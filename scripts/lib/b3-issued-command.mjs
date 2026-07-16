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
  'restart-required', 'restart-executing', 'restart-complete',
]);
const TRANSITIONS = new Set([
  'prepared:launching',
  'prepared:stop-intent',
  'stop-intent:stop-executing',
  'stop-executing:host-stopped',
  'host-stopped:launching',
  'launching:launched',
  'launching:reinstall-authorised',
  'launching:restart-required',
  'reinstall-launching:restart-required',
  'restart-required:launched',
  'restart-required:restart-executing',
  'restart-executing:restart-complete',
  'reinstall-authorised:reinstall-launching',
  'reinstall-launching:launched',
]);
const RECOVERY_SUCCESSOR_TRANSITIONS = Object.freeze({
  'restart-required': Object.freeze([
    Object.freeze(['restart-required', 'restart-executing']),
    Object.freeze(['restart-executing', 'restart-complete']),
  ]),
  'restart-executing': Object.freeze([
    Object.freeze(['restart-executing', 'restart-complete']),
  ]),
  'restart-complete': Object.freeze([]),
});
const COMMAND_CHAIN_ROOT_NAME = 'command-chain-root.json';
const BASE_NAME = /^(?<hash>[0-9a-f]{64})\.base\.json$/u;
const NEXT_COMMAND_NAME = /^(?<hash>[0-9a-f]{64})\.next-command\.json$/u;
const ENTRY_NAME = /^(?:command-chain-root|[0-9a-f]{64}\.(?:base|consumed|next-command|state-[a-z-]+|successor-[a-z-]+))\.json$/u;
const PRIVATE_TEMPORARY_NAME = /^\.issued-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;
const MAXIMUM_ALIAS_SCAN_ENTRIES = 512;
const MAXIMUM_TRANSIENT_ALIAS_RETRIES = 32;
// Four bounded abandoned Android journeys plus one final eighteen-command
// journey require ninety immutable allocations without manual ledger deletion.
const MAXIMUM_COMMAND_CHAIN_LENGTH = 96;
const MAXIMUM_LEDGER_ENTRIES = 768;

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

async function findVerifiedPrivateAlias({ evidence, path }) {
  let retained;
  try { retained = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); } catch {
    return null;
  }
  try {
    const retainedMetadata = await retained.stat();
    if (!retainedMetadata.isFile() || retainedMetadata.nlink !== 2 ||
        (retainedMetadata.mode & 0o077) !== 0 || retainedMetadata.size <= 0 ||
        retainedMetadata.size > MAXIMUM_BYTES) {
      return null;
    }
    let scanned = 0;
    const directory = await opendir(evidence);
    for await (const entry of directory) {
      scanned += 1;
      if (scanned > MAXIMUM_ALIAS_SCAN_ENTRIES) return null;
      if (!entry.isFile() || !PRIVATE_TEMPORARY_NAME.test(entry.name)) continue;
      const aliasPath = resolve(evidence, entry.name);
      let alias;
      try {
        alias = await open(
          aliasPath,
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
          return aliasPath;
        }
      } finally { await alias.close(); }
    }
    return null;
  } finally { await retained.close(); }
}

