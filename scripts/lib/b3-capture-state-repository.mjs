import { isDeepStrictEqual } from 'node:util';

import { canonicaliseB3ProofValue } from '../../src/app/b3-live-proof-protocol.js';
import {
  createB3InitialCaptureStartAuthority,
  publicB3CaptureStartAuthority,
} from './b3-capture-start-authority.mjs';
import { openB3CaptureStateDatabase } from './b3-capture-state-database.mjs';
import { takeB3CaptureStateSession } from './b3-capture-state-internal.mjs';
import {
  deriveB3CaptureStep,
  deriveB3DeviceGatewaySmokeProjection,
  validateB3RetainedCaptureStep,
} from './b3-physical-observation-journal.mjs';
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

function selectedSource(state, source) {
  return state.selectedCommands.find((candidate) =>
    isDeepStrictEqual(candidate, source));
}

function selectedDecision(state, source) {
  return state.selectedDecisions.find((decision) =>
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

  function selectCommandDecision({ source, buildAuthority, proposal }) {
    session.database.exec('BEGIN IMMEDIATE');
    try {
      let state = session.validate(buildAuthority);
      if (state.kind !== 'ready-initial' || !selectedSource(state, source)) {
        throw repositoryError('B3 capture-state command decision source is not selected');
      }
      let decision = selectedDecision(state, source);
      if (decision) {
        session.database.exec('COMMIT');
        return Object.freeze({ selected: false, decision });
      }
      if (!state.activeCommand || !isDeepStrictEqual(state.activeCommand, source)) {
        throw repositoryError('B3 capture-state command decision source is not active');
      }
      const inserted = insertSelectedDecision(proposal, source, state);
      state = session.validate(buildAuthority);
      decision = selectedDecision(state, source);
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
            state.activeCommand !== null)) {
        throw repositoryError('B3 capture-state command decision did not rederive');
      }
      session.database.exec('COMMIT');
      return Object.freeze({ selected: true, decision });
    } catch (error) {
      if (session.database.isTransaction) session.database.exec('ROLLBACK');
      throw error;
    }
  }

  function reserveInitialCaptureStartProposal(proposal, buildAuthority, allowReady) {
    session.database.exec('BEGIN IMMEDIATE');
    try {
      let state = session.validate(buildAuthority);
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
        state = session.validate(buildAuthority);
        wonReservation = true;
      }
      if (state.kind !== 'pending-initial' &&
          !(allowReady && state.kind === 'ready-initial')) {
        throw repositoryError('B3 capture-state initial reservation cannot proceed');
      }
      const winner = state.startIntent;
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
    const buildAuthority = await session.readBuildAuthorityFresh();
    const proposal = createB3InitialCaptureStartAuthority({
      platform: session.platform,
      command: rawCommand,
      buildAuthority,
    });
    return reserveInitialCaptureStartProposal(proposal, buildAuthority, false).capture;
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
    const reservationBuildAuthority = await session.readBuildAuthorityFresh();
    const proposal = createB3InitialCaptureStartAuthority({
      platform: session.platform,
      command: commandSnapshot,
      buildAuthority: reservationBuildAuthority,
    });
    const reservation = reserveInitialCaptureStartProposal(
      proposal,
      reservationBuildAuthority,
      true,
    );

    const reconciliationBuildAuthority = await session.readBuildAuthorityFresh();
    session.database.exec('BEGIN IMMEDIATE');
    try {
      let state = session.validate(reconciliationBuildAuthority);
      if (state.kind === 'pending-initial') {
        const start = state.startIntent;
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
        state = session.validate(reconciliationBuildAuthority);
      }
      if (state.kind !== 'ready-initial' ||
          state.startIntent.startIntentSha256 !== reservation.capture.startIntentSha256) {
        throw repositoryError('B3 capture-state initial reconciliation did not rederive');
      }
      const capture = publicB3CaptureStartAuthority(state.startIntent);
      session.database.exec('COMMIT');
      return Object.freeze({ kind: reservation.kind, capture });
    } catch (error) {
      if (session.database.isTransaction) session.database.exec('ROLLBACK');
      throw error;
    }
  }

  async function readActiveCommand(...readOptions) {
    if (session.isClosed()) {
      throw repositoryError('B3 capture-state repository is already closed');
    }
    if (readOptions.length !== 0) {
      throw repositoryError('B3 capture-state read authority is invalid');
    }
    const buildAuthority = await session.readBuildAuthorityFresh();

    session.database.exec('BEGIN');
    try {
      const state = session.validate(buildAuthority);
      let result;
      if (state.kind === 'empty') {
        result = Object.freeze({ kind: 'none' });
      } else if (state.kind === 'pending-initial') {
        result = Object.freeze({
          kind: 'start-reserved',
          intent: publicB3CaptureStartAuthority(state.startIntent),
        });
      } else if (state.kind === 'ready-initial') {
        result = state.activeCommand === null
          ? Object.freeze({ kind: 'none' })
          : Object.freeze({ kind: 'active', command: state.activeCommand });
      } else {
        throw repositoryError('B3 capture-state read authority is unsupported');
      }
      session.database.exec('COMMIT');
      return result;
    } catch (error) {
      if (session.database.isTransaction) session.database.exec('ROLLBACK');
      throw error;
    }
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
    const buildAuthority = await session.readBuildAuthorityFresh();
    let proposal;
    try {
      proposal = canonicaliseAllocationCommand(
        commandSnapshot,
        session.platform,
        buildAuthority,
      );
    } catch (error) {
      if (error?.code === 'b3_issued_command_invalid') {
        throw repositoryError(error.message);
      }
      throw error;
    }

    session.database.exec('BEGIN IMMEDIATE');
    try {
      let state = session.validate(buildAuthority);
      if (state.kind === 'pending-initial') {
        session.database.exec('COMMIT');
        return Object.freeze({
          kind: 'start-reserved',
          intent: publicB3CaptureStartAuthority(state.startIntent),
        });
      }
      if (state.kind !== 'ready-initial') {
        throw repositoryError('B3 capture-state next allocation has no ready capture');
      }
      if (proposal.command.captureId !== state.capture.capture_id) {
        throw repositoryError('B3 capture-state next allocation capture differs');
      }
      const retained = state.allocatedCommands.find((command) =>
        command.commandSha256 === proposal.commandSha256);
      if (state.activeCommand !== null) {
        if (state.allocatedCommands.length === 1) {
          throw repositoryError('B3 capture-state allocation tail is not closed');
        }
        if (retained &&
            retained.commandSha256 === state.activeCommand.commandSha256 &&
            retained.allocationSequence === state.activeCommand.allocationSequence &&
            isDeepStrictEqual(retained.command, proposal.command)) {
          session.database.exec('COMMIT');
          return Object.freeze({ kind: 'already-active', command: state.activeCommand });
        }
        if (retained) {
          throw repositoryError('B3 capture-state allocation reuses an earlier command');
        }
        session.database.exec('COMMIT');
        return Object.freeze({
          kind: 'allocation-conflict',
          command: state.activeCommand,
        });
      }
      if (retained) {
        throw repositoryError('B3 capture-state allocation reuses an earlier command');
      }
      if (state.genericDecision === null || state.tailCommand === null) {
        throw repositoryError('B3 capture-state allocation tail is not closed');
      }
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
        state.tailCommand.commandSha256,
        proposal.commandBytes,
        proposal.preparedRecordBytes,
        proposal.preparedRecord.recordSha256,
        state.capture.capture_id,
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
      state = session.validate(buildAuthority);
      if (state.kind !== 'ready-initial' || state.activeCommand === null ||
          state.activeCommand.commandSha256 !== proposal.commandSha256 ||
          state.activeCommand.allocationSequence !== allocationSequence ||
          !isDeepStrictEqual(state.activeCommand.command, proposal.command)) {
        throw repositoryError('B3 capture-state next allocation did not rederive');
      }
      session.database.exec('COMMIT');
      return Object.freeze({ kind: 'allocated', command: state.activeCommand });
    } catch (error) {
      if (session.database.isTransaction) session.database.exec('ROLLBACK');
      throw error;
    }
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
    const buildAuthority = await session.readBuildAuthorityFresh();
    let source;
    let next;
    let claim;
    try {
      source = canonicaliseSource(sourceSnapshot, session.platform, buildAuthority);
      next = createB3IssuedCommandStateAuthority({
        platform: session.platform,
        command: source.command,
        state: nextState,
      });
      claim = createB3OrdinaryIssuedCommandClaimAuthority({
        platform: session.platform,
        source: stateRecord(source),
        nextState,
      });
    } catch (error) {
      if (error?.code === 'b3_issued_command_invalid') {
        throw repositoryError(error.message);
      }
      throw error;
    }

    const outcome = selectCommandDecision({
      source,
      buildAuthority,
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
    const buildAuthority = await session.readBuildAuthorityFresh();
    let source;
    let claim;
    try {
      source = canonicaliseSource(sourceSnapshot, session.platform, buildAuthority);
      claim = createB3GenericConsumptionClaimAuthority({
        platform: session.platform,
        source: stateRecord(source),
      });
    } catch (error) {
      if (error?.code === 'b3_issued_command_invalid') {
        throw repositoryError(error.message);
      }
      throw error;
    }

    const outcome = selectCommandDecision({
      source,
      buildAuthority,
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
  }

  function capturePublicationSnapshot(state, canonicalSource) {
    if (state.kind !== 'ready-initial') {
      throw repositoryError('B3 capture-state publication has no ready working capture');
    }
    const selected = selectedSource(state, canonicalSource);
    if (!selected) {
      throw repositoryError('B3 capture-state publication source is not retained');
    }
    const allocated = state.allocatedCommands.find((candidate) =>
      candidate.commandSha256 === canonicalSource.commandSha256);
    if (!allocated) {
      throw repositoryError('B3 capture-state publication command is not allocated');
    }
    const steps = Object.freeze(state.steps.map(copyStepRow));
    const sequence = allocated.command.expectedSequence;
    return Object.freeze({
      captureId: state.capture.capture_id,
      activeCommand: state.activeCommand,
      source: selected,
      command: allocated.command,
      commandSha256: allocated.commandSha256,
      allCommands: Object.freeze(state.allocatedCommands.map((entry) => entry)),
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

  async function validatePublicationSteps(snapshot, buildSourceValue) {
    const retained = [];
    let previousObservation;
    for (const row of snapshot.steps) {
      const command = snapshot.commandSha256 === row.commandSha256
        ? snapshot.command
        : snapshot.allCommands.find((candidate) =>
          candidate.commandSha256 === row.commandSha256)?.command;
      if (!command) {
        throw repositoryError('B3 capture-state retained step command is absent');
      }
      const step = await validateB3RetainedCaptureStep({
        platform: session.platform,
        command,
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

  function assertBuildSourceUnchanged(left, right) {
    if (!isDeepStrictEqual(buildSourceSnapshot(left), buildSourceSnapshot(right))) {
      throw driftError('B3 capture-state build source changed during publication');
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
        const retained = await validatePublicationSteps(preflight, preflightSource.value);
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
          committedRow = copyStepRow(after.steps[committed.sequence - 1]);
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
        if (state.kind !== 'ready-initial' || state.capture.capture_state !== 'working') {
          throw repositoryError('B3 capture-state has no readable working capture');
        }
        snapshot = Object.freeze({
          kind: state.kind,
          captureId: state.capture.capture_id,
          commandSha256: state.allocatedCommands.at(-1).commandSha256,
          command: state.allocatedCommands.at(-1).command,
          allCommands: Object.freeze(state.allocatedCommands.map((entry) => entry)),
          steps: Object.freeze(state.steps.map(copyStepRow)),
        });
        session.database.exec('COMMIT');
      } catch (error) {
        if (session.database.isTransaction) session.database.exec('ROLLBACK');
        throw error;
      }
      const retained = await validatePublicationSteps(snapshot, buildSource.value);
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
    reconcileInitialCaptureStart,
    reserveInitialCaptureStart,
    transitionCommand,
    close: () => foundation.close(),
  });
}
