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
import {
  readB3BuildAuthoritySource,
  readB3BuildAuthoritySourceSync,
} from './b3-build-authority-source.mjs';
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
  validateB3PendingRecoveryFreshCaptureStartAuthority,
  validateB3ReadyInitialCaptureStartAuthority,
  validateB3ReadyRecoveryFreshCaptureStartAuthority,
} from './b3-capture-start-authority.mjs';
import {
  createB3CaptureSnapshotAuthority,
  validateB3RecoveryArchiveAuthorityBytes,
  validateB3RecoveryManifestAuthorityBytes,
  validateB3RecoveryOwnerClaimAuthorityBytes,
  validateB3RecoveryTerminalAuthorityBytes,
} from './b3-capture-recovery-authority.mjs';
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

function validateCaptureCommandStepShape({
  captureId,
  captureState,
  commandRows,
  paths,
  stepRows,
  activeCommandSha256,
}) {
  const localSteps = validateCaptureSteps(stepRows, commandRows, captureId);
  for (const [index, command] of commandRows.entries()) {
    const expectedSequence = index + 1;
    if (command.capture_id !== captureId ||
        command.expected_observation_sequence !== expectedSequence ||
        expectedSequence > 512 ||
        (expectedSequence === 1 &&
          command.previous_observation_sha256 !== '0'.repeat(64)) ||
        (expectedSequence > 1 &&
          command.previous_observation_sha256 !==
            localSteps[expectedSequence - 2]?.observationSha256)) {
      throw databaseError('B3 capture-state local command observation chain differs');
    }
    const hasStep = localSteps[expectedSequence - 1]?.commandSha256 ===
      command.command_sha256;
    if (paths[index].genericDecision !== null && !hasStep) {
      throw databaseError(
        'B3 capture-state generically closed command has no exact committed step',
      );
    }
    if (index < commandRows.length - 1 &&
        (paths[index].genericDecision === null || !hasStep)) {
      throw databaseError(
        'B3 capture-state earlier command is not generically closed with a retained step',
      );
    }
  }

  const tail = commandRows.at(-1);
  const tailPath = paths.at(-1);
  const tailIsClosed = tailPath.genericDecision !== null;
  if (captureState === 'abandoned') {
    if (tailPath.recoveryOwner === null || tailIsClosed ||
        activeCommandSha256 !== null ||
        ![commandRows.length - 1, commandRows.length].includes(localSteps.length)) {
      throw databaseError('B3 capture-state abandoned tail shape differs');
    }
  } else if (tailIsClosed) {
    if (activeCommandSha256 !== null || localSteps.length !== commandRows.length) {
      throw databaseError('B3 capture-state closed tail authority differs');
    }
  } else if (activeCommandSha256 !== tail.command_sha256 ||
      ![commandRows.length - 1, commandRows.length].includes(localSteps.length)) {
    throw databaseError('B3 capture-state active tail authority differs');
  }
  if (captureState === 'working' && localSteps.length === 0 &&
      (commandRows.length !== 1 || activeCommandSha256 !== tail.command_sha256)) {
    throw databaseError('B3 capture-state zero-step ready capture shape differs');
  }
  return localSteps;
}

function decisionSnapshot(row) {
  return Object.freeze({
    commandSha256: row.command_sha256,
    sourceState: row.source_state,
    sourceRecordSha256: row.source_record_sha256,
    winnerKind: row.winner_kind,
    nextState: row.next_state,
    nextRecordSha256: row.next_record_sha256,
    claimSha256: row.claim_sha256,
  });
}

