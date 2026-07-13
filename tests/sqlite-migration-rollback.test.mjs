import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createNodeSqliteConnection } from './helpers/node-sqlite-connection.mjs';
import {
  createSeededV1,
  learnerCellDigest,
} from './helpers/sqlite-v1-fixture.mjs';

async function withDatabase(run) {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-spelling-migration-'));
  const filename = join(directory, 'migration.sqlite');
  try {
    await run(filename);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function logicalDigest(connection) {
  return {
    transactionActive: await connection.isTransactionActive(),
    userVersion: await connection.query('PRAGMA user_version'),
    schema: await connection.query(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    ),
    marker: await connection.query(
      'SELECT marker_id, value FROM pre_migration_marker ORDER BY marker_id',
    ),
  };
}

async function createV0WithMarker(filename) {
  const connection = createNodeSqliteConnection(filename);
  await connection.open();
  await connection.execute(
    'CREATE TABLE pre_migration_marker (marker_id TEXT PRIMARY KEY, value TEXT NOT NULL)',
  );
  await connection.execute(
    'INSERT INTO pre_migration_marker (marker_id, value) VALUES (?, ?)',
    ['keep', 'unchanged'],
  );
  return connection;
}

function forwardingConnection(connection, queryOverride) {
  return Object.freeze({
    async open() {
      return connection.open();
    },
    async close() {
      return connection.close();
    },
    async execute(sql, values) {
      return connection.execute(sql, values);
    },
    async query(sql, values) {
      const overridden = await queryOverride(sql, values);
      return overridden === undefined ? connection.query(sql, values) : overridden;
    },
    async begin() {
      return connection.begin();
    },
    async commit() {
      return connection.commit();
    },
    async rollback() {
      return connection.rollback();
    },
    async isTransactionActive() {
      return connection.isTransactionActive();
    },
  });
}

const CONFIGURATION_RESULTS = Object.freeze({
  'PRAGMA journal_mode = WAL': [{ journal_mode: 'wal' }],
  'PRAGMA busy_timeout = 5000': [{ timeout: 5000 }],
  'PRAGMA foreign_keys': [{ foreign_keys: 1 }],
  'PRAGMA journal_mode': [{ journal_mode: 'wal' }],
  'PRAGMA synchronous': [{ synchronous: 2 }],
  'PRAGMA busy_timeout': [{ timeout: 5000 }],
});

function createFailureConnection({
  begin,
  rollback,
  transactionStates,
} = {}) {
  const calls = [];
  let beginAttempted = false;
  let stateIndex = 0;
  const connection = Object.freeze({
    async open() {},
    async close() {},
    async execute(sql) {
      calls.push(['execute', sql]);
      if (sql.startsWith('CREATE TABLE')) {
        throw new Error('migration_statement_failed');
      }
      return { changes: 0 };
    },
    async query(sql) {
      calls.push(['query', sql]);
      if (Object.hasOwn(CONFIGURATION_RESULTS, sql)) {
        return CONFIGURATION_RESULTS[sql];
      }
      if (sql === 'PRAGMA user_version') return [{ user_version: 0 }];
      throw new Error(`unexpected_query:${sql}`);
    },
    async begin() {
      calls.push(['begin']);
      beginAttempted = true;
      if (begin) return begin();
    },
    async commit() {},
    async rollback() {
      calls.push(['rollback']);
      if (rollback) return rollback();
    },
    async isTransactionActive() {
      calls.push(['isTransactionActive']);
      if (!beginAttempted) {
        return false;
      }
      const result = transactionStates[stateIndex];
      stateIndex += 1;
      if (result instanceof Error) throw result;
      return result;
    },
  });
  return { calls, connection };
}

function assertAggregateMessages(error, messages) {
  assert.equal(error.code, 'sqlite_migration_rollback_unverified');
  assert.equal(error.message, 'sqlite_migration_rollback_unverified');
  assert.equal(error.cause instanceof AggregateError, true);
  assert.deepEqual(
    error.cause.errors.map((cause) => cause.message),
    messages,
  );
  return true;
}

test('fresh V0 migration exposes every deterministic failure checkpoint', async () => {
  const { SCHEMA_V1_STATEMENTS } = await import(
    '../src/platform/database/schema-v1.js'
  );
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );
  const { SCHEMA_V2_STATEMENTS } = await import(
    '../src/platform/database/schema-v2.js'
  );

  await withDatabase(async (filename) => {
    const connection = createNodeSqliteConnection(filename);
    await connection.open();
    const checkpoints = [];

    await configureAndMigrateDatabase(connection, {
      async afterMigrationStep(checkpoint) {
        checkpoints.push(checkpoint);
      },
    });

    assert.deepEqual(
      checkpoints.map(({ phase }) => phase),
      [
        ...SCHEMA_V1_STATEMENTS.map(() => 'schema_statement'),
        'set_user_version',
        'foreign_key_check',
        'integrity_check',
        'before_commit',
        ...SCHEMA_V2_STATEMENTS.map(() => 'v2_schema_statement'),
        'v2_set_user_version',
        'v2_foreign_key_check',
        'v2_integrity_check',
        'v2_before_commit',
      ],
    );
    assert.deepEqual(
      checkpoints,
      [
        ...SCHEMA_V1_STATEMENTS.map((sql, statementIndex) => ({
          phase: 'schema_statement',
          sql,
          statementIndex,
        })),
        {
          phase: 'set_user_version',
          sql: 'PRAGMA user_version = 1',
          statementIndex: 8,
        },
        {
          phase: 'foreign_key_check',
          sql: 'PRAGMA foreign_key_check',
          statementIndex: 9,
        },
        {
          phase: 'integrity_check',
          sql: 'PRAGMA integrity_check',
          statementIndex: 10,
        },
        { phase: 'before_commit', sql: 'COMMIT', statementIndex: 11 },
        ...SCHEMA_V2_STATEMENTS.map((sql, statementIndex) => ({
          phase: 'v2_schema_statement',
          sql,
          statementIndex,
        })),
        {
          phase: 'v2_set_user_version',
          sql: 'PRAGMA user_version = 2',
          statementIndex: 6,
        },
        {
          phase: 'v2_foreign_key_check',
          sql: 'PRAGMA foreign_key_check',
          statementIndex: 7,
        },
        {
          phase: 'v2_integrity_check',
          sql: 'PRAGMA integrity_check',
          statementIndex: 8,
        },
        { phase: 'v2_before_commit', sql: 'COMMIT', statementIndex: 9 },
      ],
    );
    assert.equal(checkpoints.every(Object.isFrozen), true);
    await connection.close();
  });
});

test('every injected migration failure restores the exact V0 schema and data', async () => {
  const { SCHEMA_V1_STATEMENTS } = await import(
    '../src/platform/database/schema-v1.js'
  );
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );
  const checkpointCount = SCHEMA_V1_STATEMENTS.length + 4;

  for (let failureIndex = 0; failureIndex < checkpointCount; failureIndex += 1) {
    await withDatabase(async (filename) => {
      const connection = createNodeSqliteConnection(filename);
      await connection.open();
      const before = {
        transactionActive: false,
        userVersion: [{ user_version: 0 }],
        schema: [],
      };
      let observedIndex = 0;

      await assert.rejects(
        configureAndMigrateDatabase(connection, {
          async afterMigrationStep() {
            if (observedIndex === failureIndex) {
              throw new Error(`injected_migration_failure_${failureIndex}`);
            }
            observedIndex += 1;
          },
        }),
        new RegExp(`injected_migration_failure_${failureIndex}`),
      );

      assert.deepEqual(
        {
          transactionActive: await connection.isTransactionActive(),
          userVersion: await connection.query('PRAGMA user_version'),
          schema: await connection.query(
            "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
          ),
        },
        before,
      );
      assert.equal(await connection.isTransactionActive(), false);
      await connection.close();

      const reopened = createNodeSqliteConnection(filename);
      await reopened.open();
      assert.deepEqual(await reopened.query('PRAGMA user_version'), [
        { user_version: 0 },
      ]);
      assert.deepEqual(
        await reopened.query(
          "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        ),
        [],
      );
      await reopened.close();
    });
  }
});

test('candidate schema drift rolls back exact V0 data and allows a clean retry', async () => {
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );

  await withDatabase(async (filename) => {
    const connection = await createV0WithMarker(filename);
    const before = await logicalDigest(connection);
    const checkpoints = [];

    await assert.rejects(
      configureAndMigrateDatabase(connection, {
        async afterMigrationStep(checkpoint) {
          checkpoints.push(checkpoint);
        },
      }),
      /sqlite_schema_v1_invalid/,
    );
    assert.deepEqual(await logicalDigest(connection), before);
    assert.equal(
      checkpoints.some(({ phase }) => phase === 'before_commit'),
      false,
    );

    await connection.execute('DROP TABLE pre_migration_marker');
    await configureAndMigrateDatabase(connection);
    assert.deepEqual(await connection.query('PRAGMA user_version'), [
      { user_version: 2 },
    ]);
    await connection.close();
  });
});

