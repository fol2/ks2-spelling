import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  link,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  canonicaliseB3ProofValue,
  validateB3ProofLaunchCommand,
} from '../../src/app/b3-live-proof-protocol.js';
import { parseB3StrictJsonBytes } from '../check-b3-external-prerequisites.mjs';
import { validateB3PngBytes } from './b3-png.mjs';

const BUNDLE_ID = 'uk.eugnel.ks2spelling';
const ANDROID_COMPONENT = `${BUNDLE_ID}/.MainActivity`;
const IOS_OBSERVATION_PATH = 'Library/Application Support/b3-proof-observation-v1.json';
const ANDROID_OBSERVATION_PATH = `/sdcard/Android/data/${BUNDLE_ID}/files/b3-proof-observation-v1.json`;
const MAXIMUM_OBSERVATION_BYTES = 64 * 1024;
const MAXIMUM_SCREENSHOT_BYTES = 64 * 1024 * 1024;
const MAXIMUM_DEVICECTL_JSON_BYTES = 256 * 1024;
export const B3_PHYSICAL_DEVICE_PROCESS_TERMINATION_GRACE_MS = 250;
const MAXIMUM_LAUNCH_IDENTITY_BYTES = 4 * 1024;
const LAUNCH_IDENTITY_NAME = /^(?<sequence>(?:0[0-9]{7}|[1-9][0-9]{7,15}))-(?<commandSha256>[0-9a-f]{64})\.launch-identity\.json$/u;
const PRIVATE_LAUNCH_IDENTITY_TEMPORARY = /^\.launch-identity-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;
const IOS_DEVICE_ID = /^[A-Fa-f0-9-]{8,64}$/u;
const ANDROID_DEVICE_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const DEVICE_LABEL = /^[\p{L}\p{N} ._()+-]{1,128}$/u;
const IOS_PROCESS_START_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
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

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function validateScreenshotPng(bytes) {
  try {
    return validateB3PngBytes(bytes, { maximumBytes: MAXIMUM_SCREENSHOT_BYTES }).bytes;
  } catch {
    throw transportError('B3 physical-device screenshot is not a bounded original-resolution PNG');
  }
}

export function runB3PhysicalDeviceProcess(command, args, {
  cwd,
  env = process.env,
  timeoutMs = 30_000,
  stdoutLimit = 256 * 1024,
  stderrLimit = 256 * 1024,
  encoding = 'utf8',
} = {}) {
  if (typeof command !== 'string' || command.length === 0 ||
      !Array.isArray(args) || args.some((argument) => typeof argument !== 'string') ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 ||
      !Number.isSafeInteger(stdoutLimit) || stdoutLimit <= 0 ||
      !Number.isSafeInteger(stderrLimit) || stderrLimit <= 0 ||
      !['utf8', null].includes(encoding)) {
    throw new TypeError('B3 owned process options are invalid');
  }
  return new Promise((resolveProcess) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputExceeded = false;
    let timedOut = false;
    let spawnError = null;
    let closeResult = null;
    let terminationStarted = false;
    let escalationComplete = true;
    let settled = false;

    const killGroup = (signal) => {
      if (!Number.isSafeInteger(child.pid)) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try { child.kill(signal); } catch { /* The process may already be gone. */ }
      }
    };
    const finish = () => {
      if (settled || closeResult === null || !escalationComplete) return;
      settled = true;
      const stdoutBuffer = Buffer.concat(stdout, stdoutBytes);
      const stderrBuffer = Buffer.concat(stderr, stderrBytes);
      resolveProcess({
        exitCode: timedOut || outputExceeded || spawnError
          ? 1
          : Number.isInteger(closeResult.code) ? closeResult.code : 1,
        signal: closeResult.signal,
        timedOut,
        outputExceeded,
        stdout: encoding === null ? stdoutBuffer : stdoutBuffer.toString(encoding),
        stderr: encoding === null ? stderrBuffer : stderrBuffer.toString(encoding),
      });
    };
    const terminate = () => {
      if (terminationStarted) return;
      terminationStarted = true;
      escalationComplete = false;
      killGroup('SIGTERM');
      setTimeout(() => {
        killGroup('SIGKILL');
        escalationComplete = true;
        finish();
      }, B3_PHYSICAL_DEVICE_PROCESS_TERMINATION_GRACE_MS);
    };
    const retain = (target, chunk, currentBytes, limit) => {
      const bytes = Buffer.from(chunk);
      const remaining = Math.max(0, limit - currentBytes);
      if (remaining > 0) target.push(bytes.subarray(0, remaining));
      if (bytes.length > remaining) {
        outputExceeded = true;
        terminate();
      }
      return currentBytes + Math.min(bytes.length, remaining);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdoutBytes = retain(stdout, chunk, stdoutBytes, stdoutLimit);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes = retain(stderr, chunk, stderrBytes, stderrLimit);
    });
    child.on('error', (error) => { spawnError = error; });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      closeResult = { code, signal };
      finish();
    });
  });
}

