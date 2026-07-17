import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { constants as sqliteConstants, DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';

import { canonicaliseB3ProofValue } from '../../src/app/b3-live-proof-protocol.js';
import { readB3BuildAuthoritySource } from './b3-build-authority-source.mjs';
import {
  B3_CAPTURE_STATE_APPLICATION_ID,
  B3_CAPTURE_STATE_SCHEMA_OBJECTS,
  B3_CAPTURE_STATE_SCHEMA_SHA256,
  B3_CAPTURE_STATE_SCHEMA_SQL,
  B3_CAPTURE_STATE_SCHEMA_VERSION,
} from './b3-capture-state-schema.mjs';
import { B3_CAPTURE_STATE_REPOSITORY_ROOT } from './b3-capture-state-location.mjs';
import {
  validateB3PendingInitialCaptureStartAuthority,
  validateB3ReadyInitialCaptureStartAuthority,
} from './b3-capture-start-authority.mjs';
import {
  validateB3GenericConsumptionClaimAuthorityBytes,
  validateB3IssuedCommandStateAuthorityBytes,
  validateB3OrdinaryIssuedCommandClaimAuthorityBytes,
  validateB3PreparedIssuedCommandAuthorityBytes,
} from './b3-issued-command-authority.mjs';
import { registerB3CaptureStateSession } from './b3-capture-state-internal.mjs';

const PLATFORMS = new Set(['ios', 'android']);
const DATABASE_NAME = 'recovery.sqlite';
const JOURNAL_NAME = `${DATABASE_NAME}-journal`;
const APPROVED_PRAGMAS = new Set([
  'application_id',
  'busy_timeout',
  'foreign_key_check',
  'foreign_keys',
  'fullfsync',
  'integrity_check',
  'journal_mode',
  'locking_mode',
  'secure_delete',
  'synchronous',
  'temp_store',
  'trusted_schema',
  'user_version',
]);
const DENIED_AUTHORISER_ACTIONS = new Set([
  sqliteConstants.SQLITE_ATTACH,
  sqliteConstants.SQLITE_DETACH,
  sqliteConstants.SQLITE_ALTER_TABLE,
  sqliteConstants.SQLITE_CREATE_VTABLE,
  sqliteConstants.SQLITE_DROP_VTABLE,
]);
const STRICT_ONLY_DENIED_AUTHORISER_ACTIONS = new Set([
  sqliteConstants.SQLITE_REINDEX,
  sqliteConstants.SQLITE_ANALYZE,
]);
const SCHEMA_AUTHORISER_ACTIONS = new Set([
  sqliteConstants.SQLITE_CREATE_INDEX,
  sqliteConstants.SQLITE_CREATE_TABLE,
  sqliteConstants.SQLITE_CREATE_TRIGGER,
  sqliteConstants.SQLITE_CREATE_VIEW,
  sqliteConstants.SQLITE_CREATE_TEMP_INDEX,
  sqliteConstants.SQLITE_CREATE_TEMP_TABLE,
  sqliteConstants.SQLITE_CREATE_TEMP_TRIGGER,
  sqliteConstants.SQLITE_CREATE_TEMP_VIEW,
  sqliteConstants.SQLITE_DROP_INDEX,
  sqliteConstants.SQLITE_DROP_TABLE,
  sqliteConstants.SQLITE_DROP_TRIGGER,
  sqliteConstants.SQLITE_DROP_VIEW,
  sqliteConstants.SQLITE_DROP_TEMP_INDEX,
  sqliteConstants.SQLITE_DROP_TEMP_TABLE,
  sqliteConstants.SQLITE_DROP_TEMP_TRIGGER,
  sqliteConstants.SQLITE_DROP_TEMP_VIEW,
]);

function databaseError(message, code = 'b3_capture_state_invalid') {
  return Object.assign(new Error(message), { code });
}

function strictAuthoriser(actionCode, first, second) {
  if (DENIED_AUTHORISER_ACTIONS.has(actionCode) ||
      STRICT_ONLY_DENIED_AUTHORISER_ACTIONS.has(actionCode) ||
      SCHEMA_AUTHORISER_ACTIONS.has(actionCode)) return sqliteConstants.SQLITE_DENY;
  if (actionCode === sqliteConstants.SQLITE_PRAGMA &&
      (!APPROVED_PRAGMAS.has(first) || second !== null)) {
    return sqliteConstants.SQLITE_DENY;
  }
  if (actionCode === sqliteConstants.SQLITE_FUNCTION &&
      String(second ?? first ?? '').toLowerCase() === 'load_extension') {
    return sqliteConstants.SQLITE_DENY;
  }
  return sqliteConstants.SQLITE_OK;
}

function bootstrapAuthoriser(actionCode, first, second) {
  if (DENIED_AUTHORISER_ACTIONS.has(actionCode)) return sqliteConstants.SQLITE_DENY;
  if (actionCode === sqliteConstants.SQLITE_PRAGMA &&
      !APPROVED_PRAGMAS.has(first)) return sqliteConstants.SQLITE_DENY;
  if (actionCode === sqliteConstants.SQLITE_FUNCTION &&
      String(second ?? first ?? '').toLowerCase() === 'load_extension') {
    return sqliteConstants.SQLITE_DENY;
  }
  return sqliteConstants.SQLITE_OK;
}

async function syncFile(path) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(path) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

function validateDirectory(metadata, label) {
  if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
      (metadata.mode & 0o7777) !== 0o700) {
    throw databaseError(`B3 capture-state ${label} directory policy is invalid`);
  }
}

