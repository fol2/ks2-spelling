import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  B2_ANDROID_DATABASE_FILES,
  assertB2AndroidApplicationStatusClean,
  assertB2AndroidHierarchyPhase,
  collectB2AndroidDatabaseSet,
  createB2AndroidProductionDependencies,
  inspectB2AndroidHashBoundDatabaseSet,
  parseB2AndroidPidProbe,
  pollB2AndroidProcess,
  runB2AndroidLifecycleProof,
  runB2AndroidSubprocess,
  runWithB2AndroidOwnedCleanup,
  validateB2AndroidManualAttestation,
  validateB2AndroidPendingProof,
  waitForB2AndroidHierarchyPhase,
  writeB2AndroidValidatedReport,
} from '../scripts/prove-b2-android.mjs';
import { assertAndroidSerialOwnership } from '../scripts/lib/b2-evidence.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCREENSHOT_SHA256 = 'c'.repeat(64);
const DATABASE_SHA256 = 'd'.repeat(64);
const LOGICAL_SHA256 = 'e'.repeat(64);
const LEARNER_B_SHA256 = 'f'.repeat(64);

function hierarchyRecord(phase) {
  const texts = [
    'B2 persistence proof',
    'KS2 Spelling',
    'Local SQLite, transaction recovery and app lifecycle diagnostics.',
    'Active proof phase',
    phase,
    'Native local data',
    'Database',
    'ks2-spelling',
    'SQLite schema',
    '&#49;',
    'Learner isolation',
    phase === 'B2 proof complete' ? 'verified' : 'pending',
    'Lifecycle',
    phase === 'B2 proof complete'
      ? 'pause, resume and relaunch verified'
      : 'proof in progress',
  ];
  const hierarchy = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<hierarchy rotation="0">',
    '<node index="root" text="" class="android.widget.FrameLayout">',
    ...texts.map((text, index) =>
      `<node index="${index}" text="${text}" class="android.view.View"/>`,
    ),
    '</node>',
    '</hierarchy>',
  ].join('');
  return {
    phase,
    hierarchy,
    hierarchySha256: createHash('sha256')
      .update(Buffer.from(hierarchy, 'utf8'))
      .digest('hex'),
    attempts: 1,
  };
}

function successfulCommand(stdout = '', stdoutBytes = Buffer.from(stdout)) {
  return {
    exitCode: 0,
    signal: null,
    stdout,
    stdoutBytes,
    stderr: '',
    spawnError: null,
    timedOut: false,
    interruptedSignal: null,
    aborted: false,
  };
}

function createDependencies({ failAt = null } = {}) {
  const events = [];
  let launchCount = 0;
  const step = async (name, value) => {
    events.push(name);
    if (failAt === name) throw new Error(`failure at ${name}`);
    return value;
  };
  return {
    events,
    dependencies: {
      async syncAndBuildDebug() {
        return step('sync-build-debug', {
          apkPath: '/build/app-debug.apk',
          compiled: true,
          configuration: 'Debug',
          signing: 'debug',
        });
      },
      async acquireOwnedDevice() {
        return step('acquire-owned-avd', {
          adb: '/sdk/platform-tools/adb',
          emulator: '/sdk/emulator/emulator',
          avdExists: true,
        });
      },
      async withOwnedCleanup(options) {
        return runWithB2AndroidOwnedCleanup({
          ...options,
          signalSource: new EventEmitter(),
        });
      },
      async killOwnedSerial(serial) {
        assert.equal(serial, 'emulator-5580');
        return step('kill-owned-emulator-5580');
      },
      async terminateProcessGroup() {
        return step('terminate-owned-process-group');
      },
      async bootOwnedDevice(_device, { ownSerial }) {
        ownSerial('emulator-5580');
        return step('boot-owned-api36-port5580');
      },
      async freshInstallAndLaunch(build) {
        assert.equal(build.apkPath, '/build/app-debug.apk');
        return step('uninstall-install-launch', { pid: '101' });
      },
      async waitForHierarchyPhase(phase) {
        return step(`hierarchy:${phase}`, hierarchyRecord(phase));
      },
      async pressHome() {
        return step('KEYCODE_HOME');
      },
      async relaunchForResume() {
        return step('am-start-resume');
      },
      async assertProcessPresent(pid) {
        return step(`pid:${pid}:present`);
      },
      async forceStopApplication() {
        return step('am-force-stop');
      },
      async assertProcessAbsent() {
        return step('pid:absent');
      },
      async launchApplication() {
        launchCount += 1;
        return step('am-start-relaunch', { pid: launchCount === 1 ? '202' : '303' });
      },
      async captureForegroundEvidence({ pid, hierarchy }) {
        assert.equal(pid, '202');
        assert.equal(hierarchy.phase, 'B2 proof complete');
        return step('capture-hierarchy-and-screenshot-while-foreground', {
          path: '/reports/android.png',
          sha256: SCREENSHOT_SHA256,
          machineStateSource: 'uiautomator-hierarchy',
          exactTextState: 'complete',
          hierarchySha256: hierarchy.hierarchySha256,
          manualVisualInspection: 'pending',
        });
      },
      async collectTerminatedDatabaseSet() {
        return step('run-as-copy-pull-remove-db-wal-shm', {
          databasePath: '/evidence/ks2-spellingSQLite.db',
          sidecarsObserved: B2_ANDROID_DATABASE_FILES.slice(1),
          observedFiles: [...B2_ANDROID_DATABASE_FILES],
          fileSha256: Object.fromEntries(
            B2_ANDROID_DATABASE_FILES.map((name) => [name, DATABASE_SHA256]),
          ),
          everyObservedSidecarCollectedSafely: true,
        });
      },
      async inspectCollectedDatabase({ databasePath, readOnly }) {
        assert.equal(databasePath, '/evidence/ks2-spellingSQLite.db');
        assert.equal(readOnly, true);
        return step('inspect-collected-db-read-only', {
          databaseSha256: DATABASE_SHA256,
          foreignKeys: 1,
          journalMode: 'wal',
          synchronous: 2,
          busyTimeout: 5000,
          integrityCheck: 'ok',
          finalLogicalSnapshotSha256: LOGICAL_SHA256,
          resumedSessionId: 'session-from-final-row',
          learnerBDigest: LEARNER_B_SHA256,
          preRelaunchDigest: '9'.repeat(64),
          migrationRollback: 'verified',
          atomicFailureCheckpoints: [
            'after-subject-state',
            'after-practice-session',
            'after-events',
            'after-monster-state',
            'after-camp-state',
            'after-revision',
            'before-commit',
          ],
          lifecycleEvents: ['pause', 'resume'],
          finalRevision: 6,
          starterCampRows: 0,
          monsterState: 'spelling-derived-child-owned',
        });
      },
      async inspectPackagedPrivacy() {
        return step('aapt2-exact-empty-permissions', {
          serverUrl: null,
          packagedPermissions: [],
          androidBackupEnabled: false,
          androidApi: 36,
          osVersion: '16',
          buildTools: '36.0.0',
        });
      },
    },
  };
}

