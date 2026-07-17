import { isDeepStrictEqual } from 'node:util';

import { canonicaliseB3ProofValue } from '../../src/app/b3-live-proof-protocol.js';
import {
  createB3InitialCaptureStartAuthority,
  createB3RecoveryFreshCaptureStartAuthority,
  publicB3CaptureStartAuthority,
  validateB3RecoveryFreshCommandAuthority,
} from './b3-capture-start-authority.mjs';
import {
  createB3CaptureSnapshotAuthority,
  createB3RecoveryArchiveAuthority,
  createB3RecoveryManifestAuthority,
  createB3RecoveryOwnerClaimAuthority,
  createB3RecoveryTerminalAuthority,
} from './b3-capture-recovery-authority.mjs';
import { openB3CaptureStateDatabase } from './b3-capture-state-database.mjs';
import { takeB3CaptureStateSession } from './b3-capture-state-internal.mjs';
import { validateB3DistributionProjection } from './b3-evidence.mjs';
import {
  deriveB3CaptureStep,
  deriveB3DeviceGatewaySmokeProjection,
  validateB3RetainedCaptureStep,
} from './b3-capture-proof-domain.mjs';
import {
  createB3GenericConsumptionClaimAuthority,
  createB3IssuedCommandStateAuthority,
  createB3OrdinaryIssuedCommandClaimAuthority,
  createB3PreparedIssuedCommandAuthority,
} from './b3-issued-command-authority.mjs';

const SOURCE_KEYS = Object.freeze([
  'allocationSequence',
  'captureId',
  'command',
  'commandSha256',
  'platform',
  'predecessorCommandSha256',
  'recordSha256',
  'schemaVersion',
  'state',
]);
const HASH = /^[0-9a-f]{64}$/u;

function repositoryError(message) {
  return Object.assign(new Error(message), { code: 'b3_capture_state_invalid' });
}

function driftError(message) {
  return Object.assign(new Error(message), { code: 'b3_capture_state_drift' });
}

function isRetryableDrift(error) {
  return error?.code === 'b3_capture_state_drift' ||
    error?.errcode === 5 || error?.errcode === 6 ||
    String(error?.code ?? '').startsWith('SQLITE_BUSY') ||
    String(error?.code ?? '').startsWith('SQLITE_LOCKED');
}

function buildSourceSnapshot(source) {
  return Object.freeze({
    bytes: source.bytes.toString('base64'),
    sha256: source.sha256,
    sourceSha256: source.sourceSha256,
    value: Object.freeze({ ...source.value }),
    buildAuthority: Object.freeze({ ...source.buildAuthority }),
    identity: Object.freeze({
      ancestors: Object.freeze(source.identity.ancestors.map((entry) =>
        Object.freeze({ ...entry }))),
      file: Object.freeze({ ...source.identity.file }),
    }),
  });
}

function copyStepRow(row) {
  return Object.freeze({
    captureId: row.captureId,
    observationSequence: row.observationSequence,
    commandSha256: row.commandSha256,
    recordBytes: Buffer.from(row.recordBytes),
    recordSha256: row.recordSha256,
    observationSha256: row.observationSha256,
    checkpointBytes: Buffer.from(row.checkpointBytes),
    checkpointSha256: row.checkpointSha256,
  });
}

function copyCompositionValue(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => copyCompositionValue(entry)));
  }
  if (value !== null && typeof value === 'object') {
    const copied = {};
    for (const key of Object.keys(value)) {
      copied[key] = copyCompositionValue(value[key]);
    }
    return Object.freeze(copied);
  }
  return value;
}

function assertInitialReconciliationWrite(result) {
  if (result.changes !== 1) {
    throw repositoryError('B3 capture-state initial reconciliation lost authority');
  }
}

function snapshotClosedRecord(value, expectedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw repositoryError(`B3 capture-state ${label} authority is invalid`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string') ||
      !isDeepStrictEqual([...keys].sort(), [...expectedKeys].sort())) {
    throw repositoryError(`B3 capture-state ${label} authority is invalid`);
  }
  const snapshot = {};
  for (const key of keys) snapshot[key] = value[key];
  return Object.freeze(snapshot);
}

