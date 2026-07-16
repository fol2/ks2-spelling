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

function authorityError(message) {
  return Object.assign(new Error(message), { code: 'b3_issued_command_invalid' });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function createB3PreparedIssuedCommandAuthority({ platform, command: rawCommand }) {
  if (!Object.hasOwn(COMMAND_PLATFORM, platform)) {
    throw authorityError('B3 issued-command platform is invalid');
  }
  const command = validateB3ProofLaunchCommand(rawCommand);
  if (command.platform !== COMMAND_PLATFORM[platform]) {
    throw authorityError('B3 issued-command platform differs');
  }
  const commandBytes = Buffer.from(canonicaliseB3ProofValue(command), 'utf8');
  const unsigned = {
    schemaVersion: 3,
    platform,
    state: 'prepared',
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
      Buffer.from(canonicaliseB3ProofValue(unsigned), 'utf8'),
    ])),
  });
}

export function validateB3PreparedIssuedCommandAuthorityBytes({ bytes, platform }) {
  const retained = Buffer.from(bytes);
  const value = parseB3StrictJsonBytes(retained, 'B3 issued command');
  if (!value || Object.keys(value).length !== 6 || value.schemaVersion !== 3 ||
      value.platform !== platform || value.state !== 'prepared' ||
      !HASH.test(value.commandSha256 ?? '') || !HASH.test(value.recordSha256 ?? '') ||
      canonicaliseB3ProofValue(value) !== retained.toString('utf8')) {
    throw authorityError('B3 issued-command record is not canonical or closed');
  }
  const expected = createB3PreparedIssuedCommandAuthority({
    platform,
    command: value.command,
  });
  if (expected.commandSha256 !== value.commandSha256 ||
      expected.recordSha256 !== value.recordSha256) {
    throw authorityError('B3 issued-command authority is invalid');
  }
  return expected;
}
