import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDownloadCoordinator } from '../src/app/download-coordinator.js';
import { createVerifiedDownloadAuthority } from '../src/domain/packs/signed-download-access-contract.js';
import { configureAndMigrateDatabase } from '../src/platform/database/migrate-database.js';
import { createSqliteCommerceRepositories } from '../src/platform/database/sqlite-commerce-repositories.js';
import { createSqlitePackRepositories } from '../src/platform/database/sqlite-pack-repositories.js';
import {
  ARCHIVE_ETAG, ARCHIVE_SHA, ENVELOPE_SHA, HANDLE, JOB_ID, NOW, PACK_ID, VERSION,
  authorisation, capabilityUrl, createHarness, keyring, realManifestVerifier, signedManifest,
} from './helpers/range-fixture-server.mjs';
import { createNodeSqliteConnection } from './helpers/node-sqlite-connection.mjs';

async function withSqliteEntitlement(run) {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-download-entitlement-'));
  const connection = createNodeSqliteConnection(join(directory, 'entitlement.sqlite'));
  try {
    await connection.open();
    await configureAndMigrateDatabase(connection);
    const repository = createSqliteCommerceRepositories(connection);
    await repository.observeTransaction({
      journalId: 'download-rotation',
      store: 'apple',
      productId: 'uk.eugnel.ks2spelling.fullks2',
      observationState: 'purchased',
      opaqueProof: 'signed-store-proof',
      observedAt: NOW - 300,
    });
    await repository.markVerified({ journalId: 'download-rotation', verifiedAt: NOW - 200 });
    await repository.commitEntitlementAndReadyToComplete({
      journalId: 'download-rotation',
      entitlementId: 'full-ks2',
      storeTransactionId: '2000001234567890',
      sealedRefreshHandle: HANDLE,
      refreshHandleVersion: 1,
      committedAt: NOW - 100,
    });
    await run({ connection, repository });
  } finally {
    if (await connection.isTransactionActive()) await connection.rollback();
    await connection.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

function mutateManifest(mutator) {
  const manifest = structuredClone(signedManifest);
  mutator(manifest);
  return async () => Object.freeze({ manifest: Object.freeze(manifest) });
}

async function rejectsBeforeMutation({ manifestVerifier, authoriseOutcomes, activeEntitlement }) {
  const harness = createHarness({ manifestVerifier, authoriseOutcomes, activeEntitlement });
  const before = harness.memory.snapshot();
  await assert.rejects(
    createDownloadCoordinator(harness.dependencies).queue({ sealedRefreshHandle: HANDLE }),
  );
  assert.equal(harness.calls.gateway.length, 1, 'gateway authorisation is allowed first');
  assert.equal(harness.calls.downloads.length, 0, 'archive access is forbidden');
  assert.equal(harness.calls.inspections.length, 0, 'native inspection is forbidden');
  assert.deepEqual(harness.memory.snapshot(), before, 'job and chunk rows are byte-identical');
  assert.deepEqual(harness.memory.writes, []);
}

test('signed-manifest signature, canonical bytes and key validity fail before all mutation', async () => {
  const envelope = authorisation();
  const corrupted = Buffer.from(envelope.signedManifestEnvelopeBase64, 'base64');
  corrupted[corrupted.length - 4] ^= 1;
  envelope.signedManifestEnvelopeBase64 = corrupted.toString('base64');
  await rejectsBeforeMutation({
    manifestVerifier: realManifestVerifier,
    authoriseOutcomes: [envelope],
  });

  await rejectsBeforeMutation({
    manifestVerifier: async () => { throw new TypeError('payload is not canonical RFC 8785 JSON'); },
  });

  const invalidKeyringVerifier = (input) => realManifestVerifier({
    ...input,
    keyring: {
      ...keyring,
      keys: keyring.keys.map((entry) => ({ ...entry, notBefore: '2026-07-15T00:00:00Z' })),
    },
  });
  await rejectsBeforeMutation({ manifestVerifier: invalidKeyringVerifier });
});

test('every signed manifest identity, runtime, size, count and ceiling mutation is pre-download fatal', async (t) => {
  const mutations = [
    ['required entitlement', (value) => { value.requiredEntitlementId = 'another-entitlement'; }],
    ['pack', (value) => { value.packId = 'another-pack'; }],
    ['version', (value) => { value.version = '1.0.1'; }],
    ['minimum app', (value) => { value.minimumAppVersion = '0.4.0'; }],
    ['minimum schema', (value) => { value.minimumSchemaVersion = 3; }],
    ['archive name', (value) => { value.archive.name = 'another.zip'; }],
    ['archive hash', (value) => { value.archive.sha256 = 'f'.repeat(64); }],
    ['compressed size', (value) => { value.archive.bytes += 1; }],
    ['extracted size', (value) => { value.files[0].bytes += 1; }],
    ['file count', (value) => { value.files.pop(); }],
    ['compressed ceiling', (value) => { value.ceilings.compressedBytes += 1; }],
    ['extracted ceiling', (value) => { value.ceilings.extractedBytes += 1; }],
    ['file-count ceiling', (value) => { value.ceilings.fileCount += 1; }],
  ];
  for (const [label, mutation] of mutations) {
    await t.test(label, () => rejectsBeforeMutation({
      manifestVerifier: mutateManifest(mutation),
    }));
  }
});

test('gateway envelope, object and capability authority drift is pre-download fatal', async (t) => {
  const mutations = [
    ['envelope SHA', (value) => { value.signedEnvelopeSha256 = 'f'.repeat(64); }],
    ['manifest size', (value) => { value.objects[0].size += 1; }],
    ['manifest ETag', (value) => { value.objects[0].etag = 'changed'; }],
    ['archive object hash', (value) => { value.objects[1].sha256 = 'f'.repeat(64); }],
    ['archive object size', (value) => { value.objects[1].size += 1; }],
    ['archive object ETag', (value) => { value.objects[1].etag = 'changed'; }],
    ['capability archive name', (value) => { value.archiveCapability.archiveName = 'changed.zip'; }],
    ['capability hash', (value) => { value.archiveCapability.sha256 = 'f'.repeat(64); }],
    ['capability compressed bytes', (value) => { value.archiveCapability.compressedBytes += 1; }],
    ['capability ETag', (value) => { value.archiveCapability.etag = 'changed'; }],
    ['capability URL', (value) => { value.archiveCapability.capabilityUrl = capabilityUrl().replace('https:', 'http:'); }],
  ];
  for (const [label, mutation] of mutations) {
    await t.test(label, async () => {
      const response = authorisation();
      mutation(response);
      await rejectsBeforeMutation({ authoriseOutcomes: [response] });
    });
  }
});

test('inactive or handle-mismatched entitlement projection blocks before gateway and trust', async () => {
  for (const activeEntitlement of [
    {
      entitlementId: 'full-ks2', state: 'revoked', sealedRefreshHandle: HANDLE,
      refreshedAt: NOW - 1,
    },
    {
      entitlementId: 'another', state: 'active', sealedRefreshHandle: HANDLE,
      refreshedAt: NOW - 1,
    },
    {
      entitlementId: 'full-ks2', state: 'active', sealedRefreshHandle: 'b3rh1.other',
      refreshedAt: NOW - 1,
    },
  ]) {
    const harness = createHarness({ activeEntitlement });
    await assert.rejects(
      createDownloadCoordinator(harness.dependencies).queue({ sealedRefreshHandle: HANDLE }),
      (error) => error?.code === 'DOWNLOAD_ENTITLEMENT_INACTIVE',
    );
    assert.equal(harness.calls.gateway.length, 0);
    assert.deepEqual(harness.memory.writes, []);
  }
});

test('submitted handle is checked before gateway while a verified rotated handle is adopted memory-only', async () => {
  {
    const harness = createHarness({
      activeEntitlement: {
        entitlementId: 'full-ks2', state: 'active', sealedRefreshHandle: 'b3rh1.other',
        refreshedAt: NOW - 1,
      },
    });
    await assert.rejects(
      createDownloadCoordinator(harness.dependencies).queue({ sealedRefreshHandle: HANDLE }),
      (error) => error?.code === 'DOWNLOAD_ENTITLEMENT_INACTIVE',
    );
    assert.equal(harness.calls.gateway.length, 0);
    assert.deepEqual(harness.memory.writes, []);
  }

  {
    const rotatedHandle = 'b3rh1.2.rotated-nonce.rotated-ciphertext';
    const first = authorisation({ sealedRefreshHandle: rotatedHandle, refreshHandleVersion: 2 });
    const second = authorisation({ sealedRefreshHandle: rotatedHandle, refreshHandleVersion: 2 });
    const expired = Object.assign(new Error('expired'), { code: 'PACK_CAPABILITY_EXPIRED' });
    const harness = createHarness({
      authoriseOutcomes: [first, second],
      outcomes: [expired, {
        status: 206, startByte: 0, endByteExclusive: 1_324,
        totalBytes: 1_324, bytesWritten: 1_324, etag: '913d2b2485ca6cd31d467bd7228d7e75',
      }],
    });
    await createDownloadCoordinator(harness.dependencies).queue({ sealedRefreshHandle: HANDLE });
    assert.equal(harness.calls.entitlementCas.length, 1);
    assert.equal(harness.calls.entitlementCas[0].expectedSealedRefreshHandle, HANDLE);
    assert.equal(harness.calls.entitlementCas[0].sealedRefreshHandle, rotatedHandle);
    assert.equal(harness.calls.entitlementCas[0].refreshHandleVersion, 2);
    assert.equal(harness.calls.gateway[0].sealedRefreshHandle, HANDLE);
    assert.equal(harness.calls.gateway[1].sealedRefreshHandle, rotatedHandle);
    assert.equal(JSON.stringify(harness.memory.snapshot()).includes(rotatedHandle), false);
  }
});

test('rotated-handle CAS failure stops before every pack job and native effect', async () => {
  const rotatedHandle = 'b3rh1.2.rotated-nonce.rotated-ciphertext';
  const harness = createHarness({
    authoriseOutcomes: [authorisation({
      sealedRefreshHandle: rotatedHandle,
      refreshHandleVersion: 2,
    })],
  });
  harness.dependencies.entitlementRepository = {
    async compareAndSwapSealedRefreshHandle() {
      throw Object.assign(new Error('entitlement CAS conflict'), {
        code: 'sqlite_commerce_entitlement_conflict',
      });
    },
  };
  await assert.rejects(
    createDownloadCoordinator(harness.dependencies).queue({ sealedRefreshHandle: HANDLE }),
    (error) => error?.code === 'sqlite_commerce_entitlement_conflict',
  );
  assert.equal(harness.calls.gateway.length, 1);
  assert.equal(harness.calls.downloads.length, 0);
  assert.deepEqual(harness.memory.writes, []);
});

test('coordinator adopts Worker handle rotation through the real SQLite CAS port', async () => {
  await withSqliteEntitlement(async ({ repository }) => {
    const rotatedHandle = 'b3rh1.2.real-sqlite-rotation';
    const harness = createHarness({
      authoriseOutcomes: [authorisation({
        sealedRefreshHandle: rotatedHandle,
        refreshHandleVersion: 2,
      })],
    });
    harness.dependencies.activeEntitlementProjection = async () =>
      (await repository.listEntitlements())[0];
    harness.dependencies.entitlementRepository = repository;

    await createDownloadCoordinator(harness.dependencies).queue({ sealedRefreshHandle: HANDLE });
    const [entitlement] = await repository.listEntitlements();
    assert.equal(entitlement.sealedRefreshHandle, rotatedHandle);
    assert.equal(entitlement.refreshHandleVersion, 2);
    assert.equal(JSON.stringify(harness.memory.snapshot()).includes(rotatedHandle), false);
  });
});

test('post-response time accepts a capability minted across a one-second request boundary', async () => {
  let currentTime = NOW + 999;
  let clockCalls = 0;
  const responseTime = NOW + 1_001;
  const response = authorisation();
  response.archiveCapability.capabilityUrl = capabilityUrl({
    expires: Math.floor(responseTime / 1_000) + 600,
  });
  const harness = createHarness({ clock: () => {
    clockCalls += 1;
    return currentTime;
  } });
  harness.dependencies.gateway = {
    async authorisePackDownload(input) {
      assert.equal(clockCalls, 0, 'verification time must not be sampled before the response');
      harness.calls.gateway.push(structuredClone(input));
      currentTime = responseTime;
      return structuredClone(response);
    },
  };

  await createDownloadCoordinator(harness.dependencies).queue({ sealedRefreshHandle: HANDLE });
  assert.equal(harness.calls.gateway.length, 1);
  assert.equal(harness.calls.downloads.length, 1);
});

test('post-response time rejects capability and signing-key boundaries crossed in flight', async () => {
  const keyNotAfter = Date.parse('2027-07-01T00:00:00.000Z');
  const cases = [
    {
      label: 'capability expiry',
      requestTime: NOW,
      responseTime: NOW + 600_001,
      expires: Math.floor(NOW / 1_000) + 600,
    },
    {
      label: 'signing key notAfter',
      requestTime: keyNotAfter,
      responseTime: keyNotAfter + 1,
      expires: Math.floor(keyNotAfter / 1_000) + 600,
    },
  ];
  for (const boundary of cases) {
    let currentTime = boundary.requestTime;
    let clockCalls = 0;
    const response = authorisation();
    response.archiveCapability.capabilityUrl = capabilityUrl({ expires: boundary.expires });
    const harness = createHarness({ clock: () => {
      clockCalls += 1;
      return currentTime;
    } });
    harness.dependencies.gateway = {
      async authorisePackDownload(input) {
        assert.equal(clockCalls, 0, `${boundary.label} sampled a stale request time`);
        harness.calls.gateway.push(structuredClone(input));
        currentTime = boundary.responseTime;
        return structuredClone(response);
      },
    };

    await assert.rejects(
      createDownloadCoordinator(harness.dependencies).queue({ sealedRefreshHandle: HANDLE }),
    );
    assert.equal(harness.calls.gateway.length, 1);
    assert.equal(harness.calls.downloads.length, 0);
    assert.equal(harness.calls.inspections.length, 0);
    assert.deepEqual(harness.memory.writes, []);
  }
});

test('real SQLite rotation advances beyond a durable timestamp after clock rollback', async () => {
  await withSqliteEntitlement(async ({ repository }) => {
    const durableFloor = NOW + 100;
    await repository.replaceSealedRefreshHandle({
      entitlementId: 'full-ks2',
      sealedRefreshHandle: HANDLE,
      refreshHandleVersion: 1,
      refreshedAt: durableFloor,
    });
    const rotatedHandle = 'b3rh1.2.rollback-clock-rotation';
    const harness = createHarness({
      clock: () => NOW,
      authoriseOutcomes: [authorisation({
        sealedRefreshHandle: rotatedHandle,
        refreshHandleVersion: 2,
      })],
    });
    harness.dependencies.activeEntitlementProjection = async () =>
      (await repository.listEntitlements())[0];
    harness.dependencies.entitlementRepository = repository;

    await createDownloadCoordinator(harness.dependencies).queue({ sealedRefreshHandle: HANDLE });
    const [entitlement] = await repository.listEntitlements();
    assert.equal(entitlement.sealedRefreshHandle, rotatedHandle);
    assert.equal(entitlement.refreshedAt > durableFloor, true);
    assert.equal(harness.calls.gateway.length, 1);
    assert.equal(harness.calls.downloads.length, 1);
  });
});

test('future durable floor cannot contaminate fresh response security time', async () => {
  await withSqliteEntitlement(async ({ repository }) => {
    const durableFloor = NOW + 700_000;
    await repository.replaceSealedRefreshHandle({
      entitlementId: 'full-ks2',
      sealedRefreshHandle: HANDLE,
      refreshHandleVersion: 1,
      refreshedAt: durableFloor,
    });
    const rotatedHandle = 'b3rh1.2.future-durable-floor';
    const harness = createHarness({
      clock: () => NOW,
      authoriseOutcomes: [authorisation({
        sealedRefreshHandle: rotatedHandle,
        refreshHandleVersion: 2,
      })],
    });
    harness.dependencies.activeEntitlementProjection = async () =>
      (await repository.listEntitlements())[0];
    harness.dependencies.entitlementRepository = repository;

    await createDownloadCoordinator(harness.dependencies).queue({ sealedRefreshHandle: HANDLE });
    const [entitlement] = await repository.listEntitlements();
    assert.equal(entitlement.sealedRefreshHandle, rotatedHandle);
    assert.equal(entitlement.refreshedAt > durableFloor, true);
    assert.equal(harness.calls.gateway.length, 1);
    assert.equal(harness.calls.downloads.length, 1);
  });
});

test('real SQLite restart advances beyond an existing downloading-job timestamp floor', async () => {
  await withSqliteEntitlement(async ({ repository: entitlementRepository, connection }) => {
    const packRepository = createSqlitePackRepositories(connection);
    const jobFloor = NOW + 700_000;
    await packRepository.upsertDownloadJob({
      jobId: JOB_ID,
      packId: PACK_ID,
      version: VERSION,
      manifestSha256: ENVELOPE_SHA,
      archiveName: `${PACK_ID}.zip`,
      archiveSha256: ARCHIVE_SHA,
      expectedBytes: 1_324,
      completedBytes: 0,
      etag: ARCHIVE_ETAG,
      state: 'queued',
      updatedAt: jobFloor,
    });
    await packRepository.replaceDownloadChunks({
      jobId: JOB_ID,
      chunks: [{
        jobId: JOB_ID,
        startByte: 0,
        endByteExclusive: 1_324,
        state: 'pending',
        chunkSha256: null,
      }],
    });
    await packRepository.updateDownloadJob({
      jobId: JOB_ID,
      expectedState: 'queued',
      state: 'downloading',
      etag: ARCHIVE_ETAG,
      updatedAt: jobFloor,
    });
    const harness = createHarness({ clock: () => NOW });
    harness.dependencies.activeEntitlementProjection = async () =>
      (await entitlementRepository.listEntitlements())[0];
    harness.dependencies.entitlementRepository = entitlementRepository;
    harness.dependencies.packRepository = packRepository;

    const result = await createDownloadCoordinator(harness.dependencies)
      .resume({ sealedRefreshHandle: HANDLE });
    const persisted = await packRepository.getDownloadJob({ jobId: JOB_ID });
    assert.equal(result.state, 'downloaded');
    assert.equal(persisted.state, 'downloaded');
    assert.equal(persisted.updatedAt > jobFloor, true);
    assert.equal(harness.calls.downloads.length, 1);
  });
});

test('invalid or unadvanceable existing job timestamps fail before pack effects', async () => {
  for (const updatedAt of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const harness = createHarness({
      initialJob: {
        jobId: JOB_ID, packId: PACK_ID, version: VERSION,
        manifestSha256: ENVELOPE_SHA, archiveName: `${PACK_ID}.zip`,
        archiveSha256: ARCHIVE_SHA, expectedBytes: 1_324, completedBytes: 0,
        etag: ARCHIVE_ETAG, state: 'downloading', updatedAt,
      },
    });
    await assert.rejects(
      createDownloadCoordinator(harness.dependencies).resume({ sealedRefreshHandle: HANDLE }),
      (error) => error?.code === 'DOWNLOAD_JOB_TIMESTAMP_INVALID',
    );
    assert.equal(harness.calls.downloads.length, 0);
    assert.equal(harness.calls.inspections.length, 0);
    assert.deepEqual(harness.memory.writes, []);
  }

  const harness = createHarness({
    initialJob: {
      jobId: JOB_ID, packId: PACK_ID, version: VERSION,
      manifestSha256: ENVELOPE_SHA, archiveName: `${PACK_ID}.zip`,
      archiveSha256: ARCHIVE_SHA, expectedBytes: 1_324, completedBytes: 0,
      etag: ARCHIVE_ETAG, state: 'downloading', updatedAt: Number.MAX_SAFE_INTEGER,
    },
  });
  await assert.rejects(
    createDownloadCoordinator(harness.dependencies).resume({ sealedRefreshHandle: HANDLE }),
    /Download timestamp overflowed/,
  );
  assert.equal(harness.calls.downloads.length, 0);
  assert.equal(harness.calls.inspections.length, 0);
  assert.deepEqual(harness.memory.writes, []);
});

test('invalid or unadvanceable entitlement timestamps fail before gateway and pack effects', async () => {
  for (const refreshedAt of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const harness = createHarness({
      activeEntitlement: {
        entitlementId: 'full-ks2', state: 'active', sealedRefreshHandle: HANDLE,
        refreshHandleVersion: 1, refreshedAt,
      },
    });
    await assert.rejects(
      createDownloadCoordinator(harness.dependencies).queue({ sealedRefreshHandle: HANDLE }),
      (error) => error?.code === 'DOWNLOAD_ENTITLEMENT_TIMESTAMP_INVALID',
    );
    assert.equal(harness.calls.gateway.length, 0);
    assert.deepEqual(harness.memory.writes, []);
  }

  const harness = createHarness({
    activeEntitlement: {
      entitlementId: 'full-ks2', state: 'active', sealedRefreshHandle: HANDLE,
      refreshHandleVersion: 1, refreshedAt: Number.MAX_SAFE_INTEGER,
    },
  });
  await assert.rejects(
    createDownloadCoordinator(harness.dependencies).queue({ sealedRefreshHandle: HANDLE }),
    /Download timestamp overflowed/,
  );
  assert.equal(harness.calls.gateway.length, 0);
  assert.deepEqual(harness.memory.writes, []);
});

test('real SQLite revocation race rejects rotation before every pack effect', async () => {
  await withSqliteEntitlement(async ({ connection, repository }) => {
    const rotatedHandle = 'b3rh1.2.must-not-adopt';
    const harness = createHarness({
      authoriseOutcomes: [authorisation({
        sealedRefreshHandle: rotatedHandle,
        refreshHandleVersion: 2,
      })],
    });
    harness.dependencies.activeEntitlementProjection = async () =>
      (await repository.listEntitlements())[0];
    harness.dependencies.entitlementRepository = {
      async compareAndSwapSealedRefreshHandle(input) {
        await connection.execute(
          'UPDATE app_entitlements SET state = ?, sealed_refresh_handle = NULL, refresh_handle_version = NULL, revocation_at = ? WHERE entitlement_id = ?',
          ['revoked', NOW - 1, 'full-ks2'],
        );
        return repository.compareAndSwapSealedRefreshHandle(input);
      },
    };
    await assert.rejects(
      createDownloadCoordinator(harness.dependencies).queue({ sealedRefreshHandle: HANDLE }),
      (error) => error?.code === 'sqlite_commerce_entitlement_conflict',
    );
    assert.equal(harness.calls.downloads.length, 0);
    assert.deepEqual(harness.memory.writes, []);
  });
});

test('VerifiedDownloadAuthority is deeply immutable and capability URL is memory-only authority', async () => {
  const response = authorisation();
  const verifiedManifest = await realManifestVerifier({
    envelopeBytes: Uint8Array.from(Buffer.from(response.signedManifestEnvelopeBase64, 'base64')),
    keyring,
    environment: 'sandbox',
    clock: () => new Date(NOW),
  });
  const authority = createVerifiedDownloadAuthority({
    authorisation: response,
    verifiedManifest,
    envelopeSha256: response.signedEnvelopeSha256,
    activeEntitlement: { entitlementId: 'full-ks2', state: 'active', sealedRefreshHandle: HANDLE },
    submittedSealedRefreshHandle: HANDLE,
    currentAppVersion: '0.3.0-b3',
    currentSchemaVersion: 2,
    nowUnixSeconds: Math.floor(NOW / 1_000),
  });
  assert.equal(Object.isFrozen(authority), true);
  assert.equal(Object.isFrozen(authority.ceilings), true);
  assert.equal(authority.capabilityUrl, capabilityUrl());
  assert.throws(() => { authority.packId = 'changed'; }, TypeError);
});
