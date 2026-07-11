import assert from 'node:assert/strict';
import test from 'node:test';

const METHOD_NAMES = [
  'open',
  'close',
  'execute',
  'query',
  'begin',
  'commit',
  'rollback',
  'isTransactionActive',
];

function createValidConnection() {
  return Object.fromEntries(METHOD_NAMES.map((name) => [name, async () => undefined]));
}

test('SQL connection contract accepts only the exact own enumerable async surface', async () => {
  const { assertSqlConnection } = await import(
    '../src/platform/database/sql-connection-contract.js'
  );
  const connection = createValidConnection();

  assert.equal(assertSqlConnection(connection), connection);
  assert.deepEqual(Object.keys(connection), METHOD_NAMES);
});

test('SQL connection contract rejects missing, extra, hidden and symbol properties', async () => {
  const { assertSqlConnection } = await import(
    '../src/platform/database/sql-connection-contract.js'
  );

  const missing = createValidConnection();
  delete missing.query;
  assert.throws(() => assertSqlConnection(missing), /exactly/);

  const extra = createValidConnection();
  extra.reset = async () => undefined;
  assert.throws(() => assertSqlConnection(extra), /exactly/);

  const hidden = createValidConnection();
  Object.defineProperty(hidden, 'reset', { value: async () => undefined });
  assert.throws(() => assertSqlConnection(hidden), /exactly/);

  const symbol = createValidConnection();
  symbol[Symbol('reset')] = async () => undefined;
  assert.throws(() => assertSqlConnection(symbol), /exactly/);
});

test('SQL connection contract inspects descriptors without invoking accessors', async () => {
  const { assertSqlConnection } = await import(
    '../src/platform/database/sql-connection-contract.js'
  );
  const connection = createValidConnection();
  let reads = 0;
  Object.defineProperty(connection, 'query', {
    enumerable: true,
    get() {
      reads += 1;
      throw new Error('accessor_invoked');
    },
  });

  assert.throws(() => assertSqlConnection(connection), /data propert/);
  assert.equal(reads, 0);
});

test('SQL connection contract rejects inherited, non-enumerable and synchronous methods', async () => {
  const { assertSqlConnection } = await import(
    '../src/platform/database/sql-connection-contract.js'
  );

  const inherited = Object.create({ open: async () => undefined });
  Object.assign(
    inherited,
    Object.fromEntries(METHOD_NAMES.slice(1).map((name) => [name, async () => undefined])),
  );
  assert.throws(() => assertSqlConnection(inherited), /exactly/);

  const nonEnumerable = createValidConnection();
  Object.defineProperty(nonEnumerable, 'query', {
    value: async () => undefined,
    enumerable: false,
  });
  assert.throws(() => assertSqlConnection(nonEnumerable), /enumerable/);

  for (const replacement of [
    () => undefined,
    () => Promise.resolve(),
  ]) {
    const synchronous = createValidConnection();
    synchronous.execute = replacement;
    assert.throws(() => assertSqlConnection(synchronous), /async function/);
  }
});

test('Node SQLite test adapter implements the async port and parameterised operations', async () => {
  const { assertSqlConnection } = await import(
    '../src/platform/database/sql-connection-contract.js'
  );
  const { createNodeSqliteConnection } = await import(
    './helpers/node-sqlite-connection.mjs'
  );
  const connection = createNodeSqliteConnection();

  assert.equal(assertSqlConnection(connection), connection);
  await connection.open();
  await connection.execute('CREATE TABLE learner (id TEXT PRIMARY KEY, score INTEGER)');
  await connection.execute('INSERT INTO learner (id, score) VALUES (?, ?)', ['ada', 7]);
  assert.deepEqual(await connection.query('SELECT id, score FROM learner WHERE id = ?', ['ada']), [
    { id: 'ada', score: 7 },
  ]);
  await connection.begin();
  assert.equal(await connection.isTransactionActive(), true);
  await connection.rollback();
  assert.equal(await connection.isTransactionActive(), false);
  await connection.close();
});
