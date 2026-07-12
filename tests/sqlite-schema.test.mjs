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

const CONFIGURATION_RESULTS = Object.freeze({
  'PRAGMA journal_mode = WAL': [{ journal_mode: 'wal' }],
  'PRAGMA foreign_keys': [{ foreign_keys: 1 }],
  'PRAGMA journal_mode': [{ journal_mode: 'wal' }],
  'PRAGMA synchronous': [{ synchronous: 2 }],
  'PRAGMA busy_timeout': [{ timeout: 5000 }],
});

function createConfigurationProbeConnection(overrides = {}) {
  const calls = [];
  const connection = Object.freeze({
    async open() {},
    async close() {
      calls.push(['close']);
    },
    async execute(sql) {
      calls.push(['execute', sql]);
      return { changes: 0 };
    },
    async query(sql) {
      calls.push(['query', sql]);
      if (Object.hasOwn(overrides, sql)) return overrides[sql];
      if (Object.hasOwn(CONFIGURATION_RESULTS, sql)) {
        return CONFIGURATION_RESULTS[sql];
      }
      if (sql === 'PRAGMA user_version') return [{ user_version: 2 }];
      throw new Error(`unexpected_query:${sql}`);
    },
    async begin() {
      calls.push(['begin']);
    },
    async commit() {},
    async rollback() {},
    async isTransactionActive() {
      return false;
    },
  });
  return { calls, connection };
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

test('configuration queries the row-returning WAL assignment before exact readback', async () => {
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );

  await withDatabase(async (filename) => {
    const inner = createNodeSqliteConnection(filename);
    const calls = [];
    const connection = Object.freeze({
      async open() {
        return inner.open();
      },
      async close() {
        return inner.close();
      },
      async execute(sql, values) {
        calls.push(['execute', sql]);
        if (sql === 'PRAGMA journal_mode = WAL') {
          throw new Error(
            'Queries can be performed using SQLiteDatabase query or rawQuery methods only.',
          );
        }
        return inner.execute(sql, values);
      },
      async query(sql, values) {
        calls.push(['query', sql]);
        return inner.query(sql, values);
      },
      async begin() {
        return inner.begin();
      },
      async commit() {
        return inner.commit();
      },
      async rollback() {
        return inner.rollback();
      },
      async isTransactionActive() {
        return inner.isTransactionActive();
      },
    });

    await connection.open();
    await configureAndMigrateDatabase(connection);

    assert.deepEqual(calls.slice(0, 8), [
      ['execute', 'PRAGMA foreign_keys = ON'],
      ['query', 'PRAGMA journal_mode = WAL'],
      ['execute', 'PRAGMA synchronous = FULL'],
      ['execute', 'PRAGMA busy_timeout = 5000'],
      ['query', 'PRAGMA foreign_keys'],
      ['query', 'PRAGMA journal_mode'],
      ['query', 'PRAGMA synchronous'],
      ['query', 'PRAGMA busy_timeout'],
    ]);
    assert.deepEqual(await connection.query('PRAGMA journal_mode'), [
      { journal_mode: 'wal' },
    ]);
    assert.deepEqual(await connection.query('PRAGMA foreign_keys'), [
      { foreign_keys: 1 },
    ]);
    assert.deepEqual(await readSchema(connection),
      EXPECTED_SCHEMA.map((sql) => ({
        name: /^CREATE TABLE ([a-z_]+) /.exec(sql)?.[1],
        sql: sql.slice(0, -1),
      })).toSorted((left, right) => left.name.localeCompare(right.name)),
    );
    await connection.close();
  });
});

