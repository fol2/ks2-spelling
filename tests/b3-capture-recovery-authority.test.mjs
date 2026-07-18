import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { canonicaliseB3ProofValue } from '../src/app/b3-live-proof-protocol.js';
import {
  createB3IssuedCommandStateAuthority,
} from '../scripts/lib/b3-issued-command-authority.mjs';
import {
  createB3CaptureSnapshotAuthority,
  createB3RecoveryArchiveAuthority,
  createB3RecoveryManifestAuthority,
  createB3RecoveryOwnerClaimAuthority,
  createB3RecoveryTerminalAuthority,
  validateB3CaptureSnapshotAuthority,
  validateB3RecoveryArchiveAuthorityBytes,
  validateB3RecoveryManifestAuthorityBytes,
  validateB3RecoveryOwnerClaimAuthorityBytes,
  validateB3RecoveryTerminalAuthorityBytes,
} from '../scripts/lib/b3-capture-recovery-authority.mjs';

const COMMIT = '1'.repeat(40);
const FINGERPRINT = '2'.repeat(64);
const CAPTURE_ID = '018f1d7b-97e8-4a52-8cf2-783e5089c001';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalBytes(value) {
  return Buffer.from(canonicaliseB3ProofValue(value), 'utf8');
}

function command() {
  return Object.freeze({
    schemaVersion: 1,
    captureId: CAPTURE_ID,
    platform: 'ios-physical',
    testedApplicationCommit: COMMIT,
    applicationFingerprint: FINGERPRINT,
    expectedScenarioIndex: 0,
    expectedSequence: 1,
    previousObservationSha256: '0'.repeat(64),
    installationMode: 'existing',
    actionCode: 'ARM_CAPTURE',
    challengeSha256: 'f144a676e8bf11d8a36b75b4ddb08c62d10b8c69be56e29270f556b9ee42261c',
  });
}

function authorityFixture() {
  const source = createB3IssuedCommandStateAuthority({
    platform: 'ios',
    command: command(),
    state: 'restart-required',
  });
  const owner = createB3RecoveryOwnerClaimAuthority({ platform: 'ios', source });
  const snapshot = createB3CaptureSnapshotAuthority({
    platform: 'ios',
    captureId: CAPTURE_ID,
    startIntentSha256: '3'.repeat(64),
    captureState: 'abandoned',
    captureRowVersion: 2,
    testedApplicationCommit: COMMIT,
    applicationFingerprint: FINGERPRINT,
    commands: [{
      allocationSequence: 1,
      commandSha256: source.commandSha256,
      predecessorCommandSha256: null,
      commandJsonSha256: sha256(canonicalBytes(source.command)),
      preparedRecordSha256: createB3IssuedCommandStateAuthority({
        platform: 'ios',
        command: source.command,
        state: 'prepared',
      }).recordSha256,
      expectedObservationSequence: 1,
      previousObservationSha256: '0'.repeat(64),
    }],
    decisions: [{
      commandSha256: source.commandSha256,
      sourceState: source.state,
      sourceRecordSha256: source.recordSha256,
      winnerKind: owner.winnerKind,
      nextState: owner.nextState,
      nextRecordSha256: owner.nextRecordSha256,
      claimSha256: owner.ownerClaimSha256,
    }],
    steps: [],
  });
  const manifest = createB3RecoveryManifestAuthority({
    platform: 'ios',
    captureId: CAPTURE_ID,
    commandSha256: source.commandSha256,
    ownerClaimSha256: owner.ownerClaimSha256,
    captureSnapshotSha256: snapshot.captureSnapshotSha256,
    observationCount: 0,
    terminalObservationSha256: '0'.repeat(64),
  });
  const archive = createB3RecoveryArchiveAuthority({
    platform: 'ios',
    captureId: CAPTURE_ID,
    commandSha256: source.commandSha256,
    ownerClaimSha256: owner.ownerClaimSha256,
    captureSnapshotSha256: snapshot.captureSnapshotSha256,
    manifestSha256: manifest.manifestSha256,
    testedApplicationCommit: COMMIT,
    applicationFingerprint: FINGERPRINT,
  });
  const terminal = createB3RecoveryTerminalAuthority({
    platform: 'ios',
    source: owner.nextRecord,
    ownerClaimSha256: owner.ownerClaimSha256,
    captureSnapshotSha256: snapshot.captureSnapshotSha256,
    manifestSha256: manifest.manifestSha256,
    archiveAuthoritySha256: archive.archiveAuthoritySha256,
  });
  return { source, owner, snapshot, manifest, archive, terminal };
}