function validateSelectedDecisionPath({
  rows,
  command,
  preparedRecord,
  platform,
  captureState,
  isCaptureTail,
}) {
  const bySource = new Map();
  for (const row of rows) {
    if (row.command_sha256 !== command.command_sha256 || bySource.has(row.source_state)) {
      throw databaseError('B3 capture-state decision path has an orphan or duplicate source');
    }
    bySource.set(row.source_state, row);
  }

  const selectedCommands = [];
  const selectedDecisions = [];
  const snapshotDecisions = [];
  let current = preparedRecord;
  let genericDecision = null;
  let recoveryOwner = null;
  let terminalDecisionRow = null;
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
      snapshotDecisions.push(decisionSnapshot(row));
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
      snapshotDecisions.push(decisionSnapshot(row));
      break;
    }
    if (row.winner_kind === 'recovery-owner') {
      if (captureState !== 'abandoned' || !isCaptureTail || recoveryOwner !== null ||
          row.next_state !== 'restart-executing' || row.next_record_json === null ||
          row.next_record_sha256 === null) {
        throw databaseError('B3 capture-state recovery-owner decision shape differs');
      }
      const owner = validateB3RecoveryOwnerClaimAuthorityBytes({
        bytes: row.claim_json,
        platform,
        source: current,
      });
      if (owner.nextRecord.recordSha256 !== row.next_record_sha256 ||
          owner.nextRecordSha256 !== row.next_record_sha256 ||
          owner.ownerClaimSha256 !== row.claim_sha256 ||
          !owner.nextRecordBytes.equals(Buffer.from(row.next_record_json))) {
        throw databaseError('B3 capture-state recovery-owner authority differs');
      }
      recoveryOwner = Object.freeze({
        source: selectedCommands.at(-1),
        winnerKind: 'recovery-owner',
        command: publicCommandSnapshot(command, owner.nextRecord),
        claimSha256: owner.ownerClaimSha256,
        authority: owner,
      });
      selectedDecisions.push(recoveryOwner);
      snapshotDecisions.push(decisionSnapshot(row));
      current = owner.nextRecord;
      selectedCommands.push(recoveryOwner.command);
      continue;
    }
    if (row.winner_kind === 'recovery-terminal' && recoveryOwner !== null &&
        current.state === 'restart-executing') {
      terminalDecisionRow = Object.freeze({ ...row });
      break;
    }
    throw databaseError('B3 capture-state recovery decision path differs');
  }
  if (visited.size !== rows.length) {
    throw databaseError('B3 capture-state decision path contains an unselected row');
  }
  return Object.freeze({
    selectedCommands: Object.freeze(selectedCommands),
    selectedDecisions: Object.freeze(selectedDecisions),
    snapshotDecisions: Object.freeze(snapshotDecisions),
    tailCommand: selectedCommands.at(-1),
    genericDecision,
    recoveryOwner,
    terminalDecisionRow,
  });
}

function groupRows(rows, key) {
  const grouped = new Map();
  for (const row of rows) {
    const value = row[key];
    const existing = grouped.get(value) ?? [];
    existing.push(row);
    grouped.set(value, existing);
  }
  return grouped;
}

function validateReadyStartIntent({ row, platform, buildAuthority }) {
  const retained = retainedStartIntent(row);
  if (row.intent_kind === 'initial') {
    return validateB3ReadyInitialCaptureStartAuthority({
      platform,
      buildAuthority,
      retained,
    });
  }
  if (row.intent_kind === 'recovery-fresh') {
    return validateB3ReadyRecoveryFreshCaptureStartAuthority({
      platform,
      buildAuthority,
      recoveredCommandSha256: row.recovered_command_sha256,
      terminalClaimSha256: row.terminal_claim_sha256,
      retained,
    });
  }
  throw databaseError('B3 capture-state ready intent kind differs');
}

function validatePendingRecoveryStartIntent({ row, platform, buildAuthority }) {
  return validateB3PendingRecoveryFreshCaptureStartAuthority({
    platform,
    buildAuthority,
    recoveredCommandSha256: row.recovered_command_sha256,
    terminalClaimSha256: row.terminal_claim_sha256,
    retained: retainedStartIntent(row),
  });
}

