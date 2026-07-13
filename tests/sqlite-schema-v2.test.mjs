import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createNodeSqliteConnection } from './helpers/node-sqlite-connection.mjs';

const EXPECTED_SCHEMA_V2 = Object.freeze([
  "CREATE TABLE app_entitlements (entitlement_id TEXT PRIMARY KEY, store TEXT NOT NULL CHECK (store IN ('apple', 'google')), product_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('active', 'revoked')), sealed_refresh_handle TEXT NULL, refresh_handle_version INTEGER NULL, verified_at INTEGER NOT NULL CHECK (typeof(verified_at) = 'integer' AND verified_at >= 0), refreshed_at INTEGER NOT NULL CHECK (typeof(refreshed_at) = 'integer' AND refreshed_at >= 0), revocation_at INTEGER NULL CHECK (revocation_at IS NULL OR (typeof(revocation_at) = 'integer' AND revocation_at >= 0)), CHECK ((sealed_refresh_handle IS NULL AND refresh_handle_version IS NULL) OR (sealed_refresh_handle IS NOT NULL AND typeof(refresh_handle_version) = 'integer' AND refresh_handle_version > 0))) WITHOUT ROWID;",
  "CREATE TABLE transaction_journal (journal_id TEXT PRIMARY KEY, store TEXT NOT NULL CHECK (store IN ('apple', 'google')), product_id TEXT NOT NULL, store_transaction_id TEXT NULL, observation_state TEXT NOT NULL CHECK (observation_state IN ('pending', 'purchased', 'revoked')), processing_state TEXT NOT NULL CHECK (processing_state IN ('observed', 'verified', 'entitlement-committed', 'store-completion-pending', 'complete', 'rejected')), opaque_proof TEXT NULL, created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0), updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= created_at), UNIQUE (store, store_transaction_id)) WITHOUT ROWID;",
  "CREATE TABLE installed_pack_versions (pack_id TEXT NOT NULL, version TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, path_token TEXT NOT NULL, activation_marker_sha256 TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('ready', 'retired')), installed_at INTEGER NOT NULL CHECK (typeof(installed_at) = 'integer' AND installed_at >= 0), PRIMARY KEY (pack_id, version)) WITHOUT ROWID;",
  "CREATE TABLE active_pack_versions (pack_id TEXT PRIMARY KEY, version TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, path_token TEXT NOT NULL, activated_at INTEGER NOT NULL CHECK (typeof(activated_at) = 'integer' AND activated_at >= 0), FOREIGN KEY (pack_id, version) REFERENCES installed_pack_versions(pack_id, version)) WITHOUT ROWID;",
  "CREATE TABLE pack_download_jobs (job_id TEXT PRIMARY KEY, pack_id TEXT NOT NULL, version TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, archive_name TEXT NOT NULL, archive_sha256 TEXT NOT NULL, expected_bytes INTEGER NOT NULL CHECK (typeof(expected_bytes) = 'integer' AND expected_bytes >= 0), completed_bytes INTEGER NOT NULL CHECK (typeof(completed_bytes) = 'integer' AND completed_bytes >= 0 AND completed_bytes <= expected_bytes), etag TEXT NULL, state TEXT NOT NULL CHECK (state IN ('queued', 'downloading', 'downloaded', 'extracting', 'ready', 'failed')), updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0)) WITHOUT ROWID;",
  "CREATE TABLE pack_download_chunks (job_id TEXT NOT NULL, start_byte INTEGER NOT NULL CHECK (typeof(start_byte) = 'integer' AND start_byte >= 0), end_byte_exclusive INTEGER NOT NULL CHECK (typeof(end_byte_exclusive) = 'integer' AND end_byte_exclusive > start_byte), state TEXT NOT NULL CHECK (state IN ('pending', 'complete')), chunk_sha256 TEXT NULL, PRIMARY KEY (job_id, start_byte), FOREIGN KEY (job_id) REFERENCES pack_download_jobs(job_id) ON DELETE CASCADE) WITHOUT ROWID;",
]);

