import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  link,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { resolve } from 'node:path';

import { parseB3StrictJsonBytes } from '../check-b3-external-prerequisites.mjs';
import { canonicaliseB3ProofValue } from '../../src/app/b3-live-proof-protocol.js';

const HASH = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAXIMUM_ARCHIVES = 4;
const MAXIMUM_AUTHORITY_BYTES = 16 * 1024;
const MAXIMUM_EVIDENCE_ENTRIES = 512;
const PLATFORM = Object.freeze({ ios: 'ios-physical', android: 'android-play-physical' });
const CHECKPOINT_NAME = /^(?:ios|android)-capture-checkpoint\.json(?:\.revision-[0-9]{8}\.json)?$/u;
const AUTHORITY_TEMPORARY = /^\.abandoned-capture-(?<hash>[0-9a-f]{64})-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;
const CAPTURE_BOUND_FILES = Object.freeze({
  ios: Object.freeze(['ios-pending.json', 'cloudflare-device-smoke.json']),
  android: Object.freeze(['android-pending.json']),
});

function archiveError(message, code = 'b3_abandoned_capture_archive_invalid') {
  return Object.assign(new Error(message), { code });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function ensurePrivateDirectory(path) {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw archiveError('B3 abandoned-capture archive directory policy is invalid');
  }
  return realpath(path);
}

async function readPrivateDirectory(path) {
  let metadata;
  try { metadata = await lstat(path); } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw archiveError('B3 abandoned-capture archive directory cannot be inspected');
    }
    throw archiveError(
      'B3 abandoned-capture archive directory is absent',
      'b3_abandoned_capture_archive_absent',
    );
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw archiveError('B3 abandoned-capture archive directory policy is invalid');
  }
  return realpath(path);
}

async function evidenceDirectory(root) {
  const canonicalRoot = await realpath(resolve(root));
  let current = canonicalRoot;
  for (const component of ['.native-build', 'b3', 'evidence']) {
    current = await ensurePrivateDirectory(resolve(current, component));
  }
  if (!current.startsWith(`${canonicalRoot}/`)) {
    throw archiveError('B3 abandoned-capture archive escaped the repository');
  }
  return { canonicalRoot, evidence: current };
}

function buildArchiveAuthority({ platform, issued, buildAuthority }) {
  const command = issued?.command;
  if (!Object.hasOwn(PLATFORM, platform) || command?.platform !== PLATFORM[platform] ||
      !HASH.test(issued?.commandSha256 ?? '') || !UUID_V4.test(command.captureId ?? '') ||
      !Number.isSafeInteger(command.expectedSequence) || command.expectedSequence < 1 ||
      !HASH.test(command.previousObservationSha256 ?? '') ||
      !COMMIT.test(buildAuthority?.testedApplicationCommit ?? '') ||
      !HASH.test(buildAuthority?.applicationFingerprint ?? '') ||
      command.testedApplicationCommit !== buildAuthority.testedApplicationCommit ||
      command.applicationFingerprint !== buildAuthority.applicationFingerprint) {
    throw archiveError('B3 abandoned-capture archive authority is invalid');
  }
  const unsigned = {
    schemaVersion: 1,
    platform,
    captureId: command.captureId,
    commandSha256: issued.commandSha256,
    expectedSequence: command.expectedSequence,
    previousObservationSha256: command.previousObservationSha256,
    testedApplicationCommit: command.testedApplicationCommit,
    applicationFingerprint: command.applicationFingerprint,
  };
  return Object.freeze({
    ...unsigned,
    authoritySha256: sha256(Buffer.from(canonicaliseB3ProofValue(unsigned), 'utf8')),
  });
}