test('Android proof wrapper is exposed through the exact deterministic command', async () => {
  const packageJson = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(
    packageJson.scripts['prove:b2:android'],
    'node scripts/prove-b2-android.mjs',
  );
  assert.deepEqual(B2_ANDROID_DATABASE_FILES, [
    'ks2-spellingSQLite.db',
    'ks2-spellingSQLite.db-wal',
    'ks2-spellingSQLite.db-shm',
  ]);
});

test('Android proof orders hierarchy phases, HOME, PID replacement, UI and run-as copy', async () => {
  const { dependencies, events } = createDependencies();
  const result = await runB2AndroidLifecycleProof(dependencies);
  assert.deepEqual(result.lifecycle, {
    preKillPid: '101',
    postRelaunchPid: '202',
    differentPid: true,
  });
  assert.deepEqual(events, [
    'sync-build-debug',
    'acquire-owned-avd',
    'boot-owned-api36-port5580',
    'uninstall-install-launch',
    'hierarchy:Background test ready',
    'pid:101:present',
    'KEYCODE_HOME',
    'am-start-resume',
    'hierarchy:Ready for relaunch',
    'pid:101:present',
    'am-force-stop',
    'pid:absent',
    'am-start-relaunch',
    'pid:202:present',
    'hierarchy:B2 proof complete',
    'capture-hierarchy-and-screenshot-while-foreground',
    'am-force-stop',
    'pid:absent',
    'run-as-copy-pull-remove-db-wal-shm',
    'inspect-collected-db-read-only',
    'aapt2-exact-empty-permissions',
    'kill-owned-emulator-5580',
  ]);
  assert.ok(
    events.indexOf('capture-hierarchy-and-screenshot-while-foreground') <
      events.lastIndexOf('am-force-stop'),
  );
});

test('failure still shuts down only the owned exact emulator', async () => {
  const { dependencies, events } = createDependencies({
    failAt: 'capture-hierarchy-and-screenshot-while-foreground',
  });
  await assert.rejects(runB2AndroidLifecycleProof(dependencies), /failure at capture/);
  assert.equal(events.at(-1), 'kill-owned-emulator-5580');
  assert.equal(events.includes('run-as-copy-pull-remove-db-wal-shm'), false);
});

test('relaunch PID must differ before screenshot or database mutation', async () => {
  const { dependencies, events } = createDependencies();
  dependencies.launchApplication = async () => {
    events.push('am-start-reused-pid');
    return { pid: '101' };
  };
  await assert.rejects(
    runB2AndroidLifecycleProof(dependencies),
    ({ code }) => code === 'b2_android_pid_unchanged',
  );
  assert.equal(events.includes('capture-hierarchy-and-screenshot-while-foreground'), false);
  assert.equal(events.at(-1), 'kill-owned-emulator-5580');
});

test('non-owned and serial-collision paths never clean up foreign devices', async () => {
  const cleanup = [];
  await assert.rejects(
    runWithB2AndroidOwnedCleanup({
      work: async () => assertAndroidSerialOwnership('Some_Other_AVD\nOK\n'),
      killOwnedSerial: async (serial) => cleanup.push(serial),
      terminateProcessGroup: async (pid) => cleanup.push(pid),
      signalSource: new EventEmitter(),
    }),
    ({ code }) => code === 'android_serial_collision',
  );
  assert.deepEqual(cleanup, []);

  assert.equal(
    await runWithB2AndroidOwnedCleanup({
      work: async () => 'no-owned-device',
      killOwnedSerial: async () => assert.fail('must not kill a non-owned serial'),
      terminateProcessGroup: async () => assert.fail('must not kill a non-owned process'),
      signalSource: new EventEmitter(),
    }),
    'no-owned-device',
  );
});

test('signal aborts blocked work before exactly one owned cleanup', async () => {
  const signalSource = new EventEmitter();
  const events = [];
  let started;
  const workStarted = new Promise((resolve) => { started = resolve; });
  const interrupted = runWithB2AndroidOwnedCleanup({
    work: async ({ signal, ownSerial }) => {
      ownSerial('emulator-5580');
      started();
      await new Promise((resolveAbort) => {
        signal.addEventListener('abort', resolveAbort, { once: true });
      });
      events.push('work-unwound');
      signal.throwIfAborted();
      events.push('forbidden-mutation');
    },
    killOwnedSerial: async (serial) => events.push(`kill:${serial}`),
    terminateProcessGroup: async () => assert.fail('wrong cleanup route'),
    signalSource,
  });
  await workStarted;
  signalSource.emit('SIGTERM');
  await assert.rejects(
    interrupted,
    ({ code }) => code === 'b2_android_signal_interrupted',
  );
  assert.deepEqual(events, ['work-unwound', 'kill:emulator-5580']);
});

test('every subprocess has bounded process-group timeout and AbortSignal support', async () => {
  const timed = await runB2AndroidSubprocess(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { timeoutMs: 30 },
  );
  assert.equal(timed.timedOut, true);
  assert.ok(['SIGTERM', 'SIGKILL'].includes(timed.signal));

  const controller = new AbortController();
  const running = runB2AndroidSubprocess(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { timeoutMs: 2_000, signal: controller.signal },
  );
  setTimeout(() => controller.abort(new Error('test abort')), 20);
  const aborted = await running;
  assert.equal(aborted.aborted, true);
  assert.equal(aborted.abortReason.message, 'test abort');
  assert.equal(aborted.timedOut, false);
});

