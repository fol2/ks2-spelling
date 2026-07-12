import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';

import { canonicalJson } from '../src/platform/database/canonical-json.js';
import { fingerprintB2Application } from './fingerprint-b2-application.mjs';
import {
  B2_APPLICATION_ID,
  B2_ATOMIC_FAILURE_CHECKPOINTS,
  B2_IOS_DEVICE,
  B2_NATIVE_REPORT_SCHEMA_VERSION,
  B2_PLUGIN_VERSIONS,
  analyseIosScreenshotBmp,
  createB2IosFreshInstallPlan,
  parseIosRuntimeVersion,
  runWithB2IosCleanup,
  selectExistingIosDevice,
  validateB2NativeReport,
} from './lib/b2-evidence.mjs';
import {
  EXIT_CODES,
  isMain,
  printJson,
  redactText,
} from './lib/run-command.mjs';
import { parseIosHostProcess } from './launch-ios-simulator.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const REPORT_DIRECTORY = join(ROOT, 'reports/b2');
const REPORT_PATH = join(REPORT_DIRECTORY, 'ios-simulator-proof.json');
const SCREENSHOT_PATH = join(REPORT_DIRECTORY, 'ios-simulator-proof.png');
const EXIT_REPORT_PATH = join(REPORT_DIRECTORY, 'b2-exit-report.json');
const PENDING_PROOF_PATH = join(ROOT, '.native-build/b2/ios-pending-proof.json');
const DATABASE_DIRECTORY = join(ROOT, '.native-build/b2/ios-database-set');
const DATABASE_NAME = 'ks2-spellingSQLite.db';
const DATABASE_RELATIVE_PATH = join(
  'Library',
  'CapacitorDatabase',
  DATABASE_NAME,
);
const APP_PATH = join(
  ROOT,
  '.native-build/ios/Build/Products/Debug-iphonesimulator/App.app',
);
const BUNDLED_SYSTEM_APPLICATION = 'com.apple.Preferences';
const POLL_ATTEMPTS = 600;
const POLL_INTERVAL_MS = 100;
const COMMAND_TIMEOUT_MS = 15 * 60 * 1000;
const PROCESS_POLL_ATTEMPTS = 50;
const PROCESS_POLL_INTERVAL_MS = 100;
const SHA256 = /^[a-f0-9]{64}$/;
const PID = /^[1-9][0-9]*$/;
const METADATA_KEYS = Object.freeze([
  'schemaVersion',
  'phase',
  'commandIndex',
  'activeLearnerId',
  'expectedSessionId',
  'learnerARevision',
  'learnerBDigest',
  'preRelaunchDigest',
  'migrationRollback',
  'atomicFailureCheckpoints',
  'lifecycleEvents',
  'updatedAt',
]);
const LOGICAL_TABLES = Object.freeze([
  Object.freeze({ name: 'app_metadata', orderBy: 'key' }),
  Object.freeze({ name: 'learner_profiles', orderBy: 'learner_id' }),
  Object.freeze({ name: 'spelling_aggregates', orderBy: 'learner_id' }),
  Object.freeze({ name: 'spelling_subject_states', orderBy: 'learner_id' }),
  Object.freeze({ name: 'spelling_practice_sessions', orderBy: 'learner_id' }),
  Object.freeze({ name: 'spelling_events', orderBy: 'learner_id, sequence_no' }),
  Object.freeze({
    name: 'spelling_monster_states',
    orderBy: 'learner_id, reward_track_id',
  }),
  Object.freeze({ name: 'spelling_camp_states', orderBy: 'learner_id, pack_id' }),
]);

export const B2_IOS_DATABASE_FILES = Object.freeze([
  DATABASE_NAME,
  `${DATABASE_NAME}-wal`,
  `${DATABASE_NAME}-shm`,
]);

const DEFAULT_FS = Object.freeze({
  copyFile,
  existsSync,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
});

function proofError(code, message, options) {
  const error = new Error(message, options);
  error.code = code;
  return error;
}

export function runB2IosSubprocess(
  command,
  args = [],
  {
    cwd = ROOT,
    env = process.env,
    timeoutMs = COMMAND_TIMEOUT_MS,
    spawnProcess = spawn,
    signalSource = process,
    signal,
  } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('B2 iOS subprocess timeout must be a positive integer.');
  }
  if (signal?.aborted) {
    return Promise.resolve({
      command: redactText(command, env),
      args: args.map((argument) => redactText(argument, env)),
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      spawnError: null,
      timedOut: false,
      interruptedSignal: null,
      aborted: true,
      abortReason: signal.reason,
    });
  }
  return new Promise((resolveResult) => {
    const child = spawnProcess(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let spawnError = null;
    let timedOut = false;
    let interruptedSignal = null;
    let aborted = false;
    let abortReason;
    let settled = false;
    let forceKillTimer;

    const terminateGroup = (signal) => {
      if (!Number.isSafeInteger(child.pid)) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // The child may already have exited.
        }
      }
    };
    const onSignal = (signal) => {
      interruptedSignal = signal;
      terminateGroup('SIGTERM');
    };
    const onAbort = () => {
      aborted = true;
      abortReason = signal.reason;
      terminateGroup('SIGTERM');
    };
    const signalHandlers = Object.fromEntries(
      ['SIGINT', 'SIGTERM'].map((signal) => [signal, () => onSignal(signal)]),
    );
    for (const [signal, handler] of Object.entries(signalHandlers)) {
      signalSource.on(signal, handler);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateGroup('SIGTERM');
      forceKillTimer = setTimeout(() => terminateGroup('SIGKILL'), 250);
      forceKillTimer.unref?.();
    }, timeoutMs);
    timeout.unref?.();

    child.stdout?.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('close', (code, processSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKillTimer);
      for (const [name, handler] of Object.entries(signalHandlers)) {
        signalSource.off(name, handler);
      }
      signal?.removeEventListener('abort', onAbort);
      resolveResult({
        command: redactText(command, env),
        args: args.map((argument) => redactText(argument, env)),
        exitCode: Number.isInteger(code) ? code : null,
        signal: processSignal,
        stdout: redactText(Buffer.concat(stdout).toString('utf8'), env),
        stderr: redactText(Buffer.concat(stderr).toString('utf8'), env),
        spawnError,
        timedOut,
        interruptedSignal,
        aborted,
        abortReason,
      });
    });
  });
}