function validateGlobalCommandLedger(commandRows, platform, buildAuthority) {
  const blocks = [];
  const seenCaptureIds = new Set();
  let previous = null;
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
        command.predecessor_command_sha256 !== (previous?.command_sha256 ?? null) ||
        !Buffer.from(command.command_json).equals(expectedCommandBytes) ||
        command.command_sha256 !== preparedRecord.commandSha256 ||
        command.prepared_record_sha256 !== preparedRecord.recordSha256 ||
        preparedRecord.command.captureId !== command.capture_id ||
        preparedRecord.command.testedApplicationCommit !==
          buildAuthority.testedApplicationCommit ||
        preparedRecord.command.applicationFingerprint !==
          buildAuthority.applicationFingerprint ||
        command.expected_observation_sequence !== preparedRecord.command.expectedSequence ||
        command.previous_observation_sha256 !==
          preparedRecord.command.previousObservationSha256) {
      throw databaseError('B3 capture-state allocated command authority differs');
    }
    let block = blocks.at(-1);
    if (!block || block.captureId !== command.capture_id) {
      if (seenCaptureIds.has(command.capture_id)) {
        throw databaseError('B3 capture-state command capture block is not contiguous');
      }
      seenCaptureIds.add(command.capture_id);
      block = { captureId: command.capture_id, entries: [] };
      blocks.push(block);
    }
    const expectedLocalSequence = block.entries.length + 1;
    if (command.expected_observation_sequence !== expectedLocalSequence ||
        expectedLocalSequence > 512 ||
        (expectedLocalSequence === 1 &&
          command.previous_observation_sha256 !== '0'.repeat(64))) {
      throw databaseError('B3 capture-state local command ordinal differs');
    }
    block.entries.push(Object.freeze({ row: command, preparedRecord }));
    previous = command;
  }
  return Object.freeze(blocks.map((block) => Object.freeze({
    captureId: block.captureId,
    entries: Object.freeze(block.entries),
  })));
}

function validateCaptureBlock({
  block,
  captureRow,
  intentRow,
  decisionRowsByCommand,
  stepRows,
  activeCommandSha256,
  platform,
  buildAuthority,
}) {
  const startIntent = validateReadyStartIntent({
    row: intentRow,
    platform,
    buildAuthority,
  });
  const expectedCapture = {
    capture_id: startIntent.captureId,
    start_intent_sha256: startIntent.startIntentSha256,
    capture_state: captureRow.capture_state,
    row_version: captureRow.capture_state === 'working' ? 1 : 2,
  };
  if (!isDeepStrictEqual({ ...captureRow }, expectedCapture) ||
      block.captureId !== startIntent.captureId) {
    throw databaseError('B3 capture-state capture authority differs');
  }
  const paths = [];
  const commandRows = block.entries.map((entry) => entry.row);
  for (const [index, entry] of block.entries.entries()) {
    if (index === 0 && (
      entry.row.command_sha256 !== startIntent.firstCommandSha256 ||
      !Buffer.from(entry.row.command_json).equals(startIntent.commandBytes) ||
      !Buffer.from(entry.row.prepared_record_json).equals(startIntent.preparedRecordBytes) ||
      entry.row.prepared_record_sha256 !== startIntent.firstPreparedRecordSha256
    )) {
      throw databaseError('B3 capture-state first command authority differs');
    }
    const rows = decisionRowsByCommand.get(entry.row.command_sha256) ?? [];
    const path = validateSelectedDecisionPath({
      rows,
      command: entry.row,
      preparedRecord: entry.preparedRecord,
      platform,
      captureState: captureRow.capture_state,
      isCaptureTail: index === block.entries.length - 1,
    });
    if (index < block.entries.length - 1 && path.genericDecision === null) {
      throw databaseError('B3 capture-state earlier command is not generically closed');
    }
    decisionRowsByCommand.delete(entry.row.command_sha256);
    paths.push(path);
  }
  const containsActive = commandRows.some((row) =>
    row.command_sha256 === activeCommandSha256);
  const steps = validateCaptureCommandStepShape({
    captureId: captureRow.capture_id,
    captureState: captureRow.capture_state,
    commandRows,
    paths,
    stepRows,
    activeCommandSha256: containsActive ? activeCommandSha256 : null,
  });
  const tailPath = paths.at(-1);
  const allocatedCommands = Object.freeze(paths.map((path) => path.selectedCommands[0]));
  const selectedCommands = Object.freeze(paths.flatMap((path) => path.selectedCommands));
  const selectedDecisions = Object.freeze(paths.flatMap((path) => path.selectedDecisions));
  const snapshotCommands = Object.freeze(commandRows.map((row) => Object.freeze({
    allocationSequence: row.allocation_sequence,
    commandSha256: row.command_sha256,
    predecessorCommandSha256: row.predecessor_command_sha256,
    commandJsonSha256: sha256(row.command_json),
    preparedRecordSha256: row.prepared_record_sha256,
    expectedObservationSequence: row.expected_observation_sequence,
    previousObservationSha256: row.previous_observation_sha256,
  })));
  const snapshotDecisions = Object.freeze(paths.flatMap((path) =>
    path.snapshotDecisions));
  const snapshotSteps = Object.freeze(steps.map((step) => Object.freeze({
    observationSequence: step.observationSequence,
    commandSha256: step.commandSha256,
    recordSha256: step.recordSha256,
    observationSha256: step.observationSha256,
    checkpointSha256: step.checkpointSha256,
  })));
  const tailIsGeneric = tailPath.genericDecision !== null;
  return Object.freeze({
    startIntent,
    capture: Object.freeze({ ...captureRow }),
    allocatedCommands,
    selectedCommands,
    selectedDecisions,
    snapshotCommands,
    snapshotDecisions,
    snapshotSteps,
    steps,
    tailCommand: tailPath.tailCommand,
    genericDecision: tailPath.genericDecision,
    activeCommand: captureRow.capture_state === 'working' && !tailIsGeneric
      ? tailPath.tailCommand
      : null,
    recoveryOwner: tailPath.recoveryOwner,
    terminalDecisionRow: tailPath.terminalDecisionRow,
    recovery: null,
  });
}

