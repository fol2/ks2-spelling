import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  EXIT_CODES,
  isMain,
  printJson,
  runCommand,
} from './lib/run-command.mjs';
import { resolveAndroidEnvironment } from './test-android.mjs';
import {
  ANDROID_DEVICE,
  assertAndroidAvdIdentity,
} from './launch-android-emulator.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const IOS_DEVICE_NAME = 'KS2 Spelling iPhone 17';
const MINIMUM_FREE_BYTES = 25 * 1024 ** 3;

export const DOCTOR_COMMANDS = Object.freeze([
  Object.freeze(['npm', Object.freeze(['--version'])]),
  Object.freeze(['xcodebuild', Object.freeze(['-version'])]),
  Object.freeze(['xcrun', Object.freeze(['simctl', 'list', 'runtimes', '-j'])]),
  Object.freeze(['xcrun', Object.freeze(['simctl', 'list', 'devices', '-j'])]),
  Object.freeze(['df', Object.freeze(['-Pk', ROOT])]),
]);

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function hasBuildTools36(sdkRoot) {
  if (!sdkRoot) return false;
  try {
    return (await readdir(join(sdkRoot, 'build-tools'))).some(
      (version) => version === '36.0.0' || version.startsWith('36.'),
    );
  } catch {
    return false;
  }
}

function parseAvailableBytes(dfOutput) {
  const line = dfOutput.trim().split('\n').at(-1);
  const blocks = Number(line?.trim().split(/\s+/)[3]);
  return Number.isFinite(blocks) ? blocks * 1024 : null;
}

export async function hasExpectedAndroidAvd({
  home = process.env.HOME,
  readText = readFile,
} = {}) {
  if (!home) return false;
  const configPath = join(
    home,
    '.android/avd',
    `${ANDROID_DEVICE.name}.avd`,
    'config.ini',
  );
  try {
    assertAndroidAvdIdentity(await readText(configPath, 'utf8'));
    return true;
  } catch {
    return false;
  }
}

export async function collectNativeDoctor() {
  const results = [];
  for (const [command, args] of DOCTOR_COMMANDS) {
    results.push(await runCommand(command, args, { cwd: ROOT }));
  }
  const [npm, xcode, runtimesResult, devicesResult, diskResult] = results;
  const runtimes = parseJson(runtimesResult.stdout, { runtimes: [] }).runtimes ?? [];
  const devices = parseJson(devicesResult.stdout, { devices: {} }).devices ?? {};
  const iosRuntime = runtimes.find(
    ({ identifier, isAvailable }) =>
      identifier === 'com.apple.CoreSimulator.SimRuntime.iOS-26-5' && isAvailable,
  );
  const iosDevice = Object.values(devices)
    .flat()
    .find(({ name, isAvailable }) => name === IOS_DEVICE_NAME && isAvailable !== false);

  const androidResolution = resolveAndroidEnvironment();
  const sdkRoot = androidResolution.androidSdkRoot;
  const androidAvd = await hasExpectedAndroidAvd();
  const android = {
    studio: existsSync('/Applications/Android Studio.app'),
    javaHome: androidResolution.javaHome,
    sdkRoot,
    platform36: Boolean(sdkRoot && existsSync(join(sdkRoot, 'platforms/android-36/android.jar'))),
    buildTools36: await hasBuildTools36(sdkRoot),
    adb: Boolean(sdkRoot && existsSync(join(sdkRoot, 'platform-tools/adb'))),
    emulator: Boolean(sdkRoot && existsSync(join(sdkRoot, 'emulator/emulator'))),
    avd: androidAvd,
  };
  const missing = [];
  if (npm.exitCode !== 0) missing.push('npm');
  if (xcode.exitCode !== 0) missing.push('xcodebuild');
  if (!iosRuntime) missing.push('iosRuntime26.5');
  if (!iosDevice) missing.push('iosDevice');
  if (!android.studio) missing.push('androidStudio');
  if (!android.javaHome) missing.push('jbr');
  if (!android.sdkRoot) missing.push('androidSdk');
  if (!android.platform36) missing.push('androidPlatform36');
  if (!android.buildTools36) missing.push('androidBuildTools36');
  if (!android.adb) missing.push('adb');
  if (!android.emulator) missing.push('emulator');
  if (!android.avd) missing.push('androidAvd');
  const availableBytes = parseAvailableBytes(diskResult.stdout);
  if (availableBytes === null || availableBytes < MINIMUM_FREE_BYTES) {
    missing.push('freeDisk25GiB');
  }

  return {
    schemaVersion: 1,
    readOnly: true,
    node: { version: process.version },
    npm: { available: npm.exitCode === 0, version: npm.stdout.trim() || null },
    xcode: { available: xcode.exitCode === 0, version: xcode.stdout.trim() || null },
    ios: {
      runtime: iosRuntime?.version ?? null,
      device: iosDevice
        ? { name: iosDevice.name, udid: iosDevice.udid, state: iosDevice.state }
        : null,
    },
    android,
    disk: { availableBytes, minimumBytes: MINIMUM_FREE_BYTES },
    ready: missing.length === 0,
    missing,
  };
}

export async function main(args = process.argv.slice(2)) {
  const report = await collectNativeDoctor();
  printJson(report);
  return args.includes('--strict') && !report.ready
    ? EXIT_CODES.missingTool
    : EXIT_CODES.success;
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