export async function runWithB2IosOwnedCleanup({
  ownsDevice,
  udid,
  work,
  shutdown,
  signalSource = process,
}) {
  if (typeof work !== 'function' || typeof shutdown !== 'function') {
    throw new TypeError('B2 iOS cleanup requires work and shutdown functions.');
  }
  let ownedUdid = ownsDevice ? udid : null;
  const ownDevice = (candidateUdid) => {
    if (ownedUdid !== null && ownedUdid !== candidateUdid) {
      throw proofError(
        'b2_ios_device_ownership_changed',
        'B2 iOS owned Simulator identity changed during proof',
      );
    }
    if (typeof candidateUdid !== 'string' || candidateUdid.length === 0) {
      throw proofError('b2_ios_device_invalid', 'Owned iOS simulator UDID is missing');
    }
    ownedUdid = candidateUdid;
  };
  let cleanupPromise;
  const cleanup = () => {
    if (!cleanupPromise) {
      cleanupPromise = ownedUdid !== null
        ? runWithB2IosCleanup({
            ownsDevice: true,
            udid: ownedUdid,
            work: async () => undefined,
            shutdown,
          })
        : Promise.resolve();
    }
    return cleanupPromise;
  };
  const controller = new AbortController();
  const handlers = Object.fromEntries(
    ['SIGINT', 'SIGTERM'].map((signal) => [
      signal,
      () => {
        if (!controller.signal.aborted) {
          controller.abort(proofError(
          'b2_ios_signal_interrupted',
          `B2 iOS proof interrupted by ${signal}`,
          ));
        }
      },
    ]),
  );
  for (const [signal, handler] of Object.entries(handlers)) {
    signalSource.on(signal, handler);
  }
  let primaryError;
  let result;
  try {
    result = await work({ signal: controller.signal, ownDevice });
    controller.signal.throwIfAborted();
  } catch (error) {
    primaryError = controller.signal.aborted ? controller.signal.reason : error;
  } finally {
    for (const [signal, handler] of Object.entries(handlers)) {
      signalSource.off(signal, handler);
    }
  }
  let cleanupError;
  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError && cleanupError) {
    const aggregate = new AggregateError(
      [primaryError, cleanupError],
      'B2 iOS proof and owned-simulator cleanup both failed',
      { cause: primaryError },
    );
    aggregate.code = primaryError.code ?? 'b2_ios_proof_failed';
    throw aggregate;
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  return result;
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).toSorted().join('\0') === [...keys].toSorted().join('\0')
  );
}

function exactStringArray(value, expected) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function throwIfAborted(signal) {
  signal?.throwIfAborted();
}

