import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';

import { createB4PlatformRiskReport } from '../src/app/b4-development-report.js';
import {
  EXIT_CODES,
  isMain,
  printJson,
  runCommand,
  startDetached,
} from './lib/run-command.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ID = 'uk.eugnel.ks2spelling';
const TEST_RUNNER = `${APP_ID}.test/androidx.test.runner.AndroidJUnitRunner`;
const TEST_CLASS = `${APP_ID}.B4DevelopmentTest`;
const SDK_ROOT = process.env.ANDROID_SDK_ROOT ??
  process.env.ANDROID_HOME ??
  join(homedir(), 'Library/Android/sdk');
const ADB = join(SDK_ROOT, 'platform-tools/adb');
const EMULATOR = join(SDK_ROOT, 'emulator/emulator');
const AVD_MANAGER = join(SDK_ROOT, 'cmdline-tools/latest/bin/avdmanager');
const PRODUCT_IMAGE = 'system-images;android-36;google_apis;arm64-v8a';
const MINIMUM_IMAGE = 'system-images;android-24;google_apis;arm64-v8a';
const PORT = '5580';
const SERIAL = `emulator-${PORT}`;
const RUNNER_LEASE_HOST = '127.0.0.1';
const RUNNER_LEASE_PORT = 45_580;
const APK_PATH = join(ROOT, 'android/app/build/outputs/apk/debug/app-debug.apk');
const TEST_APK_PATH = join(
  ROOT,
  'android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk',
);
const OUTPUT_DIRECTORY = join(ROOT, '.native-build/b4/android');
const DATABASE_NAME = 'ks2-spellingSQLite.db';
const SOFTWARE_KEYBOARD =
  'com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME';
const COMMAND_TIMEOUT_MS = 15 * 60 * 1_000;
const LIMITATION =
  'Emulator only; not physical-device, Play-signed distribution or TalkBack evidence.';

function proofError(code, message, options) {
  const error = new Error(message, options);
  error.code = code;
  return error;
}

export function acquireB4AndroidRunnerLease() {
  return new Promise((resolveLease, rejectLease) => {
    const server = createServer();
    const reject = (cause) => {
      const busy = cause?.code === 'EADDRINUSE';
      rejectLease(proofError(
        busy ? 'b4_android_runner_busy' : 'b4_android_runner_lease_failed',
        busy
          ? 'Another B4 Android certification runner owns the emulator lease.'
          : 'The B4 Android certification runner could not acquire its emulator lease.',
        { cause },
      ));
    };
    server.once('error', reject);
    server.listen({
      host: RUNNER_LEASE_HOST,
      port: RUNNER_LEASE_PORT,
      exclusive: true,
    }, () => {
      server.off('error', reject);
      let closed = false;
      resolveLease(Object.freeze({
        async close() {
          if (closed) return;
          closed = true;
          await new Promise((resolveClose, rejectClose) => {
            server.close((error) => error ? rejectClose(error) : resolveClose());
          });
        },
      }));
    });
  });
}

function finiteSeries(value, length) {
  return Array.isArray(value) && value.length === length &&
    value.every((item) => Number.isFinite(item) && item >= 0);
}

export function validateB4AndroidInstrumentationOutput(output) {
  if (typeof output !== 'string' ||
      !/(?:^|\n)OK \(1 test\)(?:\n|$)/u.test(output) ||
      /FAILURES!!!|INSTRUMENTATION_STATUS_CODE: -2/u.test(output)) {
    throw proofError(
      'b4_android_instrumentation_failed',
      'The Android instrumentation output did not prove one passing test.',
    );
  }
  return 'passed';
}

export function validateB4AndroidAvdIdentity(output, expectedName) {
  const names = typeof output === 'string'
    ? output.split(/\r?\n/u).map((line) => line.trim()).filter(
        (line) => line.length > 0 && line !== 'OK',
      )
    : [];
  if (names.length !== 1 || names[0] !== expectedName) {
    throw proofError(
      'b4_android_emulator_ownership_lost',
      'The emulator serial no longer belongs to this certification run.',
    );
  }
  return names[0];
}

