import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { link, lstat, mkdir, open, opendir, readdir, realpath, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { parseB3StrictJsonBytes } from '../check-b3-external-prerequisites.mjs';
import {
  canonicaliseB3ProofValue,
  validateB3ProofLaunchCommand,
} from '../../src/app/b3-live-proof-protocol.js';

const PLATFORM = Object.freeze({ ios: 'ios-physical', android: 'android-play-physical' });
const HASH = /^[0-9a-f]{64}$/u;
const MAXIMUM_BYTES = 128 * 1024;
const STATES = Object.freeze([
  'prepared', 'stop-intent', 'stop-executing', 'host-stopped',
  'launching', 'reinstall-authorised', 'reinstall-launching', 'launched',
]);
const TRANSITIONS = new Set([
  'prepared:launching',
  'prepared:stop-intent',
  'stop-intent:stop-executing',
  'stop-executing:host-stopped',
  'host-stopped:launching',
  'launching:launched',
  'launching:reinstall-authorised',
  'reinstall-authorised:reinstall-launching',
  'reinstall-launching:launched',
]);
const BASE_NAME = /^(?<hash>[0-9a-f]{64})\.base\.json$/u;
const ENTRY_NAME = /^(?<hash>[0-9a-f]{64})\.(?:base|consumed|state-[a-z-]+|successor-[a-z-]+)\.json$/u;
const PRIVATE_TEMPORARY_NAME = /^\.issued-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;
const MAXIMUM_ALIAS_SCAN_ENTRIES = 512;
const MAXIMUM_TRANSIENT_ALIAS_RETRIES = 32;

function issuedError(message, code = 'b3_issued_command_invalid') {
  return Object.assign(new Error(message), { code });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function directories(root, platform) {
  if (!Object.hasOwn(PLATFORM, platform)) throw issuedError('B3 issued-command platform is invalid');
  const canonicalRoot = await realpath(resolve(root));
  let current = canonicalRoot;
  for (const component of ['.native-build', 'b3', 'evidence']) {
    current = resolve(current, component);
    try { await mkdir(current, { mode: 0o700 }); } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
      throw issuedError('B3 issued-command directory policy is invalid');
    }
  }
  const evidence = await realpath(current);
  current = resolve(evidence, `${platform}-issued-command-ledger`);
  try { await mkdir(current, { mode: 0o700 }); } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const metadata = await lstat(current);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw issuedError('B3 issued-command ledger directory policy is invalid');
  }
  const ledger = await realpath(current);
  if (!evidence.startsWith(`${canonicalRoot}/`) || !ledger.startsWith(`${evidence}/`)) {
    throw issuedError('B3 issued-command directory escaped the repository');
  }
  return { evidence, ledger };
}

async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function readBytes(path) {
  let handle;
  try { handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); } catch (error) {
    if (error?.code === 'ENOENT') throw issuedError('B3 issued command is absent', 'ENOENT');
    throw issuedError('B3 issued-command link or file policy is invalid');
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 ||
        before.size <= 0 || before.size > MAXIMUM_BYTES) {
      throw issuedError('B3 issued-command file policy is invalid');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw issuedError('B3 issued command changed while being read');
    }
    return bytes;
  } finally { await handle.close(); }
}

async function hasTransientPrivateAlias({ evidence, path }) {
  let retained;
  try { retained = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); } catch {
    return false;
  }
  try {
    const retainedMetadata = await retained.stat();
    if (!retainedMetadata.isFile() || retainedMetadata.nlink !== 2 ||
        (retainedMetadata.mode & 0o077) !== 0 || retainedMetadata.size <= 0 ||
        retainedMetadata.size > MAXIMUM_BYTES) {
      return false;
    }
    let scanned = 0;
    const directory = await opendir(evidence);
    for await (const entry of directory) {
      scanned += 1;
      if (scanned > MAXIMUM_ALIAS_SCAN_ENTRIES) return false;
      if (!entry.isFile() || !PRIVATE_TEMPORARY_NAME.test(entry.name)) continue;
      let alias;
      try {
        alias = await open(
          resolve(evidence, entry.name),
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
        );
      } catch {
        continue;
      }
      try {
        const aliasMetadata = await alias.stat();
        if (aliasMetadata.isFile() && aliasMetadata.nlink === 2 &&
            (aliasMetadata.mode & 0o077) === 0 &&
            aliasMetadata.dev === retainedMetadata.dev &&
            aliasMetadata.ino === retainedMetadata.ino &&
            aliasMetadata.size === retainedMetadata.size) {
          return true;
        }
      } finally { await alias.close(); }
    }
    return false;
  } finally { await retained.close(); }
}

