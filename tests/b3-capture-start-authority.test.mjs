import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { canonicaliseB3ProofValue } from '../src/app/b3-live-proof-protocol.js';
import {
  createB3InitialCaptureStartAuthority,
  createB3RecoveryFreshCaptureStartAuthority,
  validateB3RecoveryFreshCommandAuthority,
  validateB3PendingRecoveryFreshCaptureStartAuthority,
  validateB3ReadyRecoveryFreshCaptureStartAuthority,
} from '../scripts/lib/b3-capture-start-authority.mjs';

const COMMIT = '1'.repeat(40);
const FINGERPRINT = '2'.repeat(64);
const BUILD = Object.freeze({
  testedApplicationCommit: COMMIT,
  applicationFingerprint: FINGERPRINT,
});
const RECOVERED_COMMAND_SHA256 = 'a'.repeat(64);
const TERMINAL_CLAIM_SHA256 = 'b'.repeat(64);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function startCommand(captureId) {
  const unsigned = {
    schemaVersion: 1,
    captureId,
    platform: 'ios-physical',
    testedApplicationCommit: COMMIT,
    applicationFingerprint: FINGERPRINT,
    expectedScenarioIndex: 0,
    expectedSequence: 1,
    previousObservationSha256: '0'.repeat(64),
    installationMode: 'existing',
    actionCode: 'ARM_CAPTURE',
  };
  return Object.freeze({
    ...unsigned,
    challengeSha256: sha256(Buffer.from(
      `ks2-spelling:b3-host-command-challenge:v1\0${canonicaliseB3ProofValue(unsigned)}`,
      'utf8',
    )),
  });
}

function retained(intent, intentState, rowVersion) {
  return {
    startIntentSha256: intent.startIntentSha256,
    intentKind: intent.intentKind,
    recoveredCommandSha256: intent.recoveredCommandSha256,
    terminalClaimSha256: intent.terminalClaimSha256,
    captureId: intent.captureId,
    firstCommandSha256: intent.firstCommandSha256,
    firstCommandBytes: intent.commandBytes,
    firstPreparedRecordBytes: intent.preparedRecordBytes,
    firstPreparedRecordSha256: intent.firstPreparedRecordSha256,
    intentState,
    rowVersion,
  };
}

test('D4.1 preserves the initial start vector and freezes recovery-fresh vector', () => {
  const initial = createB3InitialCaptureStartAuthority({
    platform: 'ios',
    command: startCommand('018f1d7b-97e8-4a52-8cf2-783e5089c001'),
    buildAuthority: BUILD,
  });
  const fresh = createB3RecoveryFreshCaptureStartAuthority({
    platform: 'ios',
    command: startCommand('018f1d7b-97e8-4a52-8cf2-783e5089c002'),
    buildAuthority: BUILD,
    recoveredCommandSha256: RECOVERED_COMMAND_SHA256,
    terminalClaimSha256: TERMINAL_CLAIM_SHA256,
  });

  assert.equal(initial.startIntentSha256,
    '60330a9948db44bae18d3db4324ce708bbe57018c73bf181043e4539a3b3a521');
  assert.equal(fresh.intentKind, 'recovery-fresh');
  assert.equal(fresh.startIntentSha256,
    '74f4a7f508ab7c027d0614a5923852732d5cc23751d3dfd38d7fa68cb07be84a');
  assert.equal(fresh.firstCommandSha256,
    '8e7e82cf6a88163f5f698009ff03ed3d094db395ccf81cf762851591909de392');
  assert.equal(fresh.firstPreparedRecordSha256,
    '2e1b7d30965c38642dc5435f8417759f4ea9d24336ef4ceaeab6f5a89a6db166');
  assert.equal(fresh.firstCommand.installationMode, 'existing');
  assert.equal(fresh.firstCommand.actionCode, 'ARM_CAPTURE');
});

test('D4.1 validates pending and ready recovery-fresh retained intent bytes', () => {
  const options = {
    platform: 'ios',
    command: startCommand('018f1d7b-97e8-4a52-8cf2-783e5089c002'),
    buildAuthority: BUILD,
    recoveredCommandSha256: RECOVERED_COMMAND_SHA256,
    terminalClaimSha256: TERMINAL_CLAIM_SHA256,
  };
  const fresh = createB3RecoveryFreshCaptureStartAuthority(options);
  const validation = {
    platform: 'ios',
    buildAuthority: BUILD,
    recoveredCommandSha256: RECOVERED_COMMAND_SHA256,
    terminalClaimSha256: TERMINAL_CLAIM_SHA256,
  };

  assert.equal(validateB3PendingRecoveryFreshCaptureStartAuthority({
    ...validation,
    retained: retained(fresh, 'pending', 1),
  }).intentState, 'pending');
  assert.equal(validateB3ReadyRecoveryFreshCaptureStartAuthority({
    ...validation,
    retained: retained(fresh, 'ready', 2),
  }).intentState, 'ready');
});

test('D4.1 validates a recovery-fresh command before terminal lineage exists', () => {
  const command = startCommand('018f1d7b-97e8-4a52-8cf2-783e5089c002');
  const authority = validateB3RecoveryFreshCommandAuthority({
    platform: 'ios',
    command,
    buildAuthority: BUILD,
  });
  assert.equal(authority.commandSha256,
    '8e7e82cf6a88163f5f698009ff03ed3d094db395ccf81cf762851591909de392');
  assert.deepEqual(authority.command, command);
  assert.equal(authority.preparedRecord.state, 'prepared');
});

test('D4.1 rejects fresh-install/rebind, wrong terminal lineage and non-canonical bytes', () => {
  const command = startCommand('018f1d7b-97e8-4a52-8cf2-783e5089c002');
  const options = {
    platform: 'ios', command, buildAuthority: BUILD,
    recoveredCommandSha256: RECOVERED_COMMAND_SHA256,
    terminalClaimSha256: TERMINAL_CLAIM_SHA256,
  };
  assert.throws(() => createB3RecoveryFreshCaptureStartAuthority({
    ...options,
    command: { ...command, installationMode: 'fresh-install' },
  }), { code: 'b3_capture_state_invalid' });
  assert.throws(() => createB3RecoveryFreshCaptureStartAuthority({
    ...options,
    command: { ...command, actionCode: 'REBIND_FRESH_INSTALL' },
  }), { code: 'b3_capture_state_invalid' });

  const fresh = createB3RecoveryFreshCaptureStartAuthority(options);
  assert.throws(() => validateB3PendingRecoveryFreshCaptureStartAuthority({
    platform: 'ios', buildAuthority: BUILD,
    recoveredCommandSha256: RECOVERED_COMMAND_SHA256,
    terminalClaimSha256: 'c'.repeat(64),
    retained: retained(fresh, 'pending', 1),
  }), { code: 'b3_capture_state_invalid' });
  const nonCanonical = retained(fresh, 'pending', 1);
  nonCanonical.firstCommandBytes = Buffer.concat([
    nonCanonical.firstCommandBytes,
    Buffer.from(' '),
  ]);
  assert.throws(() => validateB3PendingRecoveryFreshCaptureStartAuthority({
    platform: 'ios', buildAuthority: BUILD,
    recoveredCommandSha256: RECOVERED_COMMAND_SHA256,
    terminalClaimSha256: TERMINAL_CLAIM_SHA256,
    retained: nonCanonical,
  }), { code: 'b3_capture_state_invalid' });
});
