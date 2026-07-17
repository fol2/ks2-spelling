import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { canonicaliseB3ProofValue } from '../../src/app/b3-live-proof-protocol.js';
import { parseB3StrictJsonBytes } from '../check-b3-external-prerequisites.mjs';
import { B3_CAPTURE_STATE_REPOSITORY_ROOT } from './b3-capture-state-location.mjs';

const COMPONENTS = Object.freeze(['.native-build', 'b3', 'distribution']);
const AUTHORITY_NAME = 'build-authority.json';
const COMMIT = /^[0-9a-f]{40}$/u;
const HASH = /^[0-9a-f]{64}$/u;

function sourceError(message) {
  return Object.assign(new Error(message), { code: 'b3_capture_state_invalid' });
}

function normaliseSourceError(error) {
  if (error?.code === 'b3_capture_state_invalid') return error;
  return sourceError(error?.message ?? 'B3 build-authority source is invalid');
}

function identity(metadata) {
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    nlink: metadata.nlink,
    size: metadata.size,
    mtime: metadata.mtimeMs,
    ctime: metadata.ctimeMs,
  });
}

function validateDirectory(metadata, label) {
  if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
      (metadata.mode & 0o7777) !== 0o700) {
    throw sourceError(`B3 build-authority ${label} directory policy is invalid`);
  }
}

function validateFile(metadata) {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 ||
      (metadata.mode & 0o7777) !== 0o600 || metadata.size < 1 ||
      metadata.size > 16 * 1024) {
    throw sourceError('B3 build-authority file policy is invalid');
  }
}

function parseAuthority(bytes) {
  let parsed;
  try {
    parsed = parseB3StrictJsonBytes(bytes, 'B3 distribution build authority');
  } catch (error) {
    throw sourceError(error?.message ?? 'B3 build-authority JSON is invalid');
  }
  if (!parsed || Object.keys(parsed).length !== 6 || parsed.schemaVersion !== 1 ||
      !COMMIT.test(parsed.testedApplicationCommit ?? '') ||
      !HASH.test(parsed.applicationFingerprint ?? '') ||
      parsed.versionName !== '0.3.0-b3' ||
      !/^[1-9][0-9]*$/u.test(parsed.iosBuildNumber ?? '') ||
      !Number.isSafeInteger(parsed.androidVersionCode) ||
      parsed.androidVersionCode <= 0) {
    throw sourceError('B3 build-authority semantic value is invalid');
  }
  const value = Object.freeze({
    schemaVersion: parsed.schemaVersion,
    testedApplicationCommit: parsed.testedApplicationCommit,
    applicationFingerprint: parsed.applicationFingerprint,
    versionName: parsed.versionName,
    iosBuildNumber: parsed.iosBuildNumber,
    androidVersionCode: parsed.androidVersionCode,
  });
  const canonicalBytes = Buffer.from(canonicaliseB3ProofValue(value), 'utf8');
  return Object.freeze({
    bytes: canonicalBytes,
    sha256: createHash('sha256').update(canonicalBytes).digest('hex'),
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    value,
    buildAuthority: Object.freeze({
      testedApplicationCommit: value.testedApplicationCommit,
      applicationFingerprint: value.applicationFingerprint,
    }),
  });
}

function result(parsed, ancestors, file) {
  const canonicalBytes = Buffer.from(parsed.bytes);
  return Object.freeze({
    get bytes() { return Buffer.from(canonicalBytes); },
    sha256: parsed.sha256,
    sourceSha256: parsed.sourceSha256,
    value: parsed.value,
    buildAuthority: parsed.buildAuthority,
    identity: Object.freeze({
      ancestors: Object.freeze(ancestors.map((entry) => Object.freeze({ ...entry }))),
      file: Object.freeze({ ...file }),
    }),
  });
}

async function assertAsyncAncestorSnapshot(paths, retained) {
  const current = [];
  for (const path of paths) current.push(identity(await lstat(path)));
  if (!isDeepStrictEqual(current, retained)) {
    throw sourceError('B3 build-authority ancestor identity changed while being read');
  }
}