function validatePrivateFile(metadata, label, allowedSizes = null) {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 ||
      (metadata.mode & 0o7777) !== 0o600 ||
      (allowedSizes && !allowedSizes(metadata.size))) {
    throw databaseError(`B3 capture-state ${label} file policy is invalid`);
  }
}

async function createOrValidateDirectory(parent, name) {
  const path = resolve(parent, name);
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  validateDirectory(await lstat(path), name);
  if (created) await syncDirectory(parent);
  const canonical = await realpath(path);
  if (!canonical.startsWith(`${parent}/`)) {
    throw databaseError('B3 capture-state directory escaped the repository');
  }
  return canonical;
}

async function assertLegacyStateAbsent(evidence, platform) {
  for (const name of [
    `${platform}-issued-command-ledger`,
    `${platform}-capture-recovery-installing`,
    `${platform}-abandoned-captures`,
  ]) {
    try {
      await lstat(resolve(evidence, name));
      throw databaseError('B3 capture-state legacy-state is present', 'b3_legacy_state');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

async function validateStateNamespace(stateDirectory) {
  const maximumScans = 3;
  for (let scan = 1; scan <= maximumScans; scan += 1) {
    const entries = await readdir(stateDirectory, { withFileTypes: true });
    const names = new Set();
    let journalDisappeared = false;
    for (const entry of entries) {
      if (!entry.isFile() || ![DATABASE_NAME, JOURNAL_NAME].includes(entry.name)) {
        throw databaseError('B3 capture-state database sibling policy is invalid');
      }
      let metadata;
      try {
        metadata = await lstat(resolve(stateDirectory, entry.name));
      } catch (error) {
        if (entry.name === JOURNAL_NAME && error?.code === 'ENOENT') {
          journalDisappeared = true;
          break;
        }
        throw error;
      }
      validatePrivateFile(metadata, entry.name, (size) => size >= 0);
      names.add(entry.name);
    }
    if (journalDisappeared) continue;
    if (names.has(JOURNAL_NAME) && !names.has(DATABASE_NAME)) {
      throw databaseError('B3 capture-state journal exists without its database');
    }
    return names;
  }
  throw databaseError('B3 capture-state journal namespace did not stabilise');
}

function setPrevalidationConnectionPragmas(database) {
  database.exec('PRAGMA busy_timeout = 5000;');
}

function setValidatedConnectionPragmas(database) {
  database.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    PRAGMA fullfsync = ON;
    PRAGMA foreign_keys = ON;
    PRAGMA trusted_schema = OFF;
    PRAGMA locking_mode = NORMAL;
    PRAGMA temp_store = MEMORY;
    PRAGMA secure_delete = ON;
  `);
}

async function validateExistingHeaderBytes(handle, size) {
  if (size < 100) {
    throw databaseError('B3 capture-state existing database header is truncated');
  }
  const header = Buffer.alloc(100);
  const { bytesRead } = await handle.read(header, 0, header.length, 0);
  if (bytesRead !== header.length ||
      !header.subarray(0, 16).equals(Buffer.from('SQLite format 3\0', 'binary')) ||
      header[18] !== 1 || header[19] !== 1) {
    throw databaseError('B3 capture-state existing database header differs');
  }
  const userVersion = header.readUInt32BE(60);
  const applicationId = header.readUInt32BE(68);
  if (applicationId === B3_CAPTURE_STATE_APPLICATION_ID && userVersion === 1) {
    throw databaseError(
      'B3 capture-state schema version 1 is obsolete',
      'b3_capture_state_schema_obsolete',
    );
  }
  if (userVersion !== B3_CAPTURE_STATE_SCHEMA_VERSION ||
      applicationId !== B3_CAPTURE_STATE_APPLICATION_ID) {
    throw databaseError('B3 capture-state existing database header differs');
  }
}

function validateExistingDatabase(database) {
  if (pragmaScalar(database, 'application_id') !== B3_CAPTURE_STATE_APPLICATION_ID ||
      pragmaScalar(database, 'user_version') !== B3_CAPTURE_STATE_SCHEMA_VERSION ||
      pragmaScalar(database, 'journal_mode') !== 'delete' ||
      !isDeepStrictEqual(schemaObjects(database), B3_CAPTURE_STATE_SCHEMA_OBJECTS)) {
    throw databaseError('B3 capture-state existing database header or schema differs');
  }
}

function pragmaScalar(database, name) {
  const values = Object.values(database.prepare(`PRAGMA ${name}`).get());
  if (values.length !== 1) {
    throw databaseError(`B3 capture-state PRAGMA ${name} shape differs`);
  }
  return values[0];
}

function validatePragmas(database) {
  const expected = Object.freeze({
    application_id: B3_CAPTURE_STATE_APPLICATION_ID,
    user_version: B3_CAPTURE_STATE_SCHEMA_VERSION,
    journal_mode: 'delete',
    synchronous: 2,
    fullfsync: 1,
    foreign_keys: 1,
    trusted_schema: 0,
    busy_timeout: 5000,
    locking_mode: 'normal',
    temp_store: 2,
    secure_delete: 1,
  });
  for (const [name, value] of Object.entries(expected)) {
    if (pragmaScalar(database, name) !== value) {
      throw databaseError(`B3 capture-state PRAGMA ${name} differs`);
    }
  }
}

function schemaObjects(database) {
  return database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all().map((row) => ({ ...row }));
}

function bootstrapOrObserveSchema(database, platform, buildAuthority) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const userVersion = pragmaScalar(database, 'user_version');
    const objects = schemaObjects(database);
    if (userVersion === 0 && objects.length === 0) {
      database.exec(`
        PRAGMA application_id = ${B3_CAPTURE_STATE_APPLICATION_ID};
        PRAGMA user_version = ${B3_CAPTURE_STATE_SCHEMA_VERSION};
        ${B3_CAPTURE_STATE_SCHEMA_SQL}
      `);
      database.prepare(`
        INSERT INTO b3_meta (
          singleton, schema_version, platform, tested_application_commit,
          application_fingerprint, schema_sha256
        ) VALUES (1, ?, ?, ?, ?, ?)
      `).run(
        B3_CAPTURE_STATE_SCHEMA_VERSION,
        platform,
        buildAuthority.testedApplicationCommit,
        buildAuthority.applicationFingerprint,
        B3_CAPTURE_STATE_SCHEMA_SHA256,
      );
      database.exec(`
        INSERT INTO b3_authority_state (
          singleton, next_allocation_sequence, active_command_sha256,
          reserved_start_command_sha256, row_version
        ) VALUES (1, 1, NULL, NULL, 1)
      `);
    }
    database.setAuthorizer(strictAuthoriser);
    validateDatabase(database, platform, buildAuthority);
    database.exec('COMMIT');
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK');
    throw error;
  }
}

function validatePendingInitialStart(database, authority, platform, buildAuthority) {
  const rows = database.prepare('SELECT * FROM b3_capture_start_intents').all();
  if (rows.length !== 1) {
    throw databaseError('B3 capture-state pending initial intent cardinality differs');
  }
  const row = rows[0];
  return validateB3PendingInitialCaptureStartAuthority({
    platform,
    buildAuthority,
    retained: Object.freeze({
      startIntentSha256: row.start_intent_sha256,
      intentKind: row.intent_kind,
      recoveredCommandSha256: row.recovered_command_sha256,
      terminalClaimSha256: row.terminal_claim_sha256,
      captureId: row.capture_id,
      firstCommandSha256: row.first_command_sha256,
      firstCommandBytes: row.first_command_json,
      firstPreparedRecordBytes: row.first_prepared_record_json,
      firstPreparedRecordSha256: row.first_prepared_record_sha256,
      intentState: row.intent_state,
      rowVersion: row.row_version,
    }),
    singleton: Object.freeze({
      nextAllocationSequence: authority.next_allocation_sequence,
      activeCommandSha256: authority.active_command_sha256,
      reservedStartCommandSha256: authority.reserved_start_command_sha256,
      rowVersion: authority.row_version,
    }),
  });
}

function retainedStartIntent(row) {
  return Object.freeze({
    startIntentSha256: row.start_intent_sha256,
    intentKind: row.intent_kind,
    recoveredCommandSha256: row.recovered_command_sha256,
    terminalClaimSha256: row.terminal_claim_sha256,
    captureId: row.capture_id,
    firstCommandSha256: row.first_command_sha256,
    firstCommandBytes: row.first_command_json,
    firstPreparedRecordBytes: row.first_prepared_record_json,
    firstPreparedRecordSha256: row.first_prepared_record_sha256,
    intentState: row.intent_state,
    rowVersion: row.row_version,
  });
}

function publicCommandSnapshot(command, record) {
  return Object.freeze({
    schemaVersion: record.schemaVersion,
    platform: record.platform,
    allocationSequence: command.allocation_sequence,
    predecessorCommandSha256: command.predecessor_command_sha256,
    captureId: command.capture_id,
    commandSha256: command.command_sha256,
    command: Object.freeze({ ...record.command }),
    state: record.state,
    recordSha256: record.recordSha256,
  });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function validateCaptureSteps(rows, commandRows, captureId) {
  const commands = new Map(commandRows.map((row) => [row.command_sha256, row]));
  let previousObservationSha256 = '0'.repeat(64);
  const retained = [];
  for (const [index, row] of rows.entries()) {
    const command = commands.get(row.command_sha256);
    const expectedSequence = index + 1;
    if (!command || row.capture_id !== captureId ||
        row.observation_sequence !== expectedSequence ||
        command.capture_id !== captureId ||
        command.expected_observation_sequence !== expectedSequence ||
        command.previous_observation_sha256 !== previousObservationSha256 ||
        sha256(row.record_json) !== row.record_sha256 ||
        sha256(row.checkpoint_json) !== row.checkpoint_sha256) {
      throw databaseError('B3 capture-state retained step structure differs');
    }
    retained.push(Object.freeze({
      captureId: row.capture_id,
      observationSequence: row.observation_sequence,
      commandSha256: row.command_sha256,
      recordBytes: Buffer.from(row.record_json),
      recordSha256: row.record_sha256,
      observationSha256: row.observation_sha256,
      checkpointBytes: Buffer.from(row.checkpoint_json),
      checkpointSha256: row.checkpoint_sha256,
    }));
    previousObservationSha256 = row.observation_sha256;
  }
  return Object.freeze(retained);
}

function validateSelectedDecisionPath(rows, command, preparedRecord, platform) {
  const bySource = new Map();
  for (const row of rows) {
    if (row.command_sha256 !== command.command_sha256 || bySource.has(row.source_state)) {
      throw databaseError('B3 capture-state decision path has an orphan or duplicate source');
    }
    bySource.set(row.source_state, row);
  }

  const selectedCommands = [];
  const selectedDecisions = [];
  let current = preparedRecord;
  let genericDecision = null;
  const visited = new Set();
  selectedCommands.push(publicCommandSnapshot(command, current));
  while (bySource.has(current.state)) {
    if (visited.has(current.state)) {
      throw databaseError('B3 capture-state decision path contains a cycle');
    }
    visited.add(current.state);
    const row = bySource.get(current.state);
    if (row.source_record_sha256 !== current.recordSha256) {
      throw databaseError('B3 capture-state decision source authority differs');
    }
    if (row.winner_kind === 'ordinary') {
      if (typeof row.next_state !== 'string' || row.next_record_json === null ||
          row.next_record_sha256 === null) {
        throw databaseError('B3 capture-state ordinary decision shape differs');
      }
      const next = validateB3IssuedCommandStateAuthorityBytes({
        bytes: row.next_record_json,
        platform,
        expectedState: row.next_state,
      });
      const claim = validateB3OrdinaryIssuedCommandClaimAuthorityBytes({
        bytes: row.claim_json,
        platform,
        source: current,
      });
      if (next.commandSha256 !== command.command_sha256 ||
          next.recordSha256 !== row.next_record_sha256 ||
          claim.nextState !== row.next_state ||
          claim.nextRecordSha256 !== row.next_record_sha256 ||
          claim.claimSha256 !== row.claim_sha256) {
        throw databaseError('B3 capture-state ordinary decision authority differs');
      }
      const selected = Object.freeze({
        source: selectedCommands.at(-1),
        winnerKind: 'ordinary',
        command: publicCommandSnapshot(command, next),
        claimSha256: claim.claimSha256,
      });
      selectedDecisions.push(selected);
      current = next;
      selectedCommands.push(selected.command);
      continue;
    }
    if (row.winner_kind === 'generic-consumption') {
      if (row.next_state !== null || row.next_record_json !== null ||
          row.next_record_sha256 !== null) {
        throw databaseError('B3 capture-state generic decision shape differs');
      }
      const claim = validateB3GenericConsumptionClaimAuthorityBytes({
        bytes: row.claim_json,
        platform,
        source: current,
      });
      if (claim.claimSha256 !== row.claim_sha256) {
        throw databaseError('B3 capture-state generic decision authority differs');
      }
      genericDecision = Object.freeze({
        source: selectedCommands.at(-1),
        winnerKind: 'generic-consumption',
        commandSha256: current.commandSha256,
        sourceState: current.state,
        claimSha256: claim.claimSha256,
      });
      selectedDecisions.push(genericDecision);
      break;
    }
    throw databaseError('B3 capture-state recovery decision is unsupported in S2b');
  }
  if (visited.size !== rows.length) {
    throw databaseError('B3 capture-state decision path contains an unselected row');
  }
  return Object.freeze({
    selectedCommands: Object.freeze(selectedCommands),
    selectedDecisions: Object.freeze(selectedDecisions),
    tailCommand: selectedCommands.at(-1),
    genericDecision,
  });
}

function validateReadyInitialStartUnchecked(database, authority, platform, buildAuthority) {
  const intentRows = database.prepare('SELECT * FROM b3_capture_start_intents').all();
  const captureRows = database.prepare('SELECT * FROM b3_captures').all();
  const commandRows = database.prepare(`
    SELECT * FROM b3_commands ORDER BY allocation_sequence
  `).all();
  const decisionRows = database.prepare(`
    SELECT * FROM b3_decisions ORDER BY command_sha256, source_state
  `).all();
  const stepRows = database.prepare(`
    SELECT * FROM b3_capture_steps ORDER BY capture_id, observation_sequence
  `).all();
  if (intentRows.length !== 1 || captureRows.length !== 1 || commandRows.length < 1) {
    throw databaseError('B3 capture-state ready initial cardinality differs');
  }
  const startIntent = validateB3ReadyInitialCaptureStartAuthority({
    platform,
    buildAuthority,
    retained: retainedStartIntent(intentRows[0]),
  });
  const capture = captureRows[0];
  if (!isDeepStrictEqual({ ...capture }, {
    capture_id: startIntent.captureId,
    start_intent_sha256: startIntent.startIntentSha256,
    capture_state: 'working',
    row_version: 1,
  })) {
    throw databaseError('B3 capture-state ready initial capture authority differs');
  }
  const decisionsByCommand = new Map();
  for (const decision of decisionRows) {
    const rows = decisionsByCommand.get(decision.command_sha256) ?? [];
    rows.push(decision);
    decisionsByCommand.set(decision.command_sha256, rows);
  }
  const paths = [];
  const allocatedCommands = [];
  let previousCommand = null;
  for (const [index, command] of commandRows.entries()) {
    const preparedRecord = validateB3PreparedIssuedCommandAuthorityBytes({
      bytes: command.prepared_record_json,
      platform,
    });
    const expectedCommandBytes = Buffer.from(
      canonicaliseB3ProofValue(preparedRecord.command),
      'utf8',
    );
    if (command.allocation_sequence !== index + 1 ||
        command.predecessor_command_sha256 !== (previousCommand?.command_sha256 ?? null) ||
        !Buffer.from(command.command_json).equals(expectedCommandBytes) ||
        command.command_sha256 !== preparedRecord.commandSha256 ||
        command.prepared_record_sha256 !== preparedRecord.recordSha256 ||
        command.capture_id !== startIntent.captureId ||
        preparedRecord.command.captureId !== startIntent.captureId ||
        preparedRecord.command.testedApplicationCommit !==
          buildAuthority.testedApplicationCommit ||
        preparedRecord.command.applicationFingerprint !==
          buildAuthority.applicationFingerprint ||
        command.expected_observation_sequence !== preparedRecord.command.expectedSequence ||
        command.previous_observation_sha256 !==
          preparedRecord.command.previousObservationSha256) {
      throw databaseError('B3 capture-state allocated command authority differs');
    }
    if (index === 0 && (
      command.command_sha256 !== startIntent.firstCommandSha256 ||
      !Buffer.from(command.command_json).equals(startIntent.commandBytes) ||
      !Buffer.from(command.prepared_record_json).equals(startIntent.preparedRecordBytes) ||
      command.prepared_record_sha256 !== startIntent.firstPreparedRecordSha256
    )) {
      throw databaseError('B3 capture-state ready initial command authority differs');
    }
    const rows = decisionsByCommand.get(command.command_sha256) ?? [];
    const path = validateSelectedDecisionPath(rows, command, preparedRecord, platform);
    if (index < commandRows.length - 1 && path.genericDecision === null) {
      throw databaseError('B3 capture-state earlier command is not generically closed');
    }
    paths.push(path);
    allocatedCommands.push(path.selectedCommands[0]);
    previousCommand = command;
    decisionsByCommand.delete(command.command_sha256);
  }
  if (decisionsByCommand.size !== 0) {
    throw databaseError('B3 capture-state decision names an unknown command');
  }
  const tailPath = paths.at(-1);
  const genericDecisionCount = paths.filter((path) => path.genericDecision !== null).length;
  const tailIsClosed = tailPath.genericDecision !== null;
  const expectedAuthority = {
    singleton: 1,
    next_allocation_sequence: commandRows.length + 1,
    active_command_sha256: tailIsClosed ? null : commandRows.at(-1).command_sha256,
    reserved_start_command_sha256: null,
    row_version: 3 + (commandRows.length - 1) + genericDecisionCount,
  };
  if (!isDeepStrictEqual({ ...authority }, expectedAuthority)) {
    throw databaseError('B3 capture-state ready initial singleton authority differs');
  }
  const selectedCommands = paths.flatMap((path) => path.selectedCommands);
  const selectedDecisions = paths.flatMap((path) => path.selectedDecisions);
  const steps = validateCaptureSteps(stepRows, commandRows, capture.capture_id);
  return Object.freeze({
    kind: 'ready-initial',
    startIntent,
    capture: Object.freeze({ ...capture }),
    authority: Object.freeze({ ...authority }),
    allocatedCommands: Object.freeze(allocatedCommands),
    selectedCommands: Object.freeze(selectedCommands),
    selectedDecisions: Object.freeze(selectedDecisions),
    steps,
    tailCommand: tailPath.tailCommand,
    genericDecision: tailPath.genericDecision,
    activeCommand: tailIsClosed ? null : tailPath.tailCommand,
  });
}

function validateReadyInitialStart(database, authority, platform, buildAuthority) {
  try {
    return validateReadyInitialStartUnchecked(
      database,
      authority,
      platform,
      buildAuthority,
    );
  } catch (error) {
    if (error?.code === 'b3_issued_command_invalid') {
      throw databaseError(error.message);
    }
    throw error;
  }
}

function validateDatabase(database, platform, buildAuthority) {
  validatePragmas(database);
  if (!isDeepStrictEqual(schemaObjects(database), B3_CAPTURE_STATE_SCHEMA_OBJECTS)) {
    throw databaseError('B3 capture-state frozen schema differs');
  }
  const integrity = database.prepare('PRAGMA integrity_check').all()
    .map((row) => ({ ...row }));
  if (!isDeepStrictEqual(integrity, [{ integrity_check: 'ok' }])) {
    throw databaseError('B3 capture-state integrity check failed');
  }
  if (database.prepare('PRAGMA foreign_key_check').all().length !== 0) {
    throw databaseError('B3 capture-state foreign-key check failed');
  }
  const meta = database.prepare('SELECT * FROM b3_meta').all();
  if (meta.length !== 1 || meta[0].singleton !== 1 ||
      meta[0].schema_version !== B3_CAPTURE_STATE_SCHEMA_VERSION ||
      meta[0].platform !== platform ||
      meta[0].tested_application_commit !== buildAuthority.testedApplicationCommit ||
      meta[0].application_fingerprint !== buildAuthority.applicationFingerprint ||
      meta[0].schema_sha256 !== B3_CAPTURE_STATE_SCHEMA_SHA256) {
    throw databaseError('B3 capture-state metadata authority differs');
  }
  const authorityRows = database.prepare('SELECT * FROM b3_authority_state').all();
  if (authorityRows.length !== 1 || authorityRows[0].singleton !== 1) {
    throw databaseError('B3 capture-state singleton authority differs');
  }
  const authority = authorityRows[0];
  const domainCounts = database.prepare(`
    SELECT
      (SELECT count(*) FROM b3_capture_start_intents) AS start_intents,
      (SELECT count(*) FROM b3_captures) AS captures,
      (SELECT count(*) FROM b3_commands) AS commands,
      (SELECT count(*) FROM b3_capture_steps) AS steps,
      (SELECT count(*) FROM b3_decisions) AS decisions,
      (SELECT count(*) FROM b3_recoveries) AS recoveries,
      (SELECT count(*) FROM b3_recovery_manifests) AS recovery_manifests,
      (SELECT count(*) FROM b3_recovery_authorities) AS recovery_authorities,
      (SELECT count(*) FROM b3_recovery_terminals) AS recovery_terminals
  `).get();
  const recoveryCount = Object.entries(domainCounts)
    .filter(([name]) => name.startsWith('recover'))
    .some(([, count]) => count !== 0);
  const initialDomainIsEmpty = domainCounts.captures === 0 &&
    domainCounts.commands === 0 && domainCounts.decisions === 0 &&
    domainCounts.steps === 0;
  if (!recoveryCount && initialDomainIsEmpty && domainCounts.start_intents === 0 &&
      isDeepStrictEqual({ ...authority }, {
        singleton: 1,
        next_allocation_sequence: 1,
        active_command_sha256: null,
        reserved_start_command_sha256: null,
        row_version: 1,
      })) {
    return Object.freeze({ kind: 'empty', startIntent: null });
  }
  if (!recoveryCount && initialDomainIsEmpty && domainCounts.start_intents === 1) {
    return Object.freeze({
      kind: 'pending-initial',
      startIntent: validatePendingInitialStart(
        database,
        authority,
        platform,
        buildAuthority,
      ),
    });
  }
  if (!recoveryCount && domainCounts.start_intents === 1 &&
      domainCounts.captures === 1 && domainCounts.commands >= 1) {
    return validateReadyInitialStart(database, authority, platform, buildAuthority);
  }
  throw databaseError('B3 capture-state domain authority is unsupported or invalid');
}

function openWithPrivateMask(path) {
  const previous = process.umask(0o077);
  try { return new DatabaseSync(path); } finally { process.umask(previous); }
}

export async function openB3CaptureStateDatabase(options) {
  const keys = options && typeof options === 'object' ? Object.keys(options) : [];
  if (keys.length !== 1 || keys[0] !== 'platform') {
    throw databaseError('B3 capture-state open authority is invalid');
  }
  const platform = options.platform;
  if (!PLATFORMS.has(platform)) {
    throw databaseError('B3 capture-state open authority is invalid');
  }
  const root = await realpath(B3_CAPTURE_STATE_REPOSITORY_ROOT);
  if (root !== B3_CAPTURE_STATE_REPOSITORY_ROOT) {
    throw databaseError('B3 capture-state repository root is not canonical');
  }
  const buildAuthority = (await readB3BuildAuthoritySource()).buildAuthority;

  let evidence = root;
  for (const component of ['.native-build', 'b3', 'evidence']) {
    evidence = await createOrValidateDirectory(evidence, component);
  }
  await assertLegacyStateAbsent(evidence, platform);
  const stateDirectory = await createOrValidateDirectory(
    evidence, `${platform}-capture-state`,
  );
  await validateStateNamespace(stateDirectory);
  const databasePath = resolve(stateDirectory, DATABASE_NAME);
  let created = false;
  let guard;
  try {
    try {
      guard = await open(
        databasePath,
        fsConstants.O_RDONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      created = true;
      await guard.sync();
      await syncDirectory(stateDirectory);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      guard = await open(databasePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    }
    const databaseMetadata = await guard.stat();
    validatePrivateFile(databaseMetadata, DATABASE_NAME, (size) => size >= 0);
    const bootstrapEligible = created || databaseMetadata.size === 0;
    if (!bootstrapEligible) {
      await validateExistingHeaderBytes(guard, databaseMetadata.size);
    }

    const database = openWithPrivateMask(databasePath);
    let returned = false;
    try {
      database.enableDefensive(true);
      database.enableLoadExtension(false);
      database.setAuthorizer(bootstrapAuthoriser);
      if (database.location() !== databasePath) {
        throw databaseError('B3 capture-state SQLite location differs');
      }
      setPrevalidationConnectionPragmas(database);
      if (!bootstrapEligible) validateExistingDatabase(database);
      setValidatedConnectionPragmas(database);
      bootstrapOrObserveSchema(database, platform, buildAuthority);
      const after = await lstat(databasePath);
      validatePrivateFile(after, DATABASE_NAME, (size) => size > 0);
      if (after.dev !== databaseMetadata.dev || after.ino !== databaseMetadata.ino) {
        throw databaseError('B3 capture-state database identity changed during open');
      }
      if (bootstrapEligible) {
        await syncFile(databasePath);
        await syncDirectory(stateDirectory);
      }
      let closed = false;
      async function close() {
        if (closed) throw databaseError('B3 capture-state handle is already closed');
        closed = true;
        database.close();
      }
      const state = { close };
      registerB3CaptureStateSession(state, Object.freeze({
        database,
        platform,
        isClosed: () => closed,
        readBuildAuthorityFresh: async () =>
          (await readB3BuildAuthoritySource()).buildAuthority,
        validate: (freshBuildAuthority) =>
          validateDatabase(database, platform, freshBuildAuthority),
      }));
      Object.freeze(state);
      returned = true;
      return state;
    } finally {
      if (!returned) {
        try { database.close(); } catch { /* Preserve the authority failure. */ }
      }
    }
  } finally {
    await guard?.close();
  }
}
