import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createB4PlatformRiskReport } from '../src/app/b4-development-report.js';
import {
  EXIT_CODES,
  isMain,
  printJson,
  runCommand,
} from './lib/run-command.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ID = 'uk.eugnel.ks2spelling';
const APP_PATH = join(
  ROOT,
  '.native-build/ios/Build/Products/Debug-iphonesimulator/App.app',
);
const OUTPUT_DIRECTORY = join(ROOT, '.native-build/b4/ios');
const DATABASE_DIRECTORY = join('Library', 'CapacitorDatabase');
const DATABASE_NAME = 'ks2-spellingSQLite.db';
const COMMAND_TIMEOUT_MS = 15 * 60 * 1_000;
const KEYBOARD_DOMAIN = 'com.apple.iphonesimulator';
const KEYBOARD_KEY = 'ConnectHardwareKeyboard';
const LIMITATION = 'Simulator only; not physical-device, signed-distribution or App Store evidence.';

function proofError(code, message, options) {
  const error = new Error(message, options);
  error.code = code;
  return error;
}

function versionParts(version) {
  return String(version).split('.').map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function preferredDeviceType(types, family, name) {
  const familyTypes = types.filter((candidate) => candidate.productFamily === family);
  return familyTypes.find((candidate) => candidate.name === name) ?? familyTypes[0] ?? null;
}

export function selectB4IosRuntimeProfiles(payload) {
  const runtime = payload?.runtimes
    ?.filter((candidate) => candidate.isAvailable === true)
    .toSorted((left, right) => compareVersions(right.version, left.version))[0];
  if (!runtime || !Array.isArray(runtime.supportedDeviceTypes)) {
    throw proofError('b4_ios_runtime_unavailable', 'No hosted iOS Simulator runtime is available.');
  }
  const phone = preferredDeviceType(runtime.supportedDeviceTypes, 'iPhone', 'iPhone 17');
  const tablet = preferredDeviceType(runtime.supportedDeviceTypes, 'iPad', 'iPad (A16)');
  if (!phone || !tablet) {
    throw proofError('b4_ios_profile_unavailable', 'The iOS runtime lacks a phone or tablet profile.');
  }
  return Object.freeze({
    runtimeIdentifier: runtime.identifier,
    runtimeLabel: `${runtime.name} ${runtime.version} (${runtime.buildversion})`,
    phoneTypeIdentifier: phone.identifier,
    phoneTypeName: phone.name,
    tabletTypeIdentifier: tablet.identifier,
    tabletTypeName: tablet.name,
  });
}

export function createB4IosXcodeTestArguments({ udid, resultPath, testMethod }) {
  return Object.freeze([
    '-quiet',
    '-project',
    'ios/App/App.xcodeproj',
    '-scheme',
    'B4DevelopmentUITests',
    '-configuration',
    'Debug',
    '-destination',
    `platform=iOS Simulator,id=${udid}`,
    '-derivedDataPath',
    '.native-build/b4-ios-ui',
    '-resultBundlePath',
    resultPath,
    `-only-testing:B3ProofUITests/B4DevelopmentTests/${testMethod}`,
    'CODE_SIGNING_ALLOWED=NO',
    'test',
  ]);
}

export function validateB4IosLayoutDimensions(value) {
  const valid = value?.portrait?.width > 0 && value.portrait.height > value.portrait.width &&
    value?.landscape?.height > 0 && value.landscape.width > value.landscape.height;
  if (!valid) {
    throw proofError(
      'b4_ios_layout_orientation_invalid',
      'The iOS layout screenshots do not prove portrait and landscape application viewports.',
    );
  }
  return structuredClone(value);
}

export function measuredB4IosTextScale({ defaultHeightPoints, scaledHeightPoints }) {
  if (!Number.isFinite(defaultHeightPoints) || defaultHeightPoints <= 0 ||
      !Number.isFinite(scaledHeightPoints) || scaledHeightPoints <= 0) {
    throw proofError(
      'b4_ios_text_scale_invalid',
      'The iOS text-scale reference heights must be positive finite values.',
    );
  }
  const ratio = scaledHeightPoints / defaultHeightPoints;
  if (ratio < 2) {
    throw proofError(
      'b4_ios_text_scale_invalid',
      `The measured iOS text scale was ${ratio.toFixed(3)}; at least 2.000 is required.`,
    );
  }
  return Number(ratio.toFixed(3));
}

async function checked(command, args, { stream = false } = {}) {
  const result = await runCommand(command, args, {
    cwd: ROOT,
    stream,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw proofError(
      'b4_ios_command_failed',
      `${command} failed with exit code ${result.exitCode}.`,
    );
  }
  return result.stdout.trim();
}

async function attempt(command, args) {
  return runCommand(command, args, { cwd: ROOT, timeoutMs: COMMAND_TIMEOUT_MS });
}

async function sumDirectoryBytes(path) {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await sumDirectoryBytes(child);
    else total += (await lstat(child)).size;
  }
  return total;
}

async function pngDimensions(path) {
  const bytes = await readFile(path);
  if (bytes.length < 24 || bytes.toString('ascii', 1, 4) !== 'PNG') {
    throw proofError('b4_ios_screenshot_invalid', 'A B4 iOS screenshot is not a PNG.');
  }
  return Object.freeze({
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  });
}

async function databaseFamilyBytes(udid) {
  const container = await checked('xcrun', [
    'simctl', 'get_app_container', udid, APP_ID, 'data',
  ]);
  let total = 0;
  let mainFound = false;
  for (const name of [DATABASE_NAME, `${DATABASE_NAME}-wal`, `${DATABASE_NAME}-shm`]) {
    try {
      total += (await stat(join(container, DATABASE_DIRECTORY, name))).size;
      if (name === DATABASE_NAME) mainFound = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  if (!mainFound) throw proofError('b4_ios_database_missing', 'The B4 SQLite database is missing.');
  return total;
}

async function buildOfflineApplication() {
  await checked('npm', ['run', 'sync:b4-development'], { stream: true });
  await checked('xcodebuild', [
    '-quiet',
    '-project', 'ios/App/App.xcodeproj',
    '-scheme', 'KS2Spelling',
    '-configuration', 'Debug',
    '-sdk', 'iphonesimulator',
    '-destination', 'generic/platform=iOS Simulator',
    '-derivedDataPath', '.native-build/ios',
    'CODE_SIGNING_ALLOWED=NO',
    'build',
  ], { stream: true });
  const index = await readFile(join(APP_PATH, 'public/index.html'), 'utf8');
  if (!index.includes('name="ks2-spelling-build-mode" content="B4Development"') ||
      !/connect-src (?:&#39;|')none(?:&#39;|')/u.test(index)) {
    throw proofError('b4_ios_offline_boundary_missing', 'The built B4 application is not network-denied.');
  }
  return sumDirectoryBytes(APP_PATH);
}

async function createSimulator(name, deviceType, runtime) {
  return checked('xcrun', ['simctl', 'create', name, deviceType, runtime]);
}

async function bootSimulator(udid) {
  await checked('xcrun', ['simctl', 'boot', udid]);
  await checked('xcrun', ['simctl', 'bootstatus', udid, '-b']);
}

async function installFresh(udid) {
  const installed = await attempt('xcrun', [
    'simctl', 'get_app_container', udid, APP_ID,
  ]);
  if (installed.exitCode === 0) {
    await checked('xcrun', ['simctl', 'uninstall', udid, APP_ID]);
  }
  await checked('xcrun', ['simctl', 'install', udid, APP_PATH]);
}

async function setContentSize(udid, category) {
  await checked('xcrun', ['simctl', 'ui', udid, 'content_size', category]);
  const actual = await checked('xcrun', ['simctl', 'ui', udid, 'content_size']);
  if (actual !== category) {
    throw proofError('b4_ios_content_size_mismatch', `Expected ${category}, received ${actual}.`);
  }
}

async function configureSoftwareKeyboard() {
  const original = await attempt('defaults', ['read', KEYBOARD_DOMAIN, KEYBOARD_KEY]);
  await checked('defaults', ['write', KEYBOARD_DOMAIN, KEYBOARD_KEY, '-bool', 'false']);
  return async () => {
    if (original.exitCode === 0) {
      const enabled = /^(?:1|true|yes)$/iu.test(original.stdout.trim());
      await checked('defaults', [
        'write', KEYBOARD_DOMAIN, KEYBOARD_KEY, '-bool', enabled ? 'true' : 'false',
      ]);
    } else {
      await checked('defaults', ['delete', KEYBOARD_DOMAIN, KEYBOARD_KEY]);
    }
  };
}

function exactAttachment(manifest, suggestedPrefix) {
  const attachments = manifest.flatMap((entry) => entry.attachments ?? []);
  const matches = attachments.filter(({ suggestedHumanReadableName }) =>
    suggestedHumanReadableName?.startsWith(suggestedPrefix));
  if (matches.length !== 1) {
    throw proofError('b4_ios_attachment_invalid', `Expected one ${suggestedPrefix} attachment.`);
  }
  return matches[0].exportedFileName;
}

async function runInstalledTest({ udid, workDirectory, name, testMethod }) {
  await installFresh(udid);
  const resultPath = join(workDirectory, `${name}.xcresult`);
  await checked('xcodebuild', createB4IosXcodeTestArguments({
    udid,
    resultPath,
    testMethod,
  }), { stream: true });
  const summary = JSON.parse(await checked('xcrun', [
    'xcresulttool', 'get', 'test-results', 'summary', '--path', resultPath,
  ]));
  if (summary.result !== 'Passed' || summary.totalTestCount !== 1 || summary.passedTests !== 1) {
    throw proofError('b4_ios_test_result_invalid', `${name} did not pass exactly one test.`);
  }
  const attachmentsDirectory = join(workDirectory, `${name}-attachments`);
  await checked('xcrun', [
    'xcresulttool', 'export', 'attachments',
    '--path', resultPath,
    '--output-path', attachmentsDirectory,
  ]);
  const manifest = JSON.parse(await readFile(join(attachmentsDirectory, 'manifest.json'), 'utf8'));
  return Object.freeze({ summary, manifest, attachmentsDirectory });
}

async function readJourneyCapture(capture) {
  const observationFile = exactAttachment(capture.manifest, 'b4-ios-journey-observations_');
  const screenshotFile = exactAttachment(capture.manifest, 'b4-ios-completed-round_');
  return Object.freeze({
    observations: JSON.parse(await readFile(
      join(capture.attachmentsDirectory, observationFile),
      'utf8',
    )),
    screenshotPath: join(capture.attachmentsDirectory, screenshotFile),
  });
}

async function hostDescription() {
  const [version, build] = await Promise.all([
    checked('sw_vers', ['-productVersion']),
    checked('sw_vers', ['-buildVersion']),
  ]);
  return `macOS ${version} (${build})`;
}

async function proveB4Ios() {
  const workDirectory = await mkdtemp(join(tmpdir(), 'ks2-b4-ios-'));
  const ownedSimulatorUdids = [];
  let phoneUdid = null;
  let scaledPhoneUdid = null;
  let tabletUdid = null;
  let restoreKeyboard = null;
  try {
    const profiles = selectB4IosRuntimeProfiles(JSON.parse(await checked('xcrun', [
      'simctl', 'list', 'runtimes', 'available', '--json',
    ])));
    const nativePayloadBytes = await buildOfflineApplication();
    await rm(OUTPUT_DIRECTORY, { recursive: true, force: true });
    await mkdir(OUTPUT_DIRECTORY, { recursive: true });

    restoreKeyboard = await configureSoftwareKeyboard();
    phoneUdid = await createSimulator(
      `KS2 Spelling B4 Phone ${process.pid}`,
      profiles.phoneTypeIdentifier,
      profiles.runtimeIdentifier,
    );
    ownedSimulatorUdids.push(phoneUdid);
    scaledPhoneUdid = await createSimulator(
      `KS2 Spelling B4 Scaled Phone ${process.pid}`,
      profiles.phoneTypeIdentifier,
      profiles.runtimeIdentifier,
    );
    ownedSimulatorUdids.push(scaledPhoneUdid);
    tabletUdid = await createSimulator(
      `KS2 Spelling B4 Tablet ${process.pid}`,
      profiles.tabletTypeIdentifier,
      profiles.runtimeIdentifier,
    );
    ownedSimulatorUdids.push(tabletUdid);
    await bootSimulator(phoneUdid);
    await bootSimulator(scaledPhoneUdid);
    await bootSimulator(tabletUdid);

    await setContentSize(phoneUdid, 'large');
    const defaultResult = await runInstalledTest({
      udid: phoneUdid,
      workDirectory,
      name: 'phone-default',
      testMethod: 'testInstalledFiveCardJourney',
    });
    const defaultJourney = await readJourneyCapture(defaultResult);
    const localDatabaseBytes = await databaseFamilyBytes(phoneUdid);

    await setContentSize(scaledPhoneUdid, 'accessibility-extra-extra-extra-large');
    const scaledResult = await runInstalledTest({
      udid: scaledPhoneUdid,
      workDirectory,
      name: 'phone-200-percent',
      testMethod: 'testInstalledFiveCardJourney',
    });
    const scaledJourney = await readJourneyCapture(scaledResult);
    const measuredTextScale = measuredB4IosTextScale({
      defaultHeightPoints: defaultJourney.observations.referenceTextHeightPoints,
      scaledHeightPoints: scaledJourney.observations.referenceTextHeightPoints,
    });

    await setContentSize(tabletUdid, 'large');
    const tabletResult = await runInstalledTest({
      udid: tabletUdid,
      workDirectory,
      name: 'tablet-layout',
      testMethod: 'testTabletLayoutScreenshots',
    });
    const portraitFile = exactAttachment(tabletResult.manifest, 'b4-ios-layout-portrait_');
    const landscapeFile = exactAttachment(tabletResult.manifest, 'b4-ios-layout-landscape_');
    const portraitPath = join(tabletResult.attachmentsDirectory, portraitFile);
    const landscapeFramebufferPath = join(tabletResult.attachmentsDirectory, landscapeFile);
    const landscapePath = join(workDirectory, 'ios-tablet-landscape-normalised.png');
    await checked('sips', [
      '--rotate', '-90', landscapeFramebufferPath, '--out', landscapePath,
    ]);
    const layoutDimensions = validateB4IosLayoutDimensions({
      portrait: await pngDimensions(portraitPath),
      landscape: await pngDimensions(landscapePath),
    });

    await Promise.all([
      copyFile(defaultJourney.screenshotPath, join(OUTPUT_DIRECTORY, 'ios-phone.png')),
      copyFile(scaledJourney.screenshotPath, join(OUTPUT_DIRECTORY, 'ios-phone-200-percent.png')),
      copyFile(
        portraitPath,
        join(OUTPUT_DIRECTORY, 'ios-tablet-portrait.png'),
      ),
      copyFile(
        landscapePath,
        join(OUTPUT_DIRECTORY, 'ios-tablet-landscape.png'),
      ),
    ]);

    const device = defaultResult.summary.devicesAndConfigurations[0]?.device;
    if (!device) throw proofError('b4_ios_device_metadata_missing', 'Simulator metadata is missing.');
    const runner = {
      runnerImage: process.env.ImageOS
        ? `${process.env.ImageOS} ${process.env.ImageVersion ?? 'unversioned'}`
        : 'local-macos',
      hostOS: await hostDescription(),
      runtime: `iOS ${device.osVersion} (${device.osBuildNumber})`,
      deviceProfile: `${device.modelName} (${device.deviceName})`,
      buildConfiguration: 'B4Development unsigned Simulator',
    };
    const raw = {
      coldLaunchMs: defaultJourney.observations.coldLaunchMs,
      answerFeedbackMs: defaultJourney.observations.answerFeedbackMs,
      audioStartMs: defaultJourney.observations.audioStartMs,
      nativePayloadBytes,
      localDatabaseBytes,
    };
    const platformRiskReport = createB4PlatformRiskReport({
      platform: 'ios-simulator',
      runner,
      raw,
    });
    if (platformRiskReport.evidenceClass !== 'virtual-development-risk-observation') {
      throw proofError('b4_ios_report_class_invalid', 'The iOS risk report class drifted.');
    }
    const capture = {
      schemaVersion: 1,
      platform: 'ios-simulator',
      runner,
      limitations: [LIMITATION],
      offlineBoundary: {
        web: "connect-src 'none'",
        nativeNetworkPlugins: 'not registered for the marked B4 bundle',
        clientTts: 'none',
      },
      journeys: {
        default: defaultJourney.observations,
        scaled: {
          contentSizeCategory: 'accessibility-extra-extra-extra-large',
          measuredTextScale,
          atLeast200Percent: measuredTextScale >= 2,
          ...scaledJourney.observations,
        },
      },
      rawSizes: { nativePayloadBytes, localDatabaseBytes },
      layout: {
        phonePortrait: 'ios-phone.png',
        phoneAt200Percent: 'ios-phone-200-percent.png',
        tabletPortrait: 'ios-tablet-portrait.png',
        tabletLandscape: 'ios-tablet-landscape.png',
        dimensions: layoutDimensions,
        landscapeNormalisation: 'XCTest portrait framebuffer rotated -90 degrees after landscape scene validation',
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
      outputDirectory: '.native-build/b4/ios',
      limitations: capture.limitations,
    };
  } catch (error) {
    const preserved = join(tmpdir(), `ks2-b4-ios-failure-${process.pid}`);
    await attempt('cp', ['-R', workDirectory, preserved]);
    error.message = `${error.message} Evidence preserved at ${preserved}.`;
    throw error;
  } finally {
    for (const udid of ownedSimulatorUdids) {
      await attempt('xcrun', ['simctl', 'shutdown', udid]);
      await attempt('xcrun', ['simctl', 'delete', udid]);
    }
    if (restoreKeyboard) await restoreKeyboard();
    await rm(workDirectory, { recursive: true, force: true });
  }
}

export async function main() {
  try {
    printJson(await proveB4Ios());
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
