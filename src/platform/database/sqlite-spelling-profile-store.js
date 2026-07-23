import {
  validateSpellingProfile,
  validateSpellingProfileRepository,
} from '../../domain/spelling/index.js';
import { canonicalJson } from './canonical-json.js';
import { assertSqlConnection } from './sql-connection-contract.js';
import { runOwnedTransaction } from './sqlite-transaction-runner.js';

export const PRODUCT_SELECTED_LEARNER_KEY = 'product-selected-learner-v1';
const SELECTED_LEARNER_KEY = PRODUCT_SELECTED_LEARNER_KEY;
const CANONICAL_LEARNER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const EMPTY_ENTITLEMENTS_JSON = canonicalJson([]);
const INITIAL_SUBJECT_STATE_JSON = canonicalJson({
  ui: {},
  data: {
    prefs: { autoSpeak: false },
    progress: {},
    guardianMap: {},
    pattern: { wobblingByRuntimeItemId: {} },
    postMega: null,
    achievements: {},
    persistenceWarning: null,
  },
});

function storeError(code, options) {
  const error = new Error(code, options);
  error.code = code;
  return error;
}

function requireGate(gate) {
  if (!gate || typeof gate !== 'object' || typeof gate.run !== 'function') {
    throw new TypeError('Profile store requires a database command gate.');
  }
  return gate;
}

function requireLearnerId(value) {
  if (typeof value !== 'string' || !CANONICAL_LEARNER_ID.test(value)) {
    throw new TypeError(
      'Profile learnerId must be a canonical lower-case kebab identifier.',
    );
  }
  return value;
}

function sampleTimestamp(now) {
  const value = now();
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError('Profile clock must return a finite non-negative timestamp.');
  }
  return value;
}

