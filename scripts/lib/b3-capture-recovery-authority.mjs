import { createHash } from 'node:crypto';

import { parseB3StrictJsonBytes } from '../check-b3-external-prerequisites.mjs';
import { canonicaliseB3ProofValue } from '../../src/app/b3-live-proof-protocol.js';
import {
  createB3IssuedCommandStateAuthority,
  validateB3IssuedCommandStateAuthorityBytes,
} from './b3-issued-command-authority.mjs';

const HASH = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PLATFORMS = new Set(['ios', 'android']);
const ZERO_SHA256 = '0'.repeat(64);
const DECISION_KINDS = new Set([
  'ordinary', 'generic-consumption', 'recovery-owner',
]);
const MAXIMUM_CAPTURE_DECISIONS = 512 * 13;

function authorityError(message) {
  return Object.assign(new Error(message), { code: 'b3_capture_recovery_invalid' });
}

function withAuthorityInputBoundary(operation) {
  try {
    return operation();
  } catch (error) {
    if (error?.code === 'b3_capture_recovery_invalid') throw error;
    if (error?.code === 'b3_issued_command_invalid' ||
        error?.code === 'B3_PROOF_PROTOCOL_INVALID' ||
        error instanceof TypeError || error instanceof SyntaxError ||
        error instanceof RangeError ||
        (error instanceof Error && error.message.startsWith('B3 '))) {
      throw authorityError(error.message);
    }
    throw error;
  }
}

function sha256(domain, value) {
  return createHash('sha256').update(Buffer.concat([
    Buffer.from(domain, 'utf8'),
    canonicalBytes(value),
  ])).digest('hex');
}

function canonicalBytes(value) {
  return Buffer.from(canonicaliseB3ProofValue(value), 'utf8');
}

function assertPlatform(platform) {
  if (!PLATFORMS.has(platform)) {
    throw authorityError('B3 capture recovery platform is invalid');
  }
}

