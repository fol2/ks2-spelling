import {
  parseRuntimeItemId,
  validateSpellingProfileRepository,
} from '../../domain/spelling/index.js';
import {
  validateSpellingProfile,
} from '../../domain/spelling/profile-contract.js';
import { canonicalJson } from './canonical-json.js';
import { assertSqlConnection } from './sql-connection-contract.js';
import { runOwnedTransaction } from './sqlite-transaction-runner.js';

export const PRODUCT_SELECTED_LEARNER_KEY = 'product-selected-learner-v1';
export const PRESERVED_FULL_LEARNING_KEY_PREFIX = 'preserved-full-learning-v1:';
const SELECTED_LEARNER_KEY = PRODUCT_SELECTED_LEARNER_KEY;
const CANONICAL_LEARNER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const STARTER_CATALOGUE_ID = 'ks2-core:starter';
const FULL_CATALOGUE_ID = 'ks2-core:full';
const EMPTY_ENTITLEMENTS_JSON = canonicalJson([]);
const FULL_ENTITLEMENTS_JSON = canonicalJson(['full-ks2']);
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

function requireCatalogueId(value) {
  let identity;
  try {
    identity = parseRuntimeItemId(value);
  } catch (cause) {
    throw new TypeError('Profile catalogueId must be canonical.', { cause });
  }
  if (![STARTER_CATALOGUE_ID, FULL_CATALOGUE_ID].includes(identity.runtimeItemId)) {
    throw new TypeError('Profile catalogueId must be a supported ks2-core catalogue.');
  }
  return identity.runtimeItemId;
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

async function insertInitialSnapshot(
  connection,
  learnerId,
  updatedAt,
  catalogueId,
) {
  const aggregate = await connection.execute(
    'INSERT INTO spelling_aggregates (learner_id, snapshot_schema_version, revision, pack_id, catalogue_id, granted_entitlement_ids_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      learnerId,
      1,
      0,
      'ks2-core',
      catalogueId,
      catalogueId === FULL_CATALOGUE_ID
        ? FULL_ENTITLEMENTS_JSON
        : EMPTY_ENTITLEMENTS_JSON,
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

function requireChanged(result, code) {
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    result.changes !== 1
  ) {
    throw storeError(code);
  }
}

function preservedFullLearningKey(learnerId) {
  return `${PRESERVED_FULL_LEARNING_KEY_PREFIX}${learnerId}`;
}

async function replaceWorkingCopyWithStarter(connection, learnerId, sampledAt) {
  // Deleting an aggregate cascades into the five learning child tables, and
  // the native driver reports sqlite3_total_changes deltas, which count
  // cascaded rows — a learner with practice history legitimately reports
  // changes > 1 here. Only changes < 1 (no working copy) is a failure.
  const removed = await connection.execute(
    'DELETE FROM spelling_aggregates WHERE learner_id = ?',
    [learnerId],
  );
  if (removed.changes < 1) {
    throw storeError('sqlite_profile_learning_reset_failed');
  }
  await insertInitialSnapshot(
    connection,
    learnerId,
    sampledAt,
    STARTER_CATALOGUE_ID,
  );
}

async function insertLearningSnapshot(connection, snapshot, updatedAt) {
  requireChanged(
    await connection.execute(
      'INSERT INTO spelling_aggregates (learner_id, snapshot_schema_version, revision, pack_id, catalogue_id, granted_entitlement_ids_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        snapshot.learnerId,
        snapshot.schemaVersion,
        snapshot.revision,
        snapshot.packId,
        snapshot.catalogueId,
        canonicalJson(snapshot.grantedEntitlementIds),
        updatedAt,
      ],
    ),
    'sqlite_profile_snapshot_insert_failed',
  );
  requireChanged(
    await connection.execute(
      'INSERT INTO spelling_subject_states (learner_id, state_json) VALUES (?, ?)',
      [snapshot.learnerId, canonicalJson(snapshot.subjectState)],
    ),
    'sqlite_profile_snapshot_insert_failed',
  );
  if (snapshot.practiceSession !== null) {
    requireChanged(
      await connection.execute(
        'INSERT INTO spelling_practice_sessions (learner_id, session_id, status, state_json) VALUES (?, ?, ?, ?)',
        [
          snapshot.learnerId,
          snapshot.practiceSession.id,
          snapshot.practiceSession.status,
          canonicalJson(snapshot.practiceSession),
        ],
      ),
      'sqlite_profile_snapshot_insert_failed',
    );
  }
  for (const [sequenceNo, event] of snapshot.eventLog.entries()) {
    requireChanged(
      await connection.execute(
        'INSERT INTO spelling_events (learner_id, event_id, sequence_no, created_at, event_json) VALUES (?, ?, ?, ?, ?)',
        [
          snapshot.learnerId,
          event.id,
          sequenceNo,
          event.createdAt,
          canonicalJson(event),
        ],
      ),
      'sqlite_profile_snapshot_insert_failed',
    );
  }
  for (const [rewardTrackId, state] of Object.entries(
    snapshot.monsterStateByRewardTrackId,
  ).sort(([left], [right]) => left.localeCompare(right, 'en'))) {
    requireChanged(
      await connection.execute(
        'INSERT INTO spelling_monster_states (learner_id, reward_track_id, state_json) VALUES (?, ?, ?)',
        [snapshot.learnerId, rewardTrackId, canonicalJson(state)],
      ),
      'sqlite_profile_snapshot_insert_failed',
    );
  }
  for (const [packId, state] of Object.entries(
    snapshot.campStateByPackId,
  ).sort(([left], [right]) => left.localeCompare(right, 'en'))) {
    requireChanged(
      await connection.execute(
        'INSERT INTO spelling_camp_states (learner_id, pack_id, state_json) VALUES (?, ?, ?)',
        [snapshot.learnerId, packId, canonicalJson(state)],
      ),
      'sqlite_profile_snapshot_insert_failed',
    );
  }
}

async function retagLearner(connection, learnerId, catalogueId, sampledAt) {
  const result = await connection.execute(
    'UPDATE spelling_aggregates SET catalogue_id = ?, granted_entitlement_ids_json = ?, updated_at = ? WHERE learner_id = ?',
    [
      catalogueId,
      catalogueId === FULL_CATALOGUE_ID
        ? FULL_ENTITLEMENTS_JSON
        : EMPTY_ENTITLEMENTS_JSON,
      sampledAt,
      learnerId,
    ],
  );
  if (result.changes !== 1) {
    throw storeError('sqlite_profile_catalogue_alignment_failed');
  }
}

async function parkFullAggregate(connection, learnerId, snapshot, sampledAt) {
  requireChanged(
    await connection.execute(
      'INSERT INTO app_metadata (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
      [
        preservedFullLearningKey(learnerId),
        canonicalJson(snapshot),
        sampledAt,
      ],
    ),
    'sqlite_preserved_full_learning_write_failed',
  );
  await replaceWorkingCopyWithStarter(connection, learnerId, sampledAt);
}

async function restorePreservedFullLearning(connection, learnerId, sampledAt) {
  const rows = await connection.query(
    'SELECT value_json FROM app_metadata WHERE key = ?',
    [preservedFullLearningKey(learnerId)],
  );
  if (!Array.isArray(rows) || rows.length > 1) {
    throw storeError('sqlite_preserved_full_learning_invalid');
  }
  if (rows.length === 0) return false;
  let snapshot;
  try {
    snapshot = JSON.parse(rows[0].value_json);
  } catch (cause) {
    throw storeError('sqlite_preserved_full_learning_invalid', { cause });
  }
  if (
    !snapshot ||
    typeof snapshot !== 'object' ||
    snapshot.learnerId !== learnerId ||
    snapshot.catalogueId !== FULL_CATALOGUE_ID
  ) {
    throw storeError('sqlite_preserved_full_learning_invalid');
  }
  const removed = await connection.execute(
    'DELETE FROM spelling_aggregates WHERE learner_id = ?',
    [learnerId],
  );
  // Cascade-inclusive count: see replaceWorkingCopyWithStarter.
  if (removed.changes < 1) {
    throw storeError('sqlite_profile_learning_reset_failed');
  }
  await insertLearningSnapshot(connection, snapshot, sampledAt);
  const cleared = await connection.execute(
    'DELETE FROM app_metadata WHERE key = ?',
    [preservedFullLearningKey(learnerId)],
  );
  if (cleared.changes !== 1) {
    throw storeError('sqlite_preserved_full_learning_write_failed');
  }
  return true;
}

async function clearPreservedFullLearning(connection) {
  const result = await connection.execute(
    'DELETE FROM app_metadata WHERE key LIKE ?',
    [`${PRESERVED_FULL_LEARNING_KEY_PREFIX}%`],
  );
  if (!Number.isSafeInteger(result?.changes) || result.changes < 0) {
    throw storeError('sqlite_preserved_full_learning_write_failed');
  }
}

export async function readSQLiteSelectedLearnerId(connection) {
  assertSqlConnection(connection);
  return readSelectedLearnerIdUnchecked(connection);
}

export function createSQLiteSpellingProfileStore({
  connection,
  gate,
  now,
  initialCatalogueId = STARTER_CATALOGUE_ID,
  onRemoveLearnerMetadata = null,
} = {}) {
  assertSqlConnection(connection);
  requireGate(gate);
  if (typeof now !== 'function') {
    throw new TypeError('Profile store requires an injected now() clock.');
  }
  if (
    onRemoveLearnerMetadata !== null
    && typeof onRemoveLearnerMetadata !== 'function'
  ) {
    throw new TypeError('onRemoveLearnerMetadata must be a function or null.');
  }
  const initialCatalogue = requireCatalogueId(initialCatalogueId);

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
          await insertInitialSnapshot(
            connection,
            profile.learnerId,
            sampledAt,
            initialCatalogue,
          );
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
        // Cascade-inclusive count (see replaceWorkingCopyWithStarter):
        // removing a learner with history reports every cascaded row, so any
        // changes >= 1 means the profile row itself was removed.
        const removedProfile = result.changes >= 1;
        if (!removedProfile) return false;
        if (onRemoveLearnerMetadata) {
          await onRemoveLearnerMetadata(connection, learnerId);
        }
        if (selectedLearnerId !== learnerId) {
          return true;
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
        // Cascade-inclusive count: see replaceWorkingCopyWithStarter.
        if (removed.changes < 1) {
          throw storeError('sqlite_profile_learning_reset_failed');
        }
        await insertInitialSnapshot(
          connection,
          learnerId,
          sampledAt,
          initialCatalogue,
        );
        return true;
      }));
    },
    /**
     * E2.7b, replacing the E2.5 unconditional reset. The working catalogue is
     * Full only while the commerce snapshot is active+installed; otherwise it
     * is Starter. Both identity columns move together because Guardian and
     * Camp read the grant off the snapshot.
     *
     * A lossless retag (Starter ⊂ Full, or Full that has never left Starter
     * words) keeps the row. A Full aggregate that cannot be shown under
     * Starter is parked when the device earned the product or when an import
     * asked us to preserve it, and wiped only as unpaid pre-E2.5 residue.
     *
     * @returns {Promise<string>} the catalogue the app should compose.
     */
    async alignCatalogueLearning({
      entitled,
      earned = false,
      preserveUnentitledFull = false,
      canRepresent,
      readSnapshot,
    } = {}) {
      if (typeof entitled !== 'boolean') {
        throw new TypeError('Catalogue alignment requires an entitled boolean.');
      }
      if (typeof earned !== 'boolean') {
        throw new TypeError('Catalogue alignment requires an earned boolean.');
      }
      if (typeof preserveUnentitledFull !== 'boolean') {
        throw new TypeError(
          'Catalogue alignment requires a preserveUnentitledFull boolean.',
        );
      }
      if (typeof canRepresent !== 'function') {
        throw new TypeError('Catalogue alignment requires canRepresent().');
      }
      if (typeof readSnapshot !== 'function') {
        throw new TypeError('Catalogue alignment requires readSnapshot().');
      }
      const target = entitled ? FULL_CATALOGUE_ID : STARTER_CATALOGUE_ID;
      const sampledAt = sampleTimestamp(now);
      return gate.run(() => runOwnedTransaction(connection, async () => {
        if (preserveUnentitledFull) {
          await clearPreservedFullLearning(connection);
        }
        const rows = await connection.query(
          'SELECT learner_id, catalogue_id FROM spelling_aggregates ORDER BY learner_id',
        );
        if (!Array.isArray(rows)) throw storeError('sqlite_profile_rows_invalid');
        if (entitled) {
          for (const row of rows) {
            const learnerId = requireLearnerId(row?.learner_id);
            await restorePreservedFullLearning(connection, learnerId, sampledAt);
          }
          const afterRestore = await connection.query(
            'SELECT learner_id, catalogue_id FROM spelling_aggregates ORDER BY learner_id',
          );
          if (!Array.isArray(afterRestore)) {
            throw storeError('sqlite_profile_rows_invalid');
          }
          for (const row of afterRestore) {
            const learnerId = requireLearnerId(row?.learner_id);
            if (requireCatalogueId(row?.catalogue_id) === FULL_CATALOGUE_ID) {
              await retagLearner(
                connection,
                learnerId,
                FULL_CATALOGUE_ID,
                sampledAt,
              );
              continue;
            }
            if ((await canRepresent(learnerId, FULL_CATALOGUE_ID)) !== true) {
              throw storeError('sqlite_profile_catalogue_alignment_failed');
            }
            await retagLearner(
              connection,
              learnerId,
              FULL_CATALOGUE_ID,
              sampledAt,
            );
          }
          return target;
        }
        for (const row of rows) {
          const learnerId = requireLearnerId(row?.learner_id);
          if (requireCatalogueId(row?.catalogue_id) === STARTER_CATALOGUE_ID) {
            continue;
          }
          if ((await canRepresent(learnerId, STARTER_CATALOGUE_ID)) === true) {
            await retagLearner(
              connection,
              learnerId,
              STARTER_CATALOGUE_ID,
              sampledAt,
            );
            continue;
          }
          if (earned || preserveUnentitledFull) {
            await parkFullAggregate(
              connection,
              learnerId,
              await readSnapshot(learnerId),
              sampledAt,
            );
            continue;
          }
          await replaceWorkingCopyWithStarter(connection, learnerId, sampledAt);
        }
        return target;
      }));
    },
    async applyReplicaResult({ working, preserved } = {}) {
      if (!working || typeof working !== 'object' || Array.isArray(working)) {
        throw new TypeError('Replica apply requires a working snapshot.');
      }
      const learnerId = requireLearnerId(working.learnerId);
      if (
        preserved != null
        && (
          typeof preserved !== 'object'
          || Array.isArray(preserved)
          || preserved.learnerId !== learnerId
        )
      ) {
        throw new TypeError('Replica preserved snapshot must belong to the working learner.');
      }
      const sampledAt = sampleTimestamp(now);
      return gate.run(() => runOwnedTransaction(connection, async () => {
        if ((await queryProfile(connection, learnerId)) === null) {
          throw storeError('sqlite_profile_missing');
        }
        if (preserved) {
          requireChanged(
            await connection.execute(
              'INSERT INTO app_metadata (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
              [
                preservedFullLearningKey(learnerId),
                canonicalJson(preserved),
                sampledAt,
              ],
            ),
            'sqlite_preserved_full_learning_write_failed',
          );
        }
        const removed = await connection.execute(
          'DELETE FROM spelling_aggregates WHERE learner_id = ?',
          [learnerId],
        );
        if (removed.changes < 1) {
          throw storeError('sqlite_profile_learning_reset_failed');
        }
        await insertLearningSnapshot(connection, working, sampledAt);
        return working.catalogueId;
      }));
    },
  });

  return Object.freeze({ profiles, selection, administration });
}