const EXPECTED_TABLES = Object.freeze({
  app_entitlements: [
    ['entitlement_id', 'TEXT', 1, null, 1],
    ['store', 'TEXT', 1, null, 0],
    ['product_id', 'TEXT', 1, null, 0],
    ['state', 'TEXT', 1, null, 0],
    ['sealed_refresh_handle', 'TEXT', 0, null, 0],
    ['refresh_handle_version', 'INTEGER', 0, null, 0],
    ['verified_at', 'INTEGER', 1, null, 0],
    ['refreshed_at', 'INTEGER', 1, null, 0],
    ['revocation_at', 'INTEGER', 0, null, 0],
  ],
  transaction_journal: [
    ['journal_id', 'TEXT', 1, null, 1],
    ['store', 'TEXT', 1, null, 0],
    ['product_id', 'TEXT', 1, null, 0],
    ['store_transaction_id', 'TEXT', 0, null, 0],
    ['observation_state', 'TEXT', 1, null, 0],
    ['processing_state', 'TEXT', 1, null, 0],
    ['opaque_proof', 'TEXT', 0, null, 0],
    ['created_at', 'INTEGER', 1, null, 0],
    ['updated_at', 'INTEGER', 1, null, 0],
  ],
  installed_pack_versions: [
    ['pack_id', 'TEXT', 1, null, 1],
    ['version', 'TEXT', 1, null, 2],
    ['manifest_sha256', 'TEXT', 1, null, 0],
    ['path_token', 'TEXT', 1, null, 0],
    ['activation_marker_sha256', 'TEXT', 1, null, 0],
    ['state', 'TEXT', 1, null, 0],
    ['installed_at', 'INTEGER', 1, null, 0],
  ],
  active_pack_versions: [
    ['pack_id', 'TEXT', 1, null, 1],
    ['version', 'TEXT', 1, null, 0],
    ['manifest_sha256', 'TEXT', 1, null, 0],
    ['path_token', 'TEXT', 1, null, 0],
    ['activated_at', 'INTEGER', 1, null, 0],
  ],
  pack_download_jobs: [
    ['job_id', 'TEXT', 1, null, 1],
    ['pack_id', 'TEXT', 1, null, 0],
    ['version', 'TEXT', 1, null, 0],
    ['manifest_sha256', 'TEXT', 1, null, 0],
    ['archive_name', 'TEXT', 1, null, 0],
    ['archive_sha256', 'TEXT', 1, null, 0],
    ['expected_bytes', 'INTEGER', 1, null, 0],
    ['completed_bytes', 'INTEGER', 1, null, 0],
    ['etag', 'TEXT', 0, null, 0],
    ['state', 'TEXT', 1, null, 0],
    ['updated_at', 'INTEGER', 1, null, 0],
  ],
  pack_download_chunks: [
    ['job_id', 'TEXT', 1, null, 1],
    ['start_byte', 'INTEGER', 1, null, 2],
    ['end_byte_exclusive', 'INTEGER', 1, null, 0],
    ['state', 'TEXT', 1, null, 0],
    ['chunk_sha256', 'TEXT', 0, null, 0],
  ],
});

async function withDatabase(run) {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-spelling-schema-v2-'));
  try {
    await run(join(directory, 'schema.sqlite'));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function compactTableInfo(rows) {
  return rows.map(({ name, type, notnull, dflt_value, pk }) => [
    name,
    type,
    notnull,
    dflt_value,
    pk,
  ]);
}

test('schema V2 exports the current version and exact frozen statement list', async () => {
  const { SCHEMA_VERSION, SCHEMA_V2_STATEMENTS } = await import(
    '../src/platform/database/schema-v2.js'
  );

  assert.equal(SCHEMA_VERSION, 2);
  assert.equal(Object.isFrozen(SCHEMA_V2_STATEMENTS), true);
  assert.deepEqual(SCHEMA_V2_STATEMENTS, EXPECTED_SCHEMA_V2);
  assert.deepEqual(
    SCHEMA_V2_STATEMENTS.map((sql) => /^CREATE (?:UNIQUE INDEX|TABLE) ([a-z_]+)/.exec(sql)?.[1]),
    [
      'app_entitlements',
      'transaction_journal',
      'installed_pack_versions',
      'active_pack_versions',
      'pack_download_jobs',
      'pack_download_chunks',
    ],
  );
});

test('fresh database has six exact app-wide tables and no learner or capability fields', async () => {
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );

  await withDatabase(async (filename) => {
    const connection = createNodeSqliteConnection(filename);
    await connection.open();
    await configureAndMigrateDatabase(connection);

    assert.deepEqual(await connection.query('PRAGMA user_version'), [
      { user_version: 2 },
    ]);
    for (const [table, expected] of Object.entries(EXPECTED_TABLES)) {
      const info = await connection.query(`PRAGMA table_info(${table})`);
      assert.deepEqual(compactTableInfo(info), expected, table);
      assert.equal(
        info.some(({ name }) =>
          /(?:learner|child|nickname|progress|session|monster|camp|capability|url)/i.test(name),
        ),
        false,
        `${table} must remain app-wide and contain no capability URL`,
      );
    }

    assert.deepEqual(
      await connection.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('app_entitlements', 'transaction_journal', 'installed_pack_versions', 'active_pack_versions', 'pack_download_jobs', 'pack_download_chunks') ORDER BY name",
      ),
      Object.keys(EXPECTED_TABLES)
        .toSorted()
        .map((name) => ({ name })),
    );
    await connection.close();
  });
});

