import assert from 'node:assert/strict';
import test from 'node:test';

function createFakeNativeDependencies({ native = true } = {}) {
  const calls = [];
  const database = {
    async open() {
      calls.push(['database.open']);
    },
    async execute(sql, transaction) {
      calls.push(['database.execute', sql, transaction]);
      return { changes: { changes: 0 } };
    },
    async run(sql, values, transaction) {
      calls.push(['database.run', sql, values, transaction]);
      return { changes: { changes: 1 } };
    },
    async query(sql, values) {
      calls.push(['database.query', sql, values]);
      return { values: [{ answer: 42 }] };
    },
    async beginTransaction() {
      calls.push(['database.beginTransaction']);
      return { changes: { changes: 0 } };
    },
    async commitTransaction() {
      calls.push(['database.commitTransaction']);
      return { changes: { changes: 0 } };
    },
    async rollbackTransaction() {
      calls.push(['database.rollbackTransaction']);
      return { changes: { changes: 0 } };
    },
    async isTransactionActive() {
      calls.push(['database.isTransactionActive']);
      return { result: true };
    },
    async close() {
      calls.push(['database.close']);
    },
  };
  const CapacitorSQLite = { plugin: 'fake' };

  class SQLiteConnection {
    constructor(plugin) {
      calls.push(['manager.constructor', plugin]);
    }

    async createConnection(...args) {
      calls.push(['manager.createConnection', ...args]);
      return database;
    }

    async closeConnection(...args) {
      calls.push(['manager.closeConnection', ...args]);
    }
  }

  return {
    calls,
    database,
    dependencies: {
      Capacitor: { isNativePlatform: () => native },
      CapacitorSQLite,
      SQLiteConnection,
    },
  };
}

test('Capacitor SQLite adapter fails closed outside a native platform', async () => {
  const { createCapacitorSqliteConnection } = await import(
    '../src/platform/database/capacitor-sqlite-connection.js'
  );
  const fake = createFakeNativeDependencies({ native: false });

  await assert.rejects(
    createCapacitorSqliteConnection(fake.dependencies),
    /native platform/i,
  );
  assert.deepEqual(fake.calls, []);
});

test('Capacitor SQLite adapter uses exact connection and statement arguments', async () => {
  const { assertSqlConnection } = await import(
    '../src/platform/database/sql-connection-contract.js'
  );
  const { createCapacitorSqliteConnection } = await import(
    '../src/platform/database/capacitor-sqlite-connection.js'
  );
  const fake = createFakeNativeDependencies();
  const connection = await createCapacitorSqliteConnection(fake.dependencies);

  assert.equal(assertSqlConnection(connection), connection);
  await connection.open();
  assert.deepEqual(await connection.execute('PRAGMA foreign_keys = ON'), {
    changes: { changes: 0 },
  });
  assert.deepEqual(
    await connection.execute('INSERT INTO learner (id) VALUES (?)', ['ada']),
    { changes: { changes: 1 } },
  );
  assert.deepEqual(await connection.query('SELECT answer FROM facts WHERE id = ?', [1]), [
    { answer: 42 },
  ]);
  await connection.begin();
  assert.equal(await connection.isTransactionActive(), true);
  await connection.commit();
  await connection.begin();
  await connection.rollback();

  assert.deepEqual(fake.calls, [
    ['manager.constructor', fake.dependencies.CapacitorSQLite],
    ['manager.createConnection', 'ks2-spelling', false, 'no-encryption', 1, false],
    ['database.open'],
    ['database.execute', 'PRAGMA foreign_keys = ON', false],
    ['database.run', 'INSERT INTO learner (id) VALUES (?)', ['ada'], false],
    ['database.query', 'SELECT answer FROM facts WHERE id = ?', [1]],
    ['database.beginTransaction'],
    ['database.isTransactionActive'],
    ['database.commitTransaction'],
    ['database.beginTransaction'],
    ['database.rollbackTransaction'],
  ]);
});

test('Capacitor SQLite adapter closes through the manager exactly once', async () => {
  const { createCapacitorSqliteConnection } = await import(
    '../src/platform/database/capacitor-sqlite-connection.js'
  );
  const fake = createFakeNativeDependencies();
  const connection = await createCapacitorSqliteConnection(fake.dependencies);

  await connection.close();
  await connection.close();

  assert.deepEqual(fake.calls.slice(-1), [
    ['manager.closeConnection', 'ks2-spelling', false],
  ]);
  assert.equal(fake.calls.filter(([name]) => name === 'manager.closeConnection').length, 1);
  assert.equal(fake.calls.some(([name]) => name === 'database.close'), false);
});