test('failed foreign_key_check rolls back and does not reset the database', async () => {
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );

  await withDatabase(async (filename) => {
    const rawConnection = await createV0WithMarker(filename);
    const before = await logicalDigest(rawConnection);
    const connection = forwardingConnection(rawConnection, async (sql) =>
      sql === 'PRAGMA foreign_key_check'
        ? [{ table: 'child', rowid: 1, parent: 'parent', fkid: 0 }]
        : undefined,
    );

    await assert.rejects(
      configureAndMigrateDatabase(connection),
      /sqlite_foreign_key_check_failed/,
    );
    assert.deepEqual(await logicalDigest(rawConnection), before);
    assert.equal(await rawConnection.isTransactionActive(), false);
    await rawConnection.close();
  });
});

test('failed integrity_check rolls back and does not reset the database', async () => {
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );

  await withDatabase(async (filename) => {
    const rawConnection = await createV0WithMarker(filename);
    const before = await logicalDigest(rawConnection);
    const connection = forwardingConnection(rawConnection, async (sql) =>
      sql === 'PRAGMA integrity_check' ? [{ integrity_check: 'corrupt' }] : undefined,
    );

    await assert.rejects(
      configureAndMigrateDatabase(connection),
      /sqlite_integrity_check_failed/,
    );
    assert.deepEqual(await logicalDigest(rawConnection), before);
    assert.equal(await rawConnection.isTransactionActive(), false);
    await rawConnection.close();
  });
});

