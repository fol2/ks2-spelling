import { Capacitor as DefaultCapacitor } from '@capacitor/core';
import {
  CapacitorSQLite as DefaultCapacitorSQLite,
  SQLiteConnection as DefaultSQLiteConnection,
} from '@capacitor-community/sqlite';

import { assertSqlConnection } from './sql-connection-contract.js';

const DATABASE_NAME = 'ks2-spelling';

export async function createCapacitorSqliteConnection(options = {}) {
  const {
    Capacitor = DefaultCapacitor,
    CapacitorSQLite = DefaultCapacitorSQLite,
    SQLiteConnection = DefaultSQLiteConnection,
  } = options;

  if (Capacitor.isNativePlatform() !== true) {
    throw new Error('Capacitor SQLite requires a native platform.');
  }

  const manager = new SQLiteConnection(CapacitorSQLite);
  const database = await manager.createConnection(
    DATABASE_NAME,
    false,
    'no-encryption',
    1,
    false,
  );
  let closePromise;

  return assertSqlConnection(
    Object.freeze({
      async open() {
        return database.open();
      },
      async close() {
        closePromise ??= manager.closeConnection(DATABASE_NAME, false);
        return closePromise;
      },
      async execute(sql, values) {
        if (values === undefined) {
          return database.execute(sql, false);
        }
        return database.run(sql, values, false);
      },
      async query(sql, values) {
        const result = await database.query(sql, values);
        return result.values ?? [];
      },
      async begin() {
        return database.beginTransaction();
      },
      async commit() {
        return database.commitTransaction();
      },
      async rollback() {
        return database.rollbackTransaction();
      },
      async isTransactionActive() {
        const result = await database.isTransactionActive();
        return result.result === true;
      },
    }),
  );
}
