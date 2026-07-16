import { createHash } from 'node:crypto';

import { parseB3StrictJsonBytes } from '../check-b3-external-prerequisites.mjs';
import {
  canonicaliseB3ProofValue,
  validateB3ProofLaunchCommand,
} from '../../src/app/b3-live-proof-protocol.js';

const COMMAND_PLATFORM = Object.freeze({
  ios: 'ios-physical',
  android: 'android-play-physical',
});
const HASH = /^[0-9a-f]{64}$/u;
const STATES = Object.freeze([
  'prepared', 'stop-intent', 'stop-executing', 'host-stopped',
  'launching', 'reinstall-authorised', 'reinstall-launching', 'launched',
  'restart-required', 'restart-executing', 'restart-complete',
]);
const ORDINARY_TRANSITIONS = new Set([
  'prepared:launching',
  'prepared:stop-intent',
  'stop-intent:stop-executing',
  'stop-executing:host-stopped',
  'host-stopped:launching',
  'launching:launched',
  'launching:reinstall-authorised',
  'launching:restart-required',
  'reinstall-authorised:reinstall-launching',
  'reinstall-launching:launched',
  'reinstall-launching:restart-required',
  'restart-required:launched',
]);
const GENERIC_STATES = new Set([
  'prepared', 'stop-intent', 'stop-executing', 'host-stopped',
  'launching', 'reinstall-authorised', 'reinstall-launching', 'launched',
]);

export function isB3OrdinaryIssuedCommandTransition(sourceState, nextState) {
  return typeof sourceState === 'string' && typeof nextState === 'string' &&
    ORDINARY_TRANSITIONS.has(`${sourceState}:${nextState}`);
}

