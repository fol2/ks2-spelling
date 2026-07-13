import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createPurchaseCoordinator } from '../src/app/purchase-coordinator.js';
import { deriveTransactionReplayJournalId } from '../src/domain/commerce/purchase-state.js';
import { configureAndMigrateDatabase } from '../src/platform/database/migrate-database.js';
import { createSqliteCommerceRepositories } from '../src/platform/database/sqlite-commerce-repositories.js';
import { createSqlitePackRepositories } from '../src/platform/database/sqlite-pack-repositories.js';

import { createNodeSqliteConnection } from './helpers/node-sqlite-connection.mjs';

const MANIFEST_SHA256 = '39b6a788a3686d7cbf1fd4791bce45623af21ef53c60eabc03d955395856218a';
const MANIFEST_BYTES = 1_135;
const MANIFEST_ETAG = 'c76b2858b8345814279a1c92ae64e365';
const ARCHIVE_SHA256 = '4c2ca2eb4d4bb7ac3347b66e3483dcb6aa71b41958704733bfc471c970ce7664';
const ARCHIVE_BYTES = 1_324;
const ARCHIVE_ETAG = '913d2b2485ca6cd31d467bd7228d7e75';

function purchased(overrides = {}) {
  return {
    store: 'google',
    environment: 'sandbox',
    productId: 'full_ks2',
    outcome: 'purchased',
    transactionRef: 'native-current-purchase',
    opaqueProof: 'current-purchase-proof',
    ...overrides,
  };
}

function pending(overrides = {}) {
  return {
    store: 'google',
    environment: 'sandbox',
    productId: 'full_ks2',
    outcome: 'pending',
    transactionRef: 'native-pending-purchase',
    ...overrides,
  };
}

function revoked(overrides = {}) {
  return {
    store: 'google',
    environment: 'sandbox',
    productId: 'full_ks2',
    outcome: 'revoked',
    transactionRef: 'native-current-revocation',
    opaqueProof: 'current-revocation-proof',
    ...overrides,
  };
}

function identity({ state = 'active', version = 1 } = {}) {
  return {
    store: 'google',
    productId: 'full_ks2',
    environment: 'sandbox',
    applicationId: 'uk.eugnel.ks2spelling',
    entitlementId: 'full-ks2',
    state,
    storeTransactionId: 'GPA.1234-5678-9012-34567',
    sealedRefreshHandle: state === 'active' ? `b3rh1.${version}.verified.handle` : null,
    refreshHandleVersion: state === 'active' ? version : null,
    traceId: '123e4567-e89b-42d3-a456-426614174000',
    workerVersionId: 'worker-test',
    workerScriptAuthoritySha256: 'a'.repeat(64),
  };
}