test('D4.1 freezes the complete canonical SQLite recovery authority vector', () => {
  const { owner, snapshot, manifest, archive, terminal } = authorityFixture();

  assert.equal(owner.instructionCode, 'REINSTALL_EXACT_BUILD');
  assert.equal(owner.nextState, 'restart-executing');
  assert.equal(owner.ownerClaimSha256,
    '02fcb8a18f17e451741e325c49b11db3df2064d362a488206c285fb1dee5a1c2');
  assert.equal(snapshot.captureSnapshotSha256,
    '26a67f4177b2bbd73d0e5a06c00ce4c51d16b532f7a241c5d956e7202ba2f0c5');
  assert.equal(manifest.manifestSha256,
    'cdba1d9c85ac0962cdc1183410bbe39d8ddce1093439d21c99f68323ac9974c3');
  assert.equal(archive.archiveAuthoritySha256,
    'e943b7b88621203c83d0f27e75c7e89d7389cb6e38307c24427dd66213bfae6a');
  assert.equal(terminal.terminalRecord.state, 'restart-complete');
  assert.equal(terminal.terminalClaimSha256,
    'b5ae67ba6e01f12be84884915995de36085fe250e5f247d959345e3552aec13d');
  assert.deepEqual(Object.keys(owner.claim), [
    'schemaVersion', 'platform', 'winnerKind', 'instructionCode',
    'commandSha256', 'sourceState', 'sourceRecordSha256', 'nextState',
    'nextRecordSha256', 'ownerClaimSha256',
  ]);
  assert.equal(Object.isFrozen(snapshot.commands), true);
  assert.equal(Object.isFrozen(snapshot.decisions), true);
  assert.equal(Object.isFrozen(snapshot.steps), true);
});

test('D4.1 validates exact recovery BLOBs and rejects one-field and byte mutations', () => {
  const { source, owner, snapshot, manifest, archive, terminal } = authorityFixture();
  const ownerInput = { platform: 'ios', source };
  const manifestInput = {
    platform: 'ios', captureId: CAPTURE_ID, commandSha256: source.commandSha256,
    ownerClaimSha256: owner.ownerClaimSha256,
    captureSnapshotSha256: snapshot.captureSnapshotSha256,
    observationCount: 0, terminalObservationSha256: '0'.repeat(64),
  };
  const archiveInput = {
    platform: 'ios', captureId: CAPTURE_ID, commandSha256: source.commandSha256,
    ownerClaimSha256: owner.ownerClaimSha256,
    captureSnapshotSha256: snapshot.captureSnapshotSha256,
    manifestSha256: manifest.manifestSha256,
    testedApplicationCommit: COMMIT, applicationFingerprint: FINGERPRINT,
  };
  const terminalInput = {
    platform: 'ios', source: owner.nextRecord,
    ownerClaimSha256: owner.ownerClaimSha256,
    captureSnapshotSha256: snapshot.captureSnapshotSha256,
    manifestSha256: manifest.manifestSha256,
    archiveAuthoritySha256: archive.archiveAuthoritySha256,
  };

  assert.equal(
    validateB3RecoveryOwnerClaimAuthorityBytes({
      ...ownerInput, bytes: owner.claimBytes,
    }).ownerClaimSha256,
    owner.ownerClaimSha256,
  );
  assert.equal(validateB3CaptureSnapshotAuthority(snapshot).captureSnapshotSha256,
    snapshot.captureSnapshotSha256);
  assert.equal(validateB3RecoveryManifestAuthorityBytes({
    ...manifestInput, bytes: manifest.manifestBytes,
  }).manifestSha256, manifest.manifestSha256);
  assert.equal(validateB3RecoveryArchiveAuthorityBytes({
    ...archiveInput, bytes: archive.authorityBytes,
  }).archiveAuthoritySha256, archive.archiveAuthoritySha256);
  assert.equal(validateB3RecoveryTerminalAuthorityBytes({
    ...terminalInput,
    terminalRecordBytes: terminal.terminalRecordBytes,
    terminalClaimBytes: terminal.terminalClaimBytes,
  }).terminalClaimSha256, terminal.terminalClaimSha256);

  const nonCanonical = Buffer.concat([owner.claimBytes, Buffer.from(' ')]);
  assert.throws(() => validateB3RecoveryOwnerClaimAuthorityBytes({
    ...ownerInput, bytes: nonCanonical,
  }), { code: 'b3_capture_recovery_invalid' });
  const wrongManifest = { ...manifestInput, observationCount: 1 };
  assert.throws(() => validateB3RecoveryManifestAuthorityBytes({
    ...wrongManifest, bytes: manifest.manifestBytes,
  }), { code: 'b3_capture_recovery_invalid' });
  assert.throws(() => validateB3RecoveryArchiveAuthorityBytes({
    ...archiveInput, manifestSha256: 'f'.repeat(64), bytes: archive.authorityBytes,
  }), { code: 'b3_capture_recovery_invalid' });
  assert.throws(() => validateB3RecoveryTerminalAuthorityBytes({
    ...terminalInput, ownerClaimSha256: 'e'.repeat(64),
    terminalRecordBytes: terminal.terminalRecordBytes,
    terminalClaimBytes: terminal.terminalClaimBytes,
  }), { code: 'b3_capture_recovery_invalid' });
  assert.throws(() => validateB3CaptureSnapshotAuthority({
    ...snapshot, captureState: 'working',
  }), { code: 'b3_capture_recovery_invalid' });
});