test('V2 closed states, non-negative values and handle tuple fail closed', async () => {
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );

  await withDatabase(async (filename) => {
    const connection = createNodeSqliteConnection(filename);
    await connection.open();
    await configureAndMigrateDatabase(connection);

    const invalidStatements = [
      [
        'INSERT INTO app_entitlements VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['full-ks2', 'apple', 'product', 'pending', null, null, 0, 0, null],
      ],
      [
        'INSERT INTO app_entitlements VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['full-ks2', 'apple', 'product', 'active', 'sealed', null, 0, 0, null],
      ],
      [
        'INSERT INTO app_entitlements VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['full-ks2', 'apple', 'product', 'active', 'sealed', 0, 0, 0, null],
      ],
      [
        'INSERT INTO app_entitlements VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['full-ks2', 'apple', 'product', 'active', null, null, 'not-an-integer', 0, null],
      ],
      [
        'INSERT INTO transaction_journal VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['journal', 'apple', 'product', null, 'unknown', 'observed', null, 0, 0],
      ],
      [
        'INSERT INTO transaction_journal VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['journal', 'apple', 'product', null, 'pending', 'observed', null, 0, 0.5],
      ],
      [
        'INSERT INTO installed_pack_versions VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['pack', '1', 'a'.repeat(64), 'path', 'b'.repeat(64), 'missing', 0],
      ],
      [
        'INSERT INTO pack_download_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['job', 'pack', '1', 'a'.repeat(64), 'pack.zip', 'b'.repeat(64), 1, 2, null, 'queued', 0],
      ],
      [
        'INSERT INTO pack_download_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['job', 'pack', '1', 'a'.repeat(64), 'pack.zip', 'b'.repeat(64), 'not-an-integer', 0, null, 'queued', 0],
      ],
      [
        'INSERT INTO pack_download_chunks VALUES (?, ?, ?, ?, ?)',
        ['missing-job', -1, 1, 'pending', null],
      ],
      [
        'INSERT INTO pack_download_chunks VALUES (?, ?, ?, ?, ?)',
        ['missing-job', 0.5, 1, 'pending', null],
      ],
    ];
    for (const [sql, values] of invalidStatements) {
      await assert.rejects(connection.execute(sql, values), /constraint failed/i);
    }
    await connection.close();
  });
});

test('V2 store transaction identity is unique per store only when non-null', async () => {
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );

  await withDatabase(async (filename) => {
    const connection = createNodeSqliteConnection(filename);
    await connection.open();
    await configureAndMigrateDatabase(connection);
    const insert =
      'INSERT INTO transaction_journal VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
    const row = (journalId, store, storeTransactionId) => [
      journalId,
      store,
      'product',
      storeTransactionId,
      'purchased',
      'observed',
      null,
      0,
      0,
    ];
    await connection.execute(insert, row('a', 'apple', null));
    await connection.execute(insert, row('b', 'apple', null));
    await connection.execute(insert, row('c', 'apple', 'transaction'));
    await connection.execute(insert, row('d', 'google', 'transaction'));
    await assert.rejects(
      connection.execute(insert, row('e', 'apple', 'transaction')),
      /UNIQUE constraint failed/,
    );
    await connection.close();
  });
});

test('V2 foreign keys enforce active installs and cascade only download chunks', async () => {
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );

  await withDatabase(async (filename) => {
    const connection = createNodeSqliteConnection(filename);
    await connection.open();
    await configureAndMigrateDatabase(connection);

    assert.deepEqual(
      await connection.query('PRAGMA foreign_key_list(active_pack_versions)'),
      [
        { id: 0, seq: 0, table: 'installed_pack_versions', from: 'pack_id', to: 'pack_id', on_update: 'NO ACTION', on_delete: 'NO ACTION', match: 'NONE' },
        { id: 0, seq: 1, table: 'installed_pack_versions', from: 'version', to: 'version', on_update: 'NO ACTION', on_delete: 'NO ACTION', match: 'NONE' },
      ],
    );
    assert.deepEqual(
      await connection.query('PRAGMA foreign_key_list(pack_download_chunks)'),
      [
        { id: 0, seq: 0, table: 'pack_download_jobs', from: 'job_id', to: 'job_id', on_update: 'NO ACTION', on_delete: 'CASCADE', match: 'NONE' },
      ],
    );
    await assert.rejects(
      connection.execute(
        'INSERT INTO active_pack_versions VALUES (?, ?, ?, ?, ?)',
        ['pack', '1', 'a'.repeat(64), 'path', 0],
      ),
      /FOREIGN KEY constraint failed/,
    );
    await connection.execute(
      'INSERT INTO pack_download_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['job', 'pack', '1', 'a'.repeat(64), 'pack.zip', 'b'.repeat(64), 1, 0, null, 'queued', 0],
    );
    await connection.execute(
      'INSERT INTO pack_download_chunks VALUES (?, ?, ?, ?, ?)',
      ['job', 0, 1, 'pending', null],
    );
    await connection.execute('DELETE FROM pack_download_jobs WHERE job_id = ?', ['job']);
    assert.deepEqual(await connection.query('SELECT * FROM pack_download_chunks'), []);
    await connection.close();
  });
});