function defaultRunner(command, args, options = {}) {
  const maximum = options.maxBuffer ?? 256 * 1024;
  return runB3PhysicalDeviceProcess(command, args, {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs ?? 30_000,
    stdoutLimit: maximum,
    stderrLimit: maximum,
  });
}

function defaultBinaryRunner(command, args, options = {}) {
  return runB3PhysicalDeviceProcess(command, args, {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs ?? 30_000,
    stdoutLimit: options.maxBuffer ?? MAXIMUM_SCREENSHOT_BYTES,
    stderrLimit: 256 * 1024,
    encoding: null,
  });
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

async function syncDirectory(directory) {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

function createLaunchIdentityRecord(command, identity, deviceIdentifier) {
  const commandBytes = Buffer.from(canonicaliseB3ProofValue(command), 'utf8');
  const unsigned = {
    schemaVersion: 1,
    platform: command.platform,
    captureId: command.captureId,
    sequence: command.expectedSequence,
    command,
    commandSha256: sha256(Buffer.concat([
      Buffer.from('ks2-spelling:b3-ios-launch-command:v1\0', 'utf8'),
      commandBytes,
    ])),
    deviceIdentifier,
    bundleId: BUNDLE_ID,
    processIdentifier: identity.processIdentifier,
    startDate: identity.startDate,
  };
  return {
    ...unsigned,
    recordSha256: sha256(Buffer.concat([
      Buffer.from('ks2-spelling:b3-ios-launch-identity:v1\0', 'utf8'),
      Buffer.from(canonicaliseB3ProofValue(unsigned), 'utf8'),
    ])),
  };
}

async function readLaunchIdentityFile(path) {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
    );
  } catch {
    throw transportError('B3 iOS launch identity link or file policy is invalid');
  }
  try {
    let before = await handle.stat();
    if (before.isFile() && before.nlink === 2 && (before.mode & 0o777) === 0o600) {
      const directory = resolve(path, '..');
      const entries = await readdir(directory, { withFileTypes: true });
      if (entries.length > 256) {
        throw transportError('B3 iOS launch identity entry bound is exceeded');
      }
      const aliases = [];
      for (const entry of entries) {
        if (!PRIVATE_LAUNCH_IDENTITY_TEMPORARY.test(entry.name)) continue;
        if (!entry.isFile()) {
          throw transportError('B3 iOS launch identity temporary alias policy is invalid');
        }
        const aliasPath = resolve(directory, entry.name);
        const alias = await open(
          aliasPath,
          fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
        );
        try {
          const metadata = await alias.stat();
          if (metadata.isFile() && metadata.nlink === 2 &&
              (metadata.mode & 0o777) === 0o600 && metadata.dev === before.dev &&
              metadata.ino === before.ino && metadata.size === before.size) {
            aliases.push(aliasPath);
          }
        } finally {
          await alias.close();
        }
      }
      if (aliases.length !== 1) {
        throw transportError('B3 iOS launch identity hard-link policy is invalid');
      }
      const aliasMetadata = await lstat(aliases[0]);
      if (aliasMetadata.isSymbolicLink() || aliasMetadata.dev !== before.dev ||
          aliasMetadata.ino !== before.ino || aliasMetadata.nlink !== 2) {
        throw transportError('B3 iOS launch identity temporary alias changed');
      }
      await rm(aliases[0]);
      await syncDirectory(directory);
      before = await handle.stat();
    }
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600 ||
        before.size <= 0 || before.size > MAXIMUM_LAUNCH_IDENTITY_BYTES) {
      throw transportError('B3 iOS launch identity file policy is invalid');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1 || bytes.length !== before.size ||
        after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs) {
      throw transportError('B3 iOS launch identity changed while being read');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function validateLaunchIdentityRecord(bytes, filename) {
  const value = parseB3StrictJsonBytes(bytes, 'B3 iOS launch identity');
  const keys = [
    'schemaVersion', 'platform', 'captureId', 'sequence', 'command', 'commandSha256',
    'deviceIdentifier', 'bundleId', 'processIdentifier', 'startDate', 'recordSha256',
  ];
  const name = LAUNCH_IDENTITY_NAME.exec(filename);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)) ||
      value.schemaVersion !== 1 || value.platform !== 'ios-physical' ||
      typeof value.captureId !== 'string' || !name ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
      value.commandSha256 !== name.groups.commandSha256 ||
      value.sequence !== Number(name.groups.sequence) || value.bundleId !== BUNDLE_ID ||
      typeof value.deviceIdentifier !== 'string' ||
      !IOS_DEVICE_ID.test(value.deviceIdentifier) ||
      !/^[0-9a-f]{64}$/u.test(value.recordSha256 ?? '') ||
      canonicaliseB3ProofValue(value) !== bytes.toString('utf8')) {
    throw transportError('B3 iOS launch identity record is not canonical or closed');
  }
  const identity = iosProcessIdentity({ runningProcesses: [{
    bundleIdentifier: value.bundleId,
    processIdentifier: value.processIdentifier,
    startDate: value.startDate,
  }] });
  const command = validateB3ProofLaunchCommand(value.command);
  const expectedCommandSha256 = sha256(Buffer.concat([
    Buffer.from('ks2-spelling:b3-ios-launch-command:v1\0', 'utf8'),
    Buffer.from(canonicaliseB3ProofValue(command), 'utf8'),
  ]));
  if (command.platform !== value.platform || command.captureId !== value.captureId ||
      command.expectedSequence !== value.sequence ||
      value.commandSha256 !== expectedCommandSha256) {
    throw transportError('B3 iOS launch identity command binding is invalid');
  }
  const unsigned = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'recordSha256'),
  );
  const expectedRecordSha256 = sha256(Buffer.concat([
    Buffer.from('ks2-spelling:b3-ios-launch-identity:v1\0', 'utf8'),
    Buffer.from(canonicaliseB3ProofValue(unsigned), 'utf8'),
  ]));
  if (value.recordSha256 !== expectedRecordSha256) {
    throw transportError('B3 iOS launch identity record hash is invalid');
  }
  return Object.freeze({ ...value, ...identity });
}

