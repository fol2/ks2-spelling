import { DatabaseSync } from 'node:sqlite';

import { assertSqlConnection } from '../../src/platform/database/sql-connection-contract.js';

export function createNodeSqliteConnection(filename = ':memory:') {
  const database = new DatabaseSync(filename, { open: false });

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
          database.exec(sql);
          return undefined;
        }
        return database.prepare(sql).run(...values);
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
