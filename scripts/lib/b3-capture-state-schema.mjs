import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const B3_CAPTURE_STATE_APPLICATION_ID = 0x4b533342;
export const B3_CAPTURE_STATE_SCHEMA_VERSION = 2;

const HASH_CHECK = (column, length) =>
  `length(${column}) = ${length} AND ${column} NOT GLOB '*[^0-9a-f]*'`;
const BLOB_CHECK = (column) =>
  `typeof(${column}) = 'blob' AND length(${column}) BETWEEN 1 AND 131072`;
const UUID_CHECK = (column) =>
  `length(${column}) = 36 AND ${column} GLOB ` +
  "'????????-????-4???-[89ab]???-????????????' AND " +
  `${column} NOT GLOB '*[^0-9a-f-]*'`;

const ORDINARY_TRANSITIONS = Object.freeze([
  ['prepared', 'launching'],
  ['prepared', 'stop-intent'],
  ['stop-intent', 'stop-executing'],
  ['stop-executing', 'host-stopped'],
  ['host-stopped', 'launching'],
  ['launching', 'launched'],
  ['launching', 'reinstall-authorised'],
  ['launching', 'restart-required'],
  ['reinstall-launching', 'restart-required'],
  ['restart-required', 'launched'],
  ['reinstall-authorised', 'reinstall-launching'],
  ['reinstall-launching', 'launched'],
]);
const GENERIC_STATES = Object.freeze([
  'prepared',
  'stop-intent',
  'stop-executing',
  'host-stopped',
  'launching',
  'reinstall-authorised',
  'reinstall-launching',
  'launched',
]);
const quoted = (value) => `'${value}'`;
const ordinaryCheck = ORDINARY_TRANSITIONS.map(([source, next]) =>
  `(source_state = ${quoted(source)} AND next_state = ${quoted(next)})`).join(' OR ');
const genericCheck = GENERIC_STATES.map(quoted).join(', ');

