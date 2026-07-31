import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDatabaseCommandGate } from '../src/platform/database/database-command-gate.js';
import { configureAndMigrateDatabase } from '../src/platform/database/migrate-database.js';
import {
  createSQLiteSoundPrefsStore,
} from '../src/platform/database/sqlite-sound-prefs-store.js';
import { createNodeSqliteConnection } from './helpers/node-sqlite-connection.mjs';

const KEY = 'product.sound-prefs';

async function openStore(t, { now = () => 1_000 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-sound-prefs-'));
  const connection = createNodeSqliteConnection(join(directory, 'sound.sqlite'));
  await connection.open();
  await configureAndMigrateDatabase(connection);
  t.after(async () => {
    await connection.close();
    await rm(directory, { force: true, recursive: true });
  });
  const store = createSQLiteSoundPrefsStore({
    connection,
    gate: createDatabaseCommandGate(),
    now,
  });
  return { connection, store };
}

test('sound prefs store returns null when no row exists', async (t) => {
  const { store } = await openStore(t);
  assert.equal(await store.read(), null);
});

test('sound prefs store round-trips a written record', async (t) => {
  const { connection, store } = await openStore(t, { now: () => 42 });
  assert.deepEqual(await store.write({ sfxEnabled: false }), { sfxEnabled: false });
  assert.deepEqual(await store.read(), { sfxEnabled: false });

  const rows = await connection.query(
    'SELECT key, value_json, updated_at FROM app_metadata WHERE key = ?',
    [KEY],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].updated_at, 42);
  assert.equal(
    rows[0].value_json,
    '{"schemaVersion":1,"sfxEnabled":false}',
  );

  assert.deepEqual(await store.write({ sfxEnabled: true }), { sfxEnabled: true });
  assert.deepEqual(await store.read(), { sfxEnabled: true });
});

test('sound prefs store treats malformed rows as a miss', async (t) => {
  const { connection, store } = await openStore(t);

  await connection.execute(
    'INSERT INTO app_metadata (key, value_json, updated_at) VALUES (?, ?, ?)',
    [KEY, '{not-json', 100],
  );
  assert.equal(await store.read(), null);

  await connection.execute(
    'UPDATE app_metadata SET value_json = ?, updated_at = ? WHERE key = ?',
    [JSON.stringify({ schemaVersion: 1 }), 101, KEY],
  );
  assert.equal(await store.read(), null);

  await connection.execute(
    'UPDATE app_metadata SET value_json = ?, updated_at = ? WHERE key = ?',
    [JSON.stringify({ schemaVersion: 2, sfxEnabled: true }), 102, KEY],
  );
  assert.equal(await store.read(), null);

  await connection.execute(
    'UPDATE app_metadata SET value_json = ?, updated_at = ? WHERE key = ?',
    [JSON.stringify({ schemaVersion: 1, sfxEnabled: 'yes' }), 103, KEY],
  );
  assert.equal(await store.read(), null);
});