function authorisation(overrides = {}) {
  const active = identity();
  return {
    ...active,
    packId: 'b3-sandbox-proof',
    version: '1.0.0-b3.1',
    signedManifestEnvelopeBase64: 'e30=',
    signedEnvelopeSha256: MANIFEST_SHA256,
    objects: [
      { objectKind: 'manifest', sha256: MANIFEST_SHA256, size: MANIFEST_BYTES, etag: MANIFEST_ETAG },
      { objectKind: 'archive', sha256: ARCHIVE_SHA256, size: ARCHIVE_BYTES, etag: ARCHIVE_ETAG },
    ],
    archiveCapability: {
      packId: 'b3-sandbox-proof',
      version: '1.0.0-b3.1',
      archiveName: 'b3-sandbox-proof.zip',
      sha256: ARCHIVE_SHA256,
      compressedBytes: ARCHIVE_BYTES,
      etag: ARCHIVE_ETAG,
      capabilityUrl: 'https://b3-gateway.eugnel.uk/v1/packs/b3-sandbox-proof/1.0.0-b3.1/b3-sandbox-proof.zip?expires=1783987200&cap=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    },
    ...overrides,
  };
}

async function withWorld(run) {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-spelling-replay-'));
  const connection = createNodeSqliteConnection(join(directory, 'replay.sqlite'));
  try {
    await connection.open();
    await configureAndMigrateDatabase(connection);
    const commerceRepository = createSqliteCommerceRepositories(connection);
    const packRepository = createSqlitePackRepositories(connection);
    const calls = {
      verify: [], complete: [], refresh: [], authorise: [], finish: [],
    };
    const state = {
      current: [],
      restore: [],
      purchase: purchased(),
      rejectVerification: false,
      authorisation: authorisation(),
      nextAttempt: 0,
      clock: 20_000,
      lastIdentity: identity(),
    };
    const store = {
      async purchase() { return state.purchase; },
      async queryTransactions() { return [...state.current]; },
      async restore() { return [...state.restore]; },
      async finishTransaction({ transactionRef }) {
        calls.finish.push(transactionRef);
        return { completion: 'finished' };
      },
    };
    const gateway = {
      async verifyTransaction(input) {
        calls.verify.push(input);
        if (state.rejectVerification) {
          throw Object.assign(new Error('authenticated permanent rejection'), {
            code: 'PROOF_REJECTED', status: 422, retryable: false,
          });
        }
        state.lastIdentity = identity({
          state: input.opaqueProof.includes('revocation') ? 'revoked' : 'active',
          version: calls.verify.length,
        });
        return state.lastIdentity;
      },
      async completeTransaction(input) {
        calls.complete.push(input);
        return state.lastIdentity;
      },
      async refreshEntitlement(input) {
        calls.refresh.push(input);
        state.lastIdentity = identity({ state: 'revoked' });
        return state.lastIdentity;
      },
      async authorisePackDownload(input) {
        calls.authorise.push(input);
        return state.authorisation;
      },
    };
    function coordinator({ failureAt = 'never' } = {}) {
      let failed = false;
      return createPurchaseCoordinator({
        store,
        gateway,
        commerceRepository,
        downloadRepository: packRepository,
        clock: () => state.clock += 1,
        idFactory: () => `restore-attempt-${state.nextAttempt += 1}`,
        failureInjector: async (checkpoint) => {
          if (!failed && checkpoint === failureAt) {
            failed = true;
            throw Object.assign(new Error('simulated crash'), { code: 'SIMULATED_CRASH' });
          }
        },
      });
    }
    await run({
      connection, commerceRepository, packRepository, calls, state, coordinator,
    });
  } finally {
    if (await connection.isTransactionActive()) await connection.rollback();
    await connection.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function journalRows(connection) {
  return connection.query(
    'SELECT journal_id, observation_state, processing_state, opaque_proof FROM transaction_journal ORDER BY created_at, journal_id',
  );
}

test('pending promotion and repeated current recovery share one non-secret acquisition authority', async () => {
  await withWorld(async ({ connection, calls, state, coordinator }) => {
    const pendingValue = pending({ transactionRef: 'pending-native-secret' });
    const purchasedValue = purchased({
      transactionRef: 'purchased-native-secret',
      opaqueProof: 'purchased-proof-secret',
    });
    assert.equal(
      await deriveTransactionReplayJournalId(pendingValue),
      'purchase-google-full-ks2-acquisition',
    );
    assert.equal(
      await deriveTransactionReplayJournalId(purchasedValue),
      'purchase-google-full-ks2-acquisition',
    );
    const first = coordinator();
    await first.handleObservation(pendingValue);
    await first.handleObservation(purchasedValue);
    state.current = [{
      ...purchasedValue,
      transactionRef: 'changed-native-secret',
      opaqueProof: 'changed-proof-secret',
    }];
    await coordinator().recover();

    const rows = await journalRows(connection);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].journal_id, 'purchase-google-full-ks2-acquisition');
    assert.equal(rows[0].processing_state, 'complete');
    assert.equal(rows[0].opaque_proof, null);
    assert.equal(calls.verify.length, 1);
    assert.equal(calls.complete.length, 1);
    assert.deepEqual(calls.finish, ['purchased-native-secret']);
    const durable = JSON.stringify(await connection.query(
      'SELECT * FROM transaction_journal ORDER BY journal_id',
    ));
    for (const secret of [
      'pending-native-secret', 'purchased-native-secret', 'purchased-proof-secret',
      'changed-native-secret', 'changed-proof-secret',
    ]) {
      assert.equal(durable.includes(secret), false);
    }
  });
});

test('changed process-local purchase authority finishes one stable recoverable attempt', async () => {
  await withWorld(async ({ connection, calls, state, coordinator }) => {
    const first = purchased({
      transactionRef: 'first-process-native-ref',
      opaqueProof: 'durable-first-process-proof',
    });
    await assert.rejects(
      coordinator({ failureAt: 'after:journal' }).handleObservation(first),
      { code: 'SIMULATED_CRASH' },
    );
    state.current = [purchased({
      transactionRef: 'fresh-process-native-ref',
      opaqueProof: 'fresh-process-observation-proof',
    })];
    await coordinator().recover();
    const rows = await journalRows(connection);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].processing_state, 'complete');
    assert.equal(rows[0].opaque_proof, null);
    assert.equal(calls.verify.length, 1);
    assert.equal(calls.verify[0].opaqueProof, 'durable-first-process-proof');
    assert.deepEqual(calls.finish, ['fresh-process-native-ref']);
  });
});

