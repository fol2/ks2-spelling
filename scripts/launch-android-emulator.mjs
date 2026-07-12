import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  EXIT_CODES,
  isMain,
  printJson,
  runCommand,
  startDetached,
} from './lib/run-command.mjs';
import { resolveAndroidEnvironment } from './test-android.mjs';
import { verifyPackagedAndroidPermissions } from './test-android.mjs';
import { fingerprintB1Application } from './fingerprint-b1-application.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APK_PATH = '.native-build/android/build/app/outputs/apk/debug/app-debug.apk';
const REPORT_PATH = 'reports/b1/android-emulator-launch.json';
const SCREENSHOT_PATH = 'reports/b1/android-emulator.png';
const TESTED_APPLICATION_COMMIT =
  'c7828c2da84d5828f7e7640992c78d3203dd1170';
const BUNDLED_SHELL_TEXT = Object.freeze([
  'KS2 Spelling',
  'Starter content: 20 words',
  'Bundled locally',
]);

export const ANDROID_DEVICE = Object.freeze({
  name: 'KS2_Spelling_API_36',
  image: 'system-images;android-36;google_apis;arm64-v8a',
  device: 'pixel_9',
  port: '5580',
  serial: 'emulator-5580',
  packageId: 'uk.eugnel.ks2spelling',
  activity: 'uk.eugnel.ks2spelling/.MainActivity',
});

function androidCaptureError(message) {
  const error = new Error(message);
  error.code = 'android_capture_invalid';
  return error;
}

export function analyseAndroidScreenshotBmp(buffer) {
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length < 54 ||
    buffer.toString('ascii', 0, 2) !== 'BM'
  ) {
    throw androidCaptureError('Android screenshot BMP header is invalid');
  }
  const pixelOffset = buffer.readUInt32LE(10);
  const dibSize = buffer.readUInt32LE(14);
  const width = buffer.readInt32LE(18);
  const signedHeight = buffer.readInt32LE(22);
  const height = Math.abs(signedHeight);
  const planes = buffer.readUInt16LE(26);
  const bitsPerPixel = buffer.readUInt16LE(28);
  const compression = buffer.readUInt32LE(30);
  const stride = width * 4;
  if (
    dibSize < 40 ||
    width <= 0 ||
    height <= 0 ||
    planes !== 1 ||
    bitsPerPixel !== 32 ||
    ![0, 3].includes(compression) ||
    pixelOffset < 54 ||
    pixelOffset + stride * height !== buffer.length
  ) {
    throw androidCaptureError('Android screenshot must be an exact 32-bit BMP');
  }
  let darkPixels = 0;
  let brightPixels = 0;
  let accentPixels = 0;
  for (let offset = pixelOffset; offset < buffer.length; offset += 4) {
    const blue = buffer[offset];
    const green = buffer[offset + 1];
    const red = buffer[offset + 2];
    if (red < 80 && green < 80 && blue < 80) darkPixels += 1;
    if (red >= 180 && green >= 180 && blue >= 160) brightPixels += 1;
    if (red < 180 && green >= 120 && blue >= 110 && green - red >= 20) {
      accentPixels += 1;
    }
  }
  const pixelCount = width * height;
  const darkPixelRatio = darkPixels / pixelCount;
  const brightPixelRatio = brightPixels / pixelCount;
  const accentPixelRatio = accentPixels / pixelCount;
  if (darkPixelRatio < 0.3) {
    throw androidCaptureError(
      'Android screenshot does not show the dark bundled B1 shell',
    );
  }
  if (brightPixelRatio < 0.01 || accentPixelRatio < 0.005) {
    throw androidCaptureError(
      'Android screenshot does not show the B1 shell text and accent surfaces',
    );
  }
  return {
    width,
    height,
    darkPixelRatio,
    brightPixelRatio,
    accentPixelRatio,
  };
}

export function parseAndroidInstalledApkPath(output) {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  const expectedPrefix = 'package:/data/app/';
  if (
    lines.length !== 1 ||
    !lines[0].startsWith(expectedPrefix) ||
    !lines[0].includes(ANDROID_DEVICE.packageId) ||
    !lines[0].endsWith('/base.apk')
  ) {
    throw androidCaptureError('Android package path does not prove the installed B1 APK');
  }
  return lines[0].slice('package:'.length);
}

export function parseAndroidPackageMetadata(output) {
  const versionName = output.match(/\bversionName=([^\s]+)/)?.[1];
  const versionCode = output.match(/\bversionCode=([0-9]+)/)?.[1];
  if (!versionName || !versionCode) {
    throw androidCaptureError('Installed Android package metadata is incomplete');
  }
  return { versionCode, versionName };
}

