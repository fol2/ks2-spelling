import {
  validateParentSecurityRecord,
} from '../../domain/security/parent-security-record.js';
import { canonicalJson } from './canonical-json.js';
import { assertSqlConnection } from './sql-connection-contract.js';

const PARENT_SECURITY_KEY = 'parent-security-v1';

function repositoryError(code, options) {
  const error = new Error(code, options);
  error.code = code;
  return error;
}

function requireGate(gate) {
  if (!gate || typeof gate !== 'object' || typeof gate.run !== 'function') {
    throw new TypeError('Parent security repository requires a command gate.');
  }
  return gate;
}

function parseRecord(row) {
  if (
    !row ||
    typeof row !== 'object' ||
    Array.isArray(row) ||
    Reflect.ownKeys(row).length !== 2 ||
    typeof row.value_json !== 'string' ||
    !Number.isSafeInteger(row.updated_at)
  ) {
    throw repositoryError('parent_security_row_invalid');
  }
  let parsed;
  try {
    parsed = JSON.parse(row.value_json);
  } catch (cause) {
    throw repositoryError('parent_security_row_invalid', { cause });
  }
  let record;
  try {
    record = validateParentSecurityRecord(parsed);
  } catch (cause) {
    throw repositoryError('parent_security_row_invalid', { cause });
  }
  if (
    canonicalJson(record) !== row.value_json ||
    record.updatedAt !== row.updated_at
  ) {
    throw repositoryError('parent_security_row_invalid');
  }
  return record;
}

export function createSQLiteParentSecurityRepository({ connection, gate } = {}) {
  assertSqlConnection(connection);
  requireGate(gate);

  return Object.freeze({
    async read() {
      return gate.run(async () => {
        const rows = await connection.query(
          'SELECT value_json, updated_at FROM app_metadata WHERE key = ?',
          [PARENT_SECURITY_KEY],
        );
        if (!Array.isArray(rows) || rows.length > 1) {
          throw repositoryError('parent_security_row_invalid');
        }
        return rows.length === 0 ? null : structuredClone(parseRecord(rows[0]));
      });
    },
    async write(candidate) {
      const record = validateParentSecurityRecord(candidate);
      return gate.run(async () => {
        const result = await connection.execute(
          'INSERT INTO app_metadata (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
          [PARENT_SECURITY_KEY, canonicalJson(record), record.updatedAt],
        );
        if (result.changes !== 1) {
          throw repositoryError('parent_security_write_failed');
        }
        return structuredClone(record);
      });
    },
  });
}
