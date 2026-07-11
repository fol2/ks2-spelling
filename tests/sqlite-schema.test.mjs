import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createNodeSqliteConnection } from './helpers/node-sqlite-connection.mjs';

const EXPECTED_SCHEMA = [
  'CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL CHECK (updated_at >= 0)) WITHOUT ROWID;',
  "CREATE TABLE learner_profiles (learner_id TEXT PRIMARY KEY, nickname TEXT NOT NULL, year_group TEXT NOT NULL, goal INTEGER NOT NULL CHECK (goal >= 0), colour TEXT NOT NULL, created_at INTEGER NOT NULL CHECK (created_at >= 0), updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)) WITHOUT ROWID;",
  'CREATE TABLE spelling_aggregates (learner_id TEXT PRIMARY KEY REFERENCES learner_profiles(learner_id) ON DELETE CASCADE, snapshot_schema_version INTEGER NOT NULL CHECK (snapshot_schema_version = 1), revision INTEGER NOT NULL CHECK (revision >= 0), pack_id TEXT NOT NULL, catalogue_id TEXT NOT NULL, granted_entitlement_ids_json TEXT NOT NULL, updated_at INTEGER NOT NULL CHECK (updated_at >= 0)) WITHOUT ROWID;',
  'CREATE TABLE spelling_subject_states (learner_id TEXT PRIMARY KEY REFERENCES spelling_aggregates(learner_id) ON DELETE CASCADE, state_json TEXT NOT NULL) WITHOUT ROWID;',
  "CREATE TABLE spelling_practice_sessions (learner_id TEXT PRIMARY KEY REFERENCES spelling_aggregates(learner_id) ON DELETE CASCADE, session_id TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'abandoned')), state_json TEXT NOT NULL) WITHOUT ROWID;",
  'CREATE TABLE spelling_events (learner_id TEXT NOT NULL REFERENCES spelling_aggregates(learner_id) ON DELETE CASCADE, event_id TEXT NOT NULL, sequence_no INTEGER NOT NULL CHECK (sequence_no >= 0), created_at INTEGER NOT NULL CHECK (created_at >= 0), event_json TEXT NOT NULL, PRIMARY KEY (learner_id, event_id), UNIQUE (learner_id, sequence_no)) WITHOUT ROWID;',
  'CREATE TABLE spelling_monster_states (learner_id TEXT NOT NULL REFERENCES spelling_aggregates(learner_id) ON DELETE CASCADE, reward_track_id TEXT NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY (learner_id, reward_track_id)) WITHOUT ROWID;',
  'CREATE TABLE spelling_camp_states (learner_id TEXT NOT NULL REFERENCES spelling_aggregates(learner_id) ON DELETE CASCADE, pack_id TEXT NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY (learner_id, pack_id)) WITHOUT ROWID;',
];

