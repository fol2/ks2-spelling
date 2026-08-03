import { canonicalJson } from './canonical-json.js';
import { assertSqlConnection } from './sql-connection-contract.js';

function baselineKey(learnerId) {
  return `product.round-baseline.${learnerId}`;
}

function requireGate(gate) {
  if (!gate || typeof gate !== 'object' || typeof gate.run !== 'function') {
    throw new TypeError('Round baseline store requires a command gate.');
  }
  return gate;
}

function requireLearnerId(learnerId) {
  if (typeof learnerId !== 'string' || learnerId.length === 0) {
    throw new TypeError('Round baseline learnerId must be a non-empty string.');
  }
  return learnerId;
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
 * Enhancement-cache shape check. Malformed rows must never break learner
 * selection, so callers treat a failed parse as a miss.
 */
function parseBaselineRecord(parsed, learnerId) {
  if (!isPlainObject(parsed)) return null;
  if (parsed.schemaVersion !== 1) return null;
  if (parsed.learnerId !== learnerId) return null;
  if (typeof parsed.sessionId !== 'string' || parsed.sessionId.length === 0) {
    return null;
  }
  if (!Array.isArray(parsed.monsters)) return null;
  if (parsed.camp !== null && !isPlainObject(parsed.camp)) return null;
  return {
    schemaVersion: 1,
    learnerId: parsed.learnerId,
    sessionId: parsed.sessionId,
    companionRewardTrackId:
      typeof parsed.companionRewardTrackId === 'string' && parsed.companionRewardTrackId.length > 0
        ? parsed.companionRewardTrackId
        : null,
    achievementIds: Array.isArray(parsed.achievementIds)
      ? parsed.achievementIds.filter(
        (id) => typeof id === 'string' && id.length > 0,
      )
      : [],
    monsters: parsed.monsters,
    camp: parsed.camp,
  };
}

export function createSQLiteRoundBaselineStore({ connection, gate, now } = {}) {
  assertSqlConnection(connection);
  requireGate(gate);
  if (typeof now !== 'function') {
    throw new TypeError('Round baseline store requires an injected now() clock.');
  }

  return Object.freeze({
    async read(learnerId) {
      const id = requireLearnerId(learnerId);
      return gate.run(async () => {
        const rows = await connection.query(
          'SELECT value_json, updated_at FROM app_metadata WHERE key = ?',
          [baselineKey(id)],
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
        return parseBaselineRecord(parsed, id);
      });
    },
    async write(learnerId, record) {
      const id = requireLearnerId(learnerId);
      const validated = parseBaselineRecord(record, id);
      if (validated === null) {
        throw new TypeError('Round baseline record is invalid.');
      }
      const updatedAt = now();
      if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
        throw new TypeError('Round baseline clock must return a safe non-negative integer.');
      }
      return gate.run(async () => {
        await connection.execute(
          'INSERT INTO app_metadata (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
          [baselineKey(id), canonicalJson(validated), updatedAt],
        );
        return structuredClone(validated);
      });
    },
  });
}
