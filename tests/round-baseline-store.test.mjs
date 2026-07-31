import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDatabaseCommandGate } from '../src/platform/database/database-command-gate.js';
import { configureAndMigrateDatabase } from '../src/platform/database/migrate-database.js';
import {
  createSQLiteRoundBaselineStore,
} from '../src/platform/database/sqlite-round-baseline-store.js';
import { createNodeSqliteConnection } from './helpers/node-sqlite-connection.mjs';

const LEARNER_ID = 'learner-a';
const RECORD = Object.freeze({
  schemaVersion: 1,
  learnerId: LEARNER_ID,
  sessionId: 'session-1',
  monsters: Object.freeze([
    Object.freeze({
      rewardTrackId: 'spelling-core-inklet',
      monsterId: 'inklet',
      secureCount: 0,
      caught: false,
    }),
  ]),
  camp: Object.freeze({
    packId: 'ks2-core',
    campHighWater: 0,
    lastCreditedGuardianDay: null,
  }),
});

async function openStore(t, { now = () => 1_000 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-round-baseline-'));
  const connection = createNodeSqliteConnection(join(directory, 'round.sqlite'));
  await connection.open();
  await configureAndMigrateDatabase(connection);
  t.after(async () => {
    await connection.close();
    await rm(directory, { force: true, recursive: true });
  });
  const store = createSQLiteRoundBaselineStore({
    connection,
    gate: createDatabaseCommandGate(),
    now,
  });
  return { connection, store };
}

test('round baseline store returns null when no row exists', async (t) => {
  const { store } = await openStore(t);
  assert.equal(await store.read(LEARNER_ID), null);
});

test('round baseline store round-trips a written record', async (t) => {
  const { connection, store } = await openStore(t, { now: () => 42 });
  assert.deepEqual(await store.write(LEARNER_ID, RECORD), RECORD);
  assert.deepEqual(await store.read(LEARNER_ID), RECORD);

  const rows = await connection.query(
    'SELECT key, updated_at FROM app_metadata WHERE key = ?',
    [`product.round-baseline.${LEARNER_ID}`],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].updated_at, 42);
});

test('round baseline store treats malformed rows as a miss', async (t) => {
  const { connection, store } = await openStore(t);
  const key = `product.round-baseline.${LEARNER_ID}`;

  await connection.execute(
    'INSERT INTO app_metadata (key, value_json, updated_at) VALUES (?, ?, ?)',
    [key, '{not-json', 100],
  );
  assert.equal(await store.read(LEARNER_ID), null);

  await connection.execute(
    'UPDATE app_metadata SET value_json = ?, updated_at = ? WHERE key = ?',
    [JSON.stringify({ schemaVersion: 1 }), 101, key],
  );
  assert.equal(await store.read(LEARNER_ID), null);

  await connection.execute(
    'UPDATE app_metadata SET value_json = ?, updated_at = ? WHERE key = ?',
    [JSON.stringify({ ...RECORD, learnerId: 'learner-other' }), 102, key],
  );
  assert.equal(await store.read(LEARNER_ID), null);
});

test('round baseline store upsert overwrites the previous record', async (t) => {
  let clock = 10;
  const { store } = await openStore(t, { now: () => {
    clock += 1;
    return clock;
  } });

  await store.write(LEARNER_ID, RECORD);
  const next = {
    ...RECORD,
    sessionId: 'session-2',
    monsters: [{ rewardTrackId: 'spelling-core-inklet', secureCount: 3 }],
    camp: null,
  };
  assert.deepEqual(await store.write(LEARNER_ID, next), next);
  assert.deepEqual(await store.read(LEARNER_ID), next);
});
