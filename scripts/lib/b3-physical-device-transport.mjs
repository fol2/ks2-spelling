import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  canonicaliseB3ProofValue,
  validateB3ProofLaunchCommand,
} from '../../src/app/b3-live-proof-protocol.js';
import { parseB3StrictJsonBytes } from '../check-b3-external-prerequisites.mjs';
import { validateB3PngBytes } from './b3-png.mjs';

const execFileAsync = promisify(execFile);
const BUNDLE_ID = 'uk.eugnel.ks2spelling';
const ANDROID_COMPONENT = `${BUNDLE_ID}/.MainActivity`;
const IOS_OBSERVATION_PATH = 'Library/Application Support/b3-proof-observation-v1.json';
const ANDROID_OBSERVATION_PATH = `/sdcard/Android/data/${BUNDLE_ID}/files/b3-proof-observation-v1.json`;
const MAXIMUM_OBSERVATION_BYTES = 64 * 1024;
const MAXIMUM_SCREENSHOT_BYTES = 64 * 1024 * 1024;
const MAXIMUM_DEVICECTL_JSON_BYTES = 256 * 1024;
const IOS_DEVICE_ID = /^[A-Fa-f0-9-]{8,64}$/u;
const ANDROID_DEVICE_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const DEVICE_LABEL = /^[\p{L}\p{N} ._()+-]{1,128}$/u;
const PLATFORM = Object.freeze({
  ios: Object.freeze({
    commandPlatform: 'ios-physical',
    environmentName: 'B3_IOS_PHYSICAL_DEVICE_ID',
    devicePattern: IOS_DEVICE_ID,
  }),
  android: Object.freeze({
    commandPlatform: 'android-play-physical',
    environmentName: 'B3_ANDROID_PHYSICAL_DEVICE_ID',
    devicePattern: ANDROID_DEVICE_ID,
  }),
});

function transportError(message, code = 'b3_physical_device_transport_invalid') {
  return Object.assign(new Error(message), { code });
}

function validateScreenshotPng(bytes) {
  try {
    return validateB3PngBytes(bytes, { maximumBytes: MAXIMUM_SCREENSHOT_BYTES }).bytes;
  } catch {
    throw transportError('B3 physical-device screenshot is not a bounded original-resolution PNG');
  }
}

async function defaultRunner(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: options.maxBuffer ?? 256 * 1024,
      windowsHide: true,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      exitCode: Number.isInteger(error.code) ? error.code : 1,
      stdout: typeof error.stdout === 'string' ? error.stdout : '',
      stderr: typeof error.stderr === 'string' ? error.stderr : '',
    };
  }
}

async function defaultBinaryRunner(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: null,
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: options.maxBuffer ?? MAXIMUM_SCREENSHOT_BYTES,
      windowsHide: true,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      exitCode: Number.isInteger(error.code) ? error.code : 1,
      stdout: Buffer.isBuffer(error.stdout) ? error.stdout : Buffer.alloc(0),
      stderr: Buffer.isBuffer(error.stderr) ? error.stderr : Buffer.alloc(0),
    };
  }
}

async function runText(runner, command, args, options = {}) {
  const result = await runner(command, args, options);
  if (!result || result.exitCode !== 0 || typeof result.stdout !== 'string' ||
      typeof result.stderr !== 'string' ||
      Buffer.byteLength(result.stdout) > (options.maxBuffer ?? 256 * 1024) ||
      Buffer.byteLength(result.stderr) > (options.maxBuffer ?? 256 * 1024)) {
    throw transportError(
      `B3 physical-device command failed: ${command}`,
      'b3_physical_device_command_failed',
    );
  }
  return result;
}

async function runBinary(runner, command, args, options = {}) {
  const result = await runner(command, args, options);
  if (!result || result.exitCode !== 0 || !Buffer.isBuffer(result.stdout) ||
      !Buffer.isBuffer(result.stderr) ||
      result.stdout.length > (options.maxBuffer ?? MAXIMUM_SCREENSHOT_BYTES) ||
      result.stderr.length > 256 * 1024) {
    throw transportError(
      `B3 physical-device binary command failed: ${command}`,
      'b3_physical_device_command_failed',
    );
  }
  return result.stdout;
}