test('first clean Restore uses stable authority and ordinary recovery stays offline', async () => {
  await withWorld(async ({ connection, calls, state, coordinator }) => {
    const restored = purchased({
      transactionRef: 'clean-restore-native',
      opaqueProof: 'clean-restore-proof',
    });
    state.restore = [restored, restored, pending({ transactionRef: 'late-pending' })];
    await coordinator().restore();
    state.current = [{
      ...restored,
      transactionRef: 'process-unstable-native',
      opaqueProof: 'process-unstable-proof',
    }];
    const before = structuredClone(calls);
    await coordinator().recover();
    assert.deepEqual(calls, before);
    const rows = await journalRows(connection);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].journal_id, 'purchase-google-full-ks2-acquisition');
    assert.equal(rows[0].processing_state, 'complete');
  });
});

test('stable rejected Restore stays proof-free proactively but a later user Restore may reseal once', async () => {
  await withWorld(async ({ connection, commerceRepository, calls, state, coordinator }) => {
    const rejected = purchased({
      transactionRef: 'rejected-native',
      opaqueProof: 'rejected-proof',
    });
    state.restore = [rejected];
    state.rejectVerification = true;
    await assert.rejects(coordinator().restore(), { code: 'PROOF_REJECTED' });
    state.current = [{
      ...rejected,
      transactionRef: 'replayed-rejected-native',
      opaqueProof: 'replayed-rejected-proof',
    }];
    await coordinator().recover();
    assert.equal(calls.verify.length, 1);
    assert.equal((await journalRows(connection))[0].opaque_proof, null);

    state.rejectVerification = false;
    state.authorisation = authorisation(identity({ version: 2 }));
    const retry = purchased({
      transactionRef: 'explicit-retry-native',
      opaqueProof: 'explicit-retry-proof',
    });
    state.restore = [retry, retry];
    await coordinator().restore();
    const entitlement = (await commerceRepository.listEntitlements())[0];
    assert.equal(entitlement.state, 'active');
    assert.equal(entitlement.sealedRefreshHandle, 'b3rh1.2.verified.handle');
    state.current = [{
      ...retry,
      transactionRef: 'ordinary-after-retry-native',
      opaqueProof: 'ordinary-after-retry-proof',
    }];
    const before = structuredClone(calls);
    await coordinator().recover();
    assert.deepEqual(calls, before);
    const rows = await journalRows(connection);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(({ processing_state }) => processing_state), ['rejected', 'complete']);
    assert.equal(rows.every(({ opaque_proof }) => opaque_proof === null), true);
  });
});

test('a later user purchase escapes a stable rejection without reopening proactive callbacks', async () => {
  await withWorld(async ({ commerceRepository, calls, state, coordinator }) => {
    state.rejectVerification = true;
    await assert.rejects(
      coordinator().purchaseFullKs2({ productId: 'full_ks2' }),
      { code: 'PROOF_REJECTED' },
    );
    state.rejectVerification = false;
    state.purchase = purchased({
      transactionRef: 'user-retry-native',
      opaqueProof: 'user-retry-proof',
    });
    state.authorisation = authorisation(identity({ version: 2 }));
    await coordinator().purchaseFullKs2({ productId: 'full_ks2' });
    assert.equal((await commerceRepository.listEntitlements())[0].state, 'active');
    const before = structuredClone(calls);
    state.current = [purchased({
      transactionRef: 'later-callback-native',
      opaqueProof: 'later-callback-proof',
    })];
    await coordinator().recover();
    assert.deepEqual(calls, before);
  });
});

test('a pending user retry after stable rejection promotes its one fresh attempt', async () => {
  await withWorld(async ({ connection, state, coordinator }) => {
    state.rejectVerification = true;
    await assert.rejects(
      coordinator().purchaseFullKs2({ productId: 'full_ks2' }),
      { code: 'PROOF_REJECTED' },
    );
    state.rejectVerification = false;
    state.purchase = pending({ transactionRef: 'retry-pending-native' });
    await coordinator().purchaseFullKs2({ productId: 'full_ks2' });
    state.authorisation = authorisation(identity({ version: 2 }));
    await coordinator().handleObservation(purchased({
      transactionRef: 'retry-approved-native',
      opaqueProof: 'retry-approved-proof',
    }));
    const rows = await journalRows(connection);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(({ processing_state }) => processing_state), ['rejected', 'complete']);
    assert.equal(rows.every(({ opaque_proof }) => opaque_proof === null), true);
  });
});