test('migration verifies rollback leaves no transaction active', async () => {
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );
  let active = false;
  const calls = [];
  const connection = Object.freeze({
    async open() {},
    async close() {},
    async execute(sql) {
      calls.push(['execute', sql]);
      if (sql.startsWith('CREATE TABLE')) {
        throw new Error('migration_statement_failed');
      }
      return { changes: 0 };
    },
    async query(sql) {
      calls.push(['query', sql]);
      if (Object.hasOwn(CONFIGURATION_RESULTS, sql)) {
        return CONFIGURATION_RESULTS[sql];
      }
      if (sql === 'PRAGMA user_version') return [{ user_version: 0 }];
      throw new Error(`unexpected_query:${sql}`);
    },
    async begin() {
      active = true;
      calls.push(['begin']);
    },
    async commit() {},
    async rollback() {
      active = false;
      calls.push(['rollback']);
    },
    async isTransactionActive() {
      calls.push(['isTransactionActive', active]);
      return active;
    },
  });

  await assert.rejects(
    configureAndMigrateDatabase(connection),
    /migration_statement_failed/,
  );
  assert.deepEqual(calls.slice(-3), [
    ['isTransactionActive', true],
    ['rollback'],
    ['isTransactionActive', false],
  ]);
});

test('rollback failure retains migration, rollback and remaining-active errors', async () => {
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );
  const probe = createFailureConnection({
    rollback() {
      throw new Error('native_rollback_failed');
    },
    transactionStates: [true, true],
  });

  await assert.rejects(configureAndMigrateDatabase(probe.connection), (error) =>
    assertAggregateMessages(error, [
      'migration_statement_failed',
      'native_rollback_failed',
      'sqlite_migration_transaction_still_active',
    ]),
  );
});

test('first transaction-state failure is retained after a final inactive proof', async () => {
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );
  const probe = createFailureConnection({
    transactionStates: [new Error('initial_state_failed'), false],
  });

  await assert.rejects(configureAndMigrateDatabase(probe.connection), (error) =>
    assertAggregateMessages(error, [
      'migration_statement_failed',
      'initial_state_failed',
    ]),
  );
  assert.equal(probe.calls.some(([operation]) => operation === 'rollback'), true);
});

test('final transaction-state failure retains the original migration error', async () => {
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );
  const probe = createFailureConnection({
    transactionStates: [true, new Error('final_state_failed')],
  });

  await assert.rejects(configureAndMigrateDatabase(probe.connection), (error) =>
    assertAggregateMessages(error, [
      'migration_statement_failed',
      'final_state_failed',
    ]),
  );
});

test('remaining active transaction is a stable inspectable rollback failure', async () => {
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );
  const probe = createFailureConnection({ transactionStates: [true, true] });

  await assert.rejects(configureAndMigrateDatabase(probe.connection), (error) =>
    assertAggregateMessages(error, [
      'migration_statement_failed',
      'sqlite_migration_transaction_still_active',
    ]),
  );
});

