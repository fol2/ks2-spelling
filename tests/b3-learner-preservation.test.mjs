import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadStarterSpellingCatalogue } from '../src/domain/spelling/index.js';
import { seedB2Learners } from '../src/platform/database/b2-seed.js';
import { canonicalJson } from '../src/platform/database/canonical-json.js';
import { createDatabaseCommandGate } from '../src/platform/database/database-command-gate.js';
import { configureAndMigrateDatabase } from '../src/platform/database/migrate-database.js';
import { createSqliteCommerceRepositories } from '../src/platform/database/sqlite-commerce-repositories.js';
import { createSQLiteSpellingCommandRepository } from '../src/platform/database/sqlite-spelling-command-repository.js';
import { createSQLiteSpellingSnapshotStore } from '../src/platform/database/sqlite-spelling-snapshot-store.js';

import { unchangedB2Plan } from './fixtures/b2-command-scenarios.mjs';
import {
  B2_NOW_MS,
  logicalSnapshotDigest,
} from './helpers/b2-database-harness.mjs';
import { createNodeSqliteConnection } from './helpers/node-sqlite-connection.mjs';
import { learnerCellDigest } from './helpers/sqlite-v1-fixture.mjs';

const V1_TABLES = Object.freeze([
  ['app_metadata', 'key'],
  ['learner_profiles', 'learner_id'],
  ['spelling_aggregates', 'learner_id'],
  ['spelling_subject_states', 'learner_id'],
  ['spelling_practice_sessions', 'learner_id, session_id'],
  ['spelling_events', 'learner_id, sequence_no'],
  ['spelling_monster_states', 'learner_id, reward_track_id'],
  ['spelling_camp_states', 'learner_id, pack_id'],
]);

function createConnectionFacade(base, hooks = {}) {
  async function hook(name, ...values) {
    if (hooks[name]) await hooks[name](...values);
  }
  return Object.freeze({
    async open() {
      await hook('beforeOpen');
      return base.open();
    },
    async close() {
      await hook('beforeClose');
      return base.close();
    },
    async execute(sql, values) {
      await hook('beforeExecute', sql, values);
      const result = await base.execute(sql, values);
      await hook('afterExecute', sql, values, result);
      return result;
    },
    async query(sql, values = []) {
      await hook('beforeQuery', sql, values);
      const result = await base.query(sql, values);
      await hook('afterQuery', sql, values, result);
      return result;
    },
    async begin() {
      await hook('beforeBegin');
      const result = await base.begin();
      await hook('afterBegin');
      return result;
    },
    async commit() {
      await hook('beforeCommit');
      const result = await base.commit();
      await hook('afterCommit');
      return result;
    },
    async rollback() {
      await hook('beforeRollback');
      const result = await base.rollback();
      await hook('afterRollback');
      return result;
    },
    async isTransactionActive() {
      const result = await base.isTransactionActive();
      await hook('afterIsTransactionActive', result);
      return result;
    },
  });
}

async function openDatabase() {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-spelling-b3-preserve-'));
  const base = createNodeSqliteConnection(join(directory, 'preserve.sqlite'));
  await base.open();
  await configureAndMigrateDatabase(base);
  await seedB2Learners(base);
  return {
    base,
    async close() {
      if (await base.isTransactionActive()) await base.rollback();
      await base.close();
      await rm(directory, { force: true, recursive: true });
    },
  };
}

function createRepositories(connection) {
  const catalogue = loadStarterSpellingCatalogue();
  const cataloguesById = Object.freeze({ [catalogue.catalogueId]: catalogue });
  const store = createSQLiteSpellingSnapshotStore({
    connection,
    cataloguesById,
  });
  const spelling = createSQLiteSpellingCommandRepository({
    connection,
    gate: createDatabaseCommandGate(),
    store,
    cataloguesById,
    now: () => B2_NOW_MS,
  });
  const commerce = createSqliteCommerceRepositories(connection);
  return { commerce, spelling, store };
}

