import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  const hierarchy = phase === 'B2 proof complete'
    ? '<node text="B2 proof complete Learner isolation verified pause, resume and relaunch verified"/>'
    : `<node text="${phase}"/>`;
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
  const complete = [
    'B2 proof complete',
    'Learner isolation',
    'verified',
    'pause, resume and relaunch verified',
  ].join(' ');
  assert.equal(
    assertB2AndroidHierarchyPhase(complete, 'B2 proof complete').phase,
    'B2 proof complete',
  );
  assert.throws(
    () => assertB2AndroidHierarchyPhase('B2 proof complete', 'B2 proof complete'),
    ({ code }) => code === 'b2_android_hierarchy_phase_invalid',
  );
  const probes = [successfulCommand('loading'), successfulCommand(complete)];
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