async function persistLaunchIdentity({ directory, command, identity, deviceIdentifier }) {
  const record = createLaunchIdentityRecord(command, identity, deviceIdentifier);
  const filename = `${String(record.sequence).padStart(8, '0')}-${record.commandSha256}.launch-identity.json`;
  const path = resolve(directory, filename);
  const bytes = Buffer.from(canonicaliseB3ProofValue(record), 'utf8');
  const temporary = resolve(directory, `.launch-identity-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, path);
    } catch (error) {
      if (error?.code !== 'EEXIST' || !(await readLaunchIdentityFile(path)).equals(bytes)) {
        throw transportError('B3 iOS launch identity immutable record conflicts');
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
  await syncDirectory(directory);
  validateLaunchIdentityRecord(await readLaunchIdentityFile(path), filename);
}

async function readRetainedLaunchIdentity({ root, command, deviceIdentifier }) {
  if (command.platform !== 'ios-physical' || command.actionCode !== 'RELAUNCH' ||
      command.expectedSequence <= 1) {
    throw transportError('B3 iOS force-stop command authority is invalid');
  }
  const directory = await ensurePrivateTransportDirectory(root, 'ios');
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > 256) {
    throw transportError('B3 iOS launch identity entry bound is exceeded');
  }
  const candidates = [];
  for (const entry of entries) {
    if (!LAUNCH_IDENTITY_NAME.test(entry.name)) continue;
    if (!entry.isFile()) {
      throw transportError('B3 iOS launch identity entry policy is invalid');
    }
    const value = validateLaunchIdentityRecord(
      await readLaunchIdentityFile(resolve(directory, entry.name)),
      entry.name,
    );
    if (value.captureId === command.captureId &&
        value.sequence === command.expectedSequence - 1) candidates.push(value);
  }
  if (candidates.length !== 1) {
    throw transportError('B3 iOS force-stop retained launch identity is absent or ambiguous');
  }
  if (candidates[0].deviceIdentifier !== deviceIdentifier) {
    throw transportError('B3 iOS retained launch device identity differs');
  }
  return candidates[0];
}

async function readPulledObservation(path) {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
    );
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
    if (!after.isFile() || after.nlink !== 1 || bytes.length !== before.size ||
        after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs) {
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
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
    );
  } catch {
    throw transportError(`B3 iOS ${label} JSON output is absent or invalid`);
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size <= 0 ||
        before.size > MAXIMUM_DEVICECTL_JSON_BYTES) {
      throw transportError(`B3 iOS ${label} JSON output is not a bounded regular file`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1 || bytes.length !== before.size ||
        after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs) {
      throw transportError(`B3 iOS ${label} JSON output changed while being read`);
    }
    const value = parseB3StrictJsonBytes(bytes, `B3 iOS ${label}`);
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

function iosProcessIdentity(result, expectedProcessIdentifier = null) {
  if (Object.keys(result).length !== 1 || !Array.isArray(result.runningProcesses) ||
      result.runningProcesses.length > 4096) {
    throw transportError('B3 iOS process inventory result violates its closed schema');
  }
  const bundleMatches = result.runningProcesses.filter((process) =>
    process && typeof process === 'object' && !Array.isArray(process) &&
    process.bundleIdentifier === BUNDLE_ID);
  const matches = expectedProcessIdentifier === null
    ? bundleMatches
    : bundleMatches.filter((process) =>
        process.processIdentifier === expectedProcessIdentifier);
  if (bundleMatches.length !== 1 || matches.length !== 1) {
    throw transportError('B3 iOS running bundle process is absent or ambiguous');
  }
  const process = matches[0];
  const pid = processIdentifier(process.processIdentifier);
  const startDate = process.startDate;
  const parsedStartDate = typeof startDate === 'string' ? new Date(startDate) : null;
  if (typeof startDate !== 'string' || !IOS_PROCESS_START_DATE.test(startDate) ||
      !Number.isFinite(parsedStartDate?.getTime()) ||
      parsedStartDate.toISOString().slice(0, 19) !== startDate.slice(0, 19)) {
    throw transportError('B3 iOS process start-date identity is invalid');
  }
  return Object.freeze({ processIdentifier: pid, startDate });
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

function boundedTransportTimeout(options) {
  if (options === undefined || (options && Object.keys(options).length === 0)) return 30_000;
  if (!options || Object.getPrototypeOf(options) !== Object.prototype ||
      Object.keys(options).length !== 1 || !Object.hasOwn(options, 'timeoutMs') ||
      !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 ||
      options.timeoutMs > 30_000) {
    throw transportError('B3 physical-device operation timeout is invalid');
  }
  return options.timeoutMs;
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
  let retainedIosProcessIdentity = null;

  async function launch(rawCommand, options) {
    const command = validateB3ProofLaunchCommand(rawCommand);
    const timeoutMs = boundedTransportTimeout(options);
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
        ], { cwd: root, timeoutMs });
        const result = await readDeviceCtlJson(jsonOutput, 'launch');
        if (Object.keys(result).some((key) => !['processIdentifier', 'deviceIdentifier'].includes(key)) ||
            !Object.hasOwn(result, 'processIdentifier') ||
            (Object.hasOwn(result, 'deviceIdentifier') && result.deviceIdentifier !== id)) {
          throw transportError('B3 iOS launch JSON result violates its closed schema');
        }
        const launchedProcessIdentifier = processIdentifier(result.processIdentifier);
        const processesOutput = resolve(temporary, 'launch-processes.json');
        await runText(runner, 'xcrun', [
          'devicectl', 'device', 'info', 'processes', '--device', id,
          '--json-output', processesOutput,
        ], { cwd: root, timeoutMs });
        retainedIosProcessIdentity = iosProcessIdentity(
          await readDeviceCtlJson(processesOutput, 'launch process inventory'),
          launchedProcessIdentifier,
        );
        await persistLaunchIdentity({
          directory: parent,
          command,
          identity: retainedIosProcessIdentity,
          deviceIdentifier: id,
        });
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    } else {
      await runText(runner, 'adb', [
        '-s', id, 'shell', 'am', 'start', '-S', '-W', '-n', ANDROID_COMPONENT,
        '--es', `${BUNDLE_ID}.B3_PROOF_COMMAND_V1`, encoded,
      ], { cwd: root, timeoutMs });
    }
  }

  async function pullObservation(options) {
    const id = deviceIdentifier(platform, env);
    const timeoutMs = boundedTransportTimeout(options);
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
        ], { cwd: root, timeoutMs });
      } else {
        await runText(runner, 'adb', [
          '-s', id, 'pull', ANDROID_OBSERVATION_PATH, destination,
        ], { cwd: root, timeoutMs });
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

  async function forceStop({ command: rawStopCommand, retainReceipt = async () => {} } = {}) {
    if (typeof retainReceipt !== 'function') {
      throw transportError('B3 force-stop receipt authority is invalid');
    }
    const id = deviceIdentifier(platform, env);
    if (platform === 'android') {
      await runText(runner, 'adb', [
        '-s', id, 'shell', 'am', 'force-stop', BUNDLE_ID,
      ], { cwd: root, timeoutMs: 30_000 });
      await retainReceipt(Object.freeze({
        deviceIdentifier: id,
        bundleIdentifier: BUNDLE_ID,
      }));
      return;
    }
    const stopCommand = validateB3ProofLaunchCommand(rawStopCommand);
    const durableLaunchIdentity = await readRetainedLaunchIdentity({
      root,
      command: stopCommand,
      deviceIdentifier: id,
    });
    if (retainedIosProcessIdentity !== null &&
        (retainedIosProcessIdentity.processIdentifier !== durableLaunchIdentity.processIdentifier ||
         retainedIosProcessIdentity.startDate !== durableLaunchIdentity.startDate)) {
      throw transportError('B3 iOS in-memory and durable launch identity differ');
    }
    retainedIosProcessIdentity = durableLaunchIdentity;
    const parent = await ensurePrivateTransportDirectory(root, platform);
    const temporary = await mkdtemp(resolve(parent, 'terminate-'));
    try {
      const processesOutput = resolve(temporary, 'processes.json');
      await runText(runner, 'xcrun', [
        'devicectl', 'device', 'info', 'processes', '--device', id,
        '--json-output', processesOutput,
      ], { cwd: root, timeoutMs: 30_000 });
      const result = await readDeviceCtlJson(processesOutput, 'process inventory');
      const identity = iosProcessIdentity(result);
      const pid = identity.processIdentifier;
      if (retainedIosProcessIdentity !== null &&
          (retainedIosProcessIdentity.processIdentifier !== pid ||
           retainedIosProcessIdentity.startDate !== identity.startDate)) {
        throw transportError('B3 iOS retained launch process identity changed before force-stop');
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
          terminated.processIdentifier !== pid ||
          (Object.hasOwn(terminated, 'deviceIdentifier') &&
           terminated.deviceIdentifier !== id)) {
        throw transportError('B3 iOS terminate JSON result violates its closed schema');
      }
      await retainReceipt(Object.freeze({
        deviceIdentifier: id,
        processIdentifier: pid,
        startDate: identity.startDate,
      }));
      retainedIosProcessIdentity = null;
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
