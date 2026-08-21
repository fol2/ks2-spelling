import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDatabaseCommandGate } from '../src/platform/database/database-command-gate.js';
import { configureAndMigrateDatabase } from '../src/platform/database/migrate-database.js';
import {
  createSQLiteStarterCompleteMomentStore,
  deleteStarterCompleteMomentInTransaction,
  starterCompleteMomentMetadataKey,
} from '../src/platform/database/sqlite-starter-complete-moment-store.js';
import { createSQLiteSpellingProfileStore } from '../src/platform/database/sqlite-spelling-profile-store.js';
import { loadStarterSpellingCatalogue } from '../src/domain/spelling/index.js';
import {
  acknowledgeStarterCompleteMoment,
  createStarterCompleteAskGrownUpHandler,
} from '../src/app/starter-complete-moment-runtime.js';
import { createNodeSqliteConnection } from './helpers/node-sqlite-connection.mjs';

const LEARNER_ID = 'learner-a';

async function openStore(t, { now = () => 1_000 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-starter-complete-'));
  const connection = createNodeSqliteConnection(join(directory, 'moment.sqlite'));
  await connection.open();
  await configureAndMigrateDatabase(connection);
  t.after(async () => {
    await connection.close();
    await rm(directory, { force: true, recursive: true });
  });
  const store = createSQLiteStarterCompleteMomentStore({
    connection,
    gate: createDatabaseCommandGate(),
    now,
  });
  return { connection, store };
}

function storeWithNoopMomentUpsert(connection) {
  const originalExecute = connection.execute.bind(connection);
  return createSQLiteStarterCompleteMomentStore({
    connection: Object.freeze({
      ...connection,
      async execute(sql, values) {
        if (
          typeof sql === 'string'
          && sql.includes('ON CONFLICT(key) DO UPDATE')
          && values?.[0] === starterCompleteMomentMetadataKey(LEARNER_ID)
        ) {
          return Object.freeze({ changes: 0 });
        }
        return originalExecute(sql, values);
      },
    }),
    gate: createDatabaseCommandGate(),
    now: () => 1_000,
  });
}

test('starter complete moment store returns null when no row exists', async (t) => {
  const { store } = await openStore(t);
  assert.equal(await store.read(LEARNER_ID), null);
});

test('starter complete moment store round-trips a presented flag', async (t) => {
  const { connection, store } = await openStore(t, { now: () => 42 });
  assert.deepEqual(await store.write(LEARNER_ID, { presented: true }), {
    presented: true,
  });
  assert.deepEqual(await store.read(LEARNER_ID), { presented: true });

  const rows = await connection.query(
    'SELECT key, updated_at FROM app_metadata WHERE key = ?',
    [`product.starter-complete-moment.${LEARNER_ID}`],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].updated_at, 42);
});

test('a contract-valid UPSERT reporting no affected row fails closed', async (t) => {
  const { connection } = await openStore(t);
  const store = storeWithNoopMomentUpsert(connection);
  await assert.rejects(
    store.write(LEARNER_ID, { presented: true }),
    (error) => error?.code === 'sqlite_starter_complete_moment_write_failed',
  );
  assert.equal(await store.read(LEARNER_ID), null);
});

test('a no-op presented write keeps the overlay and never opens Parent', async (t) => {
  const { connection } = await openStore(t);
  const store = storeWithNoopMomentUpsert(connection);
  const overlay = { open: true, parent: false };
  const inFlight = { current: false };
  const persist = () => store.write(LEARNER_ID, { presented: true });
  const acknowledge = () => acknowledgeStarterCompleteMoment({
    inFlight,
    persist,
    dismiss() { overlay.open = false; },
  });

  assert.equal(await acknowledge(), false);
  assert.equal(overlay.open, true);
  assert.equal(overlay.parent, false);

  const ask = createStarterCompleteAskGrownUpHandler({
    persist: acknowledge,
    openParent() { overlay.parent = true; },
  });
  assert.equal(await ask(), false);
  assert.equal(overlay.open, true);
  assert.equal(overlay.parent, false);
  assert.equal(await store.read(LEARNER_ID), null);
});

