import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDownloadCoordinator } from '../src/app/download-coordinator.js';
import { resolvePackJobAuthorities } from '../src/domain/commerce/purchase-state.js';
import {
  PACK_REGISTRY,
  assertPackAuthority,
  findPackAuthority,
} from '../src/domain/packs/pack-registry.js';
import { configureAndMigrateDatabase } from '../src/platform/database/migrate-database.js';
import { createSqliteCommerceRepositories } from '../src/platform/database/sqlite-commerce-repositories.js';
import { createSqlitePackRepositories } from '../src/platform/database/sqlite-pack-repositories.js';
import { createNodeSqliteConnection } from './helpers/node-sqlite-connection.mjs';
import { HANDLE, NOW, keyring } from './helpers/range-fixture-server.mjs';

// Two registry-only fixture shard packs under the one full-ks2 entitlement — the
// owner model E2.2 implements. They are deliberately absent from
// config/store-products.json (not sellable) and from the runtime keyring, so the
// signed-manifest verifier is faked; every other layer below runs for real.
function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

function md5Hex(text) {
  return createHash('md5').update(text).digest('hex');
}

function shardFixture(packId) {
  const envelopeText = JSON.stringify({ fixtureEnvelope: packId });
  const version = '1.0.0';
  const archiveName = `${packId}-${version}.zip`;
  const files = Object.freeze([
    Object.freeze({ bytes: 300, path: 'catalogue.json', sha256: 'a'.repeat(64) }),
    Object.freeze({ bytes: 100, path: `audio/${packId}-word.m4a`, sha256: 'b'.repeat(64) }),
  ]);
  const authority = assertPackAuthority({
    packId,
    version,
    requiredEntitlementId: 'full-ks2',
    archiveName,
    allowedExtensions: ['.json', '.m4a'],
    ceilings: { fileCount: 4, compressedBytes: 1_048_576, extractedBytes: 1_048_576 },
    manifestSha256: sha256Hex(envelopeText),
    manifestBytes: Buffer.byteLength(envelopeText),
    manifestEtag: md5Hex(envelopeText),
    archiveSha256: sha256Hex(`${packId}-archive`),
    archiveBytes: 512,
    archiveEtag: md5Hex(`${packId}-archive`),
  });
  const manifest = Object.freeze({
    schemaVersion: 1,
    packId,
    version,
    requiredEntitlementId: 'full-ks2',
    archive: Object.freeze({
      bytes: authority.archiveBytes,
      name: authority.archiveName,
      sha256: authority.archiveSha256,
    }),
    allowedExtensions: Object.freeze(['.json', '.m4a']),
    ceilings: Object.freeze({ ...authority.ceilings }),
    files,
  });
  const expires = Math.floor(NOW / 1_000) + 600;
  const capabilityUrl = `https://b3-gateway.eugnel.uk/v1/packs/${packId}/${version}/${archiveName}?expires=${expires}&cap=${'B'.repeat(43)}`;
  const authorisation = {
    store: 'google',
    productId: 'full_ks2',
    environment: 'sandbox',
    applicationId: 'uk.eugnel.ks2spelling',
    entitlementId: 'full-ks2',
    state: 'active',
    storeTransactionId: 'GPA.1234-5678-9012-34567',
    sealedRefreshHandle: HANDLE,
    refreshHandleVersion: 1,
    traceId: '123e4567-e89b-42d3-a456-426614174000',
    workerVersionId: 'worker-test',
    workerScriptAuthoritySha256: 'a'.repeat(64),
    packId,
    version,
    signedManifestEnvelopeBase64: Buffer.from(envelopeText).toString('base64'),
    signedEnvelopeSha256: authority.manifestSha256,
    objects: [
      {
        objectKind: 'manifest',
        sha256: authority.manifestSha256,
        size: authority.manifestBytes,
        etag: authority.manifestEtag,
      },
      {
        objectKind: 'archive',
        sha256: authority.archiveSha256,
        size: authority.archiveBytes,
        etag: authority.archiveEtag,
      },
    ],
    archiveCapability: {
      packId,
      version,
      archiveName,
      sha256: authority.archiveSha256,
      compressedBytes: authority.archiveBytes,
      etag: authority.archiveEtag,
      capabilityUrl,
    },
  };
  return { authority, manifest, authorisation };
}

const SHARD_A = shardFixture('e2-shard-alpha');
const SHARD_B = shardFixture('e2-shard-beta');
const FIXTURE_REGISTRY = Object.freeze([SHARD_A.authority, SHARD_B.authority]);