function abortableDelay(milliseconds, signal) {
  throwIfAborted(signal);
  return new Promise((resolveDelay, rejectDelay) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolveDelay();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      rejectDelay(signal.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function requirePid(value, label) {
  if (!PID.test(value ?? '')) {
    throw proofError('b2_ios_pid_invalid', `${label} is not an exact launch PID`);
  }
  return value;
}

export function parseB2IosLaunchPid(output) {
  const match = String(output ?? '')
    .trim()
    .match(/^uk\.eugnel\.ks2spelling:\s+([1-9][0-9]*)$/);
  if (!match) {
    throw proofError(
      'b2_ios_launch_pid_invalid',
      'iOS launch PID output does not match the exact application identity',
    );
  }
  return match[1];
}

export function assertB2IosProofMetadata(candidate, { phase, baseline } = {}) {
  if (!exactKeys(candidate, METADATA_KEYS)) {
    throw proofError(
      'b2_ios_metadata_invalid',
      'B2 iOS durable proof metadata has missing or unknown keys',
    );
  }
  if (
    candidate.schemaVersion !== 1 ||
    candidate.phase !== phase ||
    candidate.activeLearnerId !== 'learner-a' ||
    candidate.migrationRollback !== 'verified' ||
    candidate.updatedAt !== 1_768_478_400_000 ||
    !SHA256.test(candidate.learnerBDigest) ||
    !SHA256.test(candidate.preRelaunchDigest)
  ) {
    throw proofError(
      'b2_ios_metadata_invalid',
      `B2 iOS durable proof metadata does not match phase ${phase}`,
    );
  }
  const isComplete = phase === 'complete';
  if (
    candidate.commandIndex !== (isComplete ? 6 : 4) ||
    candidate.learnerARevision !== (isComplete ? 6 : 4) ||
    (isComplete
      ? candidate.expectedSessionId !== null
      : typeof candidate.expectedSessionId !== 'string' ||
        candidate.expectedSessionId.length === 0) ||
    !exactStringArray(
      candidate.lifecycleEvents,
      phase === 'background-test-ready' ? [] : ['pause', 'resume'],
    ) ||
    !exactStringArray(
      candidate.atomicFailureCheckpoints,
      isComplete ? B2_ATOMIC_FAILURE_CHECKPOINTS : [],
    )
  ) {
    throw proofError(
      'b2_ios_metadata_invalid',
      `B2 iOS durable proof metadata has invalid ${phase} state`,
    );
  }
  if (baseline !== undefined) {
    if (candidate.expectedSessionId !== baseline.expectedSessionId && !isComplete) {
      throw proofError(
        'b2_ios_session_changed',
        'B2 iOS durable proof session does not match the active session',
      );
    }
    if (candidate.learnerBDigest !== baseline.learnerBDigest) {
      throw proofError(
        'b2_ios_learner_b_changed',
        'B2 iOS durable proof learner-B digest changed',
      );
    }
    if (candidate.preRelaunchDigest !== baseline.preRelaunchDigest) {
      throw proofError(
        'b2_ios_pre_relaunch_changed',
        'B2 iOS durable proof pre-relaunch digest changed',
      );
    }
  }
  return structuredClone(candidate);
}

export function validateB2IosManualAttestation(candidate, screenshotSha256) {
  const keys = [
    'schemaVersion',
    'platform',
    'screenshotSha256',
    'manualVisualInspection',
  ];
  if (
    !exactKeys(candidate, keys) ||
    candidate.schemaVersion !== 1 ||
    candidate.platform !== 'ios-simulator' ||
    candidate.manualVisualInspection !== 'passed' ||
    !SHA256.test(screenshotSha256 ?? '') ||
    candidate.screenshotSha256 !== screenshotSha256
  ) {
    throw proofError(
      'b2_ios_manual_attestation_invalid',
      'B2 iOS manual visual attestation is missing, stale or malformed',
    );
  }
  return structuredClone(candidate);
}

export function validateB2IosPendingProof(
  candidate,
  { expectedCommit, expectedFingerprint, screenshotBytes } = {},
) {
  const invalid = (detail) => {
    throw proofError(
      'b2_ios_pending_proof_invalid',
      `B2 iOS pending proof ${detail}`,
    );
  };
  if (
    !exactKeys(candidate, [
      'schemaVersion',
      'testedApplicationCommit',
      'applicationFingerprint',
      'proof',
    ]) ||
    candidate.schemaVersion !== 1 ||
    !/^[a-f0-9]{40}$/.test(candidate.testedApplicationCommit ?? '') ||
    candidate.testedApplicationCommit !== expectedCommit ||
    !SHA256.test(candidate.applicationFingerprint ?? '') ||
    candidate.applicationFingerprint !== expectedFingerprint
  ) invalid('checkpoint identity is stale or malformed');

  const proof = candidate.proof;
  if (
    !exactKeys(proof, [
      'build',
      'device',
      'metadata',
      'readyMetadata',
      'screenshot',
      'collected',
      'database',
      'lifecycle',
    ]) ||
    !exactKeys(proof.build, [
      'appPath',
      'compiled',
      'configuration',
      'sdk',
      'signed',
    ]) ||
    typeof proof.build.appPath !== 'string' ||
    !proof.build.appPath ||
    proof.build.compiled !== true ||
    proof.build.configuration !== 'Debug' ||
    proof.build.sdk !== 'iphonesimulator' ||
    proof.build.signed !== false ||
    !exactKeys(proof.device, ['udid', 'state']) ||
    !/^[A-F0-9-]{36}$/i.test(proof.device.udid ?? '') ||
    typeof proof.device.state !== 'string'
  ) invalid('build or owned-device payload is malformed');

  try {
    const ready = assertB2IosProofMetadata(proof.readyMetadata, {
      phase: 'ready-for-relaunch',
    });
    assertB2IosProofMetadata(proof.metadata, {
      phase: 'complete',
      baseline: ready,
    });
  } catch {
    invalid('durable metadata payload is malformed');
  }

  if (
    !exactKeys(proof.screenshot, [
      'path',
      'sha256',
      'machineStateSource',
      'exactTextState',
      'manualVisualInspection',
    ]) ||
    typeof proof.screenshot.path !== 'string' ||
    !proof.screenshot.path ||
    proof.screenshot.machineStateSource !== 'durable-proof-metadata' ||
    proof.screenshot.exactTextState !== 'complete' ||
    proof.screenshot.manualVisualInspection !== 'pending' ||
    !SHA256.test(proof.screenshot.sha256 ?? '') ||
    !(screenshotBytes instanceof Uint8Array) ||
    sha256(screenshotBytes) !== proof.screenshot.sha256
  ) invalid('screenshot payload is stale or malformed');

  const collected = proof.collected;
  if (
    !exactKeys(collected, [
      'databasePath',
      'sidecarsObserved',
      'observedFiles',
      'fileSha256',
      'everyObservedSidecarCollectedSafely',
    ]) ||
    typeof collected.databasePath !== 'string' ||
    !collected.databasePath ||
    !Array.isArray(collected.observedFiles) ||
    collected.observedFiles[0] !== DATABASE_NAME ||
    !exactStringArray(
      collected.observedFiles,
      B2_IOS_DATABASE_FILES.filter((name) => collected.observedFiles.includes(name)),
    ) ||
    !exactStringArray(collected.sidecarsObserved, collected.observedFiles.slice(1)) ||
    !exactKeys(collected.fileSha256, collected.observedFiles) ||
    collected.observedFiles.some((name) => !SHA256.test(collected.fileSha256[name])) ||
    collected.everyObservedSidecarCollectedSafely !== true
  ) invalid('database collection payload is malformed');

  const database = proof.database;
  if (
    !exactKeys(database, [
      'databaseSha256',
      'foreignKeys',
      'journalMode',
      'synchronous',
      'busyTimeout',
      'integrityCheck',
      'finalLogicalSnapshotSha256',
      'starterCampRows',
      'monsterState',
    ]) ||
    !SHA256.test(database.databaseSha256 ?? '') ||
    database.foreignKeys !== 1 ||
    database.journalMode !== 'wal' ||
    database.synchronous !== 2 ||
    database.busyTimeout !== 5000 ||
    database.integrityCheck !== 'ok' ||
    !SHA256.test(database.finalLogicalSnapshotSha256 ?? '') ||
    database.starterCampRows !== 0 ||
    database.monsterState !== 'spelling-derived-child-owned'
  ) invalid('logical database report payload is malformed');
  if (database.databaseSha256 !== collected.fileSha256[DATABASE_NAME]) {
    invalid('physical database hash does not match its collected payload');
  }

  if (
    !exactKeys(proof.lifecycle, [
      'preKillPid',
      'postRelaunchPid',
      'differentPid',
    ]) ||
    !PID.test(proof.lifecycle.preKillPid ?? '') ||
    !PID.test(proof.lifecycle.postRelaunchPid ?? '') ||
    proof.lifecycle.preKillPid === proof.lifecycle.postRelaunchPid ||
    proof.lifecycle.differentPid !== true
  ) invalid('lifecycle report payload is malformed');
  return structuredClone(candidate);
}

export function assertB2ApplicationStatusClean(statusOutput) {
  const applicationChanges = String(statusOutput ?? '')
    .split('\n')
    .filter(Boolean)
    .filter((line) => {
      const path = line.slice(3).replace(/^"|"$/g, '');
      return !path.startsWith('reports/b2/');
    });
  if (applicationChanges.length !== 0) {
    throw proofError(
      'b2_ios_checkpoint_dirty',
      'B2 iOS proof requires a clean application checkpoint',
    );
  }
  return true;
}

function requireDependency(dependencies, name) {
  if (typeof dependencies?.[name] !== 'function') {
    throw new TypeError(`B2 iOS proof dependency ${name} must be a function.`);
  }
}

export async function runB2IosLifecycleProof(dependencies) {
  for (const name of [
    'syncAndBuildUnsigned',
    'acquireOwnedDevice',
    'bootOwnedDevice',
    'withOwnedCleanup',
    'shutdownOwnedDevice',
    'freshInstallAndLaunch',
    'resolveDataContainer',
    'openLiveMetadataReader',
    'foregroundBundledSystemApp',
    'relaunchForResume',
    'terminateApplication',
    'assertProcessPresent',
    'assertProcessAbsent',
    'launchApplication',
    'captureForegroundScreenshot',
    'collectTerminatedDatabaseSet',
    'inspectCollectedDatabase',
  ]) requireDependency(dependencies, name);
  return dependencies.withOwnedCleanup({
    ownsDevice: false,
    udid: null,
    shutdown: dependencies.shutdownOwnedDevice,
    work: async ({ signal, ownDevice }) => {
      const step = async (operation) => {
        throwIfAborted(signal);
        const value = await operation();
        throwIfAborted(signal);
        return value;
      };
      const build = await step(() =>
        dependencies.syncAndBuildUnsigned({ signal }),
      );
      throwIfAborted(signal);
      const device = await dependencies.acquireOwnedDevice({ signal });
      if (!device || typeof device.udid !== 'string' || !device.udid) {
        throw proofError('b2_ios_device_invalid', 'Owned iOS simulator UDID is missing');
      }
      ownDevice(device.udid);
      throwIfAborted(signal);
      let reader;
      try {
        await step(() => dependencies.bootOwnedDevice(device, { signal }));
        const firstLaunch = await step(() =>
          dependencies.freshInstallAndLaunch(
            { udid: device.udid, appPath: build.appPath },
            { signal },
          ),
        );
        const preKillPid = requirePid(firstLaunch?.pid, 'Pre-kill PID');
        const dataContainer = await step(() =>
          dependencies.resolveDataContainer(device.udid, { signal }),
        );
        const liveDatabasePath = join(dataContainer, DATABASE_RELATIVE_PATH);
        reader = await step(() =>
          dependencies.openLiveMetadataReader(
            liveDatabasePath,
            { readOnly: true, honoursWal: true },
            { signal },
          ),
        );
        if (
          !reader ||
          typeof reader.poll !== 'function' ||
          typeof reader.close !== 'function'
        ) {
          throw new TypeError('B2 iOS live metadata reader contract is invalid.');
        }
        const background = assertB2IosProofMetadata(
          await step(() => reader.poll('background-test-ready', { signal })),
          { phase: 'background-test-ready' },
        );

        await step(() =>
          dependencies.foregroundBundledSystemApp(device.udid, { signal }),
        );
        await step(() => dependencies.relaunchForResume(device.udid, { signal }));
        const ready = assertB2IosProofMetadata(
          await step(() => reader.poll('ready-for-relaunch', { signal })),
          { phase: 'ready-for-relaunch', baseline: background },
        );

        await step(() => dependencies.assertProcessPresent(preKillPid, { signal }));
        await step(() => dependencies.terminateApplication(device.udid, { signal }));
        await step(() => dependencies.assertProcessAbsent(preKillPid, { signal }));
        const secondLaunch = await step(() =>
          dependencies.launchApplication(device.udid, { signal }),
        );
        const postRelaunchPid = requirePid(
          secondLaunch?.pid,
          'Post-relaunch PID',
        );
        if (postRelaunchPid === preKillPid) {
          throw proofError(
            'b2_ios_pid_unchanged',
            'B2 iOS relaunch did not create a different process PID',
          );
        }
        await step(() =>
          dependencies.assertProcessPresent(postRelaunchPid, { signal }),
        );

        const complete = assertB2IosProofMetadata(
          await step(() => reader.poll('complete', { signal })),
          { phase: 'complete', baseline: ready },
        );
        const screenshot = await step(() =>
          dependencies.captureForegroundScreenshot(
            { udid: device.udid, pid: postRelaunchPid, metadata: complete },
            { signal },
          ),
        );
        await step(() => dependencies.terminateApplication(device.udid, { signal }));
        await step(() =>
          dependencies.assertProcessAbsent(postRelaunchPid, { signal }),
        );
        const collected = await step(() =>
          dependencies.collectTerminatedDatabaseSet(
            { dataContainer },
            { signal },
          ),
        );
        const database = await step(() =>
          dependencies.inspectCollectedDatabase(
            { databasePath: collected.databasePath, readOnly: true },
            { signal },
          ),
        );
        return {
          build,
          device,
          metadata: complete,
          readyMetadata: ready,
          screenshot,
          collected,
          database,
          lifecycle: {
            preKillPid,
            postRelaunchPid,
            differentPid: true,
          },
        };
      } finally {
        if (reader) await reader.close();
      }
    },
  });
}

function createRequiredRunner(run = runB2IosSubprocess) {
  return async function required(
    command,
    args,
    {
      allowMissingApplication = false,
      allowAlreadyShutdown = false,
      timeoutMs = COMMAND_TIMEOUT_MS,
      signal,
    } = {},
  ) {
    throwIfAborted(signal);
    const result = await run(command, args, { cwd: ROOT, timeoutMs, signal });
    throwIfAborted(signal);
    if (!result || typeof result !== 'object') {
      throw proofError(
        'b2_ios_command_result_invalid',
        `${command} returned a malformed command result`,
      );
    }
    if (result.spawnError) {
      throw proofError(
        'b2_ios_command_spawn_failed',
        `${command} could not be started: ${result.spawnError.message}`,
      );
    }
    if (result.aborted) {
      throw result.abortReason ?? proofError(
        'b2_ios_command_aborted',
        `${command} ${args.join(' ')} was aborted`,
      );
    }
    if (result.timedOut) {
      throw proofError(
        'b2_ios_command_timeout',
        `${command} ${args.join(' ')} exceeded its bounded timeout`,
      );
    }
    if (result.interruptedSignal) {
      throw proofError(
        'b2_ios_command_interrupted',
        `${command} ${args.join(' ')} was interrupted by ${result.interruptedSignal}`,
      );
    }
    if (result.signal) {
      throw proofError(
        'b2_ios_command_signal',
        `${command} ${args.join(' ')} exited via ${result.signal}`,
      );
    }
    if (result.exitCode === 0) return result;
    const output = `${result.stdout}\n${result.stderr}`;
    if (
      allowMissingApplication &&
      Number.isInteger(result.exitCode) &&
      /(?:not found|not installed|does not exist|no such file)/i.test(output)
    ) {
      return result;
    }
    if (
      allowAlreadyShutdown &&
      Number.isInteger(result.exitCode) &&
      /current state:\s*Shutdown/i.test(output)
    ) {
      return result;
    }
    throw proofError(
      'b2_ios_command_failed',
      `${command} ${args.join(' ')} failed with ${result.exitCode}`,
    );
  };
}

const runRequired = createRequiredRunner();

async function readJsonCommand(
  command,
  args,
  required = runRequired,
  { signal } = {},
) {
  const result = await required(command, args, { signal });
  try {
    return JSON.parse(result.stdout);
  } catch (cause) {
    throw proofError(
      'b2_ios_command_json_invalid',
      `${command} did not return valid JSON`,
      { cause },
    );
  }
}

export function parseB2IosProcessProbe(result, pid) {
  requirePid(pid, 'Process probe PID');
  if (!result || typeof result !== 'object') {
    throw proofError(
      'b2_ios_process_probe_failed',
      `B2 iOS process ${pid} probe result is malformed`,
    );
  }
  if (
    result.spawnError ||
    result.timedOut ||
    result.interruptedSignal ||
    result.signal ||
    result.aborted
  ) {
    throw proofError(
      'b2_ios_process_probe_failed',
      `B2 iOS process ${pid} probe did not complete normally`,
    );
  }
  if (result.exitCode === 0) {
    parseIosHostProcess(result.stdout, pid);
    return 'present';
  }
  if (result.exitCode === 1 && result.stdout.trim() === '') return 'absent';
  throw proofError(
    'b2_ios_process_probe_failed',
    `B2 iOS process ${pid} probe failed with ${result.exitCode}`,
  );
}

export async function pollB2IosProcess({
  pid,
  expected,
  run = runB2IosSubprocess,
  attempts = PROCESS_POLL_ATTEMPTS,
  intervalMs = PROCESS_POLL_INTERVAL_MS,
  sleep = abortableDelay,
  signal,
}) {
  if (!['present', 'absent'].includes(expected)) {
    throw new TypeError('B2 iOS process expectation is invalid.');
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    throwIfAborted(signal);
    const state = parseB2IosProcessProbe(
      await run('/bin/ps', ['-p', pid, '-o', 'pid=,comm='], {
        cwd: ROOT,
        timeoutMs: 5_000,
        signal,
      }),
      pid,
    );
    throwIfAborted(signal);
    if (state === expected) return state;
    if (attempt + 1 < attempts) await sleep(intervalMs, signal);
  }
  throw proofError(
    expected === 'present'
      ? 'b2_ios_process_missing'
      : 'b2_ios_process_still_running',
    `B2 iOS process ${pid} did not become ${expected}`,
  );
}

async function waitForPath(
  path,
  { fs = DEFAULT_FS, sleep = abortableDelay, signal } = {},
) {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);
    if (fs.existsSync(path)) return;
    await sleep(POLL_INTERVAL_MS, signal);
  }
  throw proofError(
    'b2_ios_database_timeout',
    `B2 iOS live database did not appear: ${path}`,
  );
}

export function openB2IosLiveMetadataReader(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  let closed = false;
  function readMetadata() {
    const row = database
      .prepare("SELECT value_json, updated_at FROM app_metadata WHERE key = 'b2-proof'")
      .get();
    if (!row) return null;
    if (typeof row.value_json !== 'string' || !Number.isSafeInteger(row.updated_at)) {
      throw proofError(
        'b2_ios_metadata_row_invalid',
        'B2 iOS durable proof metadata row is malformed',
      );
    }
    let value;
    try {
      value = JSON.parse(row.value_json);
    } catch (cause) {
      throw proofError(
        'b2_ios_metadata_json_invalid',
        'B2 iOS durable proof metadata is not valid JSON',
        { cause },
      );
    }
    if (canonicalJson(value) !== row.value_json || value.updatedAt !== row.updated_at) {
      throw proofError(
        'b2_ios_metadata_json_invalid',
        'B2 iOS durable proof metadata is not canonical',
      );
    }
    return value;
  }
  return Object.freeze({
    async poll(expectedPhase, { signal } = {}) {
      const phaseOrder = [
        'fresh',
        'background-test-ready',
        'ready-for-relaunch',
        'complete',
      ];
      const expectedIndex = phaseOrder.indexOf(expectedPhase);
      if (expectedIndex < 0) throw new TypeError('Unknown B2 iOS proof phase.');
      for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
        throwIfAborted(signal);
        let value = null;
        try {
          value = readMetadata();
        } catch (error) {
          if (!/no such table: app_metadata/i.test(error.message)) throw error;
        }
        if (value?.phase === expectedPhase) return value;
        const actualIndex = phaseOrder.indexOf(value?.phase);
        if (actualIndex > expectedIndex) {
          throw proofError(
            'b2_ios_phase_skipped',
            `B2 iOS durable proof skipped phase ${expectedPhase}`,
          );
        }
        await abortableDelay(POLL_INTERVAL_MS, signal);
      }
      throw proofError(
        'b2_ios_phase_timeout',
        `B2 iOS durable proof timed out at phase ${expectedPhase}`,
      );
    },
    async close() {
      if (closed) return;
      closed = true;
      database.close();
    },
  });
}

