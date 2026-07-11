export const DATABASE_NAME = 'ks2-spelling';
export const SCHEMA_VERSION = 1;

export const SCHEMA_V1_STATEMENTS = Object.freeze([
  'CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL CHECK (updated_at >= 0)) WITHOUT ROWID;',
  "CREATE TABLE learner_profiles (learner_id TEXT PRIMARY KEY, nickname TEXT NOT NULL, year_group TEXT NOT NULL, goal INTEGER NOT NULL CHECK (goal >= 0), colour TEXT NOT NULL, created_at INTEGER NOT NULL CHECK (created_at >= 0), updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)) WITHOUT ROWID;",
  'CREATE TABLE spelling_aggregates (learner_id TEXT PRIMARY KEY REFERENCES learner_profiles(learner_id) ON DELETE CASCADE, snapshot_schema_version INTEGER NOT NULL CHECK (snapshot_schema_version = 1), revision INTEGER NOT NULL CHECK (revision >= 0), pack_id TEXT NOT NULL, catalogue_id TEXT NOT NULL, granted_entitlement_ids_json TEXT NOT NULL, updated_at INTEGER NOT NULL CHECK (updated_at >= 0)) WITHOUT ROWID;',
  'CREATE TABLE spelling_subject_states (learner_id TEXT PRIMARY KEY REFERENCES spelling_aggregates(learner_id) ON DELETE CASCADE, state_json TEXT NOT NULL) WITHOUT ROWID;',
  "CREATE TABLE spelling_practice_sessions (learner_id TEXT PRIMARY KEY REFERENCES spelling_aggregates(learner_id) ON DELETE CASCADE, session_id TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'abandoned')), state_json TEXT NOT NULL) WITHOUT ROWID;",
  'CREATE TABLE spelling_events (learner_id TEXT NOT NULL REFERENCES spelling_aggregates(learner_id) ON DELETE CASCADE, event_id TEXT NOT NULL, sequence_no INTEGER NOT NULL CHECK (sequence_no >= 0), created_at INTEGER NOT NULL CHECK (created_at >= 0), event_json TEXT NOT NULL, PRIMARY KEY (learner_id, event_id), UNIQUE (learner_id, sequence_no)) WITHOUT ROWID;',
  'CREATE TABLE spelling_monster_states (learner_id TEXT NOT NULL REFERENCES spelling_aggregates(learner_id) ON DELETE CASCADE, reward_track_id TEXT NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY (learner_id, reward_track_id)) WITHOUT ROWID;',
  'CREATE TABLE spelling_camp_states (learner_id TEXT NOT NULL REFERENCES spelling_aggregates(learner_id) ON DELETE CASCADE, pack_id TEXT NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY (learner_id, pack_id)) WITHOUT ROWID;',
]);
