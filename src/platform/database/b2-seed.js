import { canonicalJson } from './canonical-json.js';
import { assertSqlConnection } from './sql-connection-contract.js';

const B2_SEED_TIMESTAMP = 1_768_478_400_000;
const B2_SEED_METADATA_KEY = 'b2-seed-v1';
const B2_LEARNERS = Object.freeze([
  Object.freeze({
    learnerId: 'learner-a',
    nickname: 'Ada',
    yearGroup: 'Y3',
    goal: 10,
    colour: '#2E7D8A',
    createdAt: B2_SEED_TIMESTAMP,
    updatedAt: B2_SEED_TIMESTAMP,
  }),
  Object.freeze({
    learnerId: 'learner-b',
    nickname: 'Ben',
    yearGroup: 'Y5',
    goal: 10,
    colour: '#A7633B',
    createdAt: B2_SEED_TIMESTAMP,
    updatedAt: B2_SEED_TIMESTAMP,
  }),
]);

const INITIAL_SUBJECT_STATE = Object.freeze({
  ui: Object.freeze({}),
  data: Object.freeze({
    prefs: Object.freeze({ autoSpeak: false }),
    progress: Object.freeze({}),
    guardianMap: Object.freeze({}),
    pattern: Object.freeze({ wobblingByRuntimeItemId: Object.freeze({}) }),
    postMega: null,
    achievements: Object.freeze({}),
    persistenceWarning: null,
  }),
});

const EMPTY_ENTITLEMENTS_JSON = canonicalJson([]);
const INITIAL_SUBJECT_STATE_JSON = canonicalJson(INITIAL_SUBJECT_STATE);
const SEED_METADATA_JSON = canonicalJson({
  learnerIds: B2_LEARNERS.map(({ learnerId }) => learnerId),
  snapshot: {
    schemaVersion: 1,
    revision: 0,
    packId: 'ks2-core',
    catalogueId: 'ks2-core:starter',
    grantedEntitlementIds: [],
    subjectState: INITIAL_SUBJECT_STATE,
    practiceSession: null,
    eventLog: [],
    monsterStateByRewardTrackId: {},
    campStateByPackId: {},
  },
});

function seedError(message) {
  const error = new Error(`B2 seed drift: ${message}.`);
  error.code = 'sqlite_b2_seed_drift';
  return error;
}

function exactSingleRow(rows, label) {
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0]) {
    throw seedError(`${label} does not contain exactly one row`);
  }
  return rows[0];
}

function learnerDatabaseRow(learner) {
  return {
    learner_id: learner.learnerId,
    nickname: learner.nickname,
    year_group: learner.yearGroup,
    goal: learner.goal,
    colour: learner.colour,
    created_at: learner.createdAt,
    updated_at: learner.updatedAt,
  };
}

function assertCanonicalJsonBytes(bytes, expected, label) {
  if (bytes !== expected) throw seedError(`${label} JSON bytes changed`);
}

function parseCanonicalSeedJson(bytes, label) {
  if (typeof bytes !== 'string') throw seedError(`${label} JSON bytes are missing`);
  let value;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw seedError(`${label} JSON bytes are invalid`);
  }
  let encoded;
  try {
    encoded = canonicalJson(value);
  } catch {
    throw seedError(`${label} JSON value is unsupported`);
  }
  if (encoded !== bytes) throw seedError(`${label} JSON bytes are not canonical`);
  return value;
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function assertMetadata(connection) {
  const row = exactSingleRow(
    await connection.query(
      'SELECT key, value_json, updated_at FROM app_metadata WHERE key = ?',
      [B2_SEED_METADATA_KEY],
    ),
    'metadata',
  );
  if (
    row.key !== B2_SEED_METADATA_KEY ||
    row.value_json !== SEED_METADATA_JSON ||
    row.updated_at !== B2_SEED_TIMESTAMP
  ) {
    throw seedError('metadata bytes changed');
  }
}

async function assertImmutableLearnerRows(connection, learner) {
  const profile = exactSingleRow(
    await connection.query(
      'SELECT learner_id, nickname, year_group, goal, colour, created_at, updated_at FROM learner_profiles WHERE learner_id = ?',
      [learner.learnerId],
    ),
    `profile ${learner.learnerId}`,
  );
  if (canonicalJson(profile) !== canonicalJson(learnerDatabaseRow(learner))) {
    throw seedError(`profile ${learner.learnerId} bytes changed`);
  }

  const aggregate = exactSingleRow(
    await connection.query(
      'SELECT learner_id, snapshot_schema_version, revision, pack_id, catalogue_id, granted_entitlement_ids_json, updated_at FROM spelling_aggregates WHERE learner_id = ?',
      [learner.learnerId],
    ),
    `aggregate ${learner.learnerId}`,
  );
  if (
    aggregate.learner_id !== learner.learnerId ||
    aggregate.snapshot_schema_version !== 1 ||
    !Number.isSafeInteger(aggregate.revision) ||
    aggregate.revision < 0 ||
    aggregate.pack_id !== 'ks2-core' ||
    aggregate.catalogue_id !== 'ks2-core:starter' ||
    !Number.isSafeInteger(aggregate.updated_at) ||
    aggregate.updated_at < 0
  ) {
    throw seedError(`aggregate ${learner.learnerId} identity changed`);
  }
  assertCanonicalJsonBytes(
    aggregate.granted_entitlement_ids_json,
    EMPTY_ENTITLEMENTS_JSON,
    `aggregate ${learner.learnerId} entitlement`,
  );
  return aggregate;
}

