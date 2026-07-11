import { Capacitor as DefaultCapacitor } from '@capacitor/core';
import {
  CapacitorSQLite as DefaultCapacitorSQLite,
  SQLiteConnection as DefaultSQLiteConnection,
} from '@capacitor-community/sqlite';

import { assertSqlConnection } from './sql-connection-contract.js';

const DATABASE_NAME = 'ks2-spelling';

function requireDataRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain data object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain data object.`);
  }
  return value;
}

function requireExactDataProperties(value, required, optional, label) {
  const record = requireDataRecord(value, label);
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(record);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => typeof key !== 'string' || !allowed.has(key))
  ) {
    throw new TypeError(`${label} has an invalid shape.`);
  }

  const descriptors = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw new TypeError(`${label} must contain only enumerable data properties.`);
    }
    descriptors[key] = descriptor.value;
  }
  return descriptors;
}

function requireSafeNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a safe non-negative integer.`);
  }
  return value;
}

function normaliseNativeChanges(result) {
  const outer = requireExactDataProperties(
    result,
    ['changes'],
    [],
    'Native changes result',
  );
  const inner = requireExactDataProperties(
    outer.changes,
    ['changes'],
    ['lastId', 'values'],
    'Native changes result payload',
  );
  const changes = requireSafeNonNegativeInteger(
    inner.changes,
    'Native changes result payload changes',
  );

  if (Object.hasOwn(inner, 'lastId') && !Number.isSafeInteger(inner.lastId)) {
    throw new TypeError('Native changes result payload lastId must be a safe integer.');
  }
  if (Object.hasOwn(inner, 'values') && !Array.isArray(inner.values)) {
    throw new TypeError('Native changes result payload values must be an array.');
  }
  return changes;
}

function normaliseNativeRows(result) {
  const outer = requireExactDataProperties(
    result,
    ['values'],
    [],
    'Native query result',
  );
  const rows = outer.values;
  if (!Array.isArray(rows) || Object.getPrototypeOf(rows) !== Array.prototype) {
    throw new TypeError('Native query result values must be a standard array.');
  }
  const keys = Reflect.ownKeys(rows);
  const expectedKeys = new Set([
    ...Array.from({ length: rows.length }, (_, index) => String(index)),
    'length',
  ]);
  if (keys.length !== expectedKeys.size || keys.some((key) => !expectedKeys.has(key))) {
    throw new TypeError('Native query result values must be a dense array.');
  }

  return Array.from({ length: rows.length }, (_, index) => {
    const rowDescriptor = Object.getOwnPropertyDescriptor(rows, String(index));
    if (
      !rowDescriptor ||
      !Object.hasOwn(rowDescriptor, 'value') ||
      !rowDescriptor.enumerable
    ) {
      throw new TypeError('Native query row must be an enumerable data property.');
    }
    const row = requireDataRecord(rowDescriptor.value, 'Native query row');
    const entries = [];
    for (const key of Reflect.ownKeys(row)) {
      if (typeof key !== 'string') {
        throw new TypeError('Native query row keys must be strings.');
      }
      const descriptor = Object.getOwnPropertyDescriptor(row, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
        throw new TypeError('Native query row must contain only enumerable data properties.');
      }
      entries.push([key, descriptor.value]);
    }
    return Object.fromEntries(entries);
  });
}

function normaliseNativeTransactionState(result) {
  const state = requireExactDataProperties(
    result,
    ['result'],
    [],
    'Native transaction state result',
  ).result;
  if (typeof state !== 'boolean') {
    throw new TypeError('Native transaction state result must contain a boolean.');
  }
  return state;
}

function createWriteResult(changes) {
  return Object.freeze({ changes });
}

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
        await database.open();
      },
      async close() {
        if (!closePromise) {
          const attempt = Promise.resolve().then(() =>
            manager.closeConnection(DATABASE_NAME, false),
          );
          closePromise = attempt;
          void attempt.catch(() => {
            if (closePromise === attempt) closePromise = undefined;
          });
        }
        await closePromise;
      },
      async execute(sql, values) {
        if (values === undefined) {
          const result = await database.execute(sql, false);
          return createWriteResult(normaliseNativeChanges(result));
        }
        const result = await database.run(sql, values, false);
        return createWriteResult(normaliseNativeChanges(result));
      },
      async query(sql, values) {
        const result = await database.query(sql, values);
        return normaliseNativeRows(result);
      },
      async begin() {
        normaliseNativeChanges(await database.beginTransaction());
      },
      async commit() {
        normaliseNativeChanges(await database.commitTransaction());
      },
      async rollback() {
        normaliseNativeChanges(await database.rollbackTransaction());
      },
      async isTransactionActive() {
        return normaliseNativeTransactionState(await database.isTransactionActive());
      },
    }),
  );
}
