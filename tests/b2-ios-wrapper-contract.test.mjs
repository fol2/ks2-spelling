import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  B2_IOS_DATABASE_FILES,
  assertB2ApplicationStatusClean,
  assertB2IosProofMetadata,
  collectB2IosDatabaseSet,
  createB2IosProductionDependencies,
  inspectB2IosHashBoundDatabaseSet,
  openB2IosLiveMetadataReader,
  parseB2IosLaunchPid,
  parseB2IosProcessProbe,
  pollB2IosProcess,
  runB2IosSubprocess,
  runB2IosLifecycleProof,
  runWithB2IosOwnedCleanup,
  validateB2IosManualAttestation,
  validateB2IosPendingProof,
  writeValidatedReport,
} from '../scripts/prove-b2-ios.mjs';
import { canonicalJson } from '../src/platform/database/canonical-json.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const SESSION_ID = 'session-known-from-durable-metadata';
const IOS_UDID = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';

const TEST_FS = Object.freeze({
  copyFile,
  existsSync: () => true,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
});

function metadata(phase) {
  const complete = phase === 'complete';
  return {
    schemaVersion: 1,
    phase,
    commandIndex: complete ? 6 : 4,
    activeLearnerId: 'learner-a',
    expectedSessionId: complete ? null : SESSION_ID,
    learnerARevision: complete ? 6 : 4,
    learnerBDigest: DIGEST_B,
    preRelaunchDigest: DIGEST_A,
    migrationRollback: 'verified',
    atomicFailureCheckpoints: complete
      ? [
          'after-subject-state',
          'after-practice-session',
          'after-events',
          'after-monster-state',
          'after-camp-state',
          'after-revision',
          'before-commit',
        ]
      : [],
    lifecycleEvents:
      phase === 'background-test-ready' ? [] : ['pause', 'resume'],
    updatedAt: 1_768_478_400_000,
  };
}