test('starter complete moment store treats malformed rows as a miss', async (t) => {
  const { connection, store } = await openStore(t);
  const key = `product.starter-complete-moment.${LEARNER_ID}`;

  await connection.execute(
    'INSERT INTO app_metadata (key, value_json, updated_at) VALUES (?, ?, ?)',
    [key, '{not-json', 100],
  );
  assert.equal(await store.read(LEARNER_ID), null);

  await connection.execute(
    'UPDATE app_metadata SET value_json = ?, updated_at = ? WHERE key = ?',
    [JSON.stringify({ schemaVersion: 1, learnerId: LEARNER_ID }), 101, key],
  );
  assert.equal(await store.read(LEARNER_ID), null);

  await connection.execute(
    'UPDATE app_metadata SET value_json = ?, updated_at = ? WHERE key = ?',
    [JSON.stringify({
      schemaVersion: 1,
      learnerId: 'learner-other',
      presented: true,
    }), 102, key],
  );
  assert.equal(await store.read(LEARNER_ID), null);
});

test('a learning reset does not clear the presented flag', async (t) => {
  const { connection, store } = await openStore(t);
  const gate = createDatabaseCommandGate();
  const profiles = createSQLiteSpellingProfileStore({
    connection,
    gate,
    now: () => 1_000,
    initialCatalogueId: loadStarterSpellingCatalogue().catalogueId,
  });

  await profiles.profiles.writeProfile({
    learnerId: LEARNER_ID,
    nickname: 'Ada',
    yearGroup: 'Y3',
    goal: 10,
    colour: '#2E7D8A',
    createdAt: 0,
    updatedAt: 0,
  });
  await store.write(LEARNER_ID, { presented: true });
  await profiles.administration.resetLearning(LEARNER_ID);

  assert.deepEqual(await store.read(LEARNER_ID), { presented: true });
  const rows = await connection.query(
    'SELECT key FROM app_metadata WHERE key = ?',
    [`product.starter-complete-moment.${LEARNER_ID}`],
  );
  assert.equal(rows.length, 1);
});

function adaProfile() {
  return {
    learnerId: LEARNER_ID,
    nickname: 'Ada',
    yearGroup: 'Y3',
    goal: 10,
    colour: '#2E7D8A',
    createdAt: 0,
    updatedAt: 0,
  };
}

test('deleting a learner removes the presented flag so a recreated id can fire again', async (t) => {
  const { connection, store } = await openStore(t);
  const gate = createDatabaseCommandGate();
  const profiles = createSQLiteSpellingProfileStore({
    connection,
    gate,
    now: () => 1_000,
    initialCatalogueId: loadStarterSpellingCatalogue().catalogueId,
    onRemoveLearnerMetadata: deleteStarterCompleteMomentInTransaction,
  });

  await profiles.profiles.writeProfile(adaProfile());
  await store.write(LEARNER_ID, { presented: true });
  assert.equal(await profiles.profiles.removeProfile(LEARNER_ID), true);
  assert.equal(await store.read(LEARNER_ID), null);
  assert.deepEqual(
    await connection.query(
      'SELECT key FROM app_metadata WHERE key = ?',
      [starterCompleteMomentMetadataKey(LEARNER_ID)],
    ),
    [],
  );

  await profiles.profiles.writeProfile(adaProfile());
  assert.equal(await store.read(LEARNER_ID), null);
});

test('removeProfile rolls back the profile and presented flag when moment cleanup fails in the owned transaction', async (t) => {
  const { connection, store } = await openStore(t);
  const gate = createDatabaseCommandGate();
  await store.write(LEARNER_ID, { presented: true });
  const originalExecute = connection.execute.bind(connection);
  const failingConnection = Object.freeze({
    ...connection,
    async execute(sql, values) {
      if (
        typeof sql === 'string'
        && sql.includes('DELETE FROM app_metadata')
        && values?.[0] === starterCompleteMomentMetadataKey(LEARNER_ID)
      ) {
        throw new Error('injected_moment_cleanup_failure');
      }
      return originalExecute(sql, values);
    },
  });
  const profiles = createSQLiteSpellingProfileStore({
    connection: failingConnection,
    gate,
    now: () => 1_000,
    initialCatalogueId: loadStarterSpellingCatalogue().catalogueId,
    onRemoveLearnerMetadata: deleteStarterCompleteMomentInTransaction,
  });
  await profiles.profiles.writeProfile(adaProfile());
  await assert.rejects(
    profiles.profiles.removeProfile(LEARNER_ID),
    /injected_moment_cleanup_failure/,
  );
  assert.equal((await profiles.profiles.readProfile(LEARNER_ID))?.learnerId, LEARNER_ID);
  assert.deepEqual(await store.read(LEARNER_ID), { presented: true });
  assert.equal(await connection.isTransactionActive(), false);
});