function shardDependencies(shard, { packRepository, commerceRepository, clock = () => NOW }) {
  const calls = { gateway: 0, downloads: 0, inspections: 0 };
  return {
    calls,
    dependencies: {
      gateway: {
        async authorisePackDownload() {
          calls.gateway += 1;
          return structuredClone(shard.authorisation);
        },
      },
      packTransfer: {
        async getFreeBytes() {
          return 10_000_000;
        },
        async downloadRange() {
          calls.downloads += 1;
          return {
            status: 206,
            startByte: 0,
            endByteExclusive: shard.authority.archiveBytes,
            totalBytes: shard.authority.archiveBytes,
            bytesWritten: shard.authority.archiveBytes,
            etag: shard.authority.archiveEtag,
          };
        },
        async inspectAndExtract() {
          calls.inspections += 1;
          return {
            archiveSha256: shard.authority.archiveSha256,
            manifestSha256: shard.authority.manifestSha256,
            extractedBytes: 400,
            fileCount: 2,
            stagingToken: `staging/${shard.authority.packId}/${shard.authority.version}`,
          };
        },
        async removeOwnedTemporaryState() {
          return { removed: true };
        },
      },
      packRepository,
      manifestVerifier: async () => Object.freeze({ manifest: shard.manifest }),
      keyring,
      activeEntitlementProjection: async () =>
        (await commerceRepository.listEntitlements())[0] ?? null,
      entitlementRepository: commerceRepository,
      currentAppVersion: '0.3.0-b3',
      currentSchemaVersion: 2,
      clock,
      chunkSize: 1_048_576,
      packAuthority: shard.authority,
    },
  };
}

