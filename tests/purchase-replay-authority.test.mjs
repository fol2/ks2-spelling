import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createPurchaseCoordinator } from '../src/app/purchase-coordinator.js';
import { deriveTransactionReplayJournalId } from '../src/domain/commerce/purchase-state.js';
import { configureAndMigrateDatabase } from '../src/platform/database/migrate-database.js';
import { createSqliteCommerceAttemptRepository } from '../src/platform/database/sqlite-commerce-attempt-repository.js';
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
    const attemptRepository = createSqliteCommerceAttemptRepository(connection, {
      store: 'google',
    });
    const packRepository = createSqlitePackRepositories(connection);
    const calls = {
      verify: [], complete: [], refresh: [], authorise: [], finish: [],
      order: [],
    };
    const state = {
      current: [],
      restore: [],
      purchase: purchased(),
      rejectVerification: false,
      authorisation: authorisation(),
      refreshIdentity: null,
      verifyIdentity: null,
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
        calls.order.push('finish');
        return { completion: 'finished' };
      },
    };
    const gateway = {
      async verifyTransaction(input) {
        calls.verify.push(input);
        calls.order.push('verify');
        if (state.rejectVerification) {
          throw Object.assign(new Error('authenticated permanent rejection'), {
            code: 'PROOF_REJECTED', status: 422, retryable: false,
          });
        }
        state.lastIdentity = state.verifyIdentity ?? identity({
          state: input.opaqueProof.includes('revocation') ? 'revoked' : 'active',
          version: calls.verify.length,
        });
        return state.lastIdentity;
      },
      async completeTransaction(input) {
        calls.complete.push(input);
        calls.order.push('complete');
        return state.lastIdentity;
      },
      async refreshEntitlement(input) {
        calls.refresh.push(input);
        state.lastIdentity = state.refreshIdentity ?? identity({ state: 'revoked' });
        return state.lastIdentity;
      },
      async authorisePackDownload(input) {
        calls.authorise.push(input);
        return {
          ...state.authorisation,
          sealedRefreshHandle: state.lastIdentity.sealedRefreshHandle,
          refreshHandleVersion: state.lastIdentity.refreshHandleVersion,
        };
      },
    };
    function coordinator({ failureAt = 'never' } = {}) {
      let failed = false;
      return createPurchaseCoordinator({
        store,
        gateway,
        commerceRepository,
        attemptRepository,
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

test('pending promotion and a later current callback use bounded non-secret authorities', async () => {
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
    assert.equal(rows.length, 2);
    assert.equal(rows[0].journal_id, 'purchase-google-full-ks2-acquisition');
    assert.equal(rows[1].journal_id, 'purchase-google-full-ks2-active-callback');
    assert.equal(rows.every((row) => row.processing_state === 'complete'), true);
    assert.equal(rows.every((row) => row.opaque_proof === null), true);
    assert.equal(calls.verify.length, 2);
    assert.equal(calls.complete.length, 2);
    assert.deepEqual(calls.finish, ['purchased-native-secret', 'changed-native-secret']);
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
    assert.equal(calls.verify.length, 2);
    assert.equal(calls.verify[0].opaqueProof, 'durable-first-process-proof');
    assert.equal(calls.verify[1].opaqueProof, 'fresh-process-observation-proof');
    assert.deepEqual(calls.finish, ['fresh-process-native-ref']);
  });
});

test('first clean Restore uses stable authority and a later current proof is live reverified', async () => {
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
    const beforeVerify = calls.verify.length;
    await coordinator().recover();
    assert.equal(calls.verify.length, beforeVerify + 1);
    assert.equal(calls.verify.at(-1).opaqueProof, 'process-unstable-proof');
    const rows = await journalRows(connection);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].journal_id, 'purchase-google-full-ks2-acquisition');
    assert.equal(rows[1].journal_id, 'purchase-google-full-ks2-active-callback');
    assert.equal(rows.every((row) => row.processing_state === 'complete'), true);
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
    const beforeVerify = calls.verify.length;
    await coordinator().recover();
    assert.equal(calls.verify.length, beforeVerify + 1);
    const rows = await journalRows(connection);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map(({ processing_state }) => processing_state), ['rejected', 'complete', 'complete']);
    assert.equal(rows.every(({ opaque_proof }) => opaque_proof === null), true);
  });
});

