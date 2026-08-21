import b3PackObjectAuthority from '../../../config/b3-pack-object-authority.json' with { type: 'json' };
import b3ProofPack from '../../../config/b3-proof-pack.json' with { type: 'json' };
import {
  PACK_REGISTRY,
  assertPackAuthority,
  findPackAuthority,
} from './pack-registry.js';
import { createSignedDownloadAccessContract } from './signed-download-access-contract.js';

function fail() {
  throw new TypeError('B3 pack authority configuration is inconsistent.');
}

export function readB3Row() {
  const archive = b3PackObjectAuthority?.objects?.find?.((entry) => entry?.role === 'archive');
  const manifest = b3PackObjectAuthority?.objects?.find?.(
    (entry) => entry?.role === 'signed-manifest',
  );
  if (
    b3ProofPack?.schemaVersion !== 1 ||
    b3PackObjectAuthority?.schemaVersion !== 1 ||
    b3ProofPack.packId !== b3PackObjectAuthority.packId ||
    b3ProofPack.version !== b3PackObjectAuthority.version ||
    !Array.isArray(b3PackObjectAuthority.objects) ||
    b3PackObjectAuthority.objects.length !== 2 ||
    !archive ||
    !manifest ||
    archive.key !==
      `packs/${b3ProofPack.packId}/${b3ProofPack.version}/${b3ProofPack.archiveName}` ||
    manifest.key !==
      `packs/${b3ProofPack.packId}/${b3ProofPack.version}/signed-manifest.json` ||
    manifest.sha256 !== b3ProofPack.signedEnvelopeSha256
  ) {
    fail();
  }
  return assertPackAuthority({
    packId: b3ProofPack.packId,
    version: b3ProofPack.version,
    requiredEntitlementId: b3ProofPack.requiredEntitlementId,
    archiveName: b3ProofPack.archiveName,
    allowedExtensions: b3ProofPack.allowedExtensions,
    ceilings: b3ProofPack.ceilings,
    manifestSha256: manifest.sha256,
    manifestBytes: manifest.bytes,
    manifestEtag: manifest.etag,
    archiveSha256: archive.sha256,
    archiveBytes: archive.bytes,
    archiveEtag: archive.etag,
  });
}

export const B3_PACK_REGISTRY = Object.freeze([readB3Row(), ...PACK_REGISTRY]);

export function findB3PackAuthority(packId) {
  return findPackAuthority(packId, B3_PACK_REGISTRY);
}

const B3_FILES = Object.freeze([
  Object.freeze({
    bytes: 840,
    path: 'audio/proof-word.m4a',
    sha256: 'ef93d2c71f8490c7dd1b93929d8cba78b82c7c22c7c5da210e402be0f6b3f82f',
  }),
  Object.freeze({
    bytes: 242,
    path: 'catalogue.json',
    sha256: 'ee99faa101efe4e18e6e864f4b9265eabc8f0106dd72465c7c4fc3c1b36feb3e',
  }),
]);

export function createB3SignedDownloadAccessContract(packAuthority, gatewayOrigin) {
  return createSignedDownloadAccessContract(packAuthority, gatewayOrigin, B3_FILES);
}

const B3_CONTRACT = createB3SignedDownloadAccessContract(
  findB3PackAuthority('b3-sandbox-proof'),
  ['https:', '', 'b3-gateway.eugnel.uk'].join('/'),
);

export const assertSignedDownloadAccess = B3_CONTRACT.assertSignedDownloadAccess;
export const assertSubmittedDownloadEntitlement = B3_CONTRACT.assertSubmittedDownloadEntitlement;
export const createVerifiedDownloadAuthority = B3_CONTRACT.createVerifiedDownloadAuthority;

function packJobFacts(row) {
  return Object.freeze({
    packId: row.packId,
    version: row.version,
    archiveName: row.archiveName,
    manifestSha256: row.manifestSha256,
    manifestBytes: row.manifestBytes,
    manifestEtag: row.manifestEtag,
    archiveSha256: row.archiveSha256,
    archiveBytes: row.archiveBytes,
    archiveEtag: row.archiveEtag,
  });
}

export const B3_PACK_JOB_AUTHORITY = packJobFacts(
  findB3PackAuthority('b3-sandbox-proof'),
);