function databaseSiblingNames(entries) {
  const siblings = entries
    .filter(({ name }) => name === DATABASE_NAME || name.startsWith(`${DATABASE_NAME}-`));
  const unknown = siblings.filter(({ name }) => !B2_IOS_DATABASE_FILES.includes(name));
  if (unknown.length !== 0) {
    throw proofError(
      'b2_ios_database_sidecar_unknown',
      `B2 iOS database has unknown sidecars: ${unknown.map(({ name }) => name).join(', ')}`,
    );
  }
  if (
    siblings.filter(({ name }) => name === DATABASE_NAME).length !== 1 ||
    siblings.some((entry) => !entry.isFile())
  ) {
    throw proofError(
      'b2_ios_database_set_invalid',
      'B2 iOS database evidence set has an invalid primary file or sidecar',
    );
  }
  return B2_IOS_DATABASE_FILES.filter((name) =>
    siblings.some((entry) => entry.name === name),
  );
}

export async function collectB2IosDatabaseSet({
  sourceDirectory,
  destinationDirectory = DATABASE_DIRECTORY,
  fs = DEFAULT_FS,
  signal,
}) {
  throwIfAborted(signal);
  const observed = databaseSiblingNames(
    await fs.readdir(sourceDirectory, { withFileTypes: true }),
  );
  throwIfAborted(signal);
  const before = new Map();
  for (const filename of observed) {
    throwIfAborted(signal);
    const path = join(sourceDirectory, filename);
    const details = await fs.stat(path);
    const bytes = await fs.readFile(path);
    throwIfAborted(signal);
    if (!details.isFile() || details.size <= 0 || bytes.byteLength !== details.size) {
      throw proofError(
        'b2_ios_database_set_invalid',
        `B2 iOS database evidence file is empty or unstable: ${filename}`,
      );
    }
    before.set(filename, {
      size: details.size,
      mtimeMs: details.mtimeMs,
      sha256: sha256(bytes),
    });
  }
  const temporaryDirectory = `${destinationDirectory}.tmp-${process.pid}`;
  throwIfAborted(signal);
  await fs.rm(temporaryDirectory, { force: true, recursive: true });
  throwIfAborted(signal);
  await fs.mkdir(temporaryDirectory, { recursive: true });
  try {
    for (const filename of observed) {
      throwIfAborted(signal);
      const source = join(sourceDirectory, filename);
      await fs.copyFile(source, join(temporaryDirectory, filename));
      throwIfAborted(signal);
    }
    const afterNames = databaseSiblingNames(
      await fs.readdir(sourceDirectory, { withFileTypes: true }),
    );
    throwIfAborted(signal);
    if (!exactStringArray(afterNames, observed)) {
      throw proofError(
        'b2_ios_database_set_changed',
        'B2 iOS database sidecar set changed during collection',
      );
    }
    for (const filename of observed) {
      throwIfAborted(signal);
      const source = join(sourceDirectory, filename);
      let details;
      let bytes;
      try {
        details = await fs.stat(source);
        bytes = await fs.readFile(source);
        throwIfAborted(signal);
      } catch (cause) {
        throw proofError(
          'b2_ios_database_set_disappeared',
          `B2 iOS database evidence disappeared during collection: ${filename}`,
          { cause },
        );
      }
      const expected = before.get(filename);
      if (
        details.size !== expected.size ||
        details.mtimeMs !== expected.mtimeMs ||
        sha256(bytes) !== expected.sha256
      ) {
        throw proofError(
          'b2_ios_database_set_changed',
          `B2 iOS database evidence changed during collection: ${filename}`,
        );
      }
    }
    throwIfAborted(signal);
    await fs.rm(destinationDirectory, { force: true, recursive: true });
    throwIfAborted(signal);
    await fs.rename(temporaryDirectory, destinationDirectory);
  } catch (error) {
    await fs.rm(temporaryDirectory, { force: true, recursive: true });
    throw error;
  }
  return {
    databasePath: join(destinationDirectory, DATABASE_NAME),
    sidecarsObserved: observed.slice(1),
    observedFiles: observed,
    fileSha256: Object.fromEntries(
      observed.map((name) => [name, before.get(name).sha256]),
    ),
    everyObservedSidecarCollectedSafely:
      observed.slice(1).every((name) => before.has(name)) &&
      observed.length === before.size,
  };
}

