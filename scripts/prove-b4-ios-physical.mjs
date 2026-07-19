import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { B4_RISK_OBSERVATION_SPECS } from '../src/app/b4-development-report.js';
import { run as runIsolatedSqlite } from './investigate-b4-performance.mjs';
import {
  createInvestigationRunner,
  exactAttachment,
  investigationError,
  roundMs,
} from './lib/investigation.mjs';
import { movePath } from './lib/move-path.mjs';
import { EXIT_CODES, isMain, printJson } from './lib/run-command.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ID = 'uk.eugnel.ks2spelling';
const DERIVED_DATA = '.native-build/ios-physical';
const APP_PATH = join(
  ROOT,
  DERIVED_DATA,
  'Build/Products/Release-iphoneos/App.app',
);
const OUTPUT_PATH = join(ROOT, 'reports/b4-physical/ios-physical-proof.json');
const COMMAND_TIMEOUT_MS = 15 * 60 * 1_000;
const SDK = 'iphoneos26.5';

export const B4_PHYSICAL_LIMITATIONS = Object.freeze([
  'Development-signed install only; this is not distribution, App Store or production signing evidence.',
  'Comparator values are specific to this physical device and must not be treated as transferable across devices or platforms.',
]);

const COMPARATOR_KINDS = Object.freeze([
  'coldLaunch',
  'answerFeedback',
  'sqliteTransactionUpperBound',
  'audioStart',
]);

const { execute, checked } = createInvestigationRunner({
  root: ROOT,
  timeoutMs: COMMAND_TIMEOUT_MS,
  failureCode: 'b4_ios_physical_command_failed',
});

function deviceUdid() {
  const udid = process.env.KS2_PHYSICAL_DEVICE_UDID;
  if (!udid) {
    // The device identifier is pairing material and is never committed.
    throw investigationError(
      'b4_ios_physical_device_udid_missing',
      'Set KS2_PHYSICAL_DEVICE_UDID to the paired device identifier.',
    );
  }
  return udid;
}

function signKeychain() {
  return process.env.KS2_SIGN_KEYCHAIN
    || join(process.env.HOME ?? '', 'Library/Keychains/ks2-ci.keychain-db');
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortKeysDeep(value[key])]),
    );
  }
  return value;
}

