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
  const directory = await mkdtemp(join(tmpdir(), 'ks2-spelling-v1-v2-'));
  try {
    await run(join(directory, 'migration.sqlite'));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test('fresh V0 migrates through committed V1 then V2 with distinct checkpoints', async () => {
  const { SCHEMA_V1_STATEMENTS: V1 } = await import(
    '../src/platform/database/schema-v1.js'
  );
  const { SCHEMA_V2_STATEMENTS } = await import(
    '../src/platform/database/schema-v2.js'
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
        ...V1.map(() => 'schema_statement'),
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
    assert.equal(checkpoints.every(Object.isFrozen), true);
    assert.deepEqual(await connection.query('PRAGMA user_version'), [
      { user_version: 2 },
    ]);
    await connection.close();
  });
});

test('seeded V1 to V2 preserves learner SQL cell bytes and SQLite types', async () => {
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );

  await withDatabase(async (filename) => {
    const connection = await createSeededV1(filename);
    const before = await learnerCellDigest(connection);
    await configureAndMigrateDatabase(connection);
    assert.equal(await learnerCellDigest(connection), before);
    assert.deepEqual(await connection.query('PRAGMA user_version'), [
      { user_version: 2 },
    ]);
    await connection.close();
  });
});

test('V2 reopen is idempotent and emits no migration checkpoints', async () => {
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );

  await withDatabase(async (filename) => {
    const first = createNodeSqliteConnection(filename);
    await first.open();
    await configureAndMigrateDatabase(first);
    await first.execute(
      'INSERT INTO app_entitlements VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['full-ks2', 'apple', 'product', 'active', 'sealed', 1, 10, 10, null],
    );
    const before = await first.query(
      'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name',
    );
    await first.close();

    const reopened = createNodeSqliteConnection(filename);
    await reopened.open();
    const checkpoints = [];
    await configureAndMigrateDatabase(reopened, {
      async afterMigrationStep(checkpoint) {
        checkpoints.push(checkpoint);
      },
    });
    assert.deepEqual(checkpoints, []);
    assert.deepEqual(
      await reopened.query(
        'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name',
      ),
      before,
    );
    assert.deepEqual(await reopened.query('SELECT * FROM app_entitlements'), [
      {
        entitlement_id: 'full-ks2',
        store: 'apple',
        product_id: 'product',
        state: 'active',
        sealed_refresh_handle: 'sealed',
        refresh_handle_version: 1,
        verified_at: 10,
        refreshed_at: 10,
        revocation_at: null,
      },
    ]);
    await reopened.close();
  });
});

test('unknown V3 closes and fails without rewriting the database', async () => {
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );

  await withDatabase(async (filename) => {
    const connection = createNodeSqliteConnection(filename);
    await connection.open();
    await connection.execute('CREATE TABLE future_data (value TEXT NOT NULL)');
    await connection.execute('INSERT INTO future_data VALUES (?)', ['keep']);
    await connection.execute('PRAGMA user_version = 3');

    await assert.rejects(configureAndMigrateDatabase(connection), {
      code: 'sqlite_schema_version_unsupported',
    });
    await assert.rejects(connection.query('PRAGMA user_version'), /not open/i);

    const inspection = createNodeSqliteConnection(filename);
    await inspection.open();
    assert.deepEqual(await inspection.query('PRAGMA user_version'), [
      { user_version: 3 },
    ]);
    assert.deepEqual(await inspection.query('SELECT value FROM future_data'), [
      { value: 'keep' },
    ]);
    await inspection.close();
  });
});
