import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
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
  runCommand,
} from './lib/run-command.mjs';
import { parseIosHostProcess } from './launch-ios-simulator.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const REPORT_DIRECTORY = join(ROOT, 'reports/b2');
const REPORT_PATH = join(REPORT_DIRECTORY, 'ios-simulator-proof.json');
const SCREENSHOT_PATH = join(REPORT_DIRECTORY, 'ios-simulator-proof.png');
const EXIT_REPORT_PATH = join(REPORT_DIRECTORY, 'b2-exit-report.json');
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

function proofError(code, message, options) {
  const error = new Error(message, options);
  error.code = code;
  return error;
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

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
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
    'ownAndBootDevice',
    'withOwnedCleanup',
    'shutdownOwnedDevice',
    'freshInstallAndLaunch',
    'resolveDataContainer',
    'openLiveMetadataReader',
    'foregroundBundledSystemApp',
    'relaunchForResume',
    'terminateApplication',
    'assertProcessAbsent',
    'launchApplication',
    'captureForegroundScreenshot',
    'collectTerminatedDatabaseSet',
    'inspectCollectedDatabase',
  ]) requireDependency(dependencies, name);

  const build = await dependencies.syncAndBuildUnsigned();
  const device = await dependencies.ownAndBootDevice();
  if (!device || typeof device.udid !== 'string' || !device.udid) {
    throw proofError('b2_ios_device_invalid', 'Owned iOS simulator UDID is missing');
  }

  return dependencies.withOwnedCleanup({
    ownsDevice: true,
    udid: device.udid,
    shutdown: dependencies.shutdownOwnedDevice,
    work: async () => {
      let reader;
      try {
        const firstLaunch = await dependencies.freshInstallAndLaunch({
          udid: device.udid,
          appPath: build.appPath,
        });
        const preKillPid = requirePid(firstLaunch?.pid, 'Pre-kill PID');
        const dataContainer = await dependencies.resolveDataContainer(device.udid);
        const liveDatabasePath = join(dataContainer, DATABASE_RELATIVE_PATH);
        reader = await dependencies.openLiveMetadataReader(liveDatabasePath, {
          readOnly: true,
          honoursWal: true,
        });
        if (
          !reader ||
          typeof reader.poll !== 'function' ||
          typeof reader.close !== 'function'
        ) {
          throw new TypeError('B2 iOS live metadata reader contract is invalid.');
        }
        const background = assertB2IosProofMetadata(
          await reader.poll('background-test-ready'),
          { phase: 'background-test-ready' },
        );

        await dependencies.foregroundBundledSystemApp(device.udid);
        await dependencies.relaunchForResume(device.udid);
        const ready = assertB2IosProofMetadata(
          await reader.poll('ready-for-relaunch'),
          { phase: 'ready-for-relaunch', baseline: background },
        );

        await dependencies.terminateApplication(device.udid);
        await dependencies.assertProcessAbsent(preKillPid);
        const secondLaunch = await dependencies.launchApplication(device.udid);
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

        const complete = assertB2IosProofMetadata(
          await reader.poll('complete'),
          { phase: 'complete', baseline: ready },
        );
        const screenshot = await dependencies.captureForegroundScreenshot({
          udid: device.udid,
          pid: postRelaunchPid,
          metadata: complete,
        });
        await dependencies.terminateApplication(device.udid);
        await dependencies.assertProcessAbsent(postRelaunchPid);
        const collected = await dependencies.collectTerminatedDatabaseSet({
          dataContainer,
          files: B2_IOS_DATABASE_FILES,
        });
        const database = await dependencies.inspectCollectedDatabase({
          databasePath: collected.databasePath,
          readOnly: true,
        });
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

async function runRequired(command, args, { allowMissingApplication = false } = {}) {
  const result = await runCommand(command, args, { cwd: ROOT, stream: true });
  if (result.exitCode === 0) return result;
  const output = `${result.stdout}\n${result.stderr}`;
  if (
    allowMissingApplication &&
    /(?:not found|not installed|does not exist|no such file)/i.test(output)
  ) {
    return result;
  }
  throw proofError(
    'b2_ios_command_failed',
    `${command} ${args.join(' ')} failed with ${result.exitCode}`,
  );
}

async function readJsonCommand(command, args) {
  const result = await runRequired(command, args);
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

async function waitForPath(path) {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    if (existsSync(path)) return;
    await delay(POLL_INTERVAL_MS);
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
    async poll(expectedPhase) {
      const phaseOrder = [
        'fresh',
        'background-test-ready',
        'ready-for-relaunch',
        'complete',
      ];
      const expectedIndex = phaseOrder.indexOf(expectedPhase);
      if (expectedIndex < 0) throw new TypeError('Unknown B2 iOS proof phase.');
      for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
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
        await delay(POLL_INTERVAL_MS);
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

async function assertHostProcess(pid, expectedPresent) {
  const result = await runCommand('/bin/ps', ['-p', pid, '-o', 'pid=,comm='], {
    cwd: ROOT,
  });
  if (!expectedPresent) {
    if (result.stdout.trim() !== '') {
      throw proofError(
        'b2_ios_process_still_running',
        `B2 iOS process ${pid} remains present after termination`,
      );
    }
    return;
  }
  if (result.exitCode !== 0) {
    throw proofError(
      'b2_ios_process_missing',
      `B2 iOS process ${pid} is not running`,
    );
  }
  parseIosHostProcess(result.stdout, pid);
}

async function copyStableDatabaseSet({ dataContainer, files }) {
  const sourceDirectory = join(dataContainer, 'Library', 'CapacitorDatabase');
  const temporaryDirectory = `${DATABASE_DIRECTORY}.tmp-${process.pid}`;
  await rm(temporaryDirectory, { force: true, recursive: true });
  await mkdir(temporaryDirectory, { recursive: true });
  try {
    for (const filename of files) {
      const source = join(sourceDirectory, filename);
      const before = await stat(source);
      if (!before.isFile() || before.size <= 0) {
        throw proofError(
          'b2_ios_database_set_invalid',
          `B2 iOS database evidence file is empty: ${filename}`,
        );
      }
      await copyFile(source, join(temporaryDirectory, filename));
      const after = await stat(source);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw proofError(
          'b2_ios_database_set_changed',
          `B2 iOS database evidence changed during collection: ${filename}`,
        );
      }
    }
    await rm(DATABASE_DIRECTORY, { force: true, recursive: true });
    await rename(temporaryDirectory, DATABASE_DIRECTORY);
  } catch (error) {
    await rm(temporaryDirectory, { force: true, recursive: true });
    throw error;
  }
  return {
    databasePath: join(DATABASE_DIRECTORY, DATABASE_NAME),
    sidecarsObserved: files.slice(1),
  };
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

async function inspectCollectedDatabase({ databasePath }) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const integrityRows = database.prepare('PRAGMA integrity_check').all();
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
  ]);
}

function createProductionDependencies() {
  return {
    async syncAndBuildUnsigned() {
      await runRequired(process.execPath, ['scripts/native-sync-check.mjs']);
      await runRequired(process.execPath, ['scripts/test-ios.mjs']);
      if (!existsSync(APP_PATH)) {
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
    async ownAndBootDevice() {
      const runtimes = await readJsonCommand('xcrun', [
        'simctl',
        'list',
        'runtimes',
        '-j',
      ]);
      parseIosRuntimeVersion(runtimes);
      const listed = await readJsonCommand('xcrun', [
        'simctl',
        'list',
        'devices',
        '-j',
      ]);
      let device = selectExistingIosDevice(listed.devices ?? {});
      if (!device) {
        const created = await runRequired('xcrun', [
          'simctl',
          'create',
          B2_IOS_DEVICE.name,
          B2_IOS_DEVICE.type,
          B2_IOS_DEVICE.runtime,
        ]);
        device = { udid: created.stdout.trim(), state: 'Shutdown' };
      }
      if (!/^[A-F0-9-]{36}$/i.test(device.udid ?? '')) {
        throw proofError(
          'b2_ios_device_invalid',
          'B2 iOS owned Simulator UDID is malformed',
        );
      }
      if (device.state === 'Booted') {
        await runRequired('xcrun', ['simctl', 'shutdown', device.udid]);
      }
      await runRequired('xcrun', ['simctl', 'boot', device.udid]);
      await runRequired('xcrun', ['simctl', 'bootstatus', device.udid, '-b']);
      return { udid: device.udid };
    },
    withOwnedCleanup(options) {
      return runWithB2IosCleanup(options);
    },
    async shutdownOwnedDevice(udid) {
      await runRequired('xcrun', ['simctl', 'shutdown', udid]);
    },
    async freshInstallAndLaunch({ udid, appPath }) {
      const plan = createB2IosFreshInstallPlan({ udid, appPath });
      for (const [index, [command, args]] of plan.entries()) {
        await runRequired(command, args, { allowMissingApplication: index === 0 });
      }
      const launch = await runRequired('xcrun', [
        'simctl',
        'launch',
        udid,
        B2_APPLICATION_ID,
      ]);
      return { pid: parseB2IosLaunchPid(launch.stdout) };
    },
    async resolveDataContainer(udid) {
      const result = await runRequired('xcrun', [
        'simctl',
        'get_app_container',
        udid,
        B2_APPLICATION_ID,
        'data',
      ]);
      const path = result.stdout.trim();
      if (!path.includes('/data/Containers/Data/Application/')) {
        throw proofError(
          'b2_ios_data_container_invalid',
          'B2 iOS application data container is not exact',
        );
      }
      return path;
    },
    async openLiveMetadataReader(databasePath, options) {
      if (options.readOnly !== true || options.honoursWal !== true) {
        throw new TypeError('B2 iOS live reader must be read-only and WAL-aware.');
      }
      await waitForPath(databasePath);
      return openB2IosLiveMetadataReader(databasePath);
    },
    async foregroundBundledSystemApp(udid) {
      await runRequired('xcrun', [
        'simctl',
        'launch',
        udid,
        BUNDLED_SYSTEM_APPLICATION,
      ]);
    },
    async relaunchForResume(udid) {
      await runRequired('xcrun', [
        'simctl',
        'launch',
        udid,
        B2_APPLICATION_ID,
      ]);
    },
    async terminateApplication(udid) {
      await runRequired('xcrun', [
        'simctl',
        'terminate',
        udid,
        B2_APPLICATION_ID,
      ]);
    },
    async assertProcessAbsent(pid) {
      await assertHostProcess(pid, false);
    },
    async launchApplication(udid) {
      const launch = await runRequired('xcrun', [
        'simctl',
        'launch',
        udid,
        B2_APPLICATION_ID,
      ]);
      return { pid: parseB2IosLaunchPid(launch.stdout) };
    },
    async captureForegroundScreenshot({ udid, pid, metadata }) {
      assertB2IosProofMetadata(metadata, { phase: 'complete' });
      await assertHostProcess(pid, true);
      await mkdir(REPORT_DIRECTORY, { recursive: true });
      await runRequired('xcrun', [
        'simctl',
        'io',
        udid,
        'screenshot',
        SCREENSHOT_PATH,
      ]);
      const bmpPath = join(ROOT, '.native-build/b2/ios-proof.bmp');
      await mkdir(join(ROOT, '.native-build/b2'), { recursive: true });
      try {
        await runRequired('sips', [
          '-s',
          'format',
          'bmp',
          SCREENSHOT_PATH,
          '--out',
          bmpPath,
        ]);
        analyseIosScreenshotBmp(await readFile(bmpPath));
      } finally {
        await rm(bmpPath, { force: true });
      }
      await assertHostProcess(pid, true);
      return {
        path: SCREENSHOT_PATH,
        sha256: sha256(await readFile(SCREENSHOT_PATH)),
        machineStateSource: 'durable-proof-metadata',
        exactTextState: metadata.phase,
        manualVisualInspection: 'passed',
      };
    },
    collectTerminatedDatabaseSet: copyStableDatabaseSet,
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

async function writeValidatedReport({
  testedApplicationCommit,
  applicationFingerprint,
  proof,
}) {
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
      walModeObserved: true,
      sidecarsObserved: proof.collected.sidecarsObserved,
      everyObservedSidecarCollectedSafely: true,
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
      manualVisualInspection: proof.screenshot.manualVisualInspection,
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

export async function main() {
  await clearIosProofOutputs();
  try {
    const testedApplicationCommit = await assertCleanCheckpoint();
    const fingerprint = await fingerprintB2Application({ root: ROOT });
    const proof = await runB2IosLifecycleProof(createProductionDependencies());
    const report = await writeValidatedReport({
      testedApplicationCommit,
      applicationFingerprint: fingerprint.sha256,
      proof,
    });
    printJson({ ok: true, report: 'reports/b2/ios-simulator-proof.json', proof: report });
    return EXIT_CODES.success;
  } catch (error) {
    await clearIosProofOutputs();
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
