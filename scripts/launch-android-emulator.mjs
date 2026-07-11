import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  EXIT_CODES,
  isMain,
  printJson,
  runCommand,
  startDetached,
} from './lib/run-command.mjs';
import { resolveAndroidEnvironment } from './test-android.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APK_PATH = '.native-build/android/build/app/outputs/apk/debug/app-debug.apk';

export const ANDROID_DEVICE = Object.freeze({
  name: 'KS2_Spelling_API_36',
  image: 'system-images;android-36;google_apis;arm64-v8a',
  device: 'pixel_9',
  port: '5580',
  serial: 'emulator-5580',
  packageId: 'uk.eugnel.ks2spelling',
  activity: 'uk.eugnel.ks2spelling/.MainActivity',
});

export function createAndroidLaunchPlan({ avdExists }) {
  const commands = [];
  if (!avdExists) {
    commands.push({
      command: 'avdmanager',
      args: [
        'create',
        'avd',
        '--name',
        ANDROID_DEVICE.name,
        '--package',
        ANDROID_DEVICE.image,
        '--device',
        ANDROID_DEVICE.device,
      ],
      input: 'no\n',
    });
  }
  commands.push(
    { command: process.execPath, args: ['scripts/test-android.mjs'] },
    {
      command: 'emulator',
      args: [
        '-avd',
        ANDROID_DEVICE.name,
        '-port',
        ANDROID_DEVICE.port,
        '-no-snapshot-save',
      ],
    },
    { command: 'adb', args: ['-s', ANDROID_DEVICE.serial, 'wait-for-device'] },
    { command: 'adb', args: ['-s', ANDROID_DEVICE.serial, 'install', '-r', APK_PATH] },
    {
      command: 'adb',
      args: ['-s', ANDROID_DEVICE.serial, 'shell', 'am', 'start', '-n', ANDROID_DEVICE.activity],
    },
  );
  return commands;
}

export function assertAndroidSerialOwnership(avdNameOutput) {
  if (avdNameOutput.trim().split(/\r?\n/)[0] !== ANDROID_DEVICE.name) {
    const collision = new Error(
      `${ANDROID_DEVICE.serial} belongs to a different Android virtual device`,
    );
    collision.code = 'android_serial_collision';
    throw collision;
  }
}

function androidAvdIdentityError(detail) {
  const mismatch = new Error(`Android virtual device identity mismatch: ${detail}`);
  mismatch.code = 'android_avd_identity_mismatch';
  return mismatch;
}

export function assertAndroidAvdIdentity(configText) {
  if (typeof configText !== 'string') {
    throw androidAvdIdentityError('config.ini is unavailable');
  }
  const expected = new Map([
    ['abi.type', ANDROID_DEVICE.image.split(';').at(-1)],
    ['hw.device.name', ANDROID_DEVICE.device],
    ['image.sysdir.1', `${ANDROID_DEVICE.image.replaceAll(';', '/')}/`],
    ['tag.id', ANDROID_DEVICE.image.split(';')[2]],
  ]);
  const actual = new Map();
  for (const line of configText.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!expected.has(key)) continue;
    if (actual.has(key)) throw androidAvdIdentityError(`duplicate ${key}`);
    actual.set(key, line.slice(separator + 1).trim());
  }
  for (const [key, value] of expected) {
    if (actual.get(key) !== value) {
      throw androidAvdIdentityError(`${key} must equal ${value}`);
    }
  }
}

export function assertAndroidAvdPointerIdentity(pointerText, home) {
  if (typeof pointerText !== 'string' || !home) {
    throw androidAvdIdentityError('AVD pointer is unavailable');
  }
  const expected = new Map([
    ['path', join(home, '.android/avd', `${ANDROID_DEVICE.name}.avd`)],
    ['path.rel', `avd/${ANDROID_DEVICE.name}.avd`],
    ['target', 'android-36'],
  ]);
  const actual = new Map();
  for (const line of pointerText.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!expected.has(key)) continue;
    if (actual.has(key)) throw androidAvdIdentityError(`duplicate ${key}`);
    actual.set(key, line.slice(separator + 1).trim());
  }
  for (const [key, value] of expected) {
    if (actual.get(key) !== value) {
      throw androidAvdIdentityError(`${key} must equal ${value}`);
    }
  }
}

async function verifyAndroidAvdIdentity() {
  const home = process.env.HOME;
  if (!home) throw androidAvdIdentityError('HOME is unavailable');
  const configPath = join(home, '.android/avd', `${ANDROID_DEVICE.name}.avd`, 'config.ini');
  const pointerPath = join(home, '.android/avd', `${ANDROID_DEVICE.name}.ini`);
  try {
    assertAndroidAvdIdentity(await readFile(configPath, 'utf8'));
    assertAndroidAvdPointerIdentity(await readFile(pointerPath, 'utf8'), home);
  } catch (error) {
    if (error.code === 'android_avd_identity_mismatch') throw error;
    throw androidAvdIdentityError('config.ini cannot be read');
  }
}