function prettySortedJson(value) {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

function maxOf(values) {
  return roundMs(Math.max(...values));
}

function createPhysicalXcodeTestArguments({ udid, resultPath, testMethod, keychain }) {
  return Object.freeze([
    '-quiet',
    '-project',
    'ios/App/App.xcodeproj',
    '-scheme',
    'B4DevelopmentUITests',
    '-configuration',
    'Release',
    '-destination',
    `id=${udid}`,
    '-derivedDataPath',
    DERIVED_DATA,
    '-resultBundlePath',
    resultPath,
    `-only-testing:B3ProofUITests/B4DevelopmentTests/${testMethod}`,
    '-allowProvisioningUpdates',
    `OTHER_CODE_SIGN_FLAGS=--keychain=${keychain}`,
    'test',
  ]);
}

function evaluateComparator(kind, observedMs) {
  const spec = B4_RISK_OBSERVATION_SPECS[kind];
  if (!spec) {
    throw investigationError(
      'b4_ios_physical_comparator_unknown',
      `Unknown B4 physical comparator kind: ${kind}.`,
    );
  }
  const observed = roundMs(observedMs);
  return Object.freeze({
    observedMs: observed,
    thresholdMs: spec.threshold,
    within: observed <= spec.threshold,
  });
}

export function assembleB4PhysicalReport({
  journeyObservations,
  splitCapture,
  isolatedSqliteMaxMs,
  runner,
  applicationCheckpoint,
}) {
  if (!Array.isArray(journeyObservations) || journeyObservations.length !== 3) {
    throw investigationError(
      'b4_ios_physical_journey_series_invalid',
      'The physical iOS proof requires exactly three journey observation captures.',
    );
  }
  for (const [index, journey] of journeyObservations.entries()) {
    if (journey?.completed !== true) {
      throw investigationError(
        'b4_ios_physical_journey_incomplete',
        `Physical journey run ${index + 1} did not complete.`,
      );
    }
    if (!Number.isFinite(journey.coldLaunchMs) || journey.coldLaunchMs < 0
        || !Array.isArray(journey.answerFeedbackMs) || journey.answerFeedbackMs.length !== 10
        || !Array.isArray(journey.audioStartMs) || journey.audioStartMs.length !== 2) {
      throw investigationError(
        'b4_ios_physical_journey_invalid',
        `Physical journey run ${index + 1} is missing required timing series.`,
      );
    }
  }
  if (splitCapture?.schemaVersion !== 1 || splitCapture.completed !== true
      || !Array.isArray(splitCapture.observations) || splitCapture.observations.length !== 10) {
    throw investigationError(
      'b4_ios_physical_split_capture_invalid',
      'The physical iOS split-timing capture is incomplete.',
    );
  }
  if (!Number.isFinite(isolatedSqliteMaxMs) || isolatedSqliteMaxMs < 0) {
    throw investigationError(
      'b4_ios_physical_sqlite_invalid',
      'The isolated SQLite max transaction time is invalid.',
    );
  }
  if (!runner || typeof runner !== 'object'
      || typeof runner.hostOS !== 'string' || runner.hostOS.length === 0
      || typeof runner.xcodeVersion !== 'string' || runner.xcodeVersion.length === 0
      || runner.sdk !== SDK
      || typeof runner.deviceModel !== 'string' || runner.deviceModel.length === 0
      || typeof runner.deviceOsVersion !== 'string' || runner.deviceOsVersion.length === 0
      || runner.buildConfiguration !== 'Release'
      || runner.reality !== 'physical') {
    throw investigationError(
      'b4_ios_physical_runner_invalid',
      'The physical iOS runner metadata is incomplete.',
    );
  }
  if (!applicationCheckpoint
      || !/^[a-f0-9]{40}$/u.test(applicationCheckpoint.commit ?? '')
      || !/^[a-f0-9]{40}$/u.test(applicationCheckpoint.tree ?? '')) {
    throw investigationError(
      'b4_ios_physical_checkpoint_invalid',
      'The application checkpoint must supply forty-character commit and tree hashes.',
    );
  }

  const coldLaunchSeriesMs = journeyObservations.map((journey) => roundMs(journey.coldLaunchMs));
  const defaultJourney = journeyObservations[0];
  const comparators = Object.freeze({
    coldLaunch: evaluateComparator('coldLaunch', maxOf(coldLaunchSeriesMs)),
    answerFeedback: evaluateComparator(
      'answerFeedback',
      maxOf(journeyObservations.flatMap((journey) => journey.answerFeedbackMs)),
    ),
    sqliteTransactionUpperBound: evaluateComparator(
      'sqliteTransactionUpperBound',
      isolatedSqliteMaxMs,
    ),
    audioStart: evaluateComparator(
      'audioStart',
      maxOf(journeyObservations.flatMap((journey) => journey.audioStartMs)),
    ),
  });
  if (Object.keys(comparators).sort().join('|') !== COMPARATOR_KINDS.toSorted().join('|')) {
    throw investigationError(
      'b4_ios_physical_comparator_set_invalid',
      'The physical comparator set drifted from the frozen four-kind contract.',
    );
  }

  return Object.freeze({
    schemaVersion: 1,
    platform: 'ios-physical',
    runner: Object.freeze({ ...runner }),
    limitations: B4_PHYSICAL_LIMITATIONS,
    journeys: Object.freeze({
      default: structuredClone(defaultJourney),
    }),
    repeatJourneys: Object.freeze(
      journeyObservations.slice(1).map((journey) => structuredClone(journey)),
    ),
    coldLaunchSeriesMs: Object.freeze([...coldLaunchSeriesMs]),
    splitTimings: structuredClone(splitCapture),
    isolatedSqlite: Object.freeze({
      maxTransactionMs: roundMs(isolatedSqliteMaxMs),
    }),
    comparators,
    applicationCheckpoint: Object.freeze({
      commit: applicationCheckpoint.commit,
      tree: applicationCheckpoint.tree,
    }),
  });
}

async function hostDescription() {
  const [version, build] = await Promise.all([
    checked('sw_vers', ['-productVersion']),
    checked('sw_vers', ['-buildVersion']),
  ]);
  return `macOS ${version} (${build})`;
}

async function xcodeVersionLabel() {
  const output = await checked('xcodebuild', ['-version']);
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
  const version = lines[0]?.replace(/^Xcode\s+/u, '') ?? '';
  const build = lines[1]?.replace(/^Build version\s+/u, '') ?? '';
  if (!version || !build) {
    throw investigationError(
      'b4_ios_physical_xcode_version_invalid',
      'Unable to parse xcodebuild -version output.',
    );
  }
  return `${version} (${build})`;
}

async function requirePhysicalDevice(udid) {
  const listing = await checked('xcrun', ['devicectl', 'list', 'devices']);
  const deviceLine = listing.split('\n').find((line) => line.includes(udid));
  if (!deviceLine || !/\bavailable\b/iu.test(deviceLine)) {
    throw investigationError(
      'b4_ios_physical_device_unavailable',
      `Physical device ${udid} is absent or not available.`,
    );
  }
}

async function buildOfflineApplication(keychain) {
  await checked('npm', ['run', 'sync:b4-development'], { stream: true });
  await checked('xcodebuild', [
    '-quiet',
    '-project', 'ios/App/App.xcodeproj',
    '-scheme', 'KS2Spelling',
    '-configuration', 'Release',
    '-sdk', 'iphoneos',
    '-destination', 'generic/platform=iOS',
    '-derivedDataPath', DERIVED_DATA,
    '-allowProvisioningUpdates',
    `OTHER_CODE_SIGN_FLAGS=--keychain=${keychain}`,
    'build',
  ], { stream: true });
  const index = await readFile(join(APP_PATH, 'public/index.html'), 'utf8');
  if (!index.includes('name="ks2-spelling-build-mode" content="B4Development"')
      || !/connect-src (?:&#39;|')none(?:&#39;|')/u.test(index)) {
    throw investigationError(
      'b4_ios_physical_offline_boundary_missing',
      'The built B4 physical application is not network-denied.',
    );
  }
}

async function installFresh(udid) {
  await execute('xcrun', [
    'devicectl', 'device', 'uninstall', 'app',
    '--device', udid,
    APP_ID,
  ]);
  await checked('xcrun', [
    'devicectl', 'device', 'install', 'app',
    '--device', udid,
    APP_PATH,
  ], { stream: true });
}

async function preserveFailedResult(resultPath, runLabel) {
  const preserved = join(
    tmpdir(),
    `ks2-b4-physical-failure-${process.pid}-${runLabel}.xcresult`,
  );
  await movePath(resultPath, preserved);
  return preserved;
}

async function runDeviceTest({
  udid,
  keychain,
  workDirectory,
  name,
  testMethod,
  runLabel,
  attachmentPrefix,
}) {
  // Fresh install per run, matching the simulator proof: the frozen journey
  // requires a fresh round state, so every cold launch is first-launch-after-install.
  await installFresh(udid);
  const resultPath = join(workDirectory, `${name}.xcresult`);
  const testResult = await execute('xcodebuild', createPhysicalXcodeTestArguments({
    udid,
    resultPath,
    testMethod,
    keychain,
  }), { stream: true });
  if (testResult.exitCode !== 0) {
    const preserved = await preserveFailedResult(resultPath, runLabel);
    throw investigationError(
      'b4_ios_physical_test_failed',
      `xcodebuild ${testMethod} failed with exit code ${testResult.exitCode}; result preserved at ${preserved}.`,
    );
  }

  const summary = JSON.parse(await checked('xcrun', [
    'xcresulttool', 'get', 'test-results', 'summary', '--path', resultPath,
  ]));
  if (summary.result !== 'Passed' || summary.totalTestCount !== 1 || summary.passedTests !== 1) {
    const preserved = await preserveFailedResult(resultPath, runLabel);
    throw investigationError(
      'b4_ios_physical_test_result_invalid',
      `${name} did not pass exactly one test; result preserved at ${preserved}.`,
    );
  }

  const attachmentsDirectory = join(workDirectory, `${name}-attachments`);
  await checked('xcrun', [
    'xcresulttool', 'export', 'attachments',
    '--path', resultPath,
    '--output-path', attachmentsDirectory,
  ]);
  const manifest = JSON.parse(await readFile(join(attachmentsDirectory, 'manifest.json'), 'utf8'));
  const attachmentFile = exactAttachment(
    manifest,
    attachmentPrefix,
    'b4_ios_physical_attachment_invalid',
  );
  const payload = JSON.parse(await readFile(join(attachmentsDirectory, attachmentFile), 'utf8'));
  const device = summary.devicesAndConfigurations?.[0]?.device;
  return Object.freeze({ payload, device });
}

async function applicationCheckpoint() {
  const [commit, tree] = await Promise.all([
    checked('git', ['rev-parse', 'HEAD']),
    checked('git', ['rev-parse', 'HEAD^{tree}']),
  ]);
  return Object.freeze({ commit, tree });
}

async function proveB4IosPhysical() {
  const udid = deviceUdid();
  const keychain = signKeychain();
  const workDirectory = await mkdtemp(join(tmpdir(), 'ks2-b4-physical-'));
  try {
    await requirePhysicalDevice(udid);
    await buildOfflineApplication(keychain);

    const journeyObservations = [];
    let deviceModel = null;
    let deviceOsVersion = null;
    for (let run = 1; run <= 3; run += 1) {
      const capture = await runDeviceTest({
        udid,
        keychain,
        workDirectory,
        name: `journey-${run}`,
        testMethod: 'testInstalledFiveCardJourney',
        runLabel: `journey-${run}`,
        attachmentPrefix: 'b4-ios-journey-observations_',
      });
      if (capture.payload.completed !== true) {
        throw investigationError(
          'b4_ios_physical_journey_incomplete',
          `Physical journey run ${run} did not complete.`,
        );
      }
      journeyObservations.push(capture.payload);
      if (capture.device) {
        deviceModel = capture.device.modelName ?? capture.device.deviceName ?? deviceModel;
        deviceOsVersion = capture.device.osVersion ?? deviceOsVersion;
      }
    }

    const split = await runDeviceTest({
      udid,
      keychain,
      workDirectory,
      name: 'split-timing',
      testMethod: 'testSplitTimingJourney',
      runLabel: 'split',
      attachmentPrefix: 'b4-ios-split-timing_',
    });
    if (!Array.isArray(split.payload.observations) || split.payload.observations.length !== 10) {
      throw investigationError(
        'b4_ios_physical_split_capture_invalid',
        'The physical split-timing capture must contain exactly ten observations.',
      );
    }

    const sqlite = await runIsolatedSqlite();
    if (!sqlite?.ok || !Number.isFinite(sqlite.maxMs)) {
      throw investigationError(
        'b4_ios_physical_sqlite_invalid',
        'The isolated SQLite investigation did not return a finite maxMs.',
      );
    }

    if (!deviceModel || !deviceOsVersion) {
      throw investigationError(
        'b4_ios_physical_device_metadata_missing',
        'Physical device model or OS version metadata is missing from the xcresult summary.',
      );
    }

    const report = assembleB4PhysicalReport({
      journeyObservations,
      splitCapture: split.payload,
      isolatedSqliteMaxMs: sqlite.maxMs,
      runner: {
        hostOS: await hostDescription(),
        xcodeVersion: await xcodeVersionLabel(),
        sdk: SDK,
        deviceModel,
        deviceOsVersion,
        buildConfiguration: 'Release',
        reality: 'physical',
      },
      applicationCheckpoint: await applicationCheckpoint(),
    });

    await mkdir(join(ROOT, 'reports/b4-physical'), { recursive: true });
    await writeFile(OUTPUT_PATH, prettySortedJson(report));
    return Object.freeze({
      ok: true,
      platform: report.platform,
      outputPath: 'reports/b4-physical/ios-physical-proof.json',
      coldLaunchSeriesMs: report.coldLaunchSeriesMs,
      comparators: report.comparators,
    });
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

export async function main() {
  try {
    printJson(await proveB4IosPhysical());
    return EXIT_CODES.success;
  } catch (error) {
    printJson({
      ok: false,
      code: error.code ?? 'b4_ios_physical_investigation_failed',
      message: error.message,
    }, process.stderr);
    return error?.code === 'b4_ios_physical_device_unavailable'
      ? EXIT_CODES.missingTool
      : EXIT_CODES.commandFailed;
  }
}

if (isMain(import.meta.url)) process.exitCode = await main();