async function exactV1CellState(connection) {
  const state = {};
  for (const [table, orderBy] of V1_TABLES) {
    const columns = await connection.query(`PRAGMA table_info(${table})`);
    const projection = columns
      .flatMap(({ name }) => [
        `typeof(${name}) AS ${name}_type`,
        `hex(CAST(${name} AS BLOB)) AS ${name}_bytes`,
      ])
      .join(', ');
    state[table] = await connection.query(
      `SELECT ${projection} FROM ${table} ORDER BY ${orderBy}`,
    );
  }
  return state;
}

async function grantAndRevoke(commerce) {
  await commerce.observeTransaction({
    journalId: 'purchase',
    store: 'apple',
    productId: 'uk.eugnel.ks2spelling.fullks2',
    observationState: 'purchased',
    opaqueProof: 'eyJhbGciOiJFUzI1NiJ9.purchase.signature',
    observedAt: 1_768_478_400_000,
  });
  await commerce.markVerified({
    journalId: 'purchase',
    verifiedAt: 1_768_478_400_100,
  });
  await commerce.commitEntitlementAndReadyToComplete({
    journalId: 'purchase',
    entitlementId: 'full-ks2',
    storeTransactionId: '2000001234567890',
    sealedRefreshHandle: 'b3rh1.1.nonce.ciphertext',
    refreshHandleVersion: 1,
    committedAt: 1_768_478_400_200,
  });
  await commerce.markStoreCompleteAndClearProof({
    journalId: 'purchase',
    completedAt: 1_768_478_400_300,
  });
  await commerce.replaceSealedRefreshHandle({
    entitlementId: 'full-ks2',
    sealedRefreshHandle: 'b3rh1.2.rotated.ciphertext',
    refreshHandleVersion: 2,
    refreshedAt: 1_768_478_401_000,
  });
  await commerce.observeTransaction({
    journalId: 'revocation',
    store: 'apple',
    productId: 'uk.eugnel.ks2spelling.fullks2',
    observationState: 'revoked',
    opaqueProof: 'eyJhbGciOiJFUzI1NiJ9.revocation.signature',
    observedAt: 1_768_478_402_000,
  });
  await commerce.markVerified({
    journalId: 'revocation',
    verifiedAt: 1_768_478_402_100,
  });
  await commerce.applyRevocationAndDeleteHandle({
    journalId: 'revocation',
    entitlementId: 'full-ks2',
    storeTransactionId: '2000001234567890',
    revokedAt: 1_768_478_402_200,
  });
}

test('grant, handle rotation and revocation preserve all eight V1 table cell types and bytes', async () => {
  const harness = await openDatabase();
  try {
    const { commerce, store } = createRepositories(harness.base);
    const beforeCells = await exactV1CellState(harness.base);
    const beforeCellDigest = await learnerCellDigest(harness.base);
    const beforeSnapshots = new Map();
    for (const learnerId of ['learner-a', 'learner-b']) {
      const snapshot = await store.read(learnerId);
      beforeSnapshots.set(learnerId, {
        bytes: canonicalJson(snapshot),
        digest: logicalSnapshotDigest(snapshot),
      });
    }

    await grantAndRevoke(commerce);

    assert.deepEqual(await exactV1CellState(harness.base), beforeCells);
    assert.equal(await learnerCellDigest(harness.base), beforeCellDigest);
    for (const learnerId of ['learner-a', 'learner-b']) {
      const snapshot = await store.read(learnerId);
      assert.equal(canonicalJson(snapshot), beforeSnapshots.get(learnerId).bytes);
      assert.equal(
        logicalSnapshotDigest(snapshot),
        beforeSnapshots.get(learnerId).digest,
      );
      assert.deepEqual(snapshot.grantedEntitlementIds, []);
      const bytes = canonicalJson(snapshot);
      for (const forbidden of [
        'full-ks2',
        '2000001234567890',
        'b3rh1.',
        'opaqueProof',
        'storeTransactionId',
        'sealedRefreshHandle',
      ]) {
        assert.equal(bytes.includes(forbidden), false, `${learnerId}: ${forbidden}`);
      }
    }
  } finally {
    await harness.close();
  }
});