function assertHash(value, label) {
  if (!HASH.test(value ?? '')) {
    throw authorityError(`B3 capture recovery ${label} is invalid`);
  }
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function frozenRows(rows, keys, label, comparator, maximumLength = 512) {
  if (!Array.isArray(rows) || rows.length > maximumLength) {
    throw authorityError(`B3 capture snapshot ${label} are invalid`);
  }
  const copied = rows.map((row) => {
    if (!exactKeys(row, keys)) {
      throw authorityError(`B3 capture snapshot ${label} row is not closed`);
    }
    return Object.freeze({ ...row });
  });
  copied.sort(comparator);
  return Object.freeze(copied);
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function validatedSource({ platform, source, expectedState }) {
  assertPlatform(platform);
  if (!source || typeof source !== 'object') {
    throw authorityError('B3 capture recovery source authority is invalid');
  }
  return validateB3IssuedCommandStateAuthorityBytes({
    bytes: canonicalBytes(source),
    platform,
    expectedState,
  });
}

function createB3RecoveryOwnerClaimAuthorityUnchecked({ platform, source: rawSource }) {
  const source = validatedSource({
    platform,
    source: rawSource,
    expectedState: 'restart-required',
  });
  const nextRecord = createB3IssuedCommandStateAuthority({
    platform,
    command: source.command,
    state: 'restart-executing',
  });
  const unsigned = {
    schemaVersion: 1,
    platform,
    winnerKind: 'recovery-owner',
    instructionCode: 'REINSTALL_EXACT_BUILD',
    commandSha256: source.commandSha256,
    sourceState: 'restart-required',
    sourceRecordSha256: source.recordSha256,
    nextState: 'restart-executing',
    nextRecordSha256: nextRecord.recordSha256,
  };
  const claim = Object.freeze({
    ...unsigned,
    ownerClaimSha256: sha256(
      'ks2-spelling:b3-recovery-owner-claim:v1\0',
      unsigned,
    ),
  });
  return Object.freeze({
    ...claim,
    claim,
    claimBytes: canonicalBytes(claim),
    nextRecord,
    nextRecordBytes: canonicalBytes(nextRecord),
  });
}

export function createB3RecoveryOwnerClaimAuthority(options) {
  return withAuthorityInputBoundary(() =>
    createB3RecoveryOwnerClaimAuthorityUnchecked(options));
}

export function validateB3RecoveryOwnerClaimAuthorityBytes({ bytes, ...options }) {
  return withAuthorityInputBoundary(() => {
    const retained = Buffer.from(bytes);
    parseB3StrictJsonBytes(retained, 'B3 recovery-owner claim');
    const expected = createB3RecoveryOwnerClaimAuthorityUnchecked(options);
    if (!retained.equals(expected.claimBytes)) {
      throw authorityError('B3 recovery-owner claim authority differs');
    }
    return expected;
  });
}

function createB3CaptureSnapshotAuthorityUnchecked({
  platform,
  captureId,
  startIntentSha256,
  captureState,
  captureRowVersion,
  testedApplicationCommit,
  applicationFingerprint,
  commands: rawCommands,
  decisions: rawDecisions,
  steps: rawSteps,
}) {
  assertPlatform(platform);
  if (!UUID.test(captureId ?? '') || captureState !== 'abandoned' ||
      captureRowVersion !== 2 || !COMMIT.test(testedApplicationCommit ?? '') ||
      !HASH.test(applicationFingerprint ?? '')) {
    throw authorityError('B3 capture snapshot authority is invalid');
  }
  assertHash(startIntentSha256, 'start intent SHA-256');
  const commands = frozenRows(rawCommands, [
    'allocationSequence', 'commandSha256', 'predecessorCommandSha256',
    'commandJsonSha256', 'preparedRecordSha256',
    'expectedObservationSequence', 'previousObservationSha256',
  ], 'commands', (left, right) => left.allocationSequence - right.allocationSequence);
  for (const row of commands) {
    if (!Number.isSafeInteger(row.allocationSequence) || row.allocationSequence < 1 ||
        !Number.isSafeInteger(row.expectedObservationSequence) ||
        row.expectedObservationSequence < 1 || row.expectedObservationSequence > 512 ||
        (row.predecessorCommandSha256 !== null &&
          !HASH.test(row.predecessorCommandSha256 ?? ''))) {
      throw authorityError('B3 capture snapshot command row is invalid');
    }
    for (const key of [
      'commandSha256', 'commandJsonSha256', 'preparedRecordSha256',
      'previousObservationSha256',
    ]) assertHash(row[key], `command ${key}`);
  }
  const decisions = frozenRows(rawDecisions, [
    'commandSha256', 'sourceState', 'sourceRecordSha256', 'winnerKind',
    'nextState', 'nextRecordSha256', 'claimSha256',
  ], 'decisions', (left, right) =>
    compareText(left.commandSha256, right.commandSha256) ||
    compareText(left.sourceState, right.sourceState), MAXIMUM_CAPTURE_DECISIONS);
  for (const row of decisions) {
    if (typeof row.sourceState !== 'string' || row.sourceState.length === 0 ||
        !DECISION_KINDS.has(row.winnerKind) ||
        (row.nextState !== null && typeof row.nextState !== 'string') ||
        (row.nextRecordSha256 !== null && !HASH.test(row.nextRecordSha256 ?? ''))) {
      throw authorityError('B3 capture snapshot decision row is invalid');
    }
    for (const key of [
      'commandSha256', 'sourceRecordSha256', 'claimSha256',
    ]) assertHash(row[key], `decision ${key}`);
  }
  const steps = frozenRows(rawSteps, [
    'observationSequence', 'commandSha256', 'recordSha256',
    'observationSha256', 'checkpointSha256',
  ], 'steps', (left, right) => left.observationSequence - right.observationSequence);
  for (const row of steps) {
    if (!Number.isSafeInteger(row.observationSequence) ||
        row.observationSequence < 1 || row.observationSequence > 512) {
      throw authorityError('B3 capture snapshot step row is invalid');
    }
    for (const key of [
      'commandSha256', 'recordSha256', 'observationSha256', 'checkpointSha256',
    ]) assertHash(row[key], `step ${key}`);
  }
  const unsigned = Object.freeze({
    schemaVersion: 1,
    platform,
    captureId,
    startIntentSha256,
    captureState: 'abandoned',
    captureRowVersion: 2,
    testedApplicationCommit,
    applicationFingerprint,
    commands,
    decisions,
    steps,
  });
  return Object.freeze({
    ...unsigned,
    captureSnapshotSha256: sha256(
      'ks2-spelling:b3-capture-snapshot:v1\0',
      unsigned,
    ),
  });
}

export function createB3CaptureSnapshotAuthority(options) {
  return withAuthorityInputBoundary(() =>
    createB3CaptureSnapshotAuthorityUnchecked(options));
}

export function validateB3CaptureSnapshotAuthority(snapshot) {
  return withAuthorityInputBoundary(() => {
    if (!exactKeys(snapshot, [
      'schemaVersion', 'platform', 'captureId', 'startIntentSha256',
      'captureState', 'captureRowVersion', 'testedApplicationCommit',
      'applicationFingerprint', 'commands', 'decisions', 'steps',
      'captureSnapshotSha256',
    ]) || snapshot.schemaVersion !== 1) {
      throw authorityError('B3 capture snapshot is not closed');
    }
    const expected = createB3CaptureSnapshotAuthorityUnchecked(snapshot);
    if (canonicaliseB3ProofValue(expected) !== canonicaliseB3ProofValue(snapshot)) {
      throw authorityError('B3 capture snapshot authority differs');
    }
    return expected;
  });
}

function createB3RecoveryManifestAuthorityUnchecked({
  platform,
  captureId,
  commandSha256,
  ownerClaimSha256,
  captureSnapshotSha256,
  observationCount,
  terminalObservationSha256,
}) {
  assertPlatform(platform);
  if (!UUID.test(captureId ?? '') || !Number.isSafeInteger(observationCount) ||
      observationCount < 0 || observationCount > 512) {
    throw authorityError('B3 recovery manifest authority is invalid');
  }
  for (const [label, value] of [
    ['command SHA-256', commandSha256],
    ['owner claim SHA-256', ownerClaimSha256],
    ['capture snapshot SHA-256', captureSnapshotSha256],
    ['terminal observation SHA-256', terminalObservationSha256],
  ]) assertHash(value, label);
  if (observationCount === 0 && terminalObservationSha256 !== ZERO_SHA256) {
    throw authorityError('B3 empty recovery manifest terminal observation differs');
  }
  const unsigned = {
    schemaVersion: 2,
    platform,
    captureId,
    commandSha256,
    ownerClaimSha256,
    captureSnapshotSha256,
    observationCount,
    terminalObservationSha256,
  };
  const manifest = Object.freeze({
    ...unsigned,
    manifestSha256: sha256(
      'ks2-spelling:b3-recovery-manifest:v2\0',
      unsigned,
    ),
  });
  return Object.freeze({
    ...manifest,
    manifest,
    manifestBytes: canonicalBytes(manifest),
  });
}

export function createB3RecoveryManifestAuthority(options) {
  return withAuthorityInputBoundary(() =>
    createB3RecoveryManifestAuthorityUnchecked(options));
}

export function validateB3RecoveryManifestAuthorityBytes({ bytes, ...options }) {
  return withAuthorityInputBoundary(() => {
    const retained = Buffer.from(bytes);
    parseB3StrictJsonBytes(retained, 'B3 recovery manifest');
    const expected = createB3RecoveryManifestAuthorityUnchecked(options);
    if (!retained.equals(expected.manifestBytes)) {
      throw authorityError('B3 recovery manifest authority differs');
    }
    return expected;
  });
}

function createB3RecoveryArchiveAuthorityUnchecked({
  platform,
  captureId,
  commandSha256,
  ownerClaimSha256,
  captureSnapshotSha256,
  manifestSha256,
  testedApplicationCommit,
  applicationFingerprint,
}) {
  assertPlatform(platform);
  if (!UUID.test(captureId ?? '') || !COMMIT.test(testedApplicationCommit ?? '') ||
      !HASH.test(applicationFingerprint ?? '')) {
    throw authorityError('B3 recovery archive authority is invalid');
  }
  for (const [label, value] of [
    ['command SHA-256', commandSha256],
    ['owner claim SHA-256', ownerClaimSha256],
    ['capture snapshot SHA-256', captureSnapshotSha256],
    ['manifest SHA-256', manifestSha256],
  ]) assertHash(value, label);
  const unsigned = {
    schemaVersion: 3,
    platform,
    captureId,
    commandSha256,
    ownerClaimSha256,
    captureSnapshotSha256,
    manifestSha256,
    testedApplicationCommit,
    applicationFingerprint,
  };
  const authority = Object.freeze({
    ...unsigned,
    archiveAuthoritySha256: sha256(
      'ks2-spelling:b3-recovery-archive-authority:v3\0',
      unsigned,
    ),
  });
  return Object.freeze({
    ...authority,
    authority,
    authorityBytes: canonicalBytes(authority),
  });
}

export function createB3RecoveryArchiveAuthority(options) {
  return withAuthorityInputBoundary(() =>
    createB3RecoveryArchiveAuthorityUnchecked(options));
}

export function validateB3RecoveryArchiveAuthorityBytes({ bytes, ...options }) {
  return withAuthorityInputBoundary(() => {
    const retained = Buffer.from(bytes);
    parseB3StrictJsonBytes(retained, 'B3 recovery archive authority');
    const expected = createB3RecoveryArchiveAuthorityUnchecked(options);
    if (!retained.equals(expected.authorityBytes)) {
      throw authorityError('B3 recovery archive authority differs');
    }
    return expected;
  });
}

function createB3RecoveryTerminalAuthorityUnchecked({
  platform,
  source: rawSource,
  ownerClaimSha256,
  captureSnapshotSha256,
  manifestSha256,
  archiveAuthoritySha256,
}) {
  const source = validatedSource({
    platform,
    source: rawSource,
    expectedState: 'restart-executing',
  });
  for (const [label, value] of [
    ['owner claim SHA-256', ownerClaimSha256],
    ['capture snapshot SHA-256', captureSnapshotSha256],
    ['manifest SHA-256', manifestSha256],
    ['archive authority SHA-256', archiveAuthoritySha256],
  ]) assertHash(value, label);
  const terminalRecord = createB3IssuedCommandStateAuthority({
    platform,
    command: source.command,
    state: 'restart-complete',
  });
  const unsigned = {
    schemaVersion: 1,
    platform,
    winnerKind: 'recovery-terminal',
    commandSha256: source.commandSha256,
    sourceState: 'restart-executing',
    sourceRecordSha256: source.recordSha256,
    ownerClaimSha256,
    captureSnapshotSha256,
    manifestSha256,
    archiveAuthoritySha256,
    terminalRecordSha256: terminalRecord.recordSha256,
  };
  const terminalClaim = Object.freeze({
    ...unsigned,
    terminalClaimSha256: sha256(
      'ks2-spelling:b3-recovery-terminal-claim:v1\0',
      unsigned,
    ),
  });
  return Object.freeze({
    ...terminalClaim,
    terminalRecord,
    terminalRecordBytes: canonicalBytes(terminalRecord),
    terminalClaim,
    terminalClaimBytes: canonicalBytes(terminalClaim),
  });
}

export function createB3RecoveryTerminalAuthority(options) {
  return withAuthorityInputBoundary(() =>
    createB3RecoveryTerminalAuthorityUnchecked(options));
}

export function validateB3RecoveryTerminalAuthorityBytes({
  terminalRecordBytes,
  terminalClaimBytes,
  ...options
}) {
  return withAuthorityInputBoundary(() => {
    const retainedRecord = Buffer.from(terminalRecordBytes);
    const retainedClaim = Buffer.from(terminalClaimBytes);
    parseB3StrictJsonBytes(retainedRecord, 'B3 recovery terminal record');
    parseB3StrictJsonBytes(retainedClaim, 'B3 recovery terminal claim');
    const expected = createB3RecoveryTerminalAuthorityUnchecked(options);
    if (!retainedRecord.equals(expected.terminalRecordBytes) ||
        !retainedClaim.equals(expected.terminalClaimBytes)) {
      throw authorityError('B3 recovery terminal authority differs');
    }
    return expected;
  });
}