test('D4.1 sorts snapshot rows by the frozen relational keys', () => {
  const { snapshot } = authorityFixture();
  const secondCommand = {
    ...snapshot.commands[0],
    allocationSequence: 2,
    commandSha256: 'f'.repeat(64),
    predecessorCommandSha256: snapshot.commands[0].commandSha256,
    expectedObservationSequence: 2,
  };
  const reordered = createB3CaptureSnapshotAuthority({
    ...snapshot,
    commands: [secondCommand, snapshot.commands[0]],
    decisions: [],
    steps: [{
      observationSequence: 2, commandSha256: secondCommand.commandSha256,
      recordSha256: 'b'.repeat(64), observationSha256: 'c'.repeat(64),
      checkpointSha256: 'd'.repeat(64),
    }, {
      observationSequence: 1, commandSha256: snapshot.commands[0].commandSha256,
      recordSha256: '8'.repeat(64), observationSha256: '9'.repeat(64),
      checkpointSha256: 'a'.repeat(64),
    }],
  });
  assert.deepEqual(reordered.commands.map(({ allocationSequence }) => allocationSequence),
    [1, 2]);
  assert.deepEqual(reordered.steps.map(({ observationSequence }) => observationSequence),
    [1, 2]);
});

test('D4.1 does not apply the 512 command limit to selected decisions', () => {
  const { snapshot } = authorityFixture();
  const decisions = Array.from({ length: 513 }, (_, index) => ({
    commandSha256: index.toString(16).padStart(64, '0'),
    sourceState: `state-${index.toString().padStart(3, '0')}`,
    sourceRecordSha256: '6'.repeat(64),
    winnerKind: 'ordinary',
    nextState: 'launching',
    nextRecordSha256: '7'.repeat(64),
    claimSha256: '8'.repeat(64),
  }));
  const retained = createB3CaptureSnapshotAuthority({
    ...snapshot,
    decisions: decisions.toReversed(),
  });
  assert.equal(retained.decisions.length, 513);
  assert.equal(retained.decisions[0].commandSha256, '0'.repeat(64));
  assert.equal(retained.decisions.at(-1).commandSha256,
    (512).toString(16).padStart(64, '0'));
  assert.throws(() => createB3CaptureSnapshotAuthority({
    ...snapshot,
    decisions: Array(512 * 13 + 1).fill(decisions[0]),
  }), { code: 'b3_capture_recovery_invalid' });
});