test('a later user purchase escapes a stable rejection and later callbacks stay live verified', async () => {
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
    const beforeVerify = calls.verify.length;
    state.current = [purchased({
      transactionRef: 'later-callback-native',
      opaqueProof: 'later-callback-proof',
    })];
    await coordinator().recover();
    assert.equal(calls.verify.length, beforeVerify + 1);
    assert.equal(calls.verify.at(-1).opaqueProof, 'later-callback-proof');
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

test('an active entitlement journals and live-verifies duplicate proof before completion and native finish', async () => {
  await withWorld(async ({ connection, commerceRepository, calls, state, coordinator }) => {
    await coordinator().handleObservation(purchased());
    const active = (await commerceRepository.listEntitlements())[0];
    const duplicate = purchased({
      transactionRef: 'active-duplicate-native',
      opaqueProof: 'active-duplicate-proof',
    });
    const orderBefore = calls.order.length;
    await coordinator().handleObservation(duplicate);
    assert.deepEqual(calls.order.slice(orderBefore, orderBefore + 3), [
      'verify', 'complete', 'finish',
    ]);
    assert.equal(calls.verify.at(-1).opaqueProof, 'active-duplicate-proof');
    assert.equal(calls.finish.at(-1), 'active-duplicate-native');
    const rows = await connection.query(
      'SELECT journal_id, store_transaction_id, processing_state, opaque_proof FROM transaction_journal ORDER BY journal_id',
    );
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((row) => row.store_transaction_id !== null).length, 1);
    assert.equal(
      rows.find((row) => row.journal_id.endsWith('active-callback')).store_transaction_id,
      null,
    );
    assert.equal(rows.every((row) => row.processing_state === 'complete'), true);
    assert.equal(rows.every((row) => row.opaque_proof === null), true);
    assert.equal((await commerceRepository.listEntitlements())[0].storeTransactionId,
      active.storeTransactionId);

    state.verifyIdentity = identity({ version: 3 });
    await coordinator().handleObservation(purchased({
      transactionRef: 'active-duplicate-native-again',
      opaqueProof: 'active-duplicate-proof-again',
    }));
    assert.equal((await connection.query('SELECT COUNT(*) AS count FROM transaction_journal'))[0].count, 2);
  });
});

test('an active entitlement rejects and clears a changed safe ID without completion or access loss', async () => {
  await withWorld(async ({ connection, commerceRepository, calls, state, coordinator }) => {
    await coordinator().handleObservation(purchased());
    const before = (await commerceRepository.listEntitlements())[0];
    const completionsBefore = calls.complete.length;
    const finishesBefore = calls.finish.length;
    state.verifyIdentity = {
      ...identity({ version: 2 }),
      storeTransactionId: 'GPA.2222-3333-4444-55555',
    };
    await assert.rejects(
      coordinator().handleObservation(purchased({
        transactionRef: 'changed-id-native',
        opaqueProof: 'changed-id-proof',
      })),
      { code: 'PURCHASE_GATEWAY_IDENTITY_MISMATCH' },
    );
    assert.equal(calls.complete.length, completionsBefore);
    assert.equal(calls.finish.length, finishesBefore);
    assert.deepEqual((await commerceRepository.listEntitlements())[0], before);
    const callback = (await connection.query(
      "SELECT store_transaction_id, processing_state, opaque_proof FROM transaction_journal WHERE journal_id LIKE '%active-callback'",
    ))[0];
    assert.deepEqual(callback, {
      store_transaction_id: null,
      processing_state: 'rejected',
      opaque_proof: null,
    });
  });
});

test('changed active-callback authority converges proof-free across rejection crash arrows', async () => {
  for (const checkpoint of ['before:rejection', 'after:rejection']) {
    await withWorld(async ({ connection, commerceRepository, calls, state, coordinator }) => {
      await coordinator().handleObservation(purchased());
      const before = (await commerceRepository.listEntitlements())[0];
      const completionsBefore = calls.complete.length;
      const finishesBefore = calls.finish.length;
      state.verifyIdentity = {
        ...identity({ version: 2 }),
        storeTransactionId: 'GPA.2222-3333-4444-55555',
      };
      state.current = [purchased({
        transactionRef: `changed-id-${checkpoint.replace(':', '-')}`,
        opaqueProof: `changed-proof-${checkpoint.replace(':', '-')}`,
      })];
      await assert.rejects(coordinator({ failureAt: checkpoint }).recover(), {
        code: 'SIMULATED_CRASH',
      }, checkpoint);
      try {
        await coordinator().recover();
      } catch (error) {
        assert.equal(error.code, 'PURCHASE_GATEWAY_IDENTITY_MISMATCH', checkpoint);
      }
      const callback = (await connection.query(
        "SELECT store_transaction_id, processing_state, opaque_proof FROM transaction_journal WHERE journal_id LIKE '%active-callback'",
      ))[0];
      assert.deepEqual(callback, {
        store_transaction_id: null,
        processing_state: 'rejected',
        opaque_proof: null,
      }, checkpoint);
      assert.equal(calls.complete.length, completionsBefore, checkpoint);
      assert.equal(calls.finish.length, finishesBefore, checkpoint);
      assert.deepEqual((await commerceRepository.listEntitlements())[0], before, checkpoint);
    });
  }
});

test('active duplicate callback recovery is constant-row across every durable crash arrow', async () => {
  const checkpoints = [
    'before:journal', 'after:journal',
    'before:verify', 'after:verify',
    'before:mark-verified', 'after:mark-verified',
    'before:entitlement-commit', 'after:entitlement-commit',
    'before:gateway-completion', 'after:gateway-completion',
    'before:store-finish', 'after:store-finish',
    'before:proof-clear', 'after:proof-clear',
  ];
  for (const checkpoint of checkpoints) {
    await withWorld(async ({ connection, commerceRepository, state, coordinator }) => {
      await coordinator().handleObservation(purchased());
      state.current = [purchased({
        transactionRef: `callback-${checkpoint.replace(':', '-')}`,
        opaqueProof: `callback-proof-${checkpoint.replace(':', '-')}`,
      })];
      await assert.rejects(coordinator({ failureAt: checkpoint }).recover(), {
        code: 'SIMULATED_CRASH',
      }, checkpoint);
      await coordinator().recover();
      const rows = await connection.query(
        'SELECT store_transaction_id, processing_state, opaque_proof FROM transaction_journal ORDER BY journal_id',
      );
      assert.equal(rows.length, 2, checkpoint);
      assert.equal(rows.filter((row) => row.store_transaction_id !== null).length, 1, checkpoint);
      assert.equal(rows.every((row) => row.processing_state === 'complete'), true, checkpoint);
      assert.equal(rows.every((row) => row.opaque_proof === null), true, checkpoint);
      assert.equal((await commerceRepository.listEntitlements())[0].state, 'active', checkpoint);
    });
  }
});

test('refresh fails closed when the safe store transaction identity changes', async () => {
  await withWorld(async ({ commerceRepository, state, coordinator }) => {
    await coordinator().handleObservation(purchased());
    const before = (await commerceRepository.listEntitlements())[0];
    state.refreshIdentity = {
      ...identity({ state: 'active', version: 2 }),
      storeTransactionId: 'GPA.2222-3333-4444-55555',
    };
    await assert.rejects(
      coordinator().refresh(),
      { code: 'PURCHASE_GATEWAY_IDENTITY_MISMATCH' },
    );
    assert.deepEqual((await commerceRepository.listEntitlements())[0], before);
  });
});

test('download authorisation fails closed when the safe store transaction identity changes', async () => {
  await withWorld(async ({ commerceRepository, packRepository, state, coordinator }) => {
    await coordinator().handleObservation(purchased());
    await packRepository.deleteDownloadJob({ jobId: 'b3-sandbox-proof.1.0.0-b3.1' });
    const before = (await commerceRepository.listEntitlements())[0];
    state.authorisation = authorisation({
      storeTransactionId: 'GPA.2222-3333-4444-55555',
    });
    state.current = [];
    await assert.rejects(
      coordinator().recover(),
      { code: 'PURCHASE_GATEWAY_IDENTITY_MISMATCH' },
    );
    assert.deepEqual((await commerceRepository.listEntitlements())[0], before);
    assert.deepEqual(await packRepository.listDownloadJobs(), []);
  });
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