async function ensurePrivateTransportDirectory(root, platform) {
  const canonicalRoot = await realpath(resolve(root));
  let current = canonicalRoot;
  for (const component of ['.native-build', 'b3', 'evidence', `${platform}-transport`]) {
    current = resolve(current, component);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
        (metadata.mode & 0o077) !== 0) {
      throw transportError('B3 physical-device transport directory policy is invalid');
    }
  }
  const directory = await realpath(current);
  if (!directory.startsWith(`${canonicalRoot}/`)) {
    throw transportError('B3 physical-device transport directory escaped the repository');
  }
  return directory;
}

async function readPulledObservation(path) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw transportError('B3 physical-device observation pull did not produce the fixed file');
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size <= 0 ||
        before.size > MAXIMUM_OBSERVATION_BYTES) {
      throw transportError('B3 physical-device observation pull is not a bounded regular file');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw transportError('B3 physical-device observation changed while being read');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readDeviceCtlJson(path, label) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw transportError(`B3 iOS ${label} JSON output is absent or invalid`);
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size <= 0 ||
        metadata.size > MAXIMUM_DEVICECTL_JSON_BYTES) {
      throw transportError(`B3 iOS ${label} JSON output is not a bounded regular file`);
    }
    const value = parseB3StrictJsonBytes(await handle.readFile(), `B3 iOS ${label}`);
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).length !== 2 || !Object.hasOwn(value, 'info') ||
        !Object.hasOwn(value, 'result') || value.info?.outcome !== 'success' ||
        value.result === null || typeof value.result !== 'object' ||
        Array.isArray(value.result)) {
      throw transportError(`B3 iOS ${label} JSON authority is invalid`);
    }
    return value.result;
  } finally {
    await handle.close();
  }
}

function processIdentifier(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw transportError('B3 iOS process PID authority is invalid');
  }
  return value;
}

function physicalIosDevice(result, identifier) {
  if (!Array.isArray(result.devices)) {
    throw transportError('B3 iOS physical device inventory is invalid');
  }
  const matches = result.devices.filter((device) => device?.identifier === identifier);
  if (matches.length !== 1) {
    throw transportError('B3 iOS physical device inventory is absent or ambiguous');
  }
  const device = matches[0];
  const model = device.hardwareProperties?.marketingName;
  const osVersion = device.deviceProperties?.osVersionNumber;
  if (device.hardwareProperties?.reality !== 'physical' ||
      typeof model !== 'string' || !DEVICE_LABEL.test(model) ||
      typeof osVersion !== 'string' || !DEVICE_LABEL.test(osVersion)) {
    throw transportError('B3 iOS model, OS or physical authority is invalid');
  }
  return Object.freeze({ model, osVersion, physical: true });
}

function androidDeviceLabel(value, label) {
  const normalised = value.trim();
  if (!DEVICE_LABEL.test(normalised)) {
    throw transportError(`B3 Android ${label} authority is invalid`);
  }
  return normalised;
}

function deviceIdentifier(platform, env) {
  const authority = PLATFORM[platform];
  const value = env?.[authority.environmentName];
  if (typeof value !== 'string' || !authority.devicePattern.test(value)) {
    throw transportError(`B3 ${platform} physical device identifier is absent or invalid`);
  }
  return value;
}