function createDependencies({ failAt = null } = {}) {
  const events = [];
  let phaseIndex = 0;
  const phases = [
    metadata('background-test-ready'),
    metadata('ready-for-relaunch'),
    metadata('complete'),
  ];
  const step = async (name, value) => {
    events.push(name);
    if (failAt === name) throw new Error(`failure at ${name}`);
    return value;
  };
  return {
    events,
    dependencies: {
      async syncAndBuildUnsigned() {
        return step('sync-build-unsigned', {
          appPath: '/build/App.app',
          compiled: true,
          configuration: 'Debug',
          sdk: 'iphonesimulator',
          signed: false,
        });
      },
      async acquireOwnedDevice() {
        return step('acquire-owned', {
          udid: IOS_UDID,
          state: 'Shutdown',
        });
      },
      async bootOwnedDevice() {
        return step('boot-owned');
      },
      async withOwnedCleanup({ ownsDevice, udid, work, shutdown }) {
        assert.equal(ownsDevice, false);
        assert.equal(udid, null);
        return runWithB2IosOwnedCleanup({
          ownsDevice,
          udid,
          work,
          shutdown,
          signalSource: new EventEmitter(),
        });
      },
      async shutdownOwnedDevice(udid) {
        assert.equal(udid, IOS_UDID);
        return step('shutdown-owned');
      },
      async freshInstallAndLaunch({ udid, appPath }) {
        assert.equal(udid, IOS_UDID);
        assert.equal(appPath, '/build/App.app');
        return step('uninstall-install-launch', { pid: '101' });
      },
      async resolveDataContainer(udid) {
        assert.equal(udid, IOS_UDID);
        return step('resolve-data-container', '/data/container');
      },
      async openLiveMetadataReader(databasePath, options) {
        assert.equal(
          databasePath,
          '/data/container/Library/CapacitorDatabase/ks2-spellingSQLite.db',
        );
        assert.deepEqual(options, { readOnly: true, honoursWal: true });
        await step('open-host-read-only-wal');
        return {
          async poll(expectedPhase) {
            assert.equal(phases[phaseIndex].phase, expectedPhase);
            const value = phases[phaseIndex];
            phaseIndex += 1;
            return step(`poll-${expectedPhase}`, value);
          },
          async close() {
            return step('close-host-read-only-wal');
          },
        };
      },
      async foregroundBundledSystemApp() {
        return step('foreground-bundled-system-app');
      },
      async relaunchForResume() {
        return step('relaunch-for-resume');
      },
      async terminateApplication() {
        return step('terminate-application');
      },
      async assertProcessPresent(pid) {
        assert.ok(['101', '202'].includes(pid));
        return step(`prove-pid-${pid}-present`);
      },
      async assertProcessAbsent(pid) {
        assert.ok(['101', '202'].includes(pid));
        return step(
          pid === '101'
            ? 'prove-old-pid-absent'
            : 'prove-new-pid-absent-before-copy',
        );
      },
      async launchApplication() {
        return step('launch-new-process', { pid: '202' });
      },
      async captureForegroundScreenshot({ pid, metadata: durable }) {
        assert.equal(pid, '202');
        assert.equal(durable.phase, 'complete');
        return step('capture-screenshot-while-foreground', {
          path: '/reports/ios.png',
          sha256: 'c'.repeat(64),
          machineStateSource: 'durable-proof-metadata',
          exactTextState: 'complete',
          manualVisualInspection: 'pending',
        });
      },
      async collectTerminatedDatabaseSet() {
        return step('copy-db-wal-shm-after-termination', {
          databasePath: '/evidence/ks2-spellingSQLite.db',
          sidecarsObserved: B2_IOS_DATABASE_FILES.slice(1),
          observedFiles: [...B2_IOS_DATABASE_FILES],
          everyObservedSidecarCollectedSafely: true,
          fileSha256: Object.fromEntries(
            B2_IOS_DATABASE_FILES.map((name, index) => [
              name,
              (index === 0 ? 'f' : 'e').repeat(64),
            ]),
          ),
        });
      },
      async inspectCollectedDatabase({
        databasePath,
        observedFiles,
        fileSha256,
        readOnly,
      }) {
        assert.equal(databasePath, '/evidence/ks2-spellingSQLite.db');
        assert.deepEqual(observedFiles, [...B2_IOS_DATABASE_FILES]);
        assert.deepEqual(Object.keys(fileSha256), [...B2_IOS_DATABASE_FILES]);
        assert.equal(readOnly, true);
        return step('inspect-collected-db-read-only', {
          foreignKeys: 1,
          journalMode: 'wal',
          synchronous: 2,
          busyTimeout: 5000,
          integrityCheck: 'ok',
          databaseSha256: 'f'.repeat(64),
          finalLogicalSnapshotSha256: '0'.repeat(64),
          starterCampRows: 0,
          monsterState: 'spelling-derived-child-owned',
        });
      },
    },
  };
}

test('iOS proof wrapper is exposed through the exact deterministic command', async () => {
  const packageJson = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['prove:b2:ios'], 'node scripts/prove-b2-ios.mjs');
  assert.deepEqual(B2_IOS_DATABASE_FILES, [
    'ks2-spellingSQLite.db',
    'ks2-spellingSQLite.db-wal',
    'ks2-spellingSQLite.db-shm',
  ]);
});