const ANDROID_RESUMED_ACTIVITY_AUTHORITIES = Object.freeze([
  'mResumedActivity',
  'topResumedActivity',
]);
const ANDROID_PACKAGE_NAME =
  /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const ANDROID_CLASS_SUFFIX =
  /^\.[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;
const ANDROID_CLASS_NAME =
  /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/;

function normaliseAndroidActivityComponent(component) {
  const separator = component.indexOf('/');
  if (separator <= 0 || separator !== component.lastIndexOf('/')) {
    throw androidCaptureError('Android resumed activity component is malformed');
  }
  const packageId = component.slice(0, separator);
  const activity = component.slice(separator + 1);
  if (!ANDROID_PACKAGE_NAME.test(packageId)) {
    throw androidCaptureError('Android resumed activity package is malformed');
  }
  let activityName;
  if (ANDROID_CLASS_SUFFIX.test(activity)) {
    activityName = `${packageId}${activity}`;
  } else if (ANDROID_CLASS_NAME.test(activity)) {
    activityName = activity;
  } else {
    throw androidCaptureError('Android resumed activity class is malformed');
  }
  return Object.freeze({
    packageId,
    activityName,
    component: `${packageId}/${activityName}`,
  });
}

export function parseAndroidDumpsysResumedActivity(output) {
  if (typeof output !== 'string' || output.length === 0) {
    throw androidCaptureError('Android resumed activity output is incomplete');
  }
  const observations = [];
  const seenAuthorities = new Set();
  for (const line of output.split(/\r?\n/)) {
    const mentionedAuthorities = ANDROID_RESUMED_ACTIVITY_AUTHORITIES.filter(
      (authority) => line.includes(authority),
    );
    if (mentionedAuthorities.length === 0) continue;
    if (mentionedAuthorities.length !== 1) {
      throw androidCaptureError('Android resumed activity authority is ambiguous');
    }
    const match = line.match(
      /^\s*(?:(mResumedActivity):\s+|(topResumedActivity)=)ActivityRecord\{[A-Za-z0-9]+ u[0-9]+ ([^\s{}]+) t[0-9]+\}\s*$/,
    );
    const authority = match?.[1] ?? match?.[2];
    if (!match || authority !== mentionedAuthorities[0] || seenAuthorities.has(authority)) {
      throw androidCaptureError('Android resumed activity authority is malformed');
    }
    seenAuthorities.add(authority);
    observations.push(Object.freeze({
      authority,
      ...normaliseAndroidActivityComponent(match[3]),
    }));
  }
  if (observations.length === 0) {
    throw androidCaptureError('Android resumed activity authority is missing');
  }
  const components = new Set(observations.map(({ component }) => component));
  if (components.size !== 1) {
    throw androidCaptureError('Android resumed activity authorities conflict');
  }
  const [{ packageId, activityName, component }] = observations;
  return Object.freeze({
    packageId,
    activityName,
    component,
    authorities: Object.freeze(observations.map(({ authority }) => authority)),
  });
}

export function parseAndroidResumedActivity(output) {
  const resumed = parseAndroidDumpsysResumedActivity(output);
  if (
    resumed.authorities.length !== 1 ||
    resumed.packageId !== ANDROID_DEVICE.packageId ||
    resumed.activityName !== `${ANDROID_DEVICE.packageId}.MainActivity`
  ) {
    throw androidCaptureError('Android resumed activity is not the B1 application');
  }
  return ANDROID_DEVICE.activity;
}

export async function waitForAndroidProcess({
  probe,
  attempts = 20,
  delay = () => new Promise((completion) => setTimeout(completion, 250)),
}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await probe();
    const processIdentifier = result.stdout.trim();
    if (result.exitCode === 0 && /^[1-9][0-9]*$/.test(processIdentifier)) {
      return processIdentifier;
    }
    if (attempt < attempts - 1) await delay();
  }
  throw androidCaptureError('Android application process did not become ready');
}

export async function clearAndroidCaptureEvidence({ root = ROOT } = {}) {
  await Promise.all(
    [REPORT_PATH, SCREENSHOT_PATH, 'reports/b1/b1-exit-report.json'].map((path) =>
      rm(join(root, path), { force: true }),
    ),
  );
}

export function createAndroidCaptureCleanupPlan({
  capture,
  ownsB1Serial,
  startedDetachedPid,
}) {
  if (!capture) return [];
  if (ownsB1Serial) {
    return [{ type: 'kill-owned-b1-serial', serial: ANDROID_DEVICE.serial }];
  }
  if (Number.isInteger(startedDetachedPid) && startedDetachedPid > 0) {
    return [{ type: 'terminate-started-process-group', pid: startedDetachedPid }];
  }
  return [];
}