function snapshotClosedDataRecord(value, expectedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw repositoryError(`B3 capture-state ${label} authority is invalid`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string') ||
      !isDeepStrictEqual([...keys].sort(), [...expectedKeys].sort())) {
    throw repositoryError(`B3 capture-state ${label} authority is invalid`);
  }
  const snapshot = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw repositoryError(`B3 capture-state ${label} authority is invalid`);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function snapshotScalarCommand(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw repositoryError(`B3 capture-state ${label} authority is invalid`);
  }
  const snapshot = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, 'value') ||
        !['string', 'number', 'boolean'].includes(typeof descriptor.value) &&
          descriptor.value !== null) {
      throw repositoryError(`B3 capture-state ${label} authority is invalid`);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function snapshotCommand(value, label = 'source command') {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw repositoryError(`B3 capture-state ${label} authority is invalid`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) {
    throw repositoryError(`B3 capture-state ${label} authority is invalid`);
  }
  const snapshot = {};
  for (const key of keys) snapshot[key] = value[key];
  return Object.freeze(snapshot);
}

function snapshotSource(rawSource) {
  const copied = snapshotClosedRecord(rawSource, SOURCE_KEYS, 'source');
  const command = snapshotCommand(copied.command);
  return Object.freeze({ ...copied, command });
}

function canonicaliseSource(copied, platform, buildAuthority) {
  const command = copied.command;
  const record = createB3IssuedCommandStateAuthority({
    platform,
    command,
    state: copied.state,
  });
  if (copied.schemaVersion !== record.schemaVersion || copied.platform !== platform ||
      !Number.isSafeInteger(copied.allocationSequence) || copied.allocationSequence <= 0 ||
      (copied.predecessorCommandSha256 !== null &&
        !HASH.test(copied.predecessorCommandSha256 ?? '')) ||
      copied.captureId !== record.command.captureId ||
      copied.commandSha256 !== record.commandSha256 ||
      copied.recordSha256 !== record.recordSha256 ||
      command.testedApplicationCommit !== buildAuthority.testedApplicationCommit ||
      command.applicationFingerprint !== buildAuthority.applicationFingerprint) {
    throw repositoryError('B3 capture-state source authority differs');
  }
  return Object.freeze({
    schemaVersion: record.schemaVersion,
    platform,
    allocationSequence: copied.allocationSequence,
    predecessorCommandSha256: copied.predecessorCommandSha256,
    captureId: copied.captureId,
    commandSha256: record.commandSha256,
    command: record.command,
    state: record.state,
    recordSha256: record.recordSha256,
  });
}

function canonicalBytes(value) {
  return Buffer.from(canonicaliseB3ProofValue(value), 'utf8');
}

function canonicaliseAllocationCommand(command, platform, buildAuthority) {
  const preparedRecord = createB3PreparedIssuedCommandAuthority({ platform, command });
  if (preparedRecord.command.testedApplicationCommit !==
        buildAuthority.testedApplicationCommit ||
      preparedRecord.command.applicationFingerprint !==
        buildAuthority.applicationFingerprint) {
    throw repositoryError('B3 capture-state allocation build authority differs');
  }
  if (preparedRecord.command.expectedSequence > 512) {
    throw repositoryError('B3 capture-state allocation observation sequence exceeds 512');
  }
  return Object.freeze({
    command: preparedRecord.command,
    commandSha256: preparedRecord.commandSha256,
    commandBytes: canonicalBytes(preparedRecord.command),
    preparedRecord,
    preparedRecordBytes: canonicalBytes(preparedRecord),
  });
}

function selectedSource(capture, source) {
  return capture.selectedCommands.find((candidate) =>
    isDeepStrictEqual(candidate, source));
}

function selectedDecision(capture, source) {
  return capture.selectedDecisions.find((decision) =>
    decision.source.state === source.state &&
    decision.source.recordSha256 === source.recordSha256);
}

function genericOutcome(kind, decision) {
  return Object.freeze({
    kind,
    commandSha256: decision.commandSha256,
    sourceState: decision.sourceState,
    claimSha256: decision.claimSha256,
  });
}

function stateRecord(source) {
  return Object.freeze({
    schemaVersion: source.schemaVersion,
    platform: source.platform,
    state: source.state,
    command: source.command,
    commandSha256: source.commandSha256,
    recordSha256: source.recordSha256,
  });
}

export async function openB3CaptureStateRepository(options) {
  const foundation = await openB3CaptureStateDatabase(options);
  const session = takeB3CaptureStateSession(foundation);
  if (!session) {
    await foundation.close();
    throw repositoryError('B3 capture-state internal session authority is absent');
  }

  function copyCompositionState(state) {
    return copyCompositionValue(state);
  }

  function readCompositionState(buildSource) {
    session.database.exec('BEGIN');
    try {
      const snapshot = copyCompositionState(
        session.validate(buildSource.buildAuthority),
      );
      session.database.exec('COMMIT');
      return snapshot;
    } catch (error) {
      if (session.database.isTransaction) session.database.exec('ROLLBACK');
      throw error;
    }
  }

  async function validateCompositionSteps(snapshot, buildSourceValue) {
    if (Array.isArray(snapshot.captures)) {
      const retainedCaptures = [];
      for (const capture of snapshot.captures) {
        retainedCaptures.push(Object.freeze({
          captureId: capture.capture.capture_id,
          steps: await validateCompositionSteps(capture, buildSourceValue),
        }));
      }
      return Object.freeze(retainedCaptures);
    }
    if (!Array.isArray(snapshot.steps)) return Object.freeze([]);
    const allocatedCommands = snapshot.allocatedCommands ?? snapshot.allCommands;
    const retained = [];
    let previousObservation;
    for (const row of snapshot.steps) {
      const allocated = allocatedCommands.find((candidate) =>
        candidate.commandSha256 === row.commandSha256);
      if (!allocated) {
        throw repositoryError('B3 capture-state retained step command is absent');
      }
      const step = await validateB3RetainedCaptureStep({
        platform: session.platform,
        command: allocated.command,
        buildSource: buildSourceValue,
        previousObservation,
        recordBytes: row.recordBytes,
        checkpointBytes: row.checkpointBytes,
      });
      if (step.recordSha256 !== row.recordSha256 ||
          step.observationSha256 !== row.observationSha256 ||
          step.checkpointBlobSha256 !== row.checkpointSha256) {
        throw repositoryError('B3 capture-state retained step semantic hashes differ');
      }
      retained.push(step);
      previousObservation = step.record.observation;
    }
    return Object.freeze(retained);
  }

  async function readCompositionPreflight() {
    const buildSource = await session.readBuildSourceFresh();
    const state = readCompositionState(buildSource);
    const retainedSteps = await validateCompositionSteps(state, buildSource.value);
    return Object.freeze({ buildSource, state, retainedSteps });
  }

  function assertBuildSourceUnchanged(left, right) {
    if (!isDeepStrictEqual(buildSourceSnapshot(left), buildSourceSnapshot(right))) {
      throw driftError('B3 capture-state build source changed during composition');
    }
  }

  function rereadCompositionState(preflight) {
    session.database.exec('BEGIN');
    try {
      const committedSource = session.readBuildSourceFreshSync();
      assertBuildSourceUnchanged(preflight.buildSource, committedSource);
      const committed = copyCompositionState(
        session.validate(committedSource.buildAuthority),
      );
      if (!isDeepStrictEqual(committed, preflight.state)) {
        throw driftError('B3 capture-state composition changed after preflight');
      }
      session.database.exec('COMMIT');
      return committed;
    } catch (error) {
      if (session.database.isTransaction) session.database.exec('ROLLBACK');
      throw error;
    }
  }

  function beginCompositionWriter(preflight) {
    session.database.exec('BEGIN IMMEDIATE');
    const committedSource = session.readBuildSourceFreshSync();
    assertBuildSourceUnchanged(preflight.buildSource, committedSource);
    const committed = copyCompositionState(
      session.validate(committedSource.buildAuthority),
    );
    if (!isDeepStrictEqual(committed, preflight.state)) {
      throw driftError('B3 capture-state composition changed before mutation');
    }
    return Object.freeze({
      buildAuthority: committedSource.buildAuthority,
      buildSource: committedSource,
      state: committed,
    });
  }

  function normaliseCompositionError(error, label) {
    if (error?.code === 'b3_capture_state_invalid') return error;
    if (error?.code === 'b3_issued_command_invalid') {
      return repositoryError(error.message);
    }
    return repositoryError(error?.message ?? `B3 capture-state ${label} failed`);
  }

  async function retryComposition(label, operation) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (session.database.isTransaction) session.database.exec('ROLLBACK');
        if (isRetryableDrift(error) && attempt < 3) continue;
        throw normaliseCompositionError(error, label);
      }
    }
    throw repositoryError(`B3 capture-state ${label} attempt bound exceeded`);
  }

  function insertSelectedDecision(proposal, source, state) {
    let inserted;
    if (proposal.winnerKind === 'ordinary') {
      inserted = session.database.prepare(`
        INSERT INTO b3_decisions (
          command_sha256, source_state, source_record_sha256, winner_kind,
          next_state, next_record_json, next_record_sha256,
          claim_json, claim_sha256
        ) VALUES (?, ?, ?, 'ordinary', ?, ?, ?, ?, ?)
        ON CONFLICT (command_sha256, source_state) DO NOTHING
      `).run(
        source.commandSha256,
        source.state,
        source.recordSha256,
        proposal.next.state,
        canonicalBytes(proposal.next),
        proposal.next.recordSha256,
        canonicalBytes(proposal.claim),
        proposal.claim.claimSha256,
      );
    } else {
      inserted = session.database.prepare(`
        INSERT INTO b3_decisions (
          command_sha256, source_state, source_record_sha256, winner_kind,
          next_state, next_record_json, next_record_sha256,
          claim_json, claim_sha256
        ) VALUES (?, ?, ?, 'generic-consumption', NULL, NULL, NULL, ?, ?)
        ON CONFLICT (command_sha256, source_state) DO NOTHING
      `).run(
        source.commandSha256,
        source.state,
        source.recordSha256,
        canonicalBytes(proposal.claim),
        proposal.claim.claimSha256,
      );
      if (inserted.changes === 0) return false;
      const cleared = session.database.prepare(`
        UPDATE b3_authority_state
        SET active_command_sha256 = NULL, row_version = row_version + 1
        WHERE singleton = 1 AND active_command_sha256 = ?
          AND reserved_start_command_sha256 IS NULL AND row_version = ?
      `).run(source.commandSha256, state.authority.row_version);
      if (cleared.changes !== 1) {
        throw repositoryError('B3 capture-state command decision lost active authority');
      }
    }
    if (inserted.changes === 0) return false;
    if (inserted.changes !== 1) {
      throw repositoryError('B3 capture-state command decision lost selection authority');
    }
    return true;
  }

  function selectCommandDecision({ source, preflight, proposal }) {
    try {
      const writer = beginCompositionWriter(preflight);
      let state = writer.state;
      let capture = state.workingCapture;
      if (state.kind !== 'working' || !capture || !selectedSource(capture, source)) {
        throw repositoryError('B3 capture-state command decision source is not selected');
      }
      let decision = selectedDecision(capture, source);
      if (decision) {
        session.database.exec('COMMIT');
        return Object.freeze({ selected: false, decision });
      }
      if (!capture.activeCommand || !isDeepStrictEqual(capture.activeCommand, source)) {
        throw repositoryError('B3 capture-state command decision source is not active');
      }
      const inserted = insertSelectedDecision(proposal, source, state);
      state = session.validate(writer.buildAuthority);
      capture = state.workingCapture;
      decision = capture && selectedDecision(capture, source);
      if (!inserted) {
        if (!decision) {
          throw repositoryError('B3 capture-state command decision conflict did not rederive');
        }
        session.database.exec('COMMIT');
        return Object.freeze({ selected: false, decision });
      }
      if (!decision || decision.winnerKind !== proposal.winnerKind ||
          decision.claimSha256 !== proposal.claim.claimSha256 ||
          (proposal.winnerKind === 'ordinary' &&
            decision.command.recordSha256 !== proposal.next.recordSha256) ||
          (proposal.winnerKind === 'generic-consumption' &&
            capture.activeCommand !== null)) {
        throw repositoryError('B3 capture-state command decision did not rederive');
      }
      session.database.exec('COMMIT');
      return Object.freeze({ selected: true, decision });
    } catch (error) {
      if (session.database.isTransaction) session.database.exec('ROLLBACK');
      throw error;
    }
  }

  function reserveInitialCaptureStartProposal(proposal, buildSource, allowReady) {
    session.database.exec('BEGIN IMMEDIATE');
    try {
      const committedSource = session.readBuildSourceFreshSync();
      assertBuildSourceUnchanged(buildSource, committedSource);
      let state = session.validate(committedSource.buildAuthority);
      let wonReservation = false;
      if (state.kind === 'empty') {
        const inserted = session.database.prepare(`
          INSERT INTO b3_capture_start_intents (
            start_intent_sha256, intent_kind, recovered_command_sha256,
            terminal_claim_sha256, capture_id, first_command_sha256,
            first_command_json, first_prepared_record_json,
            first_prepared_record_sha256, intent_state, row_version
          ) VALUES (?, 'initial', NULL, NULL, ?, ?, ?, ?, ?, 'pending', 1)
        `).run(
          proposal.startIntentSha256,
          proposal.captureId,
          proposal.firstCommandSha256,
          proposal.commandBytes,
          proposal.preparedRecordBytes,
          proposal.firstPreparedRecordSha256,
        );
        const reserved = session.database.prepare(`
          UPDATE b3_authority_state
          SET reserved_start_command_sha256 = ?, row_version = row_version + 1
          WHERE singleton = 1 AND next_allocation_sequence = 1
            AND active_command_sha256 IS NULL
            AND reserved_start_command_sha256 IS NULL AND row_version = 1
        `).run(proposal.firstCommandSha256);
        if (inserted.changes !== 1 || reserved.changes !== 1) {
          throw repositoryError('B3 capture-state initial reservation write lost authority');
        }
        state = session.validate(committedSource.buildAuthority);
        wonReservation = true;
      }
      const readyInitial = state.kind === 'working' &&
        state.captures.length === 1 &&
        state.workingCapture?.startIntent.intentKind === 'initial';
      if (state.kind !== 'pending-initial' && !(allowReady && readyInitial)) {
        throw repositoryError('B3 capture-state initial reservation cannot proceed');
      }
      const winner = state.kind === 'pending-initial'
        ? state.pendingStartIntent
        : state.workingCapture.startIntent;
      const kind = wonReservation
        ? 'won-reservation'
        : (winner.startIntentSha256 === proposal.startIntentSha256
            ? 'same-winner'
            : 'different-winner');
      session.database.exec('COMMIT');
      return Object.freeze({
        kind,
        capture: publicB3CaptureStartAuthority(winner),
      });
    } catch (error) {
      if (session.database.isTransaction) session.database.exec('ROLLBACK');
      throw error;
    }
  }

  async function reserveInitialCaptureStart(reservationOptions) {
    if (session.isClosed()) {
      throw repositoryError('B3 capture-state repository is already closed');
    }
    const reservationKeys = reservationOptions && typeof reservationOptions === 'object'
      ? Object.keys(reservationOptions)
      : [];
    if (reservationKeys.length !== 1 || reservationKeys[0] !== 'command') {
      throw repositoryError('B3 capture-state initial reservation authority is invalid');
    }
    const rawCommand = reservationOptions.command;
    const buildSource = await session.readBuildSourceFresh();
    const proposal = createB3InitialCaptureStartAuthority({
      platform: session.platform,
      command: rawCommand,
      buildAuthority: buildSource.buildAuthority,
    });
    return reserveInitialCaptureStartProposal(proposal, buildSource, false).capture;
  }

  async function reconcileInitialCaptureStart(reconciliationOptions) {
    if (session.isClosed()) {
      throw repositoryError('B3 capture-state repository is already closed');
    }
    const options = snapshotClosedRecord(
      reconciliationOptions,
      ['command'],
      'initial reconciliation',
    );
    const commandSnapshot = snapshotCommand(options.command, 'initial command');
    return retryComposition('initial reconciliation', async () => {
      const preflight = await readCompositionPreflight();
      const proposal = createB3InitialCaptureStartAuthority({
        platform: session.platform,
        command: commandSnapshot,
        buildAuthority: preflight.buildSource.buildAuthority,
      });
      if (preflight.state.kind === 'working') {
        const ready = preflight.state.workingCapture;
        if (preflight.state.captures.length !== 1 ||
            ready?.startIntent.intentKind !== 'initial') {
          throw repositoryError('B3 capture-state initial reconciliation cannot proceed');
        }
        const confirmed = rereadCompositionState(preflight);
        return Object.freeze({
          kind: confirmed.workingCapture.startIntent.startIntentSha256 ===
            proposal.startIntentSha256
            ? 'same-winner'
            : 'different-winner',
          capture: publicB3CaptureStartAuthority(confirmed.workingCapture.startIntent),
        });
      }
      const reservation = reserveInitialCaptureStartProposal(
        proposal,
        preflight.buildSource,
        true,
      );

      const reconciliationSource = await session.readBuildSourceFresh();
      session.database.exec('BEGIN IMMEDIATE');
      let state;
      try {
        const committedSource = session.readBuildSourceFreshSync();
        assertBuildSourceUnchanged(reconciliationSource, committedSource);
        state = session.validate(committedSource.buildAuthority);
        if (state.kind === 'pending-initial') {
          const start = state.pendingStartIntent;
          const insertedCapture = session.database.prepare(`
            INSERT INTO b3_captures (
              capture_id, start_intent_sha256, capture_state, row_version
            ) VALUES (?, ?, 'working', 1)
          `).run(start.captureId, start.startIntentSha256);
          assertInitialReconciliationWrite(insertedCapture);
          const insertedCommand = session.database.prepare(`
            INSERT INTO b3_commands (
              command_sha256, allocation_sequence, predecessor_command_sha256,
              command_json, prepared_record_json, prepared_record_sha256, capture_id,
              expected_observation_sequence, previous_observation_sha256
            ) VALUES (?, 1, NULL, ?, ?, ?, ?, ?, ?)
          `).run(
            start.firstCommandSha256,
            start.commandBytes,
            start.preparedRecordBytes,
            start.firstPreparedRecordSha256,
            start.captureId,
            start.firstCommand.expectedSequence,
            start.firstCommand.previousObservationSha256,
          );
          assertInitialReconciliationWrite(insertedCommand);
          const advanced = session.database.prepare(`
            UPDATE b3_authority_state
            SET next_allocation_sequence = 2, active_command_sha256 = ?,
              reserved_start_command_sha256 = NULL, row_version = row_version + 1
            WHERE singleton = 1 AND next_allocation_sequence = 1
              AND active_command_sha256 IS NULL
              AND reserved_start_command_sha256 = ? AND row_version = 2
          `).run(start.firstCommandSha256, start.firstCommandSha256);
          assertInitialReconciliationWrite(advanced);
          const readied = session.database.prepare(`
            UPDATE b3_capture_start_intents
            SET intent_state = 'ready', row_version = row_version + 1
            WHERE start_intent_sha256 = ? AND intent_state = 'pending' AND row_version = 1
          `).run(start.startIntentSha256);
          assertInitialReconciliationWrite(readied);
          state = session.validate(committedSource.buildAuthority);
        }
        if (state.kind !== 'working' ||
            state.workingCapture.startIntent.startIntentSha256 !==
              reservation.capture.startIntentSha256) {
          throw repositoryError('B3 capture-state initial reconciliation did not rederive');
        }
        session.database.exec('COMMIT');
      } catch (error) {
        if (session.database.isTransaction) session.database.exec('ROLLBACK');
        throw error;
      }
      const completed = await readCompositionPreflight();
      if (completed.state.kind !== 'working' ||
          completed.state.workingCapture.startIntent.startIntentSha256 !==
            reservation.capture.startIntentSha256) {
        throw driftError('B3 capture-state initial reconciliation changed after commit');
      }
      return Object.freeze({
        kind: reservation.kind,
        capture: publicB3CaptureStartAuthority(completed.state.workingCapture.startIntent),
      });
    });
  }

  async function readActiveCommand(...readOptions) {
    if (session.isClosed()) {
      throw repositoryError('B3 capture-state repository is already closed');
    }
    if (readOptions.length !== 0) {
      throw repositoryError('B3 capture-state read authority is invalid');
    }
    return retryComposition('active-command read', async () => {
      const { state } = await readCompositionPreflight();
      let result;
      if (state.kind === 'empty') {
        result = Object.freeze({ kind: 'none' });
      } else if (state.kind === 'pending-initial') {
        result = Object.freeze({
          kind: 'start-reserved',
          intent: publicB3CaptureStartAuthority(state.pendingStartIntent),
        });
      } else if (state.kind === 'working') {
        result = state.workingCapture.activeCommand === null
          ? Object.freeze({ kind: 'none' })
          : Object.freeze({ kind: 'active', command: state.workingCapture.activeCommand });
      } else if (state.kind === 'archived-recovery-pending-terminal' ||
          state.kind === 'terminal-pending-recovery-fresh') {
        result = Object.freeze({ kind: 'recovery-pending' });
      } else {
        throw repositoryError('B3 capture-state read authority is unsupported');
      }
      return result;
    });
  }

  function recoveryDistributionBuildAuthority(buildSource) {
    return Object.freeze({
      testedApplicationCommit: buildSource.value.testedApplicationCommit,
      applicationFingerprint: buildSource.value.applicationFingerprint,
      versionName: buildSource.value.versionName,
      buildNumber: session.platform === 'ios'
        ? buildSource.value.iosBuildNumber
        : buildSource.value.androidVersionCode,
    });
  }

  function validateRecoveryAttemptAuthorities({ distribution, freshCommand, buildSource }) {
    try {
      const retainedDistribution = validateB3DistributionProjection({
        value: distribution,
        platform: session.platform,
        buildAuthority: recoveryDistributionBuildAuthority(buildSource),
      });
      const retainedCommand = validateB3RecoveryFreshCommandAuthority({
        platform: session.platform,
        command: freshCommand,
        buildAuthority: buildSource.buildAuthority,
      });
      return Object.freeze({
        distribution: copyCompositionValue(retainedDistribution),
        freshCommand: retainedCommand,
      });
    } catch (error) {
      if (error?.code === 'b3_capture_state_invalid') throw error;
      throw repositoryError(error?.message ?? 'B3 recovery attempt authority differs');
    }
  }

  async function readRecoveryInvocationPin(...pinOptions) {
    if (session.isClosed()) {
      throw repositoryError('B3 capture-state repository is already closed');
    }
    if (pinOptions.length !== 0) {
      throw repositoryError('B3 recovery invocation pin authority is invalid');
    }
    const { state } = await readCompositionPreflight();
    if (state.kind === 'empty') return Object.freeze({ kind: 'empty' });
    if (state.kind === 'pending-initial') {
      return Object.freeze({
        kind: 'pending-initial',
        startIntentSha256: state.pendingStartIntent.startIntentSha256,
        firstCommandSha256: state.pendingStartIntent.firstCommandSha256,
      });
    }
    if (state.kind === 'archived-recovery-pending-terminal' ||
        state.kind === 'terminal-pending-recovery-fresh') {
      const capture = state.captures.at(-1);
      return Object.freeze({
        kind: 'recovery-pending',
        phase: state.kind === 'archived-recovery-pending-terminal'
          ? 'archive'
          : 'terminal',
        captureId: capture.capture.capture_id,
        startIntentSha256: capture.startIntent.startIntentSha256,
        commandSha256: capture.allocatedCommands.at(-1).commandSha256,
        ownerClaimSha256: capture.recovery.owner.ownerClaimSha256,
        terminalClaimSha256: capture.recovery.terminal?.terminalClaimSha256 ?? null,
      });
    }
    const capture = state.workingCapture;
    if (!capture) throw repositoryError('B3 recovery invocation working capture is absent');
    const previous = state.captures.at(-2) ?? null;
    if (capture.startIntent.intentKind === 'recovery-fresh' &&
        capture.allocatedCommands.length === 1 && capture.selectedDecisions.length === 0 &&
        capture.steps.length === 0 && capture.activeCommand?.state === 'prepared' &&
        previous?.recovery?.terminal &&
        capture.startIntent.recoveredCommandSha256 ===
          previous.allocatedCommands.at(-1).commandSha256 &&
        capture.startIntent.terminalClaimSha256 ===
          previous.recovery.terminal.terminalClaimSha256) {
      return Object.freeze({
        kind: 'recovery-pending',
        phase: 'ready',
        captureId: previous.capture.capture_id,
        startIntentSha256: previous.startIntent.startIntentSha256,
        commandSha256: previous.allocatedCommands.at(-1).commandSha256,
        ownerClaimSha256: previous.recovery.owner.ownerClaimSha256,
        terminalClaimSha256: previous.recovery.terminal.terminalClaimSha256,
      });
    }
    if (capture.activeCommand === null) {
      return Object.freeze({
        kind: 'working-empty',
        captureId: capture.capture.capture_id,
        startIntentSha256: capture.startIntent.startIntentSha256,
        tailCommandSha256: capture.tailCommand.commandSha256,
        tailState: capture.tailCommand.state,
        tailRecordSha256: capture.tailCommand.recordSha256,
      });
    }
    return Object.freeze({
      kind: 'active',
      captureId: capture.capture.capture_id,
      startIntentSha256: capture.startIntent.startIntentSha256,
      source: copyCompositionValue(capture.activeCommand),
    });
  }

  function recoveryCaptureForPin(state, pin) {
    return state.captures.find((capture) =>
      capture.capture.capture_id === pin.captureId &&
      capture.startIntent.startIntentSha256 === pin.startIntentSha256 &&
      capture.allocatedCommands.at(-1)?.commandSha256 ===
        (pin.kind === 'active' ? pin.source.commandSha256 : pin.commandSha256)) ?? null;
  }

  function terminalBoundSuccessor(state, capture) {
    const index = state.captures.indexOf(capture);
    const terminal = capture.recovery?.terminal;
    if (!terminal) return null;
    const next = state.captures[index + 1] ?? null;
    if (next && next.startIntent.intentKind === 'recovery-fresh' &&
        next.startIntent.recoveredCommandSha256 ===
          capture.allocatedCommands.at(-1).commandSha256 &&
        next.startIntent.terminalClaimSha256 === terminal.terminalClaimSha256) {
      return next;
    }
    return null;
  }

  function resolvePinnedRecoveryLineage(state, pin) {
    if (pin.kind === 'empty') {
      return Object.freeze({ kind: state.kind === 'empty' ? 'non-recovery' : 'rejected' });
    }
    if (pin.kind === 'pending-initial') {
      const retained = state.kind === 'pending-initial' &&
        state.pendingStartIntent.startIntentSha256 === pin.startIntentSha256 &&
        state.pendingStartIntent.firstCommandSha256 === pin.firstCommandSha256;
      return Object.freeze({ kind: retained ? 'non-recovery' : 'rejected' });
    }
    if (pin.kind === 'working-empty') {
      const capture = state.captures.find((candidate) =>
        candidate.capture.capture_id === pin.captureId &&
        candidate.startIntent.startIntentSha256 === pin.startIntentSha256);
      const retained = state.kind === 'working' && capture === state.workingCapture &&
        capture.activeCommand === null &&
        capture.tailCommand.commandSha256 === pin.tailCommandSha256 &&
        capture.tailCommand.state === pin.tailState &&
        capture.tailCommand.recordSha256 === pin.tailRecordSha256;
      return Object.freeze({ kind: retained ? 'non-recovery' : 'rejected' });
    }
    if (pin.kind === 'recovery-pending') {
      const capture = recoveryCaptureForPin(state, pin);
      if (!capture || capture.capture.capture_state !== 'abandoned' ||
          capture.recovery?.owner.ownerClaimSha256 !== pin.ownerClaimSha256) {
        return Object.freeze({ kind: 'rejected' });
      }
      const successor = terminalBoundSuccessor(state, capture);
      if (successor) return Object.freeze({ kind: 'successor', capture, successor });
      if (capture.recovery.terminal) {
        if (state.pendingStartIntent?.recoveredCommandSha256 !== pin.commandSha256 ||
            state.pendingStartIntent.terminalClaimSha256 !==
              capture.recovery.terminal.terminalClaimSha256) {
          return Object.freeze({ kind: 'rejected' });
        }
        return Object.freeze({ kind: 'terminal', capture });
      }
      return Object.freeze({ kind: 'archive', capture });
    }
    if (pin.kind !== 'active') return Object.freeze({ kind: 'rejected' });
    const capture = recoveryCaptureForPin(state, pin);
    if (!capture) return Object.freeze({ kind: 'rejected' });
    if (pin.source.state !== 'restart-required') {
      if (capture.capture.capture_state !== 'working') {
        return Object.freeze({ kind: 'rejected' });
      }
      const current = capture.activeCommand;
      if (!current || current.commandSha256 !== pin.source.commandSha256 ||
          current.captureId !== pin.source.captureId) {
        return Object.freeze({ kind: 'rejected' });
      }
      if (current.state === 'restart-required') {
        return Object.freeze({ kind: 'rejected' });
      }
      return Object.freeze({
        kind: ['launching', 'reinstall-launching', 'stop-executing']
          .includes(current.state) ? 'rejected' : 'non-recovery',
      });
    }
    if (capture.capture.capture_state === 'abandoned') {
      if (!capture.recoveryOwner ||
          !isDeepStrictEqual(capture.recoveryOwner.source, pin.source)) {
        return Object.freeze({ kind: 'rejected' });
      }
      const successor = terminalBoundSuccessor(state, capture);
      if (successor) return Object.freeze({ kind: 'successor', capture, successor });
      if (capture.recovery.terminal) {
        if (state.pendingStartIntent?.recoveredCommandSha256 !==
              pin.source.commandSha256 ||
            state.pendingStartIntent.terminalClaimSha256 !==
              capture.recovery.terminal.terminalClaimSha256) {
          return Object.freeze({ kind: 'rejected' });
        }
        return Object.freeze({ kind: 'terminal', capture });
      }
      return Object.freeze({ kind: 'archive', capture });
    }
    const decision = selectedDecision(capture, pin.source);
    if (decision) {
      return Object.freeze({
        kind: decision.winnerKind === 'ordinary' ? 'ordinary-winner' : 'rejected',
      });
    }
    if (!isDeepStrictEqual(capture.activeCommand, pin.source)) {
      return Object.freeze({ kind: 'rejected' });
    }
    return Object.freeze({ kind: 'unowned', capture });
  }

  function beginRecoveryWriter(preflight, distribution, freshCommand) {
    const writer = beginCompositionWriter(preflight);
    const authorities = validateRecoveryAttemptAuthorities({
      distribution,
      freshCommand,
      buildSource: writer.buildSource,
    });
    return Object.freeze({ ...writer, authorities });
  }

  function recoveryOwnerDecisionSnapshot(owner) {
    return Object.freeze({
      commandSha256: owner.commandSha256,
      sourceState: owner.sourceState,
      sourceRecordSha256: owner.sourceRecordSha256,
      winnerKind: 'recovery-owner',
      nextState: owner.nextState,
      nextRecordSha256: owner.nextRecordSha256,
      claimSha256: owner.ownerClaimSha256,
    });
  }

  async function ensureRecoveryArchive({
    pin,
    acknowledgeReinstall,
    distribution,
    freshCommand,
  }) {
    return retryComposition('recovery archive', async () => {
      const preflight = await readCompositionPreflight();
      validateRecoveryAttemptAuthorities({
        distribution,
        freshCommand,
        buildSource: preflight.buildSource,
      });
      const resolution = resolvePinnedRecoveryLineage(preflight.state, pin);
      if (resolution.kind !== 'unowned') {
        return Object.freeze({ committed: false, resolution });
      }
      if (!acknowledgeReinstall) {
        return Object.freeze({ committed: false, resolution: Object.freeze({
          kind: 'operator-required',
        }) });
      }
      const writer = beginRecoveryWriter(preflight, distribution, freshCommand);
      const retained = resolvePinnedRecoveryLineage(writer.state, pin);
      if (retained.kind !== 'unowned') throw driftError(
        'B3 recovery archive lineage changed before mutation',
      );
      const capture = retained.capture;
      const owner = createB3RecoveryOwnerClaimAuthority({
        platform: session.platform,
        source: stateRecord(pin.source),
      });
      const insertedDecision = session.database.prepare(`
        INSERT INTO b3_decisions (
          command_sha256, source_state, source_record_sha256, winner_kind,
          next_state, next_record_json, next_record_sha256,
          claim_json, claim_sha256
        ) VALUES (?, 'restart-required', ?, 'recovery-owner',
          'restart-executing', ?, ?, ?, ?)
        ON CONFLICT (command_sha256, source_state) DO NOTHING
      `).run(
        pin.source.commandSha256,
        pin.source.recordSha256,
        owner.nextRecordBytes,
        owner.nextRecordSha256,
        owner.claimBytes,
        owner.ownerClaimSha256,
      );
      if (insertedDecision.changes !== 1) {
        throw driftError('B3 recovery archive owner decision lost selection');
      }
      const abandoned = session.database.prepare(`
        UPDATE b3_captures
        SET capture_state = 'abandoned', row_version = 2
        WHERE capture_id = ? AND start_intent_sha256 = ?
          AND capture_state = 'working' AND row_version = 1
      `).run(capture.capture.capture_id, capture.startIntent.startIntentSha256);
      if (abandoned.changes !== 1) {
        throw repositoryError('B3 recovery archive capture write lost authority');
      }
      const cleared = session.database.prepare(`
        UPDATE b3_authority_state
        SET active_command_sha256 = NULL, row_version = row_version + 1
        WHERE singleton = 1 AND active_command_sha256 = ?
          AND reserved_start_command_sha256 IS NULL AND row_version = ?
      `).run(pin.source.commandSha256, writer.state.authority.row_version);
      if (cleared.changes !== 1) {
        throw repositoryError('B3 recovery archive active clear lost authority');
      }
      const snapshot = createB3CaptureSnapshotAuthority({
        platform: session.platform,
        captureId: capture.capture.capture_id,
        startIntentSha256: capture.startIntent.startIntentSha256,
        captureState: 'abandoned',
        captureRowVersion: 2,
        testedApplicationCommit: writer.buildAuthority.testedApplicationCommit,
        applicationFingerprint: writer.buildAuthority.applicationFingerprint,
        commands: capture.snapshotCommands,
        decisions: Object.freeze([
          ...capture.snapshotDecisions,
          recoveryOwnerDecisionSnapshot(owner),
        ]),
        steps: capture.snapshotSteps,
      });
      const terminalStep = capture.steps.at(-1);
      const manifest = createB3RecoveryManifestAuthority({
        platform: session.platform,
        captureId: capture.capture.capture_id,
        commandSha256: pin.source.commandSha256,
        ownerClaimSha256: owner.ownerClaimSha256,
        captureSnapshotSha256: snapshot.captureSnapshotSha256,
        observationCount: capture.steps.length,
        terminalObservationSha256: terminalStep?.observationSha256 ?? '0'.repeat(64),
      });
      const archive = createB3RecoveryArchiveAuthority({
        platform: session.platform,
        captureId: capture.capture.capture_id,
        commandSha256: pin.source.commandSha256,
        ownerClaimSha256: owner.ownerClaimSha256,
        captureSnapshotSha256: snapshot.captureSnapshotSha256,
        manifestSha256: manifest.manifestSha256,
        testedApplicationCommit: writer.buildAuthority.testedApplicationCommit,
        applicationFingerprint: writer.buildAuthority.applicationFingerprint,
      });
      session.database.prepare(`
        INSERT INTO b3_recoveries (
          command_sha256, owner_kind, owner_claim_sha256, capture_id,
          capture_snapshot_sha256, row_version
        ) VALUES (?, 'recovery-owner', ?, ?, ?, 1)
      `).run(
        pin.source.commandSha256,
        owner.ownerClaimSha256,
        capture.capture.capture_id,
        snapshot.captureSnapshotSha256,
      );
      session.database.prepare(`
        INSERT INTO b3_recovery_manifests (
          command_sha256, owner_claim_sha256, capture_snapshot_sha256,
          manifest_json, manifest_sha256
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        pin.source.commandSha256,
        owner.ownerClaimSha256,
        snapshot.captureSnapshotSha256,
        manifest.manifestBytes,
        manifest.manifestSha256,
      );
      session.database.prepare(`
        INSERT INTO b3_recovery_authorities (
          command_sha256, owner_claim_sha256, capture_snapshot_sha256,
          manifest_sha256, authority_json, authority_sha256
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        pin.source.commandSha256,
        owner.ownerClaimSha256,
        snapshot.captureSnapshotSha256,
        manifest.manifestSha256,
        archive.authorityBytes,
        archive.archiveAuthoritySha256,
      );
      const state = session.validate(writer.buildAuthority);
      if (state.kind !== 'archived-recovery-pending-terminal') {
        throw repositoryError('B3 recovery archive did not rederive');
      }
      const resolved = resolvePinnedRecoveryLineage(state, pin);
      if (resolved.kind !== 'archive') {
        throw repositoryError('B3 recovery archive lineage did not rederive');
      }
      session.database.exec('COMMIT');
      return Object.freeze({ committed: true, resolution: resolved });
    });
  }

  async function ensureRecoveryTerminalReservation({ pin, distribution, freshCommand }) {
    return retryComposition('recovery terminal reservation', async () => {
      const preflight = await readCompositionPreflight();
      const authorities = validateRecoveryAttemptAuthorities({
        distribution,
        freshCommand,
        buildSource: preflight.buildSource,
      });
      const resolution = resolvePinnedRecoveryLineage(preflight.state, pin);
      if (resolution.kind !== 'archive') {
        return Object.freeze({ committed: false, resolution });
      }
      const writer = beginRecoveryWriter(preflight, distribution, freshCommand);
      const retained = resolvePinnedRecoveryLineage(writer.state, pin);
      if (retained.kind !== 'archive') throw driftError(
        'B3 recovery terminal lineage changed before mutation',
      );
      const capture = retained.capture;
      const recovery = capture.recovery;
      const terminal = createB3RecoveryTerminalAuthority({
        platform: session.platform,
        source: recovery.owner.nextRecord,
        ownerClaimSha256: recovery.owner.ownerClaimSha256,
        captureSnapshotSha256: recovery.snapshot.captureSnapshotSha256,
        manifestSha256: recovery.manifest.manifestSha256,
        archiveAuthoritySha256: recovery.archive.archiveAuthoritySha256,
      });
      const start = createB3RecoveryFreshCaptureStartAuthority({
        platform: session.platform,
        command: authorities.freshCommand.command,
        buildAuthority: writer.buildAuthority,
        recoveredCommandSha256: terminal.commandSha256,
        terminalClaimSha256: terminal.terminalClaimSha256,
      });
      session.database.prepare(`
        INSERT INTO b3_decisions (
          command_sha256, source_state, source_record_sha256, winner_kind,
          next_state, next_record_json, next_record_sha256,
          claim_json, claim_sha256
        ) VALUES (?, 'restart-executing', ?, 'recovery-terminal',
          'restart-complete', ?, ?, ?, ?)
      `).run(
        terminal.commandSha256,
        terminal.sourceRecordSha256,
        terminal.terminalRecordBytes,
        terminal.terminalRecordSha256,
        terminal.terminalClaimBytes,
        terminal.terminalClaimSha256,
      );
      session.database.prepare(`
        INSERT INTO b3_recovery_terminals (
          command_sha256, owner_claim_sha256, capture_snapshot_sha256,
          manifest_sha256, authority_sha256, terminal_kind,
          terminal_record_json, terminal_record_sha256,
          terminal_claim_json, terminal_claim_sha256
        ) VALUES (?, ?, ?, ?, ?, 'recovery-terminal', ?, ?, ?, ?)
      `).run(
        terminal.commandSha256,
        terminal.ownerClaimSha256,
        terminal.captureSnapshotSha256,
        terminal.manifestSha256,
        terminal.archiveAuthoritySha256,
        terminal.terminalRecordBytes,
        terminal.terminalRecordSha256,
        terminal.terminalClaimBytes,
        terminal.terminalClaimSha256,
      );
      session.database.prepare(`
        INSERT INTO b3_capture_start_intents (
          start_intent_sha256, intent_kind, recovered_command_sha256,
          terminal_claim_sha256, capture_id, first_command_sha256,
          first_command_json, first_prepared_record_json,
          first_prepared_record_sha256, intent_state, row_version
        ) VALUES (?, 'recovery-fresh', ?, ?, ?, ?, ?, ?, ?, 'pending', 1)
      `).run(
        start.startIntentSha256,
        start.recoveredCommandSha256,
        start.terminalClaimSha256,
        start.captureId,
        start.firstCommandSha256,
        start.commandBytes,
        start.preparedRecordBytes,
        start.firstPreparedRecordSha256,
      );
      const reserved = session.database.prepare(`
        UPDATE b3_authority_state
        SET reserved_start_command_sha256 = ?, row_version = row_version + 1
        WHERE singleton = 1 AND active_command_sha256 IS NULL
          AND reserved_start_command_sha256 IS NULL AND row_version = ?
      `).run(start.firstCommandSha256, writer.state.authority.row_version);
      if (reserved.changes !== 1) {
        throw repositoryError('B3 recovery terminal reservation lost authority');
      }
      const state = session.validate(writer.buildAuthority);
      if (state.kind !== 'terminal-pending-recovery-fresh' ||
          state.pendingStartIntent.startIntentSha256 !== start.startIntentSha256 ||
          state.captures.at(-1).recovery.snapshot.captureSnapshotSha256 !==
            recovery.snapshot.captureSnapshotSha256) {
        throw repositoryError('B3 recovery terminal reservation did not rederive');
      }
      const resolved = resolvePinnedRecoveryLineage(state, pin);
      if (resolved.kind !== 'terminal') {
        throw repositoryError('B3 recovery terminal lineage did not rederive');
      }
      session.database.exec('COMMIT');
      return Object.freeze({ committed: true, resolution: resolved });
    });
  }

  async function ensureRecoveryFreshCapture({ pin, distribution, freshCommand }) {
    return retryComposition('recovery fresh reconciliation', async () => {
      const preflight = await readCompositionPreflight();
      validateRecoveryAttemptAuthorities({
        distribution,
        freshCommand,
        buildSource: preflight.buildSource,
      });
      const resolution = resolvePinnedRecoveryLineage(preflight.state, pin);
      if (resolution.kind !== 'terminal') {
        return Object.freeze({ committed: false, resolution });
      }
      const writer = beginRecoveryWriter(preflight, distribution, freshCommand);
      const retained = resolvePinnedRecoveryLineage(writer.state, pin);
      if (retained.kind !== 'terminal') throw driftError(
        'B3 recovery fresh lineage changed before mutation',
      );
      const start = writer.state.pendingStartIntent;
      const allocationSequence = writer.state.authority.next_allocation_sequence;
      const insertedCapture = session.database.prepare(`
        INSERT INTO b3_captures (
          capture_id, start_intent_sha256, capture_state, row_version
        ) VALUES (?, ?, 'working', 1)
      `).run(start.captureId, start.startIntentSha256);
      assertInitialReconciliationWrite(insertedCapture);
      const insertedCommand = session.database.prepare(`
        INSERT INTO b3_commands (
          command_sha256, allocation_sequence, predecessor_command_sha256,
          command_json, prepared_record_json, prepared_record_sha256, capture_id,
          expected_observation_sequence, previous_observation_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
      `).run(
        start.firstCommandSha256,
        allocationSequence,
        start.recoveredCommandSha256,
        start.commandBytes,
        start.preparedRecordBytes,
        start.firstPreparedRecordSha256,
        start.captureId,
        '0'.repeat(64),
      );
      assertInitialReconciliationWrite(insertedCommand);
      const advanced = session.database.prepare(`
        UPDATE b3_authority_state
        SET next_allocation_sequence = next_allocation_sequence + 1,
          active_command_sha256 = ?, reserved_start_command_sha256 = NULL,
          row_version = row_version + 1
        WHERE singleton = 1 AND next_allocation_sequence = ?
          AND active_command_sha256 IS NULL
          AND reserved_start_command_sha256 = ? AND row_version = ?
      `).run(
        start.firstCommandSha256,
        allocationSequence,
        start.firstCommandSha256,
        writer.state.authority.row_version,
      );
      assertInitialReconciliationWrite(advanced);
      const readied = session.database.prepare(`
        UPDATE b3_capture_start_intents
        SET intent_state = 'ready', row_version = 2
        WHERE start_intent_sha256 = ? AND intent_kind = 'recovery-fresh'
          AND intent_state = 'pending' AND row_version = 1
      `).run(start.startIntentSha256);
      assertInitialReconciliationWrite(readied);
      const state = session.validate(writer.buildAuthority);
      const resolved = resolvePinnedRecoveryLineage(state, pin);
      if (state.kind !== 'working' || resolved.kind !== 'successor' ||
          resolved.successor.startIntent.startIntentSha256 !== start.startIntentSha256) {
        throw repositoryError('B3 recovery fresh reconciliation did not rederive');
      }
      session.database.exec('COMMIT');
      return Object.freeze({ committed: true, resolution: resolved });
    });
  }

  async function finaliseRecoveryInvocation(finaliseOptions) {
    if (session.isClosed()) {
      throw repositoryError('B3 capture-state repository is already closed');
    }
    const options = snapshotClosedRecord(finaliseOptions, [
      'pin', 'acknowledgeReinstall', 'distribution', 'freshCommand',
    ], 'recovery finalisation');
    if (typeof options.acknowledgeReinstall !== 'boolean') {
      throw repositoryError('B3 recovery acknowledgement authority is invalid');
    }
    const pin = options.pin;
    const archive = await ensureRecoveryArchive({
      pin,
      acknowledgeReinstall: options.acknowledgeReinstall,
      distribution: options.distribution,
      freshCommand: options.freshCommand,
    });
    if (archive.resolution.kind === 'operator-required') {
      return Object.freeze({
        status: 'operator-required',
        exactRecoveryLineageConverged: false,
      });
    }
    if (archive.resolution.kind === 'ordinary-winner' ||
        archive.resolution.kind === 'non-recovery') {
      return Object.freeze({
        status: 'not-applicable',
        exactRecoveryLineageConverged: false,
      });
    }
    if (archive.resolution.kind === 'rejected' ||
        !['archive', 'terminal', 'successor'].includes(archive.resolution.kind)) {
      return Object.freeze({
        status: 'rejected',
        exactRecoveryLineageConverged: false,
      });
    }
    let selectedBoundary = archive.committed;
    const terminal = await ensureRecoveryTerminalReservation({
      pin,
      distribution: options.distribution,
      freshCommand: options.freshCommand,
    });
    if (terminal.resolution.kind === 'rejected') {
      return Object.freeze({ status: 'rejected', exactRecoveryLineageConverged: false });
    }
    selectedBoundary ||= terminal.committed;
    const fresh = await ensureRecoveryFreshCapture({
      pin,
      distribution: options.distribution,
      freshCommand: options.freshCommand,
    });
    if (fresh.resolution.kind !== 'successor') {
      return Object.freeze({ status: 'rejected', exactRecoveryLineageConverged: false });
    }
    return Object.freeze({
      status: selectedBoundary ? 'recovered' : 'already-recovered',
      exactRecoveryLineageConverged: true,
    });
  }

  async function allocateNextCommand(allocationOptions) {
    if (session.isClosed()) {
      throw repositoryError('B3 capture-state repository is already closed');
    }
    const options = snapshotClosedRecord(
      allocationOptions,
      ['command'],
      'next allocation',
    );
    const commandSnapshot = snapshotCommand(options.command, 'allocation command');
    return retryComposition('next allocation', async () => {
      const preflight = await readCompositionPreflight();
      const proposal = canonicaliseAllocationCommand(
        commandSnapshot,
        session.platform,
        preflight.buildSource.buildAuthority,
      );
      let state = preflight.state;
      if (state.kind === 'pending-initial') {
        state = rereadCompositionState(preflight);
        return Object.freeze({
          kind: 'start-reserved',
          intent: publicB3CaptureStartAuthority(state.pendingStartIntent),
        });
      }
      if (state.kind !== 'working') {
        throw repositoryError('B3 capture-state next allocation has no ready capture');
      }
      let capture = state.workingCapture;
      if (proposal.command.captureId !== capture.capture.capture_id) {
        throw repositoryError('B3 capture-state next allocation capture differs');
      }
      const retained = capture.allocatedCommands.find((command) =>
        command.commandSha256 === proposal.commandSha256);
      if (capture.activeCommand !== null) {
        if (capture.allocatedCommands.length === 1) {
          throw repositoryError('B3 capture-state allocation tail is not closed');
        }
        if (retained &&
            retained.commandSha256 === capture.activeCommand.commandSha256 &&
            retained.allocationSequence === capture.activeCommand.allocationSequence &&
            isDeepStrictEqual(retained.command, proposal.command)) {
          state = rereadCompositionState(preflight);
          return Object.freeze({
            kind: 'already-active',
            command: state.workingCapture.activeCommand,
          });
        }
        if (retained) {
          throw repositoryError('B3 capture-state allocation reuses an earlier command');
        }
        state = rereadCompositionState(preflight);
        return Object.freeze({
          kind: 'allocation-conflict',
          command: state.workingCapture.activeCommand,
        });
      }
      if (retained) {
        throw repositoryError('B3 capture-state allocation reuses an earlier command');
      }
      if (capture.genericDecision === null || capture.tailCommand === null) {
        throw repositoryError('B3 capture-state allocation tail is not closed');
      }
      const expectedSequence = capture.allocatedCommands.length + 1;
      const predecessorStep = capture.steps.at(-1);
      if (proposal.command.expectedSequence !== expectedSequence ||
          expectedSequence > 512 ||
          capture.steps.length !== capture.allocatedCommands.length ||
          predecessorStep?.commandSha256 !== capture.tailCommand.commandSha256 ||
          proposal.command.previousObservationSha256 !==
            predecessorStep?.observationSha256) {
        throw repositoryError(
          'B3 capture-state next allocation does not follow the committed tail step',
        );
      }
      const writer = beginCompositionWriter(preflight);
      state = writer.state;
      const allocationSequence = state.authority.next_allocation_sequence;
      const inserted = session.database.prepare(`
        INSERT INTO b3_commands (
          command_sha256, allocation_sequence, predecessor_command_sha256,
          command_json, prepared_record_json, prepared_record_sha256, capture_id,
          expected_observation_sequence, previous_observation_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING
      `).run(
        proposal.commandSha256,
        allocationSequence,
        capture.tailCommand.commandSha256,
        proposal.commandBytes,
        proposal.preparedRecordBytes,
        proposal.preparedRecord.recordSha256,
        capture.capture.capture_id,
        proposal.command.expectedSequence,
        proposal.command.previousObservationSha256,
      );
      if (inserted.changes !== 1) {
        throw repositoryError('B3 capture-state next allocation lost command authority');
      }
      const advanced = session.database.prepare(`
        UPDATE b3_authority_state
        SET next_allocation_sequence = next_allocation_sequence + 1,
          active_command_sha256 = ?, row_version = row_version + 1
        WHERE singleton = 1 AND next_allocation_sequence = ?
          AND active_command_sha256 IS NULL
          AND reserved_start_command_sha256 IS NULL AND row_version = ?
      `).run(
        proposal.commandSha256,
        allocationSequence,
        state.authority.row_version,
      );
      if (advanced.changes !== 1) {
        throw repositoryError('B3 capture-state next allocation lost singleton authority');
      }
      state = session.validate(writer.buildAuthority);
      capture = state.workingCapture;
      if (state.kind !== 'working' || capture.activeCommand === null ||
          capture.activeCommand.commandSha256 !== proposal.commandSha256 ||
          capture.activeCommand.allocationSequence !== allocationSequence ||
          !isDeepStrictEqual(capture.activeCommand.command, proposal.command)) {
        throw repositoryError('B3 capture-state next allocation did not rederive');
      }
      session.database.exec('COMMIT');
      return Object.freeze({ kind: 'allocated', command: capture.activeCommand });
    });
  }

  async function transitionCommand(transitionOptions) {
    if (session.isClosed()) {
      throw repositoryError('B3 capture-state repository is already closed');
    }
    const options = snapshotClosedRecord(
      transitionOptions,
      ['source', 'nextState'],
      'ordinary transition',
    );
    const rawSource = options.source;
    const nextState = options.nextState;
    const sourceSnapshot = snapshotSource(rawSource);
    return retryComposition('ordinary transition', async () => {
      const preflight = await readCompositionPreflight();
      const source = canonicaliseSource(
        sourceSnapshot,
        session.platform,
        preflight.buildSource.buildAuthority,
      );
      const next = createB3IssuedCommandStateAuthority({
        platform: session.platform,
        command: source.command,
        state: nextState,
      });
      const claim = createB3OrdinaryIssuedCommandClaimAuthority({
        platform: session.platform,
        source: stateRecord(source),
        nextState,
      });
      const capture = preflight.state.workingCapture;
      if (preflight.state.kind !== 'working' || !capture ||
          !selectedSource(capture, source)) {
        throw repositoryError('B3 capture-state command decision source is not selected');
      }
      const retained = selectedDecision(capture, source);
      const outcome = retained
        ? Object.freeze({
            selected: false,
            decision: selectedDecision(
              rereadCompositionState(preflight).workingCapture,
              source,
            ),
          })
        : selectCommandDecision({
            source,
            preflight,
            proposal: Object.freeze({ winnerKind: 'ordinary', next, claim }),
          });
      if (outcome.selected) {
        return Object.freeze({ kind: 'transitioned', command: outcome.decision.command });
      }
      if (outcome.decision.winnerKind === 'generic-consumption') {
        return genericOutcome('generic-consumed', outcome.decision);
      }
      return Object.freeze({
        kind: outcome.decision.command.state === nextState
          ? 'already-transitioned'
          : 'ordinary-conflict',
        command: outcome.decision.command,
      });
    });
  }

  async function consumeCommand(consumptionOptions) {
    if (session.isClosed()) {
      throw repositoryError('B3 capture-state repository is already closed');
    }
    const options = snapshotClosedRecord(
      consumptionOptions,
      ['source'],
      'generic consumption',
    );
    const rawSource = options.source;
    const sourceSnapshot = snapshotSource(rawSource);
    return retryComposition('generic consumption', async () => {
      const preflight = await readCompositionPreflight();
      const source = canonicaliseSource(
        sourceSnapshot,
        session.platform,
        preflight.buildSource.buildAuthority,
      );
      const claim = createB3GenericConsumptionClaimAuthority({
        platform: session.platform,
        source: stateRecord(source),
      });
      const capture = preflight.state.workingCapture;
      if (preflight.state.kind !== 'working' || !capture ||
          !selectedSource(capture, source)) {
        throw repositoryError('B3 capture-state command decision source is not selected');
      }
      const retained = selectedDecision(capture, source);
      if (!retained) {
        const step = capture.steps[source.command.expectedSequence - 1];
        if (step?.commandSha256 !== source.commandSha256) {
          throw repositoryError(
            'B3 capture-state generic consumption requires the exact committed step',
          );
        }
      }
      const outcome = retained
        ? Object.freeze({
            selected: false,
            decision: selectedDecision(
              rereadCompositionState(preflight).workingCapture,
              source,
            ),
          })
        : selectCommandDecision({
            source,
            preflight,
            proposal: Object.freeze({ winnerKind: 'generic-consumption', claim }),
          });
      if (outcome.selected) {
        return genericOutcome('consumed', outcome.decision);
      }
      if (outcome.decision.winnerKind === 'ordinary') {
        return Object.freeze({
          kind: 'ordinary-selected',
          command: outcome.decision.command,
        });
      }
      return genericOutcome('already-consumed', outcome.decision);
    });
  }

  function capturePublicationSnapshot(state, canonicalSource) {
    const capture = state.captures.find((candidate) =>
      candidate.capture.capture_id === canonicalSource.captureId &&
      selectedSource(candidate, canonicalSource));
    const selected = capture && selectedSource(capture, canonicalSource);
    if (!selected) {
      throw repositoryError('B3 capture-state publication source is not retained');
    }
    const allocated = capture.allocatedCommands.find((candidate) =>
      candidate.commandSha256 === canonicalSource.commandSha256);
    if (!allocated) {
      throw repositoryError('B3 capture-state publication command is not allocated');
    }
    const steps = Object.freeze(capture.steps.map(copyStepRow));
    const sequence = allocated.command.expectedSequence;
    return Object.freeze({
      captureId: capture.capture.capture_id,
      activeCommand: capture === state.workingCapture ? capture.activeCommand : null,
      source: selected,
      command: allocated.command,
      commandSha256: allocated.commandSha256,
      allCommands: Object.freeze(capture.allocatedCommands.map((entry) => entry)),
      sequence,
      steps,
      predecessor: sequence === 1 ? null : (steps[sequence - 2] ?? null),
      existing: steps[sequence - 1] ?? null,
    });
  }

  function sameExistingPublicationSnapshot(left, right) {
    return left.captureId === right.captureId &&
      left.commandSha256 === right.commandSha256 &&
      left.sequence === right.sequence &&
      isDeepStrictEqual(left.source, right.source) &&
      isDeepStrictEqual(left.command, right.command) &&
      isDeepStrictEqual(left.predecessor, right.predecessor) &&
      isDeepStrictEqual(left.existing, right.existing);
  }

  function sameMissingPublicationSnapshot(left, right) {
    return sameExistingPublicationSnapshot(left, right) &&
      isDeepStrictEqual(left.activeCommand, right.activeCommand) &&
      isDeepStrictEqual(left.allCommands, right.allCommands) &&
      isDeepStrictEqual(left.steps, right.steps);
  }

  function readPublicationSnapshot(sourceSnapshot, buildSource) {
    session.database.exec('BEGIN');
    try {
      const state = session.validate(buildSource.buildAuthority);
      const canonicalSource = canonicaliseSource(
        sourceSnapshot,
        session.platform,
        buildSource.buildAuthority,
      );
      const snapshot = capturePublicationSnapshot(state, canonicalSource);
      session.database.exec('COMMIT');
      return snapshot;
    } catch (error) {
      if (session.database.isTransaction) session.database.exec('ROLLBACK');
      throw error;
    }
  }

  function rereadExistingPublicationSnapshot(sourceSnapshot, preflightSource) {
    session.database.exec('BEGIN');
    try {
      const committedSource = session.readBuildSourceFreshSync();
      assertBuildSourceUnchanged(preflightSource, committedSource);
      const state = session.validate(committedSource.buildAuthority);
      const canonicalSource = canonicaliseSource(
        sourceSnapshot,
        session.platform,
        committedSource.buildAuthority,
      );
      const snapshot = capturePublicationSnapshot(state, canonicalSource);
      session.database.exec('COMMIT');
      return snapshot;
    } catch (error) {
      if (session.database.isTransaction) session.database.exec('ROLLBACK');
      throw error;
    }
  }

  function committedResult(kind, step) {
    return Object.freeze({ kind, record: step.record, checkpoint: step.checkpoint });
  }

  async function publishObservation(publicationOptions) {
    if (session.isClosed()) {
      throw repositoryError('B3 capture-state repository is already closed');
    }
    const options = snapshotClosedDataRecord(
      publicationOptions,
      ['source', 'observationBytes'],
      'observation publication',
    );
    const copiedSource = snapshotClosedDataRecord(options.source, SOURCE_KEYS, 'source');
    const sourceSnapshot = Object.freeze({
      ...copiedSource,
      command: snapshotScalarCommand(copiedSource.command, 'source command'),
    });
    const observationBytes = options.observationBytes instanceof Uint8Array
      ? Buffer.from(options.observationBytes)
      : null;
    if (!observationBytes) {
      throw repositoryError('B3 capture-state observation bytes are invalid');
    }

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const preflightSource = await session.readBuildSourceFresh();
        const preflight = readPublicationSnapshot(sourceSnapshot, preflightSource);
        const retained = await validateCompositionSteps(preflight, preflightSource.value);
        const previousObservation = retained[preflight.sequence - 2]?.record.observation;
        const proposal = await deriveB3CaptureStep({
          platform: session.platform,
          command: preflight.command,
          buildSource: preflightSource.value,
          previousObservation,
          observationBytes,
        });

        if (preflight.existing !== null) {
          const committed = rereadExistingPublicationSnapshot(
            sourceSnapshot,
            preflightSource,
          );
          if (!sameExistingPublicationSnapshot(committed, preflight)) {
            throw driftError('B3 capture-state existing publication snapshot changed');
          }
          const existing = retained[preflight.sequence - 1];
          const identical = proposal.recordBytes.equals(existing.recordBytes) &&
            proposal.checkpointBytes.equals(existing.checkpointBytes);
          return committedResult(
            identical ? 'already-published' : 'publication-conflict',
            existing,
          );
        }

        if (!isDeepStrictEqual(preflight.activeCommand, preflight.source) ||
            preflight.steps.length !== preflight.sequence - 1 ||
            (preflight.predecessor?.observationSha256 ?? '0'.repeat(64)) !==
              preflight.command.previousObservationSha256) {
          throw repositoryError('B3 capture-state missing publication is not the active tail');
        }

        session.database.exec('BEGIN IMMEDIATE');
        let committedRow;
        try {
          const committedSource = session.readBuildSourceFreshSync();
          assertBuildSourceUnchanged(preflightSource, committedSource);
          const state = session.validate(committedSource.buildAuthority);
          const canonicalSource = canonicaliseSource(
            sourceSnapshot,
            session.platform,
            committedSource.buildAuthority,
          );
          const committed = capturePublicationSnapshot(state, canonicalSource);
          if (!sameMissingPublicationSnapshot(committed, preflight)) {
            throw driftError('B3 capture-state missing publication snapshot changed');
          }
          const inserted = session.database.prepare(`
            INSERT INTO b3_capture_steps (
              capture_id, observation_sequence, command_sha256,
              record_json, record_sha256, observation_sha256,
              checkpoint_json, checkpoint_sha256
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT DO NOTHING
          `).run(
            committed.captureId,
            committed.sequence,
            committed.commandSha256,
            proposal.recordBytes,
            proposal.recordSha256,
            proposal.observationSha256,
            proposal.checkpointBytes,
            proposal.checkpointBlobSha256,
          );
          if (inserted.changes !== 1) {
            throw driftError('B3 capture-state publication insert selected no row');
          }
          const after = session.validate(committedSource.buildAuthority);
          const afterCapture = after.captures.find((capture) =>
            capture.capture.capture_id === committed.captureId);
          committedRow = copyStepRow(afterCapture.steps[committed.sequence - 1]);
          session.database.exec('COMMIT');
        } catch (error) {
          if (session.database.isTransaction) session.database.exec('ROLLBACK');
          throw error;
        }
        const committedStep = await validateB3RetainedCaptureStep({
          platform: session.platform,
          command: preflight.command,
          buildSource: preflightSource.value,
          previousObservation,
          recordBytes: committedRow.recordBytes,
          checkpointBytes: committedRow.checkpointBytes,
        });
        return committedResult('published', committedStep);
      } catch (error) {
        if (isRetryableDrift(error) && attempt < 3) continue;
        if (error?.code === 'b3_capture_state_invalid') throw error;
        throw repositoryError(error?.message ?? 'B3 capture-state publication failed');
      }
    }
    throw repositoryError('B3 capture-state publication attempt bound exceeded');
  }

  async function readCapture(...readOptions) {
    if (session.isClosed()) {
      throw repositoryError('B3 capture-state repository is already closed');
    }
    if (readOptions.length !== 0) {
      throw repositoryError('B3 capture-state read capture authority is invalid');
    }
    try {
      const buildSource = await session.readBuildSourceFresh();
      session.database.exec('BEGIN');
      let snapshot;
      try {
        const state = session.validate(buildSource.buildAuthority);
        const capture = state.workingCapture;
        if (state.kind !== 'working' || !capture ||
            capture.capture.capture_state !== 'working') {
          throw repositoryError('B3 capture-state has no readable working capture');
        }
        snapshot = Object.freeze({
          kind: state.kind,
          captureId: capture.capture.capture_id,
          commandSha256: capture.allocatedCommands.at(-1).commandSha256,
          command: capture.allocatedCommands.at(-1).command,
          allCommands: Object.freeze(capture.allocatedCommands.map((entry) => entry)),
          steps: Object.freeze(capture.steps.map(copyStepRow)),
        });
        session.database.exec('COMMIT');
      } catch (error) {
        if (session.database.isTransaction) session.database.exec('ROLLBACK');
        throw error;
      }
      const retained = await validateCompositionSteps(snapshot, buildSource.value);
      const records = Object.freeze(retained.map((step) => step.record));
      const checkpoint = retained.at(-1)?.checkpoint ?? null;
      return Object.freeze({
        schemaVersion: 1,
        platform: session.platform,
        captureId: snapshot.captureId,
        records,
        checkpoint,
        gatewaySmokeProjection: deriveB3DeviceGatewaySmokeProjection(records),
      });
    } catch (error) {
      if (error?.code === 'b3_capture_state_invalid') throw error;
      throw repositoryError(error?.message ?? 'B3 capture-state read failed');
    }
  }

  return Object.freeze({
    allocateNextCommand,
    consumeCommand,
    readActiveCommand,
    readCapture,
    publishObservation,
    readRecoveryInvocationPin,
    finaliseRecoveryInvocation,
    reconcileInitialCaptureStart,
    reserveInitialCaptureStart,
    transitionCommand,
    close: () => foundation.close(),
  });
}