async function removeVerifiedPrivateAlias({ evidence, path, aliasPath }) {
  const verified = await findVerifiedPrivateAlias({ evidence, path });
  if (verified !== aliasPath) return false;
  const ledger = resolve(path, '..');
  // Preserve the claimed target before making the stale writer alias disappear.
  await syncDirectory(ledger);
  try {
    await rm(aliasPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await syncDirectory(evidence);
  await syncDirectory(ledger);
  return true;
}

async function readImmutableClaimBytes({ evidence, path }) {
  for (let attempt = 0; attempt <= MAXIMUM_TRANSIENT_ALIAS_RETRIES; attempt += 1) {
    try { return await readBytes(path); } catch (error) {
      if (error?.message !== 'B3 issued-command file policy is invalid') throw error;
      const aliasPath = await findVerifiedPrivateAlias({ evidence, path });
      if (aliasPath === null) {
        // The installing writer can unlink its alias between the strict read and
        // alias proof. Accept only a subsequent fully strict single-link read.
        return readBytes(path);
      }
      if (attempt === MAXIMUM_TRANSIENT_ALIAS_RETRIES) {
        await removeVerifiedPrivateAlias({ evidence, path, aliasPath });
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
    nextCommand: resolve(ledger, `${commandSha256}.next-command.json`),
    state: (state) => resolve(ledger, `${commandSha256}.state-${state}.json`),
    successor: (state) => resolve(ledger, `${commandSha256}.successor-${state}.json`),
  };
}

async function readOptional({ evidence, path }) {
  try { return await readImmutableClaimBytes({ evidence, path }); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function deriveCommand({ evidence, ledger, platform, commandSha256 }) {
  const commandPaths = paths(ledger, commandSha256);
  let current = validateRecord(
    await readImmutableClaimBytes({ evidence, path: commandPaths.base }),
    platform,
    'prepared',
  );
  if (current.commandSha256 !== commandSha256) {
    throw issuedError('B3 issued-command base filename authority differs');
  }
  const consumedBytes = await readOptional({ evidence, path: commandPaths.consumed });
  const visited = new Set();
  while (true) {
    if (visited.has(current.state)) throw issuedError('B3 issued-command ledger contains a cycle');
    visited.add(current.state);
    const claimBytes = await readOptional({
      evidence,
      path: commandPaths.successor(current.state),
    });
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
      await readImmutableClaimBytes({
        evidence,
        path: commandPaths.state(successor.nextState),
      }),
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

async function ledgerEntries(ledger) {
  const entries = await readdir(ledger, { withFileTypes: true });
  if (entries.length > MAXIMUM_LEDGER_ENTRIES ||
      entries.some((entry) => !entry.isFile() || !ENTRY_NAME.test(entry.name))) {
    throw issuedError('B3 issued-command ledger entry policy is invalid');
  }
  const bases = entries.filter((entry) => BASE_NAME.test(entry.name));
  const nextCommands = entries.filter((entry) => NEXT_COMMAND_NAME.test(entry.name));
  if (bases.length > MAXIMUM_COMMAND_CHAIN_LENGTH) {
    throw issuedError('B3 issued-command ledger base count exceeds its bound');
  }
  if (nextCommands.length >= MAXIMUM_COMMAND_CHAIN_LENGTH) {
    throw issuedError('B3 issued-command allocation chain exceeds its bound');
  }
  return { entries, bases, nextCommands };
}

async function claimImmutable({
  evidence,
  ledger,
  path,
  bytes,
  beforeTargetSync = async () => {},
}) {
  const temporary = resolve(evidence, `.issued-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  let claimed = false;
  let retained = bytes;
  let removeTemporary = true;
  try {
    await link(temporary, path);
    claimed = true;
    removeTemporary = false;
    // Make the immutable target durable before removing the only writer alias.
    // A death before this fsync leaves the exact alias for restart reconciliation.
    await beforeTargetSync();
    await syncDirectory(ledger);
    removeTemporary = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    retained = await readImmutableClaimBytes({ evidence, path });
  } finally {
    if (removeTemporary) {
      await rm(temporary, { force: true });
      await syncDirectory(evidence);
    }
  }
  await syncDirectory(ledger);
  return Object.freeze({ claimed, bytes: retained });
}

async function writeImmutable({ evidence, ledger, path, bytes }) {
  const result = await claimImmutable({ evidence, ledger, path, bytes });
  if (!result.bytes.equals(bytes)) throw issuedError('B3 issued-command immutable ledger conflict');
  const { claimed } = result;
  return claimed;
}

async function ensureAllocatedBase({ evidence, ledger, platform, allocation, bytes }) {
  const base = paths(ledger, allocation.commandSha256).base;
  let retained;
  try {
    retained = await readImmutableClaimBytes({ evidence, path: base });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await writeImmutable({ evidence, ledger, path: base, bytes });
    return;
  }
  const retainedRecord = validateRecord(retained, platform, 'prepared');
  if (retainedRecord.commandSha256 !== allocation.commandSha256 ||
      retainedRecord.recordSha256 !== allocation.recordSha256 || !retained.equals(bytes)) {
    throw issuedError('B3 issued-command allocated base differs from its immutable claim');
  }
}

async function inspectCommandChain({ evidence, ledger, platform }) {
  // The fixed root and consumed-predecessor successors form one append-only,
  // platform-global allocation chain. Each claim carries the canonical prepared
  // record so a process death before base materialisation remains recoverable.
  const initial = await ledgerEntries(ledger);
  const rootPath = resolve(ledger, COMMAND_CHAIN_ROOT_NAME);
  const hasRoot = initial.entries.some(({ name }) => name === COMMAND_CHAIN_ROOT_NAME);
  if (!hasRoot) {
    if (initial.bases.length > 0 || initial.nextCommands.length > 0) {
      throw issuedError('B3 issued-command ledger has authority without a global root claim');
    }
    return Object.freeze({ active: Object.freeze([]), tail: null, length: 0 });
  }

  let allocationBytes = await readImmutableClaimBytes({ evidence, path: rootPath });
  const commandHashes = new Set();
  const traversedNextClaims = new Set();
  let active = null;
  let tail = null;
  for (let index = 0; index < MAXIMUM_COMMAND_CHAIN_LENGTH; index += 1) {
    const allocation = validateRecord(allocationBytes, platform, 'prepared');
    if (commandHashes.has(allocation.commandSha256)) {
      throw issuedError('B3 issued-command allocation chain contains a cycle');
    }
    commandHashes.add(allocation.commandSha256);
    await ensureAllocatedBase({
      evidence,
      ledger,
      platform,
      allocation,
      bytes: allocationBytes,
    });
    const current = await deriveCommand({
      evidence,
      ledger,
      platform,
      commandSha256: allocation.commandSha256,
    });
    tail = allocation;
    let nextBytes = null;
    try {
      nextBytes = await readImmutableClaimBytes({
        evidence,
        path: paths(ledger, allocation.commandSha256).nextCommand,
      });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (current !== null) {
      if (nextBytes !== null) {
        throw issuedError('B3 issued-command successor allocation has an active predecessor');
      }
      active = current;
      break;
    }
    if (nextBytes === null) break;
    traversedNextClaims.add(`${allocation.commandSha256}.next-command.json`);
    allocationBytes = nextBytes;
    if (index === MAXIMUM_COMMAND_CHAIN_LENGTH - 1) {
      throw issuedError('B3 issued-command allocation chain exceeds its bound');
    }
  }

  const finalEntries = await ledgerEntries(ledger);
  const unexpectedNextClaims = finalEntries.nextCommands
    .map(({ name }) => name)
    .filter((name) => !traversedNextClaims.has(name));
  if (unexpectedNextClaims.length > 0) {
    const expectedTailClaim = tail === null ? null : `${tail.commandSha256}.next-command.json`;
    if (active === null && unexpectedNextClaims.length === 1 &&
        unexpectedNextClaims[0] === expectedTailClaim) {
      return null;
    }
    throw issuedError('B3 issued-command allocation claim is orphaned or unanchored');
  }
  const allocatedBases = new Set([...commandHashes].map((hash) => `${hash}.base.json`));
  if (finalEntries.bases.length !== allocatedBases.size ||
      finalEntries.bases.some(({ name }) => !allocatedBases.has(name))) {
    throw issuedError('B3 issued-command base is absent from the global allocation chain');
  }
  return Object.freeze({
    active: Object.freeze(active === null ? [] : [active]),
    tail,
    length: commandHashes.size,
  });
}

async function commandChain(options) {
  for (let attempt = 0; attempt <= MAXIMUM_TRANSIENT_ALIAS_RETRIES; attempt += 1) {
    const chain = await inspectCommandChain(options);
    if (chain !== null) return chain;
    await delay(1);
  }
  throw issuedError('B3 issued-command allocation reconciliation retry bound was exceeded');
}

async function activeCommands(options) {
  return (await commandChain(options)).active;
}

export async function readB3IssuedCommand({ root, platform }) {
  if (!Object.hasOwn(PLATFORM, platform)) throw issuedError('B3 issued-command platform is invalid');
  const { evidence, ledger } = await directories(root, platform);
  const active = await activeCommands({ evidence, ledger, platform });
  if (active.length === 0) throw issuedError('B3 issued command is absent', 'ENOENT');
  return active[0];
}

async function readExactConsumedB3RecoverySuccessor({
  root,
  platform,
  commandSha256,
  recordSha256,
  state,
}) {
  const { evidence, ledger } = await directories(root, platform);
  const commandPaths = paths(ledger, commandSha256);
  const base = validateRecord(
    await readImmutableClaimBytes({ evidence, path: commandPaths.base }),
    platform,
    'prepared',
  );
  if (base.commandSha256 !== commandSha256) {
    throw issuedError('B3 issued-command recovery base authority differs');
  }
  let current = validateRecord(
    await readImmutableClaimBytes({ evidence, path: commandPaths.state(state) }),
    platform,
    state,
  );
  if (current.commandSha256 !== commandSha256 || current.recordSha256 !== recordSha256 ||
      canonicaliseB3ProofValue(current.command) !== canonicaliseB3ProofValue(base.command)) {
    throw issuedError('B3 issued-command recovery predecessor authority differs');
  }
  for (const [expectedState, nextState] of RECOVERY_SUCCESSOR_TRANSITIONS[state]) {
    if (current.state !== expectedState) {
      throw issuedError('B3 issued-command consumed recovery chain is incomplete');
    }
    const successor = validateClaim(
      await readImmutableClaimBytes({
        evidence,
        path: commandPaths.successor(expectedState),
      }),
      platform,
      current,
    );
    const next = validateRecord(
      await readImmutableClaimBytes({ evidence, path: commandPaths.state(nextState) }),
      platform,
      nextState,
    );
    if (successor.nextState !== nextState ||
        successor.nextRecordSha256 !== next.recordSha256 ||
        next.commandSha256 !== commandSha256 ||
        canonicaliseB3ProofValue(next.command) !== canonicaliseB3ProofValue(current.command)) {
      throw issuedError('B3 issued-command consumed recovery successor authority differs');
    }
    current = next;
  }
  if (current.state !== 'restart-complete') {
    throw issuedError('B3 issued-command consumed recovery is not terminal');
  }
  const consumed = validateTombstone(
    await readImmutableClaimBytes({ evidence, path: commandPaths.consumed }),
    platform,
    commandSha256,
  );
  if (consumed.finalRecordSha256 !== current.recordSha256) {
    throw issuedError('B3 issued-command consumed recovery tombstone authority differs');
  }
  const chain = await commandChain({ evidence, ledger, platform });
  if (chain.active.length !== 0 || chain.tail?.commandSha256 !== commandSha256) {
    throw issuedError('B3 issued-command consumed recovery was replaced');
  }
  return Object.freeze({ ...current, transitionClaimed: false, recoveryConsumed: true });
}

export async function readB3IssuedCommandRecoverySuccessor({
  root,
  platform,
  commandSha256,
  recordSha256,
  state,
  afterCurrentRead = async () => {},
}) {
  if (!Object.hasOwn(RECOVERY_SUCCESSOR_TRANSITIONS, state) || !HASH.test(commandSha256 ?? '') ||
      !HASH.test(recordSha256 ?? '') || typeof afterCurrentRead !== 'function') {
    throw issuedError('B3 issued-command recovery predecessor authority is invalid');
  }
  let current;
  try {
    current = await readB3IssuedCommand({ root, platform });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return readExactConsumedB3RecoverySuccessor({
      root,
      platform,
      commandSha256,
      recordSha256,
      state,
    });
  }
  const predecessor = record(platform, current.command, state);
  const transitions = RECOVERY_SUCCESSOR_TRANSITIONS[state];
  const allowedStates = transitions.map(([, nextState]) => nextState);
  if (current.commandSha256 !== commandSha256 || predecessor.recordSha256 !== recordSha256 ||
      !allowedStates.includes(current.state)) {
    throw issuedError('B3 issued command is not a recovery successor of the pinned invocation');
  }
  await afterCurrentRead(current);

  // `existingRevisionOnly` verifies each immutable successor claim without
  // creating one. Walking every edge up to the already-derived current state
  // makes adoption depend on the retained ledger chain, not state names alone.
  let adopted = current;
  try {
    for (const [expectedState, nextState] of transitions) {
      adopted = await transitionB3IssuedCommand({
        root,
        platform,
        command: current.command,
        expectedState,
        nextState,
        existingRevisionOnly: true,
      });
      if (nextState === adopted.state) break;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return readExactConsumedB3RecoverySuccessor({
      root,
      platform,
      commandSha256,
      recordSha256,
      state,
    });
  }
  if (adopted.commandSha256 !== commandSha256 || !allowedStates.includes(adopted.state)) {
    throw issuedError('B3 issued-command recovery successor changed during adoption');
  }
  return adopted;
}

export async function persistB3IssuedCommand({
  root,
  platform,
  command: rawCommand,
  beforeAllocationSync = async () => {},
}) {
  if (typeof beforeAllocationSync !== 'function') {
    throw issuedError('B3 issued-command allocation sync hook is invalid');
  }
  const command = validateB3ProofLaunchCommand(rawCommand);
  if (command.platform !== PLATFORM[platform]) throw issuedError('B3 issued-command platform differs');
  const { evidence, ledger } = await directories(root, platform);
  const value = record(platform, command, 'prepared');
  const chain = await commandChain({ evidence, ledger, platform });
  if (chain.active.length === 1) {
    if (chain.active[0].commandSha256 !== value.commandSha256) {
      throw issuedError('B3 issued command conflicts with the pending command');
    }
    return chain.active[0];
  }
  if (chain.length >= MAXIMUM_COMMAND_CHAIN_LENGTH) {
    throw issuedError('B3 issued-command allocation chain exceeds its bound');
  }
  const commandPaths = paths(ledger, value.commandSha256);
  if (await readOptional({ evidence, path: commandPaths.consumed })) {
    throw issuedError('B3 consumed issued command cannot be reused');
  }
  const bytes = Buffer.from(canonicaliseB3ProofValue(value), 'utf8');
  const allocationPath = chain.tail === null
    ? resolve(ledger, COMMAND_CHAIN_ROOT_NAME)
    : paths(ledger, chain.tail.commandSha256).nextCommand;
  const allocation = await claimImmutable({
    evidence,
    ledger,
    path: allocationPath,
    bytes,
    beforeTargetSync: beforeAllocationSync,
  });
  const winner = validateRecord(allocation.bytes, platform, 'prepared');
  await ensureAllocatedBase({
    evidence,
    ledger,
    platform,
    allocation: winner,
    bytes: allocation.bytes,
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
      await readImmutableClaimBytes({
        evidence,
        path: commandPaths.successor(expectedState),
      }),
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
      await readImmutableClaimBytes({
        evidence,
        path: commandPaths.successor(expectedState),
      }),
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
