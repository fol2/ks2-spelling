import assert from 'node:assert/strict';
import test from 'node:test';

import productionDocument from '../config/ks2-pack-object-authority-production.json' with { type: 'json' };
import {
  PACK_REGISTRY,
  readDownloadablePackRows,
} from '../src/domain/packs/pack-registry.js';
import {
  PRODUCTION_PACK_REGISTRY,
  overlayProductionPackObjectFacts,
  packRegistryForEnvironment,
} from '../src/domain/packs/production-pack-registry.js';
import { createSignedDownloadAccessContract } from '../src/domain/packs/signed-download-access-contract.js';

test('the production overlay keeps archive pins and replaces sandbox-signed manifests', () => {
  assert.equal(PRODUCTION_PACK_REGISTRY.length, PACK_REGISTRY.length);
  assert.equal(PRODUCTION_PACK_REGISTRY.length, 15);
  for (const [index, row] of PRODUCTION_PACK_REGISTRY.entries()) {
    const sandbox = PACK_REGISTRY[index];
    const productionPack = productionDocument.packs[index];
    const manifest = productionPack.objects.find((object) => object.role === 'signed-manifest');
    assert.equal(row.packId, sandbox.packId);
    assert.equal(row.version, sandbox.version);
    assert.equal(row.archiveSha256, sandbox.archiveSha256);
    assert.equal(row.archiveBytes, sandbox.archiveBytes);
    assert.equal(row.archiveEtag, sandbox.archiveEtag);
    assert.equal(row.manifestSha256, manifest.sha256);
    assert.equal(row.manifestBytes, manifest.bytes);
    assert.equal(row.manifestEtag, manifest.etag);
    assert.notEqual(row.manifestSha256, sandbox.manifestSha256);
    assert.notEqual(row.manifestEtag, sandbox.manifestEtag);
  }
  assert.equal(packRegistryForEnvironment('production'), PRODUCTION_PACK_REGISTRY);
  assert.equal(packRegistryForEnvironment('sandbox'), PACK_REGISTRY);
  assert.throws(() => packRegistryForEnvironment('test'), /Pack trust environment is invalid/u);
});

test('archive drift or reused sandbox envelopes fail the production overlay closed', () => {
  const rows = readDownloadablePackRows();
  const driftedArchive = structuredClone(productionDocument);
  driftedArchive.packs[0].objects.find((object) => object.role === 'archive').etag = 'a'.repeat(32);
  assert.throws(
    () => overlayProductionPackObjectFacts(rows, driftedArchive),
    /archive facts drifted/u,
  );

  const reusedEnvelope = structuredClone(productionDocument);
  const sandbox = rows[0];
  const manifest = reusedEnvelope.packs[0].objects.find((object) => object.role === 'signed-manifest');
  manifest.sha256 = sandbox.manifestSha256;
  manifest.bytes = sandbox.manifestBytes;
  manifest.etag = sandbox.manifestEtag;
  assert.throws(
    () => overlayProductionPackObjectFacts(rows, reusedEnvelope),
    /must not reuse sandbox-signed manifest facts/u,
  );

  const missing = structuredClone(productionDocument);
  missing.packs = missing.packs.slice(1);
  assert.throws(
    () => overlayProductionPackObjectFacts(rows, missing),
    /must cover the same packs/u,
  );
});

test('a production download contract accepts production object facts and rejects sandbox envelopes', () => {
  const production = PRODUCTION_PACK_REGISTRY[0];
  const sandbox = PACK_REGISTRY[0];
  assert.equal(production.packId, sandbox.packId);
  assert.notEqual(production.manifestSha256, sandbox.manifestSha256);
  const nowUnixSeconds = 1_782_865_200;
  const handle = 'b3rh1.1.test-nonce.test-ciphertext';
  const productionOrigin = 'https://ks2-gateway.eugnel.uk';
  const authorisation = {
    store: 'google',
    productId: 'full_ks2',
    environment: 'sandbox',
    applicationId: 'uk.eugnel.ks2spelling',
    entitlementId: 'full-ks2',
    state: 'active',
    storeTransactionId: 'GPA.1234-5678-9012-34567',
    sealedRefreshHandle: handle,
    refreshHandleVersion: 1,
    packId: production.packId,
    version: production.version,
    signedManifestEnvelopeBase64: 'e30=',
    signedEnvelopeSha256: production.manifestSha256,
    objects: [
      {
        objectKind: 'manifest',
        sha256: production.manifestSha256,
        size: production.manifestBytes,
        etag: production.manifestEtag,
      },
      {
        objectKind: 'archive',
        sha256: production.archiveSha256,
        size: production.archiveBytes,
        etag: production.archiveEtag,
      },
    ],
    archiveCapability: {
      packId: production.packId,
      version: production.version,
      archiveName: production.archiveName,
      sha256: production.archiveSha256,
      compressedBytes: production.archiveBytes,
      etag: production.archiveEtag,
      capabilityUrl: `${productionOrigin}/v1/packs/${production.packId}/${production.version}/${production.archiveName}?expires=${nowUnixSeconds + 600}&cap=${'A'.repeat(43)}`,
    },
  };
  const verifiedManifest = {
    manifest: {
      packId: production.packId,
      version: production.version,
      schemaVersion: 1,
      requiredEntitlementId: production.requiredEntitlementId,
      archive: {
        bytes: production.archiveBytes,
        name: production.archiveName,
        sha256: production.archiveSha256,
      },
      ceilings: { ...production.ceilings },
      allowedExtensions: [...production.allowedExtensions],
      files: [{
        bytes: 1,
        path: 'catalogue.json',
        sha256: 'a'.repeat(64),
      }],
    },
  };
  const input = {
    authorisation,
    verifiedManifest,
    envelopeSha256: production.manifestSha256,
    activeEntitlement: {
      entitlementId: 'full-ks2',
      state: 'active',
      sealedRefreshHandle: handle,
    },
    submittedSealedRefreshHandle: handle,
    currentAppVersion: '0.3.0-b3',
    currentSchemaVersion: 2,
    nowUnixSeconds,
  };
  const accepted = createSignedDownloadAccessContract(production, productionOrigin)
    .createVerifiedDownloadAuthority(input);
  assert.equal(accepted.manifestSha256, production.manifestSha256);
  assert.equal(accepted.etag, production.archiveEtag);
  assert.match(accepted.capabilityUrl, /^https:\/\/ks2-gateway\.eugnel\.uk\//u);

  assert.throws(
    () => createSignedDownloadAccessContract(sandbox, productionOrigin)
      .createVerifiedDownloadAuthority(input),
    (error) => error.code === 'DOWNLOAD_GATEWAY_AUTHORITY_MISMATCH',
  );
});