test('production adapter consumes the frozen B1 ownership and read-only authorities', async () => {
  const source = await readFile(join(ROOT, 'scripts/prove-b2-ios.mjs'), 'utf8');
  for (const authority of [
    'B2_IOS_DEVICE',
    'selectExistingIosDevice',
    'parseIosRuntimeVersion',
    'createB2IosFreshInstallPlan',
    'runWithB2IosCleanup',
    "BUNDLED_SYSTEM_APPLICATION = 'com.apple.Preferences'",
    "new DatabaseSync(databasePath, { readOnly: true })",
    "'Library',\n  'CapacitorDatabase'",
  ]) assert.match(source, new RegExp(authority.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(source, /\bsimctl\s*(?:erase|delete)\b|\biCloud\b/);
  assert.doesNotMatch(source, /CODE_SIGNING_ALLOWED=(?!NO)/);
  assert.doesNotMatch(source, /manualVisualInspection:\s*'passed'/);
});

test('checkpoint cleanliness permits evidence outputs but rejects application drift', () => {
  assert.equal(
    assertB2ApplicationStatusClean(
      '?? reports/b2/ios-simulator-proof.json\n?? reports/b2/ios-simulator-proof.png\n',
    ),
    true,
  );
  assert.throws(
    () => assertB2ApplicationStatusClean(' M src/main.jsx\n'),
    ({ code }) => code === 'b2_ios_checkpoint_dirty',
  );
  assert.throws(
    () => assertB2ApplicationStatusClean('?? scripts/prove-b2-android.mjs\n'),
    ({ code }) => code === 'b2_ios_checkpoint_dirty',
  );
});

test('strict launch PID and durable phase contracts fail closed', () => {
  assert.equal(parseB2IosLaunchPid('uk.eugnel.ks2spelling: 123\n'), '123');
  for (const output of ['123', 'other.bundle: 123', 'uk.eugnel.ks2spelling: 0']) {
    assert.throws(() => parseB2IosLaunchPid(output), /launch PID/i);
  }

  const background = metadata('background-test-ready');
  assert.deepEqual(
    assertB2IosProofMetadata(background, {
      phase: 'background-test-ready',
    }),
    background,
  );
  const stale = structuredClone(metadata('ready-for-relaunch'));
  stale.learnerBDigest = 'd'.repeat(64);
  assert.throws(
    () =>
      assertB2IosProofMetadata(stale, {
        phase: 'ready-for-relaunch',
        baseline: background,
      }),
    /learner-B digest/i,
  );
  const wrongSession = structuredClone(metadata('ready-for-relaunch'));
  wrongSession.expectedSessionId = 'different-session';
  assert.throws(
    () =>
      assertB2IosProofMetadata(wrongSession, {
        phase: 'ready-for-relaunch',
        baseline: background,
      }),
    /session/i,
  );
});

test('process probes reject runner errors and bounded polling handles transient presence', async () => {
  const present = {
    exitCode: 0,
    signal: null,
    stdout: '123 /tmp/App.app/App\n',
    stdoutBytes: Buffer.from('123 /tmp/App.app/App\n'),
    stderr: '',
    stderrBytes: Buffer.alloc(0),
    spawnError: null,
    timedOut: false,
    interruptedSignal: null,
  };
  const absent = {
    ...present,
    exitCode: 1,
    stdout: '',
    stdoutBytes: Buffer.alloc(0),
  };
  assert.equal(parseB2IosProcessProbe(present, '123'), 'present');
  assert.equal(
    parseB2IosProcessProbe(
      {
        ...present,
        stdout: 'token=[REDACTED]\n',
        stdoutBytes: Buffer.from('123 /tmp/App.app/App\n'),
      },
      '123',
    ),
    'present',
  );
  assert.throws(
    () =>
      parseB2IosProcessProbe(
        {
          ...present,
          stdoutBytes: Uint8Array.from([0xc3, 0x28]),
        },
        '123',
      ),
    ({ code }) => code === 'b2_ios_machine_output_invalid',
  );
  assert.equal(parseB2IosProcessProbe(absent, '123'), 'absent');
  for (const invalid of [
    { ...absent, exitCode: 2 },
    { ...absent, spawnError: new Error('spawn failed') },
    { ...absent, timedOut: true },
    { ...absent, signal: 'SIGKILL' },
  ]) {
    assert.throws(
      () => parseB2IosProcessProbe(invalid, '123'),
      ({ code }) => code === 'b2_ios_process_probe_failed',
    );
  }

  const results = [present, present, absent];
  const sleeps = [];
  assert.equal(
    await pollB2IosProcess({
      pid: '123',
      expected: 'absent',
      attempts: 3,
      intervalMs: 7,
      run: async () => results.shift(),
      sleep: async (milliseconds) => sleeps.push(milliseconds),
    }),
    'absent',
  );
  assert.deepEqual(sleeps, [7, 7]);
  await assert.rejects(
    pollB2IosProcess({
      pid: '123',
      expected: 'absent',
      attempts: 2,
      run: async () => present,
      sleep: async () => undefined,
    }),
    ({ code }) => code === 'b2_ios_process_still_running',
  );
});

test('every subprocess has a bounded process-group timeout', async () => {
  const result = await runB2IosSubprocess(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { timeoutMs: 30 },
  );
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.ok(['SIGTERM', 'SIGKILL'].includes(result.signal));
});

test('AbortSignal terminates the current subprocess before its timeout', async () => {
  const controller = new AbortController();
  const running = runB2IosSubprocess(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { timeoutMs: 2_000, signal: controller.signal },
  );
  setTimeout(() => controller.abort(new Error('test abort')), 20);
  const result = await running;
  assert.equal(result.aborted, true);
  assert.equal(result.abortReason.message, 'test abort');
  assert.equal(result.timedOut, false);
});

test('manual visual attestation is explicit and bound to the exact screenshot SHA', () => {
  const screenshotSha256 = 'c'.repeat(64);
  const attestation = {
    schemaVersion: 1,
    platform: 'ios-simulator',
    screenshotSha256,
    manualVisualInspection: 'passed',
  };
  assert.deepEqual(
    validateB2IosManualAttestation(attestation, screenshotSha256),
    attestation,
  );
  assert.throws(
    () => validateB2IosManualAttestation(undefined, screenshotSha256),
    ({ code }) => code === 'b2_ios_manual_attestation_invalid',
  );
  assert.throws(
    () =>
      validateB2IosManualAttestation(
        { ...attestation, screenshotSha256: 'd'.repeat(64) },
        screenshotSha256,
      ),
    ({ code }) => code === 'b2_ios_manual_attestation_invalid',
  );
});

test('pending proof validation rejects nested unknown keys and local payload tampering', async () => {
  const { dependencies } = createDependencies();
  const proof = await runB2IosLifecycleProof(dependencies);
  const screenshotBytes = Buffer.from('pending proof screenshot');
  proof.screenshot.sha256 = createHash('sha256')
    .update(screenshotBytes)
    .digest('hex');
  const pending = {
    schemaVersion: 1,
    testedApplicationCommit: '1'.repeat(40),
    applicationFingerprint: '2'.repeat(64),
    proof,
  };
  assert.deepEqual(
    validateB2IosPendingProof(pending, {
      expectedCommit: pending.testedApplicationCommit,
      expectedFingerprint: pending.applicationFingerprint,
      screenshotBytes,
    }),
    pending,
  );
  for (const mutate of [
    (value) => { value.proof.screenshot.unknown = true; },
    (value) => { value.proof.screenshot.manualVisualInspection = 'passed'; },
    (value) => { value.proof.lifecycle.postRelaunchPid = value.proof.lifecycle.preKillPid; },
    (value) => { value.proof.collected.observedFiles = ['ks2-spellingSQLite.db-wal']; },
    (value) => { value.proof.metadata.learnerBDigest = '9'.repeat(64); },
    (value) => { value.proof.database.databaseSha256 = '8'.repeat(64); },
    (value) => { value.applicationFingerprint = '3'.repeat(64); },
  ]) {
    const changed = structuredClone(pending);
    mutate(changed);
    assert.throws(
      () =>
        validateB2IosPendingProof(changed, {
          expectedCommit: pending.testedApplicationCommit,
          expectedFingerprint: pending.applicationFingerprint,
          screenshotBytes,
        }),
      ({ code }) => code === 'b2_ios_pending_proof_invalid',
    );
  }
});

test('final report fails before any self-attested manual visual claim', async () => {
  await assert.rejects(
    writeValidatedReport({
      testedApplicationCommit: '1'.repeat(40),
      applicationFingerprint: '2'.repeat(64),
      proof: { screenshot: { sha256: 'c'.repeat(64) } },
      manualAttestation: undefined,
    }),
    ({ code }) => code === 'b2_ios_manual_attestation_invalid',
  );
});

test('production host reader is read-only and observes committed WAL updates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'b2-ios-live-reader-'));
  const databasePath = join(directory, 'ks2-spellingSQLite.db');
  const writer = new DatabaseSync(databasePath);
  let reader;
  try {
    writer.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE app_metadata (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;
    `);
    const write = writer.prepare(
      'INSERT OR REPLACE INTO app_metadata (key, value_json, updated_at) VALUES (?, ?, ?)',
    );
    const background = metadata('background-test-ready');
    write.run('b2-proof', canonicalJson(background), background.updatedAt);
    reader = openB2IosLiveMetadataReader(databasePath);
    assert.deepEqual(await reader.poll('background-test-ready'), background);

    const ready = metadata('ready-for-relaunch');
    write.run('b2-proof', canonicalJson(ready), ready.updatedAt);
    assert.deepEqual(await reader.poll('ready-for-relaunch'), ready);
    assert.deepEqual(Object.keys(reader).toSorted(), ['close', 'poll']);
  } finally {
    if (reader) await reader.close();
    writer.close();
    await rm(directory, { force: true, recursive: true });
  }
});

async function createDatabaseFiles(directory, filenames) {
  await mkdir(directory, { recursive: true });
  for (const filename of filenames) {
    await writeFile(join(directory, filename), Buffer.from(`bytes:${filename}`));
  }
}

test('database collection permits optional known sidecars and derives complete coverage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'b2-ios-db-set-'));
  try {
    for (const filenames of [
      ['ks2-spellingSQLite.db'],
      [...B2_IOS_DATABASE_FILES],
    ]) {
      const source = join(directory, `source-${filenames.length}`);
      const destination = join(directory, `destination-${filenames.length}`);
      await createDatabaseFiles(source, filenames);
      const collected = await collectB2IosDatabaseSet({
        sourceDirectory: source,
        destinationDirectory: destination,
        fs: TEST_FS,
      });
      assert.deepEqual(collected.observedFiles, filenames);
      assert.deepEqual(collected.sidecarsObserved, filenames.slice(1));
      assert.equal(collected.everyObservedSidecarCollectedSafely, true);
      assert.deepEqual(Object.keys(collected.fileSha256), filenames);
      for (const filename of filenames) {
        assert.deepEqual(
          await readFile(join(destination, filename)),
          await readFile(join(source, filename)),
        );
      }
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('database collection rejects unknown, changed and disappeared sidecars', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'b2-ios-db-failure-'));
  try {
    const unknown = join(directory, 'unknown');
    await createDatabaseFiles(unknown, [
      'ks2-spellingSQLite.db',
      'ks2-spellingSQLite.db-journal',
    ]);
    await assert.rejects(
      collectB2IosDatabaseSet({
        sourceDirectory: unknown,
        destinationDirectory: join(directory, 'unknown-copy'),
        fs: TEST_FS,
      }),
      ({ code }) => code === 'b2_ios_database_sidecar_unknown',
    );

    const changed = join(directory, 'changed');
    await createDatabaseFiles(changed, [...B2_IOS_DATABASE_FILES]);
    let changedOnce = false;
    await assert.rejects(
      collectB2IosDatabaseSet({
        sourceDirectory: changed,
        destinationDirectory: join(directory, 'changed-copy'),
        fs: {
          ...TEST_FS,
          async copyFile(source, destination) {
            await copyFile(source, destination);
            if (!changedOnce && source.endsWith('-wal')) {
              changedOnce = true;
              await writeFile(source, Buffer.from('changed WAL bytes'));
            }
          },
        },
      }),
      ({ code }) => code === 'b2_ios_database_set_changed',
    );

    const disappeared = join(directory, 'disappeared');
    await createDatabaseFiles(disappeared, [...B2_IOS_DATABASE_FILES]);
    const entries = await readdir(disappeared, { withFileTypes: true });
    let statCalls = 0;
    await assert.rejects(
      collectB2IosDatabaseSet({
        sourceDirectory: disappeared,
        destinationDirectory: join(directory, 'disappeared-copy'),
        fs: {
          ...TEST_FS,
          async readdir() {
            return entries;
          },
          async stat(path) {
            statCalls += 1;
            if (statCalls > B2_IOS_DATABASE_FILES.length && path.endsWith('-shm')) {
              const error = new Error('gone');
              error.code = 'ENOENT';
              throw error;
            }
            return stat(path);
          },
        },
      }),
      ({ code }) => code === 'b2_ios_database_set_disappeared',
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('hash-bound iOS verification mutates only scratch SHM across capture and finalise checks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'b2-ios-isolated-evidence-'));
  const collected = join(directory, 'collected');
  const scratchRoot = join(directory, 'scratch');
  await createDatabaseFiles(collected, [...B2_IOS_DATABASE_FILES]);
  const original = Object.fromEntries(
    await Promise.all(B2_IOS_DATABASE_FILES.map(async (name) => [
      name,
      await readFile(join(collected, name)),
    ])),
  );
  const fileSha256 = Object.fromEntries(
    Object.entries(original).map(([name, bytes]) => [
      name,
      createHash('sha256').update(bytes).digest('hex'),
    ]),
  );
  let mutationCount = 0;
  const inspectDatabase = async (scratchDatabasePath) => {
    const scratchShm = `${scratchDatabasePath}-shm`;
    await writeFile(scratchShm, Buffer.from(`reader-mutated-shm-${mutationCount}`));
    mutationCount += 1;
    return { mutationCount };
  };
  try {
    for (const stage of ['capture', 'finalise']) {
      assert.deepEqual(
        await inspectB2IosHashBoundDatabaseSet(
          {
            databasePath: join(collected, B2_IOS_DATABASE_FILES[0]),
            observedFiles: [...B2_IOS_DATABASE_FILES],
            fileSha256,
          },
          { scratchRoot, inspectDatabase },
        ),
        { mutationCount: stage === 'capture' ? 1 : 2 },
      );
      for (const name of B2_IOS_DATABASE_FILES) {
        assert.deepEqual(await readFile(join(collected, name)), original[name]);
      }
      assert.deepEqual(await readdir(scratchRoot), []);
    }
    assert.equal(mutationCount, 2, 'the fake reader must really mutate both scratch sets');
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('iOS proof orders lifecycle, PID replacement, UI capture and WAL-safe collection', async () => {
  const { dependencies, events } = createDependencies();
  const result = await runB2IosLifecycleProof(dependencies);
  assert.equal(result.lifecycle.preKillPid, '101');
  assert.equal(result.lifecycle.postRelaunchPid, '202');
  assert.equal(result.metadata.phase, 'complete');
  assert.deepEqual(events, [
    'sync-build-unsigned',
    'acquire-owned',
    'boot-owned',
    'uninstall-install-launch',
    'resolve-data-container',
    'open-host-read-only-wal',
    'poll-background-test-ready',
    'foreground-bundled-system-app',
    'relaunch-for-resume',
    'poll-ready-for-relaunch',
    'prove-pid-101-present',
    'terminate-application',
    'prove-old-pid-absent',
    'launch-new-process',
    'prove-pid-202-present',
    'poll-complete',
    'capture-screenshot-while-foreground',
    'terminate-application',
    'prove-new-pid-absent-before-copy',
    'copy-db-wal-shm-after-termination',
    'inspect-collected-db-read-only',
    'close-host-read-only-wal',
    'shutdown-owned',
  ]);
});

test('failure still closes the read-only view and shuts down only the owned simulator', async () => {
  const { dependencies, events } = createDependencies({
    failAt: 'capture-screenshot-while-foreground',
  });
  await assert.rejects(runB2IosLifecycleProof(dependencies), /failure at capture/);
  assert.ok(events.includes('close-host-read-only-wal'));
  assert.equal(events.at(-1), 'shutdown-owned');
  assert.equal(events.filter((entry) => entry === 'shutdown-owned').length, 1);
  assert.equal(events.includes('copy-db-wal-shm-after-termination'), false);
});

test('relaunch must produce a distinct live PID before proof can continue', async () => {
  const { dependencies, events } = createDependencies();
  dependencies.launchApplication = async () => {
    events.push('launch-reused-process');
    return { pid: '101' };
  };
  await assert.rejects(
    runB2IosLifecycleProof(dependencies),
    ({ code }) => code === 'b2_ios_pid_unchanged',
  );
  assert.equal(events.at(-1), 'shutdown-owned');
  assert.equal(events.includes('capture-screenshot-while-foreground'), false);
});

test('boot failure is already inside cleanup and primary plus cleanup failures aggregate', async () => {
  const bootFailure = createDependencies({ failAt: 'boot-owned' });
  await assert.rejects(
    runB2IosLifecycleProof(bootFailure.dependencies),
    /failure at boot-owned/,
  );
  assert.equal(bootFailure.events.at(-1), 'shutdown-owned');

  const primary = Object.assign(new Error('primary failure'), { code: 'primary_code' });
  await assert.rejects(
    runWithB2IosOwnedCleanup({
      ownsDevice: true,
      udid: IOS_UDID,
      work: async () => { throw primary; },
      shutdown: async () => { throw new Error('cleanup failure'); },
      signalSource: new EventEmitter(),
    }),
    (error) =>
      error instanceof AggregateError &&
      error.code === 'primary_code' &&
      error.cause === primary &&
      error.errors.length === 2,
  );
});

test('signal waits for blocked work to unwind before one owned cleanup and prevents later mutation', async () => {
  const signalSource = new EventEmitter();
  const events = [];
  let releaseWork;
  let observeAbort;
  let markWorkStarted;
  const workReleased = new Promise((resolveRelease) => {
    releaseWork = resolveRelease;
  });
  const abortObserved = new Promise((resolveAbort) => {
    observeAbort = resolveAbort;
  });
  const workStarted = new Promise((resolveStarted) => {
    markWorkStarted = resolveStarted;
  });
  const interrupted = runWithB2IosOwnedCleanup({
    ownsDevice: true,
    udid: IOS_UDID,
    work: async ({ signal }) => {
      events.push('work-started');
      markWorkStarted();
      signal.addEventListener('abort', () => {
        events.push('abort-observed');
        observeAbort();
      }, { once: true });
      await workReleased;
      events.push('work-unwound');
      signal.throwIfAborted();
      events.push('forbidden-mutation');
    },
    shutdown: async (udid) => events.push(`shutdown:${udid}`),
    signalSource,
  });
  await workStarted;
  signalSource.emit('SIGTERM');
  await abortObserved;
  let settled = false;
  interrupted.catch(() => { settled = true; });
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  assert.equal(settled, false);
  assert.equal(events.some((event) => event.startsWith('shutdown:')), false);
  releaseWork();
  await assert.rejects(
    interrupted,
    ({ code }) => code === 'b2_ios_signal_interrupted',
  );
  assert.deepEqual(events, [
    'work-started',
    'abort-observed',
    'work-unwound',
    `shutdown:${IOS_UDID}`,
  ]);
  assert.equal(events.includes('forbidden-mutation'), false);
});

test('cleanup never shuts down a non-owned device', async () => {
  await runWithB2IosOwnedCleanup({
    ownsDevice: false,
    udid: 'foreign-udid',
    work: async () => 'done',
    shutdown: async () => assert.fail('must not shut down a non-owned device'),
    signalSource: new EventEmitter(),
  });
});

test('signal remains the primary cause when owned cleanup also fails', async () => {
  const signalSource = new EventEmitter();
  let started;
  const workStarted = new Promise((resolveStarted) => { started = resolveStarted; });
  const interrupted = runWithB2IosOwnedCleanup({
    ownsDevice: true,
    udid: IOS_UDID,
    work: async ({ signal }) => {
      started();
      await new Promise((resolveAbort) => {
        signal.addEventListener('abort', resolveAbort, { once: true });
      });
      signal.throwIfAborted();
    },
    shutdown: async () => { throw new Error('cleanup failed'); },
    signalSource,
  });
  await workStarted;
  signalSource.emit('SIGINT');
  await assert.rejects(
    interrupted,
    (error) =>
      error instanceof AggregateError &&
      error.code === 'b2_ios_signal_interrupted' &&
      error.cause?.code === 'b2_ios_signal_interrupted' &&
      error.errors[1].message === 'cleanup failed',
  );
});

function successfulCommand(stdout = '') {
  return {
    exitCode: 0,
    signal: null,
    stdout,
    stdoutBytes: Buffer.from(stdout),
    stderr: '',
    stderrBytes: Buffer.alloc(0),
    spawnError: null,
    timedOut: false,
    interruptedSignal: null,
  };
}

test('production iOS JSON uses raw bytes despite redacted text and rejects invalid UTF-8', async () => {
  const runtime = JSON.stringify({
    runtimes: [
      {
        identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
        isAvailable: true,
        version: '26.5',
        token: 'machine-value',
      },
    ],
  });
  const devices = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
        {
          name: 'KS2 Spelling iPhone 17',
          udid: IOS_UDID,
          state: 'Shutdown',
          deviceTypeIdentifier:
            'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
        },
      ],
    },
  });
  const rawCommand = (raw) => ({
    ...successfulCommand('{"token":[REDACTED]}'),
    stdoutBytes: Buffer.from(raw),
  });
  const dependencies = createB2IosProductionDependencies({
    fs: TEST_FS,
    run: async (_command, args) =>
      rawCommand(args.includes('runtimes') ? runtime : devices),
  });
  assert.deepEqual(await dependencies.acquireOwnedDevice(), {
    udid: IOS_UDID,
    state: 'Shutdown',
  });

  const invalid = createB2IosProductionDependencies({
    fs: TEST_FS,
    run: async () => ({
      ...successfulCommand('{"runtimes":[]}'),
      stdoutBytes: Uint8Array.from([0xc3, 0x28]),
    }),
  });
  await assert.rejects(
    invalid.acquireOwnedDevice(),
    ({ code }) => code === 'b2_ios_machine_output_invalid',
  );
});

test('production adapter executes exact owned-device commands through the injected runner', async () => {
  const commands = [];
  const runtime = {
    runtimes: [
      {
        identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
        isAvailable: true,
        version: '26.5',
      },
    ],
  };
  const devices = {
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
        {
          name: 'KS2 Spelling iPhone 17',
          udid: IOS_UDID,
          state: 'Shutdown',
          deviceTypeIdentifier:
            'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
        },
      ],
    },
  };
  let launchCount = 0;
  const run = async (command, args, options) => {
    commands.push([command, args, options.timeoutMs]);
    const serialised = args.join(' ');
    if (serialised === 'simctl list runtimes -j') {
      return successfulCommand(JSON.stringify(runtime));
    }
    if (serialised === 'simctl list devices -j') {
      return successfulCommand(JSON.stringify(devices));
    }
    if (serialised.includes('simctl launch') && serialised.includes('uk.eugnel')) {
      launchCount += 1;
      return successfulCommand(`uk.eugnel.ks2spelling: ${100 + launchCount}\n`);
    }
    if (command === '/bin/ps') {
      return successfulCommand(`${args[1]} /tmp/App.app/App\n`);
    }
    return successfulCommand();
  };
  const dependencies = createB2IosProductionDependencies({
    run,
    fs: TEST_FS,
    sleep: async () => undefined,
    signalSource: new EventEmitter(),
  });
  const build = await dependencies.syncAndBuildUnsigned();
  const device = await dependencies.acquireOwnedDevice();
  await dependencies.bootOwnedDevice(device);
  const first = await dependencies.freshInstallAndLaunch({
    udid: device.udid,
    appPath: build.appPath,
  });
  await dependencies.assertProcessPresent(first.pid);
  await dependencies.terminateApplication(device.udid);
  await dependencies.launchApplication(device.udid);

  assert.deepEqual(
    commands.slice(2, 9).map(([, args]) => args),
    [
      ['simctl', 'list', 'runtimes', '-j'],
      ['simctl', 'list', 'devices', '-j'],
      ['simctl', 'boot', IOS_UDID],
      ['simctl', 'bootstatus', IOS_UDID, '-b'],
      ['simctl', 'uninstall', IOS_UDID, 'uk.eugnel.ks2spelling'],
      ['simctl', 'install', IOS_UDID, build.appPath],
      ['simctl', 'launch', IOS_UDID, 'uk.eugnel.ks2spelling'],
    ],
  );
  assert.ok(commands.every(([, , timeoutMs]) => Number.isInteger(timeoutMs)));
});

test('production ownership rejects a same-name collision without boot or cleanup mutation', async () => {
  const commands = [];
  const run = async (command, args) => {
    commands.push([command, args]);
    if (args.includes('runtimes')) {
      return successfulCommand(
        JSON.stringify({
          runtimes: [
            {
              identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
              isAvailable: true,
              version: '26.5',
            },
          ],
        }),
      );
    }
    return successfulCommand(
      JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-25-0': [
            {
              name: 'KS2 Spelling iPhone 17',
              udid: IOS_UDID,
              state: 'Shutdown',
              deviceTypeIdentifier:
                'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
            },
          ],
        },
      }),
    );
  };
  const dependencies = createB2IosProductionDependencies({ run, fs: TEST_FS });
  await assert.rejects(
    dependencies.acquireOwnedDevice(),
    ({ code }) => code === 'ios_device_collision',
  );
  assert.equal(commands.length, 2);
  assert.equal(commands.some(([, args]) => args.includes('boot')), false);
});

test('production required runner rejects timeout and spawn failures before mutation continues', async () => {
  for (const result of [
    { ...successfulCommand(), exitCode: null, timedOut: true },
    { ...successfulCommand(), exitCode: null, spawnError: new Error('missing') },
  ]) {
    const dependencies = createB2IosProductionDependencies({
      run: async () => result,
      fs: TEST_FS,
    });
    await assert.rejects(
      dependencies.syncAndBuildUnsigned(),
      ({ code }) =>
        code === 'b2_ios_command_timeout' ||
        code === 'b2_ios_command_spawn_failed',
    );
  }
});