function validateCaptureRecovery({
  capture,
  recoveryRow,
  manifestRow,
  authorityRow,
  terminalRow,
  platform,
  buildAuthority,
}) {
  if (capture.capture.capture_state !== 'abandoned' || !capture.recoveryOwner ||
      !recoveryRow || !manifestRow || !authorityRow) {
    throw databaseError('B3 capture-state abandoned recovery cardinality differs');
  }
  const owner = capture.recoveryOwner.authority;
  const tailCommandSha256 = capture.allocatedCommands.at(-1).commandSha256;
  const snapshot = createB3CaptureSnapshotAuthority({
    platform,
    captureId: capture.capture.capture_id,
    startIntentSha256: capture.startIntent.startIntentSha256,
    captureState: 'abandoned',
    captureRowVersion: capture.capture.row_version,
    testedApplicationCommit: buildAuthority.testedApplicationCommit,
    applicationFingerprint: buildAuthority.applicationFingerprint,
    commands: capture.snapshotCommands,
    decisions: capture.snapshotDecisions,
    steps: capture.snapshotSteps,
  });
  if (!isDeepStrictEqual({ ...recoveryRow }, {
    command_sha256: tailCommandSha256,
    owner_kind: 'recovery-owner',
    owner_claim_sha256: owner.ownerClaimSha256,
    capture_id: capture.capture.capture_id,
    capture_snapshot_sha256: snapshot.captureSnapshotSha256,
    row_version: 1,
  })) {
    throw databaseError('B3 capture-state recovery snapshot row differs');
  }
  const lastStep = capture.steps.at(-1);
  const manifest = validateB3RecoveryManifestAuthorityBytes({
    bytes: manifestRow.manifest_json,
    platform,
    captureId: capture.capture.capture_id,
    commandSha256: tailCommandSha256,
    ownerClaimSha256: owner.ownerClaimSha256,
    captureSnapshotSha256: snapshot.captureSnapshotSha256,
    observationCount: capture.steps.length,
    terminalObservationSha256: lastStep?.observationSha256 ?? '0'.repeat(64),
  });
  if (manifestRow.command_sha256 !== tailCommandSha256 ||
      manifestRow.owner_claim_sha256 !== owner.ownerClaimSha256 ||
      manifestRow.capture_snapshot_sha256 !== snapshot.captureSnapshotSha256 ||
      manifestRow.manifest_sha256 !== manifest.manifestSha256) {
    throw databaseError('B3 capture-state recovery manifest row differs');
  }
  const archive = validateB3RecoveryArchiveAuthorityBytes({
    bytes: authorityRow.authority_json,
    platform,
    captureId: capture.capture.capture_id,
    commandSha256: tailCommandSha256,
    ownerClaimSha256: owner.ownerClaimSha256,
    captureSnapshotSha256: snapshot.captureSnapshotSha256,
    manifestSha256: manifest.manifestSha256,
    testedApplicationCommit: buildAuthority.testedApplicationCommit,
    applicationFingerprint: buildAuthority.applicationFingerprint,
  });
  if (authorityRow.command_sha256 !== tailCommandSha256 ||
      authorityRow.owner_claim_sha256 !== owner.ownerClaimSha256 ||
      authorityRow.capture_snapshot_sha256 !== snapshot.captureSnapshotSha256 ||
      authorityRow.manifest_sha256 !== manifest.manifestSha256 ||
      authorityRow.authority_sha256 !== archive.archiveAuthoritySha256) {
    throw databaseError('B3 capture-state recovery archive row differs');
  }

  let terminal = null;
  if (terminalRow !== undefined) {
    const decision = capture.terminalDecisionRow;
    if (!decision) {
      throw databaseError('B3 capture-state recovery terminal decision is absent');
    }
    terminal = validateB3RecoveryTerminalAuthorityBytes({
      terminalRecordBytes: terminalRow.terminal_record_json,
      terminalClaimBytes: terminalRow.terminal_claim_json,
      platform,
      source: owner.nextRecord,
      ownerClaimSha256: owner.ownerClaimSha256,
      captureSnapshotSha256: snapshot.captureSnapshotSha256,
      manifestSha256: manifest.manifestSha256,
      archiveAuthoritySha256: archive.archiveAuthoritySha256,
    });
    if (terminalRow.command_sha256 !== tailCommandSha256 ||
        terminalRow.owner_claim_sha256 !== owner.ownerClaimSha256 ||
        terminalRow.capture_snapshot_sha256 !== snapshot.captureSnapshotSha256 ||
        terminalRow.manifest_sha256 !== manifest.manifestSha256 ||
        terminalRow.authority_sha256 !== archive.archiveAuthoritySha256 ||
        terminalRow.terminal_kind !== 'recovery-terminal' ||
        terminalRow.terminal_record_sha256 !== terminal.terminalRecordSha256 ||
        terminalRow.terminal_claim_sha256 !== terminal.terminalClaimSha256 ||
        decision.command_sha256 !== tailCommandSha256 ||
        decision.source_state !== 'restart-executing' ||
        decision.source_record_sha256 !== owner.nextRecordSha256 ||
        decision.winner_kind !== 'recovery-terminal' ||
        decision.next_state !== 'restart-complete' ||
        decision.next_record_sha256 !== terminal.terminalRecordSha256 ||
        decision.claim_sha256 !== terminal.terminalClaimSha256 ||
        !Buffer.from(decision.next_record_json).equals(terminal.terminalRecordBytes) ||
        !Buffer.from(decision.claim_json).equals(terminal.terminalClaimBytes)) {
      throw databaseError('B3 capture-state recovery terminal row differs');
    }
  } else if (capture.terminalDecisionRow !== null) {
    throw databaseError('B3 capture-state terminal decision has no terminal row');
  }
  return Object.freeze({
    owner,
    snapshot,
    manifest,
    archive,
    terminal,
  });
}