async function withMultiShardDatabase(run) {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-multi-shard-'));
  const connection = createNodeSqliteConnection(join(directory, 'multi-shard.sqlite'));
  try {
    await connection.open();
    await configureAndMigrateDatabase(connection);
    const commerceRepository = createSqliteCommerceRepositories(connection);
    const packRepository = createSqlitePackRepositories(connection);
    await commerceRepository.observeTransaction({
      journalId: 'multi-shard-acquisition',
      store: 'apple',
      productId: 'uk.eugnel.ks2spelling.fullks2',
      observationState: 'purchased',
      opaqueProof: 'signed-store-proof',
      observedAt: NOW - 300,
    });
    await commerceRepository.markVerified({
      journalId: 'multi-shard-acquisition',
      verifiedAt: NOW - 200,
    });
    await commerceRepository.commitEntitlementAndReadyToComplete({
      journalId: 'multi-shard-acquisition',
      entitlementId: 'full-ks2',
      storeTransactionId: '2000001234567890',
      sealedRefreshHandle: HANDLE,
      refreshHandleVersion: 1,
      committedAt: NOW - 100,
    });
    await commerceRepository.markStoreCompleteAndClearProof({
      journalId: 'multi-shard-acquisition',
      completedAt: NOW - 50,
    });
    await run({ connection, commerceRepository, packRepository });
  } finally {
    if (await connection.isTransactionActive()) await connection.rollback();
    await connection.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

function shardActivation(shard, installedAt, activatedAt) {
  const identity = {
    packId: shard.authority.packId,
    version: shard.authority.version,
    manifestSha256: shard.authority.manifestSha256,
    pathToken: `installed/${shard.authority.packId}/${shard.authority.version}`,
  };
  return {
    requiredEntitlementId: 'full-ks2',
    installedVersion: {
      ...identity,
      activationMarkerSha256: 'c'.repeat(64),
      state: 'ready',
      installedAt,
    },
    activeVersion: { ...identity, activatedAt },
  };
}

test('the registry resolves N shard packs per entitlement and fails closed otherwise', () => {
  const authorities = resolvePackJobAuthorities({
    entitlementId: 'full-ks2',
    packIds: ['e2-shard-alpha', 'e2-shard-beta'],
  }, FIXTURE_REGISTRY);
  assert.deepEqual([...authorities].map((authority) => ({ ...authority })), [
    {
      entitlementId: 'full-ks2',
      packId: 'e2-shard-alpha',
      version: '1.0.0',
      jobId: 'e2-shard-alpha.1.0.0',
    },
    {
      entitlementId: 'full-ks2',
      packId: 'e2-shard-beta',
      version: '1.0.0',
      jobId: 'e2-shard-beta.1.0.0',
    },
  ]);
  assert.equal(Object.isFrozen(authorities), true);
  assert.equal(Object.isFrozen(authorities[0]), true);

  // Fixture shards are registry-only: the config registry never resolves them.
  assert.throws(() => findPackAuthority('e2-shard-alpha'), /not registered/);
  assert.deepEqual(PACK_REGISTRY.map((row) => row.packId), ['b3-sandbox-proof']);

  // A registered pack bound to a different entitlement never joins the product.
  assert.throws(() => resolvePackJobAuthorities({
    entitlementId: 'year-3-spelling',
    packIds: ['e2-shard-alpha'],
  }, FIXTURE_REGISTRY), /not bound to the product entitlement/);
});

test('a download coordinator rejects a present-but-undefined pack authority', () => {
  const stub = (methods) => Object.fromEntries(
    methods.map((method) => [method, async () => undefined]),
  );
  const dependencies = {
    gateway: stub(['authorisePackDownload']),
    packTransfer: stub([
      'getFreeBytes', 'downloadRange', 'inspectAndExtract', 'removeOwnedTemporaryState',
    ]),
    packRepository: stub([
      'clearDownloadChunks', 'completeDownloadChunk', 'deleteDownloadJob',
      'getDownloadJob', 'listDownloadChunks', 'replaceDownloadChunks',
      'updateDownloadJob', 'upsertDownloadJob',
    ]),
    manifestVerifier: async () => undefined,
    keyring,
    activeEntitlementProjection: async () => null,
    entitlementRepository: stub(['compareAndSwapSealedRefreshHandle']),
    currentAppVersion: '0.3.0-b3',
    currentSchemaVersion: 2,
    clock: () => NOW,
    chunkSize: 1_048_576,
    // A missed registry lookup upstream must fail here, never silently fall
    // back to the default pack.
    packAuthority: undefined,
  };
  assert.throws(() => createDownloadCoordinator(dependencies), /Pack authority/);
});

test('N=2 shards download, install, activate and revocation locks both', async () => {
  await withMultiShardDatabase(async ({ commerceRepository, packRepository }) => {
    // Download both shards through real coordinators sharing one database.
    const shardHarnesses = [SHARD_A, SHARD_B].map((shard) =>
      shardDependencies(shard, { packRepository, commerceRepository }));
    for (const harness of shardHarnesses) {
      const result = await createDownloadCoordinator(harness.dependencies)
        .queue({ sealedRefreshHandle: HANDLE });
      assert.equal(result.state, 'downloaded');
      assert.deepEqual(harness.calls, { gateway: 1, downloads: 1, inspections: 1 });
    }
    const jobs = await packRepository.listDownloadJobs();
    assert.deepEqual(
      jobs.map((job) => job.jobId).toSorted(),
      ['e2-shard-alpha.1.0.0', 'e2-shard-beta.1.0.0'],
    );
    assert.ok(jobs.every((job) => job.state === 'downloaded'));

    // Install + activate both shards under the one active entitlement.
    await packRepository.registerAndFlipActiveVersion(
      shardActivation(SHARD_A, NOW + 10, NOW + 11),
    );
    await packRepository.registerAndFlipActiveVersion(
      shardActivation(SHARD_B, NOW + 12, NOW + 13),
    );
    const activeAlpha = await packRepository.getActiveVersion({ packId: 'e2-shard-alpha' });
    const activeBeta = await packRepository.getActiveVersion({ packId: 'e2-shard-beta' });
    assert.equal(activeAlpha.version, '1.0.0');
    assert.equal(activeBeta.version, '1.0.0');

    // Revoke the entitlement through the real journal; every shard locks.
    await commerceRepository.observeTransaction({
      journalId: 'multi-shard-revocation',
      store: 'apple',
      productId: 'uk.eugnel.ks2spelling.fullks2',
      observationState: 'revoked',
      opaqueProof: 'eyJhbGciOiJFUzI1NiJ9.revocation.signature',
      observedAt: NOW + 20,
    });
    await commerceRepository.markVerified({
      journalId: 'multi-shard-revocation',
      verifiedAt: NOW + 21,
    });
    await commerceRepository.applyRevocationAndDeleteHandle({
      journalId: 'multi-shard-revocation',
      entitlementId: 'full-ks2',
      storeTransactionId: '2000001234567890',
      revokedAt: NOW + 22,
    });
    for (const shard of [SHARD_A, SHARD_B]) {
      await assert.rejects(
        packRepository.registerAndFlipActiveVersion(
          shardActivation(shard, NOW + 30, NOW + 31),
        ),
        (error) => error?.code === 'sqlite_pack_entitlement_inactive',
      );
    }
    const lockedHarness = shardDependencies(SHARD_A, {
      packRepository,
      commerceRepository,
      clock: () => NOW + 40,
    });
    await assert.rejects(
      createDownloadCoordinator(lockedHarness.dependencies)
        .queue({ sealedRefreshHandle: HANDLE }),
      (error) => error?.code === 'DOWNLOAD_ENTITLEMENT_INACTIVE',
    );
    assert.equal(lockedHarness.calls.gateway, 0, 'a locked shard never reaches the gateway');

    // The revocation locked access; the installed rows and active pointers stay.
    assert.equal(
      (await packRepository.getActiveVersion({ packId: 'e2-shard-alpha' })).version,
      '1.0.0',
    );
  });
});
