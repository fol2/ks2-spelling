import { createHash } from 'node:crypto';

import { parseB3StrictJsonBytes } from '../check-b3-external-prerequisites.mjs';
import { canonicaliseB3ProofValue } from '../../src/app/b3-live-proof-protocol.js';
import {
  createB3PreparedIssuedCommandAuthority,
  validateB3PreparedIssuedCommandAuthorityBytes,
} from './b3-issued-command-authority.mjs';

const INITIAL_OBSERVATION_SHA256 = '0'.repeat(64);
const COMMAND_PLATFORM = Object.freeze({
  ios: 'ios-physical',
  android: 'android-play-physical',
});

function authorityError(message) {
  return Object.assign(new Error(message), { code: 'b3_capture_state_invalid' });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalBytes(value) {
  return Buffer.from(canonicaliseB3ProofValue(value), 'utf8');
}

export function createB3InitialCaptureStartAuthority({
  platform,
  command: rawCommand,
  buildAuthority,
}) {
  const preparedRecord = createB3PreparedIssuedCommandAuthority({
    platform,
    command: rawCommand,
  });
  const { command } = preparedRecord;
  if (command.platform !== COMMAND_PLATFORM[platform] ||
      command.testedApplicationCommit !== buildAuthority.testedApplicationCommit ||
      command.applicationFingerprint !== buildAuthority.applicationFingerprint ||
      command.expectedScenarioIndex !== 0 || command.expectedSequence !== 1 ||
      command.previousObservationSha256 !== INITIAL_OBSERVATION_SHA256 ||
      command.installationMode !== 'existing' || command.actionCode !== 'ARM_CAPTURE') {
    throw authorityError('B3 capture-state initial command authority is invalid');
  }
  const unsignedIntent = Object.freeze({
    schemaVersion: 1,
    intentKind: 'initial',
    recoveredCommandSha256: null,
    terminalClaimSha256: null,
    captureId: command.captureId,
    firstCommandSha256: preparedRecord.commandSha256,
    firstPreparedRecordSha256: preparedRecord.recordSha256,
  });
  const startIntentSha256 = sha256(Buffer.concat([
    Buffer.from('ks2-spelling:b3-capture-start-intent:v1\0', 'utf8'),
    canonicalBytes(unsignedIntent),
  ]));
  return Object.freeze({
    ...unsignedIntent,
    startIntentSha256,
    firstCommand: Object.freeze(command),
    intentState: 'pending',
    rowVersion: 1,
    commandBytes: canonicalBytes(command),
    preparedRecordBytes: canonicalBytes(preparedRecord),
  });
}

export function validateB3PendingInitialCaptureStartAuthority({
  platform,
  buildAuthority,
  retained,
  singleton,
}) {
  try {
    const commandBytes = Buffer.from(retained.firstCommandBytes);
    const command = parseB3StrictJsonBytes(
      commandBytes,
      'B3 capture-state initial command',
    );
    const expected = createB3InitialCaptureStartAuthority({
      platform,
      command,
      buildAuthority,
    });
    const retainedPrepared = validateB3PreparedIssuedCommandAuthorityBytes({
      bytes: retained.firstPreparedRecordBytes,
      platform,
    });
    if (retained.startIntentSha256 !== expected.startIntentSha256 ||
        retained.intentKind !== 'initial' || retained.recoveredCommandSha256 !== null ||
        retained.terminalClaimSha256 !== null || retained.captureId !== expected.captureId ||
        retained.firstCommandSha256 !== expected.firstCommandSha256 ||
        !commandBytes.equals(expected.commandBytes) ||
        retained.firstPreparedRecordSha256 !== expected.firstPreparedRecordSha256 ||
        !Buffer.from(retained.firstPreparedRecordBytes).equals(expected.preparedRecordBytes) ||
        retainedPrepared.commandSha256 !== expected.firstCommandSha256 ||
        retainedPrepared.recordSha256 !== expected.firstPreparedRecordSha256 ||
        retained.intentState !== 'pending' || retained.rowVersion !== 1 ||
        singleton.nextAllocationSequence !== 1 || singleton.activeCommandSha256 !== null ||
        singleton.reservedStartCommandSha256 !== expected.firstCommandSha256 ||
        singleton.rowVersion !== 2) {
      throw authorityError('B3 capture-state pending initial intent authority differs');
    }
    return expected;
  } catch (error) {
    if (error?.code === 'b3_capture_state_invalid') throw error;
    throw authorityError('B3 capture-state pending initial intent is invalid');
  }
}

export function validateB3ReadyInitialCaptureStartAuthority({
  platform,
  buildAuthority,
  retained,
}) {
  try {
    const commandBytes = Buffer.from(retained.firstCommandBytes);
    const command = parseB3StrictJsonBytes(
      commandBytes,
      'B3 capture-state initial command',
    );
    const expected = createB3InitialCaptureStartAuthority({
      platform,
      command,
      buildAuthority,
    });
    const retainedPrepared = validateB3PreparedIssuedCommandAuthorityBytes({
      bytes: retained.firstPreparedRecordBytes,
      platform,
    });
    if (retained.startIntentSha256 !== expected.startIntentSha256 ||
        retained.intentKind !== 'initial' || retained.recoveredCommandSha256 !== null ||
        retained.terminalClaimSha256 !== null || retained.captureId !== expected.captureId ||
        retained.firstCommandSha256 !== expected.firstCommandSha256 ||
        !commandBytes.equals(expected.commandBytes) ||
        retained.firstPreparedRecordSha256 !== expected.firstPreparedRecordSha256 ||
        !Buffer.from(retained.firstPreparedRecordBytes).equals(expected.preparedRecordBytes) ||
        retainedPrepared.commandSha256 !== expected.firstCommandSha256 ||
        retainedPrepared.recordSha256 !== expected.firstPreparedRecordSha256 ||
        retained.intentState !== 'ready' || retained.rowVersion !== 2) {
      throw authorityError('B3 capture-state ready initial intent authority differs');
    }
    return Object.freeze({ ...expected, intentState: 'ready', rowVersion: 2 });
  } catch (error) {
    if (error?.code === 'b3_capture_state_invalid') throw error;
    throw authorityError('B3 capture-state ready initial intent is invalid');
  }
}

export function publicB3CaptureStartAuthority(intent) {
  return Object.freeze({
    schemaVersion: intent.schemaVersion,
    startIntentSha256: intent.startIntentSha256,
    intentKind: intent.intentKind,
    recoveredCommandSha256: intent.recoveredCommandSha256,
    terminalClaimSha256: intent.terminalClaimSha256,
    captureId: intent.captureId,
    firstCommandSha256: intent.firstCommandSha256,
    firstCommand: Object.freeze({ ...intent.firstCommand }),
    firstPreparedRecordSha256: intent.firstPreparedRecordSha256,
    intentState: intent.intentState,
    rowVersion: intent.rowVersion,
  });
}
