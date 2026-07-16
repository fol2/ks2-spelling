import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { parseB3StrictJsonBytes } from '../check-b3-external-prerequisites.mjs';
import { runB3PhysicalDeviceProcess } from './b3-physical-device-transport.mjs';
import { validateB3PngBytes } from './b3-png.mjs';

const DEVICE_ID = /^[A-Fa-f0-9-]{8,64}$/u;
const MAXIMUM_TEXT_BYTES = 256 * 1024;
const MAXIMUM_SCREENSHOT_BYTES = 64 * 1024 * 1024;
const ATTACHMENT_NAME = 'b3-ios-sandbox-proof.png';
const TEST_IDENTIFIER = 'B3ProofUITests/B3ProofScreenshotTests/testCaptureInstalledApplication()';

function screenshotError(message, code = 'b3_ios_screenshot_capture_invalid') {
  return Object.assign(new Error(message), { code });
}

function exactKeys(value, required, optional = []) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every((key) => [...required, ...optional].includes(key)) &&
    required.every((key) => Object.hasOwn(value, key));
}

export function runB3IosScreenshotProcess(command, args, options = {}) {
  return runB3PhysicalDeviceProcess(command, args, {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs ?? 10 * 60 * 1000,
    stdoutLimit: MAXIMUM_TEXT_BYTES,
    stderrLimit: MAXIMUM_TEXT_BYTES,
  });
}

const defaultRunner = runB3IosScreenshotProcess;

async function run(runner, command, args, options) {
  const result = await runner(command, args, options);
  if (!result || result.exitCode !== 0 || typeof result.stdout !== 'string' ||
      typeof result.stderr !== 'string' ||
      Buffer.byteLength(result.stdout) > MAXIMUM_TEXT_BYTES ||
      Buffer.byteLength(result.stderr) > MAXIMUM_TEXT_BYTES) {
    throw screenshotError(
      `B3 iOS screenshot command failed: ${basename(command)}`,
      'b3_ios_screenshot_command_failed',
    );
  }
}

async function ensurePrivateParent(root) {
  const canonicalRoot = await realpath(resolve(root));
  let current = canonicalRoot;
  for (const component of ['.native-build', 'b3', 'evidence', 'ios-screenshot']) {
    current = resolve(current, component);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
        (metadata.mode & 0o077) !== 0) {
      throw screenshotError('B3 iOS screenshot directory policy is invalid');
    }
  }
  const parent = await realpath(current);
  if (!parent.startsWith(`${canonicalRoot}/`)) {
    throw screenshotError('B3 iOS screenshot directory escaped the repository');
  }
  return parent;
}

function selectAttachment(manifest, deviceId) {
  if (!Array.isArray(manifest) || manifest.length === 0 || manifest.length > 16) {
    throw screenshotError('B3 iOS screenshot attachment manifest is invalid');
  }
  const matches = [];
  for (const test of manifest) {
    if (!exactKeys(test, ['testIdentifier', 'attachments'], ['testIdentifierURL']) ||
        typeof test.testIdentifier !== 'string' || !Array.isArray(test.attachments) ||
        test.attachments.length > 16) {
      throw screenshotError('B3 iOS screenshot attachment manifest is invalid');
    }
    for (const attachment of test.attachments) {
      if (!exactKeys(attachment, [
        'exportedFileName', 'suggestedHumanReadableName', 'isAssociatedWithFailure',
        'configurationName', 'deviceName', 'deviceId',
      ], ['timestamp', 'repetitionNumber', 'arguments']) ||
          typeof attachment.exportedFileName !== 'string' ||
          typeof attachment.suggestedHumanReadableName !== 'string' ||
          typeof attachment.isAssociatedWithFailure !== 'boolean' ||
          typeof attachment.configurationName !== 'string' ||
          typeof attachment.deviceName !== 'string' ||
          typeof attachment.deviceId !== 'string') {
        throw screenshotError('B3 iOS screenshot attachment manifest is invalid');
      }
      if (test.testIdentifier === TEST_IDENTIFIER &&
          attachment.suggestedHumanReadableName === ATTACHMENT_NAME) {
        matches.push(attachment);
      }
    }
  }
  if (matches.length !== 1 || matches[0].deviceId !== deviceId ||
      matches[0].isAssociatedWithFailure ||
      matches[0].exportedFileName !== basename(matches[0].exportedFileName) ||
      matches[0].exportedFileName.normalize('NFC') !== matches[0].exportedFileName ||
      matches[0].configurationName.length === 0 || matches[0].deviceName.length === 0) {
    throw screenshotError('B3 iOS screenshot named attachment, device or path authority is invalid');
  }
  return matches[0].exportedFileName;
}

async function readScreenshot(path) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw screenshotError('B3 iOS screenshot attachment path is invalid');
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 57 ||
        before.size > MAXIMUM_SCREENSHOT_BYTES) {
      throw screenshotError('B3 iOS screenshot attachment is not a bounded regular file');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw screenshotError('B3 iOS screenshot attachment bytes are invalid');
    }
    try {
      return validateB3PngBytes(bytes, { maximumBytes: MAXIMUM_SCREENSHOT_BYTES }).bytes;
    } catch {
      throw screenshotError('B3 iOS screenshot attachment bytes are invalid');
    }
  } finally {
    await handle.close();
  }
}

export async function captureB3IosScreenshotBytes({
  root,
  deviceId,
  runner = defaultRunner,
} = {}) {
  if (typeof root !== 'string' || typeof runner !== 'function' ||
      typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) {
    throw screenshotError('B3 iOS physical device identifier or capture options are invalid');
  }
  const parent = await ensurePrivateParent(root);
  const temporary = await mkdtemp(resolve(parent, 'capture-'));
  const resultBundle = resolve(temporary, 'B3ProofScreenshot.xcresult');
  const exported = resolve(temporary, 'attachments');
  try {
    await run(runner, 'xcodebuild', [
      '-project', resolve(root, 'ios/App/App.xcodeproj'),
      '-scheme', 'B3ProofUITests',
      '-configuration', 'B3SandboxProof',
      '-destination', `id=${deviceId}`,
      '-resultBundlePath', resultBundle,
      '-only-testing:B3ProofUITests/B3ProofScreenshotTests/testCaptureInstalledApplication',
      'test',
    ], { cwd: root, timeoutMs: 10 * 60 * 1000 });
    const resultMetadata = await lstat(resultBundle).catch(() => null);
    if (!resultMetadata?.isDirectory() || resultMetadata.isSymbolicLink()) {
      throw screenshotError('B3 iOS screenshot result bundle is absent or invalid');
    }
    await run(runner, 'xcrun', [
      'xcresulttool', 'export', 'attachments',
      '--path', resultBundle,
      '--output-path', exported,
    ], { cwd: root, timeoutMs: 60_000 });
    const manifest = parseB3StrictJsonBytes(
      await readFile(resolve(exported, 'manifest.json')),
      'B3 iOS screenshot attachment manifest',
    );
    const filename = selectAttachment(manifest, deviceId);
    return await readScreenshot(resolve(exported, filename));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
