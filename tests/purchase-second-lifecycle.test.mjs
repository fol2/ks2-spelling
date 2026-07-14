import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createPurchaseCoordinator } from '../src/app/purchase-coordinator.js';
import { configureAndMigrateDatabase } from '../src/platform/database/migrate-database.js';
import { createSqliteCommerceAttemptRepository } from '../src/platform/database/sqlite-commerce-attempt-repository.js';
import { createSqliteCommerceRepositories } from '../src/platform/database/sqlite-commerce-repositories.js';

import { createNodeSqliteConnection } from './helpers/node-sqlite-connection.mjs';

const PRODUCT_ID = 'full_ks2';
const STABLE_ACQUISITION_ID = 'purchase-google-full-ks2-acquisition';
const STABLE_REVOCATION_ID = 'purchase-google-full-ks2-revocation';
const FIRST_STORE_ID = 'GPA.1234-5678-9012-34567';
const SECOND_STORE_ID = 'GPA.2222-3333-4444-55555';
const THIRD_STORE_ID = 'GPA.7777-8888-9999-00000';
const MANIFEST_SHA256 = '39b6a788a3686d7cbf1fd4791bce45623af21ef53c60eabc03d955395856218a';
const ARCHIVE_SHA256 = '4c2ca2eb4d4bb7ac3347b66e3483dcb6aa71b41958704733bfc471c970ce7664';
const ARCHIVE_ETAG = '913d2b2485ca6cd31d467bd7228d7e75';

function purchased(suffix, opaqueProof = `proof-${suffix}`) {
  return Object.freeze({
    store: 'google',
    environment: 'sandbox',
    productId: PRODUCT_ID,
    outcome: 'purchased',
    transactionRef: `native-${suffix}`,
    opaqueProof,
  });
}

function revoked(suffix = 'revoked') {
  return Object.freeze({
    store: 'google',
    environment: 'sandbox',
    productId: PRODUCT_ID,
    outcome: 'revoked',
    transactionRef: `native-${suffix}`,
    opaqueProof: `proof-${suffix}`,
  });
}

function outcome(kind, suffix = kind) {
  return Object.freeze({
    store: 'google',
    environment: 'sandbox',
    productId: PRODUCT_ID,
    outcome: kind,
    transactionRef: `native-${suffix}`,
  });
}

function identity({
  state = 'active',
  storeTransactionId = FIRST_STORE_ID,
  handleVersion = storeTransactionId === FIRST_STORE_ID ? 1 : 2,
} = {}) {
  return Object.freeze({
    store: 'google',
    productId: PRODUCT_ID,
    environment: 'sandbox',
    applicationId: 'uk.eugnel.ks2spelling',
    entitlementId: 'full-ks2',
    state,
    storeTransactionId,
    sealedRefreshHandle: `b3rh1.${handleVersion}.nonce.ciphertext`,
    refreshHandleVersion: handleVersion,
    traceId: '123e4567-e89b-42d3-a456-426614174000',
    workerVersionId: 'worker-test',
    workerScriptAuthoritySha256: 'a'.repeat(64),
  });
}