function profileFromRow(row) {
  if (
    !row ||
    typeof row !== 'object' ||
    Array.isArray(row) ||
    Reflect.ownKeys(row).length !== 7
  ) {
    throw storeError('sqlite_profile_row_invalid');
  }
  return validateSpellingProfile({
    learnerId: row.learner_id,
    nickname: row.nickname,
    yearGroup: row.year_group,
    goal: row.goal,
    colour: row.colour,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

async function queryProfile(connection, learnerId) {
  const rows = await connection.query(
    'SELECT learner_id, nickname, year_group, goal, colour, created_at, updated_at FROM learner_profiles WHERE learner_id = ?',
    [learnerId],
  );
  if (!Array.isArray(rows) || rows.length > 1) {
    throw storeError('sqlite_profile_row_invalid');
  }
  return rows.length === 0 ? null : profileFromRow(rows[0]);
}

async function queryProfiles(connection) {
  const rows = await connection.query(
    'SELECT learner_id, nickname, year_group, goal, colour, created_at, updated_at FROM learner_profiles ORDER BY learner_id',
  );
  if (!Array.isArray(rows)) throw storeError('sqlite_profile_rows_invalid');
  return rows.map(profileFromRow);
}

function parseSelectedLearner(bytes) {
  if (typeof bytes !== 'string') {
    throw storeError('sqlite_selected_learner_invalid');
  }
  let value;
  try {
    value = JSON.parse(bytes);
  } catch (cause) {
    throw storeError('sqlite_selected_learner_invalid', { cause });
  }
  if (
    canonicalJson(value) !== bytes ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 1 ||
    !Object.hasOwn(value, 'learnerId')
  ) {
    throw storeError('sqlite_selected_learner_invalid');
  }
  return requireLearnerId(value.learnerId);
}

async function readSelectedLearnerIdUnchecked(connection) {
  const rows = await connection.query(
    'SELECT value_json FROM app_metadata WHERE key = ?',
    [SELECTED_LEARNER_KEY],
  );
  if (!Array.isArray(rows) || rows.length > 1) {
    throw storeError('sqlite_selected_learner_invalid');
  }
  if (rows.length === 0) return null;
  const learnerId = parseSelectedLearner(rows[0]?.value_json);
  if ((await queryProfile(connection, learnerId)) === null) {
    throw storeError('sqlite_selected_learner_missing');
  }
  return learnerId;
}

async function writeSelectedLearner(connection, learnerId, updatedAt) {
  const result = await connection.execute(
    'INSERT INTO app_metadata (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
    [SELECTED_LEARNER_KEY, canonicalJson({ learnerId }), updatedAt],
  );
  if (result.changes !== 1) {
    throw storeError('sqlite_selected_learner_write_failed');
  }
}

async function insertInitialSnapshot(connection, learnerId, updatedAt) {
  const aggregate = await connection.execute(
    'INSERT INTO spelling_aggregates (learner_id, snapshot_schema_version, revision, pack_id, catalogue_id, granted_entitlement_ids_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      learnerId,
      1,
      0,
      'ks2-core',
      'ks2-core:starter',
      EMPTY_ENTITLEMENTS_JSON,
      updatedAt,
    ],
  );
  if (aggregate.changes !== 1) {
    throw storeError('sqlite_profile_snapshot_insert_failed');
  }
  const subject = await connection.execute(
    'INSERT INTO spelling_subject_states (learner_id, state_json) VALUES (?, ?)',
    [learnerId, INITIAL_SUBJECT_STATE_JSON],
  );
  if (subject.changes !== 1) {
    throw storeError('sqlite_profile_snapshot_insert_failed');
  }
}

export async function readSQLiteSelectedLearnerId(connection) {
  assertSqlConnection(connection);
  return readSelectedLearnerIdUnchecked(connection);
}

export function createSQLiteSpellingProfileStore({ connection, gate, now } = {}) {
  assertSqlConnection(connection);
  requireGate(gate);
  if (typeof now !== 'function') {
    throw new TypeError('Profile store requires an injected now() clock.');
  }

  const profiles = validateSpellingProfileRepository(Object.freeze({
    async listProfiles() {
      return gate.run(async () => structuredClone(await queryProfiles(connection)));
    },
    async readProfile(learnerId) {
      requireLearnerId(learnerId);
      return gate.run(async () => {
        const profile = await queryProfile(connection, learnerId);
        return profile === null ? null : structuredClone(profile);
      });
    },
    async writeProfile(candidate) {
      const supplied = validateSpellingProfile(candidate);
      const sampledAt = sampleTimestamp(now);
      return gate.run(() => runOwnedTransaction(connection, async () => {
        const existing = await queryProfile(connection, supplied.learnerId);
        const profile = validateSpellingProfile({
          ...supplied,
          createdAt: existing?.createdAt ?? sampledAt,
          updatedAt: sampledAt,
        });
        const result = existing === null
          ? await connection.execute(
            'INSERT INTO learner_profiles (learner_id, nickname, year_group, goal, colour, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [
              profile.learnerId,
              profile.nickname,
              profile.yearGroup,
              profile.goal,
              profile.colour,
              profile.createdAt,
              profile.updatedAt,
            ],
          )
          : await connection.execute(
            'UPDATE learner_profiles SET nickname = ?, year_group = ?, goal = ?, colour = ?, updated_at = ? WHERE learner_id = ?',
            [
              profile.nickname,
              profile.yearGroup,
              profile.goal,
              profile.colour,
              profile.updatedAt,
              profile.learnerId,
            ],
          );
        if (result.changes !== 1) throw storeError('sqlite_profile_write_failed');
        if (existing === null) {
          await insertInitialSnapshot(connection, profile.learnerId, sampledAt);
        }
        if ((await readSelectedLearnerIdUnchecked(connection)) === null) {
          await writeSelectedLearner(connection, profile.learnerId, sampledAt);
        }
        return structuredClone(profile);
      }));
    },
    async removeProfile(learnerId) {
      requireLearnerId(learnerId);
      const sampledAt = sampleTimestamp(now);
      return gate.run(() => runOwnedTransaction(connection, async () => {
        const selectedLearnerId = await readSelectedLearnerIdUnchecked(connection);
        const result = await connection.execute(
          'DELETE FROM learner_profiles WHERE learner_id = ?',
          [learnerId],
        );
        if (result.changes !== 0 && result.changes !== 1) {
          throw storeError('sqlite_profile_remove_failed');
        }
        if (result.changes === 0 || selectedLearnerId !== learnerId) {
          return result.changes === 1;
        }
        const remaining = await connection.query(
          'SELECT learner_id FROM learner_profiles ORDER BY learner_id LIMIT 1',
        );
        if (!Array.isArray(remaining) || remaining.length > 1) {
          throw storeError('sqlite_profile_rows_invalid');
        }
        if (remaining.length === 0) {
          const metadata = await connection.execute(
            'DELETE FROM app_metadata WHERE key = ?',
            [SELECTED_LEARNER_KEY],
          );
          if (metadata.changes !== 1) {
            throw storeError('sqlite_selected_learner_write_failed');
          }
        } else {
          await writeSelectedLearner(
            connection,
            requireLearnerId(remaining[0]?.learner_id),
            sampledAt,
          );
        }
        return true;
      }));
    },
  }));

  const selection = Object.freeze({
    async readSelectedLearnerId() {
      return gate.run(() => readSelectedLearnerIdUnchecked(connection));
    },
    async selectLearner(learnerId) {
      requireLearnerId(learnerId);
      const sampledAt = sampleTimestamp(now);
      return gate.run(() => runOwnedTransaction(connection, async () => {
        if ((await queryProfile(connection, learnerId)) === null) {
          throw storeError('sqlite_selected_learner_missing');
        }
        await writeSelectedLearner(connection, learnerId, sampledAt);
        return learnerId;
      }));
    },
  });

  const administration = Object.freeze({
    async resetLearning(learnerId) {
      requireLearnerId(learnerId);
      const sampledAt = sampleTimestamp(now);
      return gate.run(() => runOwnedTransaction(connection, async () => {
        if ((await queryProfile(connection, learnerId)) === null) {
          throw storeError('sqlite_profile_missing');
        }
        const removed = await connection.execute(
          'DELETE FROM spelling_aggregates WHERE learner_id = ?',
          [learnerId],
        );
        if (removed.changes !== 1) {
          throw storeError('sqlite_profile_learning_reset_failed');
        }
        await insertInitialSnapshot(connection, learnerId, sampledAt);
        return true;
      }));
    },
  });

  return Object.freeze({ profiles, selection, administration });
}