export function combineB4AndroidJourney(phaseOne, phaseTwo) {
  const progress = phaseOne?.resumeProgress;
  if (!Number.isFinite(phaseOne?.coldLaunchMs) || phaseOne.coldLaunchMs < 0 ||
      !finiteSeries(phaseOne?.audioStartMs, 2) ||
      !finiteSeries(phaseOne?.answerFeedbackMs, 3) ||
      !Number.isFinite(phaseOne?.minimumControlHeightDp) ||
      phaseOne.minimumControlHeightDp < 48 ||
      phaseOne.softwareKeyboardObserved !== true ||
      phaseOne.enterSubmitted !== true ||
      phaseOne.backgroundAudioStoppedCount !== 2 ||
      typeof progress !== 'string' || !/^Card [1-5] of 5$/u.test(progress) ||
      !finiteSeries(phaseTwo?.answerFeedbackMs, 7) ||
      phaseTwo?.resumeProgressBefore !== progress ||
      phaseTwo?.resumeProgressAfter !== progress ||
      phaseTwo?.completed !== true) {
    throw proofError('b4_android_journey_invalid', 'The Android journey evidence is invalid.');
  }
  return Object.freeze({
    coldLaunchMs: phaseOne.coldLaunchMs,
    audioStartMs: [...phaseOne.audioStartMs],
    answerFeedbackMs: [...phaseOne.answerFeedbackMs, ...phaseTwo.answerFeedbackMs],
    minimumControlHeightDp: phaseOne.minimumControlHeightDp,
    softwareKeyboardObserved: true,
    enterSubmitted: true,
    backgroundAudioStoppedCount: 2,
    resumeProgressBefore: progress,
    resumeProgressAfter: progress,
    completed: true,
  });
}

export function validateB4AndroidLayoutDimensions(value) {
  const valid = value?.portrait?.width > 0 &&
    value.portrait.height > value.portrait.width &&
    value?.landscape?.height > 0 &&
    value.landscape.width > value.landscape.height;
  if (!valid) {
    throw proofError(
      'b4_android_layout_orientation_invalid',
      'The Android screenshots do not prove portrait and landscape viewports.',
    );
  }
  return structuredClone(value);
}