async function readImmutableClaimBytes({ evidence, path }) {
  for (let attempt = 0; attempt <= MAXIMUM_TRANSIENT_ALIAS_RETRIES; attempt += 1) {
    try { return await readBytes(path); } catch (error) {
      if (error?.message !== 'B3 issued-command file policy is invalid' ||
          attempt === MAXIMUM_TRANSIENT_ALIAS_RETRIES) {
        throw error;
      }
      if (!await hasTransientPrivateAlias({ evidence, path })) {
        // The installing writer can unlink its alias between the strict read and
        // alias proof. Accept only a subsequent fully strict single-link read.
        return readBytes(path);
      }
      await delay(1);
    }
  }
  throw issuedError('B3 issued-command immutable claim retry bound was exceeded');
}

function record(platform, command, state = 'prepared') {
  if (!STATES.includes(state)) throw issuedError('B3 issued-command state is invalid');
  const commandBytes = Buffer.from(canonicaliseB3ProofValue(command), 'utf8');
  const unsigned = {
    schemaVersion: 3,
    platform,
    state,
    command,
    commandSha256: sha256(Buffer.concat([
      Buffer.from('ks2-spelling:b3-issued-command:v1\0', 'utf8'), commandBytes,
    ])),
  };
  return {
    ...unsigned,
    recordSha256: sha256(Buffer.concat([
      Buffer.from('ks2-spelling:b3-issued-command-record:v3\0', 'utf8'),
      Buffer.from(canonicaliseB3ProofValue(unsigned), 'utf8'),
    ])),
  };
}

function validateRecord(bytes, platform, expectedState) {
  const value = parseB3StrictJsonBytes(bytes, 'B3 issued command');
  if (!value || Object.keys(value).length !== 6 || value.schemaVersion !== 3 ||
      value.platform !== platform || !STATES.includes(value.state) ||
      (expectedState && value.state !== expectedState) ||
      !HASH.test(value.commandSha256 ?? '') || !HASH.test(value.recordSha256 ?? '') ||
      canonicaliseB3ProofValue(value) !== bytes.toString('utf8')) {
    throw issuedError('B3 issued-command record is not canonical or closed');
  }
  const command = validateB3ProofLaunchCommand(value.command);
  const expected = record(platform, command, value.state);
  if (command.platform !== PLATFORM[platform] ||
      expected.commandSha256 !== value.commandSha256 ||
      expected.recordSha256 !== value.recordSha256) {
    throw issuedError('B3 issued-command authority is invalid');
  }
  return Object.freeze({ ...expected, command: Object.freeze(command) });
}

function claim(platform, current, next) {
  const unsigned = {
    schemaVersion: 1,
    platform,
    commandSha256: current.commandSha256,
    expectedState: current.state,
    nextState: next.state,
    nextRecordSha256: next.recordSha256,
  };
  return {
    ...unsigned,
    claimSha256: sha256(Buffer.from(canonicaliseB3ProofValue(unsigned), 'utf8')),
  };
}

function validateClaim(bytes, platform, current) {
  const value = parseB3StrictJsonBytes(bytes, 'B3 issued-command successor claim');
  if (!value || Object.keys(value).length !== 7 || value.schemaVersion !== 1 ||
      value.platform !== platform || value.commandSha256 !== current.commandSha256 ||
      value.expectedState !== current.state || !STATES.includes(value.nextState) ||
      !TRANSITIONS.has(`${value.expectedState}:${value.nextState}`) ||
      !HASH.test(value.nextRecordSha256 ?? '') || !HASH.test(value.claimSha256 ?? '') ||
      canonicaliseB3ProofValue(value) !== bytes.toString('utf8')) {
    throw issuedError('B3 issued-command successor claim is invalid');
  }
  const unsigned = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'claimSha256'));
  if (sha256(Buffer.from(canonicaliseB3ProofValue(unsigned), 'utf8')) !== value.claimSha256) {
    throw issuedError('B3 issued-command successor claim hash is invalid');
  }
  return Object.freeze(value);
}

function tombstone(platform, current) {
  const unsigned = {
    schemaVersion: 1,
    platform,
    commandSha256: current.commandSha256,
    finalRecordSha256: current.recordSha256,
  };
  return {
    ...unsigned,
    tombstoneSha256: sha256(Buffer.from(canonicaliseB3ProofValue(unsigned), 'utf8')),
  };
}