export async function runAndroidCaptureCleanup({
  plan,
  killOwnedSerial,
  terminateProcessGroup,
}) {
  for (const step of plan) {
    if (step.type === 'kill-owned-b1-serial') await killOwnedSerial(step.serial);
    else if (step.type === 'terminate-started-process-group') {
      await terminateProcessGroup(step.pid);
    } else {
      throw androidCaptureError(`Unknown Android cleanup step: ${step.type}`);
    }
  }
}

export function assertAndroidBundledShellHierarchy(output) {
  if (!BUNDLED_SHELL_TEXT.every((text) => output.includes(text))) {
    throw androidCaptureError('Android UI hierarchy does not show the bundled B1 shell');
  }
  return 'ready';
}

export async function waitForAndroidBundledShell({
  probe,
  attempts = 60,
  delay = () => new Promise((completion) => setTimeout(completion, 500)),
}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await probe();
    if (result.exitCode === 0) {
      try {
        const hierarchy = result.stderr
          ? `${result.stdout}\n${result.stderr}`
          : result.stdout;
        assertAndroidBundledShellHierarchy(hierarchy);
        return {
          status: 'ready',
          requiredTexts: [...BUNDLED_SHELL_TEXT],
          hierarchySha256: sha256(Buffer.from(hierarchy, 'utf8')),
          attempts: attempt + 1,
        };
      } catch (error) {
        if (error.code !== 'android_capture_invalid') throw error;
      }
    }
    if (attempt < attempts - 1) await delay();
  }
  throw androidCaptureError('Android bundled B1 shell did not become visible');
}

export async function waitForAndroidScreenshotShell({
  probe,
  attempts = 60,
  delay = () => new Promise((completion) => setTimeout(completion, 500)),
}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return {
        source: 'screenshot-bmp-shell-colour-populations',
        ...analyseAndroidScreenshotBmp(await probe()),
        screenshotAttempts: attempt + 1,
      };
    } catch (error) {
      if (error.code !== 'android_capture_invalid') throw error;
    }
    if (attempt < attempts - 1) await delay();
  }
  throw androidCaptureError('Android screenshot did not show the bundled B1 shell');
}

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
    { command: process.execPath, args: ['scripts/native-sync-check.mjs'] },
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