function validateAuthority(bytes, expected) {
  const value = parseB3StrictJsonBytes(bytes, 'B3 abandoned-capture archive authority');
  const unsigned = value && Object.fromEntries(Object.entries(value).filter(
    ([key]) => key !== 'authoritySha256',
  ));
  if (!value || Object.keys(value).length !== 9 || value.schemaVersion !== 1 ||
      !Object.hasOwn(PLATFORM, value.platform) || !UUID_V4.test(value.captureId ?? '') ||
      !HASH.test(value.commandSha256 ?? '') || !Number.isSafeInteger(value.expectedSequence) ||
      value.expectedSequence < 1 || !HASH.test(value.previousObservationSha256 ?? '') ||
      !COMMIT.test(value.testedApplicationCommit ?? '') ||
      !HASH.test(value.applicationFingerprint ?? '') ||
      Object.entries(expected).some(([key, expectedValue]) => value[key] !== expectedValue) ||
      value.authoritySha256 !== sha256(Buffer.from(canonicaliseB3ProofValue(unsigned), 'utf8')) ||
      canonicaliseB3ProofValue(value) !== bytes.toString('utf8')) {
    throw archiveError('B3 abandoned-capture archive authority differs');
  }
  return value;
}

export async function readB3AbandonedCaptureArchive({
  root,
  platform,
  commandSha256,
  buildAuthority,
}) {
  if (!Object.hasOwn(PLATFORM, platform) || !HASH.test(commandSha256 ?? '') ||
      !COMMIT.test(buildAuthority?.testedApplicationCommit ?? '') ||
      !HASH.test(buildAuthority?.applicationFingerprint ?? '')) {
    throw archiveError('B3 abandoned-capture archive lookup authority is invalid');
  }
  const { evidence } = await evidenceDirectory(root);
  const archiveRoot = await readPrivateDirectory(
    resolve(evidence, `${platform}-abandoned-captures`),
  );
  const archive = await readPrivateDirectory(resolve(archiveRoot, commandSha256));
  const authorityPath = resolve(archive, 'authority.json');
  await reconcileAuthorityTemporaries({
    evidence,
    archive,
    path: authorityPath,
    commandSha256,
  });
  const authority = validateAuthority(
    await readRegularPrivateFile(authorityPath),
    {
      platform,
      commandSha256,
      testedApplicationCommit: buildAuthority.testedApplicationCommit,
      applicationFingerprint: buildAuthority.applicationFingerprint,
    },
  );
  return Object.freeze({
    restarted: true,
    abandonedCaptureId: authority.captureId,
    commandSha256: authority.commandSha256,
  });
}

async function readRegularPrivateFile(path, maximumBytes = MAXIMUM_AUTHORITY_BYTES) {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
    );
  } catch {
    throw archiveError('B3 abandoned-capture archive file or link policy is invalid');
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 ||
        before.size <= 0 || before.size > maximumBytes) {
      throw archiveError('B3 abandoned-capture archive file policy is invalid');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1 || (after.mode & 0o077) !== 0 ||
        bytes.length !== before.size || after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs) {
      throw archiveError('B3 abandoned-capture archive file changed while being read');
    }
    return bytes;
  } finally { await handle.close(); }
}

