import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createNodeSqliteConnection } from './helpers/node-sqlite-connection.mjs';

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

test('fresh V0 migration exposes every deterministic failure checkpoint', async () => {
  const { SCHEMA_V1_STATEMENTS } = await import(
    '../src/platform/database/schema-v1.js'
  );
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
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
      ],
    );
    assert.deepEqual(
      checkpoints.slice(0, SCHEMA_V1_STATEMENTS.length),
      SCHEMA_V1_STATEMENTS.map((sql, statementIndex) => ({
        phase: 'schema_statement',
        sql,
        statementIndex,
      })),
    );
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
      const connection = await createV0WithMarker(filename);
      const before = await logicalDigest(connection);
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

      assert.deepEqual(await logicalDigest(connection), before);
      assert.equal(await connection.isTransactionActive(), false);
      await connection.close();

      const reopened = createNodeSqliteConnection(filename);
      await reopened.open();
      assert.deepEqual(await logicalDigest(reopened), before);
      await reopened.close();
    });
  }
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
      if (sql === 'PRAGMA user_version') return [{ user_version: 0 }];
      return [];
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
