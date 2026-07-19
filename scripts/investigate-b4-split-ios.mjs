import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  createB4IosXcodeTestArguments,
  selectB4IosRuntimeProfiles,
} from './prove-b4-ios.mjs';
import { EXIT_CODES, isMain, printJson, runCommand } from './lib/run-command.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ID = 'uk.eugnel.ks2spelling';
const APP_PATH = join(ROOT, '.native-build/ios/Build/Products/Debug-iphonesimulator/App.app');
const DATABASE_NAME = 'ks2-spellingSQLite.db';
const COMMAND_TIMEOUT_MS = 15 * 60 * 1_000;
const KEYBOARD_DOMAIN = 'com.apple.iphonesimulator';
const KEYBOARD_KEY = 'ConnectHardwareKeyboard';

function investigationError(code, message, options) {
  return Object.assign(new Error(message, options), { code });
}

function roundMs(value) {
  return Math.round(value * 1_000) / 1_000;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function execute(command, args, { stream = false } = {}) {
  return runCommand(command, args, {
    cwd: ROOT,
    stream,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
}

async function checked(command, args, options) {
  const result = await execute(command, args, options);
  if (result.exitCode !== 0) {
    throw investigationError(
      'b4_ios_split_command_failed',
      `${command} failed with exit code ${result.exitCode}.`,
    );
  }
  return result.stdout.trim();
}

async function attempt(command, args) {
  return execute(command, args);
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
    throw investigationError(
      'b4_ios_split_offline_boundary_missing',
      'The built B4 application is not network-denied.',
    );
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
  const matches = manifest.flatMap((entry) => entry.attachments ?? []).filter(
    ({ suggestedHumanReadableName }) => suggestedHumanReadableName?.startsWith(suggestedPrefix),
  );
  if (matches.length !== 1) {
    throw investigationError(
      'b4_ios_split_attachment_invalid',
      `Expected one ${suggestedPrefix} attachment.`,
    );
  }
  return matches[0].exportedFileName;
}

async function watchRevisions(databasePath, testPromise) {
  const revisions = new Map();
  let database = null;
  let lastRevision = -1;
  let testFinished = false;
  void testPromise.finally(() => { testFinished = true; });
  try {
    while (!testFinished) {
      if (database === null) {
        try {
          await access(databasePath);
          database = new DatabaseSync(databasePath, { readOnly: true });
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
      if (database !== null) {
        const row = database.prepare(
          'SELECT revision FROM spelling_aggregates WHERE learner_id = ?',
        ).get('learner-a');
        if (row && row.revision !== lastRevision) {
          const revision = Number(row.revision);
          if (!Number.isSafeInteger(revision) || revision < lastRevision ||
              (lastRevision >= 0 && revision !== lastRevision + 1)) {
            throw investigationError(
              'b4_ios_split_revision_observation_incomplete',
              `SQLite revision observation jumped from ${lastRevision} to ${revision}.`,
            );
          }
          revisions.set(revision, Date.now());
          lastRevision = revision;
        }
      }
      await delay(2);
    }
    return revisions;
  } finally {
    database?.close();
  }
}

function createReport(capture, revisions) {
  if (capture?.schemaVersion !== 1 || capture.completed !== true ||
      !Array.isArray(capture.observations) || capture.observations.length !== 10) {
    throw investigationError(
      'b4_ios_split_capture_invalid',
      'The iOS split-timing capture is incomplete.',
    );
  }
  const observations = capture.observations.map((observation, index) => {
    const expectedRevision = 2 + (index * 2);
    const commitEpochMs = revisions.get(expectedRevision);
    if (observation.answerIndex !== index + 1 ||
        observation.expectedRevision !== expectedRevision ||
        !Number.isFinite(commitEpochMs) ||
        !Number.isFinite(observation.submitEpochMs) ||
        !Number.isFinite(observation.audioPlayingVisibleEpochMs) ||
        !Number.isFinite(observation.feedbackVisibleEpochMs) ||
        !Number.isFinite(observation.replayToAudioPlayingVisibleMs) ||
        commitEpochMs < observation.submitEpochMs ||
        observation.audioPlayingVisibleEpochMs < commitEpochMs ||
        observation.feedbackVisibleEpochMs < commitEpochMs) {
      throw investigationError(
        'b4_ios_split_observation_invalid',
        `The iOS split-timing observation for answer ${index + 1} is invalid.`,
      );
    }
    return Object.freeze({
      answerIndex: index + 1,
      expectedRevision,
      commandCommitUpperBoundMs: roundMs(commitEpochMs - observation.submitEpochMs),
      commitToAudioPlayingAndPublishVisibleMs: roundMs(
        Math.min(
          observation.audioPlayingVisibleEpochMs,
          observation.feedbackVisibleEpochMs,
        ) - commitEpochMs,
      ),
      accessibilityObservationSkewMs: roundMs(
        Math.abs(
          observation.audioPlayingVisibleEpochMs - observation.feedbackVisibleEpochMs,
        ),
      ),
      submitToFeedbackVisibleMs: roundMs(
        observation.feedbackVisibleEpochMs - observation.submitEpochMs,
      ),
      replayToAudioPlayingAndPublishVisibleMs: roundMs(
        observation.replayToAudioPlayingVisibleMs,
      ),
    });
  });
  return Object.freeze({
    ok: true,
    schemaVersion: 1,
    platform: 'ios-simulator',
    splitKind: 'bounded',
    observations,
    limitations: Object.freeze([
      'Simulator only; not physical-device or signed-distribution evidence.',
      'SQLite polling records an upper bound on command commit and includes polling latency.',
      'XCUITest cannot observe the installed WKWebView JavaScript playing event or controller publish separately.',
      'Audio playing and feedback are DOM-driven accessibility nodes from the same post-playing render; their combined interval cannot attribute audio versus publish time.',
    ]),
  });
}

export async function run() {
  const workDirectory = await mkdtemp(join(tmpdir(), 'ks2-b4-split-ios-'));
  let simulatorUdid = null;
  let restoreKeyboard = null;
  try {
    await buildOfflineApplication();
    const profiles = selectB4IosRuntimeProfiles(JSON.parse(await checked('xcrun', [
      'simctl', 'list', 'runtimes', 'available', '--json',
    ])));
    restoreKeyboard = await configureSoftwareKeyboard();
    simulatorUdid = await checked('xcrun', [
      'simctl', 'create', `KS2 Spelling B4 Split ${process.pid}`,
      profiles.phoneTypeIdentifier, profiles.runtimeIdentifier,
    ]);
    await checked('xcrun', ['simctl', 'boot', simulatorUdid]);
    await checked('xcrun', ['simctl', 'bootstatus', simulatorUdid, '-b']);
    await checked('xcrun', ['simctl', 'ui', simulatorUdid, 'content_size', 'large']);
    await checked('xcrun', ['simctl', 'install', simulatorUdid, APP_PATH]);
    const container = await checked('xcrun', [
      'simctl', 'get_app_container', simulatorUdid, APP_ID, 'data',
    ]);
    const resultPath = join(workDirectory, 'split-timing.xcresult');
    const testPromise = execute('xcodebuild', createB4IosXcodeTestArguments({
      udid: simulatorUdid,
      resultPath,
      testMethod: 'testSplitTimingJourney',
    }), { stream: true });
    const revisionsPromise = watchRevisions(
      join(container, 'Library', 'CapacitorDatabase', DATABASE_NAME),
      testPromise,
    );
    const testResult = await testPromise;
    const revisions = await revisionsPromise;
    if (testResult.exitCode !== 0) {
      throw investigationError(
        'b4_ios_split_test_failed',
        `xcodebuild failed with exit code ${testResult.exitCode}.`,
      );
    }

    const summary = JSON.parse(await checked('xcrun', [
      'xcresulttool', 'get', 'test-results', 'summary', '--path', resultPath,
    ]));
    if (summary.result !== 'Passed' || summary.totalTestCount !== 1 || summary.passedTests !== 1) {
      throw investigationError('b4_ios_split_test_invalid', 'The iOS split test did not pass once.');
    }
    const attachmentsDirectory = join(workDirectory, 'attachments');
    await checked('xcrun', [
      'xcresulttool', 'export', 'attachments',
      '--path', resultPath, '--output-path', attachmentsDirectory,
    ]);
    const manifest = JSON.parse(await readFile(join(attachmentsDirectory, 'manifest.json'), 'utf8'));
    const captureFile = exactAttachment(manifest, 'b4-ios-split-timing_');
    const capture = JSON.parse(await readFile(join(attachmentsDirectory, captureFile), 'utf8'));
    return createReport(capture, revisions);
  } finally {
    if (simulatorUdid) {
      await attempt('xcrun', ['simctl', 'shutdown', simulatorUdid]);
      await attempt('xcrun', ['simctl', 'delete', simulatorUdid]);
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
      code: error.code ?? 'b4_ios_split_investigation_failed',
      message: error.message,
    }, process.stderr);
    return EXIT_CODES.commandFailed;
  }
}

if (isMain(import.meta.url)) process.exitCode = await main();
