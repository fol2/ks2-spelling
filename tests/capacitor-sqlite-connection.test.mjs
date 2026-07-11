import assert from 'node:assert/strict';
import test from 'node:test';

function createFakeNativeDependencies({ native = true, results = {} } = {}) {
  const calls = [];
  const resultFor = (name, fallback) =>
    Object.hasOwn(results, name) ? results[name] : fallback;
  const database = {
    async open() {
      calls.push(['database.open']);
    },
    async execute(sql, transaction) {
      calls.push(['database.execute', sql, transaction]);
      return resultFor('execute', { changes: { changes: 0 } });
    },
    async run(sql, values, transaction) {
      calls.push(['database.run', sql, values, transaction]);
      return resultFor('run', { changes: { changes: 1, lastId: 1 } });
    },
    async query(sql, values) {
      calls.push(['database.query', sql, values]);
      return resultFor('query', { values: [{ answer: 42 }] });
    },
    async beginTransaction() {
      calls.push(['database.beginTransaction']);
      return resultFor('begin', { changes: { changes: 0 } });
    },
    async commitTransaction() {
      calls.push(['database.commitTransaction']);
      return resultFor('commit', { changes: { changes: 0 } });
    },
    async rollbackTransaction() {
      calls.push(['database.rollbackTransaction']);
      return resultFor('rollback', { changes: { changes: 0 } });
    },
    async isTransactionActive() {
      calls.push(['database.isTransactionActive']);
      return resultFor('isTransactionActive', { result: true });
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
    changes: 0,
  });
  assert.deepEqual(
    await connection.execute('INSERT INTO learner (id) VALUES (?)', ['ada']),
    { changes: 1 },
  );
  assert.deepEqual(await connection.query('SELECT answer FROM facts WHERE id = ?', [1]), [
    { answer: 42 },
  ]);
  assert.equal(await connection.begin(), undefined);
  assert.equal(await connection.isTransactionActive(), true);
  assert.equal(await connection.commit(), undefined);
  assert.equal(await connection.begin(), undefined);
  assert.equal(await connection.rollback(), undefined);

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

test('Capacitor SQLite adapter shares concurrent close and memoises success', async () => {
  const { createCapacitorSqliteConnection } = await import(
    '../src/platform/database/capacitor-sqlite-connection.js'
  );
  const fake = createFakeNativeDependencies();
  const connection = await createCapacitorSqliteConnection(fake.dependencies);

  await Promise.all([connection.close(), connection.close()]);
  await connection.close();

  assert.deepEqual(fake.calls.slice(-1), [
    ['manager.closeConnection', 'ks2-spelling', false],
  ]);
  assert.equal(fake.calls.filter(([name]) => name === 'manager.closeConnection').length, 1);
  assert.equal(fake.calls.some(([name]) => name === 'database.close'), false);
});

test('Capacitor SQLite adapter retries the exact native close after rejection', async () => {
  const { createCapacitorSqliteConnection } = await import(
    '../src/platform/database/capacitor-sqlite-connection.js'
  );
  const fake = createFakeNativeDependencies();
  const prototype = fake.dependencies.SQLiteConnection.prototype;
  const nativeClose = prototype.closeConnection;
  let attempts = 0;
  prototype.closeConnection = async function closeConnection(...args) {
    attempts += 1;
    await nativeClose.apply(this, args);
    if (attempts === 1) throw new Error('native_close_uncertain');
  };
  const connection = await createCapacitorSqliteConnection(fake.dependencies);

  await assert.rejects(connection.close(), /native_close_uncertain/);
  await connection.close();
  await connection.close();

  assert.equal(attempts, 2);
  assert.equal(
    fake.calls.filter(([name]) => name === 'manager.closeConnection').length,
    2,
  );
});

test('Capacitor SQLite adapter rejects malformed write result shapes', async () => {
  const { createCapacitorSqliteConnection } = await import(
    '../src/platform/database/capacitor-sqlite-connection.js'
  );
  const malformed = [
    {},
    { changes: 1 },
    { changes: {} },
    { changes: { changes: '1' } },
    { changes: { changes: -1 } },
    { changes: { changes: Number.MAX_SAFE_INTEGER + 1 } },
  ];

  for (const result of malformed) {
    const executeFake = createFakeNativeDependencies({ results: { execute: result } });
    const executeConnection = await createCapacitorSqliteConnection(
      executeFake.dependencies,
    );
    await assert.rejects(
      executeConnection.execute('PRAGMA foreign_keys = ON'),
      /safe non-negative integer|native changes result/i,
    );

    const runFake = createFakeNativeDependencies({ results: { run: result } });
    const runConnection = await createCapacitorSqliteConnection(runFake.dependencies);
    await assert.rejects(
      runConnection.execute('UPDATE learner SET score = ? WHERE id = ?', [8, 'ada']),
      /safe non-negative integer|native changes result/i,
    );
  }
});

test('Capacitor SQLite adapter rejects malformed query and transaction-state results', async () => {
  const { createCapacitorSqliteConnection } = await import(
    '../src/platform/database/capacitor-sqlite-connection.js'
  );

  for (const result of [{}, { values: {} }, { values: [null] }]) {
    const fake = createFakeNativeDependencies({ results: { query: result } });
    const connection = await createCapacitorSqliteConnection(fake.dependencies);
    await assert.rejects(connection.query('SELECT 1'), /native query result|row/i);
  }

  for (const result of [{}, { result: 'true' }]) {
    const fake = createFakeNativeDependencies({
      results: { isTransactionActive: result },
    });
    const connection = await createCapacitorSqliteConnection(fake.dependencies);
    await assert.rejects(
      connection.isTransactionActive(),
      /native transaction state result/i,
    );
  }
});

test('Capacitor SQLite adapter validates every transaction operation result', async () => {
  const { createCapacitorSqliteConnection } = await import(
    '../src/platform/database/capacitor-sqlite-connection.js'
  );

  for (const method of ['begin', 'commit', 'rollback']) {
    const fake = createFakeNativeDependencies({ results: { [method]: {} } });
    const connection = await createCapacitorSqliteConnection(fake.dependencies);
    await assert.rejects(connection[method](), /native changes result/i);
  }
});

test('Capacitor SQLite result validation does not invoke hostile accessors', async () => {
  const { createCapacitorSqliteConnection } = await import(
    '../src/platform/database/capacitor-sqlite-connection.js'
  );
  let reads = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'changes', {
    enumerable: true,
    get() {
      reads += 1;
      throw new Error('native_accessor_invoked');
    },
  });
  const fake = createFakeNativeDependencies({ results: { execute: hostile } });
  const connection = await createCapacitorSqliteConnection(fake.dependencies);

  await assert.rejects(
    connection.execute('PRAGMA foreign_keys = ON'),
    /native changes result/i,
  );
  assert.equal(reads, 0);
});

test('Capacitor SQLite adapter clones __proto__ columns as safe own data', async () => {
  const { createCapacitorSqliteConnection } = await import(
    '../src/platform/database/capacitor-sqlite-connection.js'
  );
  const row = {};
  Object.defineProperty(row, '__proto__', {
    value: 'column-value',
    enumerable: true,
  });
  const fake = createFakeNativeDependencies({ results: { query: { values: [row] } } });
  const connection = await createCapacitorSqliteConnection(fake.dependencies);

  const [cloned] = await connection.query('SELECT value AS __proto__ FROM facts');
  assert.equal(Object.getPrototypeOf(cloned), Object.prototype);
  assert.equal(Object.hasOwn(cloned, '__proto__'), true);
  assert.equal(cloned.__proto__, 'column-value');
});