async function copyStableDatabaseSet(
  { dataContainer },
  fs = DEFAULT_FS,
  { signal } = {},
) {
  return collectB2IosDatabaseSet({
    sourceDirectory: join(dataContainer, 'Library', 'CapacitorDatabase'),
    fs,
    signal,
  });
}

function pragmaScalar(database, pragma, key) {
  const row = database.prepare(`PRAGMA ${pragma}`).get();
  if (!row || !Object.hasOwn(row, key)) {
    throw proofError(
      'b2_ios_pragma_invalid',
      `B2 iOS collected database PRAGMA ${pragma} is incomplete`,
    );
  }
  return row[key];
}

function tableRows(database, table, orderBy) {
  return database.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all();
}

async function inspectCollectedDatabase({ databasePath }, { signal } = {}) {
  throwIfAborted(signal);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    throwIfAborted(signal);
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const integrityRows = database.prepare('PRAGMA integrity_check').all();
    throwIfAborted(signal);
    const logicalState = {
      schema: database
        .prepare(
          'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name',
        )
        .all(),
      tables: Object.fromEntries(
        LOGICAL_TABLES.map(({ name, orderBy }) => [
          name,
          tableRows(database, name, orderBy),
        ]),
      ),
      userVersion: database.prepare('PRAGMA user_version').all(),
    };
    const campRows = logicalState.tables.spelling_camp_states;
    const monsterRows = logicalState.tables.spelling_monster_states;
    if (campRows.length !== 0) {
      throw proofError(
        'b2_ios_starter_camp_invalid',
        'B2 iOS Starter proof unexpectedly contains Camp rows',
      );
    }
    if (
      monsterRows.length === 0 ||
      monsterRows.some(
        ({ learner_id: learnerId, reward_track_id: rewardTrackId }) =>
          learnerId !== 'learner-a' ||
          typeof rewardTrackId !== 'string' ||
          rewardTrackId.length === 0,
      )
    ) {
      throw proofError(
        'b2_ios_monster_state_invalid',
        'B2 iOS Monster state is not spelling-derived and child-owned',
      );
    }
    return {
      databaseSha256: sha256(await readFile(databasePath)),
      foreignKeys: Number(pragmaScalar(database, 'foreign_keys', 'foreign_keys')),
      journalMode: pragmaScalar(database, 'journal_mode', 'journal_mode'),
      synchronous: Number(pragmaScalar(database, 'synchronous', 'synchronous')),
      busyTimeout: Number(pragmaScalar(database, 'busy_timeout', 'timeout')),
      integrityCheck:
        integrityRows.length === 1 ? integrityRows[0].integrity_check : null,
      finalLogicalSnapshotSha256: sha256(canonicalJson(logicalState)),
      starterCampRows: campRows.length,
      monsterState: 'spelling-derived-child-owned',
    };
  } finally {
    database.close();
  }
}