async function withDatabase(run) {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-spelling-schema-'));
  const filename = join(directory, 'schema.sqlite');
  try {
    await run(filename);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function readSchema(connection) {
  return connection.query(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
}

test('schema V1 exports the exact database identity and ordered statements', async () => {
  const { DATABASE_NAME, SCHEMA_VERSION, SCHEMA_V1_STATEMENTS } = await import(
    '../src/platform/database/schema-v1.js'
  );

  assert.equal(DATABASE_NAME, 'ks2-spelling');
  assert.equal(SCHEMA_VERSION, 1);
  assert.deepEqual(SCHEMA_V1_STATEMENTS, EXPECTED_SCHEMA);
  assert.equal(Object.isFrozen(SCHEMA_V1_STATEMENTS), true);
});

test('fresh migration creates only the eight exact V1 tables and PRAGMAs', async () => {
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );

  await withDatabase(async (filename) => {
    const connection = createNodeSqliteConnection(filename);
    await connection.open();
    await configureAndMigrateDatabase(connection);

    assert.deepEqual(await connection.query('PRAGMA foreign_keys'), [
      { foreign_keys: 1 },
    ]);
    assert.deepEqual(await connection.query('PRAGMA journal_mode'), [
      { journal_mode: 'wal' },
    ]);
    assert.deepEqual(await connection.query('PRAGMA synchronous'), [
      { synchronous: 2 },
    ]);
    assert.deepEqual(await connection.query('PRAGMA busy_timeout'), [
      { timeout: 5000 },
    ]);
    assert.deepEqual(await connection.query('PRAGMA user_version'), [
      { user_version: 1 },
    ]);

    const schema = await readSchema(connection);
    assert.deepEqual(
      schema.map(({ name }) => name),
      [
        'app_metadata',
        'learner_profiles',
        'spelling_aggregates',
        'spelling_camp_states',
        'spelling_events',
        'spelling_monster_states',
        'spelling_practice_sessions',
        'spelling_subject_states',
      ],
    );
    assert.deepEqual(
      schema.map(({ sql }) => `${sql};`),
      EXPECTED_SCHEMA.toSorted(),
    );

    const explicitIndexes = await connection.query(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name",
    );
    assert.deepEqual(explicitIndexes, []);
    await connection.close();
  });
});

test('V1 reopen verifies in place without rewriting schema or data', async () => {
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );

  await withDatabase(async (filename) => {
    const first = createNodeSqliteConnection(filename);
    await first.open();
    await configureAndMigrateDatabase(first);
    await first.execute(
      'INSERT INTO app_metadata (key, value_json, updated_at) VALUES (?, ?, ?)',
      ['proof', '{"revision":1}', 100],
    );
    const before = await readSchema(first);
    await first.close();

    const reopened = createNodeSqliteConnection(filename);
    await reopened.open();
    await configureAndMigrateDatabase(reopened);

    assert.deepEqual(await readSchema(reopened), before);
    assert.deepEqual(
      await reopened.query(
        'SELECT key, value_json, updated_at FROM app_metadata ORDER BY key',
      ),
      [{ key: 'proof', value_json: '{"revision":1}', updated_at: 100 }],
    );
    await reopened.close();
  });
});

test('V1 enforces checks, foreign keys, uniqueness and cascades', async () => {
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );

  await withDatabase(async (filename) => {
    const connection = createNodeSqliteConnection(filename);
    await connection.open();
    await configureAndMigrateDatabase(connection);

    await assert.rejects(
      connection.execute(
        'INSERT INTO learner_profiles (learner_id, nickname, year_group, goal, colour, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['invalid', 'Invalid', '3', -1, 'blue', 0, 0],
      ),
      /CHECK constraint failed/,
    );
    await assert.rejects(
      connection.execute(
        'INSERT INTO spelling_aggregates (learner_id, snapshot_schema_version, revision, pack_id, catalogue_id, granted_entitlement_ids_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['missing', 1, 0, 'starter', 'starter-v1', '[]', 0],
      ),
      /FOREIGN KEY constraint failed/,
    );

    await connection.execute(
      'INSERT INTO learner_profiles (learner_id, nickname, year_group, goal, colour, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['learner-a', 'Ada', '3', 10, 'blue', 0, 0],
    );
    await connection.execute(
      'INSERT INTO spelling_aggregates (learner_id, snapshot_schema_version, revision, pack_id, catalogue_id, granted_entitlement_ids_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['learner-a', 1, 0, 'starter', 'starter-v1', '[]', 0],
    );
    await assert.rejects(
      connection.execute(
        'INSERT INTO spelling_practice_sessions (learner_id, session_id, status, state_json) VALUES (?, ?, ?, ?)',
        ['learner-a', 'session-a', 'paused', '{}'],
      ),
      /CHECK constraint failed/,
    );
    await connection.execute(
      'INSERT INTO spelling_events (learner_id, event_id, sequence_no, created_at, event_json) VALUES (?, ?, ?, ?, ?)',
      ['learner-a', 'event-a', 0, 0, '{}'],
    );
    await assert.rejects(
      connection.execute(
        'INSERT INTO spelling_events (learner_id, event_id, sequence_no, created_at, event_json) VALUES (?, ?, ?, ?, ?)',
        ['learner-a', 'event-b', 0, 1, '{}'],
      ),
      /UNIQUE constraint failed/,
    );

    await connection.execute(
      'DELETE FROM learner_profiles WHERE learner_id = ?',
      ['learner-a'],
    );
    assert.deepEqual(
      await connection.query(
        'SELECT learner_id FROM spelling_aggregates WHERE learner_id = ?',
        ['learner-a'],
      ),
      [],
    );
    assert.deepEqual(
      await connection.query(
        'SELECT learner_id FROM spelling_events WHERE learner_id = ?',
        ['learner-a'],
      ),
      [],
    );
    await connection.close();
  });
});

test('V1 verification rejects schema drift without rewriting it', async () => {
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );

  await withDatabase(async (filename) => {
    const connection = createNodeSqliteConnection(filename);
    await connection.open();
    await configureAndMigrateDatabase(connection);
    await connection.execute('DROP TABLE spelling_camp_states');

    await assert.rejects(
      configureAndMigrateDatabase(connection),
      /sqlite_schema_v1_invalid/,
    );
    assert.deepEqual(
      await connection.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'spelling_camp_states'",
      ),
      [],
    );
    await connection.close();
  });
});

test('unsupported newer user_version closes and fails with the exact code', async () => {
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );

  await withDatabase(async (filename) => {
    const connection = createNodeSqliteConnection(filename);
    await connection.open();
    await connection.execute('PRAGMA user_version = 2');

    await assert.rejects(configureAndMigrateDatabase(connection), (error) => {
      assert.equal(error.code, 'sqlite_schema_version_unsupported');
      assert.equal(error.message, 'sqlite_schema_version_unsupported');
      return true;
    });
    await assert.rejects(connection.query('PRAGMA user_version'), /not open/i);
  });
});
