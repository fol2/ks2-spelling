import { canonicalJson } from './canonical-json.js';
import { assertSqlConnection } from './sql-connection-contract.js';

const SOUND_PREFS_KEY = 'product.sound-prefs';

function requireGate(gate) {
  if (!gate || typeof gate !== 'object' || typeof gate.run !== 'function') {
    throw new TypeError('Sound prefs store requires a command gate.');
  }
  return gate;
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

/**
 * Enhancement-cache shape check. Malformed rows must never break the shell,
 * so callers treat a failed parse as a miss.
 */
function parseSoundPrefs(parsed) {
  if (!isPlainObject(parsed)) return null;
  if (parsed.schemaVersion !== 1) return null;
  if (typeof parsed.sfxEnabled !== 'boolean') return null;
  return {
    schemaVersion: 1,
    sfxEnabled: parsed.sfxEnabled,
  };
}

export function createSQLiteSoundPrefsStore({ connection, gate, now } = {}) {
  assertSqlConnection(connection);
  requireGate(gate);
  if (typeof now !== 'function') {
    throw new TypeError('Sound prefs store requires an injected now() clock.');
  }

  return Object.freeze({
    async read() {
      return gate.run(async () => {
        const rows = await connection.query(
          'SELECT value_json, updated_at FROM app_metadata WHERE key = ?',
          [SOUND_PREFS_KEY],
        );
        if (!Array.isArray(rows) || rows.length === 0) return null;
        if (rows.length > 1) return null;
        const row = rows[0];
        if (
          !row ||
          typeof row !== 'object' ||
          typeof row.value_json !== 'string' ||
          !Number.isSafeInteger(row.updated_at)
        ) {
          return null;
        }
        let parsed;
        try {
          parsed = JSON.parse(row.value_json);
        } catch {
          return null;
        }
        const record = parseSoundPrefs(parsed);
        if (record === null) return null;
        return { sfxEnabled: record.sfxEnabled };
      });
    },

    async write(prefs) {
      if (!isPlainObject(prefs) || typeof prefs.sfxEnabled !== 'boolean') {
        throw new TypeError('Sound prefs write requires { sfxEnabled: boolean }.');
      }
      const record = {
        schemaVersion: 1,
        sfxEnabled: prefs.sfxEnabled,
      };
      const updatedAt = now();
      if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
        throw new TypeError('Sound prefs clock must return a safe non-negative integer.');
      }
      return gate.run(async () => {
        await connection.execute(
          'INSERT INTO app_metadata (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
          [SOUND_PREFS_KEY, canonicalJson(record), updatedAt],
        );
        return { sfxEnabled: record.sfxEnabled };
      });
    },
  });
}