function validateTombstone(bytes, platform, commandSha256) {
  const value = parseB3StrictJsonBytes(bytes, 'B3 issued-command tombstone');
  if (!value || Object.keys(value).length !== 5 || value.schemaVersion !== 1 ||
      value.platform !== platform || value.commandSha256 !== commandSha256 ||
      !HASH.test(value.finalRecordSha256 ?? '') || !HASH.test(value.tombstoneSha256 ?? '') ||
      canonicaliseB3ProofValue(value) !== bytes.toString('utf8')) {
    throw issuedError('B3 issued-command tombstone is invalid');
  }
  const unsigned = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'tombstoneSha256'));
  if (sha256(Buffer.from(canonicaliseB3ProofValue(unsigned), 'utf8')) !== value.tombstoneSha256) {
    throw issuedError('B3 issued-command tombstone hash is invalid');
  }
  return value;
}

function paths(ledger, commandSha256) {
  return {
    base: resolve(ledger, `${commandSha256}.base.json`),
    consumed: resolve(ledger, `${commandSha256}.consumed.json`),
    state: (state) => resolve(ledger, `${commandSha256}.state-${state}.json`),
    successor: (state) => resolve(ledger, `${commandSha256}.successor-${state}.json`),
  };
}

async function readOptional(path) {
  try { return await readBytes(path); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function deriveCommand({ ledger, platform, commandSha256 }) {
  const commandPaths = paths(ledger, commandSha256);
  let current = validateRecord(await readBytes(commandPaths.base), platform, 'prepared');
  if (current.commandSha256 !== commandSha256) {
    throw issuedError('B3 issued-command base filename authority differs');
  }
  const consumedBytes = await readOptional(commandPaths.consumed);
  const visited = new Set();
  while (true) {
    if (visited.has(current.state)) throw issuedError('B3 issued-command ledger contains a cycle');
    visited.add(current.state);
    const claimBytes = await readOptional(commandPaths.successor(current.state));
    if (!claimBytes) {
      if (!consumedBytes) return current;
      const consumed = validateTombstone(consumedBytes, platform, commandSha256);
      if (consumed.finalRecordSha256 !== current.recordSha256) {
        throw issuedError('B3 issued-command tombstone does not consume the derived terminal state');
      }
      return null;
    }
    const successor = validateClaim(claimBytes, platform, current);
    const next = validateRecord(
      await readBytes(commandPaths.state(successor.nextState)),
      platform,
      successor.nextState,
    );
    if (next.commandSha256 !== commandSha256 ||
        next.recordSha256 !== successor.nextRecordSha256 ||
        canonicaliseB3ProofValue(next.command) !== canonicaliseB3ProofValue(current.command)) {
      throw issuedError('B3 issued-command successor record authority differs');
    }
    current = next;
  }
}

async function activeCommands({ ledger, platform }) {
  const entries = await readdir(ledger, { withFileTypes: true });
  if (entries.length > 256 ||
      entries.some((entry) => !entry.isFile() || !ENTRY_NAME.test(entry.name))) {
    throw issuedError('B3 issued-command ledger entry policy is invalid');
  }
  const bases = entries.filter((entry) => BASE_NAME.test(entry.name));
  if (bases.length > 64) throw issuedError('B3 issued-command ledger base count exceeds its bound');
  const active = [];
  for (const entry of bases) {
    const commandSha256 = BASE_NAME.exec(entry.name).groups.hash;
    const current = await deriveCommand({ ledger, platform, commandSha256 });
    if (current) active.push(current);
  }
  if (active.length > 1) throw issuedError('B3 issued-command ledger has multiple active commands');
  return active;
}

async function writeImmutable({ evidence, ledger, path, bytes }) {
  const temporary = resolve(evidence, `.issued-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  let claimed = false;
  try {
    await link(temporary, path);
    claimed = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const retained = await readImmutableClaimBytes({ evidence, path });
    if (!retained.equals(bytes)) throw issuedError('B3 issued-command immutable ledger conflict');
  } finally {
    await rm(temporary, { force: true });
  }
  await syncDirectory(ledger);
  return claimed;
}

export async function readB3IssuedCommand({ root, platform }) {
  if (!Object.hasOwn(PLATFORM, platform)) throw issuedError('B3 issued-command platform is invalid');
  const { ledger } = await directories(root, platform);
  const active = await activeCommands({ ledger, platform });
  if (active.length === 0) throw issuedError('B3 issued command is absent', 'ENOENT');
  return active[0];
}

export async function persistB3IssuedCommand({ root, platform, command: rawCommand }) {
  const command = validateB3ProofLaunchCommand(rawCommand);
  if (command.platform !== PLATFORM[platform]) throw issuedError('B3 issued-command platform differs');
  const { evidence, ledger } = await directories(root, platform);
  const value = record(platform, command, 'prepared');
  const retained = await activeCommands({ ledger, platform });
  if (retained.length === 1) {
    if (retained[0].commandSha256 !== value.commandSha256) {
      throw issuedError('B3 issued command conflicts with the pending command');
    }
    return retained[0];
  }
  const commandPaths = paths(ledger, value.commandSha256);
  if (await readOptional(commandPaths.consumed)) {
    throw issuedError('B3 consumed issued command cannot be reused');
  }
  await writeImmutable({
    evidence,
    ledger,
    path: commandPaths.base,
    bytes: Buffer.from(canonicaliseB3ProofValue(value), 'utf8'),
  });
  return readB3IssuedCommand({ root, platform });
}

export async function transitionB3IssuedCommand({
  root,
  platform,
  command: rawCommand,
  expectedState,
  nextState,
  existingRevisionOnly = false,
}) {
  if (!TRANSITIONS.has(`${expectedState}:${nextState}`) ||
      typeof existingRevisionOnly !== 'boolean') {
    throw issuedError('B3 issued-command state transition is invalid');
  }
  const command = validateB3ProofLaunchCommand(rawCommand);
  const { evidence, ledger } = await directories(root, platform);
  const current = await readB3IssuedCommand({ root, platform });
  if (canonicaliseB3ProofValue(current.command) !== canonicaliseB3ProofValue(command)) {
    throw issuedError('B3 issued-command state transition is stale');
  }
  const next = record(platform, command, nextState);
  const commandPaths = paths(ledger, current.commandSha256);
  if (current.state !== expectedState) {
    const expected = record(platform, command, expectedState);
    const retainedClaim = validateClaim(
      await readBytes(commandPaths.successor(expectedState)),
      platform,
      expected,
    );
    if (retainedClaim.nextState !== nextState ||
        retainedClaim.nextRecordSha256 !== next.recordSha256) {
      throw issuedError('B3 issued-command source state already chose a different successor');
    }
    return Object.freeze({ ...current, transitionClaimed: false });
  }
  const nextBytes = Buffer.from(canonicaliseB3ProofValue(next), 'utf8');
  if (existingRevisionOnly) {
    const retainedClaim = validateClaim(
      await readBytes(commandPaths.successor(expectedState)),
      platform,
      current,
    );
    if (retainedClaim.nextState !== nextState || retainedClaim.nextRecordSha256 !== next.recordSha256) {
      throw issuedError('B3 issued-command existing successor differs');
    }
    return Object.freeze({ ...(await readB3IssuedCommand({ root, platform })), transitionClaimed: false });
  }
  await writeImmutable({
    evidence,
    ledger,
    path: commandPaths.state(nextState),
    bytes: nextBytes,
  });
  const successor = claim(platform, current, next);
  const transitionClaimed = await writeImmutable({
    evidence,
    ledger,
    path: commandPaths.successor(expectedState),
    bytes: Buffer.from(canonicaliseB3ProofValue(successor), 'utf8'),
  });
  const derived = await readB3IssuedCommand({ root, platform });
  if (derived.state !== nextState) {
    throw issuedError('B3 issued-command successor lost its state authority');
  }
  return Object.freeze({ ...derived, transitionClaimed });
}

export async function clearB3IssuedCommand({
  root,
  platform,
  command: rawCommand,
  beforeConsume = async () => {},
}) {
  if (typeof beforeConsume !== 'function') throw issuedError('B3 consume hook is invalid');
  const command = validateB3ProofLaunchCommand(rawCommand);
  const { evidence, ledger } = await directories(root, platform);
  const current = await readB3IssuedCommand({ root, platform });
  if (canonicaliseB3ProofValue(current.command) !== canonicaliseB3ProofValue(command)) {
    throw issuedError('B3 issued command cannot be consumed by different authority');
  }
  await beforeConsume();
  const value = tombstone(platform, current);
  await writeImmutable({
    evidence,
    ledger,
    path: paths(ledger, current.commandSha256).consumed,
    bytes: Buffer.from(canonicaliseB3ProofValue(value), 'utf8'),
  });
}
