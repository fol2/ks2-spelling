import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { selectB4IosRuntimeProfiles } from './prove-b4-ios.mjs';
import {
  configureSoftwareKeyboard,
  createInvestigationRunner,
  exactAttachment,
  investigationError,
} from './lib/investigation.mjs';
import { EXIT_CODES, isMain, printJson } from './lib/run-command.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const RELEASE_APP_PATH = join(
  ROOT,
  '.native-build/b4-release/Build/Products/Release-iphonesimulator/App.app',
);
const COMMAND_TIMEOUT_MS = 15 * 60 * 1_000;

const { execute, checked } = createInvestigationRunner({
  root: ROOT,
  timeoutMs: COMMAND_TIMEOUT_MS,
  failureCode: 'b4_ios_release_command_failed',
});

export async function run() {
  const workDirectory = await mkdtemp(join(tmpdir(), 'ks2-b4-release-ios-'));
  let simulatorUdid = null;
  let restoreKeyboard = null;
  try {
    await checked('npm', ['run', 'sync:b4-development'], { stream: true });
    await checked('xcodebuild', [
      '-quiet',
      '-project', 'ios/App/App.xcodeproj',
      '-scheme', 'KS2Spelling',
      '-configuration', 'Release',
      '-sdk', 'iphonesimulator',
      '-destination', 'generic/platform=iOS Simulator',
      '-derivedDataPath', '.native-build/b4-release',
      'CODE_SIGNING_ALLOWED=NO',
      'build',
    ], { stream: true });
    await checked('xcodebuild', [
      '-quiet',
      '-project', 'ios/App/App.xcodeproj',
      '-scheme', 'B4DevelopmentUITests',
      '-configuration', 'Release',
      '-destination', 'generic/platform=iOS Simulator',
      '-derivedDataPath', '.native-build/b4-release',
      'CODE_SIGNING_ALLOWED=NO',
      'build-for-testing',
    ], { stream: true });
    const index = await readFile(join(RELEASE_APP_PATH, 'public/index.html'), 'utf8');
    if (!index.includes('name="ks2-spelling-build-mode" content="B4Development"')) {
      throw investigationError(
        'b4_ios_release_bundle_invalid',
        'The Release build is not the marked B4 bundle.',
      );
    }
    const profiles = selectB4IosRuntimeProfiles(JSON.parse(await checked('xcrun', [
      'simctl', 'list', 'runtimes', 'available', '--json',
    ])));
    restoreKeyboard = await configureSoftwareKeyboard({ execute, checked });
    simulatorUdid = await checked('xcrun', [
      'simctl', 'create', `KS2 Spelling B4 Release ${process.pid}`,
      profiles.phoneTypeIdentifier, profiles.runtimeIdentifier,
    ]);
    await checked('xcrun', ['simctl', 'boot', simulatorUdid]);
    await checked('xcrun', ['simctl', 'bootstatus', simulatorUdid, '-b']);
    await checked('xcrun', ['simctl', 'install', simulatorUdid, RELEASE_APP_PATH]);
    const resultPath = join(workDirectory, 'release-journey.xcresult');
    const testResult = await execute('xcodebuild', [
      '-quiet',
      '-project', 'ios/App/App.xcodeproj',
      '-scheme', 'B4DevelopmentUITests',
      '-configuration', 'Release',
      '-destination', `platform=iOS Simulator,id=${simulatorUdid}`,
      '-derivedDataPath', '.native-build/b4-release',
      '-resultBundlePath', resultPath,
      '-only-testing:B3ProofUITests/B4DevelopmentTests/testInstalledFiveCardJourney',
      'CODE_SIGNING_ALLOWED=NO',
      'test-without-building',
    ], { stream: true });
    if (testResult.exitCode !== 0) {
      const preserved = join(tmpdir(), `ks2-b4-release-ios-failure-${process.pid}.xcresult`);
      await execute('cp', ['-R', resultPath, preserved]);
      throw investigationError(
        'b4_ios_release_test_failed',
        `xcodebuild failed with exit code ${testResult.exitCode}; result preserved at ${preserved}.`,
      );
    }
    const attachmentsDirectory = join(workDirectory, 'attachments');
    await checked('xcrun', [
      'xcresulttool', 'export', 'attachments',
      '--path', resultPath, '--output-path', attachmentsDirectory,
    ]);
    const manifest = JSON.parse(await readFile(join(attachmentsDirectory, 'manifest.json'), 'utf8'));
    const observationFile = exactAttachment(manifest, 'b4-ios-journey-observations_', 'b4_ios_release_attachment_invalid');
    const journey = JSON.parse(await readFile(join(attachmentsDirectory, observationFile), 'utf8'));
    if (journey.schemaVersion !== 1 || journey.completed !== true) {
      throw investigationError(
        'b4_ios_release_journey_invalid',
        'The Release journey observations are incomplete.',
      );
    }
    return Object.freeze({
      ok: true,
      platform: 'ios-simulator',
      buildConfiguration: 'Release',
      coldLaunchMs: journey.coldLaunchMs,
      answerFeedbackMs: journey.answerFeedbackMs,
      audioStartMs: journey.audioStartMs,
      comparator: Object.freeze({ coldLaunchMs: 2_000 }),
      limitations: Object.freeze([
        'Simulator only; a Release-configuration launch on a virtual device is attribution evidence, not device certification.',
      ]),
    });
  } finally {
    if (simulatorUdid) {
      await execute('xcrun', ['simctl', 'shutdown', simulatorUdid]);
      await execute('xcrun', ['simctl', 'delete', simulatorUdid]);
    }
    if (restoreKeyboard) await restoreKeyboard();
    await rm(workDirectory, { recursive: true, force: true });
  }
}

export async function main() {
  try {
    printJson(await run());
    return EXIT_CODES.success;
  } catch (error) {
    printJson({
      ok: false,
      code: error.code ?? 'b4_ios_release_investigation_failed',
      message: error.message,
    }, process.stderr);
    return EXIT_CODES.commandFailed;
  }
}

if (isMain(import.meta.url)) process.exitCode = await main();