test('authorisation compares exact ordered tracked object records before durable writes', async () => {
  const mutations = [
    (value) => { value.objects[0].sha256 = 'd'.repeat(64); value.signedEnvelopeSha256 = 'd'.repeat(64); },
    (value) => { value.objects[0].size += 1; },
    (value) => { value.objects[0].etag = 'wrong-manifest-etag'; },
    (value) => { value.objects[1].sha256 = 'e'.repeat(64); value.archiveCapability.sha256 = 'e'.repeat(64); },
    (value) => { value.objects[1].size += 1; value.archiveCapability.compressedBytes += 1; },
    (value) => { value.objects[1].etag = 'wrong-archive-etag'; value.archiveCapability.etag = 'wrong-archive-etag'; },
    (value) => { value.objects.reverse(); },
    (value) => { value.objects.push({ ...value.objects[1] }); },
  ];
  for (const mutate of mutations) {
    await withWorld(async ({ commerceRepository, packRepository, state, coordinator }) => {
      await coordinator().handleObservation(purchased());
      await packRepository.deleteDownloadJob({ jobId: 'b3-sandbox-proof.1.0.0-b3.1' });
      const before = (await commerceRepository.listEntitlements())[0];
      const wrong = structuredClone(authorisation());
      wrong.sealedRefreshHandle = 'b3rh1.99.must-not-persist';
      wrong.refreshHandleVersion = 99;
      mutate(wrong);
      state.authorisation = wrong;
      state.current = [];
      await assert.rejects(
        coordinator().recover(),
        { code: 'PURCHASE_DOWNLOAD_AUTHORITY_MISMATCH' },
      );
      assert.deepEqual((await commerceRepository.listEntitlements())[0], before);
      assert.deepEqual(await packRepository.listDownloadJobs(), []);
    });
  }
});

test('refresh-authorised revocation emits refresh only and a later lifecycle revokes again', async () => {
  await withWorld(async ({ commerceRepository, calls, state, coordinator }) => {
    await coordinator().handleObservation(purchased());
    const firstRevoke = revoked();
    state.current = [firstRevoke];
    const beforeVerify = calls.verify.length;
    const beforeComplete = calls.complete.length;
    await coordinator().refresh();
    assert.equal(calls.refresh.length, 1);
    assert.equal(calls.verify.length, beforeVerify);
    assert.equal(calls.complete.length, beforeComplete);
    assert.equal((await commerceRepository.listEntitlements())[0].state, 'revoked');

    const restore = purchased({
      transactionRef: 'second-lifecycle-restore',
      opaqueProof: 'second-lifecycle-proof',
    });
    state.restore = [restore];
    state.current = [];
    await coordinator().restore();
    assert.equal((await commerceRepository.listEntitlements())[0].state, 'active');
    state.current = [revoked({
      transactionRef: 'second-lifecycle-revocation',
      opaqueProof: 'second-lifecycle-revocation-proof',
    })];
    await coordinator().refresh();
    assert.equal(calls.refresh.length, 2);
    assert.equal((await commerceRepository.listEntitlements())[0].state, 'revoked');
  });
});

test('revoked before any entitlement converges durably without granting access', async () => {
  await withWorld(async ({ commerceRepository, calls, state, coordinator }) => {
    const value = revoked({
      transactionRef: 'reinstall-revocation-native',
      opaqueProof: 'reinstall-revocation-proof',
    });
    state.current = [value];
    await coordinator().recover();
    const [entitlement] = await commerceRepository.listEntitlements();
    assert.equal(entitlement.state, 'revoked');
    assert.equal(entitlement.sealedRefreshHandle, null);
    assert.equal(entitlement.refreshHandleVersion, null);
    assert.deepEqual(calls.finish, ['reinstall-revocation-native']);
  });
});

test('revoked-before-entitlement converges after every durable crash arrow', async () => {
  const checkpoints = [
    'before:journal', 'after:journal',
    'before:verify', 'after:verify',
    'before:mark-verified', 'after:mark-verified',
    'before:entitlement-commit', 'after:entitlement-commit',
    'before:store-finish', 'after:store-finish',
    'before:proof-clear', 'after:proof-clear',
  ];
  for (const checkpoint of checkpoints) {
    await withWorld(async ({ connection, commerceRepository, state, coordinator }) => {
      state.current = [revoked()];
      await assert.rejects(
        coordinator({ failureAt: checkpoint }).recover(),
        { code: 'SIMULATED_CRASH' },
        checkpoint,
      );
      await coordinator().recover();
      const [entitlement] = await commerceRepository.listEntitlements();
      assert.equal(entitlement.state, 'revoked', checkpoint);
      assert.equal(entitlement.sealedRefreshHandle, null, checkpoint);
      const rows = await journalRows(connection);
      assert.equal(rows.length, 1, checkpoint);
      assert.equal(rows[0].processing_state, 'complete', checkpoint);
      assert.equal(rows[0].opaque_proof, null, checkpoint);
    });
  }
});