async function assertSubjectState(connection, learnerId, revision) {
  const row = exactSingleRow(
    await connection.query(
      'SELECT learner_id, state_json FROM spelling_subject_states WHERE learner_id = ?',
      [learnerId],
    ),
    `subject ${learnerId}`,
  );
  if (row.learner_id !== learnerId) throw seedError(`subject ${learnerId} ownership changed`);
  if (revision === 0) {
    assertCanonicalJsonBytes(
      row.state_json,
      INITIAL_SUBJECT_STATE_JSON,
      `subject ${learnerId}`,
    );
    return;
  }

  const value = parseCanonicalSeedJson(row.state_json, `subject ${learnerId}`);
  if (
    !isPlainRecord(value) ||
    Reflect.ownKeys(value).length !== 2 ||
    !Object.hasOwn(value, 'ui') ||
    !Object.hasOwn(value, 'data') ||
    !isPlainRecord(value.ui) ||
    !isPlainRecord(value.data)
  ) {
    throw seedError(`subject ${learnerId} envelope is invalid`);
  }
}

async function assertNoMutableRows(connection, learnerId) {
  const tables = [
    'spelling_practice_sessions',
    'spelling_events',
    'spelling_monster_states',
    'spelling_camp_states',
  ];
  for (const table of tables) {
    const rows = await connection.query(
      `SELECT learner_id FROM ${table} WHERE learner_id = ?`,
      [learnerId],
    );
    if (!Array.isArray(rows) || rows.length !== 0) {
      throw seedError(`${table} contains revision-zero rows for ${learnerId}`);
    }
  }
}

async function insertInitialLearner(connection, learner) {
  const profileResult = await connection.execute(
    'INSERT OR IGNORE INTO learner_profiles (learner_id, nickname, year_group, goal, colour, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      learner.learnerId,
      learner.nickname,
      learner.yearGroup,
      learner.goal,
      learner.colour,
      learner.createdAt,
      learner.updatedAt,
    ],
  );
  if (profileResult.changes === 0) return;
  if (profileResult.changes !== 1) throw seedError('profile insert count is invalid');

  await connection.execute(
    'INSERT INTO spelling_aggregates (learner_id, snapshot_schema_version, revision, pack_id, catalogue_id, granted_entitlement_ids_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      learner.learnerId,
      1,
      0,
      'ks2-core',
      'ks2-core:starter',
      EMPTY_ENTITLEMENTS_JSON,
      learner.updatedAt,
    ],
  );
  await connection.execute(
    'INSERT INTO spelling_subject_states (learner_id, state_json) VALUES (?, ?)',
    [learner.learnerId, INITIAL_SUBJECT_STATE_JSON],
  );
}

async function rollbackSeed(connection, originalError) {
  try {
    if (await connection.isTransactionActive()) await connection.rollback();
  } catch (rollbackError) {
    originalError.cause = rollbackError;
  }
  throw originalError;
}

export async function seedB2Learners(connection) {
  assertSqlConnection(connection);
  if ((await connection.isTransactionActive()) !== false) {
    throw new Error('B2 seed requires an idle database connection.');
  }
  try {
    await connection.begin();
    await connection.execute(
      'INSERT OR IGNORE INTO app_metadata (key, value_json, updated_at) VALUES (?, ?, ?)',
      [B2_SEED_METADATA_KEY, SEED_METADATA_JSON, B2_SEED_TIMESTAMP],
    );
    await assertMetadata(connection);

    for (const learner of B2_LEARNERS) {
      await insertInitialLearner(connection, learner);
      const aggregate = await assertImmutableLearnerRows(connection, learner);
      await assertSubjectState(connection, learner.learnerId, aggregate.revision);
      if (aggregate.revision === 0) {
        if (aggregate.updated_at !== learner.updatedAt) {
          throw seedError(`aggregate ${learner.learnerId} timestamp changed`);
        }
        await assertNoMutableRows(connection, learner.learnerId);
      }
    }
    await connection.commit();
  } catch (error) {
    await rollbackSeed(connection, error);
  }
}