function authorityError(message) {
  return Object.assign(new Error(message), { code: 'b3_issued_command_invalid' });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalBytes(value) {
  return Buffer.from(canonicaliseB3ProofValue(value), 'utf8');
}

export function createB3IssuedCommandStateAuthority({
  platform,
  command: rawCommand,
  state,
}) {
  if (!Object.hasOwn(COMMAND_PLATFORM, platform)) {
    throw authorityError('B3 issued-command platform is invalid');
  }
  if (!STATES.includes(state)) {
    throw authorityError('B3 issued-command state is invalid');
  }
  const command = validateB3ProofLaunchCommand(rawCommand);
  if (command.platform !== COMMAND_PLATFORM[platform]) {
    throw authorityError('B3 issued-command platform differs');
  }
  const commandBytes = canonicalBytes(command);
  const unsigned = {
    schemaVersion: 3,
    platform,
    state,
    command,
    commandSha256: sha256(Buffer.concat([
      Buffer.from('ks2-spelling:b3-issued-command:v1\0', 'utf8'),
      commandBytes,
    ])),
  };
  return Object.freeze({
    ...unsigned,
    command: Object.freeze(command),
    recordSha256: sha256(Buffer.concat([
      Buffer.from('ks2-spelling:b3-issued-command-record:v3\0', 'utf8'),
      canonicalBytes(unsigned),
    ])),
  });
}

export function validateB3IssuedCommandStateAuthorityBytes({
  bytes,
  platform,
  expectedState,
}) {
  const retained = Buffer.from(bytes);
  const value = parseB3StrictJsonBytes(retained, 'B3 issued command');
  if (!value || Object.keys(value).length !== 6 || value.schemaVersion !== 3 ||
      value.platform !== platform || !STATES.includes(value.state) ||
      (expectedState !== undefined && value.state !== expectedState) ||
      !HASH.test(value.commandSha256 ?? '') || !HASH.test(value.recordSha256 ?? '') ||
      canonicaliseB3ProofValue(value) !== retained.toString('utf8')) {
    throw authorityError('B3 issued-command record is not canonical or closed');
  }
  const expected = createB3IssuedCommandStateAuthority({
    platform,
    command: value.command,
    state: value.state,
  });
  if (expected.commandSha256 !== value.commandSha256 ||
      expected.recordSha256 !== value.recordSha256) {
    throw authorityError('B3 issued-command authority is invalid');
  }
  return expected;
}

function validateSource(platform, source) {
  if (!source || typeof source !== 'object' || typeof source.state !== 'string') {
    throw authorityError('B3 issued-command source authority is invalid');
  }
  return validateB3IssuedCommandStateAuthorityBytes({
    bytes: canonicalBytes(source),
    platform,
    expectedState: source.state,
  });
}

export function createB3OrdinaryIssuedCommandClaimAuthority({
  platform,
  source: rawSource,
  nextState,
}) {
  const source = validateSource(platform, rawSource);
  if (!isB3OrdinaryIssuedCommandTransition(source.state, nextState)) {
    throw authorityError('B3 issued-command ordinary transition is invalid');
  }
  const next = createB3IssuedCommandStateAuthority({
    platform,
    command: source.command,
    state: nextState,
  });
  const unsigned = {
    schemaVersion: 1,
    platform,
    commandSha256: source.commandSha256,
    expectedState: source.state,
    nextState,
    nextRecordSha256: next.recordSha256,
  };
  return Object.freeze({
    ...unsigned,
    claimSha256: sha256(canonicalBytes(unsigned)),
  });
}

export function validateB3OrdinaryIssuedCommandClaimAuthorityBytes({
  bytes,
  platform,
  source: rawSource,
}) {
  const source = validateSource(platform, rawSource);
  const retained = Buffer.from(bytes);
  const value = parseB3StrictJsonBytes(retained, 'B3 issued-command successor claim');
  if (!value || Object.keys(value).length !== 7 || value.schemaVersion !== 1 ||
      value.platform !== platform || value.commandSha256 !== source.commandSha256 ||
      value.expectedState !== source.state || typeof value.nextState !== 'string' ||
      !HASH.test(value.nextRecordSha256 ?? '') || !HASH.test(value.claimSha256 ?? '') ||
      canonicaliseB3ProofValue(value) !== retained.toString('utf8')) {
    throw authorityError('B3 issued-command ordinary claim is not canonical or closed');
  }
  const expected = createB3OrdinaryIssuedCommandClaimAuthority({
    platform,
    source,
    nextState: value.nextState,
  });
  if (canonicaliseB3ProofValue(expected) !== retained.toString('utf8')) {
    throw authorityError('B3 issued-command ordinary claim authority differs');
  }
  return expected;
}

export function createB3GenericConsumptionClaimAuthority({
  platform,
  source: rawSource,
}) {
  const source = validateSource(platform, rawSource);
  if (!GENERIC_STATES.has(source.state)) {
    throw authorityError('B3 issued-command generic-consumption state is invalid');
  }
  const unsigned = {
    schemaVersion: 1,
    platform,
    winnerKind: 'generic-consumption',
    commandSha256: source.commandSha256,
    sourceState: source.state,
    sourceRecordSha256: source.recordSha256,
  };
  return Object.freeze({
    ...unsigned,
    claimSha256: sha256(Buffer.concat([
      Buffer.from('ks2-spelling:b3-generic-consumption-claim:v1\0', 'utf8'),
      canonicalBytes(unsigned),
    ])),
  });
}

export function validateB3GenericConsumptionClaimAuthorityBytes({
  bytes,
  platform,
  source: rawSource,
}) {
  const source = validateSource(platform, rawSource);
  const retained = Buffer.from(bytes);
  const value = parseB3StrictJsonBytes(retained, 'B3 generic-consumption claim');
  if (!value || Object.keys(value).length !== 7 || value.schemaVersion !== 1 ||
      value.platform !== platform || value.winnerKind !== 'generic-consumption' ||
      value.commandSha256 !== source.commandSha256 || value.sourceState !== source.state ||
      value.sourceRecordSha256 !== source.recordSha256 ||
      !HASH.test(value.claimSha256 ?? '') ||
      canonicaliseB3ProofValue(value) !== retained.toString('utf8')) {
    throw authorityError('B3 generic-consumption claim is not canonical or closed');
  }
  const expected = createB3GenericConsumptionClaimAuthority({ platform, source });
  if (canonicaliseB3ProofValue(expected) !== retained.toString('utf8')) {
    throw authorityError('B3 generic-consumption claim authority differs');
  }
  return expected;
}

export function createB3PreparedIssuedCommandAuthority({ platform, command }) {
  return createB3IssuedCommandStateAuthority({ platform, command, state: 'prepared' });
}

export function validateB3PreparedIssuedCommandAuthorityBytes({ bytes, platform }) {
  return validateB3IssuedCommandStateAuthorityBytes({
    bytes,
    platform,
    expectedState: 'prepared',
  });
}