function authorisation(authority) {
  return Object.freeze({
    ...authority,
    packId: 'b3-sandbox-proof',
    version: '1.0.0-b3.1',
    signedManifestEnvelopeBase64: 'e30=',
    signedEnvelopeSha256: MANIFEST_SHA256,
    objects: Object.freeze([
      Object.freeze({
        objectKind: 'manifest',
        sha256: MANIFEST_SHA256,
        size: 1_135,
        etag: 'c76b2858b8345814279a1c92ae64e365',
      }),
      Object.freeze({
        objectKind: 'archive',
        sha256: ARCHIVE_SHA256,
        size: 1_324,
        etag: ARCHIVE_ETAG,
      }),
    ]),
    archiveCapability: Object.freeze({
      packId: 'b3-sandbox-proof',
      version: '1.0.0-b3.1',
      archiveName: 'b3-sandbox-proof.zip',
      sha256: ARCHIVE_SHA256,
      compressedBytes: 1_324,
      etag: ARCHIVE_ETAG,
      capabilityUrl: 'https://b3-gateway.eugnel.uk/v1/packs/b3-sandbox-proof/1.0.0-b3.1/b3-sandbox-proof.zip?expires=1783987200&cap=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    }),
  });
}

async function withWorld(run) {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-spelling-retry-'));
  const connection = createNodeSqliteConnection(join(directory, 'commerce.sqlite'));
  await connection.open();
  try {
    await configureAndMigrateDatabase(connection);
    const commerceRepository = createSqliteCommerceRepositories(connection);
    const attemptRepository = createSqliteCommerceAttemptRepository(connection, {
      store: 'google',
    });
    const calls = [];
    const native = [];
    const jobs = [];
    let purchaseResult = purchased('first');
    let restoreResults = [];
    let gatewayIdentity = identity();
    let nextId = 0;
    const store = {
      async queryProducts() { return []; },
      async purchase(input) {
        calls.push(['purchase', input]);
        return purchaseResult;
      },
      async queryTransactions(input) {
        calls.push(['queryTransactions', input]);
        return [...native];
      },
      async restore(input) {
        calls.push(['restore', input]);
        return [...restoreResults];
      },
      async finishTransaction(input) {
        calls.push(['finishTransaction', input]);
        const index = native.findIndex((entry) => entry.transactionRef === input.transactionRef);
        if (index !== -1) native.splice(index, 1);
        return Object.freeze({ completion: 'finished' });
      },
      async subscribeTransactionUpdates() {
        return Object.freeze({ async remove() {} });
      },
    };
    const gateway = {
      async verifyTransaction(input) {
        calls.push(['verifyTransaction', input]);
        return gatewayIdentity;
      },
      async completeTransaction(input) {
        calls.push(['completeTransaction', input]);
        return gatewayIdentity;
      },
      async refreshEntitlement(input) {
        calls.push(['refreshEntitlement', input]);
        return gatewayIdentity;
      },
      async authorisePackDownload(input) {
        calls.push(['authorisePackDownload', input]);
        return authorisation(gatewayIdentity);
      },
    };
    const downloadRepository = {
      async listDownloadJobs() { return jobs; },
      async upsertDownloadJob(value) { jobs.push(value); return value; },
    };
    const makeCoordinator = (failureInjector = async () => {}, overrides = {}) =>
      createPurchaseCoordinator({
        store,
        gateway,
        commerceRepository,
        attemptRepository,
        downloadRepository,
        clock: () => 10_000,
        idFactory: () => `explicit-attempt-${nextId += 1}`,
        failureInjector,
        ...overrides,
      });
    await run({
      connection,
      commerceRepository,
      attemptRepository,
      calls,
      native,
      jobs,
      store,
      gateway,
      makeCoordinator,
      setPurchaseResult(value) { purchaseResult = value; },
      setRestoreResults(value) { restoreResults = value; },
      setGatewayIdentity(value) { gatewayIdentity = value; },
    });
  } finally {
    await connection.close();
    await rm(directory, { force: true, recursive: true });
  }
}

async function rows(connection) {
  return connection.query(
    'SELECT journal_id, observation_state, processing_state, opaque_proof, store_transaction_id FROM transaction_journal ORDER BY created_at, journal_id',
  );
}

async function bootstrapActive(world) {
  world.setPurchaseResult(purchased('first'));
  await world.makeCoordinator().purchaseFullKs2({ productId: PRODUCT_ID });
}

async function bootstrapRevoked(world) {
  await bootstrapActive(world);
  world.setGatewayIdentity(identity({ state: 'revoked' }));
  await world.makeCoordinator().handleObservation(revoked());
}

async function seedPurchasedRecoveryWithPendingIntent(world, operation) {
  await bootstrapActive(world);
  const existingJob = structuredClone(world.jobs[0]);
  const purchasedJournalId = `orphan-recovery-${operation}`;
  const pendingJournalId = `orphan-intent-${operation}`;
  await world.commerceRepository.observeTransaction({
    journalId: purchasedJournalId,
    store: 'google',
    productId: PRODUCT_ID,
    observationState: 'purchased',
    opaqueProof: `proof-orphan-${operation}`,
    observedAt: 20_000,
  });
  await world.attemptRepository.preparePendingAttempt({
    journalId: pendingJournalId,
    observedAt: 20_001,
  });
  return { existingJob, purchasedJournalId, pendingJournalId };
}

function configureRevocationAuthority(world) {
  const activeAuthority = identity();
  const revokedAuthority = identity({ state: 'revoked' });
  world.gateway.verifyTransaction = async (input) => {
    world.calls.push(['verifyTransaction', input]);
    return activeAuthority;
  };
  world.gateway.completeTransaction = async (input) => {
    world.calls.push(['completeTransaction', input]);
    return activeAuthority;
  };
  world.gateway.refreshEntitlement = async (input) => {
    world.calls.push(['refreshEntitlement', input]);
    return revokedAuthority;
  };
}

function runExplicitParentOperation(coordinator, operation) {
  return operation === 'Buy'
    ? coordinator.purchaseFullKs2({ productId: PRODUCT_ID })
    : coordinator.restore();
}

test('explicit Buy persists one intent before native work and recovers a second lifecycle after process loss', async () => {
  await withWorld(async (world) => {
    await bootstrapRevoked(world);
    const acquired = purchased('second-before-return', 'proof-before-process-loss');
    world.setGatewayIdentity(identity({ storeTransactionId: SECOND_STORE_ID }));
    world.store.purchase = async (input) => {
      world.calls.push(['purchase', input]);
      world.native.push(acquired);
      throw Object.assign(new Error('process lost after native success'), {
        code: 'SIMULATED_PROCESS_LOSS',
      });
    };

    await assert.rejects(
      world.makeCoordinator().purchaseFullKs2({ productId: PRODUCT_ID }),
      { code: 'SIMULATED_PROCESS_LOSS' },
    );
    const beforeRecovery = await rows(world.connection);
    assert.equal(beforeRecovery.filter((row) => row.observation_state === 'pending').length, 1);
    assert.equal(beforeRecovery.some((row) => row.opaque_proof === acquired.opaqueProof), false);

    world.native[0] = purchased('second-after-restart', 'changed-proof-after-restart');
    await world.makeCoordinator().recover();

    const entitlement = (await world.commerceRepository.listEntitlements())[0];
    assert.equal(entitlement.state, 'active');
    assert.equal(entitlement.refreshHandleVersion, 2);
    const afterRecovery = await rows(world.connection);
    assert.equal(afterRecovery.at(-1).processing_state, 'complete');
    assert.equal(afterRecovery.at(-1).store_transaction_id, SECOND_STORE_ID);
    assert.equal(afterRecovery.at(-1).opaque_proof, null);
  });
});

test('Parent Buy preflights one purchased journal before any second store purchase', async () => {
  await withWorld(async (world) => {
    const acquired = purchased('buy-preflight', 'buy-preflight-proof');
    world.native.push(acquired);
    world.setPurchaseResult(acquired);
    let journalWrites = 0;
    await assert.rejects(
      world.makeCoordinator(async (checkpoint) => {
        if (checkpoint === 'after:journal' && (journalWrites += 1) === 2) {
          throw Object.assign(new Error('process lost after purchased journal'), {
            code: 'SIMULATED_PROCESS_LOSS',
          });
        }
      }).purchaseFullKs2({ productId: PRODUCT_ID }),
      { code: 'SIMULATED_PROCESS_LOSS' },
    );
    assert.equal((await rows(world.connection))[0].processing_state, 'observed');
    assert.deepEqual(await world.commerceRepository.listEntitlements(), []);

    let secondStorePurchases = 0;
    world.store.purchase = async (input) => {
      world.calls.push(['purchase', input]);
      secondStorePurchases += 1;
      return acquired;
    };
    await world.makeCoordinator().purchaseFullKs2({ productId: PRODUCT_ID });

    assert.equal(secondStorePurchases, 0);
    const durable = await rows(world.connection);
    assert.equal(durable.length, 1);
    assert.equal(durable[0].journal_id, STABLE_ACQUISITION_ID);
    assert.equal(durable[0].processing_state, 'complete');
    assert.equal(durable[0].opaque_proof, null);
    assert.equal((await world.commerceRepository.listEntitlements())[0].state, 'active');
  });
});

test('explicit pending Buy promotes the same intent and reactivates a revoked entitlement', async () => {
  await withWorld(async (world) => {
    await bootstrapRevoked(world);
    world.setGatewayIdentity(identity({ storeTransactionId: SECOND_STORE_ID }));
    world.setPurchaseResult(outcome('pending', 'second-pending'));
    await world.makeCoordinator().purchaseFullKs2({ productId: PRODUCT_ID });
    const pendingRows = (await rows(world.connection)).filter(
      (row) => row.observation_state === 'pending' && row.processing_state === 'observed',
    );
    assert.equal(pendingRows.length, 1);

    await world.makeCoordinator().handleObservation(
      purchased('second-approved', 'second-approved-proof'),
    );
    const entitlement = (await world.commerceRepository.listEntitlements())[0];
    assert.equal(entitlement.state, 'active');
    const promoted = await rows(world.connection);
    assert.equal(promoted.some((row) => row.journal_id === pendingRows[0].journal_id &&
      row.observation_state === 'purchased' && row.processing_state === 'complete'), true);
  });
});

test('Restore journal replay associates the sole acquisition after native reference and proof change', async () => {
  await withWorld(async (world) => {
    await bootstrapActive(world);
    const restored = purchased('restore-before-crash', 'restore-proof-before-crash');
    world.native.push(restored);
    world.setRestoreResults([restored]);
    world.setGatewayIdentity(identity({ storeTransactionId: SECOND_STORE_ID }));
    let afterJournalCount = 0;
    const crashAfterPurchasedJournal = async (checkpoint) => {
      if (checkpoint === 'after:journal' && (afterJournalCount += 1) === 2) {
        throw Object.assign(new Error('process lost after purchased journal'), {
          code: 'SIMULATED_PROCESS_LOSS',
        });
      }
    };

    await assert.rejects(
      world.makeCoordinator(crashAfterPurchasedJournal).restore(),
      { code: 'SIMULATED_PROCESS_LOSS' },
    );
    const durable = await rows(world.connection);
    const recoverable = durable.filter((row) => row.processing_state === 'observed');
    assert.equal(recoverable.length, 1);
    assert.equal(recoverable[0].observation_state, 'purchased');

    world.native[0] = purchased('restore-after-restart', 'changed-restore-proof');
    const verifiesBeforeRecovery = world.calls.filter(([name]) => name === 'verifyTransaction').length;
    await world.makeCoordinator().recover();
    const finished = await rows(world.connection);
    assert.equal(finished.at(-1).processing_state, 'complete');
    assert.equal(finished.at(-1).opaque_proof, null);
    assert.equal(
      world.calls.filter(([name]) => name === 'completeTransaction').length,
      2,
      'one initial acquisition and one restored lifecycle complete exactly once each',
    );
    assert.equal(world.native.length, 0);
    const replayProofs = world.calls
      .filter(([name]) => name === 'verifyTransaction')
      .slice(verifiesBeforeRecovery)
      .map(([, input]) => input.opaqueProof);
    assert.deepEqual(replayProofs, [
      'restore-proof-before-crash',
      'changed-restore-proof',
    ]);
  });
});

test('Parent Restore preflights one purchased journal before any second restore attempt', async () => {
  await withWorld(async (world) => {
    const restored = purchased('restore-preflight', 'restore-preflight-proof');
    world.native.push(restored);
    world.setRestoreResults([restored]);
    let journalWrites = 0;
    await assert.rejects(
      world.makeCoordinator(async (checkpoint) => {
        if (checkpoint === 'after:journal' && (journalWrites += 1) === 2) {
          throw Object.assign(new Error('process lost after Restore journal'), {
            code: 'SIMULATED_PROCESS_LOSS',
          });
        }
      }).restore(),
      { code: 'SIMULATED_PROCESS_LOSS' },
    );
    assert.equal((await rows(world.connection))[0].processing_state, 'observed');

    let secondRestores = 0;
    world.store.restore = async (input) => {
      world.calls.push(['restore', input]);
      secondRestores += 1;
      return [restored];
    };
    await world.makeCoordinator().restore();

    assert.equal(secondRestores, 0);
    const durable = await rows(world.connection);
    assert.equal(durable.length, 1);
    assert.equal(durable[0].journal_id, STABLE_ACQUISITION_ID);
    assert.equal(durable[0].processing_state, 'complete');
    assert.equal(durable[0].opaque_proof, null);
    assert.equal((await world.commerceRepository.listEntitlements())[0].state, 'active');
  });
});

test('changed native proof must reverify to the same durable store transaction before finishing', async () => {
  await withWorld(async (world) => {
    await bootstrapActive(world);
    const restored = purchased('authority-a', 'proof-authority-a');
    world.native.push(restored);
    world.setRestoreResults([restored]);
    world.setGatewayIdentity(identity({ storeTransactionId: SECOND_STORE_ID }));
    let journalWrites = 0;
    await assert.rejects(
      world.makeCoordinator(async (checkpoint) => {
        if (checkpoint === 'after:journal' && (journalWrites += 1) === 2) {
          throw Object.assign(new Error('process lost'), { code: 'SIMULATED_PROCESS_LOSS' });
        }
      }).restore(),
      { code: 'SIMULATED_PROCESS_LOSS' },
    );
    world.native[0] = purchased('authority-b', 'proof-authority-b');
    world.gateway.verifyTransaction = async (input) => {
      world.calls.push(['verifyTransaction', input]);
      return identity({
        storeTransactionId:
          input.opaqueProof === 'proof-authority-b' ? THIRD_STORE_ID : SECOND_STORE_ID,
      });
    };
    const effectsBefore = world.calls.length;
    await assert.rejects(
      world.makeCoordinator().recover(),
      { code: 'PURCHASE_GATEWAY_IDENTITY_MISMATCH' },
    );
    assert.equal(
      world.calls.slice(effectsBefore).some(([name]) =>
        name === 'completeTransaction' || name === 'finishTransaction'),
      false,
    );
    const durable = await rows(world.connection);
    assert.equal(durable.at(-1).processing_state, 'verified');
    assert.equal(durable.at(-1).opaque_proof, 'proof-authority-a');
  });
});

test('permanently rejected replacement proof preserves durable proof A and performs no completion', async () => {
  await withWorld(async (world) => {
    await bootstrapActive(world);
    const restored = purchased('permanent-a', 'proof-permanent-a');
    world.native.push(restored);
    world.setRestoreResults([restored]);
    world.setGatewayIdentity(identity({ storeTransactionId: SECOND_STORE_ID }));
    let journalWrites = 0;
    await assert.rejects(
      world.makeCoordinator(async (checkpoint) => {
        if (checkpoint === 'after:journal' && (journalWrites += 1) === 2) {
          throw Object.assign(new Error('process lost'), { code: 'SIMULATED_PROCESS_LOSS' });
        }
      }).restore(),
      { code: 'SIMULATED_PROCESS_LOSS' },
    );
    world.native[0] = purchased('permanent-b', 'proof-permanent-b');
    world.gateway.verifyTransaction = async (input) => {
      world.calls.push(['verifyTransaction', input]);
      if (input.opaqueProof === 'proof-permanent-b') {
        throw Object.assign(new Error('replacement rejected'), {
          code: 'PROOF_REJECTED', status: 422, retryable: false,
        });
      }
      return identity({ storeTransactionId: SECOND_STORE_ID });
    };
    const effectsBefore = world.calls.length;
    await assert.rejects(world.makeCoordinator().recover(), { code: 'PROOF_REJECTED' });
    assert.equal(
      world.calls.slice(effectsBefore).some(([name]) =>
        name === 'completeTransaction' || name === 'finishTransaction'),
      false,
    );
    const durable = await rows(world.connection);
    assert.equal(durable.at(-1).processing_state, 'verified');
    assert.equal(durable.at(-1).opaque_proof, 'proof-permanent-a');
    assert.equal(durable.some((row) => row.opaque_proof === 'proof-permanent-b'), false);
  });
});

test('active entitlement Buy is a local no-op while explicit Restore still opens one attempt', async () => {
  await withWorld(async (world) => {
    await bootstrapActive(world);
    const durableBefore = await rows(world.connection);
    const callsBefore = world.calls.length;
    assert.deepEqual(
      await world.makeCoordinator().purchaseFullKs2({ productId: PRODUCT_ID }),
      { state: 'complete' },
    );
    assert.deepEqual(await rows(world.connection), durableBefore);
    assert.equal(
      world.calls.slice(callsBefore).some(([name]) => name === 'purchase'),
      false,
    );

    const restored = purchased('active-restore', 'active-restore-proof');
    world.setRestoreResults([restored]);
    world.setGatewayIdentity(identity({ storeTransactionId: SECOND_STORE_ID }));
    await world.makeCoordinator().restore();
    const afterRestore = await rows(world.connection);
    assert.equal(afterRestore.length, durableBefore.length + 1);
    assert.equal(afterRestore.at(-1).processing_state, 'complete');
  });
});

test('active Buy reconciles one incomplete acquisition without opening a second store purchase', async () => {
  await withWorld(async (world) => {
    const first = purchased('incomplete-active');
    world.native.push(first);
    world.setPurchaseResult(first);
    let entitlementCommitSeen = 0;
    await assert.rejects(
      world.makeCoordinator(async (checkpoint) => {
        if (checkpoint === 'after:entitlement-commit' && (entitlementCommitSeen += 1) === 1) {
          throw Object.assign(new Error('process lost after commit'), {
            code: 'SIMULATED_PROCESS_LOSS',
          });
        }
      }).purchaseFullKs2({ productId: PRODUCT_ID }),
      { code: 'SIMULATED_PROCESS_LOSS' },
    );
    assert.equal((await world.commerceRepository.listEntitlements())[0].state, 'active');
    assert.equal((await rows(world.connection))[0].processing_state, 'store-completion-pending');
    const callsBefore = world.calls.length;

    await world.makeCoordinator().purchaseFullKs2({ productId: PRODUCT_ID });
    assert.equal((await rows(world.connection))[0].processing_state, 'complete');
    assert.equal(
      world.calls.slice(callsBefore).some(([name]) => name === 'purchase'),
      false,
    );
    assert.equal(world.native.length, 0);
  });
});

test('Parent Buy completes purchased recovery and clears a surviving empty intent without buying again', async () => {
  await withWorld(async (world) => {
    const authority = await seedPurchasedRecoveryWithPendingIntent(world, 'buy');
    const callsBefore = world.calls.length;

    const result = await world.makeCoordinator().purchaseFullKs2({ productId: PRODUCT_ID });

    assert.deepEqual(result, { state: 'complete' });
    assert.equal(
      world.calls.slice(callsBefore).some(([name]) => name === 'purchase' || name === 'restore'),
      false,
    );
    const durable = await rows(world.connection);
    assert.equal(durable.some((row) => row.journal_id === authority.pendingJournalId), false);
    assert.deepEqual(durable.filter((row) =>
      row.journal_id === authority.purchasedJournalId), [{
      journal_id: authority.purchasedJournalId,
      observation_state: 'purchased',
      processing_state: 'complete',
      opaque_proof: null,
      store_transaction_id: FIRST_STORE_ID,
    }]);
    assert.equal((await world.commerceRepository.listEntitlements())[0].state, 'active');
    assert.deepEqual(world.jobs, [authority.existingJob]);
  });
});

test('Parent Restore reports purchased recovery and clears a surviving empty intent without restoring again', async () => {
  await withWorld(async (world) => {
    const authority = await seedPurchasedRecoveryWithPendingIntent(world, 'restore');
    const callsBefore = world.calls.length;

    const result = await world.makeCoordinator().restore();

    assert.deepEqual(result, { state: 'restored' });
    assert.equal(
      world.calls.slice(callsBefore).some(([name]) => name === 'purchase' || name === 'restore'),
      false,
    );
    const durable = await rows(world.connection);
    assert.equal(durable.some((row) => row.journal_id === authority.pendingJournalId), false);
    assert.deepEqual(durable.filter((row) =>
      row.journal_id === authority.purchasedJournalId), [{
      journal_id: authority.purchasedJournalId,
      observation_state: 'purchased',
      processing_state: 'complete',
      opaque_proof: null,
      store_transaction_id: FIRST_STORE_ID,
    }]);
    assert.equal((await world.commerceRepository.listEntitlements())[0].state, 'active');
    assert.deepEqual(world.jobs, [authority.existingJob]);
  });
});

for (const operation of ['Buy', 'Restore']) {
  for (const snapshot of ['pending', 'revocation']) {
    test(`Parent ${operation} recovers a purchased journal before a coexisting ${snapshot} intent snapshot`, async () => {
      await withWorld(async (world) => {
        const authority = await seedPurchasedRecoveryWithPendingIntent(
          world,
          `${operation.toLowerCase()}-${snapshot}`,
        );
        if (snapshot === 'pending') {
          world.native.push(outcome('pending', `${operation.toLowerCase()}-coexisting-pending`));
        } else {
          configureRevocationAuthority(world);
          world.native.push(revoked(`${operation.toLowerCase()}-coexisting-revocation`));
        }
        const callsBefore = world.calls.length;

        const result = await runExplicitParentOperation(world.makeCoordinator(), operation);

        assert.deepEqual(result, { state: snapshot === 'pending' ? 'pending' : 'revoked' });
        const relevantCalls = world.calls.slice(callsBefore);
        assert.equal(
          relevantCalls.some(([name]) => name === 'purchase' || name === 'restore'),
          false,
        );
        const durable = await rows(world.connection);
        assert.equal(durable.some((row) =>
          row.journal_id === authority.purchasedJournalId &&
          row.observation_state === 'purchased' &&
          row.processing_state === 'complete' &&
          row.opaque_proof === null), true);
        assert.equal(durable.some((row) =>
          row.journal_id === authority.pendingJournalId &&
          row.observation_state === 'pending' &&
          row.processing_state === 'observed' &&
          row.opaque_proof === null &&
          row.store_transaction_id === null), true);
        const entitlement = (await world.commerceRepository.listEntitlements())[0];
        if (snapshot === 'pending') {
          assert.equal(entitlement.state, 'active');
          assert.notEqual(entitlement.sealedRefreshHandle, null);
        } else {
          assert.ok(
            relevantCalls.findIndex(([name]) => name === 'completeTransaction') <
            relevantCalls.findIndex(([name]) => name === 'refreshEntitlement'),
          );
          assert.equal(entitlement.state, 'revoked');
          assert.equal(entitlement.sealedRefreshHandle, null);
          assert.equal(durable.some((row) =>
            row.observation_state === 'revoked' &&
            row.processing_state === 'complete' &&
            row.opaque_proof === null), true);
        }
      });
    });
  }
}

for (const operation of ['Buy', 'Restore']) {
  for (const [checkpoint, occurrence, retrySnapshot] of [
    ['after:store-finish', 1, 'empty'],
    ['after:proof-clear', 2, 'empty'],
    ['after:proof-clear', 2, 'cancelled'],
  ]) {
    test(`Parent ${operation} resumes coexisting revocation ${checkpoint} with ${retrySnapshot} retry authority`, async () => {
      await withWorld(async (world) => {
        const authority = await seedPurchasedRecoveryWithPendingIntent(
          world,
          `${operation.toLowerCase()}-revocation-retry`,
        );
        configureRevocationAuthority(world);
        world.native.push(revoked(`${operation.toLowerCase()}-revocation-retry`));
        let seen = 0;
        const loseDuringRevocationCompletion = async (observedCheckpoint) => {
          if (observedCheckpoint === checkpoint && (seen += 1) === occurrence) {
            throw Object.assign(new Error('process lost after native revocation finish'), {
              code: 'SIMULATED_PROCESS_LOSS',
            });
          }
        };
        const firstCoordinator = world.makeCoordinator(loseDuringRevocationCompletion);

        await assert.rejects(
          runExplicitParentOperation(firstCoordinator, operation),
          { code: 'SIMULATED_PROCESS_LOSS' },
        );
        assert.deepEqual(world.native, []);
        if (retrySnapshot === 'cancelled') {
          world.native.push(outcome('cancelled', `${operation.toLowerCase()}-revocation-retry`));
        }
        const callsBeforeRetry = world.calls.length;

        const result = await runExplicitParentOperation(world.makeCoordinator(), operation);

        assert.deepEqual(result, { state: 'revoked' });
        assert.equal(
          world.calls.slice(callsBeforeRetry).some(([name]) =>
            name === 'purchase' || name === 'restore'),
          false,
        );
        const durable = await rows(world.connection);
        assert.equal(durable.some((row) =>
          row.journal_id === authority.pendingJournalId &&
          row.observation_state === 'pending' &&
          row.processing_state === 'observed'), true);
        assert.equal(durable.some((row) =>
          row.observation_state === 'revoked' &&
          row.processing_state === 'complete' &&
          row.opaque_proof === null), true);
        const entitlement = (await world.commerceRepository.listEntitlements())[0];
        assert.equal(entitlement.state, 'revoked');
        assert.equal(entitlement.sealedRefreshHandle, null);
      });
    });
  }
}

for (const operation of ['Buy', 'Restore']) {
  for (const retrySnapshot of ['empty', 'cancelled']) {
    test(`Parent ${operation} preserves completed purchased recovery over a ${retrySnapshot} intent retry`, async () => {
      await withWorld(async (world) => {
        const authority = await seedPurchasedRecoveryWithPendingIntent(
          world,
          `${operation.toLowerCase()}-purchased-proof-clear-${retrySnapshot}`,
        );
        if (retrySnapshot === 'cancelled') {
          world.native.push(outcome('cancelled', `${operation.toLowerCase()}-purchased-retry`));
        }
        const loseAfterPurchasedProofClear = async (checkpoint) => {
          if (checkpoint === 'after:proof-clear') {
            throw Object.assign(new Error('process lost after purchased proof clear'), {
              code: 'SIMULATED_PROCESS_LOSS',
            });
          }
        };

        await assert.rejects(
          runExplicitParentOperation(
            world.makeCoordinator(loseAfterPurchasedProofClear),
            operation,
          ),
          { code: 'SIMULATED_PROCESS_LOSS' },
        );
        const callsBeforeRetry = world.calls.length;

        const result = await runExplicitParentOperation(world.makeCoordinator(), operation);

        assert.deepEqual(result, {
          state: operation === 'Buy' ? 'complete' : 'restored',
        });
        assert.equal(
          world.calls.slice(callsBeforeRetry).some(([name]) =>
            name === 'purchase' || name === 'restore'),
          false,
        );
        const durable = await rows(world.connection);
        assert.equal(durable.some((row) => row.journal_id === authority.pendingJournalId), false);
        assert.equal(durable.some((row) =>
          row.journal_id === authority.purchasedJournalId &&
          row.observation_state === 'purchased' &&
          row.processing_state === 'complete' &&
          row.opaque_proof === null), true);
        const entitlement = (await world.commerceRepository.listEntitlements())[0];
        assert.equal(entitlement.state, 'active');
        assert.notEqual(entitlement.sealedRefreshHandle, null);
      });
    });
  }
}

test('a lifecycle not strictly later than the Parent intent cannot claim terminal precedence', async () => {
  for (const lifecycleState of ['active', 'revoked']) {
    for (const operation of ['Buy', 'Restore']) {
      for (const timing of ['equal', 'newer']) {
        await withWorld(async (world) => {
          if (lifecycleState === 'active') await bootstrapActive(world);
          else await bootstrapRevoked(world);
          const entitlement = (await world.commerceRepository.listEntitlements())[0];
          const lifecycleAt = lifecycleState === 'active'
            ? entitlement.verifiedAt
            : entitlement.revocationAt;
          const attempt = await world.attemptRepository.preparePendingAttempt({
            journalId: `${timing}-${lifecycleState}-${operation.toLowerCase()}-intent`,
            observedAt: timing === 'equal' ? lifecycleAt : 50_000,
          });
          world.native.push(outcome('cancelled', `${timing}-${lifecycleState}-intent`));
          const callsBeforeRetry = world.calls.length;

          const result = await runExplicitParentOperation(world.makeCoordinator(), operation);

          const label = `${lifecycleState}/${operation}/${timing}`;
          assert.deepEqual(result, { state: 'cancelled' }, label);
          assert.equal(
            world.calls.slice(callsBeforeRetry).some(([name]) =>
              name === 'purchase' || name === 'restore'),
            false,
            label,
          );
          assert.equal(
            (await rows(world.connection)).some((row) => row.journal_id === attempt.journalId),
            false,
            label,
          );
        });
      }
    }
  }
});

test('a routine handle refresh after the Parent intent cannot claim purchase precedence', async () => {
  for (const operation of ['Buy', 'Restore']) {
    for (const retrySnapshot of ['empty', 'cancelled']) {
      await withWorld(async (world) => {
        await bootstrapActive(world);
        const activeBeforeIntent = (await world.commerceRepository.listEntitlements())[0];
        const attempt = await world.attemptRepository.preparePendingAttempt({
          journalId: `routine-refresh-${operation.toLowerCase()}-${retrySnapshot}-intent`,
          observedAt: 50_000,
        });

        await world.makeCoordinator().refresh();
        const refreshed = (await world.commerceRepository.listEntitlements())[0];
        assert.equal(refreshed.storeTransactionId, activeBeforeIntent.storeTransactionId);
        assert.equal(refreshed.verifiedAt, activeBeforeIntent.verifiedAt);
        assert.equal(refreshed.refreshedAt > attempt.updatedAt, true);
        if (retrySnapshot === 'cancelled') {
          world.native.push(outcome('cancelled', `routine-refresh-${operation.toLowerCase()}`));
        }
        const callsBeforeRetry = world.calls.length;

        const result = await runExplicitParentOperation(world.makeCoordinator(), operation);

        const label = `${operation}/${retrySnapshot}`;
        assert.deepEqual(result, { state: 'cancelled' }, label);
        assert.equal(
          world.calls.slice(callsBeforeRetry).some(([name]) =>
            name === 'purchase' || name === 'restore'),
          false,
          label,
        );
        assert.equal(
          (await rows(world.connection)).some((row) => row.journal_id === attempt.journalId),
          false,
          label,
        );
      });
    }
  }
});

test('Restore rejects a foreign-platform acquisition and discards its safe configured intent', async () => {
  await withWorld(async (world) => {
    const foreign = Object.freeze({
      store: 'apple',
      environment: 'sandbox',
      productId: 'uk.eugnel.ks2spelling.fullks2',
      outcome: 'purchased',
      transactionRef: 'foreign-native-reference',
      opaqueProof: 'foreign-proof',
    });
    world.setRestoreResults([foreign]);
    const callsBefore = world.calls.length;
    await assert.rejects(
      world.makeCoordinator().restore(),
      { code: 'PURCHASE_ATTEMPT_AUTHORITY_MISMATCH' },
    );
    assert.equal(
      world.calls.slice(callsBefore).some(([name]) =>
        name === 'verifyTransaction' || name === 'finishTransaction'),
      false,
    );
    const durable = await rows(world.connection);
    assert.deepEqual(durable, []);
  });
});

test('cancelled and empty explicit operations discard intent rows before any later native proof', async () => {
  for (const operation of ['cancelled-buy', 'unverified-buy', 'empty-restore', 'cancelled-restore']) {
    await withWorld(async (world) => {
      if (operation === 'cancelled-buy') world.setPurchaseResult(outcome('cancelled'));
      if (operation === 'unverified-buy') world.setPurchaseResult(outcome('unverified'));
      if (operation === 'cancelled-restore') world.setRestoreResults([outcome('cancelled')]);
      if (operation.endsWith('buy')) {
        await world.makeCoordinator().purchaseFullKs2({ productId: PRODUCT_ID });
      } else {
        await world.makeCoordinator().restore();
      }
      assert.deepEqual(await rows(world.connection), [], operation);
      assert.deepEqual(await world.commerceRepository.listEntitlements(), [], operation);

      const unrelated = purchased(`unrelated-${operation}`);
      world.native.push(unrelated);
      await world.makeCoordinator().recover();
      const durable = await rows(world.connection);
      assert.equal(durable.length, 1, operation);
      assert.equal(durable[0].journal_id, STABLE_ACQUISITION_ID, operation);
      assert.equal(durable[0].opaque_proof, null, operation);
    });
  }
});

test('a crash before cancelled or empty intent discard preserves one-shot authority without access', async () => {
  for (const operation of ['cancelled-buy', 'empty-restore']) {
    await withWorld(async (world) => {
      if (operation === 'cancelled-buy') world.setPurchaseResult(outcome('cancelled'));
      const crash = async (checkpoint) => {
        if (checkpoint === 'before:attempt-discard') {
          throw Object.assign(new Error('process lost before intent discard'), {
            code: 'SIMULATED_PROCESS_LOSS',
          });
        }
      };
      await assert.rejects(
        operation === 'cancelled-buy'
          ? world.makeCoordinator(crash).purchaseFullKs2({ productId: PRODUCT_ID })
          : world.makeCoordinator(crash).restore(),
        { code: 'SIMULATED_PROCESS_LOSS' },
      );
      const pending = await rows(world.connection);
      assert.equal(pending.length, 1, operation);
      assert.equal(pending[0].observation_state, 'pending', operation);
      assert.equal(pending[0].opaque_proof, null, operation);
      assert.deepEqual(await world.commerceRepository.listEntitlements(), [], operation);

      const later = purchased(`later-${operation}`);
      world.native.push(later);
      await world.makeCoordinator().recover();
      const completed = await rows(world.connection);
      assert.equal(completed.length, 1, operation);
      assert.equal(completed[0].processing_state, 'complete', operation);
      assert.equal(completed[0].opaque_proof, null, operation);

      world.native.push(purchased(`unrelated-after-${operation}`));
      const gatewayCalls = world.calls.filter(([name]) => name === 'verifyTransaction').length;
      await world.makeCoordinator().recover();
      assert.equal(
        world.calls.filter(([name]) => name === 'verifyTransaction').length,
        gatewayCalls + 1,
        operation,
      );
      assert.equal((await rows(world.connection)).length, 2, operation);
    });
  }
});

test('more than one recoverable acquisition candidate fails closed before verification', async () => {
  await withWorld(async (world) => {
    for (const journalId of ['ambiguous-one', 'ambiguous-two']) {
      await world.commerceRepository.observeTransaction({
        journalId,
        store: 'google',
        productId: PRODUCT_ID,
        observationState: 'pending',
        opaqueProof: null,
        observedAt: journalId.endsWith('one') ? 10_000 : 10_001,
      });
    }
    world.native.push(purchased('ambiguous'));
    const callsBefore = world.calls.length;
    await assert.rejects(
      world.makeCoordinator().recover(),
      { code: 'PURCHASE_ACQUISITION_AMBIGUOUS' },
    );
    assert.equal(
      world.calls.slice(callsBefore).some(([name]) =>
        name === 'verifyTransaction' || name === 'finishTransaction'),
      false,
    );
    assert.deepEqual(await world.commerceRepository.listEntitlements(), []);
  });
});

test('two different native acquisition candidates fail the whole snapshot before effects', async () => {
  await withWorld(async (world) => {
    world.native.push(
      purchased('native-candidate-one', 'native-proof-one'),
      purchased('native-candidate-two', 'native-proof-two'),
    );
    const callsBefore = world.calls.length;
    await assert.rejects(
      world.makeCoordinator().recover(),
      { code: 'PURCHASE_NATIVE_ACQUISITION_AMBIGUOUS' },
    );
    assert.equal(
      world.calls.slice(callsBefore).some(([name]) => [
        'verifyTransaction',
        'completeTransaction',
        'finishTransaction',
        'authorisePackDownload',
      ].includes(name)),
      false,
    );
    assert.deepEqual(await rows(world.connection), []);
    assert.deepEqual(await world.commerceRepository.listEntitlements(), []);
    assert.deepEqual(world.jobs, []);
  });
});

test('pre-existing one-shot intent reconciles native state without a second Buy or Restore', async () => {
  for (const operation of ['purchase', 'restore']) {
    for (const snapshot of ['purchased', 'pending', 'empty']) {
      await withWorld(async (world) => {
        await world.attemptRepository.preparePendingAttempt({
          journalId: `pre-existing-${operation}-${snapshot}`,
          observedAt: 9_999,
        });
        if (snapshot === 'purchased') {
          world.native.push(purchased(`${operation}-pre-existing`));
        } else if (snapshot === 'pending') {
          world.native.push(outcome('pending', `${operation}-pre-existing`));
        }
        const callsBefore = world.calls.length;
        const invoke = () => operation === 'purchase'
          ? world.makeCoordinator().purchaseFullKs2({ productId: PRODUCT_ID })
          : world.makeCoordinator().restore();
        const result = await invoke();
        assert.equal(
          world.calls.slice(callsBefore).some(([name]) => name === operation),
          false,
          `${operation}/${snapshot}`,
        );
        const durable = await rows(world.connection);
        if (snapshot === 'purchased') {
          assert.equal(durable.length, 1, `${operation}/${snapshot}`);
          assert.equal(durable[0].processing_state, 'complete', `${operation}/${snapshot}`);
          assert.equal((await world.commerceRepository.listEntitlements())[0].state, 'active');
        } else if (snapshot === 'pending') {
          assert.equal(result.state, 'pending', `${operation}/${snapshot}`);
          assert.equal(durable.length, 1, `${operation}/${snapshot}`);
          assert.equal(durable[0].observation_state, 'pending', `${operation}/${snapshot}`);
        } else {
          assert.equal(result.state, 'cancelled', `${operation}/${snapshot}`);
          assert.deepEqual(durable, [], `${operation}/${snapshot}`);
          await invoke();
          assert.equal(
            world.calls.filter(([name]) => name === operation).length,
            1,
            `${operation}/${snapshot}/later-action`,
          );
        }
      });
    }
  }
});

test('pre-existing intent preserves an unverified matching query snapshot without effects', async () => {
  for (const operation of ['purchase', 'restore']) {
    await withWorld(async (world) => {
      const attempt = await world.attemptRepository.preparePendingAttempt({
        journalId: `pre-existing-${operation}-unverified`,
        observedAt: 9_999,
      });
      world.native.push(outcome('unverified', `${operation}-unverified`));
      const callsBefore = world.calls.length;

      const result = operation === 'purchase'
        ? await world.makeCoordinator().purchaseFullKs2({ productId: PRODUCT_ID })
        : await world.makeCoordinator().restore();

      assert.equal(result.state, 'unverified', operation);
      assert.deepEqual(await rows(world.connection), [{
        journal_id: attempt.journalId,
        observation_state: 'pending',
        processing_state: 'observed',
        opaque_proof: null,
        store_transaction_id: null,
      }], operation);
      assert.deepEqual(await world.commerceRepository.listEntitlements(), [], operation);
      assert.deepEqual(world.jobs, [], operation);
      assert.equal(
        world.calls.slice(callsBefore).some(([name]) => [
          'purchase',
          'restore',
          'verifyTransaction',
          'completeTransaction',
          'finishTransaction',
          'authorisePackDownload',
        ].includes(name)),
        false,
        operation,
      );
    });
  }
});

test('unverified prevalidates a mixed pending-intent snapshot before any authority effect', async () => {
  for (const authorityOutcome of ['purchased', 'revoked']) {
    await withWorld(async (world) => {
      if (authorityOutcome === 'revoked') await bootstrapActive(world);
      const attempt = await world.attemptRepository.preparePendingAttempt({
        journalId: `pre-existing-unverified-with-${authorityOutcome}`,
        observedAt: 20_000,
      });
      world.native.push(
        authorityOutcome === 'purchased'
          ? purchased('mixed-unverified-acquisition')
          : revoked('mixed-unverified-revocation'),
        outcome('unverified', `mixed-${authorityOutcome}`),
      );
      const durableBefore = await rows(world.connection);
      const entitlementsBefore = await world.commerceRepository.listEntitlements();
      const jobsBefore = structuredClone(world.jobs);
      const callsBefore = world.calls.length;

      const result = await world.makeCoordinator().purchaseFullKs2({ productId: PRODUCT_ID });

      assert.equal(result.state, 'unverified', authorityOutcome);
      assert.deepEqual(await rows(world.connection), durableBefore, authorityOutcome);
      assert.deepEqual(
        await world.commerceRepository.listEntitlements(),
        entitlementsBefore,
        authorityOutcome,
      );
      assert.deepEqual(world.jobs, jobsBefore, authorityOutcome);
      assert.equal(
        (await rows(world.connection)).some((row) => row.journal_id === attempt.journalId),
        true,
        authorityOutcome,
      );
      assert.equal(
        world.calls.slice(callsBefore).some(([name]) => [
          'purchase',
          'restore',
          'verifyTransaction',
          'refreshEntitlement',
          'completeTransaction',
          'finishTransaction',
          'authorisePackDownload',
        ].includes(name)),
        false,
        authorityOutcome,
      );
    });
  }
});

test('pre-existing intent processes a revocation-only query snapshot and remains pending', async () => {
  for (const operation of ['purchase', 'restore']) {
    await withWorld(async (world) => {
      await bootstrapActive(world);
      await world.attemptRepository.preparePendingAttempt({
        journalId: `pre-existing-${operation}-revocation`,
        observedAt: 20_000,
      });
      world.setGatewayIdentity(identity({ state: 'revoked' }));
      world.native.push(revoked(`${operation}-query-revocation`));
      const callsBefore = world.calls.length;

      const result = operation === 'purchase'
        ? await world.makeCoordinator().purchaseFullKs2({ productId: PRODUCT_ID })
        : await world.makeCoordinator().restore();

      assert.equal(result.state, 'revoked', operation);
      const durable = await rows(world.connection);
      assert.equal(durable.some((row) =>
        row.journal_id === `pre-existing-${operation}-revocation` &&
        row.observation_state === 'pending' &&
        row.processing_state === 'observed' &&
        row.opaque_proof === null &&
        row.store_transaction_id === null), true, operation);
      assert.equal(durable.some((row) =>
        row.journal_id === STABLE_REVOCATION_ID &&
        row.processing_state === 'complete' &&
        row.opaque_proof === null), true, operation);
      const entitlement = (await world.commerceRepository.listEntitlements())[0];
      assert.equal(entitlement.state, 'revoked', operation);
      assert.equal(entitlement.sealedRefreshHandle, null, operation);
      assert.equal(
        world.calls.slice(callsBefore).some(([name]) => name === 'purchase' || name === 'restore'),
        false,
        operation,
      );
      assert.equal(
        world.calls.slice(callsBefore).some(([name]) => name === 'refreshEntitlement'),
        true,
        operation,
      );
    });
  }
});

test('pre-existing intent orders acquisition before revocation from one validated query snapshot', async () => {
  await withWorld(async (world) => {
    await world.attemptRepository.preparePendingAttempt({
      journalId: 'pre-existing-acquisition-and-revocation',
      observedAt: 9_999,
    });
    const acquisition = purchased('ordered-acquisition');
    const revocation = revoked('ordered-revocation');
    world.native.push(revocation, acquisition);
    const active = identity();
    const revokedAuthority = identity({ state: 'revoked' });
    world.gateway.verifyTransaction = async (input) => {
      world.calls.push(['verifyTransaction', input]);
      return input.opaqueProof === acquisition.opaqueProof ? active : revokedAuthority;
    };
    world.gateway.completeTransaction = async (input) => {
      world.calls.push(['completeTransaction', input]);
      return active;
    };
    world.gateway.refreshEntitlement = async (input) => {
      world.calls.push(['refreshEntitlement', input]);
      return revokedAuthority;
    };
    const callsBefore = world.calls.length;

    const result = await world.makeCoordinator().purchaseFullKs2({ productId: PRODUCT_ID });

    assert.equal(result.state, 'revoked');
    const relevantCalls = world.calls.slice(callsBefore);
    assert.equal(relevantCalls.some(([name]) => name === 'purchase' || name === 'restore'), false);
    assert.ok(
      relevantCalls.findIndex(([name]) => name === 'completeTransaction') <
      relevantCalls.findIndex(([name]) => name === 'refreshEntitlement'),
    );
    const entitlement = (await world.commerceRepository.listEntitlements())[0];
    assert.equal(entitlement.state, 'revoked');
    assert.equal(entitlement.sealedRefreshHandle, null);
    const durable = await rows(world.connection);
    assert.equal(durable.some((row) =>
      row.observation_state === 'purchased' && row.processing_state === 'complete'), true);
    assert.equal(durable.some((row) =>
      row.observation_state === 'revoked' && row.processing_state === 'complete'), true);
  });
});

test('pre-existing intent discards only empty or matching cancelled snapshots', async () => {
  for (const snapshot of ['empty', 'cancelled']) {
    await withWorld(async (world) => {
      await world.attemptRepository.preparePendingAttempt({
        journalId: `pre-existing-authoritative-${snapshot}`,
        observedAt: 9_999,
      });
      if (snapshot === 'cancelled') world.native.push(outcome('cancelled', 'matching-cancelled'));

      const result = await world.makeCoordinator().restore();

      assert.equal(result.state, 'cancelled', snapshot);
      assert.deepEqual(await rows(world.connection), [], snapshot);
      assert.equal(world.calls.some(([name]) => name === 'restore'), false, snapshot);
    });
  }
});

test('pre-existing intent rejects a foreign authority-bearing snapshot before effects', async () => {
  for (const nativeOutcome of ['purchased', 'revoked']) {
    await withWorld(async (world) => {
      const attempt = await world.attemptRepository.preparePendingAttempt({
        journalId: `pre-existing-foreign-${nativeOutcome}`,
        observedAt: 9_999,
      });
      world.native.push(Object.freeze({
        store: 'apple',
        environment: 'sandbox',
        productId: 'uk.eugnel.ks2spelling.fullks2',
        outcome: nativeOutcome,
        transactionRef: `foreign-${nativeOutcome}-reference`,
        opaqueProof: `foreign-${nativeOutcome}-proof`,
      }));
      const callsBefore = world.calls.length;

      await assert.rejects(
        world.makeCoordinator().purchaseFullKs2({ productId: PRODUCT_ID }),
        { code: 'PURCHASE_ATTEMPT_AUTHORITY_MISMATCH' },
      );

      assert.deepEqual(await rows(world.connection), [{
        journal_id: attempt.journalId,
        observation_state: 'pending',
        processing_state: 'observed',
        opaque_proof: null,
        store_transaction_id: null,
      }], nativeOutcome);
      assert.deepEqual(await world.commerceRepository.listEntitlements(), [], nativeOutcome);
      assert.deepEqual(world.jobs, [], nativeOutcome);
      assert.equal(
        world.calls.slice(callsBefore).some(([name]) => [
          'purchase',
          'restore',
          'verifyTransaction',
          'completeTransaction',
          'finishTransaction',
          'authorisePackDownload',
        ].includes(name)),
        false,
        nativeOutcome,
      );
    });
  }
});

test('Restore rejects an ambiguous acquisition result before gateway or retained durable effects', async () => {
  await withWorld(async (world) => {
    world.setRestoreResults([
      purchased('restore-ambiguous-one', 'restore-ambiguous-proof-one'),
      purchased('restore-ambiguous-two', 'restore-ambiguous-proof-two'),
    ]);
    const callsBefore = world.calls.length;
    await assert.rejects(
      world.makeCoordinator().restore(),
      { code: 'PURCHASE_NATIVE_ACQUISITION_AMBIGUOUS' },
    );
    assert.equal(
      world.calls.slice(callsBefore).some(([name]) => [
        'verifyTransaction',
        'completeTransaction',
        'finishTransaction',
        'authorisePackDownload',
      ].includes(name)),
      false,
    );
    assert.deepEqual(await rows(world.connection), []);
    assert.deepEqual(await world.commerceRepository.listEntitlements(), []);
    assert.deepEqual(world.jobs, []);
  });
});

test('second lifecycle converges across every durable purchase arrow', async () => {
  const cases = [
    ['before:journal', 1],
    ['after:journal', 1],
    ['before:journal', 2],
    ['after:journal', 2],
    ['before:verify', 1],
    ['after:verify', 1],
    ['before:mark-verified', 1],
    ['after:mark-verified', 1],
    ['before:entitlement-commit', 1],
    ['after:entitlement-commit', 1],
    ['before:gateway-completion', 1],
    ['after:gateway-completion', 1],
    ['before:store-finish', 1],
    ['after:store-finish', 1],
    ['before:proof-clear', 1],
    ['after:proof-clear', 1],
  ];
  for (const [target, occurrence] of cases) {
    await withWorld(async (world) => {
      await bootstrapRevoked(world);
      const second = purchased(`matrix-${target}-${occurrence}`);
      world.setGatewayIdentity(identity({ storeTransactionId: SECOND_STORE_ID }));
      world.setPurchaseResult(second);
      let seen = 0;
      const crash = async (checkpoint) => {
        if (checkpoint === target && (seen += 1) === occurrence) {
          throw Object.assign(new Error('simulated process loss'), {
            code: 'SIMULATED_PROCESS_LOSS',
          });
        }
      };
      if (!(target.endsWith(':journal') && occurrence === 1)) {
        world.native.push(second);
      }
      await assert.rejects(
        world.makeCoordinator(crash).purchaseFullKs2({ productId: PRODUCT_ID }),
        { code: 'SIMULATED_PROCESS_LOSS' },
        `${target} occurrence ${occurrence}`,
      );

      await world.makeCoordinator().recover();
      let entitlement = (await world.commerceRepository.listEntitlements())[0];
      if (target.endsWith(':journal') && occurrence === 1) {
        assert.equal(entitlement.state, 'revoked');
        world.native.push(second);
        await world.makeCoordinator().purchaseFullKs2({ productId: PRODUCT_ID });
        entitlement = (await world.commerceRepository.listEntitlements())[0];
      }
      assert.equal(entitlement.state, 'active', `${target} occurrence ${occurrence}`);
      assert.equal(entitlement.refreshHandleVersion, 2, `${target} occurrence ${occurrence}`);
      const durable = await rows(world.connection);
      assert.equal(durable.at(-1).processing_state, 'complete', `${target} occurrence ${occurrence}`);
      assert.equal(durable.at(-1).opaque_proof, null, `${target} occurrence ${occurrence}`);
      assert.equal(
        (await world.commerceRepository.listRecoverableTransactions()).length,
        0,
        `${target} occurrence ${occurrence}`,
      );
      assert.equal(durable.length, 3, `${target} occurrence ${occurrence}`);
    });
  }
});

test('fresh Restore lifecycle converges across every durable commerce arrow', async () => {
  const cases = [
    ['before:journal', 1],
    ['after:journal', 1],
    ['before:journal', 2],
    ['after:journal', 2],
    ['before:verify', 1],
    ['after:verify', 1],
    ['before:mark-verified', 1],
    ['after:mark-verified', 1],
    ['before:entitlement-commit', 1],
    ['after:entitlement-commit', 1],
    ['before:gateway-completion', 1],
    ['after:gateway-completion', 1],
    ['before:store-finish', 1],
    ['after:store-finish', 1],
    ['before:proof-clear', 1],
    ['after:proof-clear', 1],
  ];
  for (const [target, occurrence] of cases) {
    await withWorld(async (world) => {
      await bootstrapActive(world);
      const restored = purchased(`restore-matrix-${target}-${occurrence}`);
      world.setRestoreResults([restored]);
      world.setGatewayIdentity(identity({
        storeTransactionId: FIRST_STORE_ID,
        handleVersion: 2,
      }));
      let seen = 0;
      const crash = async (checkpoint) => {
        if (checkpoint === target && (seen += 1) === occurrence) {
          throw Object.assign(new Error('simulated Restore process loss'), {
            code: 'SIMULATED_PROCESS_LOSS',
          });
        }
      };
      if (!(target.endsWith(':journal') && occurrence === 1)) {
        world.native.push(restored);
      }
      await assert.rejects(
        world.makeCoordinator(crash).restore(),
        { code: 'SIMULATED_PROCESS_LOSS' },
        `${target} occurrence ${occurrence}`,
      );

      await world.makeCoordinator().recover();
      let entitlement = (await world.commerceRepository.listEntitlements())[0];
      if (target.endsWith(':journal') && occurrence === 1) {
        assert.equal(entitlement.refreshHandleVersion, 1);
        world.native.push(restored);
        await world.makeCoordinator().restore();
        entitlement = (await world.commerceRepository.listEntitlements())[0];
      }
      assert.equal(entitlement.state, 'active', `${target} occurrence ${occurrence}`);
      assert.equal(entitlement.refreshHandleVersion, 2, `${target} occurrence ${occurrence}`);
      const durable = await rows(world.connection);
      assert.equal(durable.length, 2, `${target} occurrence ${occurrence}`);
      assert.equal(durable.at(-1).processing_state, 'complete', `${target} occurrence ${occurrence}`);
      assert.equal(durable.at(-1).opaque_proof, null, `${target} occurrence ${occurrence}`);
      assert.equal(
        (await world.commerceRepository.listRecoverableTransactions()).length,
        0,
        `${target} occurrence ${occurrence}`,
      );
    });
  }
});

test('a rejected revocation tombstone cannot reopen proactively but live refresh may start one lifecycle', async () => {
  await withWorld(async (world) => {
    await bootstrapActive(world);
    await world.commerceRepository.observeTransaction({
      journalId: STABLE_REVOCATION_ID,
      store: 'google',
      productId: PRODUCT_ID,
      observationState: 'revoked',
      opaqueProof: 'rejected-revocation-proof',
      observedAt: 20_000,
    });
    await world.commerceRepository.markRejectedAndClearProof({
      journalId: STABLE_REVOCATION_ID,
      rejectionKind: 'authenticated-permanent',
      rejectedAt: 20_001,
    });
    const replay = revoked('rejected-replay');
    world.native.push(replay);
    world.setGatewayIdentity(identity({ state: 'revoked' }));
    const before = await rows(world.connection);
    const callsBefore = world.calls.length;

    await world.makeCoordinator().recover();
    assert.deepEqual(await rows(world.connection), before);
    assert.equal(
      world.calls.slice(callsBefore).some(([name]) =>
        ['verifyTransaction', 'refreshEntitlement', 'completeTransaction'].includes(name)),
      false,
    );
    assert.equal((await world.commerceRepository.listEntitlements())[0].state, 'active');

    await world.makeCoordinator().refresh();
    const afterRefresh = await rows(world.connection);
    assert.equal(afterRefresh.length, before.length + 1);
    assert.equal(afterRefresh.at(-1).observation_state, 'revoked');
    assert.equal(afterRefresh.at(-1).processing_state, 'complete');
    assert.equal(afterRefresh.at(-1).opaque_proof, null);
    assert.equal((await world.commerceRepository.listEntitlements())[0].state, 'revoked');
  });
});
