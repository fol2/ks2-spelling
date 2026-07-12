import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  B2_ANDROID_DATABASE_FILES,
  B2_ANDROID_HIERARCHY_POLL_DEADLINE_MS,
  assertB2AndroidApplicationStatusClean,
  assertB2AndroidHierarchyPhase,
  b2AndroidRemoteShellArgs,
  collectB2AndroidDatabaseSet,
  createB2AndroidProductionDependencies,
  inspectB2AndroidHashBoundDatabaseSet,
  parseB2AndroidHierarchyTexts,
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
  const learnerIsolation = phase === 'B2 proof complete' ? 'verified' : 'pending';
  const lifecycle = phase === 'B2 proof complete'
    ? 'pause, resume and relaunch verified'
    : 'proof in progress';
  const texts = [
    'KS2 Spelling',
    'KS2 Spelling',
    'B2 PERSISTENCE PROOF',
    'KS2 Spelling',
    'Local SQLite, transaction recovery and app lifecycle diagnostics.',
    'ACTIVE PROOF PHASE',
    phase,
    'Native local data',
    'B2 persistence evidence',
    'Database: ks2-spelling',
    'DATABASE',
    'ks2-spelling',
    'SQLite schema: 1',
    'SQLITE SCHEMA',
    '&#49;',
    `Learner isolation: ${learnerIsolation}`,
    'LEARNER ISOLATION',
    learnerIsolation,
    `Lifecycle: ${lifecycle}`,
    'LIFECYCLE',
    lifecycle,
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
    texts,
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
    stderrBytes: Buffer.alloc(0),
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
      async waitForApplicationBackgrounded() {
        return step('activity-backgrounded');
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
  assert.equal(result.background.phase, 'Background test ready');
  assert.equal(result.ready.phase, 'Ready for relaunch');
  assert.equal(result.complete.phase, 'B2 proof complete');
  for (const phase of [result.background, result.ready, result.complete]) {
    assert.deepEqual(Object.keys(phase), [
      'phase',
      'hierarchySha256',
      'attempts',
      'hierarchy',
    ]);
    assert.doesNotMatch(JSON.stringify(phase), /"texts"/);
  }
  assert.notEqual(result.ready.hierarchySha256, result.background.hierarchySha256);
  assert.notEqual(result.ready.hierarchySha256, result.complete.hierarchySha256);
  assert.deepEqual(events, [
    'sync-build-debug',
    'acquire-owned-avd',
    'boot-owned-api36-port5580',
    'uninstall-install-launch',
    'hierarchy:Background test ready',
    'pid:101:present',
    'KEYCODE_HOME',
    'activity-backgrounded',
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

test('background acknowledgement timeout prevents resume launch and still cleans the owned emulator', async () => {
  const { dependencies, events } = createDependencies();
  dependencies.waitForApplicationBackgrounded = async () => {
    events.push('activity-background-poll-timeout');
    throw Object.assign(new Error('background acknowledgement timed out'), {
      code: 'b2_android_background_timeout',
    });
  };

  await assert.rejects(
    runB2AndroidLifecycleProof(dependencies),
    ({ code }) => code === 'b2_android_background_timeout',
  );
  assert.equal(events.includes('am-start-resume'), false);
  assert.equal(events.includes('hierarchy:Ready for relaunch'), false);
  assert.equal(events.at(-1), 'kill-owned-emulator-5580');
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
    parseB2AndroidPidProbe({
      ...successfulCommand('token=[REDACTED]\n'),
      stdoutBytes: Buffer.from('123\n'),
    }),
    { state: 'present', pid: '123' },
  );
  assert.throws(
    () =>
      parseB2AndroidPidProbe({
        ...successfulCommand('123\n'),
        stdoutBytes: Uint8Array.from([0xc3, 0x28]),
      }),
    ({ code }) => code === 'b2_android_machine_output_invalid',
  );
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
    '<node index="19" text="LIFECYCLE" class="android.view.View"/>',
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

// Minimal product-text fixture extracted from the live API 36 hierarchy with
// SHA-256 9b6734e310ea5a2af5e38237f102940fc392771a8fb215de7590f7b7167c83ce.
test('API 36 WebView hierarchy accepts the exact accessible background shell', async () => {
  const hierarchy = await readFile(
    join(ROOT, 'tests/fixtures/b2-android-api36-background-hierarchy.xml'),
    'utf8',
  );

  const result = assertB2AndroidHierarchyPhase(
    hierarchy,
    'Background test ready',
  );

  assert.equal(result.phase, 'Background test ready');
  assert.equal(result.texts.length, 21);
});

test('API 36 WebView hierarchy rejects accessibility drift and extra text', async () => {
  const hierarchy = await readFile(
    join(ROOT, 'tests/fixtures/b2-android-api36-background-hierarchy.xml'),
    'utf8',
  );
  const candidates = [
    hierarchy.replace('B2 PERSISTENCE PROOF', 'B2 persistence proof'),
    hierarchy.replace(
      '    <node index="1" text="KS2 Spelling" class="android.view.View" />\n',
      '',
    ),
    hierarchy.replace(
      'Learner isolation: pending',
      'Learner isolation: not verified',
    ),
    hierarchy.replace(
      '</node>\n</hierarchy>',
      '  <node index="21" text="unexpected diagnostic" class="android.view.View" />\n  </node>\n</hierarchy>',
    ),
  ];

  for (const candidate of candidates) {
    assert.throws(
      () =>
        assertB2AndroidHierarchyPhase(candidate, 'Background test ready'),
      ({ code }) => code === 'b2_android_hierarchy_phase_invalid',
    );
  }
});

test('hierarchy polling includes slow probe runtime in its wall-clock deadline', async () => {
  const unexpectedPhase = hierarchyRecord('Ready for relaunch').hierarchy.replace(
    '</node></hierarchy>',
    '<node index="secret" text="typed-secret-123" class="android.view.View"/></node></hierarchy>',
  );
  const unexpectedTexts = parseB2AndroidHierarchyTexts(unexpectedPhase);
  let currentTimeMs = 0;
  let probeCalls = 0;
  const sleeps = [];

  await assert.rejects(
    waitForB2AndroidHierarchyPhase({
      phase: 'Background test ready',
      deadlineMs: 60_000,
      now: () => currentTimeMs,
      probe: async () => {
        probeCalls += 1;
        currentTimeMs += 60_001;
        return successfulCommand(unexpectedPhase);
      },
      sleep: async (milliseconds) => sleeps.push(milliseconds),
    }),
    (error) => {
      assert.equal(error.code, 'b2_android_hierarchy_timeout');
      assert.equal(
        error.message,
        'B2 Android UI hierarchy timed out before the expected phase',
      );
      assert.deepEqual(error.diagnostic, {
        expectedPhase: 'Background test ready',
        attempts: 1,
        lastValidHierarchy: {
          sha256: createHash('sha256')
            .update(Buffer.from(unexpectedPhase, 'utf8'))
            .digest('hex'),
          textCount: unexpectedTexts.length,
          matchedKnownPhase: 'Ready for relaunch',
        },
        lastTransientCode: 'b2_android_hierarchy_phase_invalid',
      });
      assert.doesNotMatch(JSON.stringify(error.diagnostic), /typed-secret-123/);
      return true;
    },
  );

  assert.equal(probeCalls, 1);
  assert.deepEqual(sleeps, []);
});

test('hierarchy polling rejects an expected phase that completes after its deadline', async () => {
  const expectedHierarchy = hierarchyRecord('Background test ready').hierarchy;
  const expectedTexts = parseB2AndroidHierarchyTexts(expectedHierarchy);
  let currentTimeMs = 0;

  await assert.rejects(
    waitForB2AndroidHierarchyPhase({
      phase: 'Background test ready',
      deadlineMs: 5_000,
      now: () => currentTimeMs,
      probe: async () => {
        currentTimeMs = 5_001;
        return successfulCommand(expectedHierarchy);
      },
      sleep: async () => undefined,
    }),
    ({ code, diagnostic }) => {
      assert.equal(code, 'b2_android_hierarchy_timeout');
      assert.deepEqual(diagnostic, {
        expectedPhase: 'Background test ready',
        attempts: 1,
        lastValidHierarchy: {
          sha256: createHash('sha256')
            .update(Buffer.from(expectedHierarchy, 'utf8'))
            .digest('hex'),
          textCount: expectedTexts.length,
          matchedKnownPhase: 'Background test ready',
        },
        lastTransientCode: 'b2_android_hierarchy_deadline_reached',
      });
      return true;
    },
  );
});

test('production hierarchy gives API 36 cold readiness an exact 120 second deadline', async () => {
  assert.equal(B2_ANDROID_HIERARCHY_POLL_DEADLINE_MS, 120_000);
  const expectedHierarchy = hierarchyRecord('Background test ready').hierarchy;
  const scheduled = [];
  const cleared = [];
  const dependencies = createB2AndroidProductionDependencies({
    runId: 'default-deadline-1234',
    fs: productionTestFs(),
    env: {
      HOME: '/test-home',
      JAVA_HOME: '/java',
      ANDROID_HOME: '/sdk',
    },
    now: () => 0,
    scheduleHierarchyTimeout(callback, milliseconds) {
      const timer = { callback, milliseconds };
      scheduled.push(timer);
      return timer;
    },
    cancelHierarchyTimeout(timer) {
      timer.cleared = true;
      cleared.push(timer);
    },
    run: async (_command, args) => {
      const value = args.join(' ');
      if (value.includes('if [ -e ')) return successfulCommand('absent\n');
      if (value.includes('uiautomator dump')) {
        return successfulCommand(
          `UI hierchary dumped to: ${args.at(-1)}\n`,
        );
      }
      if (value.includes(' cat /sdcard/ks2-spelling-b2-window-')) {
        return successfulCommand(expectedHierarchy);
      }
      return successfulCommand();
    },
  });

  const result = await dependencies.waitForHierarchyPhase(
    'Background test ready',
  );

  assert.equal(result.phase, 'Background test ready');
  assert.deepEqual(
    scheduled.map(({ milliseconds }) => milliseconds),
    [120_000],
  );
  assert.deepEqual(cleared, scheduled);
  assert.equal(scheduled[0].cleared, true);
});

test('hierarchy polling accepts an expected phase just before deadline and clears its timer', async () => {
  const expectedHierarchy = hierarchyRecord('Background test ready').hierarchy;
  let currentTimeMs = 0;
  const timers = [];
  const clearedTimers = [];

  const result = await waitForB2AndroidHierarchyPhase({
    phase: 'Background test ready',
    deadlineMs: 5_000,
    now: () => currentTimeMs,
    scheduleTimeout(callback, milliseconds) {
      const timer = { callback, milliseconds };
      timers.push(timer);
      return timer;
    },
    cancelTimeout(timer) {
      clearedTimers.push(timer);
    },
    probe: async ({ signal, timeoutMs }) => {
      assert.ok(signal instanceof AbortSignal);
      assert.equal(timeoutMs, 5_000);
      currentTimeMs = 4_999;
      return successfulCommand(expectedHierarchy);
    },
    sleep: async () => undefined,
  });

  assert.equal(result.phase, 'Background test ready');
  assert.equal(timers.length, 1);
  assert.deepEqual(clearedTimers, timers);
});

test('hierarchy wall-clock timeout reports only sanitised null-root evidence', async () => {
  let currentTimeMs = 0;
  let probeCalls = 0;
  const sleeps = [];

  await assert.rejects(
    waitForB2AndroidHierarchyPhase({
      phase: 'Background test ready',
      deadlineMs: 5_000,
      now: () => currentTimeMs,
      probe: async () => {
        probeCalls += 1;
        currentTimeMs += 2_000;
        const error = new Error('transient raw diagnostic must not escape');
        error.code = 'b2_android_hierarchy_dump_not_ready';
        throw error;
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        currentTimeMs += milliseconds;
      },
    }),
    (error) => {
      assert.equal(error.code, 'b2_android_hierarchy_timeout');
      assert.deepEqual(error.diagnostic, {
        expectedPhase: 'Background test ready',
        attempts: 3,
        lastValidHierarchy: null,
        lastTransientCode: 'b2_android_hierarchy_dump_not_ready',
      });
      assert.doesNotMatch(
        `${error.message}${JSON.stringify(error.diagnostic)}`,
        /raw diagnostic must not escape/,
      );
      return true;
    },
  );

  assert.equal(probeCalls, 3);
  assert.deepEqual(sleeps, [100, 100]);
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

  const rawMachineXml = complete.replace(
    'class="android.widget.FrameLayout"',
    'class="android.widget.FrameLayout" password="false" token="machine-value"',
  );
  assert.equal(
    assertB2AndroidHierarchyPhase(rawMachineXml, 'B2 proof complete').phase,
    'B2 proof complete',
  );
  assert.throws(
    () =>
      parseB2AndroidHierarchyTexts(
        rawMachineXml
          .replace('password="false"', 'password=[REDACTED]')
          .replace('token="machine-value"', 'token=[REDACTED]'),
      ),
    ({ code }) => code === 'b2_android_hierarchy_xml_invalid',
  );
});

test('hierarchy polling rejects an unknown phase before clocks, probes or diagnostics', async () => {
  let clockCalls = 0;
  let probeCalls = 0;
  const secretPhase = 'secret-phase-do-not-disclose';
  await assert.rejects(
    waitForB2AndroidHierarchyPhase({
      phase: secretPhase,
      now: () => {
        clockCalls += 1;
        return 0;
      },
      probe: async () => {
        probeCalls += 1;
        return successfulCommand(hierarchyRecord('Background test ready').hierarchy);
      },
    }),
    (error) =>
      error instanceof TypeError &&
      error.diagnostic === undefined &&
      !error.message.includes(secretPhase),
  );
  assert.equal(clockCalls, 0);
  assert.equal(probeCalls, 0);
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

test('run-as collection rejects destination drift after rename and removes the owned set', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'b2-android-destination-drift-'));
  const destinationDirectory = join(directory, 'collected');
  let driftInjected = false;
  try {
    await assert.rejects(
      collectB2AndroidDatabaseSet({
        async listDatabaseFiles() {
          return B2_ANDROID_DATABASE_FILES.join('\n');
        },
        async assertTemporaryDirectoryAbsent() {},
        async createTemporaryDirectory() {},
        async copyToTemporaryDirectory() {},
        async pullTemporaryFile(filename) {
          return Buffer.from(`database-bytes:${filename}`);
        },
        async removeTemporaryDirectory() {},
        destinationDirectory,
        fs: {
          mkdir,
          readFile,
          rm,
          writeFile,
          async rename(source, destination) {
            await rename(source, destination);
            await writeFile(
              join(destination, B2_ANDROID_DATABASE_FILES[2]),
              Buffer.from('destination drift'),
            );
            driftInjected = true;
          },
        },
      }),
      ({ code }) => code === 'b2_android_database_destination_changed',
    );
    assert.equal(driftInjected, true, 'the final destination mutation must run');
    await assert.rejects(
      readdir(destinationDirectory),
      ({ code }) => code === 'ENOENT',
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
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

test('real lifecycle serialises a minimal pending proof that validates and rejects extras', async () => {
  const { dependencies } = createDependencies();
  const proof = await runB2AndroidLifecycleProof(dependencies);
  const screenshotBytes = Buffer.from('pending android screenshot');
  proof.screenshot.sha256 = createHash('sha256').update(screenshotBytes).digest('hex');
  const serialised = JSON.stringify({
    schemaVersion: 1,
    testedApplicationCommit: '1'.repeat(40),
    applicationFingerprint: '2'.repeat(64),
    proof,
  });
  assert.doesNotMatch(serialised, /"texts"/);
  const pending = JSON.parse(serialised);
  for (const phase of [
    pending.proof.background,
    pending.proof.ready,
    pending.proof.complete,
  ]) {
    assert.deepEqual(Object.keys(phase), [
      'phase',
      'hierarchySha256',
      'attempts',
      'hierarchy',
    ]);
  }
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
    (value) => { value.proof.background.texts = ['must never persist']; },
    (value) => { value.proof.complete.privateLearnerName = 'must never persist'; },
    (value) => {
      value.proof.background.hierarchy = value.proof.background.hierarchy
        .replace('Background test ready', 'Background test drifted');
      value.proof.background.hierarchySha256 = createHash('sha256')
        .update(Buffer.from(value.proof.background.hierarchy, 'utf8'))
        .digest('hex');
    },
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
  assert.doesNotMatch(source, /return\s*\{\s*\.\.\.output,\s*stdout:/);
  assert.doesNotMatch(source, /Promise\.race/);
});

async function executeJoinedAndroidRemoteCommand(args, options) {
  return runB2AndroidSubprocess('/bin/sh', ['-c', args.join(' ')], {
    ...options,
    timeoutMs: 2_000,
  });
}

test('remote sh scripts survive adb argv joining and preserve path ownership', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'b2-android-remote-shell-'));
  const bin = join(directory, 'bin');
  const hierarchyPath = 'hierarchy.xml';
  const runId = 'safe-runid-1234';
  const temporaryDirectory = `files/.b2-proof-export-${runId}`;
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const execute = (args) => executeJoinedAndroidRemoteCommand(args, {
    cwd: directory,
    env,
  });
  const hierarchyProbe = `if [ -e ${hierarchyPath} ]; then echo exists; else echo absent; fi`;
  const temporaryProbe = `if [ -e ${temporaryDirectory} ]; then echo exists; else echo absent; fi`;
  const createTemporary = `mkdir ${temporaryDirectory} && printf ${runId} > ${temporaryDirectory}/.owner`;
  const cleanupTemporary = `if [ ! -e ${temporaryDirectory} ]; then exit 0; elif [ "$(cat ${temporaryDirectory}/.owner 2>/dev/null)" = "${runId}" ]; then rm -rf ${temporaryDirectory}; else echo foreign-owned-temp >&2; exit 42; fi`;
  const runAs = (script) => [
    'run-as',
    'uk.eugnel.ks2spelling',
    ...b2AndroidRemoteShellArgs(script),
  ];
  try {
    await mkdir(bin, { recursive: true });
    await mkdir(join(directory, 'files'), { recursive: true });
    const fakeRunAs = join(bin, 'run-as');
    await writeFile(
      fakeRunAs,
      '#!/bin/sh\napplication=$1\nshift\n[ "$application" = uk.eugnel.ks2spelling ] || exit 64\nexec "$@"\n',
    );
    await chmod(fakeRunAs, 0o755);

    let result = await execute(b2AndroidRemoteShellArgs(hierarchyProbe));
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'absent\n');
    await writeFile(join(directory, hierarchyPath), 'owned hierarchy');
    result = await execute(b2AndroidRemoteShellArgs(hierarchyProbe));
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'exists\n');

    result = await execute(runAs(temporaryProbe));
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'absent\n');
    result = await execute(runAs(createTemporary));
    assert.equal(result.exitCode, 0);
    assert.equal(await readFile(join(directory, temporaryDirectory, '.owner'), 'utf8'), runId);
    result = await execute(runAs(cleanupTemporary));
    assert.equal(result.exitCode, 0);
    await assert.rejects(
      readdir(join(directory, temporaryDirectory)),
      ({ code }) => code === 'ENOENT',
    );

    await mkdir(join(directory, temporaryDirectory), { recursive: true });
    await writeFile(join(directory, temporaryDirectory, '.owner'), 'foreign-runid');
    result = await execute(runAs(cleanupTemporary));
    assert.equal(result.exitCode, 42);
    assert.match(result.stderr, /foreign-owned-temp/);
    assert.equal(
      await readFile(join(directory, temporaryDirectory, '.owner'), 'utf8'),
      'foreign-runid',
    );

    result = await execute(
      b2AndroidRemoteShellArgs(`printf '%s' "it's intact" > quoted.txt`),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(await readFile(join(directory, 'quoted.txt'), 'utf8'), "it's intact");
    result = await execute(
      b2AndroidRemoteShellArgs(
        `printf '%s' "safe'; touch injected; #" > untrusted-looking.txt`,
      ),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(
      await readFile(join(directory, 'untrusted-looking.txt'), 'utf8'),
      "safe'; touch injected; #",
    );
    await assert.rejects(
      readFile(join(directory, 'injected')),
      ({ code }) => code === 'ENOENT',
    );

    const source = await readFile(join(ROOT, 'scripts/prove-b2-android.mjs'), 'utf8');
    assert.doesNotMatch(source, /shellArgs\(\s*'sh',\s*'-c'/);
    assert.doesNotMatch(source, /runAs(?:Cleanup)?\(\s*'sh',\s*'-c'/);
    assert.equal((source.match(/['"]-c['"]/g) ?? []).length, 1);
    assert.match(source, /return \['sh', '-c', quotedScript\];/);
    assert.throws(
      () => createB2AndroidProductionDependencies({
        fs: productionTestFs(),
        env: {
          HOME: '/test-home',
          JAVA_HOME: '/java',
          ANDROID_HOME: '/sdk',
        },
        runId: "safe1234'; touch injected; #",
      }),
      /safe unique token/,
    );
    await assert.rejects(
      readFile(join(directory, 'injected')),
      ({ code }) => code === 'ENOENT',
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
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
      if (path.includes('/.native-build/b2/android-database-set/')) {
        const filename = path.split('/').at(-1);
        return Buffer.from(`bytes:${filename}`);
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
    if (serialised.includes('dumpsys activity activities')) {
      return successfulCommand(
        'mResumedActivity: ActivityRecord{abc u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity t2}\n',
      );
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
  await dependencies.waitForApplicationBackgrounded();
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
  assert.ok(
    commands.some(
      ([command, args]) =>
        command === adb &&
        args.join(' ') ===
          '-s emulator-5580 shell dumpsys activity activities',
    ),
  );
  assert.ok(commands.every(([, , timeoutMs]) => Number.isSafeInteger(timeoutMs)));
});

function createBackgroundActivityHarness({ results, sleep = async () => undefined }) {
  const commands = [];
  let probes = 0;
  const dependencies = createB2AndroidProductionDependencies({
    run: async (_command, args) => {
      const command = args.join(' ');
      commands.push(command);
      if (command.includes('dumpsys activity activities')) {
        const result = results[Math.min(probes, results.length - 1)];
        probes += 1;
        return typeof result === 'string' ? successfulCommand(result) : result;
      }
      return successfulCommand();
    },
    fs: productionTestFs(),
    sleep,
    signalSource: new EventEmitter(),
    env: {
      HOME: '/test-home',
      JAVA_HOME: '/java',
      ANDROID_HOME: '/sdk',
    },
  });
  return {
    commands,
    dependencies,
    probeCount: () => probes,
  };
}

test('production adapter waits for raw foreign-package activity before resume launch', async () => {
  const ownRaw =
    'mResumedActivity: ActivityRecord{abc u0 uk.eugnel.ks2spelling/.MainActivity t42}\n';
  const foreignRaw =
    'topResumedActivity=ActivityRecord{def u0 com.google.android.apps.nexuslauncher/com.google.android.apps.nexuslauncher.NexusLauncherActivity t2}\n';
  const sleeps = [];
  const { commands, dependencies, probeCount } = createBackgroundActivityHarness({
    results: [
      successfulCommand(
        'mResumedActivity: ActivityRecord{redacted u0 foreign.example/.Fake t1}\n',
        Buffer.from(ownRaw),
      ),
      successfulCommand('[REDACTED]\n', Buffer.from(foreignRaw)),
    ],
    sleep: async (milliseconds) => sleeps.push(milliseconds),
  });

  assert.equal(await dependencies.waitForApplicationBackgrounded(), undefined);
  assert.equal(
    commands.some((command) => command.includes(' shell am start ')),
    false,
  );
  await dependencies.relaunchForResume();

  assert.equal(probeCount(), 2);
  assert.deepEqual(sleeps, [100]);
  assert.ok(commands.at(-1).includes(' shell am start -n '));
});

test('background acknowledgement treats every same-package Activity as foreground', async () => {
  for (const resumedActivity of [
    'uk.eugnel.ks2spelling/uk.eugnel.ks2spelling.MainActivity',
    'uk.eugnel.ks2spelling/.SettingsActivity',
    'uk.eugnel.ks2spelling/example.shared.ExternalActivity',
  ]) {
    const { commands, dependencies, probeCount } = createBackgroundActivityHarness({
      results: [
        `mResumedActivity: ActivityRecord{abc u0 ${resumedActivity} t42}\n`,
      ],
    });
    await assert.rejects(
      dependencies.waitForApplicationBackgrounded(),
      ({ code }) => code === 'b2_android_background_timeout',
    );
    assert.equal(probeCount(), 50);
    assert.equal(
      commands.some((command) => command.includes(' shell am start ')),
      false,
    );
  }
});

test('background acknowledgement rejects malformed, conflicting and non-empty stderr authority', async (t) => {
  const scenarios = [
    {
      name: 'malformed authority',
      result: successfulCommand('mResumedActivity: null\n'),
    },
    {
      name: 'conflicting authorities',
      result: successfulCommand(
        'mResumedActivity: ActivityRecord{abc u0 uk.eugnel.ks2spelling/.MainActivity t42}\n' +
          'topResumedActivity=ActivityRecord{def u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity t2}\n',
      ),
    },
    {
      name: 'raw stderr is not exactly empty',
      result: {
        ...successfulCommand(
          'mResumedActivity: ActivityRecord{abc u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity t2}\n',
        ),
        stderr: '',
        stderrBytes: Buffer.from('\n'),
      },
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const { dependencies, probeCount } = createBackgroundActivityHarness({
        results: [scenario.result],
      });
      await assert.rejects(
        dependencies.waitForApplicationBackgrounded(),
        ({ code }) => code === 'b2_android_resumed_activity_invalid',
      );
      assert.equal(probeCount(), 1);
    });
  }
});

test('background acknowledgement rejects invalid raw UTF-8 before resume launch', async () => {
  const { commands, dependencies, probeCount } = createBackgroundActivityHarness({
    results: [{
      ...successfulCommand(
        'mResumedActivity: ActivityRecord{abc u0 foreign.example/.Fake t1}\n',
      ),
      stdoutBytes: Uint8Array.from([0xc3, 0x28]),
    }],
  });
  await assert.rejects(
    dependencies.waitForApplicationBackgrounded(),
    ({ code }) => code === 'b2_android_machine_output_invalid',
  );
  assert.equal(probeCount(), 1);
  assert.equal(
    commands.some((command) => command.includes(' shell am start ')),
    false,
  );
});

test('parent abort unwinds background polling before owned cleanup and never resumes', async () => {
  const signalSource = new EventEmitter();
  const events = [];
  let acknowledgeSleepStarted;
  const sleepStarted = new Promise((resolve) => {
    acknowledgeSleepStarted = resolve;
  });
  const { commands, dependencies } = createBackgroundActivityHarness({
    results: [
      'mResumedActivity: ActivityRecord{abc u0 uk.eugnel.ks2spelling/.MainActivity t42}\n',
    ],
    sleep: async (_milliseconds, signal) => {
      events.push('background-poll-sleep');
      acknowledgeSleepStarted();
      await new Promise((resolve) => {
        signal.addEventListener('abort', resolve, { once: true });
      });
      events.push('background-poll-unwound');
      signal.throwIfAborted();
    },
  });
  const proof = runWithB2AndroidOwnedCleanup({
    signalSource,
    work: async ({ signal, ownSerial }) => {
      ownSerial('emulator-5580');
      await dependencies.pressHome({ signal });
      await dependencies.waitForApplicationBackgrounded({ signal });
      await dependencies.relaunchForResume({ signal });
    },
    killOwnedSerial: async (serial) => events.push(`cleanup:${serial}`),
    terminateProcessGroup: async () => assert.fail('serial cleanup is authoritative'),
  });

  await sleepStarted;
  signalSource.emit('SIGTERM');
  await assert.rejects(
    proof,
    ({ code }) => code === 'b2_android_signal_interrupted',
  );
  assert.deepEqual(events, [
    'background-poll-sleep',
    'background-poll-unwound',
    'cleanup:emulator-5580',
  ]);
  assert.ok(
    commands.findIndex((command) => command.includes('input keyevent KEYCODE_HOME')) <
      commands.findIndex((command) => command.includes('dumpsys activity activities')),
  );
  assert.equal(
    commands.some((command) => command.includes(' shell am start ')),
    false,
  );
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

test('Android fresh install proves API 36 package absence before accepting failed uninstall', async () => {
  const fs = productionTestFs();
  const env = {
    HOME: '/test-home',
    JAVA_HOME: '/java',
    ANDROID_HOME: '/sdk',
  };
  const commandResult = ({ exitCode = 0, stdout = '', stderr = '' } = {}) => ({
    ...successfulCommand(stdout),
    exitCode,
    stdoutBytes: Buffer.from(stdout),
    stderr,
    stderrBytes: Buffer.from(stderr),
  });
  const exactApi36MissingUninstall = commandResult({
    exitCode: 1,
    stdout: 'Failure [DELETE_FAILED_INTERNAL_ERROR]\n',
  });
  const exactAbsentPackageList = commandResult();
  const exactAbsentPackagePath = commandResult({ exitCode: 1 });
  const exactPresentPackageList = commandResult({
    stdout: 'package:uk.eugnel.ks2spelling\n',
  });
  const exactPresentPackagePath = commandResult({
    stdout: 'package:/data/app/~~token/uk.eugnel.ks2spelling-token/base.apk\n',
  });
  const runFreshInstall = async ({
    uninstall = exactApi36MissingUninstall,
    packageList = exactAbsentPackageList,
    packagePath = exactAbsentPackagePath,
  } = {}) => {
    const commands = [];
    const dependencies = createB2AndroidProductionDependencies({
      fs,
      env,
      sleep: async () => undefined,
      run: async (_command, args) => {
        commands.push(args.join(' '));
        if (args.includes('uninstall')) return uninstall;
        if (args.includes('list') && args.includes('packages')) return packageList;
        if (args.includes('path')) return packagePath;
        if (args.includes('pidof')) return successfulCommand('321\n');
        return successfulCommand();
      },
    });
    try {
      const launch = await dependencies.freshInstallAndLaunch({
        apkPath: '/tmp/app-debug.apk',
      });
      return { commands, launch, error: null };
    } catch (error) {
      return { commands, launch: null, error };
    }
  };

  const allowed = await runFreshInstall();
  assert.equal(allowed.error, null);
  assert.equal(allowed.launch.pid, '321');
  assert.deepEqual(allowed.commands.slice(0, 3), [
    '-s emulator-5580 uninstall uk.eugnel.ks2spelling',
    '-s emulator-5580 shell pm list packages --user 0 uk.eugnel.ks2spelling',
    '-s emulator-5580 shell pm path uk.eugnel.ks2spelling',
  ]);
  assert.ok(allowed.commands.some((value) => value.includes(' install ')));

  const present = await runFreshInstall({
    packageList: exactPresentPackageList,
    packagePath: exactPresentPackagePath,
  });
  assert.equal(present.error?.code, 'b2_android_uninstall_failed_application_present');
  assert.equal(
    present.commands.some((value) => value.includes(' install ')),
    false,
  );

  const falseDiagnostic = await runFreshInstall({
    uninstall: commandResult({ exitCode: 1, stdout: 'Unknown package\n' }),
    packageList: exactPresentPackageList,
    packagePath: exactPresentPackagePath,
  });
  assert.equal(
    falseDiagnostic.error?.code,
    'b2_android_uninstall_failed_application_present',
  );
  assert.equal(
    falseDiagnostic.commands.some((value) => value.includes(' install ')),
    false,
  );

  const invalidUtf8Uninstall = await runFreshInstall({
    uninstall: {
      ...exactApi36MissingUninstall,
      stdoutBytes: Uint8Array.from([0xc3, 0x28]),
    },
  });
  assert.equal(invalidUtf8Uninstall.error?.code, 'b2_android_machine_output_invalid');
  assert.deepEqual(invalidUtf8Uninstall.commands, [
    '-s emulator-5580 uninstall uk.eugnel.ks2spelling',
  ]);

  for (const authority of [
    { packageList: commandResult({ stdout: 'package:other.application\n' }) },
    { packageList: commandResult({ exitCode: 1 }) },
    { packageList: commandResult({ stderr: 'warning\n' }) },
    { packagePath: commandResult({ exitCode: 0 }) },
    { packagePath: commandResult({ exitCode: 1, stdout: 'missing\n' }) },
    { packagePath: commandResult({ stdout: 'package:relative/base.apk\n' }) },
    {
      packagePath: {
        ...exactAbsentPackagePath,
        stdoutBytes: Uint8Array.from([0xc3, 0x28]),
      },
    },
    {
      packageList: exactAbsentPackageList,
      packagePath: exactPresentPackagePath,
    },
  ]) {
    const rejected = await runFreshInstall(authority);
    assert.equal(rejected.error?.code, 'b2_android_uninstall_absence_unproven');
    assert.ok(rejected.error?.cause instanceof AggregateError);
    assert.equal(
      rejected.commands.some((value) => value.includes(' install ')),
      false,
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
      if (value.includes('mkdir files/.b2-proof-export-interrupted-proof-1234')) {
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
  const rawFreshHierarchy = hierarchy.hierarchy.replace(
    'class="android.widget.FrameLayout"',
    'class="android.widget.FrameLayout" password="false" token="machine-value"',
  );
  const redactedFreshHierarchy = rawFreshHierarchy
    .replace('password="false"', 'password=[REDACTED]')
    .replace('token="machine-value"', 'token=[REDACTED]');
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
    if (value.includes('uiautomator dump')) {
      return successfulCommand(`UI hierchary dumped to: ${args.at(-1)}\n`);
    }
    if (value.includes(' cat /sdcard/ks2-spelling-b2-window-')) {
      return successfulCommand(
        redactedFreshHierarchy,
        Buffer.from(rawFreshHierarchy),
      );
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
  assert.doesNotMatch(
    JSON.stringify(captured),
    /machine-value|password="false"|token="machine-value"/,
  );
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

test('foreground hierarchy rejects invalid raw UTF-8 and cleans without leaking diagnostics', async () => {
  const hierarchy = hierarchyRecord('B2 proof complete');
  const commands = [];
  const dependencies = createB2AndroidProductionDependencies({
    runId: 'invalid-capture-utf8-1234',
    fs: productionTestFs(),
    env: {
      HOME: '/test-home',
      JAVA_HOME: '/java',
      ANDROID_HOME: '/sdk',
    },
    sleep: async () => undefined,
    run: async (_command, args) => {
      const value = args.join(' ');
      commands.push(value);
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
      if (value.includes('uiautomator dump')) {
        return successfulCommand(`UI hierchary dumped to: ${args.at(-1)}\n`);
      }
      if (value.includes(' cat /sdcard/ks2-spelling-b2-window-')) {
        return successfulCommand(
          'password=[REDACTED] token=[REDACTED]',
          Uint8Array.from([0xc3, 0x28]),
        );
      }
      return successfulCommand();
    },
  });

  await assert.rejects(
    dependencies.captureForegroundEvidence({ pid: '202', hierarchy }),
    ({ code, message }) =>
      code === 'b2_android_machine_output_invalid' &&
      !/password|token|REDACTED/.test(message),
  );
  assert.equal(
    commands.filter((value) => value.includes(' rm -f ')).length,
    1,
  );
  assert.equal(commands.some((value) => value.includes('screencap')), false);
});

test('production hierarchy waits for delayed API 36 output and cleans the exact owned path', async () => {
  const hierarchy = hierarchyRecord('B2 proof complete');
  const remotePath =
    '/sdcard/ks2-spelling-b2-window-delayed-hierarchy-1234.xml';
  const commands = [];
  const sleeps = [];
  let catAttempts = 0;
  const dependencies = createB2AndroidProductionDependencies({
    runId: 'delayed-hierarchy-1234',
    fs: productionTestFs(),
    env: {
      HOME: '/test-home',
      JAVA_HOME: '/java',
      ANDROID_HOME: '/sdk',
    },
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    run: async (_command, args) => {
      const value = args.join(' ');
      commands.push(value);
      if (value.includes('if [ -e ')) return successfulCommand('absent\n');
      if (value.includes('uiautomator dump')) {
        return successfulCommand(`UI hierchary dumped to: ${remotePath}\n`);
      }
      if (value.includes(` cat ${remotePath}`)) {
        catAttempts += 1;
        if (catAttempts === 1) {
          return {
            ...successfulCommand(),
            exitCode: 1,
            stderr: `cat: ${remotePath}: No such file or directory\n`,
            stderrBytes: Buffer.from(
              `cat: ${remotePath}: No such file or directory\n`,
            ),
          };
        }
        return successfulCommand(hierarchy.hierarchy);
      }
      return successfulCommand();
    },
  });

  const result = await dependencies.waitForHierarchyPhase('B2 proof complete');
  assert.equal(result.phase, 'B2 proof complete');
  assert.equal(catAttempts, 2);
  assert.deepEqual(sleeps, [50]);
  assert.equal(
    commands.filter((value) => value.includes('uiautomator dump')).length,
    1,
  );
  assert.equal(
    commands.filter((value) => value.includes(` rm -f ${remotePath}`)).length,
    1,
  );
});

test('production hierarchy rejects API 36 output redirection and still cleans only its path', async () => {
  const remotePath =
    '/sdcard/ks2-spelling-b2-window-redirected-hierarchy-1234.xml';
  const commands = [];
  const dependencies = createB2AndroidProductionDependencies({
    runId: 'redirected-hierarchy-1234',
    fs: productionTestFs(),
    env: {
      HOME: '/test-home',
      JAVA_HOME: '/java',
      ANDROID_HOME: '/sdk',
    },
    sleep: async () => undefined,
    run: async (_command, args) => {
      const value = args.join(' ');
      commands.push(value);
      if (value.includes('if [ -e ')) return successfulCommand('absent\n');
      if (value.includes('uiautomator dump')) {
        return successfulCommand(
          'UI hierchary dumped to: /sdcard/window_dump.xml\n',
        );
      }
      return successfulCommand();
    },
  });

  await assert.rejects(
    dependencies.waitForHierarchyPhase('B2 proof complete'),
    ({ code }) => code === 'b2_android_hierarchy_output_redirected',
  );
  assert.equal(commands.some((value) => value.includes(` cat ${remotePath}`)), false);
  assert.equal(
    commands.filter((value) => value.includes(` rm -f ${remotePath}`)).length,
    1,
  );
  assert.equal(
    commands.some((value) => value.includes('rm -f /sdcard/window_dump.xml')),
    false,
  );
});

test('production hierarchy bounds missing output polling and cleans on timeout', async () => {
  const remotePath = '/sdcard/ks2-spelling-b2-window-missing-output-1234.xml';
  const commands = [];
  const sleeps = [];
  const dependencies = createB2AndroidProductionDependencies({
    runId: 'missing-output-1234',
    fs: productionTestFs(),
    env: {
      HOME: '/test-home',
      JAVA_HOME: '/java',
      ANDROID_HOME: '/sdk',
    },
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    run: async (_command, args) => {
      const value = args.join(' ');
      commands.push(value);
      if (value.includes('if [ -e ')) return successfulCommand('absent\n');
      if (value.includes('uiautomator dump')) {
        return successfulCommand(`UI hierchary dumped to: ${remotePath}\n`);
      }
      if (value.includes(` cat ${remotePath}`)) {
        return {
          ...successfulCommand(),
          exitCode: 1,
          stderr: `cat: ${remotePath}: No such file or directory\n`,
          stderrBytes: Buffer.from(
            `cat: ${remotePath}: No such file or directory\n`,
          ),
        };
      }
      return successfulCommand();
    },
  });

  await assert.rejects(
    dependencies.waitForHierarchyPhase('B2 proof complete'),
    ({ code }) => code === 'b2_android_hierarchy_output_timeout',
  );
  assert.equal(
    commands.filter((value) => value.includes(` cat ${remotePath}`)).length,
    20,
  );
  assert.deepEqual(sleeps, Array(19).fill(50));
  assert.equal(
    commands.filter((value) => value.includes(` rm -f ${remotePath}`)).length,
    1,
  );
});

function hierarchyOutputHarness({
  runId,
  dumpResult,
  catResults = [],
  sleep = async () => undefined,
  hierarchyDeadlineMs,
  now,
}) {
  const remotePath = `/sdcard/ks2-spelling-b2-window-${runId}.xml`;
  const commands = [];
  let dumpIndex = 0;
  let catIndex = 0;
  const machineResult = (result) => {
    const preserve = result?.preserveMachineBytes === true;
    const normalised = { ...result };
    delete normalised.preserveMachineBytes;
    return {
      ...normalised,
      stdoutBytes: preserve
        ? normalised.stdoutBytes
        : Buffer.from(normalised.stdout ?? ''),
      stderrBytes: preserve
        ? normalised.stderrBytes
        : Buffer.from(normalised.stderr ?? ''),
    };
  };
  const dependencies = createB2AndroidProductionDependencies({
    runId,
    fs: productionTestFs(),
    env: {
      HOME: '/test-home',
      JAVA_HOME: '/java',
      ANDROID_HOME: '/sdk',
    },
    sleep,
    hierarchyDeadlineMs,
    now,
    run: async (_command, args) => {
      const value = args.join(' ');
      commands.push(value);
      if (value.includes('if [ -e ')) return successfulCommand('absent\n');
      if (value.includes('uiautomator dump')) {
        const result = dumpResult(remotePath, dumpIndex);
        dumpIndex += 1;
        return machineResult(result);
      }
      if (value.includes(` cat ${remotePath}`)) {
        const result = catResults[Math.min(catIndex, catResults.length - 1)];
        catIndex += 1;
        return machineResult(
          typeof result === 'function' ? result(remotePath) : result,
        );
      }
      return successfulCommand();
    },
  });
  return { commands, dependencies, remotePath };
}

test('production hierarchy accepts only exact byte-equivalent dump reports', async (t) => {
  await t.test('diagnosis-observed stdout fixture', async () => {
    const hierarchy = hierarchyRecord('B2 proof complete').hierarchy;
    const { commands, dependencies, remotePath } = hierarchyOutputHarness({
      runId: 'observed-report-1234',
      dumpResult: (path) => successfulCommand(
        `UI hierchary dumped to: ${path}\n`,
      ),
      catResults: [successfulCommand(hierarchy)],
    });
    await assert.doesNotReject(
      dependencies.waitForHierarchyPhase('B2 proof complete'),
    );
    assert.equal(
      commands.filter((value) => value.includes(` rm -f ${remotePath}`)).length,
      1,
    );
  });

  await t.test('byte-equivalent duplicate across streams', async () => {
    const hierarchy = hierarchyRecord('B2 proof complete').hierarchy;
    const { commands, dependencies, remotePath } = hierarchyOutputHarness({
      runId: 'duplicate-same-1234',
      dumpResult: (path) => {
        const report = `UI hierchary dumped to: ${path}\n`;
        return { ...successfulCommand(report), stderr: report };
      },
      catResults: [successfulCommand(hierarchy)],
    });
    await assert.doesNotReject(
      dependencies.waitForHierarchyPhase('B2 proof complete'),
    );
    assert.equal(
      commands.filter((value) => value.includes(` rm -f ${remotePath}`)).length,
      1,
    );
  });

  for (const scenario of [
    {
      name: 'missing report',
      runId: 'missing-report-1234',
      result: () => successfulCommand('dump complete\n'),
      code: 'b2_android_hierarchy_output_report_invalid',
    },
    {
      name: 'duplicate distinct reports',
      runId: 'duplicate-distinct-1234',
      result: (remotePath) => ({
        ...successfulCommand(`UI hierchary dumped to: ${remotePath}\n`),
        stderr: 'UI hierchary dumped to: /sdcard/window_dump.xml\n',
      }),
      code: 'b2_android_hierarchy_output_report_invalid',
    },
    {
      name: 'extra malformed diagnostic',
      runId: 'extra-report-text-1234',
      result: (remotePath) => successfulCommand(
        `UI hierchary dumped to: ${remotePath}\nunexpected diagnostic\n`,
      ),
      code: 'b2_android_hierarchy_output_report_invalid',
    },
    {
      name: 'redirected report',
      runId: 'foreign-report-1234',
      result: () => successfulCommand(
        'UI hierchary dumped to: /sdcard/window_dump.xml\n',
      ),
      code: 'b2_android_hierarchy_output_redirected',
    },
  ]) {
    await t.test(scenario.name, async () => {
      const { commands, dependencies, remotePath } = hierarchyOutputHarness({
        runId: scenario.runId,
        dumpResult: scenario.result,
        catResults: [successfulCommand(hierarchyRecord('B2 proof complete').hierarchy)],
      });
      await assert.rejects(
        dependencies.waitForHierarchyPhase('B2 proof complete'),
        ({ code }) => code === scenario.code,
      );
      assert.equal(
        commands.some((value) => value.includes(` cat ${remotePath}`)),
        false,
      );
      assert.equal(
        commands.filter((value) => value.includes(` rm -f ${remotePath}`)).length,
        1,
      );
      assert.equal(
        commands.some((value) => value.includes('rm -f /sdcard/window_dump.xml')),
        false,
      );
    });
  }
});

test('production hierarchy parses raw XML bytes instead of redacted diagnostics', async () => {
  const rawHierarchy = hierarchyRecord('B2 proof complete').hierarchy.replace(
    'class="android.widget.FrameLayout"',
    'class="android.widget.FrameLayout" password="false" token="machine-value"',
  );
  const redactedHierarchy = rawHierarchy
    .replace('password="false"', 'password=[REDACTED]')
    .replace('token="machine-value"', 'token=[REDACTED]');
  const { commands, dependencies, remotePath } = hierarchyOutputHarness({
    runId: 'raw-machine-xml-1234',
    dumpResult: (path) =>
      successfulCommand(`UI hierchary dumped to: ${path}\n`),
    catResults: [{
      ...successfulCommand(redactedHierarchy),
      stdoutBytes: Buffer.from(rawHierarchy),
      preserveMachineBytes: true,
    }],
  });

  await assert.doesNotReject(
    dependencies.waitForHierarchyPhase('B2 proof complete'),
  );
  assert.equal(
    commands.filter((value) => value.includes(` rm -f ${remotePath}`)).length,
    1,
  );
});

test('production hierarchy rejects invalid UTF-8 machine bytes and cleans its path', async () => {
  const redactedHierarchy = hierarchyRecord('B2 proof complete').hierarchy;
  const { commands, dependencies, remotePath } = hierarchyOutputHarness({
    runId: 'invalid-machine-xml-1234',
    dumpResult: (path) =>
      successfulCommand(`UI hierchary dumped to: ${path}\n`),
    catResults: [{
      ...successfulCommand(redactedHierarchy),
      stdoutBytes: Uint8Array.from([0xc3, 0x28]),
      preserveMachineBytes: true,
    }],
  });

  await assert.rejects(
    dependencies.waitForHierarchyPhase('B2 proof complete'),
    ({ code }) => code === 'b2_android_machine_output_invalid',
  );
  assert.equal(
    commands.filter((value) => value.includes(` rm -f ${remotePath}`)).length,
    1,
  );
});

test('production hierarchy retries only the exact API 36 null-root fixture', async () => {
  const sleeps = [];
  const hierarchy = hierarchyRecord('B2 proof complete').hierarchy;
  const { commands, dependencies, remotePath } = hierarchyOutputHarness({
    runId: 'null-root-retry-1234',
    dumpResult: (path, index) =>
      index === 0
        ? {
            ...successfulCommand(),
            stderr: 'ERROR: null root node returned by UiTestAutomationBridge.\n',
          }
        : successfulCommand(`UI hierchary dumped to: ${path}\n`),
    catResults: [successfulCommand(hierarchy)],
    sleep: async (milliseconds) => sleeps.push(milliseconds),
  });

  const result = await dependencies.waitForHierarchyPhase('B2 proof complete');
  assert.equal(result.phase, 'B2 proof complete');
  assert.deepEqual(sleeps, [100]);
  assert.equal(
    commands.filter((value) => value.includes('uiautomator dump')).length,
    2,
  );
  assert.equal(
    commands.filter((value) => value.includes(` rm -f ${remotePath}`)).length,
    2,
  );
});

test('production hierarchy bounds repeated API 36 null-root results', async () => {
  const sleeps = [];
  let currentTimeMs = 0;
  const { commands, dependencies, remotePath } = hierarchyOutputHarness({
    runId: 'null-root-timeout-1234',
    dumpResult: () => {
      currentTimeMs += 2_000;
      return {
        ...successfulCommand(),
        stderr: 'ERROR: null root node returned by UiTestAutomationBridge.\n',
      };
    },
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      currentTimeMs += milliseconds;
    },
    hierarchyDeadlineMs: 5_000,
    now: () => currentTimeMs,
  });

  await assert.rejects(
    dependencies.waitForHierarchyPhase('B2 proof complete'),
    ({ code, diagnostic }) =>
      code === 'b2_android_hierarchy_timeout' &&
      diagnostic.attempts === 3 &&
      diagnostic.lastValidHierarchy === null &&
      diagnostic.lastTransientCode === 'b2_android_hierarchy_dump_not_ready',
  );
  assert.equal(
    commands.filter((value) => value.includes('uiautomator dump')).length,
    3,
  );
  assert.deepEqual(sleeps, [100, 100]);
  assert.equal(
    commands.filter((value) => value.includes(` rm -f ${remotePath}`)).length,
    3,
  );
});

test('production hierarchy aborts between exact API 36 null-root retries', async () => {
  const controller = new AbortController();
  const abortReason = new Error('abort null-root hierarchy retry');
  const { commands, dependencies, remotePath } = hierarchyOutputHarness({
    runId: 'null-root-abort-1234',
    dumpResult: () => ({
      ...successfulCommand(),
      stderr: 'ERROR: null root node returned by UiTestAutomationBridge.\n',
    }),
    sleep: async () => {
      controller.abort(abortReason);
      controller.signal.throwIfAborted();
    },
  });

  await assert.rejects(
    dependencies.waitForHierarchyPhase('B2 proof complete', {
      signal: controller.signal,
    }),
    (error) => error === abortReason,
  );
  assert.equal(
    commands.filter((value) => value.includes('uiautomator dump')).length,
    1,
  );
  assert.equal(
    commands.filter((value) => value.includes(` rm -f ${remotePath}`)).length,
    1,
  );
});

test('active hierarchy deadline aborts its subprocess and awaits owned cleanup', async () => {
  const runId = 'active-deadline-1234';
  const remotePath = `/sdcard/ks2-spelling-b2-window-${runId}.xml`;
  const events = [];
  const timers = [];
  let currentTimeMs = 0;
  const dependencies = createB2AndroidProductionDependencies({
    runId,
    fs: productionTestFs(),
    env: {
      HOME: '/test-home',
      JAVA_HOME: '/java',
      ANDROID_HOME: '/sdk',
    },
    hierarchyDeadlineMs: 5_000,
    now: () => currentTimeMs,
    scheduleHierarchyTimeout(callback, milliseconds) {
      const timer = { callback, milliseconds };
      timers.push(timer);
      return timer;
    },
    cancelHierarchyTimeout(timer) {
      events.push('timer-cleared');
      timer.cleared = true;
    },
    run: async (_command, args, options) => {
      const value = args.join(' ');
      if (value.includes('if [ -e ')) return successfulCommand('absent\n');
      if (value.includes('uiautomator dump')) {
        return new Promise((resolveProbe) => {
          assert.ok(options.signal instanceof AbortSignal);
          options.signal.addEventListener('abort', () => {
            events.push('probe-aborted');
            resolveProbe({
              ...successfulCommand(),
              exitCode: null,
              aborted: true,
              abortReason: options.signal.reason,
            });
          }, { once: true });
          const timer = timers.at(-1);
          currentTimeMs += timer.milliseconds;
          timer.callback();
        });
      }
      if (value.includes(` rm -f ${remotePath}`)) {
        events.push('owned-path-cleaned');
        return successfulCommand();
      }
      return successfulCommand();
    },
  });

  await assert.rejects(
    dependencies.waitForHierarchyPhase('B2 proof complete'),
    ({ code, diagnostic }) => {
      events.push('timeout-returned');
      return (
        code === 'b2_android_hierarchy_timeout' &&
        diagnostic.attempts === 1 &&
        diagnostic.lastTransientCode === 'b2_android_hierarchy_deadline_reached'
      );
    },
  );
  assert.deepEqual(events, [
    'probe-aborted',
    'owned-path-cleaned',
    'timer-cleared',
    'timeout-returned',
  ]);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].cleared, true);
});

test('parent abort remains authoritative during an active hierarchy probe', async () => {
  const runId = 'active-parent-abort-1234';
  const remotePath = `/sdcard/ks2-spelling-b2-window-${runId}.xml`;
  const controller = new AbortController();
  const abortReason = new Error('parent hierarchy abort');
  const events = [];
  const dependencies = createB2AndroidProductionDependencies({
    runId,
    fs: productionTestFs(),
    env: {
      HOME: '/test-home',
      JAVA_HOME: '/java',
      ANDROID_HOME: '/sdk',
    },
    hierarchyDeadlineMs: 5_000,
    now: () => 0,
    scheduleHierarchyTimeout(callback, milliseconds) {
      return { callback, milliseconds };
    },
    cancelHierarchyTimeout() {
      events.push('timer-cleared');
    },
    run: async (_command, args, options) => {
      const value = args.join(' ');
      if (value.includes('if [ -e ')) return successfulCommand('absent\n');
      if (value.includes('uiautomator dump')) {
        return new Promise((resolveProbe) => {
          assert.ok(options.signal instanceof AbortSignal);
          options.signal.addEventListener('abort', () => {
            events.push('probe-aborted');
            resolveProbe({
              ...successfulCommand(),
              exitCode: null,
              aborted: true,
              abortReason: options.signal.reason,
            });
          }, { once: true });
          controller.abort(abortReason);
        });
      }
      if (value.includes(` rm -f ${remotePath}`)) {
        events.push('owned-path-cleaned');
        return successfulCommand();
      }
      return successfulCommand();
    },
  });

  await assert.rejects(
    dependencies.waitForHierarchyPhase('B2 proof complete', {
      signal: controller.signal,
    }),
    (error) => error === abortReason,
  );
  assert.deepEqual(events, [
    'probe-aborted',
    'owned-path-cleaned',
    'timer-cleared',
  ]);
});

test('production hierarchy retries only exact empty and exact owned ENOENT results', async (t) => {
  const exactHierarchy = successfulCommand(
    hierarchyRecord('B2 proof complete').hierarchy,
  );
  for (const scenario of [
    {
      name: 'foreign ENOENT',
      runId: 'foreign-enoent-1234',
      result: () => ({
        ...successfulCommand(),
        exitCode: 1,
        stderr: 'cat: /sdcard/foreign.xml: No such file or directory\n',
      }),
    },
    {
      name: 'permission denied',
      runId: 'permission-denied-1234',
      result: (remotePath) => ({
        ...successfulCommand(),
        exitCode: 1,
        stderr: `cat: ${remotePath}: Permission denied\n`,
      }),
    },
    {
      name: 'mixed stdout and ENOENT',
      runId: 'mixed-output-1234',
      result: (remotePath) => ({
        ...successfulCommand('unexpected stdout\n'),
        exitCode: 1,
        stderr: `cat: ${remotePath}: No such file or directory\n`,
      }),
    },
    {
      name: 'additional ENOENT diagnosis',
      runId: 'extra-diagnosis-1234',
      result: (remotePath) => ({
        ...successfulCommand(),
        exitCode: 1,
        stderr: `cat: ${remotePath}: No such file or directory\nadditional error\n`,
      }),
    },
    {
      name: 'subprocess timeout',
      runId: 'probe-timeout-1234',
      result: () => ({
        ...successfulCommand(),
        exitCode: null,
        timedOut: true,
      }),
    },
  ]) {
    await t.test(scenario.name, async () => {
      const sleeps = [];
      const { commands, dependencies, remotePath } = hierarchyOutputHarness({
        runId: scenario.runId,
        dumpResult: (path) =>
          successfulCommand(`UI hierchary dumped to: ${path}\n`),
        catResults: [scenario.result],
        sleep: async (milliseconds) => sleeps.push(milliseconds),
      });
      await assert.rejects(
        dependencies.waitForHierarchyPhase('B2 proof complete'),
        ({ code }) => code === 'b2_android_hierarchy_output_failed',
      );
      assert.deepEqual(sleeps, []);
      assert.equal(
        commands.filter((value) => value.includes(` cat ${remotePath}`)).length,
        1,
      );
      assert.equal(
        commands.filter((value) => value.includes(` rm -f ${remotePath}`)).length,
        1,
      );
    });
  }

  await t.test('empty stdout and stderr', async () => {
    const sleeps = [];
    const { commands, dependencies, remotePath } = hierarchyOutputHarness({
      runId: 'empty-output-1234',
      dumpResult: (path) =>
        successfulCommand(`UI hierchary dumped to: ${path}\n`),
      catResults: [successfulCommand(), exactHierarchy],
      sleep: async (milliseconds) => sleeps.push(milliseconds),
    });
    await assert.doesNotReject(
      dependencies.waitForHierarchyPhase('B2 proof complete'),
    );
    assert.deepEqual(sleeps, [50]);
    assert.equal(
      commands.filter((value) => value.includes(` cat ${remotePath}`)).length,
      2,
    );
    assert.equal(
      commands.filter((value) => value.includes(` rm -f ${remotePath}`)).length,
      1,
    );
  });
});

test('production hierarchy aborts output polling and cleans the exact owned path', async () => {
  const controller = new AbortController();
  const abortReason = new Error('abort hierarchy output probe');
  const { commands, dependencies, remotePath } = hierarchyOutputHarness({
    runId: 'abort-output-1234',
    dumpResult: (path) =>
      successfulCommand(`UI hierchary dumped to: ${path}\n`),
    catResults: [() => {
      controller.abort(abortReason);
      return {
        ...successfulCommand(),
        exitCode: null,
        aborted: true,
      };
    }],
  });
  await assert.rejects(
    dependencies.waitForHierarchyPhase('B2 proof complete', {
      signal: controller.signal,
    }),
    (error) => error === abortReason,
  );
  assert.equal(
    commands.filter((value) => value.includes(` cat ${remotePath}`)).length,
    1,
  );
  assert.equal(
    commands.filter((value) => value.includes(` rm -f ${remotePath}`)).length,
    1,
  );
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