test('AbortSignal escalates a SIGTERM-ignoring child to SIGKILL and owned cleanup runs once', async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  const running = runB2AndroidSubprocess(
    process.execPath,
    [
      '-e',
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
    ],
    { timeoutMs: 5_000, signal: controller.signal },
  );
  setTimeout(() => controller.abort(new Error('forced abort')), 150);
  const result = await running;
  assert.equal(result.aborted, true);
  assert.equal(result.signal, 'SIGKILL');
  assert.ok(Date.now() - startedAt < 2_000);

  const childSignalSource = new EventEmitter();
  const interruptedChild = runB2AndroidSubprocess(
    process.execPath,
    [
      '-e',
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
    ],
    { timeoutMs: 5_000, signalSource: childSignalSource },
  );
  setTimeout(() => childSignalSource.emit('SIGTERM'), 150);
  const interruptedResult = await interruptedChild;
  assert.equal(interruptedResult.interruptedSignal, 'SIGTERM');
  assert.equal(interruptedResult.signal, 'SIGKILL');

  const signalSource = new EventEmitter();
  const cleanup = [];
  let workStarted;
  const began = new Promise((resolve) => { workStarted = resolve; });
  const proof = runWithB2AndroidOwnedCleanup({
    work: async ({ signal, ownSerial }) => {
      ownSerial('emulator-5580');
      const child = runB2AndroidSubprocess(
        process.execPath,
        [
          '-e',
          "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
        ],
        { timeoutMs: 5_000, signal },
      );
      workStarted();
      await child;
      signal.throwIfAborted();
    },
    killOwnedSerial: async (serial) => cleanup.push(serial),
    terminateProcessGroup: async () => assert.fail('wrong cleanup route'),
    signalSource,
  });
  await began;
  signalSource.emit('SIGINT');
  await assert.rejects(
    proof,
    ({ code }) => code === 'b2_android_signal_interrupted',
  );
  assert.deepEqual(cleanup, ['emulator-5580']);
});

test('PID probes fail closed on timeout, signals and malformed or multiple PIDs', async () => {
  assert.deepEqual(parseB2AndroidPidProbe(successfulCommand('123\n')), {
    state: 'present',
    pid: '123',
  });
  assert.deepEqual(
    parseB2AndroidPidProbe({ ...successfulCommand(), exitCode: 1 }),
    { state: 'absent', pid: null },
  );
  for (const candidate of [
    successfulCommand('123 456\n'),
    { ...successfulCommand(), exitCode: 2 },
    { ...successfulCommand(), exitCode: null, timedOut: true },
    { ...successfulCommand(), exitCode: null, signal: 'SIGKILL' },
    { ...successfulCommand(), exitCode: null, spawnError: new Error('missing') },
  ]) {
    assert.throws(
      () => parseB2AndroidPidProbe(candidate),
      ({ code }) => code === 'b2_android_process_probe_failed',
    );
  }

  const results = [successfulCommand('123\n'), successfulCommand('')];
  assert.deepEqual(
    await pollB2AndroidProcess({
      expected: 'absent',
      attempts: 2,
      run: async () => results.shift(),
      sleep: async () => undefined,
    }),
    { state: 'absent', pid: null },
  );
});

test('hierarchy polling requires exact phases and the complete diagnostic shell', async () => {
  const complete = hierarchyRecord('B2 proof complete').hierarchy;
  assert.equal(
    assertB2AndroidHierarchyPhase(complete, 'B2 proof complete').phase,
    'B2 proof complete',
  );
  assert.throws(
    () => assertB2AndroidHierarchyPhase('B2 proof complete', 'B2 proof complete'),
    ({ code }) => code === 'b2_android_hierarchy_xml_invalid',
  );
  const partial = complete.replace(
    '<node index="12" text="Lifecycle" class="android.view.View"/>',
    '',
  );
  const probes = [successfulCommand(partial), successfulCommand(complete)];
  const result = await waitForB2AndroidHierarchyPhase({
    phase: 'B2 proof complete',
    attempts: 2,
    probe: async () => probes.shift(),
    sleep: async () => undefined,
  });
  assert.equal(result.attempts, 2);
  await assert.rejects(
    waitForB2AndroidHierarchyPhase({
      phase: 'Ready for relaunch',
      attempts: 1,
      probe: async () => ({ ...successfulCommand(), timedOut: true }),
    }),
    ({ code }) => code === 'b2_android_hierarchy_probe_failed',
  );
});

test('hierarchy parser rejects negated, duplicate, stale, partial and malformed XML text', () => {
  const complete = hierarchyRecord('B2 proof complete').hierarchy;
  const candidates = [
    complete.replace('text="B2 proof complete"', 'text="Not B2 proof complete"'),
    complete.replace(
      '</hierarchy>',
      '<node index="99" text="KS2 Spelling" class="android.view.View"/></hierarchy>',
    ),
    complete.replace(
      '</hierarchy>',
      '<node index="99" text="Ready for relaunch" class="android.view.View"/></hierarchy>',
    ),
    complete.replace(
      '<node index="1" text="KS2 Spelling" class="android.view.View"/>',
      '',
    ),
    complete.replace('text="KS2 Spelling"', 'text="KS2 &unknown; Spelling"'),
    complete.replace(
      'text="KS2 Spelling"',
      'text="KS2 Spelling" text="KS2 Spelling"',
    ),
  ];
  for (const candidate of candidates) {
    assert.throws(
      () => assertB2AndroidHierarchyPhase(candidate, 'B2 proof complete'),
      ({ code }) => [
        'b2_android_hierarchy_phase_invalid',
        'b2_android_hierarchy_xml_invalid',
      ].includes(code),
    );
  }
});