async function execute(command, args, { input = null, stream = false } = {}) {
  return runCommand(command, args, {
    cwd: ROOT,
    input,
    stream,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
}

async function checked(command, args, options) {
  const result = await execute(command, args, options);
  if (result.exitCode !== 0) {
    throw proofError(
      'b4_android_command_failed',
      `${command} failed with exit code ${result.exitCode}.`,
    );
  }
  return result.stdout.trim();
}

async function attempt(command, args, options) {
  return execute(command, args, options);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function imageDirectory(image) {
  const [, android, flavour, abi] = image.split(';');
  return join(SDK_ROOT, 'system-images', android, flavour, abi);
}

async function imageIsHosted(image) {
  try {
    await stat(join(imageDirectory(image), 'package.xml'));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function assertSerialAvailable() {
  const state = await attempt(ADB, ['-s', SERIAL, 'get-state']);
  if (state.exitCode === 0) {
    throw proofError(
      'b4_android_serial_busy',
      `${SERIAL} is already in use; refusing to mutate an emulator not owned by this run.`,
    );
  }
}

async function createAvd({ name, image, device }) {
  await checked(AVD_MANAGER, [
    'create', 'avd', '--force', '--name', name, '--package', image, '--device', device,
  ], { input: 'no\n' });
}

async function waitForBoot() {
  for (let attemptIndex = 0; attemptIndex < 240; attemptIndex += 1) {
    const [state, booted] = await Promise.all([
      attempt(ADB, ['-s', SERIAL, 'get-state']),
      attempt(ADB, ['-s', SERIAL, 'shell', 'getprop', 'sys.boot_completed']),
    ]);
    if (state.exitCode === 0 && state.stdout.trim() === 'device' &&
        booted.exitCode === 0 && booted.stdout.trim() === '1') return;
    await delay(500);
  }
  throw proofError('b4_android_emulator_unavailable', 'The owned Android emulator did not boot.');
}

async function assertOwnedSerial(expectedName) {
  const identity = await attempt(ADB, ['-s', SERIAL, 'emu', 'avd', 'name']);
  if (identity.exitCode !== 0) {
    throw proofError(
      'b4_android_emulator_ownership_lost',
      'The emulator serial did not expose its AVD identity.',
    );
  }
  validateB4AndroidAvdIdentity(`${identity.stdout}\n${identity.stderr}`, expectedName);
}

async function stopEmulator(expectedName) {
  const state = await attempt(ADB, ['-s', SERIAL, 'get-state']);
  if (state.exitCode !== 0) return;
  await assertOwnedSerial(expectedName);
  await attempt(ADB, ['-s', SERIAL, 'emu', 'kill']);
  for (let attemptIndex = 0; attemptIndex < 80; attemptIndex += 1) {
    const state = await attempt(ADB, ['-s', SERIAL, 'get-state']);
    if (state.exitCode !== 0) return;
    await delay(250);
  }
  throw proofError('b4_android_emulator_cleanup_failed', 'The owned emulator did not stop.');
}

async function withOwnedAvd({ label, image, device }, action) {
  const name = `KS2_Spelling_B4_${label}_${process.pid}`;
  let created = false;
  let started = false;
  await assertSerialAvailable();
  try {
    await createAvd({ name, image, device });
    created = true;
    startDetached(EMULATOR, [
      '-avd', name,
      '-wipe-data',
      '-no-window',
      '-no-boot-anim',
      '-no-snapshot',
      '-gpu', 'swiftshader_indirect',
      '-port', PORT,
    ]);
    started = true;
    await waitForBoot();
    await assertOwnedSerial(name);
    return await action({ name, image, device, serial: SERIAL });
  } finally {
    try {
      if (started) await stopEmulator(name);
    } finally {
      if (created) await attempt(AVD_MANAGER, ['delete', 'avd', '--name', name]);
    }
  }
}

async function buildOfflineApplication() {
  await checked('npm', ['run', 'sync:b4-development'], { stream: true });
  await checked('./android/gradlew', [
    '-p', 'android', ':app:assembleDebug', ':app:assembleDebugAndroidTest',
  ], { stream: true });
  const index = await checked('unzip', [
    '-p', APK_PATH, 'assets/public/index.html',
  ]);
  if (!index.includes('name="ks2-spelling-build-mode" content="B4Development"') ||
      !/connect-src (?:&#39;|')none(?:&#39;|')/u.test(index)) {
    throw proofError(
      'b4_android_offline_boundary_missing',
      'The built B4 APK is not network-denied.',
    );
  }
  return (await stat(APK_PATH)).size;
}

async function adbChecked(args, options) {
  return checked(ADB, ['-s', SERIAL, ...args], options);
}

async function installApplications() {
  await adbChecked(['install', '-r', APK_PATH]);
  await adbChecked(['install', '-r', TEST_APK_PATH]);
}

async function configureDevice(fontScale = '1.0') {
  await adbChecked(['shell', 'settings', 'put', 'global', 'airplane_mode_on', '1']);
  await adbChecked(['shell', 'svc', 'wifi', 'disable']);
  await adbChecked(['shell', 'svc', 'data', 'disable']);
  await adbChecked([
    'shell', 'settings', 'put', 'secure', 'show_ime_with_hard_keyboard', '1',
  ]);
  await adbChecked(['shell', 'ime', 'enable', SOFTWARE_KEYBOARD]);
  await adbChecked(['shell', 'ime', 'set', SOFTWARE_KEYBOARD]);
  await adbChecked(['shell', 'settings', 'put', 'system', 'font_scale', fontScale]);
  const [offline, keyboard] = await Promise.all([
    adbChecked(['shell', 'settings', 'get', 'global', 'airplane_mode_on']),
    adbChecked(['shell', 'settings', 'get', 'secure', 'default_input_method']),
  ]);
  if (offline !== '1' || keyboard !== SOFTWARE_KEYBOARD) {
    throw proofError(
      'b4_android_device_state_invalid',
      'The emulator did not retain the offline and software-keyboard preconditions.',
    );
  }
}

async function runInstrumentation(method, prefix) {
  const result = await execute(ADB, [
    '-s', SERIAL,
    'shell', 'am', 'instrument', '-w', '-r',
    '-e', 'class', `${TEST_CLASS}#${method}`,
    '-e', 'b4EvidencePrefix', prefix,
    TEST_RUNNER,
  ], { stream: true });
  if (result.exitCode !== 0) {
    throw proofError('b4_android_instrumentation_failed', `${method} could not run.`);
  }
  validateB4AndroidInstrumentationOutput(`${result.stdout}\n${result.stderr}`);
}

async function readPhase(prefix, phase) {
  const raw = await adbChecked([
    'shell', 'run-as', APP_ID, 'cat', `files/b4-${prefix}-${phase}.json`,
  ]);
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw proofError('b4_android_evidence_invalid', 'Android phase evidence is not JSON.', {
      cause,
    });
  }
}

async function runJourney({ prefix, fontScale }) {
  await adbChecked(['shell', 'pm', 'clear', APP_ID]);
  await configureDevice(fontScale);
  await runInstrumentation('testJourneyPhaseOne', prefix);
  const phaseOne = await readPhase(prefix, 'phase1');
  await adbChecked(['shell', 'am', 'force-stop', APP_ID]);
  await runInstrumentation('testJourneyPhaseTwo', prefix);
  const phaseTwo = await readPhase(prefix, 'phase2');
  return combineB4AndroidJourney(phaseOne, phaseTwo);
}

async function databaseFamilyBytes() {
  let total = 0;
  let mainFound = false;
  for (const name of [DATABASE_NAME, `${DATABASE_NAME}-wal`, `${DATABASE_NAME}-shm`]) {
    const result = await attempt(ADB, [
      '-s', SERIAL, 'shell', 'run-as', APP_ID,
      'stat', '-c', '%s', `databases/${name}`,
    ]);
    if (result.exitCode === 0 && /^[0-9]+$/u.test(result.stdout.trim())) {
      total += Number.parseInt(result.stdout.trim(), 10);
      if (name === DATABASE_NAME) mainFound = true;
    } else if (name === DATABASE_NAME) {
      throw proofError('b4_android_database_missing', 'The Android SQLite database is missing.');
    }
  }
  if (!mainFound) throw proofError('b4_android_database_missing', 'The Android SQLite database is missing.');
  return total;
}

async function capturePng(localPath, label) {
  const remotePath = `/sdcard/ks2-spelling-b4-${process.pid}-${label}.png`;
  try {
    await adbChecked(['shell', 'screencap', '-p', remotePath]);
    await adbChecked(['pull', remotePath, localPath]);
  } finally {
    await attempt(ADB, ['-s', SERIAL, 'shell', 'rm', '-f', remotePath]);
  }
  return pngDimensions(localPath);
}

async function pngDimensions(path) {
  const bytes = await readFile(path);
  if (bytes.length < 24 || bytes.toString('ascii', 1, 4) !== 'PNG') {
    throw proofError('b4_android_screenshot_invalid', 'An Android screenshot is not a PNG.');
  }
  return Object.freeze({
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  });
}

async function deviceMetadata(profile) {
  const [api, release, build, model, abi, emulator] = await Promise.all([
    adbChecked(['shell', 'getprop', 'ro.build.version.sdk']),
    adbChecked(['shell', 'getprop', 'ro.build.version.release']),
    adbChecked(['shell', 'getprop', 'ro.build.id']),
    adbChecked(['shell', 'getprop', 'ro.product.model']),
    adbChecked(['shell', 'getprop', 'ro.product.cpu.abi']),
    adbChecked(['shell', 'getprop', 'ro.kernel.qemu']),
  ]);
  if (!/^[0-9]+$/u.test(api) || emulator !== '1') {
    throw proofError('b4_android_device_metadata_invalid', 'Android emulator metadata is invalid.');
  }
  return Object.freeze({
    avdName: profile.name,
    requestedImage: profile.image,
    requestedDevice: profile.device,
    api: Number.parseInt(api, 10),
    release,
    build,
    model,
    abi,
  });
}

async function startApplication() {
  await adbChecked([
    'shell', 'am', 'start', '-W',
    '-a', 'android.intent.action.MAIN',
    '-c', 'android.intent.category.LAUNCHER',
    '-n', `${APP_ID}/.MainActivity`,
  ]);
}

async function waitForApplicationSurface() {
  for (let attemptIndex = 0; attemptIndex < 30; attemptIndex += 1) {
    const hierarchy = await attempt(ADB, [
      '-s', SERIAL, 'exec-out', 'uiautomator', 'dump', '/dev/tty',
    ]);
    if (hierarchy.exitCode === 0 &&
        `${hierarchy.stdout}\n${hierarchy.stderr}`.includes('Listen, type, learn')) {
      await delay(750);
      return;
    }
    await delay(250);
  }
  throw proofError(
    'b4_android_surface_missing',
    'The foreground Android application did not expose the learner surface.',
  );
}

async function presentApplication() {
  await startApplication();
  await waitForApplicationSurface();
}

async function captureTabletLayout(workDirectory) {
  await adbChecked(['shell', 'pm', 'clear', APP_ID]);
  await configureDevice('1.0');
  await runInstrumentation('testTabletLayout', 'tablet');
  const controlEvidence = await readPhase('tablet', 'layout');
  await adbChecked(['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0']);
  const candidates = [];
  for (const rotation of ['0', '1']) {
    await adbChecked(['shell', 'settings', 'put', 'system', 'user_rotation', rotation]);
    await presentApplication();
    const path = join(workDirectory, `tablet-rotation-${rotation}.png`);
    candidates.push({ rotation, path, dimensions: await capturePng(path, `tablet-${rotation}`) });
  }
  const portrait = candidates.find(({ dimensions }) => dimensions.height > dimensions.width);
  const landscape = candidates.find(({ dimensions }) => dimensions.width > dimensions.height);
  if (!portrait || !landscape) {
    throw proofError(
      'b4_android_layout_orientation_invalid',
      'The tablet emulator did not expose both viewport orientations.',
    );
  }
  const portraitOutput = join(OUTPUT_DIRECTORY, 'android-tablet-portrait.png');
  const landscapeOutput = join(OUTPUT_DIRECTORY, 'android-tablet-landscape.png');
  await Promise.all([
    rename(portrait.path, portraitOutput),
    rename(landscape.path, landscapeOutput),
  ]);
  return Object.freeze({
    controlEvidence,
    dimensions: validateB4AndroidLayoutDimensions({
      portrait: portrait.dimensions,
      landscape: landscape.dimensions,
    }),
    rotations: { portrait: portrait.rotation, landscape: landscape.rotation },
  });
}

async function hostDescription() {
  const [version, build] = await Promise.all([
    checked('sw_vers', ['-productVersion']),
    checked('sw_vers', ['-buildVersion']),
  ]);
  return `macOS ${version} (${build})`;
}

async function minimumCompatibility() {
  if (!await imageIsHosted(MINIMUM_IMAGE)) {
    return Object.freeze({ status: 'not-hosted', requestedImage: MINIMUM_IMAGE });
  }
  return withOwnedAvd({ label: 'Minimum', image: MINIMUM_IMAGE, device: 'pixel_2' }, async (profile) => {
    await installApplications();
    await adbChecked(['shell', 'pm', 'clear', APP_ID]);
    await configureDevice('1.0');
    await runInstrumentation('testJourneyPhaseOne', 'api24');
    const evidence = await readPhase('api24', 'phase1');
    return Object.freeze({
      status: 'passed',
      device: await deviceMetadata(profile),
      coreFlow: {
        completedAnswers: evidence.answerFeedbackMs?.length ?? 0,
        softwareKeyboardObserved: evidence.softwareKeyboardObserved === true,
        audioActionsObserved: evidence.audioStartMs?.length ?? 0,
      },
    });
  });
}

async function proveB4Android() {
  const lease = await acquireB4AndroidRunnerLease();
  let workDirectory = null;
  try {
    workDirectory = await mkdtemp(join(tmpdir(), 'ks2-b4-android-'));
    if (!await imageIsHosted(PRODUCT_IMAGE)) {
      throw proofError(
        'b4_android_emulator_unavailable',
        `The required hosted Android image is missing: ${PRODUCT_IMAGE}.`,
      );
    }
    const nativePayloadBytes = await buildOfflineApplication();
    await rm(OUTPUT_DIRECTORY, { recursive: true, force: true });
    await mkdir(OUTPUT_DIRECTORY, { recursive: true });

    const phone = await withOwnedAvd(
      { label: 'Phone', image: PRODUCT_IMAGE, device: 'pixel_9' },
      async (profile) => {
        await installApplications();
        const defaultJourney = await runJourney({ prefix: 'default', fontScale: '1.0' });
        await presentApplication();
        const phoneDimensions = await capturePng(
          join(OUTPUT_DIRECTORY, 'android-phone.png'),
          'phone',
        );
        const localDatabaseBytes = await databaseFamilyBytes();
        const scaledJourney = await runJourney({ prefix: 'scaled', fontScale: '2.0' });
        await presentApplication();
        const scaledDimensions = await capturePng(
          join(OUTPUT_DIRECTORY, 'android-phone-200-percent.png'),
          'phone-scaled',
        );
        if (phoneDimensions.height <= phoneDimensions.width ||
            scaledDimensions.height <= scaledDimensions.width) {
          throw proofError(
            'b4_android_layout_orientation_invalid',
            'The phone screenshots are not portrait viewports.',
          );
        }
        return Object.freeze({
          device: await deviceMetadata(profile),
          defaultJourney,
          scaledJourney,
          localDatabaseBytes,
          dimensions: { default: phoneDimensions, scaled: scaledDimensions },
        });
      },
    );

    const tablet = await withOwnedAvd(
      { label: 'Tablet', image: PRODUCT_IMAGE, device: 'pixel_tablet' },
      async (profile) => {
        await installApplications();
        const layout = await captureTabletLayout(workDirectory);
        return Object.freeze({ device: await deviceMetadata(profile), layout });
      },
    );
    const minimumApi24 = await minimumCompatibility();

    const runner = {
      runnerImage: process.env.ImageOS
        ? `${process.env.ImageOS} ${process.env.ImageVersion ?? 'unversioned'}`
        : 'local-macos',
      hostOS: await hostDescription(),
      runtime: `Android ${phone.device.release} / API ${phone.device.api} (${phone.device.build})`,
      deviceProfile: `${phone.device.model}; ${phone.device.abi}; ${phone.device.requestedDevice}`,
      buildConfiguration: 'B4Development debug APK and Android instrumentation APK',
    };
    const platformRiskReport = createB4PlatformRiskReport({
      platform: 'android-emulator',
      runner,
      raw: {
        coldLaunchMs: phone.defaultJourney.coldLaunchMs,
        answerFeedbackMs: phone.defaultJourney.answerFeedbackMs,
        audioStartMs: phone.defaultJourney.audioStartMs,
        nativePayloadBytes,
        localDatabaseBytes: phone.localDatabaseBytes,
      },
    });
    if (platformRiskReport.evidenceClass !== 'virtual-development-risk-observation') {
      throw proofError('b4_android_report_class_invalid', 'The Android report class drifted.');
    }
    const capture = {
      schemaVersion: 1,
      platform: 'android-emulator',
      runner,
      limitations: [LIMITATION],
      offlineBoundary: {
        web: "connect-src 'none'",
        nativeNetworkPlugins: 'not registered for the marked B4 bundle',
        deviceNetwork: 'airplane mode on; Wi-Fi and mobile data disabled',
        clientTts: 'none',
      },
      compatibility: {
        minimumApi24,
        productJourney: phone.device,
        tabletLayout: tablet.device,
      },
      journeys: {
        default: phone.defaultJourney,
        scaled: {
          fontScale: 2,
          atLeast200Percent: true,
          ...phone.scaledJourney,
        },
      },
      rawSizes: {
        nativePayloadBytes,
        localDatabaseBytes: phone.localDatabaseBytes,
      },
      layout: {
        phonePortrait: 'android-phone.png',
        phoneAt200Percent: 'android-phone-200-percent.png',
        tabletPortrait: 'android-tablet-portrait.png',
        tabletLandscape: 'android-tablet-landscape.png',
        phoneDimensions: phone.dimensions,
        tabletDimensions: tablet.layout.dimensions,
        tabletRotations: tablet.layout.rotations,
        tabletControlEvidence: tablet.layout.controlEvidence,
      },
      platformRiskReport,
    };
    await writeFile(
      join(OUTPUT_DIRECTORY, 'capture.json'),
      `${JSON.stringify(capture, null, 2)}\n`,
      { flag: 'wx' },
    );
    return {
      ok: true,
      platform: capture.platform,
      technicalOutcome: platformRiskReport.technicalOutcome,
      outputDirectory: '.native-build/b4/android',
      minimumApi24: minimumApi24.status,
      limitations: capture.limitations,
    };
  } finally {
    try {
      if (workDirectory) await rm(workDirectory, { recursive: true, force: true });
    } finally {
      await lease.close();
    }
  }
}

export async function main() {
  try {
    printJson(await proveB4Android());
    return EXIT_CODES.success;
  } catch (error) {
    printJson({ ok: false, code: error.code, message: error.message }, process.stderr);
    return error?.code?.endsWith('_unavailable')
      ? EXIT_CODES.missingTool
      : EXIT_CODES.commandFailed;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