async function findAvdManager(sdkRoot) {
  const commandLineRoot = join(sdkRoot, 'cmdline-tools');
  const candidates = [join(commandLineRoot, 'latest/bin/avdmanager')];
  try {
    const versions = (await readdir(commandLineRoot)).sort().reverse();
    candidates.push(...versions.map((version) => join(commandLineRoot, version, 'bin/avdmanager')));
  } catch {
    // The caller reports the stable missing-tool result.
  }
  return candidates.find(existsSync) ?? null;
}

async function runRequired(command, args, options = {}) {
  const result = await runCommand(command, args, { cwd: ROOT, ...options });
  if (result.exitCode !== 0) throw new Error(`${command} failed with ${result.exitCode}`);
  return result;
}

async function waitForBoot(adb, env) {
  await runRequired(adb, ['-s', ANDROID_DEVICE.serial, 'wait-for-device'], { env });
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const result = await runCommand(
      adb,
      ['-s', ANDROID_DEVICE.serial, 'shell', 'getprop', 'sys.boot_completed'],
      { cwd: ROOT, env },
    );
    if (result.stdout.trim() === '1') return;
    await new Promise((completion) => setTimeout(completion, 2000));
  }
  throw new Error('Android emulator did not finish booting');
}

export async function main() {
  const resolution = resolveAndroidEnvironment();
  if (!resolution.ready) {
    printJson(
      { ok: false, code: 'missing_android_toolchain', missing: resolution.missing },
      process.stderr,
    );
    return EXIT_CODES.missingTool;
  }
  const sdkRoot = resolution.androidSdkRoot;
  const emulator = join(sdkRoot, 'emulator/emulator');
  const adb = join(sdkRoot, 'platform-tools/adb');
  const avdManager = await findAvdManager(sdkRoot);
  if (!existsSync(emulator) || !existsSync(adb) || !avdManager) {
    printJson({ ok: false, code: 'missing_android_launch_tools' }, process.stderr);
    return EXIT_CODES.missingTool;
  }
  const env = {
    ...process.env,
    JAVA_HOME: resolution.javaHome,
    ANDROID_HOME: sdkRoot,
  };

  try {
    const avds = await runRequired(emulator, ['-list-avds'], { env });
    const avdExists = avds.stdout.split(/\r?\n/).includes(ANDROID_DEVICE.name);
    if (!avdExists) {
      await runRequired(
        avdManager,
        [
          'create',
          'avd',
          '--name',
          ANDROID_DEVICE.name,
          '--package',
          ANDROID_DEVICE.image,
          '--device',
          ANDROID_DEVICE.device,
        ],
        { env, input: 'no\n' },
      );
    }
    await verifyAndroidAvdIdentity();
    await runRequired(process.execPath, ['scripts/test-android.mjs'], { env });
    const serialState = await runCommand(adb, ['-s', ANDROID_DEVICE.serial, 'get-state'], {
      cwd: ROOT,
      env,
    });
    let detached = null;
    if (serialState.exitCode === 0) {
      const avdName = await runRequired(
        adb,
        ['-s', ANDROID_DEVICE.serial, 'emu', 'avd', 'name'],
        { env },
      );
      assertAndroidSerialOwnership(avdName.stdout);
    } else {
      detached = startDetached(
        emulator,
        [
          '-avd',
          ANDROID_DEVICE.name,
          '-port',
          ANDROID_DEVICE.port,
          '-no-snapshot-save',
          '-no-boot-anim',
        ],
        { cwd: ROOT, env },
      );
    }
    await waitForBoot(adb, env);
    await runRequired(adb, ['-s', ANDROID_DEVICE.serial, 'install', '-r', APK_PATH], {
      env,
    });
    const launch = await runRequired(
      adb,
      [
        '-s',
        ANDROID_DEVICE.serial,
        'shell',
        'am',
        'start',
        '-n',
        ANDROID_DEVICE.activity,
      ],
      { env },
    );
    const processResult = await runRequired(
      adb,
      ['-s', ANDROID_DEVICE.serial, 'shell', 'pidof', ANDROID_DEVICE.packageId],
      { env },
    );
    printJson({
      ok: true,
      platform: 'android',
      device: { name: ANDROID_DEVICE.name, created: !avdExists },
      packageId: ANDROID_DEVICE.packageId,
      activity: ANDROID_DEVICE.activity,
      apkPath: APK_PATH,
      emulatorPid: detached?.pid ?? null,
      appPid: processResult.stdout.trim(),
      launch: launch.stdout.trim(),
    });
    return EXIT_CODES.success;
  } catch (error) {
    const stateMismatch = [
      'android_serial_collision',
      'android_avd_identity_mismatch',
    ].includes(error.code);
    printJson(
      {
        ok: false,
        code: stateMismatch ? error.code : 'android_launch_failed',
        message: error.message,
      },
      process.stderr,
    );
    return stateMismatch ? EXIT_CODES.stateMismatch : EXIT_CODES.commandFailed;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