test('learner transaction blocks commerce on the same connection without nested begin or learner rollback', async () => {
  const harness = await openDatabase();
  try {
    let beginCalls = 0;
    const connection = createConnectionFacade(harness.base, {
      beforeBegin() {
        beginCalls += 1;
      },
    });
    const { commerce, spelling, store } = createRepositories(connection);
    const beforeDigest = logicalSnapshotDigest(await store.read('learner-a'));
    let releaseLearner;
    const holdLearner = new Promise((resolve) => {
      releaseLearner = resolve;
    });
    let learnerStarted;
    const waitForLearner = new Promise((resolve) => {
      learnerStarted = resolve;
    });
    const learnerWork = spelling.runCommandTransaction(
      'learner-a',
      async (fresh, context) => {
        learnerStarted();
        await holdLearner;
        return unchangedB2Plan(fresh, context);
      },
    );
    await waitForLearner;

    const commerceWork = commerce.observeTransaction({
      journalId: 'serial-after-learner',
      store: 'apple',
      productId: 'uk.eugnel.ks2spelling.fullks2',
      observationState: 'purchased',
      opaqueProof: 'proof',
      observedAt: 1_768_478_400_000,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(beginCalls, 1, 'commerce must wait outside the learner transaction');
    assert.equal(await harness.base.isTransactionActive(), true);

    releaseLearner();
    await Promise.all([learnerWork, commerceWork]);
    assert.equal(beginCalls, 2);
    assert.equal(await harness.base.isTransactionActive(), false);
    assert.equal(
      logicalSnapshotDigest(await store.read('learner-a')),
      beforeDigest,
    );
  } finally {
    await harness.close();
  }
});

test('commerce transaction blocks learner work on the same connection and both commit in order', async () => {
  const harness = await openDatabase();
  try {
    let beginCalls = 0;
    let holdCommerce = true;
    let releaseCommerce;
    const commerceBarrier = new Promise((resolve) => {
      releaseCommerce = resolve;
    });
    let commerceStarted;
    const waitForCommerce = new Promise((resolve) => {
      commerceStarted = resolve;
    });
    const connection = createConnectionFacade(harness.base, {
      beforeBegin() {
        beginCalls += 1;
      },
      async beforeExecute(sql) {
        if (holdCommerce && /INSERT\s+INTO\s+transaction_journal/i.test(sql)) {
          holdCommerce = false;
          commerceStarted();
          await commerceBarrier;
        }
      },
    });
    const { commerce, spelling, store } = createRepositories(connection);
    const beforeDigest = logicalSnapshotDigest(await store.read('learner-b'));
    const commerceWork = commerce.observeTransaction({
      journalId: 'serial-before-learner',
      store: 'google',
      productId: 'full_ks2',
      observationState: 'pending',
      opaqueProof: null,
      observedAt: 1_768_478_400_000,
    });
    await waitForCommerce;

    const learnerWork = spelling.runCommandTransaction(
      'learner-b',
      (fresh, context) => unchangedB2Plan(fresh, context),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(beginCalls, 1, 'learner work must wait outside commerce transaction');
    assert.equal(await harness.base.isTransactionActive(), true);

    releaseCommerce();
    await Promise.all([commerceWork, learnerWork]);
    assert.equal(beginCalls, 2);
    assert.equal(await harness.base.isTransactionActive(), false);
    assert.equal(
      logicalSnapshotDigest(await store.read('learner-b')),
      beforeDigest,
    );
  } finally {
    await harness.close();
  }
});
