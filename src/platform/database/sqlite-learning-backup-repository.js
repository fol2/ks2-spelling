import {
  createLearningBackupCodec,
} from '../../domain/security/learning-backup-contract.js';
import {
  validateSpellingProfile,
} from '../../domain/spelling/profile-contract.js';
import { canonicalJson } from './canonical-json.js';
import { assertSqlConnection } from './sql-connection-contract.js';
import {
  PRODUCT_SELECTED_LEARNER_KEY,
  readSQLiteSelectedLearnerId,
} from './sqlite-spelling-profile-store.js';
import {
  createSQLiteSpellingSnapshotStore,
} from './sqlite-spelling-snapshot-store.js';
import { runOwnedTransaction } from './sqlite-transaction-runner.js';

function repositoryError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireGate(gate) {
  if (!gate || typeof gate !== 'object' || typeof gate.run !== 'function') {
    throw new TypeError('Learning backup repository requires a command gate.');
  }
  return gate;
}

function sampleTimestamp(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Learning backup clock must return a safe timestamp.');
  }
  return value;
}

function requireChanged(result, label) {
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    Reflect.ownKeys(result).length !== 1 ||
    result.changes !== 1
  ) {
    throw repositoryError(
      'learning_backup_write_failed',
      `${label} did not change exactly one row.`,
    );
  }
}

function profileFromRow(row) {
  if (
    !row ||
    typeof row !== 'object' ||
    Array.isArray(row) ||
    Reflect.ownKeys(row).length !== 7
  ) {
    throw repositoryError('learning_backup_profile_invalid');
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

async function insertProfile(connection, profile) {
  requireChanged(
    await connection.execute(
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
    ),
    'Learning backup profile insert',
  );
}

async function insertSnapshot(connection, snapshot, updatedAt) {
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
    'Learning backup aggregate insert',
  );
  requireChanged(
    await connection.execute(
      'INSERT INTO spelling_subject_states (learner_id, state_json) VALUES (?, ?)',
      [snapshot.learnerId, canonicalJson(snapshot.subjectState)],
    ),
    'Learning backup subject insert',
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
      'Learning backup practice insert',
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
      'Learning backup event insert',
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
      'Learning backup Monster insert',
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
      'Learning backup Camp insert',
    );
  }
}

async function replaceSelectedLearner(connection, learnerId, updatedAt) {
  if (learnerId === null) {
    const result = await connection.execute(
      'DELETE FROM app_metadata WHERE key = ?',
      [PRODUCT_SELECTED_LEARNER_KEY],
    );
    if (![0, 1].includes(result?.changes)) {
      throw repositoryError('learning_backup_write_failed');
    }
    return;
  }
  requireChanged(
    await connection.execute(
      'INSERT INTO app_metadata (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
      [
        PRODUCT_SELECTED_LEARNER_KEY,
        canonicalJson({ learnerId }),
        updatedAt,
      ],
    ),
    'Learning backup selected learner write',
  );
}

export function createSQLiteLearningBackupRepository({
  connection,
  gate,
  cataloguesById,
  now,
  maximumBytes,
} = {}) {
  assertSqlConnection(connection);
  requireGate(gate);
  if (typeof now !== 'function') {
    throw new TypeError('Learning backup repository requires now().');
  }
  const codec = createLearningBackupCodec({ cataloguesById, maximumBytes });
  const snapshots = createSQLiteSpellingSnapshotStore({
    connection,
    cataloguesById,
  });

  return Object.freeze({
    exportBackup() {
      const exportedAt = sampleTimestamp(now);
      return gate.run(() => runOwnedTransaction(connection, async () => {
        const rows = await connection.query(
          'SELECT learner_id, nickname, year_group, goal, colour, created_at, updated_at FROM learner_profiles ORDER BY learner_id',
        );
        if (!Array.isArray(rows)) {
          throw repositoryError('learning_backup_profile_invalid');
        }
        const learners = [];
        for (const row of rows) {
          const profile = profileFromRow(row);
          learners.push({
            profile,
            snapshot: await snapshots.read(profile.learnerId),
          });
        }
        return codec.encode({
          exportedAt,
          selectedLearnerId: await readSQLiteSelectedLearnerId(connection),
          learners,
        });
      }));
    },
    importBackup(bytes) {
      const backup = codec.decode(bytes);
      const importedAt = sampleTimestamp(now);
      return gate.run(() => runOwnedTransaction(connection, async () => {
        const deleted = await connection.execute('DELETE FROM learner_profiles');
        if (!Number.isSafeInteger(deleted?.changes) || deleted.changes < 0) {
          throw repositoryError('learning_backup_write_failed');
        }
        for (const learner of backup.learners) {
          await insertProfile(connection, learner.profile);
          await insertSnapshot(connection, learner.snapshot, importedAt);
        }
        await replaceSelectedLearner(
          connection,
          backup.selectedLearnerId,
          importedAt,
        );
        return Object.freeze({
          learnerCount: backup.learners.length,
          selectedLearnerId: backup.selectedLearnerId,
        });
      }));
    },
  });
}