test('configuration fails closed when a native port ignores or misreports a PRAGMA', async () => {
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );
  const cases = [
    {
      sql: 'PRAGMA foreign_keys',
      ignored: [{ foreign_keys: 0 }],
      wrong: [{ foreign_keys: 1, extra: true }],
    },
    {
      sql: 'PRAGMA journal_mode',
      ignored: [{ journal_mode: 'delete' }],
      wrong: [{ journal_mode: 'wal', extra: true }],
    },
    {
      sql: 'PRAGMA synchronous',
      ignored: [{ synchronous: 1 }],
      wrong: [{ synchronous: 2, extra: true }],
    },
    {
      sql: 'PRAGMA busy_timeout',
      ignored: [{ timeout: 0 }],
      wrong: [{ timeout: 5000, extra: true }],
    },
  ];

  for (const { sql, ignored, wrong } of cases) {
    let accessorReads = 0;
    const accessorRow = {};
    const property = Object.keys(CONFIGURATION_RESULTS[sql][0])[0];
    Object.defineProperty(accessorRow, property, {
      enumerable: true,
      get() {
        accessorReads += 1;
        return CONFIGURATION_RESULTS[sql][0][property];
      },
    });
    const variants = {
      ignored,
      wrong,
      missing: [{}],
      malformed: { [property]: CONFIGURATION_RESULTS[sql][0][property] },
      accessor: [accessorRow],
    };

    for (const [variant, result] of Object.entries(variants)) {
      const probe = createConfigurationProbeConnection({ [sql]: result });
      await assert.rejects(
        configureAndMigrateDatabase(probe.connection),
        /sqlite_configuration_invalid/,
        `${sql} ${variant}`,
      );
      assert.equal(
        probe.calls.some(
          ([operation, value]) => operation === 'query' && value === 'PRAGMA user_version',
        ),
        false,
        `${sql} ${variant} must fail before schema inspection`,
      );
    }
    assert.equal(accessorReads, 0, `${sql} accessor must not be invoked`);
  }
});

test('configuration rejects malformed row-returning WAL assignment evidence', async () => {
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );
  const candidates = [
    [],
    [{ journal_mode: 'delete' }],
    [{ journal_mode: 'wal', extra: true }],
    { journal_mode: 'wal' },
  ];

  for (const candidate of candidates) {
    const probe = createConfigurationProbeConnection({
      'PRAGMA journal_mode = WAL': candidate,
    });
    await assert.rejects(
      configureAndMigrateDatabase(probe.connection),
      /sqlite_configuration_invalid/,
    );
    assert.deepEqual(probe.calls.slice(0, 2), [
      ['execute', 'PRAGMA foreign_keys = ON'],
      ['query', 'PRAGMA journal_mode = WAL'],
    ]);
  }
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

test('V1 verification rejects an explicit index without rewriting it', async () => {
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );

  await withDatabase(async (filename) => {
    const connection = createNodeSqliteConnection(filename);
    await connection.open();
    await configureAndMigrateDatabase(connection);
    await connection.execute(
      'CREATE INDEX app_metadata_updated_at ON app_metadata (updated_at)',
    );

    await assert.rejects(
      configureAndMigrateDatabase(connection),
      /sqlite_schema_v1_invalid/,
    );
    assert.deepEqual(
      await connection.query(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name = 'app_metadata_updated_at'",
      ),
      [
        {
          type: 'index',
          name: 'app_metadata_updated_at',
          tbl_name: 'app_metadata',
          sql: 'CREATE INDEX app_metadata_updated_at ON app_metadata (updated_at)',
        },
      ],
    );
    await connection.close();
  });
});

test('V1 authority rejects unexpected views and triggers without rewriting them', async () => {
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );
  const cases = [
    {
      name: 'unexpected_view',
      sql: 'CREATE VIEW unexpected_view AS SELECT key FROM app_metadata',
      type: 'view',
    },
    {
      name: 'unexpected_trigger',
      sql: 'CREATE TRIGGER unexpected_trigger AFTER INSERT ON app_metadata BEGIN SELECT 1; END',
      type: 'trigger',
    },
  ];

  for (const candidate of cases) {
    await withDatabase(async (filename) => {
      const connection = createNodeSqliteConnection(filename);
      await connection.open();
      await configureAndMigrateDatabase(connection);
      await connection.execute(candidate.sql);

      await assert.rejects(
        configureAndMigrateDatabase(connection),
        /sqlite_schema_v1_invalid/,
      );
      assert.deepEqual(
        await connection.query(
          'SELECT type, name, sql FROM sqlite_master WHERE name = ?',
          [candidate.name],
        ),
        [{ type: candidate.type, name: candidate.name, sql: candidate.sql }],
      );
      await connection.close();
    });
  }
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

test('unsupported version preserves a close failure as the exact outer cause', async () => {
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );
  const closeError = new Error('native_close_failed');
  const probe = createConfigurationProbeConnection();
  const connection = Object.freeze({
    ...probe.connection,
    async close() {
      throw closeError;
    },
  });

  await assert.rejects(configureAndMigrateDatabase(connection), (error) => {
    assert.equal(error.code, 'sqlite_schema_version_unsupported');
    assert.equal(error.message, 'sqlite_schema_version_unsupported');
    assert.equal(error.cause, closeError);
    return true;
  });
});