async function collectFixture(listing, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'b2-android-run-as-'));
  const events = [];
  try {
    const result = await collectB2AndroidDatabaseSet({
      async listDatabaseFiles() {
        events.push('list');
        return listing;
      },
      async assertTemporaryDirectoryAbsent() {
        events.push('assert-temp-absent');
        if (options.collision) throw Object.assign(new Error('collision'), {
          code: 'b2_android_temporary_collision',
        });
      },
      async createTemporaryDirectory() {
        events.push('mkdir-app-readable-temp');
      },
      async copyToTemporaryDirectory(filename) {
        events.push(`copy:${filename}`);
      },
      async pullTemporaryFile(filename) {
        events.push(`pull:${filename}`);
        return Buffer.from(`database-bytes:${filename}`);
      },
      async removeTemporaryDirectory() {
        events.push('remove-only-owned-temp');
      },
      destinationDirectory: join(directory, 'collected'),
    });
    return { result, events };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test('run-as collection safely copies the primary and every optional known sidecar', async () => {
  for (const files of [
    [B2_ANDROID_DATABASE_FILES[0]],
    [...B2_ANDROID_DATABASE_FILES],
  ]) {
    const { result, events } = await collectFixture(files.join('\n'));
    assert.deepEqual(result.observedFiles, files);
    assert.deepEqual(result.sidecarsObserved, files.slice(1));
    assert.equal(result.everyObservedSidecarCollectedSafely, true);
    assert.deepEqual(
      events,
      [
        'list',
        'assert-temp-absent',
        'mkdir-app-readable-temp',
        ...files.map((name) => `copy:${name}`),
        'list',
        ...files.map((name) => `pull:${name}`),
        'remove-only-owned-temp',
      ],
    );
  }
});

test('run-as collection rejects unknown sidecars and preserves colliding temp paths', async () => {
  await assert.rejects(
    collectFixture('ks2-spellingSQLite.db\nks2-spellingSQLite.db-journal\n'),
    ({ code }) => code === 'b2_android_database_sidecar_unknown',
  );
  const collisionEvents = [];
  await assert.rejects(
    collectB2AndroidDatabaseSet({
      async listDatabaseFiles() {
        collisionEvents.push('list');
        return 'ks2-spellingSQLite.db\n';
      },
      async assertTemporaryDirectoryAbsent() {
        collisionEvents.push('collision');
        throw Object.assign(new Error('existing temp'), {
          code: 'b2_android_temporary_collision',
        });
      },
      async createTemporaryDirectory() {
        collisionEvents.push('forbidden-mkdir');
      },
      async copyToTemporaryDirectory() {},
      async pullTemporaryFile() {},
      async removeTemporaryDirectory() {
        collisionEvents.push('forbidden-remove');
      },
    }),
    ({ code }) => code === 'b2_android_temporary_collision',
  );
  assert.deepEqual(collisionEvents, ['list', 'collision']);
});

test('run-as mkdir registers ownership before abort and uses non-aborted cleanup', async () => {
  const controller = new AbortController();
  const events = [];
  await assert.rejects(
    collectB2AndroidDatabaseSet({
      async listDatabaseFiles() {
        return 'ks2-spellingSQLite.db\n';
      },
      async assertTemporaryDirectoryAbsent() {
        events.push('collision-clear');
      },
      async createTemporaryDirectory() {
        events.push('mkdir-succeeded');
        controller.abort(new Error('abort after mkdir'));
      },
      async copyToTemporaryDirectory() {
        events.push('forbidden-copy');
      },
      async pullTemporaryFile() {
        events.push('forbidden-pull');
      },
      async removeTemporaryDirectory() {
        events.push('owned-cleanup-without-aborted-signal');
      },
      signal: controller.signal,
    }),
    /abort after mkdir/,
  );
  assert.deepEqual(events, [
    'collision-clear',
    'mkdir-succeeded',
    'owned-cleanup-without-aborted-signal',
  ]);

  const failedMkdir = [];
  await assert.rejects(
    collectB2AndroidDatabaseSet({
      async listDatabaseFiles() { return 'ks2-spellingSQLite.db\n'; },
      async assertTemporaryDirectoryAbsent() {},
      async createTemporaryDirectory() {
        failedMkdir.push('side-effect-attempted');
        throw new Error('mkdir outcome uncertain');
      },
      async copyToTemporaryDirectory() {},
      async pullTemporaryFile() {},
      async removeTemporaryDirectory() {
        failedMkdir.push('pre-registered-cleanup-ran');
      },
    }),
    /mkdir outcome uncertain/,
  );
  assert.deepEqual(failedMkdir, [
    'side-effect-attempted',
    'pre-registered-cleanup-ran',
  ]);
});

test('hash-bound Android verification mutates only scratch SHM across capture and finalise checks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'b2-android-isolated-evidence-'));
  const collected = join(directory, 'collected');
  const scratchRoot = join(directory, 'scratch');
  await mkdir(collected, { recursive: true });
  for (const name of B2_ANDROID_DATABASE_FILES) {
    await writeFile(join(collected, name), Buffer.from(`original:${name}`));
  }
  const original = Object.fromEntries(
    await Promise.all(B2_ANDROID_DATABASE_FILES.map(async (name) => [
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
    await writeFile(
      `${scratchDatabasePath}-shm`,
      Buffer.from(`android-reader-mutated-shm-${mutationCount}`),
    );
    mutationCount += 1;
    return { mutationCount };
  };
  try {
    for (const expected of [1, 2]) {
      assert.deepEqual(
        await inspectB2AndroidHashBoundDatabaseSet(
          {
            databasePath: join(collected, B2_ANDROID_DATABASE_FILES[0]),
            observedFiles: [...B2_ANDROID_DATABASE_FILES],
            fileSha256,
          },
          { scratchRoot, inspectDatabase },
        ),
        { mutationCount: expected },
      );
      for (const name of B2_ANDROID_DATABASE_FILES) {
        assert.deepEqual(await readFile(join(collected, name)), original[name]);
      }
      assert.deepEqual(await readdir(scratchRoot), []);
    }
    assert.equal(mutationCount, 2);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('checkpoint cleanup is platform-scoped and application drift fails closed', () => {
  assert.equal(
    assertB2AndroidApplicationStatusClean(
      '?? reports/b2/ios-simulator-proof.json\n?? reports/b2/android-emulator-proof.png\n',
    ),
    true,
  );
  assert.throws(
    () => assertB2AndroidApplicationStatusClean(' M src/main.jsx\n'),
    ({ code }) => code === 'b2_android_checkpoint_dirty',
  );
});

test('manual visual attestation is explicit and bound to the exact screenshot SHA', async () => {
  const attestation = {
    schemaVersion: 1,
    platform: 'android-emulator',
    screenshotSha256: SCREENSHOT_SHA256,
    manualVisualInspection: 'passed',
  };
  assert.deepEqual(
    validateB2AndroidManualAttestation(attestation, SCREENSHOT_SHA256),
    attestation,
  );
  for (const invalid of [
    undefined,
    { ...attestation, screenshotSha256: '0'.repeat(64) },
    { ...attestation, platform: 'ios-simulator' },
    { ...attestation, extra: true },
  ]) {
    assert.throws(
      () => validateB2AndroidManualAttestation(invalid, SCREENSHOT_SHA256),
      ({ code }) => code === 'b2_android_manual_attestation_invalid',
    );
  }
  await assert.rejects(
    writeB2AndroidValidatedReport({
      testedApplicationCommit: '1'.repeat(40),
      applicationFingerprint: '2'.repeat(64),
      proof: { screenshot: { sha256: SCREENSHOT_SHA256 } },
      manualAttestation: undefined,
    }),
    ({ code }) => code === 'b2_android_manual_attestation_invalid',
  );
});

test('pending proof rejects self-passed, stale screenshot and tampered database identities', async () => {
  const { dependencies } = createDependencies();
  const proof = await runB2AndroidLifecycleProof(dependencies);
  const screenshotBytes = Buffer.from('pending android screenshot');
  proof.screenshot.sha256 = createHash('sha256').update(screenshotBytes).digest('hex');
  const pending = {
    schemaVersion: 1,
    testedApplicationCommit: '1'.repeat(40),
    applicationFingerprint: '2'.repeat(64),
    proof,
  };
  assert.deepEqual(
    validateB2AndroidPendingProof(pending, {
      expectedCommit: pending.testedApplicationCommit,
      expectedFingerprint: pending.applicationFingerprint,
      screenshotBytes,
    }),
    pending,
  );
  for (const mutate of [
    (value) => { value.proof.screenshot.manualVisualInspection = 'passed'; },
    (value) => { value.proof.lifecycle.postRelaunchPid = '101'; },
    (value) => { value.proof.collected.observedFiles.push('unknown-sidecar'); },
    (value) => { value.proof.database.atomicFailureCheckpoints.pop(); },
    (value) => { value.proof.privacy.packagedPermissions = ['android.permission.INTERNET']; },
    (value) => { value.applicationFingerprint = '3'.repeat(64); },
  ]) {
    const changed = structuredClone(pending);
    mutate(changed);
    assert.throws(
      () => validateB2AndroidPendingProof(changed, {
        expectedCommit: pending.testedApplicationCommit,
        expectedFingerprint: pending.applicationFingerprint,
        screenshotBytes,
      }),
      ({ code }) => code === 'b2_android_pending_proof_invalid',
    );
  }
});

function matchedIosReport({ proof, commit, fingerprint, screenshotSha256 }) {
  return {
    schemaVersion: 1,
    platform: 'ios-simulator',
    testedApplicationCommit: commit,
    applicationFingerprint: fingerprint,
    identity: { applicationId: 'uk.eugnel.ks2spelling' },
    device: {
      name: 'KS2 Spelling iPhone 17',
      runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
      osVersion: '26.5',
    },
    nativeVersions: {
      xcode: '26.6 (17F113)',
      iosSdk: '26.5',
      capacitorIos: '8.4.1',
    },
    pluginVersions: {
      capacitorCore: '8.4.1',
      capacitorApp: '8.1.0',
      capacitorSqlite: '8.1.0',
    },
    database: {
      name: 'ks2-spelling',
      physicalFile: 'ks2-spellingSQLite.db',
      schemaVersion: 1,
      foreignKeys: proof.database.foreignKeys,
      journalMode: proof.database.journalMode,
      synchronous: proof.database.synchronous,
      busyTimeout: proof.database.busyTimeout,
      integrityCheck: proof.database.integrityCheck,
      databaseSha256: '8'.repeat(64),
      walModeObserved: true,
      sidecarsObserved: proof.collected.sidecarsObserved,
      everyObservedSidecarCollectedSafely: true,
    },
    lifecycle: {
      events: ['pause', 'resume'],
      preKillPid: '301',
      postRelaunchPid: '302',
      differentPid: true,
    },
    proof: {
      resumedSessionId: proof.database.resumedSessionId,
      preKillRevision: 4,
      finalRevision: proof.database.finalRevision,
      finalLogicalSnapshotSha256: proof.database.finalLogicalSnapshotSha256,
      atomicFailureCheckpoints: proof.database.atomicFailureCheckpoints,
      migrationRollback: proof.database.migrationRollback,
      learnerBIsolation: 'verified',
      learnerBInitialSha256: proof.database.learnerBDigest,
      learnerBFinalSha256: proof.database.learnerBDigest,
      monsterState: proof.database.monsterState,
      starterCampRows: proof.database.starterCampRows,
    },
    privacy: {
      serverUrl: null,
      packagedAndroidPermissions: [],
      androidBackupEnabled: false,
      addedIosUsageDescriptionKeys: [],
      addedIosEntitlements: [],
    },
    ui: {
      diagnosticPhase: 'complete',
      machineStateSource: 'durable-proof-metadata',
      screenshotSha256,
      manualVisualInspection: 'passed',
    },
    cleanup: { deviceStopped: true },
  };
}

test('Android final report requires live matched iOS evidence before any write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'b2-cross-platform-final-'));
  const paths = {
    androidReport: join(directory, 'android.json'),
    androidScreenshot: join(directory, 'android.png'),
    iosReport: join(directory, 'ios.json'),
    iosScreenshot: join(directory, 'ios.png'),
  };
  const commit = '1'.repeat(40);
  const fingerprint = '2'.repeat(64);
  const androidScreenshot = Buffer.from('android screenshot');
  const iosScreenshot = Buffer.from('ios screenshot');
  const { dependencies } = createDependencies();
  const proof = await runB2AndroidLifecycleProof(dependencies);
  proof.screenshot.sha256 = createHash('sha256')
    .update(androidScreenshot)
    .digest('hex');
  proof.collected.fileSha256['ks2-spellingSQLite.db'] = proof.database.databaseSha256;
  const attestation = {
    schemaVersion: 1,
    platform: 'android-emulator',
    screenshotSha256: proof.screenshot.sha256,
    manualVisualInspection: 'passed',
  };
  const ios = matchedIosReport({
    proof,
    commit,
    fingerprint,
    screenshotSha256: createHash('sha256').update(iosScreenshot).digest('hex'),
  });
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(paths.androidScreenshot, androidScreenshot);
    await writeFile(paths.iosScreenshot, iosScreenshot);
    await writeFile(paths.iosReport, `${JSON.stringify(ios)}\n`);
    await writeB2AndroidValidatedReport({
      testedApplicationCommit: commit,
      applicationFingerprint: fingerprint,
      proof,
      manualAttestation: attestation,
      paths,
    });
    assert.equal(JSON.parse(await readFile(paths.androidReport)).platform, 'android-emulator');

    const mismatch = structuredClone(ios);
    mismatch.proof.finalLogicalSnapshotSha256 = '0'.repeat(64);
    await writeFile(paths.iosReport, `${JSON.stringify(mismatch)}\n`);
    await rm(paths.androidReport);
    await assert.rejects(
      writeB2AndroidValidatedReport({
        testedApplicationCommit: commit,
        applicationFingerprint: fingerprint,
        proof,
        manualAttestation: attestation,
        paths,
      }),
      /logical proof/i,
    );
    await assert.rejects(readFile(paths.androidReport), { code: 'ENOENT' });

    const stale = structuredClone(ios);
    stale.testedApplicationCommit = '9'.repeat(40);
    await writeFile(paths.iosReport, `${JSON.stringify(stale)}\n`);
    await assert.rejects(
      writeB2AndroidValidatedReport({
        testedApplicationCommit: commit,
        applicationFingerprint: fingerprint,
        proof,
        manualAttestation: attestation,
        paths,
      }),
      /testedApplicationCommit/i,
    );
    await assert.rejects(readFile(paths.androidReport), { code: 'ENOENT' });

    await rm(paths.iosReport);
    await assert.rejects(
      writeB2AndroidValidatedReport({
        testedApplicationCommit: commit,
        applicationFingerprint: fingerprint,
        proof,
        manualAttestation: attestation,
        paths,
      }),
      ({ code }) => code === 'b2_android_ios_evidence_missing',
    );
    await assert.rejects(readFile(paths.androidReport), { code: 'ENOENT' });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('production source uses exact ownership/run-as and never roots or self-attests', async () => {
  const source = await readFile(join(ROOT, 'scripts/prove-b2-android.mjs'), 'utf8');
  for (const required of [
    'B2_ANDROID_DEVICE',
    'KEYCODE_HOME',
    'uiautomator',
    'am',
    'force-stop',
    'run-as',
    'aapt2',
    "'dump', 'permissions'",
    'assertAndroidSerialOwnership',
    'assertStartedAndroidEmulatorProcess',
  ]) assert.ok(source.includes(required), required);
  assert.doesNotMatch(source, /\badb\s+root\b|\bchmod\b|manualVisualInspection:\s*'passed'/);
});

function productionTestFs() {
  return {
    existsSync: () => true,
    async readdir() {
      return ['latest'];
    },
    async readFile(path) {
      if (path.endsWith('/config.ini')) {
        return [
          'abi.type=arm64-v8a',
          'hw.device.name=pixel_9',
          'image.sysdir.1=system-images/android-36/google_apis/arm64-v8a/',
          'tag.id=google_apis',
        ].join('\n');
      }
      if (path.endsWith('KS2_Spelling_API_36.ini')) {
        return [
          'path=/test-home/.android/avd/KS2_Spelling_API_36.avd',
          'path.rel=avd/KS2_Spelling_API_36.avd',
          'target=android-36',
        ].join('\n');
      }
      throw new Error(`unexpected fake read: ${path}`);
    },
    async mkdir() {},
    async rename() {},
    async rm() {},
    async writeFile() {},
  };
}

test('production adapter executes exact AVD, fresh-install, HOME and force-stop commands', async () => {
  const commands = [];
  const adb = '/sdk/platform-tools/adb';
  const run = async (command, args, options) => {
    commands.push([command, args, options.timeoutMs]);
    const serialised = args.join(' ');
    if (command === '/sdk/emulator/emulator' && serialised === '-list-avds') {
      return successfulCommand('KS2_Spelling_API_36\n');
    }
    if (serialised.includes('emu avd name')) {
      return successfulCommand('KS2_Spelling_API_36\nOK\n');
    }
    if (serialised.includes('getprop sys.boot_completed')) {
      return successfulCommand('1\n');
    }
    if (serialised.includes('pidof uk.eugnel.ks2spelling')) {
      return successfulCommand('101\n');
    }
    return successfulCommand();
  };
  const dependencies = createB2AndroidProductionDependencies({
    run,
    fs: productionTestFs(),
    sleep: async () => undefined,
    signalSource: new EventEmitter(),
    env: {
      HOME: '/test-home',
      JAVA_HOME: '/java',
      ANDROID_HOME: '/sdk',
    },
  });
  const build = await dependencies.syncAndBuildDebug();
  const device = await dependencies.acquireOwnedDevice();
  const owned = [];
  await dependencies.bootOwnedDevice(device, {
    ownSerial: (serial) => owned.push(serial),
    ownProcessGroup: () => assert.fail('existing exact AVD needs no new process group'),
  });
  const first = await dependencies.freshInstallAndLaunch(build);
  await dependencies.pressHome();
  await dependencies.relaunchForResume();
  await dependencies.forceStopApplication();

  assert.equal(first.pid, '101');
  assert.deepEqual(owned, ['emulator-5580', 'emulator-5580']);
  assert.ok(
    commands.some(
      ([command, args]) =>
        command === adb &&
        args.join(' ') ===
          '-s emulator-5580 uninstall uk.eugnel.ks2spelling',
    ),
  );
  assert.ok(
    commands.some(
      ([command, args]) =>
        command === adb &&
        args.join(' ') ===
          '-s emulator-5580 shell input keyevent KEYCODE_HOME',
    ),
  );
  assert.ok(
    commands.some(
      ([command, args]) =>
        command === adb &&
        args.join(' ') ===
          '-s emulator-5580 shell am force-stop uk.eugnel.ks2spelling',
    ),
  );
  assert.ok(commands.every(([, , timeoutMs]) => Number.isSafeInteger(timeoutMs)));
});

test('production adapter rejects a serial collision and required-runner failures', async () => {
  const fs = productionTestFs();
  const env = {
    HOME: '/test-home',
    JAVA_HOME: '/java',
    ANDROID_HOME: '/sdk',
  };
  const collision = createB2AndroidProductionDependencies({
    fs,
    env,
    run: async (_command, args) => {
      if (args.join(' ').includes('emu avd name')) {
        return successfulCommand('Some_Other_AVD\nOK\n');
      }
      return successfulCommand();
    },
  });
  await assert.rejects(
    collision.bootOwnedDevice({}, {
      ownSerial: () => assert.fail('collision must not become owned'),
      ownProcessGroup: () => assert.fail('collision must not start another emulator'),
    }),
    ({ code }) => code === 'android_serial_collision',
  );

  for (const failed of [
    { ...successfulCommand(), exitCode: null, timedOut: true },
    { ...successfulCommand(), exitCode: null, signal: 'SIGKILL' },
    { ...successfulCommand(), exitCode: null, spawnError: new Error('missing') },
  ]) {
    const dependencies = createB2AndroidProductionDependencies({
      fs,
      env,
      run: async () => failed,
    });
    await assert.rejects(
      dependencies.syncAndBuildDebug(),
      ({ code }) => [
        'b2_android_command_timeout',
        'b2_android_command_signal',
        'b2_android_command_spawn_failed',
      ].includes(code),
    );
  }
});

test('production run-as uses unique paths, pulls every sidecar and cleans an interrupted mkdir', async () => {
  const commands = [];
  const files = B2_ANDROID_DATABASE_FILES.join('\n');
  const run = async (command, args, options) => {
    commands.push([command, args, options.signal]);
    const serialised = args.join(' ');
    if (serialised.includes(' ls -1 databases')) return successfulCommand(`${files}\n`);
    if (serialised.includes('if [ -e files/.b2-proof-export-')) {
      return successfulCommand('absent\n');
    }
    if (args.includes('exec-out') && args.includes('cat')) {
      const filename = args.at(-1).split('/').at(-1);
      return successfulCommand('', Buffer.from(`bytes:${filename}`));
    }
    return successfulCommand();
  };
  const dependencies = createB2AndroidProductionDependencies({
    run,
    fs: productionTestFs(),
    env: {
      HOME: '/test-home',
      JAVA_HOME: '/java',
      ANDROID_HOME: '/sdk',
    },
    runId: 'run-as-proof-1234',
  });
  const collected = await dependencies.collectTerminatedDatabaseSet();
  assert.deepEqual(collected.observedFiles, [...B2_ANDROID_DATABASE_FILES]);
  const serialised = commands.map(([, args]) => args.join(' '));
  assert.ok(serialised.some((value) => value.includes('files/.b2-proof-export-run-as-proof-1234')));
  assert.equal(
    serialised.filter((value) => value.includes(' rm -rf files/.b2-proof-export-run-as-proof-1234')).length,
    1,
  );
  assert.equal(serialised.some((value) => value.includes('files/.b2-proof-export ')), false);

  const controller = new AbortController();
  const interruptedCommands = [];
  const interrupted = createB2AndroidProductionDependencies({
    fs: productionTestFs(),
    env: {
      HOME: '/test-home',
      JAVA_HOME: '/java',
      ANDROID_HOME: '/sdk',
    },
    runId: 'interrupted-proof-1234',
    run: async (_command, args, options) => {
      const value = args.join(' ');
      interruptedCommands.push([value, options.signal]);
      if (value.includes(' ls -1 databases')) {
        return successfulCommand('ks2-spellingSQLite.db\n');
      }
      if (value.includes('if [ -e files/.b2-proof-export-')) {
        return successfulCommand('absent\n');
      }
      if (value.includes(' mkdir files/.b2-proof-export-interrupted-proof-1234')) {
        controller.abort(new Error('interrupt after remote mkdir'));
      }
      return successfulCommand();
    },
  });
  await assert.rejects(
    interrupted.collectTerminatedDatabaseSet({ signal: controller.signal }),
    /interrupt after remote mkdir/,
  );
  const cleanup = interruptedCommands.find(([value]) =>
    value.includes(' rm -rf files/.b2-proof-export-interrupted-proof-1234'),
  );
  assert.ok(cleanup);
  assert.equal(cleanup[1], undefined, 'cleanup runner must not reuse the aborted signal');

  const collisionCommands = [];
  const collision = createB2AndroidProductionDependencies({
    fs: productionTestFs(),
    env: {
      HOME: '/test-home',
      JAVA_HOME: '/java',
      ANDROID_HOME: '/sdk',
    },
    runId: 'foreign-temp-proof-1234',
    run: async (_command, args) => {
      const value = args.join(' ');
      collisionCommands.push(value);
      if (value.includes(' ls -1 databases')) {
        return successfulCommand('ks2-spellingSQLite.db\n');
      }
      if (value.includes('if [ -e files/.b2-proof-export-')) {
        return successfulCommand('exists\n');
      }
      return successfulCommand();
    },
  });
  await assert.rejects(
    collision.collectTerminatedDatabaseSet(),
    ({ code }) => code === 'b2_android_temporary_collision',
  );
  assert.equal(collisionCommands.some((value) => value.includes('rm -rf')), false);
});

function diagnosticBmp() {
  const width = 10;
  const height = 10;
  const buffer = Buffer.alloc(54 + width * height * 4);
  buffer.write('BM', 0, 'ascii');
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(32, 28);
  buffer.writeUInt32LE(0, 30);
  for (let offset = 54; offset < buffer.length; offset += 4) {
    buffer[offset] = 20;
    buffer[offset + 1] = 20;
    buffer[offset + 2] = 20;
    buffer[offset + 3] = 255;
  }
  buffer[54] = 220;
  buffer[55] = 220;
  buffer[56] = 220;
  buffer[58] = 130;
  buffer[59] = 160;
  buffer[60] = 80;
  return buffer;
}

test('production foreground capture and privacy inspection use executable runner evidence', async () => {
  const commands = [];
  const screenshot = Buffer.from('fake png screenshot');
  const hierarchy = hierarchyRecord('B2 proof complete');
  const stored = new Map();
  const fs = {
    ...productionTestFs(),
    async readFile(path) {
      if (path.endsWith('android-proof.bmp')) return diagnosticBmp();
      if (stored.has(path)) return stored.get(path);
      return productionTestFs().readFile(path);
    },
    async writeFile(path, bytes) {
      stored.set(path, Buffer.from(bytes));
    },
  };
  const run = async (command, args, options) => {
    commands.push([command, args, options.timeoutMs]);
    const value = args.join(' ');
    if (value.includes('pidof uk.eugnel.ks2spelling')) {
      return successfulCommand('202\n');
    }
    if (value.includes('dumpsys activity activities')) {
      return successfulCommand(
        'mResumedActivity: ActivityRecord{abc u0 uk.eugnel.ks2spelling/.MainActivity t42}\n',
      );
    }
    if (value.includes('if [ -e /sdcard/ks2-spelling-b2-window-')) {
      return successfulCommand('absent\n');
    }
    if (value.includes(' cat /sdcard/ks2-spelling-b2-window-')) {
      return successfulCommand(hierarchy.hierarchy);
    }
    if (args.includes('screencap')) return successfulCommand('', screenshot);
    if (args[0] === 'dump' && args[1] === 'permissions') {
      return successfulCommand('package: uk.eugnel.ks2spelling\n');
    }
    if (args[0] === 'dump' && args[1] === 'xmltree') {
      return successfulCommand([
        'A: android:allowBackup(0x01010280)=false',
        'A: android:fullBackupContent(0x010105eb)=@0x7f120000',
        'A: android:dataExtractionRules(0x0101064f)=@0x7f120001',
      ].join('\n'));
    }
    if (command === 'unzip') return successfulCommand('{"server":{}}\n');
    if (value.includes('getprop ro.build.version.sdk')) return successfulCommand('36\n');
    if (value.includes('getprop ro.build.version.release')) return successfulCommand('16\n');
    return successfulCommand();
  };
  const dependencies = createB2AndroidProductionDependencies({
    run,
    fs,
    env: {
      HOME: '/test-home',
      JAVA_HOME: '/java',
      ANDROID_HOME: '/sdk',
    },
    runId: 'foreground-proof-1234',
  });
  const captured = await dependencies.captureForegroundEvidence(
    { pid: '202', hierarchy },
  );
  assert.equal(captured.sha256, createHash('sha256').update(screenshot).digest('hex'));
  const privacy = await dependencies.inspectPackagedPrivacy();
  assert.deepEqual(privacy.packagedPermissions, []);
  assert.equal(privacy.androidBackupEnabled, false);
  const commandText = commands.map(([, args]) => args.join(' '));
  assert.ok(
    commandText.findIndex((value) => value.includes('uiautomator dump')) <
      commandText.findIndex((value) => value.includes('exec-out screencap -p')),
  );
  assert.equal(commandText.some((value) => value.includes('force-stop')), false);
  assert.ok(commandText.every((_, index) => Number.isSafeInteger(commands[index][2])));

  const collisionCommands = [];
  const hierarchyCollision = createB2AndroidProductionDependencies({
    runId: 'foreign-hierarchy-1234',
    fs,
    env: {
      HOME: '/test-home',
      JAVA_HOME: '/java',
      ANDROID_HOME: '/sdk',
    },
    run: async (_command, args) => {
      collisionCommands.push(args.join(' '));
      return successfulCommand('exists\n');
    },
  });
  await assert.rejects(
    hierarchyCollision.waitForHierarchyPhase('B2 proof complete'),
    ({ code }) => code === 'b2_android_hierarchy_collision',
  );
  assert.equal(collisionCommands.some((value) => value.includes('uiautomator')), false);
  assert.equal(collisionCommands.some((value) => value.includes(' rm -f ')), false);
});

test('new-emulator start registers process-group ownership before boot failure cleanup', async () => {
  const started = [];
  const cleanup = [];
  const dependencies = createB2AndroidProductionDependencies({
    fs: productionTestFs(),
    env: {
      HOME: '/test-home',
      JAVA_HOME: '/java',
      ANDROID_HOME: '/sdk',
    },
    runId: 'new-emulator-proof-1234',
    startEmulator(command, args) {
      started.push([command, args]);
      return { pid: 321 };
    },
    run: async (_command, args) => {
      const value = args.join(' ');
      if (value.endsWith('-s emulator-5580 get-state')) {
        return { ...successfulCommand(), exitCode: 1 };
      }
      if (value.includes('wait-for-device')) {
        return { ...successfulCommand(), exitCode: null, timedOut: true };
      }
      return successfulCommand();
    },
  });
  await assert.rejects(
    runWithB2AndroidOwnedCleanup({
      work: ({ signal, ownSerial, ownProcessGroup }) =>
        dependencies.bootOwnedDevice({}, { signal, ownSerial, ownProcessGroup }),
      killOwnedSerial: async () => assert.fail('serial was never acquired'),
      terminateProcessGroup: async (pid) => cleanup.push(pid),
      signalSource: new EventEmitter(),
    }),
    ({ code }) => code === 'b2_android_command_timeout',
  );
  assert.equal(started[0][1].includes('5580'), true);
  assert.deepEqual(cleanup, [321]);
});