async function assertCleanCheckpoint() {
  const [commit, status] = await Promise.all([
    runRequired('git', ['rev-parse', 'HEAD']),
    runRequired('git', ['status', '--porcelain', '--untracked-files=all']),
  ]);
  const testedApplicationCommit = commit.stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(testedApplicationCommit)) {
    throw proofError(
      'b2_ios_checkpoint_invalid',
      'B2 iOS tested application commit is malformed',
    );
  }
  assertB2ApplicationStatusClean(status.stdout);
  return testedApplicationCommit;
}

async function clearIosProofOutputs() {
  await Promise.all([
    rm(REPORT_PATH, { force: true }),
    rm(SCREENSHOT_PATH, { force: true }),
    rm(EXIT_REPORT_PATH, { force: true }),
    rm(PENDING_PROOF_PATH, { force: true }),
  ]);
}

export function createB2IosProductionDependencies({
  run = runB2IosSubprocess,
  fs = DEFAULT_FS,
  sleep = abortableDelay,
  signalSource = process,
} = {}) {
  const required = createRequiredRunner(run);
  return {
    async syncAndBuildUnsigned({ signal } = {}) {
      await required(process.execPath, ['scripts/native-sync-check.mjs'], { signal });
      await required(process.execPath, ['scripts/test-ios.mjs'], { signal });
      throwIfAborted(signal);
      if (!fs.existsSync(APP_PATH)) {
        throw proofError(
          'b2_ios_build_output_invalid',
          'B2 iOS build is not the exact unsigned Simulator application',
        );
      }
      return {
        appPath: APP_PATH,
        compiled: true,
        configuration: 'Debug',
        sdk: 'iphonesimulator',
        signed: false,
      };
    },
    async acquireOwnedDevice({ signal } = {}) {
      const runtimes = await readJsonCommand('xcrun', [
        'simctl',
        'list',
        'runtimes',
        '-j',
      ], required, { signal });
      parseIosRuntimeVersion(runtimes);
      const listed = await readJsonCommand('xcrun', [
        'simctl',
        'list',
        'devices',
        '-j',
      ], required, { signal });
      let device = selectExistingIosDevice(listed.devices ?? {});
      if (!device) {
        const created = await required('xcrun', [
          'simctl',
          'create',
          B2_IOS_DEVICE.name,
          B2_IOS_DEVICE.type,
          B2_IOS_DEVICE.runtime,
        ], { signal });
        device = { udid: created.stdout.trim(), state: 'Shutdown' };
      }
      if (!/^[A-F0-9-]{36}$/i.test(device.udid ?? '')) {
        throw proofError(
          'b2_ios_device_invalid',
          'B2 iOS owned Simulator UDID is malformed',
        );
      }
      return { udid: device.udid, state: device.state };
    },
    async bootOwnedDevice(device, { signal } = {}) {
      if (device.state !== 'Shutdown') {
        await required('xcrun', ['simctl', 'shutdown', device.udid], { signal });
      }
      await required('xcrun', ['simctl', 'boot', device.udid], { signal });
      await required('xcrun', ['simctl', 'bootstatus', device.udid, '-b'], {
        signal,
      });
    },
    withOwnedCleanup(options) {
      return runWithB2IosOwnedCleanup({ ...options, signalSource });
    },
    async shutdownOwnedDevice(udid) {
      await required('xcrun', ['simctl', 'shutdown', udid], {
        allowAlreadyShutdown: true,
      });
    },
    async freshInstallAndLaunch({ udid, appPath }, { signal } = {}) {
      const plan = createB2IosFreshInstallPlan({ udid, appPath });
      for (const [index, [command, args]] of plan.entries()) {
        await required(command, args, {
          allowMissingApplication: index === 0,
          signal,
        });
      }
      const launch = await required('xcrun', [
        'simctl',
        'launch',
        udid,
        B2_APPLICATION_ID,
      ], { signal });
      return { pid: parseB2IosLaunchPid(launch.stdout) };
    },
    async resolveDataContainer(udid, { signal } = {}) {
      const result = await required('xcrun', [
        'simctl',
        'get_app_container',
        udid,
        B2_APPLICATION_ID,
        'data',
      ], { signal });
      const path = result.stdout.trim();
      if (!path.includes('/data/Containers/Data/Application/')) {
        throw proofError(
          'b2_ios_data_container_invalid',
          'B2 iOS application data container is not exact',
        );
      }
      return path;
    },
    async openLiveMetadataReader(databasePath, options, { signal } = {}) {
      if (options.readOnly !== true || options.honoursWal !== true) {
        throw new TypeError('B2 iOS live reader must be read-only and WAL-aware.');
      }
      await waitForPath(databasePath, { fs, sleep, signal });
      return openB2IosLiveMetadataReader(databasePath);
    },
    async foregroundBundledSystemApp(udid, { signal } = {}) {
      await required('xcrun', [
        'simctl',
        'launch',
        udid,
        BUNDLED_SYSTEM_APPLICATION,
      ], { signal });
    },
    async relaunchForResume(udid, { signal } = {}) {
      await required('xcrun', [
        'simctl',
        'launch',
        udid,
        B2_APPLICATION_ID,
      ], { signal });
    },
    async terminateApplication(udid, { signal } = {}) {
      await required('xcrun', [
        'simctl',
        'terminate',
        udid,
        B2_APPLICATION_ID,
      ], { signal });
    },
    async assertProcessPresent(pid, { signal } = {}) {
      await pollB2IosProcess({ pid, expected: 'present', run, sleep, signal });
    },
    async assertProcessAbsent(pid, { signal } = {}) {
      await pollB2IosProcess({ pid, expected: 'absent', run, sleep, signal });
    },
    async launchApplication(udid, { signal } = {}) {
      const launch = await required('xcrun', [
        'simctl',
        'launch',
        udid,
        B2_APPLICATION_ID,
      ], { signal });
      return { pid: parseB2IosLaunchPid(launch.stdout) };
    },
    async captureForegroundScreenshot(
      { udid, pid, metadata },
      { signal } = {},
    ) {
      assertB2IosProofMetadata(metadata, { phase: 'complete' });
      await pollB2IosProcess({ pid, expected: 'present', run, sleep, signal });
      throwIfAborted(signal);
      await fs.mkdir(REPORT_DIRECTORY, { recursive: true });
      throwIfAborted(signal);
      await required('xcrun', [
        'simctl',
        'io',
        udid,
        'screenshot',
        SCREENSHOT_PATH,
      ], { signal });
      const bmpPath = join(ROOT, '.native-build/b2/ios-proof.bmp');
      throwIfAborted(signal);
      await fs.mkdir(join(ROOT, '.native-build/b2'), { recursive: true });
      throwIfAborted(signal);
      try {
        await required('sips', [
          '-s',
          'format',
          'bmp',
          SCREENSHOT_PATH,
          '--out',
          bmpPath,
        ], { signal });
        throwIfAborted(signal);
        analyseIosScreenshotBmp(await fs.readFile(bmpPath));
        throwIfAborted(signal);
      } finally {
        await fs.rm(bmpPath, { force: true });
      }
      await pollB2IosProcess({ pid, expected: 'present', run, sleep, signal });
      throwIfAborted(signal);
      const screenshotBytes = await fs.readFile(SCREENSHOT_PATH);
      throwIfAborted(signal);
      return {
        path: SCREENSHOT_PATH,
        sha256: sha256(screenshotBytes),
        machineStateSource: 'durable-proof-metadata',
        exactTextState: metadata.phase,
        manualVisualInspection: 'pending',
      };
    },
    collectTerminatedDatabaseSet(options, context) {
      return copyStableDatabaseSet(options, fs, context);
    },
    inspectCollectedDatabase,
  };
}