async function readBuildAuthoritySourceOnce() {
  const root = await realpath(B3_CAPTURE_STATE_REPOSITORY_ROOT);
  if (root !== B3_CAPTURE_STATE_REPOSITORY_ROOT) {
    throw sourceError('B3 build-authority repository root is not canonical');
  }
  const paths = [];
  const ancestors = [];
  let parent = root;
  for (const component of COMPONENTS) {
    const path = resolve(parent, component);
    const metadata = await lstat(path);
    validateDirectory(metadata, component);
    if (await realpath(path) !== path || !path.startsWith(`${root}/`)) {
      throw sourceError('B3 build-authority directory escaped the repository');
    }
    paths.push(path);
    ancestors.push(identity(metadata));
    parent = path;
  }
  const path = resolve(parent, AUTHORITY_NAME);
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    validateFile(before);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathname = await lstat(path);
    if (!isDeepStrictEqual(identity(after), identity(before)) ||
        !isDeepStrictEqual(identity(pathname), identity(before)) ||
        await realpath(path) !== path ||
        bytes.length !== before.size) {
      throw sourceError('B3 build-authority file identity changed while being read');
    }
    await assertAsyncAncestorSnapshot(paths, ancestors);
    return result(parseAuthority(bytes), ancestors, identity(before));
  } finally {
    await handle.close();
  }
}

export async function readB3BuildAuthoritySource(...options) {
  if (options.length !== 0) {
    throw sourceError('B3 build-authority source accepts no caller authority');
  }
  try {
    return await readBuildAuthoritySourceOnce();
  } catch (error) {
    throw normaliseSourceError(error);
  }
}

function assertSyncAncestorSnapshot(paths, retained) {
  const current = paths.map((path) => identity(lstatSync(path)));
  if (!isDeepStrictEqual(current, retained)) {
    throw sourceError('B3 build-authority ancestor identity changed while being read');
  }
}

function readDescriptorBytes(descriptor, size) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  if (offset !== bytes.length) {
    throw sourceError('B3 build-authority file was truncated while being read');
  }
  return bytes;
}

function readBuildAuthoritySourceSyncOnce() {
  const root = realpathSync(B3_CAPTURE_STATE_REPOSITORY_ROOT);
  if (root !== B3_CAPTURE_STATE_REPOSITORY_ROOT) {
    throw sourceError('B3 build-authority repository root is not canonical');
  }
  const paths = [];
  const ancestors = [];
  let parent = root;
  for (const component of COMPONENTS) {
    const path = resolve(parent, component);
    const metadata = lstatSync(path);
    validateDirectory(metadata, component);
    if (realpathSync(path) !== path || !path.startsWith(`${root}/`)) {
      throw sourceError('B3 build-authority directory escaped the repository');
    }
    paths.push(path);
    ancestors.push(identity(metadata));
    parent = path;
  }
  const path = resolve(parent, AUTHORITY_NAME);
  const descriptor = openSync(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const before = fstatSync(descriptor);
    validateFile(before);
    const bytes = readDescriptorBytes(descriptor, before.size);
    const after = fstatSync(descriptor);
    const pathname = lstatSync(path);
    if (!isDeepStrictEqual(identity(after), identity(before)) ||
        !isDeepStrictEqual(identity(pathname), identity(before)) ||
        realpathSync(path) !== path ||
        bytes.length !== before.size) {
      throw sourceError('B3 build-authority file identity changed while being read');
    }
    assertSyncAncestorSnapshot(paths, ancestors);
    return result(parseAuthority(bytes), ancestors, identity(before));
  } finally {
    closeSync(descriptor);
  }
}

export function readB3BuildAuthoritySourceSync(...options) {
  if (options.length !== 0) {
    throw sourceError('B3 build-authority source accepts no caller authority');
  }
  try {
    return readBuildAuthoritySourceSyncOnce();
  } catch (error) {
    throw normaliseSourceError(error);
  }
}
