import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { parseB3StrictJsonBytes } from '../check-b3-external-prerequisites.mjs';
import { canonicaliseB3ProofValue } from '../../src/app/b3-live-proof-protocol.js';
import { validateB3PngBytes } from './b3-png.mjs';

const MAXIMUM_SCREENSHOT_BYTES = 64 * 1024 * 1024;
const MAXIMUM_ATTESTATION_BYTES = 16 * 1024;
const SCREENSHOT_RELATIVE = '.native-build/b3/evidence/android-play-protect-settings.png';
const ATTESTATION_RELATIVE =
  '.native-build/b3/evidence/android-play-protect-root-attestation.json';

function attestationError(message, code = 'b3_play_protect_attestation_invalid') {
  return Object.assign(new Error(message), { code });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function validatePng(rawBytes) {
  try {
    return validateB3PngBytes(rawBytes, {
      maximumBytes: MAXIMUM_SCREENSHOT_BYTES,
      label: 'B3 Play Protect settings capture',
    }).bytes;
  } catch {
    throw attestationError('B3 Play Protect settings capture is not an original PNG');
  }
}

async function privateEvidenceDirectory(root) {
  const canonicalRoot = await realpath(resolve(root));
  let current = canonicalRoot;
  for (const component of ['.native-build', 'b3', 'evidence']) {
    current = resolve(current, component);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
        (metadata.mode & 0o077) !== 0) {
      throw attestationError('B3 Play Protect evidence directory policy is invalid');
    }
  }
  const directory = await realpath(current);
  if (!directory.startsWith(`${canonicalRoot}/`)) {
    throw attestationError('B3 Play Protect evidence directory escaped the repository');
  }
  return directory;
}

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readSecure(path, maximumBytes, label) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw attestationError(
        `B3 Play Protect ${label} is absent`,
        'b3_play_protect_attestation_absent',
      );
    }
    if (error?.code === 'ELOOP') {
      throw attestationError(`B3 Play Protect ${label} is linked`);
    }
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 ||
        before.size <= 0 || before.size > maximumBytes) {
      throw attestationError(`B3 Play Protect ${label} file policy is invalid`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw attestationError(`B3 Play Protect ${label} changed while being read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function captureB3PlayProtectSettingsScreenshot({ root, bytes: rawBytes }) {
  const bytes = validatePng(rawBytes);
  const directory = await privateEvidenceDirectory(root);
  const path = resolve(directory, 'android-play-protect-settings.png');
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  await syncDirectory(directory);
  const retained = validatePng(await readSecure(path, MAXIMUM_SCREENSHOT_BYTES, 'screenshot'));
  if (!retained.equals(bytes)) {
    throw attestationError('B3 Play Protect screenshot persistence changed its bytes');
  }
  return Object.freeze({ path: SCREENSHOT_RELATIVE, sha256: sha256(bytes) });
}

export async function inspectB3PlayProtectRootAttestation({ root }) {
  const directory = await privateEvidenceDirectory(root);
  const screenshotBytes = validatePng(await readSecure(
    resolve(directory, 'android-play-protect-settings.png'),
    MAXIMUM_SCREENSHOT_BYTES,
    'screenshot',
  ));
  const attestationBytes = await readSecure(
    resolve(directory, 'android-play-protect-root-attestation.json'),
    MAXIMUM_ATTESTATION_BYTES,
    'root attestation',
  );
  const value = parseB3StrictJsonBytes(attestationBytes, 'B3 Play Protect root attestation');
  const keys = ['schemaVersion', 'platform', 'screenshotPath', 'screenshotSha256', 'playCertified'];
  const screenshotSha256 = sha256(screenshotBytes);
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)) ||
      canonicaliseB3ProofValue(value) !== attestationBytes.toString('utf8') ||
      value.schemaVersion !== 1 || value.platform !== 'android-play-physical' ||
      value.screenshotPath !== SCREENSHOT_RELATIVE ||
      value.screenshotSha256 !== screenshotSha256 || value.playCertified !== true) {
    throw attestationError('B3 Play Protect root attestation authority is invalid');
  }
  return Object.freeze({
    playCertified: true,
    playProtectSettingsScreenshotSha256: screenshotSha256,
    playProtectRootAttestationSha256: sha256(attestationBytes),
    attestationPath: ATTESTATION_RELATIVE,
  });
}
