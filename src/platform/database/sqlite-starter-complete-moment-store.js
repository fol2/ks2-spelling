import { canonicalJson } from './canonical-json.js';
import { assertSqlConnection } from './sql-connection-contract.js';

export const STARTER_COMPLETE_MOMENT_KEY_PREFIX = 'product.starter-complete-moment.';

export function starterCompleteMomentMetadataKey(learnerId) {
  return `${STARTER_COMPLETE_MOMENT_KEY_PREFIX}${requireLearnerId(learnerId)}`;
}

function storeError(code, options) {
  const error = new Error(code, options);
  error.code = code;
  return error;
}

function requireGate(gate) {
  if (!gate || typeof gate !== 'object' || typeof gate.run !== 'function') {
    throw new TypeError('Starter complete moment store requires a command gate.');
  }
  return gate;
}

function requireLearnerId(learnerId) {
  if (typeof learnerId !== 'string' || learnerId.length === 0) {
    throw new TypeError('Starter complete moment learnerId must be a non-empty string.');
  }
  return learnerId;
}

function isPlainObject(value) {
  return (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null)
  );
}

/**
 * Enhancement-cache shape check. Malformed rows must never break a round,
 * so callers treat a failed parse as a miss.
 */
function parseMomentRecord(parsed, learnerId) {
  if (!isPlainObject(parsed)) return null;
  if (parsed.schemaVersion !== 1) return null;
  if (parsed.learnerId !== learnerId) return null;
  if (parsed.presented !== true) return null;
  return {
    schemaVersion: 1,
    learnerId: parsed.learnerId,
    presented: true,
  };
}

export function createSQLiteStarterCompleteMomentStore({
  connection,
  gate,
  now,
} = {}) {
  assertSqlConnection(connection);
  requireGate(gate);
  if (typeof now !== 'function') {
    throw new TypeError('Starter complete moment store requires an injected now() clock.');
  }

  return Object.freeze({
    async read(learnerId) {
      const id = requireLearnerId(learnerId);
      return gate.run(async () => {
        const rows = await connection.query(
          'SELECT value_json, updated_at FROM app_metadata WHERE key = ?',
          [starterCompleteMomentMetadataKey(id)],
        );
        if (!Array.isArray(rows) || rows.length === 0) return null;
        if (rows.length > 1) return null;
        const row = rows[0];
        if (
          !row
          || typeof row !== 'object'
          || typeof row.value_json !== 'string'
          || !Number.isSafeInteger(row.updated_at)
        ) {
          return null;
        }
        let parsed;
        try {
          parsed = JSON.parse(row.value_json);
        } catch {
          return null;
        }
        const record = parseMomentRecord(parsed, id);
        return record ? { presented: true } : null;
      });
    },

    async write(learnerId, record) {
      const id = requireLearnerId(learnerId);
      if (!isPlainObject(record) || record.presented !== true) {
        throw new TypeError(
          'Starter complete moment write requires { presented: true }.',
        );
      }
      const stored = {
        schemaVersion: 1,
        learnerId: id,
        presented: true,
      };
      const updatedAt = now();
      if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
        throw new TypeError(
          'Starter complete moment clock must return a safe non-negative integer.',
        );
      }
      return gate.run(async () => {
        const result = await connection.execute(
          'INSERT INTO app_metadata (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
          [starterCompleteMomentMetadataKey(id), canonicalJson(stored), updatedAt],
        );
        if (result.changes !== 1) {
          throw storeError('sqlite_starter_complete_moment_write_failed');
        }
        return { presented: true };
      });
    },
  });
}

/**
 * Deletes the per-learner presented flag inside an already-owned SQLite
 * transaction. Missing rows are a successful no-op so a learner who never
 * saw the moment can still be removed.
 */
export async function deleteStarterCompleteMomentInTransaction(connection, learnerId) {
  assertSqlConnection(connection);
  const result = await connection.execute(
    'DELETE FROM app_metadata WHERE key = ?',
    [starterCompleteMomentMetadataKey(learnerId)],
  );
  if (!Number.isSafeInteger(result?.changes) || result.changes < 0) {
    throw new TypeError('Starter complete moment cleanup failed.');
  }
}