export const B3_CAPTURE_STATE_SCHEMA_SQL = `
CREATE TABLE b3_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 2),
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  tested_application_commit TEXT NOT NULL CHECK (${HASH_CHECK('tested_application_commit', 40)}),
  application_fingerprint TEXT NOT NULL CHECK (${HASH_CHECK('application_fingerprint', 64)}),
  schema_sha256 TEXT NOT NULL CHECK (${HASH_CHECK('schema_sha256', 64)})
) STRICT, WITHOUT ROWID;

CREATE TABLE b3_capture_start_intents (
  start_intent_sha256 TEXT PRIMARY KEY CHECK (${HASH_CHECK('start_intent_sha256', 64)}),
  intent_kind TEXT NOT NULL CHECK (intent_kind IN ('initial', 'recovery-fresh')),
  recovered_command_sha256 TEXT NULL CHECK (recovered_command_sha256 IS NULL OR ${HASH_CHECK('recovered_command_sha256', 64)}),
  terminal_claim_sha256 TEXT NULL CHECK (terminal_claim_sha256 IS NULL OR ${HASH_CHECK('terminal_claim_sha256', 64)}),
  capture_id TEXT UNIQUE NOT NULL CHECK (${UUID_CHECK('capture_id')}),
  first_command_sha256 TEXT UNIQUE NOT NULL CHECK (${HASH_CHECK('first_command_sha256', 64)}),
  first_command_json BLOB NOT NULL CHECK (${BLOB_CHECK('first_command_json')}),
  first_prepared_record_json BLOB NOT NULL CHECK (${BLOB_CHECK('first_prepared_record_json')}),
  first_prepared_record_sha256 TEXT NOT NULL CHECK (${HASH_CHECK('first_prepared_record_sha256', 64)}),
  intent_state TEXT NOT NULL CHECK (intent_state IN ('pending', 'ready')),
  row_version INTEGER NOT NULL CHECK (row_version > 0),
  CHECK (
    (intent_kind = 'initial' AND recovered_command_sha256 IS NULL AND terminal_claim_sha256 IS NULL) OR
    (intent_kind = 'recovery-fresh' AND recovered_command_sha256 IS NOT NULL AND terminal_claim_sha256 IS NOT NULL)
  ),
  FOREIGN KEY (recovered_command_sha256, terminal_claim_sha256)
    REFERENCES b3_recovery_terminals(command_sha256, terminal_claim_sha256)
) STRICT, WITHOUT ROWID;

CREATE UNIQUE INDEX b3_capture_start_one_pending
  ON b3_capture_start_intents ((1)) WHERE intent_state = 'pending';

CREATE TABLE b3_captures (
  capture_id TEXT PRIMARY KEY CHECK (${UUID_CHECK('capture_id')}),
  start_intent_sha256 TEXT UNIQUE NOT NULL
    REFERENCES b3_capture_start_intents(start_intent_sha256),
  capture_state TEXT NOT NULL CHECK (capture_state IN ('working', 'abandoned')),
  row_version INTEGER NOT NULL CHECK (row_version > 0)
) STRICT, WITHOUT ROWID;

CREATE TABLE b3_commands (
  command_sha256 TEXT PRIMARY KEY CHECK (${HASH_CHECK('command_sha256', 64)}),
  allocation_sequence INTEGER UNIQUE NOT NULL CHECK (allocation_sequence > 0),
  predecessor_command_sha256 TEXT UNIQUE NULL
    REFERENCES b3_commands(command_sha256),
  command_json BLOB NOT NULL CHECK (${BLOB_CHECK('command_json')}),
  prepared_record_json BLOB NOT NULL CHECK (${BLOB_CHECK('prepared_record_json')}),
  prepared_record_sha256 TEXT NOT NULL CHECK (${HASH_CHECK('prepared_record_sha256', 64)}),
  capture_id TEXT NOT NULL REFERENCES b3_captures(capture_id),
  expected_observation_sequence INTEGER NOT NULL
    CHECK (expected_observation_sequence BETWEEN 1 AND 512),
  previous_observation_sha256 TEXT NOT NULL CHECK (${HASH_CHECK('previous_observation_sha256', 64)}),
  UNIQUE (command_sha256, capture_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE b3_capture_steps (
  capture_id TEXT NOT NULL REFERENCES b3_captures(capture_id),
  observation_sequence INTEGER NOT NULL
    CHECK (observation_sequence BETWEEN 1 AND 512),
  command_sha256 TEXT UNIQUE NOT NULL CHECK (${HASH_CHECK('command_sha256', 64)}),
  record_json BLOB NOT NULL CHECK (${BLOB_CHECK('record_json')}),
  record_sha256 TEXT NOT NULL CHECK (${HASH_CHECK('record_sha256', 64)}),
  observation_sha256 TEXT NOT NULL CHECK (${HASH_CHECK('observation_sha256', 64)}),
  checkpoint_json BLOB NOT NULL CHECK (${BLOB_CHECK('checkpoint_json')}),
  checkpoint_sha256 TEXT NOT NULL CHECK (${HASH_CHECK('checkpoint_sha256', 64)}),
  PRIMARY KEY (capture_id, observation_sequence),
  FOREIGN KEY (command_sha256, capture_id)
    REFERENCES b3_commands(command_sha256, capture_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE b3_decisions (
  command_sha256 TEXT NOT NULL REFERENCES b3_commands(command_sha256),
  source_state TEXT NOT NULL,
  source_record_sha256 TEXT NOT NULL CHECK (${HASH_CHECK('source_record_sha256', 64)}),
  winner_kind TEXT NOT NULL CHECK (winner_kind IN (
    'ordinary', 'generic-consumption', 'recovery-owner', 'recovery-terminal'
  )),
  next_state TEXT NULL,
  next_record_json BLOB NULL CHECK (next_record_json IS NULL OR ${BLOB_CHECK('next_record_json')}),
  next_record_sha256 TEXT NULL CHECK (next_record_sha256 IS NULL OR ${HASH_CHECK('next_record_sha256', 64)}),
  claim_json BLOB NOT NULL CHECK (${BLOB_CHECK('claim_json')}),
  claim_sha256 TEXT NOT NULL CHECK (${HASH_CHECK('claim_sha256', 64)}),
  PRIMARY KEY (command_sha256, source_state),
  UNIQUE (command_sha256, winner_kind, claim_sha256),
  UNIQUE (
    command_sha256, winner_kind, next_record_sha256, claim_sha256
  ),
  CHECK (
    (winner_kind = 'ordinary' AND (${ordinaryCheck}) AND
      next_record_json IS NOT NULL AND next_record_sha256 IS NOT NULL) OR
    (winner_kind = 'generic-consumption' AND source_state IN (${genericCheck}) AND
      next_state IS NULL AND next_record_json IS NULL AND next_record_sha256 IS NULL) OR
    (winner_kind = 'recovery-owner' AND source_state = 'restart-required' AND
      next_state = 'restart-executing' AND next_record_json IS NOT NULL AND
      next_record_sha256 IS NOT NULL) OR
    (winner_kind = 'recovery-terminal' AND source_state = 'restart-executing' AND
      next_state = 'restart-complete' AND next_record_json IS NOT NULL AND
      next_record_sha256 IS NOT NULL)
  )
) STRICT, WITHOUT ROWID;

CREATE TABLE b3_recoveries (
  command_sha256 TEXT PRIMARY KEY CHECK (${HASH_CHECK('command_sha256', 64)}),
  owner_kind TEXT NOT NULL CHECK (owner_kind = 'recovery-owner'),
  owner_claim_sha256 TEXT NOT NULL CHECK (${HASH_CHECK('owner_claim_sha256', 64)}),
  capture_id TEXT UNIQUE NOT NULL CHECK (${UUID_CHECK('capture_id')}),
  capture_snapshot_sha256 TEXT NOT NULL CHECK (${HASH_CHECK('capture_snapshot_sha256', 64)}),
  row_version INTEGER NOT NULL CHECK (row_version = 1),
  FOREIGN KEY (command_sha256, owner_kind, owner_claim_sha256)
    REFERENCES b3_decisions(command_sha256, winner_kind, claim_sha256),
  FOREIGN KEY (command_sha256, capture_id)
    REFERENCES b3_commands(command_sha256, capture_id),
  UNIQUE (command_sha256, owner_claim_sha256, capture_snapshot_sha256)
) STRICT, WITHOUT ROWID;

CREATE TABLE b3_recovery_manifests (
  command_sha256 TEXT PRIMARY KEY CHECK (${HASH_CHECK('command_sha256', 64)}),
  owner_claim_sha256 TEXT NOT NULL CHECK (${HASH_CHECK('owner_claim_sha256', 64)}),
  capture_snapshot_sha256 TEXT NOT NULL CHECK (${HASH_CHECK('capture_snapshot_sha256', 64)}),
  manifest_json BLOB NOT NULL CHECK (${BLOB_CHECK('manifest_json')}),
  manifest_sha256 TEXT NOT NULL CHECK (${HASH_CHECK('manifest_sha256', 64)}),
  FOREIGN KEY (command_sha256, owner_claim_sha256, capture_snapshot_sha256)
    REFERENCES b3_recoveries(
      command_sha256, owner_claim_sha256, capture_snapshot_sha256
    ),
  UNIQUE (
    command_sha256, owner_claim_sha256, capture_snapshot_sha256, manifest_sha256
  )
) STRICT, WITHOUT ROWID;

CREATE TABLE b3_recovery_authorities (
  command_sha256 TEXT PRIMARY KEY CHECK (${HASH_CHECK('command_sha256', 64)}),
  owner_claim_sha256 TEXT NOT NULL CHECK (${HASH_CHECK('owner_claim_sha256', 64)}),
  capture_snapshot_sha256 TEXT NOT NULL CHECK (${HASH_CHECK('capture_snapshot_sha256', 64)}),
  manifest_sha256 TEXT NOT NULL CHECK (${HASH_CHECK('manifest_sha256', 64)}),
  authority_json BLOB NOT NULL CHECK (${BLOB_CHECK('authority_json')}),
  authority_sha256 TEXT NOT NULL CHECK (${HASH_CHECK('authority_sha256', 64)}),
  FOREIGN KEY (
    command_sha256, owner_claim_sha256, capture_snapshot_sha256, manifest_sha256
  )
    REFERENCES b3_recovery_manifests(
      command_sha256, owner_claim_sha256, capture_snapshot_sha256, manifest_sha256
    ),
  UNIQUE (
    command_sha256, owner_claim_sha256, capture_snapshot_sha256,
    manifest_sha256, authority_sha256
  )
) STRICT, WITHOUT ROWID;

CREATE TABLE b3_recovery_terminals (
  command_sha256 TEXT PRIMARY KEY CHECK (${HASH_CHECK('command_sha256', 64)}),
  owner_claim_sha256 TEXT NOT NULL CHECK (${HASH_CHECK('owner_claim_sha256', 64)}),
  capture_snapshot_sha256 TEXT NOT NULL CHECK (${HASH_CHECK('capture_snapshot_sha256', 64)}),
  manifest_sha256 TEXT NOT NULL CHECK (${HASH_CHECK('manifest_sha256', 64)}),
  authority_sha256 TEXT NOT NULL CHECK (${HASH_CHECK('authority_sha256', 64)}),
  terminal_kind TEXT NOT NULL CHECK (terminal_kind = 'recovery-terminal'),
  terminal_record_json BLOB NOT NULL CHECK (${BLOB_CHECK('terminal_record_json')}),
  terminal_record_sha256 TEXT NOT NULL CHECK (${HASH_CHECK('terminal_record_sha256', 64)}),
  terminal_claim_json BLOB NOT NULL CHECK (${BLOB_CHECK('terminal_claim_json')}),
  terminal_claim_sha256 TEXT NOT NULL CHECK (${HASH_CHECK('terminal_claim_sha256', 64)}),
  FOREIGN KEY (
    command_sha256, owner_claim_sha256, capture_snapshot_sha256,
    manifest_sha256, authority_sha256
  )
    REFERENCES b3_recovery_authorities(
      command_sha256, owner_claim_sha256, capture_snapshot_sha256,
      manifest_sha256, authority_sha256
    ),
  FOREIGN KEY (
    command_sha256, terminal_kind,
    terminal_record_sha256, terminal_claim_sha256
  )
    REFERENCES b3_decisions(
      command_sha256, winner_kind,
      next_record_sha256, claim_sha256
    ),
  UNIQUE (command_sha256, terminal_claim_sha256)
) STRICT, WITHOUT ROWID;

CREATE TABLE b3_authority_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  next_allocation_sequence INTEGER NOT NULL CHECK (next_allocation_sequence > 0),
  active_command_sha256 TEXT NULL REFERENCES b3_commands(command_sha256),
  reserved_start_command_sha256 TEXT NULL
    REFERENCES b3_capture_start_intents(first_command_sha256),
  row_version INTEGER NOT NULL CHECK (row_version > 0),
  CHECK (active_command_sha256 IS NULL OR reserved_start_command_sha256 IS NULL)
) STRICT, WITHOUT ROWID;
`.trim();

const schemaDatabase = new DatabaseSync(':memory:');
schemaDatabase.exec(B3_CAPTURE_STATE_SCHEMA_SQL);
export const B3_CAPTURE_STATE_SCHEMA_OBJECTS = Object.freeze(
  schemaDatabase.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all().map((row) => Object.freeze({ ...row })),
);
schemaDatabase.close();

export const B3_CAPTURE_STATE_SCHEMA_SHA256 = createHash('sha256')
  .update(Buffer.from(JSON.stringify(B3_CAPTURE_STATE_SCHEMA_OBJECTS), 'utf8'))
  .digest('hex');