export function createB3PhysicalDeviceTransport({
  root,
  platform,
  env = process.env,
  runner = defaultRunner,
  binaryRunner = defaultBinaryRunner,
} = {}) {
  if (!Object.hasOwn(PLATFORM, platform) || typeof root !== 'string' ||
      typeof runner !== 'function' || typeof binaryRunner !== 'function') {
    throw transportError('B3 physical-device transport options are invalid');
  }
  const authority = PLATFORM[platform];
  let retainedIosProcessIdentifier = null;

  async function launch(rawCommand) {
    const command = validateB3ProofLaunchCommand(rawCommand);
    if (command.platform !== authority.commandPlatform) {
      throw transportError('B3 physical-device command platform differs from transport platform');
    }
    const id = deviceIdentifier(platform, env);
    const encoded = canonicaliseB3ProofValue(command);
    if (Buffer.byteLength(encoded) > MAXIMUM_OBSERVATION_BYTES) {
      throw transportError('B3 physical-device command exceeds its bound');
    }
    if (platform === 'ios') {
      const parent = await ensurePrivateTransportDirectory(root, platform);
      const temporary = await mkdtemp(resolve(parent, 'launch-'));
      const jsonOutput = resolve(temporary, 'launch.json');
      try {
        await runText(runner, 'xcrun', [
          'devicectl', 'device', 'process', 'launch', '--device', id,
          '--terminate-existing', '--json-output', jsonOutput,
          BUNDLE_ID, '--b3-proof-command-v1', encoded,
        ], { cwd: root, timeoutMs: 30_000 });
        const result = await readDeviceCtlJson(jsonOutput, 'launch');
        if (Object.keys(result).some((key) => !['processIdentifier', 'deviceIdentifier'].includes(key)) ||
            !Object.hasOwn(result, 'processIdentifier')) {
          throw transportError('B3 iOS launch JSON result violates its closed schema');
        }
        retainedIosProcessIdentifier = processIdentifier(result.processIdentifier);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    } else {
      await runText(runner, 'adb', [
        '-s', id, 'shell', 'am', 'start', '-S', '-W', '-n', ANDROID_COMPONENT,
        '--es', `${BUNDLE_ID}.B3_PROOF_COMMAND_V1`, encoded,
      ], { cwd: root, timeoutMs: 30_000 });
    }
  }

  async function pullObservation() {
    const id = deviceIdentifier(platform, env);
    const parent = await ensurePrivateTransportDirectory(root, platform);
    const temporary = await mkdtemp(resolve(parent, 'pull-'));
    const destination = resolve(temporary, 'b3-proof-observation-v1.json');
    try {
      if (platform === 'ios') {
        await runText(runner, 'xcrun', [
          'devicectl', 'device', 'copy', 'from', '--device', id,
          '--source', IOS_OBSERVATION_PATH,
          '--destination', destination,
          '--domain-type', 'appDataContainer',
          '--domain-identifier', BUNDLE_ID,
        ], { cwd: root, timeoutMs: 30_000 });
      } else {
        await runText(runner, 'adb', [
          '-s', id, 'pull', ANDROID_OBSERVATION_PATH, destination,
        ], { cwd: root, timeoutMs: 30_000 });
      }
      return await readPulledObservation(destination);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async function captureScreenshot() {
    if (platform !== 'android') {
      throw transportError('B3 iOS screenshots require the independent XCUITest transport');
    }
    const id = deviceIdentifier(platform, env);
    const bytes = await runBinary(binaryRunner, 'adb', [
      '-s', id, 'exec-out', 'screencap', '-p',
    ], { cwd: root, timeoutMs: 30_000, maxBuffer: MAXIMUM_SCREENSHOT_BYTES });
    return validateScreenshotPng(bytes);
  }

  async function inspectDevice() {
    const id = deviceIdentifier(platform, env);
    if (platform === 'android') {
      const prefix = ['-s', id, 'shell', 'getprop'];
      const [emulator, model, osVersion] = await Promise.all([
        runText(runner, 'adb', [...prefix, 'ro.kernel.qemu'], {
          cwd: root, timeoutMs: 30_000,
        }),
        runText(runner, 'adb', [...prefix, 'ro.product.model'], {
          cwd: root, timeoutMs: 30_000,
        }),
        runText(runner, 'adb', [...prefix, 'ro.build.version.release'], {
          cwd: root, timeoutMs: 30_000,
        }),
      ]);
      if (emulator.stdout.trim() === '1') {
        throw transportError('B3 Android physical device authority rejected an emulator');
      }
      return Object.freeze({
        model: androidDeviceLabel(model.stdout, 'model'),
        osVersion: androidDeviceLabel(osVersion.stdout, 'OS version'),
        physical: true,
      });
    }
    const parent = await ensurePrivateTransportDirectory(root, platform);
    const temporary = await mkdtemp(resolve(parent, 'device-info-'));
    const jsonOutput = resolve(temporary, 'devices.json');
    try {
      await runText(runner, 'xcrun', [
        'devicectl', 'list', 'devices', '--json-output', jsonOutput,
      ], { cwd: root, timeoutMs: 30_000 });
      return physicalIosDevice(
        await readDeviceCtlJson(jsonOutput, 'device inventory'),
        id,
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async function foregroundApplication() {
    if (platform !== 'android') {
      throw transportError('B3 explicit foreground application step is Android-only');
    }
    const id = deviceIdentifier(platform, env);
    await runText(runner, 'adb', [
      '-s', id, 'shell', 'am', 'start', '-W', '-n', ANDROID_COMPONENT,
    ], { cwd: root, timeoutMs: 30_000 });
  }

  async function forceStop({ retainReceipt = async () => {} } = {}) {
    if (typeof retainReceipt !== 'function') {
      throw transportError('B3 force-stop receipt authority is invalid');
    }
    const id = deviceIdentifier(platform, env);
    if (platform === 'android') {
      await runText(runner, 'adb', [
        '-s', id, 'shell', 'am', 'force-stop', BUNDLE_ID,
      ], { cwd: root, timeoutMs: 30_000 });
      return;
    }
    const parent = await ensurePrivateTransportDirectory(root, platform);
    const temporary = await mkdtemp(resolve(parent, 'terminate-'));
    try {
      const processesOutput = resolve(temporary, 'processes.json');
      await runText(runner, 'xcrun', [
        'devicectl', 'device', 'info', 'processes', '--device', id,
        '--json-output', processesOutput,
      ], { cwd: root, timeoutMs: 30_000 });
      const result = await readDeviceCtlJson(processesOutput, 'process inventory');
      if (Object.keys(result).length !== 1 || !Array.isArray(result.runningProcesses) ||
          result.runningProcesses.length > 4096) {
        throw transportError('B3 iOS process inventory result violates its closed schema');
      }
      const matches = result.runningProcesses.filter((process) =>
        process && typeof process === 'object' && !Array.isArray(process) &&
        process.bundleIdentifier === BUNDLE_ID,
      );
      if (matches.length !== 1) {
        throw transportError('B3 iOS running bundle process is absent or ambiguous');
      }
      const pid = processIdentifier(matches[0].processIdentifier);
      if (retainedIosProcessIdentifier !== null && retainedIosProcessIdentifier !== pid) {
        throw transportError('B3 iOS retained launch PID no longer belongs to the running bundle');
      }
      const terminateOutput = resolve(temporary, 'terminate.json');
      await runText(runner, 'xcrun', [
        'devicectl', 'device', 'process', 'terminate', '--device', id,
        '--pid', String(pid), '--kill',
        '--json-output', terminateOutput,
      ], { cwd: root, timeoutMs: 30_000 });
      const terminated = await readDeviceCtlJson(terminateOutput, 'terminate');
      if (Object.keys(terminated).some((key) =>
        !['processIdentifier', 'deviceIdentifier'].includes(key)) ||
          terminated.processIdentifier !== pid) {
        throw transportError('B3 iOS terminate JSON result violates its closed schema');
      }
      await retainReceipt(Object.freeze({
        deviceIdentifier: id,
        processIdentifier: pid,
      }));
      retainedIosProcessIdentifier = null;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  return Object.freeze({
    launch,
    pullObservation,
    captureScreenshot,
    forceStop,
    inspectDevice,
    foregroundApplication,
  });
}
