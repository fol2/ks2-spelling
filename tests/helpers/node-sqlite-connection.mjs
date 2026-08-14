import { DatabaseSync as DefaultDatabaseSync } from 'node:sqlite';

import { assertSqlConnection } from '../../src/platform/database/sql-connection-contract.js';

function requireNodeChanges(result, label) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new TypeError(`${label} must contain a safe non-negative integer.`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(result, 'changes');
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
    throw new TypeError(`${label} must contain a safe non-negative integer.`);
  }
  const value = descriptor.value;
  if (
    (typeof value !== 'bigint' && typeof value !== 'number') ||
    (typeof value === 'number' && !Number.isSafeInteger(value)) ||
    value < 0
  ) {
    throw new TypeError(`${label} must contain a safe non-negative integer.`);
  }
  return typeof value === 'bigint' ? value : BigInt(value);
}

function createWriteResult(changes) {
  if (changes < 0n || changes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError('SQLite changes must be a safe non-negative integer.');
  }
  return Object.freeze({ changes: Number(changes) });
}

export function createNodeSqliteConnection(
  filename = ':memory:',
  { DatabaseSync = DefaultDatabaseSync } = {},
) {
  const database = new DatabaseSync(filename, { open: false });

  function totalChanges() {
    const statement = database.prepare('SELECT total_changes() AS changes');
    statement.setReadBigInts(true);
    return requireNodeChanges(statement.get(), 'SQLite total_changes() result');
  }

  return assertSqlConnection(
    Object.freeze({
      async open() {
        database.open();
      },
      async close() {
        database.close();
      },
      async execute(sql, values) {
        if (values === undefined) {
          const before = totalChanges();
          database.exec(sql);
          return createWriteResult(totalChanges() - before);
        }
        // Report the total_changes() delta rather than StatementSync's
        // sqlite3_changes-based count: the Capacitor iOS plugin derives its
        // changes from sqlite3_total_changes, which counts rows removed by
        // ON DELETE CASCADE, so tests must see the same cascade-inclusive
        // numbers the device sees.
        const statement = database.prepare(sql);
        statement.setReadBigInts(true);
        const before = totalChanges();
        const reported = requireNodeChanges(
          statement.run(...values),
          'StatementSync run result',
        );
        if (reported > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new TypeError(
            'StatementSync run result must contain a safe non-negative integer.',
          );
        }
        return createWriteResult(totalChanges() - before);
      },
      async query(sql, values = []) {
        return database.prepare(sql).all(...values).map((row) => ({ ...row }));
      },
      async begin() {
        database.exec('BEGIN');
      },
      async commit() {
        database.exec('COMMIT');
      },
      async rollback() {
        database.exec('ROLLBACK');
      },
      async isTransactionActive() {
        return database.isTransaction;
      },
    }),
  );
}