test('native begin followed by adapter rejection rolls back once and releases the queue', async () => {
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );

  await withDatabase(async (filename) => {
    const raw = await createSeededV1(filename);
    const beforeDigest = await learnerCellDigest(raw);
    let beginCount = 0;
    let rollbackCount = 0;
    const connection = Object.freeze({
      async open() { return raw.open(); },
      async close() { return raw.close(); },
      async execute(sql, values) { return raw.execute(sql, values); },
      async query(sql, values) { return raw.query(sql, values); },
      async begin() {
        beginCount += 1;
        await raw.begin();
        if (beginCount === 1) throw new Error('native_begin_ack_invalid');
      },
      async commit() { return raw.commit(); },
      async rollback() {
        rollbackCount += 1;
        return raw.rollback();
      },
      async isTransactionActive() { return raw.isTransactionActive(); },
    });

    const first = configureAndMigrateDatabase(connection);
    const queuedRetry = configureAndMigrateDatabase(connection);
    const results = await Promise.allSettled([first, queuedRetry]);

    assert.equal(results[0].status, 'rejected');
    assert.match(results[0].reason.message, /native_begin_ack_invalid/);
    assert.equal(results[1].status, 'fulfilled');
    assert.equal(beginCount, 2);
    assert.equal(rollbackCount, 1);
    assert.equal(await raw.isTransactionActive(), false);
    assert.deepEqual(await raw.query('PRAGMA user_version'), [
      { user_version: 2 },
    ]);
    assert.equal(await learnerCellDigest(raw), beforeDigest);
    await raw.close();
  });
});

test('ambiguous begin state inspection retains both errors and proves rollback', async () => {
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );

  await withDatabase(async (filename) => {
    const raw = await createSeededV1(filename);
    let inspectAfterBegin = false;
    let inspectionFailed = false;
    let rollbackCount = 0;
    const connection = Object.freeze({
      async open() { return raw.open(); },
      async close() { return raw.close(); },
      async execute(sql, values) { return raw.execute(sql, values); },
      async query(sql, values) { return raw.query(sql, values); },
      async begin() {
        await raw.begin();
        inspectAfterBegin = true;
        throw new Error('native_begin_ack_invalid');
      },
      async commit() { return raw.commit(); },
      async rollback() {
        rollbackCount += 1;
        return raw.rollback();
      },
      async isTransactionActive() {
        if (inspectAfterBegin && !inspectionFailed) {
          inspectionFailed = true;
          throw new Error('native_state_probe_failed');
        }
        return raw.isTransactionActive();
      },
    });

    await assert.rejects(configureAndMigrateDatabase(connection), (error) => {
      assert.equal(error.code, 'sqlite_migration_transaction_state_invalid');
      assert.equal(error.cause instanceof AggregateError, true);
      assert.deepEqual(
        error.cause.errors.map((cause) => cause.message),
        ['native_begin_ack_invalid', 'native_state_probe_failed'],
      );
      return true;
    });
    assert.equal(rollbackCount, 1);
    assert.equal(await raw.isTransactionActive(), false);
    await raw.close();
  });
});

test('pre-existing active transaction is neither begun nor rolled back', async () => {
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );

  await withDatabase(async (filename) => {
    const raw = await createSeededV1(filename);
    await raw.begin();
    let beginCount = 0;
    let rollbackCount = 0;
    const connection = Object.freeze({
      async open() { return raw.open(); },
      async close() { return raw.close(); },
      async execute(sql, values) { return raw.execute(sql, values); },
      async query(sql, values) { return raw.query(sql, values); },
      async begin() {
        beginCount += 1;
        return raw.begin();
      },
      async commit() { return raw.commit(); },
      async rollback() {
        rollbackCount += 1;
        return raw.rollback();
      },
      async isTransactionActive() { return raw.isTransactionActive(); },
    });

    await assert.rejects(configureAndMigrateDatabase(connection), {
      code: 'sqlite_migration_transaction_already_active',
    });
    assert.equal(beginCount, 0);
    assert.equal(rollbackCount, 0);
    assert.equal(await raw.isTransactionActive(), true);
    await raw.rollback();
    await raw.close();
  });
});

test('begin rejection before native start is inspected but never rolled back', async () => {
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );
  const probe = createFailureConnection({
    begin() {
      throw new Error('native_begin_failed');
    },
    transactionStates: [false],
  });

  await assert.rejects(
    configureAndMigrateDatabase(probe.connection),
    /native_begin_failed/,
  );
  assert.deepEqual(probe.calls.slice(-3), [
    ['isTransactionActive'],
    ['begin'],
    ['isTransactionActive'],
  ]);
  assert.equal(
    probe.calls.some(([operation]) => operation === 'rollback'),
    false,
  );
});