async function readInstalledPrivacy(build) {
  const info = await readJsonCommand('plutil', [
    '-convert',
    'json',
    '-o',
    '-',
    join(build.appPath, 'Info.plist'),
  ]);
  if (info.CFBundleIdentifier !== B2_APPLICATION_ID) {
    throw proofError(
      'b2_ios_bundle_identity_invalid',
      'B2 iOS installed application identity is not exact',
    );
  }
  const usageKeys = Object.keys(info).filter((key) => /^NS.+UsageDescription$/.test(key));
  if (usageKeys.length !== 0) {
    throw proofError(
      'b2_ios_usage_description_invalid',
      'B2 iOS proof application added protected-resource usage descriptions',
    );
  }
  const config = JSON.parse(
    await readFile(join(build.appPath, 'capacitor.config.json'), 'utf8'),
  );
  if ((config.server?.url ?? null) !== null) {
    throw proofError(
      'b2_ios_server_url_invalid',
      'B2 iOS proof application contains server.url',
    );
  }
  const entitlements = existsSync(join(build.appPath, 'archived-expanded-entitlements.xcent'))
    ? ['unexpected-packaged-entitlements']
    : [];
  if (entitlements.length !== 0) {
    throw proofError(
      'b2_ios_entitlements_invalid',
      'B2 iOS proof application contains unexpected entitlements',
    );
  }
  return {
    serverUrl: null,
    addedIosUsageDescriptionKeys: [],
    addedIosEntitlements: [],
  };
}

async function xcodeVersion() {
  const result = await runRequired('xcodebuild', ['-version']);
  const match = result.stdout.trim().match(/^Xcode ([^\n]+)\nBuild version ([^\n]+)$/);
  if (!match) {
    throw proofError(
      'b2_ios_xcode_version_invalid',
      'B2 iOS Xcode version output is incomplete',
    );
  }
  return `${match[1]} (${match[2]})`;
}