function validateAuthorityProjection({
  authority,
  captures,
  pendingStartIntent,
  intentCount,
  commandCount,
}) {
  const workingCapture = captures.find((capture) =>
    capture.capture.capture_state === 'working') ?? null;
  const genericCount = captures.reduce((count, capture) =>
    count + capture.selectedDecisions.filter((decision) =>
      decision.winnerKind === 'generic-consumption').length, 0);
  const abandonedCount = captures.filter((capture) =>
    capture.capture.capture_state === 'abandoned').length;
  const expectedActive = workingCapture?.activeCommand?.commandSha256 ?? null;
  const expectedReserved = pendingStartIntent?.firstCommandSha256 ?? null;
  if (!isDeepStrictEqual({ ...authority }, {
    singleton: 1,
    next_allocation_sequence: commandCount + 1,
    active_command_sha256: expectedActive,
    reserved_start_command_sha256: expectedReserved,
    row_version: 1 + intentCount + commandCount + genericCount + abandonedCount,
  })) {
    throw databaseError('B3 capture-state singleton authority differs');
  }
  return workingCapture;
}

function validateRelationalState(database, authority, platform, buildAuthority) {
  const intentRows = database.prepare(`
    SELECT * FROM b3_capture_start_intents ORDER BY start_intent_sha256
  `).all();
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
  const recoveryRows = database.prepare('SELECT * FROM b3_recoveries').all();
  const manifestRows = database.prepare('SELECT * FROM b3_recovery_manifests').all();
  const archiveRows = database.prepare('SELECT * FROM b3_recovery_authorities').all();
  const terminalRows = database.prepare('SELECT * FROM b3_recovery_terminals').all();

  const recoveryDomainCount = recoveryRows.length + manifestRows.length +
    archiveRows.length + terminalRows.length;
  if (captureRows.length === 0 && commandRows.length === 0 &&
      decisionRows.length === 0 && stepRows.length === 0 && recoveryDomainCount === 0) {
    if (intentRows.length === 0 && isDeepStrictEqual({ ...authority }, {
      singleton: 1,
      next_allocation_sequence: 1,
      active_command_sha256: null,
      reserved_start_command_sha256: null,
      row_version: 1,
    })) {
      return Object.freeze({
        kind: 'empty',
        authority: Object.freeze({ ...authority }),
        captures: Object.freeze([]),
        workingCapture: null,
        pendingStartIntent: null,
        latestRecovery: null,
      });
    }
    if (intentRows.length === 1 && intentRows[0].intent_kind === 'initial') {
      const pending = validatePendingInitialStart(
        database,
        authority,
        platform,
        buildAuthority,
      );
      return Object.freeze({
        kind: 'pending-initial',
        authority: Object.freeze({ ...authority }),
        captures: Object.freeze([]),
        workingCapture: null,
        pendingStartIntent: pending,
        latestRecovery: null,
      });
    }
    throw databaseError('B3 capture-state empty domain authority differs');
  }
  if (captureRows.length === 0 || commandRows.length === 0) {
    throw databaseError('B3 capture-state capture domain cardinality differs');
  }

  const blocks = validateGlobalCommandLedger(commandRows, platform, buildAuthority);
  const captureById = new Map(captureRows.map((row) => [row.capture_id, row]));
  const intentBySha256 = new Map(intentRows.map((row) =>
    [row.start_intent_sha256, row]));
  const decisionsByCommand = groupRows(decisionRows, 'command_sha256');
  const stepsByCapture = groupRows(stepRows, 'capture_id');
  const baseCaptures = [];
  for (const block of blocks) {
    const captureRow = captureById.get(block.captureId);
    const intentRow = captureRow && intentBySha256.get(captureRow.start_intent_sha256);
    if (!captureRow || !intentRow || intentRow.intent_state !== 'ready') {
      throw databaseError('B3 capture-state capture block authority is absent');
    }
    const capture = validateCaptureBlock({
      block,
      captureRow,
      intentRow,
      decisionRowsByCommand: decisionsByCommand,
      stepRows: stepsByCapture.get(block.captureId) ?? [],
      activeCommandSha256: authority.active_command_sha256,
      platform,
      buildAuthority,
    });
    baseCaptures.push(capture);
    captureById.delete(block.captureId);
    intentBySha256.delete(intentRow.start_intent_sha256);
    stepsByCapture.delete(block.captureId);
  }
  if (captureById.size !== 0 || decisionsByCommand.size !== 0 ||
      stepsByCapture.size !== 0) {
    throw databaseError('B3 capture-state relational row is orphaned');
  }

  const recoveryByCommand = new Map(recoveryRows.map((row) =>
    [row.command_sha256, row]));
  const manifestByCommand = new Map(manifestRows.map((row) =>
    [row.command_sha256, row]));
  const archiveByCommand = new Map(archiveRows.map((row) =>
    [row.command_sha256, row]));
  const terminalByCommand = new Map(terminalRows.map((row) =>
    [row.command_sha256, row]));
  const captures = [];
  for (const capture of baseCaptures) {
    const commandSha256 = capture.allocatedCommands.at(-1).commandSha256;
    if (capture.capture.capture_state === 'working') {
      if (recoveryByCommand.has(commandSha256) || manifestByCommand.has(commandSha256) ||
          archiveByCommand.has(commandSha256) || terminalByCommand.has(commandSha256) ||
          capture.recoveryOwner || capture.terminalDecisionRow) {
        throw databaseError('B3 capture-state working capture has recovery authority');
      }
      captures.push(capture);
      continue;
    }
    const recovery = validateCaptureRecovery({
      capture,
      recoveryRow: recoveryByCommand.get(commandSha256),
      manifestRow: manifestByCommand.get(commandSha256),
      authorityRow: archiveByCommand.get(commandSha256),
      terminalRow: terminalByCommand.get(commandSha256),
      platform,
      buildAuthority,
    });
    recoveryByCommand.delete(commandSha256);
    manifestByCommand.delete(commandSha256);
    archiveByCommand.delete(commandSha256);
    terminalByCommand.delete(commandSha256);
    captures.push(Object.freeze({ ...capture, recovery }));
  }
  if (recoveryByCommand.size !== 0 || manifestByCommand.size !== 0 ||
      archiveByCommand.size !== 0 || terminalByCommand.size !== 0) {
    throw databaseError('B3 capture-state recovery row is orphaned');
  }

  if (captures[0].startIntent.intentKind !== 'initial') {
    throw databaseError('B3 capture-state first intent is not initial');
  }
  for (let index = 1; index < captures.length; index += 1) {
    const previous = captures[index - 1];
    const current = captures[index];
    if (current.startIntent.intentKind !== 'recovery-fresh' ||
        previous.capture.capture_state !== 'abandoned' ||
        previous.recovery?.terminal === null ||
        current.startIntent.recoveredCommandSha256 !==
          previous.allocatedCommands.at(-1).commandSha256 ||
        current.startIntent.terminalClaimSha256 !==
          previous.recovery.terminal.terminalClaimSha256) {
      throw databaseError('B3 capture-state recovery-fresh lineage differs');
    }
  }

  const pendingRows = [...intentBySha256.values()];
  let pendingStartIntent = null;
  if (pendingRows.length === 1 && pendingRows[0].intent_state === 'pending' &&
      pendingRows[0].intent_kind === 'recovery-fresh') {
    pendingStartIntent = validatePendingRecoveryStartIntent({
      row: pendingRows[0],
      platform,
      buildAuthority,
    });
  } else if (pendingRows.length !== 0) {
    throw databaseError('B3 capture-state pending intent authority differs');
  }

  const frozenCaptures = Object.freeze(captures);
  const workingCaptures = captures.filter((capture) =>
    capture.capture.capture_state === 'working');
  if (workingCaptures.length > 1 ||
      (workingCaptures.length === 1 && workingCaptures[0] !== captures.at(-1))) {
    throw databaseError('B3 capture-state working capture ordering differs');
  }
  const latest = captures.at(-1);
  let kind;
  if (workingCaptures.length === 1 && pendingStartIntent === null) {
    kind = 'working';
  } else if (workingCaptures.length === 0 && latest.recovery?.terminal === null &&
      pendingStartIntent === null) {
    kind = 'archived-recovery-pending-terminal';
  } else if (workingCaptures.length === 0 && latest.recovery?.terminal !== null &&
      pendingStartIntent !== null &&
      pendingStartIntent.recoveredCommandSha256 ===
        latest.allocatedCommands.at(-1).commandSha256 &&
      pendingStartIntent.terminalClaimSha256 ===
        latest.recovery.terminal.terminalClaimSha256) {
    kind = 'terminal-pending-recovery-fresh';
  } else {
    throw databaseError('B3 capture-state recovery phase mixture differs');
  }
  for (let index = 0; index < captures.length - 1; index += 1) {
    if (captures[index].capture.capture_state !== 'abandoned' ||
        captures[index].recovery?.terminal === null) {
      throw databaseError('B3 capture-state earlier recovery is incomplete');
    }
  }
  const workingCapture = validateAuthorityProjection({
    authority,
    captures,
    pendingStartIntent,
    intentCount: intentRows.length,
    commandCount: commandRows.length,
  });
  const latestRecovery = [...captures].reverse().find((capture) =>
    capture.capture.capture_state === 'abandoned')?.recovery ?? null;
  return Object.freeze({
    kind,
    authority: Object.freeze({ ...authority }),
    captures: frozenCaptures,
    workingCapture,
    pendingStartIntent,
    latestRecovery,
  });
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
  try {
    return validateRelationalState(database, authority, platform, buildAuthority);
  } catch (error) {
    if (error?.code === 'b3_issued_command_invalid' ||
        error?.code === 'b3_capture_recovery_invalid') {
      throw databaseError(error.message);
    }
    throw error;
  }
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
        readBuildSourceFresh: readB3BuildAuthoritySource,
        readBuildSourceFreshSync: readB3BuildAuthoritySourceSync,
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
