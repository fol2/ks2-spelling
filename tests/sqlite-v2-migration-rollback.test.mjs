import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SCHEMA_V1_STATEMENTS } from '../src/platform/database/schema-v1.js';
import { createNodeSqliteConnection } from './helpers/node-sqlite-connection.mjs';
import {
  createSeededV1,
  learnerCellDigest,
} from './helpers/sqlite-v1-fixture.mjs';

async function withDatabase(run) {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-spelling-v2-rollback-'));
  try {
    await run(join(directory, 'migration.sqlite'));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function exactV1State(connection) {
  return {
    transactionActive: await connection.isTransactionActive(),
    userVersion: await connection.query('PRAGMA user_version'),
    schema: await connection.query(
      'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name',
    ),
    learnerCellDigest: await learnerCellDigest(connection),
  };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function runConcurrentMigrationScenario(connection, blockedPhase) {
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );
  const firstBlocked = createDeferred();
  const releaseFirst = createDeferred();
  const firstPhases = [];
  const secondPhases = [];

  const first = configureAndMigrateDatabase(connection, {
    async afterMigrationStep(checkpoint) {
      firstPhases.push(checkpoint.phase);
      if (checkpoint.phase === blockedPhase && firstPhases.length === 1) {
        firstBlocked.resolve();
        await releaseFirst.promise;
      }
    },
  });
  await firstBlocked.promise;

  let secondSettled = false;
  const second = configureAndMigrateDatabase(connection, {
    async afterMigrationStep(checkpoint) {
      secondPhases.push(checkpoint.phase);
    },
  });
  second.then(
    () => {
      secondSettled = true;
    },
    () => {
      secondSettled = true;
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const settledWhileFirstOwnedTransaction = secondSettled;
  releaseFirst.resolve();
  const results = await Promise.allSettled([first, second]);

  assert.equal(settledWhileFirstOwnedTransaction, false);
  assert.deepEqual(
    results.map(({ status }) => status),
    ['fulfilled', 'fulfilled'],
  );
  assert.equal(secondPhases.length, 0);
  return firstPhases;
}

test('same-connection V1 migrations serialise without rolling back another invocation', async () => {
  await withDatabase(async (filename) => {
    const connection = await createSeededV1(filename);
    const beforeDigest = await learnerCellDigest(connection);

    const firstPhases = await runConcurrentMigrationScenario(
      connection,
      'v2_schema_statement',
    );

    assert.match(firstPhases.join(','), /^v2_/);
    assert.deepEqual(await connection.query('PRAGMA user_version'), [
      { user_version: 2 },
    ]);
    assert.equal(await learnerCellDigest(connection), beforeDigest);
    assert.equal(await connection.isTransactionActive(), false);
    await connection.close();
  });
});

test('same-connection fresh V0 migrations serialise through both committed steps', async () => {
  await withDatabase(async (filename) => {
    const connection = createNodeSqliteConnection(filename);
    await connection.open();

    const firstPhases = await runConcurrentMigrationScenario(
      connection,
      'schema_statement',
    );

    assert.equal(firstPhases[0], 'schema_statement');
    assert.equal(firstPhases.includes('v2_schema_statement'), true);
    assert.deepEqual(await connection.query('PRAGMA user_version'), [
      { user_version: 2 },
    ]);
    assert.equal(await connection.isTransactionActive(), false);
    await connection.close();
  });
});

test('every V2 checkpoint failure restores exact V1 and permits a clean retry', async () => {
  const { SCHEMA_V2_STATEMENTS } = await import(
    '../src/platform/database/schema-v2.js'
  );
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );
  const checkpointCount = SCHEMA_V2_STATEMENTS.length + 4;

  for (let failureIndex = 0; failureIndex < checkpointCount; failureIndex += 1) {
    await withDatabase(async (filename) => {
      const connection = await createSeededV1(filename);
      const before = await exactV1State(connection);
      let observedIndex = 0;

      await assert.rejects(
        configureAndMigrateDatabase(connection, {
          async afterMigrationStep(checkpoint) {
            assert.match(checkpoint.phase, /^v2_/);
            if (observedIndex === failureIndex) {
              throw new Error(`injected_v2_failure_${failureIndex}`);
            }
            observedIndex += 1;
          },
        }),
        new RegExp(`injected_v2_failure_${failureIndex}`),
      );
      assert.deepEqual(await exactV1State(connection), before);

      await configureAndMigrateDatabase(connection);
      assert.deepEqual(await connection.query('PRAGMA user_version'), [
        { user_version: 2 },
      ]);
      await connection.close();
    });
  }
});

test('fresh V0 keeps exact committed V1 when V2 fails', async () => {
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );

  await withDatabase(async (filename) => {
    const connection = createNodeSqliteConnection(filename);
    await connection.open();
    await assert.rejects(
      configureAndMigrateDatabase(connection, {
        async afterMigrationStep(checkpoint) {
          if (checkpoint.phase === 'v2_schema_statement') {
            throw new Error('injected_first_v2_statement_failure');
          }
        },
      }),
      /injected_first_v2_statement_failure/,
    );
    assert.deepEqual(await connection.query('PRAGMA user_version'), [
      { user_version: 1 },
    ]);
    assert.deepEqual(
      await connection.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ),
      SCHEMA_V1_STATEMENTS.map((sql) => ({
        name: /^CREATE TABLE ([a-z_]+)/.exec(sql)[1],
      })).toSorted((left, right) => left.name.localeCompare(right.name)),
    );
    assert.equal(await connection.isTransactionActive(), false);

    await configureAndMigrateDatabase(connection);
    assert.deepEqual(await connection.query('PRAGMA user_version'), [
      { user_version: 2 },
    ]);
    await connection.close();
  });
});

test('V2 foreign-key and integrity failures restore exact V1', async () => {
  const { configureAndMigrateDatabase } = await import(
    '../src/platform/database/migrate-database.js'
  );

  for (const [phase, sql, result, expectedCode] of [
    [
      'v2_foreign_key_check',
      'PRAGMA foreign_key_check',
      [{ table: 'child', rowid: 1, parent: 'parent', fkid: 0 }],
      'sqlite_foreign_key_check_failed',
    ],
    [
      'v2_integrity_check',
      'PRAGMA integrity_check',
      [{ integrity_check: 'corrupt' }],
      'sqlite_integrity_check_failed',
    ],
  ]) {
    await withDatabase(async (filename) => {
      const raw = await createSeededV1(filename);
      const before = await exactV1State(raw);
      let armed = false;
      const connection = Object.freeze({
        async open() { return raw.open(); },
        async close() { return raw.close(); },
        async execute(candidate, values) { return raw.execute(candidate, values); },
        async query(candidate, values) {
          if (armed && candidate === sql) return result;
          return raw.query(candidate, values);
        },
        async begin() { return raw.begin(); },
        async commit() { return raw.commit(); },
        async rollback() { return raw.rollback(); },
        async isTransactionActive() { return raw.isTransactionActive(); },
      });

      await assert.rejects(
        configureAndMigrateDatabase(connection, {
          async afterMigrationStep(checkpoint) {
            if (checkpoint.phase === 'v2_set_user_version') armed = true;
          },
        }),
        { code: expectedCode },
        phase,
      );
      assert.deepEqual(await exactV1State(raw), before);
      await raw.close();
    });
  }
});