export function assertStartedAndroidEmulatorProcess(commandLine) {
  if (
    !/(?:^|\/)(?:emulator|qemu-system-[^/\s]+)(?:\s|$)/.test(commandLine) ||
    !/(?:^|\s)-avd\s+KS2_Spelling_API_36(?:\s|$)/.test(commandLine) ||
    !/(?:^|\s)-port\s+5580(?:\s|$)/.test(commandLine)
  ) {
    throw androidCaptureError(
      'Detached process no longer proves the exact B1 Android emulator',
    );
  }
  return 'owned-b1-emulator-process';
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
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with ${result.exitCode}`);
  }
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

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function captureAndroidEvidence({ adb, env, packageJson }) {
  await new Promise((completion) => setTimeout(completion, 2000));
  const remoteHierarchy = '/sdcard/ks2-spelling-b1-window.xml';
  let hierarchyReadiness;
  try {
    hierarchyReadiness = await waitForAndroidBundledShell({
      probe: async () => {
        const dump = await runCommand(
          adb,
          [
            '-s',
            ANDROID_DEVICE.serial,
            'shell',
            'uiautomator',
            'dump',
            remoteHierarchy,
          ],
          { cwd: ROOT, env },
        );
        if (dump.exitCode !== 0) return dump;
        return runCommand(
          adb,
          ['-s', ANDROID_DEVICE.serial, 'shell', 'cat', remoteHierarchy],
          { cwd: ROOT, env },
        );
      },
    });
  } catch (error) {
    const logcat = await runCommand(
      adb,
      ['-s', ANDROID_DEVICE.serial, 'logcat', '-d', '-t', '300'],
      { cwd: ROOT, env },
    );
    const relevantLog = logcat.stdout
      .split(/\r?\n/)
      .filter((line) => /AndroidRuntime|Capacitor|chromium|WebView/i.test(line))
      .slice(-20)
      .join(' | ');
    throw androidCaptureError(
      `${error.message}; filteredLogcat=${relevantLog || 'none'}`,
    );
  } finally {
    await runCommand(
      adb,
      ['-s', ANDROID_DEVICE.serial, 'shell', 'rm', '-f', remoteHierarchy],
      { cwd: ROOT, env },
    );
  }
  const [
    packagePath,
    resumedActivity,
    processResult,
    apiLevel,
    osVersion,
    packageMetadata,
    packagedIndex,
    packagedConfig,
    permissionEvidence,
  ] = await Promise.all([
    runRequired(
      adb,
      ['-s', ANDROID_DEVICE.serial, 'shell', 'pm', 'path', ANDROID_DEVICE.packageId],
      { env },
    ),
    runRequired(
      adb,
      ['-s', ANDROID_DEVICE.serial, 'shell', 'dumpsys', 'activity', 'activities'],
      { env },
    ),
    runRequired(
      adb,
      ['-s', ANDROID_DEVICE.serial, 'shell', 'pidof', ANDROID_DEVICE.packageId],
      { env },
    ),
    runRequired(
      adb,
      ['-s', ANDROID_DEVICE.serial, 'shell', 'getprop', 'ro.build.version.sdk'],
      { env },
    ),
    runRequired(
      adb,
      ['-s', ANDROID_DEVICE.serial, 'shell', 'getprop', 'ro.build.version.release'],
      { env },
    ),
    runRequired(
      adb,
      ['-s', ANDROID_DEVICE.serial, 'shell', 'dumpsys', 'package', ANDROID_DEVICE.packageId],
      { env },
    ),
    runRequired('unzip', ['-p', APK_PATH, 'assets/public/index.html']),
    runRequired('unzip', ['-p', APK_PATH, 'assets/capacitor.config.json']),
    verifyPackagedAndroidPermissions(),
  ]);
  const installedApkPath = parseAndroidInstalledApkPath(packagePath.stdout);
  const foregroundActivity = parseAndroidResumedActivity(resumedActivity.stdout);
  const processIdentifier = processResult.stdout.trim();
  if (!/^[1-9][0-9]*$/.test(processIdentifier)) {
    throw androidCaptureError('Android process identifier is incomplete');
  }
  const { versionCode, versionName } = parseAndroidPackageMetadata(
    packageMetadata.stdout,
  );
  const installedConfig = JSON.parse(packagedConfig.stdout);
  const serverUrl = installedConfig.server?.url ?? null;
  if (serverUrl !== null) {
    throw androidCaptureError('Packaged Android application contains server.url');
  }
  if (
    permissionEvidence.appIdentity !== ANDROID_DEVICE.packageId ||
    permissionEvidence.declaredPermissions.length ||
    permissionEvidence.requestedPermissions.length
  ) {
    throw androidCaptureError('Packaged Android permission surface is not empty');
  }
  await mkdir(join(ROOT, 'reports/b1'), { recursive: true });
  const remoteScreenshot = '/sdcard/ks2-spelling-b1.png';
  const readinessBmp = join(ROOT, '.native-build/android/android-readiness.bmp');
  let screenshotReadiness;
  try {
    screenshotReadiness = await waitForAndroidScreenshotShell({
      probe: async () => {
        await runRequired(
          adb,
          ['-s', ANDROID_DEVICE.serial, 'shell', 'screencap', '-p', remoteScreenshot],
          { env },
        );
        await runRequired(
          adb,
          [
            '-s',
            ANDROID_DEVICE.serial,
            'pull',
            remoteScreenshot,
            join(ROOT, SCREENSHOT_PATH),
          ],
          { env },
        );
        await runRequired(
          'sips',
          [
            '-s',
            'format',
            'bmp',
            join(ROOT, SCREENSHOT_PATH),
            '--out',
            readinessBmp,
          ],
          { env },
        );
        return readFile(readinessBmp);
      },
    });
  } finally {
    await Promise.all([
      runCommand(
        adb,
        ['-s', ANDROID_DEVICE.serial, 'shell', 'rm', '-f', remoteScreenshot],
        { cwd: ROOT, env },
      ),
      rm(readinessBmp, { force: true }),
    ]);
  }
  const uiReadiness = {
    status: hierarchyReadiness.status,
    source:
      'uiautomator-required-texts-and-screenshot-bmp-shell-colour-populations',
    requiredTexts: hierarchyReadiness.requiredTexts,
    hierarchySha256: hierarchyReadiness.hierarchySha256,
    hierarchyAttempts: hierarchyReadiness.attempts,
    width: screenshotReadiness.width,
    height: screenshotReadiness.height,
    darkPixelRatio: screenshotReadiness.darkPixelRatio,
    brightPixelRatio: screenshotReadiness.brightPixelRatio,
    accentPixelRatio: screenshotReadiness.accentPixelRatio,
    screenshotAttempts: screenshotReadiness.screenshotAttempts,
  };
  const screenshotSha256 = sha256(await readFile(join(ROOT, SCREENSHOT_PATH)));
  const applicationFingerprint = await fingerprintB1Application({ root: ROOT });
  const report = {
    schemaVersion: 1,
    platform: 'android-emulator',
    testedApplicationCommit: TESTED_APPLICATION_COMMIT,
    applicationFingerprint,
    packageVersions: {
      application: packageJson.version,
      capacitorCore: packageJson.dependencies['@capacitor/core'],
      capacitorPlatform: packageJson.dependencies['@capacitor/android'],
    },
    nativeVersions: {
      buildTools: permissionEvidence.buildToolsVersion,
      androidApi: Number(apiLevel.stdout.trim()),
    },
    identity: { packageId: ANDROID_DEVICE.packageId },
    device: {
      name: ANDROID_DEVICE.name,
      serial: ANDROID_DEVICE.serial,
      image: ANDROID_DEVICE.image,
      hardwareProfile: ANDROID_DEVICE.device,
      apiLevel: Number(apiLevel.stdout.trim()),
      osVersion: osVersion.stdout.trim(),
    },
    installation: {
      buildApkPath: APK_PATH,
      installedApkPath,
      versionName,
      versionCode,
    },
    foreground: {
      processIdentifier,
      resumedActivity: foregroundActivity,
      processState: 'running',
    },
    bundle: {
      serverUrl,
      indexHtmlPath: 'assets/public/index.html',
      indexHtmlSha256: sha256(Buffer.from(packagedIndex.stdout, 'utf8')),
    },
    packagedPermissions: {
      declared: permissionEvidence.declaredPermissions,
      requested: permissionEvidence.requestedPermissions,
    },
    uiReadiness,
    screenshot: {
      path: SCREENSHOT_PATH,
      sha256: screenshotSha256,
    },
  };
  await writeFile(
    join(ROOT, REPORT_PATH),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  return report;
}

export async function main(args = process.argv.slice(2)) {
  const capture = args.includes('--capture');
  if (capture) await clearAndroidCaptureEvidence();
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
  let ownsB1Serial = false;
  let startedDetachedPid = null;

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
    await runRequired(process.execPath, ['scripts/native-sync-check.mjs'], { env });
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
      ownsB1Serial = true;
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
      startedDetachedPid = detached.pid;
    }
    await waitForBoot(adb, env);
    const bootedAvdName = await runRequired(
      adb,
      ['-s', ANDROID_DEVICE.serial, 'emu', 'avd', 'name'],
      { env },
    );
    assertAndroidSerialOwnership(bootedAvdName.stdout);
    ownsB1Serial = true;
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
    const appPid = await waitForAndroidProcess({
      probe: () =>
        runCommand(
          adb,
          ['-s', ANDROID_DEVICE.serial, 'shell', 'pidof', ANDROID_DEVICE.packageId],
          { cwd: ROOT, env },
        ),
    });
    const packageJson = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
    const evidence = capture
      ? await captureAndroidEvidence({ adb, env, packageJson })
      : null;
    printJson({
      ok: true,
      platform: 'android',
      device: { name: ANDROID_DEVICE.name, created: !avdExists },
      packageId: ANDROID_DEVICE.packageId,
      activity: ANDROID_DEVICE.activity,
      apkPath: APK_PATH,
      emulatorPid: detached?.pid ?? null,
      appPid,
      launch: launch.stdout.trim(),
      evidence: evidence ? REPORT_PATH : null,
    });
    return EXIT_CODES.success;
  } catch (error) {
    if (capture) await clearAndroidCaptureEvidence();
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
  } finally {
    await runAndroidCaptureCleanup({
      plan: createAndroidCaptureCleanupPlan({
        capture,
        ownsB1Serial,
        startedDetachedPid,
      }),
      killOwnedSerial: () =>
        runCommand(adb, ['-s', ANDROID_DEVICE.serial, 'emu', 'kill'], {
          cwd: ROOT,
          env,
        }),
      terminateProcessGroup: async (pid) => {
        const processIdentity = await runCommand(
          '/bin/ps',
          ['-p', String(pid), '-o', 'command='],
          { cwd: ROOT, env },
        );
        if (processIdentity.exitCode !== 0) return;
        assertStartedAndroidEmulatorProcess(processIdentity.stdout.trim());
        try {
          process.kill(-pid, 'SIGTERM');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      },
    });
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