export async function writeValidatedReport({
  testedApplicationCommit,
  applicationFingerprint,
  proof,
  manualAttestation,
}) {
  const attestation = validateB2IosManualAttestation(
    manualAttestation,
    proof.screenshot.sha256,
  );
  const privacy = await readInstalledPrivacy(proof.build);
  const report = {
    schemaVersion: B2_NATIVE_REPORT_SCHEMA_VERSION,
    platform: 'ios-simulator',
    testedApplicationCommit,
    applicationFingerprint,
    identity: { applicationId: B2_APPLICATION_ID },
    device: {
      name: B2_IOS_DEVICE.name,
      runtime: B2_IOS_DEVICE.runtime,
      osVersion: '26.5',
    },
    nativeVersions: {
      xcode: await xcodeVersion(),
      iosSdk: '26.5',
      capacitorIos: '8.4.1',
    },
    pluginVersions: { ...B2_PLUGIN_VERSIONS },
    database: {
      name: 'ks2-spelling',
      physicalFile: DATABASE_NAME,
      schemaVersion: 1,
      foreignKeys: proof.database.foreignKeys,
      journalMode: proof.database.journalMode,
      synchronous: proof.database.synchronous,
      busyTimeout: proof.database.busyTimeout,
      integrityCheck: proof.database.integrityCheck,
      databaseSha256: proof.database.databaseSha256,
      walModeObserved: proof.database.journalMode === 'wal',
      sidecarsObserved: proof.collected.sidecarsObserved,
      everyObservedSidecarCollectedSafely:
        proof.collected.everyObservedSidecarCollectedSafely,
    },
    lifecycle: {
      events: ['pause', 'resume'],
      ...proof.lifecycle,
    },
    proof: {
      resumedSessionId: proof.readyMetadata.expectedSessionId,
      preKillRevision: proof.readyMetadata.learnerARevision,
      finalRevision: proof.metadata.learnerARevision,
      finalLogicalSnapshotSha256: proof.database.finalLogicalSnapshotSha256,
      atomicFailureCheckpoints: proof.metadata.atomicFailureCheckpoints,
      migrationRollback: proof.metadata.migrationRollback,
      learnerBIsolation: 'verified',
      learnerBInitialSha256: proof.readyMetadata.learnerBDigest,
      learnerBFinalSha256: proof.metadata.learnerBDigest,
      monsterState: proof.database.monsterState,
      starterCampRows: proof.database.starterCampRows,
    },
    privacy: {
      serverUrl: privacy.serverUrl,
      packagedAndroidPermissions: [],
      androidBackupEnabled: false,
      addedIosUsageDescriptionKeys: privacy.addedIosUsageDescriptionKeys,
      addedIosEntitlements: privacy.addedIosEntitlements,
    },
    ui: {
      diagnosticPhase: proof.metadata.phase,
      machineStateSource: proof.screenshot.machineStateSource,
      screenshotSha256: proof.screenshot.sha256,
      manualVisualInspection: attestation.manualVisualInspection,
    },
    cleanup: { deviceStopped: true },
  };
  const screenshotBytes = await readFile(SCREENSHOT_PATH);
  validateB2NativeReport(report, {
    expectedPlatform: 'ios-simulator',
    expectedApplicationCommit: testedApplicationCommit,
    expectedApplicationFingerprint: applicationFingerprint,
    screenshotBytes,
  });
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

async function capturePendingProof() {
  await clearIosProofOutputs();
  try {
    const testedApplicationCommit = await assertCleanCheckpoint();
    const fingerprint = await fingerprintB2Application({ root: ROOT });
    const proof = await runB2IosLifecycleProof(
      createB2IosProductionDependencies(),
    );
    await DEFAULT_FS.mkdir(join(ROOT, '.native-build/b2'), { recursive: true });
    await DEFAULT_FS.writeFile(
      PENDING_PROOF_PATH,
      `${JSON.stringify({
        schemaVersion: 1,
        testedApplicationCommit,
        applicationFingerprint: fingerprint.sha256,
        proof,
      }, null, 2)}\n`,
      'utf8',
    );
    printJson(
      {
        ok: false,
        code: 'b2_ios_manual_attestation_required',
        screenshot: 'reports/b2/ios-simulator-proof.png',
        screenshotSha256: proof.screenshot.sha256,
        pendingProof: '.native-build/b2/ios-pending-proof.json',
      },
      process.stderr,
    );
    return EXIT_CODES.stateMismatch;
  } catch (error) {
    await clearIosProofOutputs();
    throw error;
  }
}

async function finalisePendingProof(attestationPath) {
  if (typeof attestationPath !== 'string' || !attestationPath) {
    throw proofError(
      'b2_ios_manual_attestation_required',
      'Use --attest <path> with a screenshot-SHA-bound manual attestation',
    );
  }
  let pending = JSON.parse(await DEFAULT_FS.readFile(PENDING_PROOF_PATH, 'utf8'));
  const currentCommit = await assertCleanCheckpoint();
  const fingerprint = await fingerprintB2Application({ root: ROOT });
  const screenshotBytes = await DEFAULT_FS.readFile(SCREENSHOT_PATH);
  pending = validateB2IosPendingProof(pending, {
    expectedCommit: currentCommit,
    expectedFingerprint: fingerprint.sha256,
    screenshotBytes,
  });
  const collectedDirectory = resolve(
    pending.proof.collected.databasePath,
    '..',
  );
  for (const filename of pending.proof.collected.observedFiles ?? []) {
    const expected = pending.proof.collected.fileSha256?.[filename];
    const actual = sha256(
      await DEFAULT_FS.readFile(join(collectedDirectory, filename)),
    );
    if (!SHA256.test(expected ?? '') || actual !== expected) {
      throw proofError(
        'b2_ios_pending_proof_stale',
        `B2 iOS pending database evidence changed: ${filename}`,
      );
    }
  }
  const recomputedDatabase = await inspectCollectedDatabase({
    databasePath: pending.proof.collected.databasePath,
  });
  if (canonicalJson(recomputedDatabase) !== canonicalJson(pending.proof.database)) {
    throw proofError(
      'b2_ios_pending_proof_invalid',
      'B2 iOS pending logical database report was locally modified',
    );
  }
  const manualAttestation = JSON.parse(
    await DEFAULT_FS.readFile(resolve(attestationPath), 'utf8'),
  );
  const report = await writeValidatedReport({
    testedApplicationCommit: pending.testedApplicationCommit,
    applicationFingerprint: pending.applicationFingerprint,
    proof: pending.proof,
    manualAttestation,
  });
  await DEFAULT_FS.rm(PENDING_PROOF_PATH, { force: true });
  printJson({ ok: true, report: 'reports/b2/ios-simulator-proof.json', proof: report });
  return EXIT_CODES.success;
}

export async function main(args = process.argv.slice(2)) {
  try {
    if (args.length === 0) return capturePendingProof();
    if (args.length === 2 && args[0] === '--attest') {
      return finalisePendingProof(args[1]);
    }
    throw proofError(
      'b2_ios_proof_usage_invalid',
      'Use no arguments to capture or --attest <path> to finalise',
    );
  } catch (error) {
    printJson(
      {
        ok: false,
        code: error.code ?? 'b2_ios_proof_failed',
        message: error.message,
      },
      process.stderr,
    );
    return EXIT_CODES.stateMismatch;
  }
}

if (isMain(import.meta.url)) process.exitCode = await main();