async function reconcileAuthorityTemporaries({ evidence, archive, path, commandSha256 }) {
  const entries = await readdir(evidence, { withFileTypes: true });
  if (entries.length > MAXIMUM_EVIDENCE_ENTRIES) {
    throw archiveError('B3 abandoned-capture evidence entry bound is exceeded');
  }
  const aliases = entries.filter((entry) =>
    AUTHORITY_TEMPORARY.exec(entry.name)?.groups.hash === commandSha256);
  let targetMetadata = null;
  try { targetMetadata = await lstat(path); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  let matchingAlias = null;
  for (const entry of aliases) {
    const aliasPath = resolve(evidence, entry.name);
    const metadata = await lstat(aliasPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 ||
        ![1, 2].includes(metadata.nlink)) {
      throw archiveError('B3 abandoned-capture authority temporary policy is invalid');
    }
    if (targetMetadata && metadata.dev === targetMetadata.dev &&
        metadata.ino === targetMetadata.ino) {
      if (matchingAlias !== null || metadata.nlink !== 2) {
        throw archiveError('B3 abandoned-capture authority alias is ambiguous');
      }
      matchingAlias = aliasPath;
      continue;
    }
    if (metadata.nlink !== 1) {
      throw archiveError('B3 abandoned-capture authority temporary has an external link');
    }
    if (targetMetadata) await rm(aliasPath);
  }
  if (targetMetadata) {
    if (!targetMetadata.isFile() || targetMetadata.isSymbolicLink() ||
        (targetMetadata.mode & 0o077) !== 0 || ![1, 2].includes(targetMetadata.nlink) ||
        (targetMetadata.nlink === 2 && matchingAlias === null)) {
      throw archiveError('B3 abandoned-capture authority link policy is invalid');
    }
    if (matchingAlias !== null) {
      await syncDirectory(archive);
      await rm(matchingAlias);
    }
  }
  await syncDirectory(evidence);
  await syncDirectory(archive);
}

async function retainAuthority({ evidence, archive, authority }) {
  const path = resolve(archive, 'authority.json');
  await reconcileAuthorityTemporaries({
    evidence,
    archive,
    path,
    commandSha256: authority.commandSha256,
  });
  const bytes = Buffer.from(canonicaliseB3ProofValue(authority), 'utf8');
  const temporary = resolve(
    evidence,
    `.abandoned-capture-${authority.commandSha256}-${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle?.close();
  }
  try {
    await link(temporary, path);
    await syncDirectory(archive);
  } catch (error) {
    if (!['EEXIST', 'ENOENT'].includes(error?.code)) throw error;
    try { await lstat(path); } catch { throw error; }
  } finally {
    await rm(temporary, { force: true });
    await syncDirectory(evidence);
  }
  await syncDirectory(archive);
  const retained = validateAuthority(await readRegularPrivateFile(path), authority);
  await reconcileAuthorityTemporaries({
    evidence,
    archive,
    path,
    commandSha256: authority.commandSha256,
  });
  return retained;
}

async function moveDirectoryOnce({ source, destination, sourceParent, destinationParent }) {
  let sourceMetadata = null;
  let destinationMetadata = null;
  try { sourceMetadata = await lstat(source); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try { destinationMetadata = await lstat(destination); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (sourceMetadata && (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink())) {
    throw archiveError('B3 abandoned-capture observation directory policy is invalid');
  }
  if (destinationMetadata &&
      (!destinationMetadata.isDirectory() || destinationMetadata.isSymbolicLink())) {
    throw archiveError('B3 abandoned-capture destination directory policy is invalid');
  }
  if (sourceMetadata && destinationMetadata) {
    try { sourceMetadata = await lstat(source); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      sourceMetadata = null;
    }
    if (sourceMetadata) {
      throw archiveError('B3 abandoned-capture observation archive conflicts');
    }
  }
  if (!sourceMetadata && !destinationMetadata) {
    try { await mkdir(destination, { mode: 0o700 }); } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  if (sourceMetadata) {
    try { await rename(source, destination); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const retained = await lstat(destination);
  if (!retained.isDirectory() || retained.isSymbolicLink() || (retained.mode & 0o077) !== 0) {
    throw archiveError('B3 abandoned-capture observation archive is invalid');
  }
  await syncDirectory(sourceParent);
  await syncDirectory(destinationParent);
}

async function moveFileOnce({ source, destination, sourceParent, destinationParent }) {
  let sourceMetadata = null;
  let destinationMetadata = null;
  try { sourceMetadata = await lstat(source); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try { destinationMetadata = await lstat(destination); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const valid = (metadata) => metadata.isFile() && !metadata.isSymbolicLink() &&
    metadata.nlink === 1 && (metadata.mode & 0o077) === 0;
  if (sourceMetadata && !valid(sourceMetadata)) {
    throw archiveError('B3 abandoned-capture checkpoint source policy is invalid');
  }
  if (destinationMetadata && !valid(destinationMetadata)) {
    throw archiveError('B3 abandoned-capture checkpoint destination policy is invalid');
  }
  if (sourceMetadata && destinationMetadata) {
    try { sourceMetadata = await lstat(source); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      sourceMetadata = null;
    }
    if (sourceMetadata) {
      throw archiveError('B3 abandoned-capture checkpoint archive conflicts');
    }
  }
  if (sourceMetadata) {
    try { await rename(source, destination); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  await readRegularPrivateFile(destination, 128 * 1024);
  await syncDirectory(sourceParent);
  await syncDirectory(destinationParent);
}

export async function archiveB3AbandonedCapture({ root, platform, issued, buildAuthority }) {
  const authority = buildArchiveAuthority({ platform, issued, buildAuthority });
  const { evidence } = await evidenceDirectory(root);
  const archiveRoot = await ensurePrivateDirectory(
    resolve(evidence, `${platform}-abandoned-captures`),
  );
  const entries = await readdir(archiveRoot, { withFileTypes: true });
  if (entries.length > MAXIMUM_ARCHIVES || entries.some((entry) =>
    !entry.isDirectory() || !HASH.test(entry.name))) {
    throw archiveError('B3 abandoned-capture archive entry policy is invalid');
  }
  if (entries.length === MAXIMUM_ARCHIVES &&
      !entries.some(({ name }) => name === issued.commandSha256)) {
    throw archiveError('B3 abandoned-capture archive bound is exhausted');
  }
  const archive = await ensurePrivateDirectory(resolve(archiveRoot, issued.commandSha256));
  const retainedAuthority = await retainAuthority({ evidence, archive, authority });

  await moveDirectoryOnce({
    source: resolve(evidence, `${platform}-observations`),
    destination: resolve(archive, 'observations'),
    sourceParent: evidence,
    destinationParent: archive,
  });

  const checkpointArchive = await ensurePrivateDirectory(resolve(archive, 'checkpoint'));
  const checkpointPrefix = `${platform}-capture-checkpoint.json`;
  const currentEntries = await readdir(evidence, { withFileTypes: true });
  const checkpointNames = currentEntries
    .filter((entry) => entry.name.startsWith(checkpointPrefix))
    .map(({ name }) => name);
  if (checkpointNames.some((name) => !CHECKPOINT_NAME.test(name))) {
    throw archiveError('B3 abandoned-capture checkpoint entry policy is invalid');
  }
  for (const name of checkpointNames.sort()) {
    await moveFileOnce({
      source: resolve(evidence, name),
      destination: resolve(checkpointArchive, name),
      sourceParent: evidence,
      destinationParent: checkpointArchive,
    });
  }
  const remaining = (await readdir(evidence)).filter((name) => name.startsWith(checkpointPrefix));
  if (remaining.length !== 0) {
    throw archiveError('B3 abandoned-capture checkpoint archive is incomplete');
  }

  const derivedArchive = await ensurePrivateDirectory(resolve(archive, 'derived'));
  for (const name of CAPTURE_BOUND_FILES[platform]) {
    let present = true;
    try { await lstat(resolve(evidence, name)); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      present = false;
    }
    let archived = true;
    try { await lstat(resolve(derivedArchive, name)); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      archived = false;
    }
    if (present || archived) {
      await moveFileOnce({
        source: resolve(evidence, name),
        destination: resolve(derivedArchive, name),
        sourceParent: evidence,
        destinationParent: derivedArchive,
      });
    }
  }
  await syncDirectory(archiveRoot);
  await syncDirectory(archive);
  return Object.freeze({
    restarted: true,
    abandonedCaptureId: retainedAuthority.captureId,
    commandSha256: retainedAuthority.commandSha256,
  });
}
