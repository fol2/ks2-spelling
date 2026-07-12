import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  B2_IOS_DATABASE_FILES,
  assertB2ApplicationStatusClean,
  assertB2IosProofMetadata,
  openB2IosLiveMetadataReader,
  parseB2IosLaunchPid,
  runB2IosLifecycleProof,
} from '../scripts/prove-b2-ios.mjs';
import { canonicalJson } from '../src/platform/database/canonical-json.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const SESSION_ID = 'session-known-from-durable-metadata';

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
        return step('sync-build-unsigned', { appPath: '/build/App.app' });
      },
      async ownAndBootDevice() {
        return step('own-boot', { udid: 'owned-ios-udid' });
      },
      async withOwnedCleanup({ ownsDevice, udid, work, shutdown }) {
        assert.equal(ownsDevice, true);
        assert.equal(udid, 'owned-ios-udid');
        try {
          return await work();
        } finally {
          await shutdown(udid);
        }
      },
      async shutdownOwnedDevice(udid) {
        assert.equal(udid, 'owned-ios-udid');
        return step('shutdown-owned');
      },
      async freshInstallAndLaunch({ udid, appPath }) {
        assert.equal(udid, 'owned-ios-udid');
        assert.equal(appPath, '/build/App.app');
        return step('uninstall-install-launch', { pid: '101' });
      },
      async resolveDataContainer(udid) {
        assert.equal(udid, 'owned-ios-udid');
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
          manualVisualInspection: 'passed',
        });
      },
      async collectTerminatedDatabaseSet({ files }) {
        assert.deepEqual(files, B2_IOS_DATABASE_FILES);
        return step('copy-db-wal-shm-after-termination', {
          databasePath: '/evidence/ks2-spellingSQLite.db',
          sidecarsObserved: files.slice(1),
        });
      },
      async inspectCollectedDatabase({ databasePath, readOnly }) {
        assert.equal(databasePath, '/evidence/ks2-spellingSQLite.db');
        assert.equal(readOnly, true);
        return step('inspect-collected-db-read-only', {
          foreignKeys: 1,
          journalMode: 'wal',
          synchronous: 2,
          busyTimeout: 5000,
          integrityCheck: 'ok',
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

test('iOS proof orders lifecycle, PID replacement, UI capture and WAL-safe collection', async () => {
  const { dependencies, events } = createDependencies();
  const result = await runB2IosLifecycleProof(dependencies);
  assert.equal(result.lifecycle.preKillPid, '101');
  assert.equal(result.lifecycle.postRelaunchPid, '202');
  assert.equal(result.metadata.phase, 'complete');
  assert.deepEqual(events, [
    'sync-build-unsigned',
    'own-boot',
    'uninstall-install-launch',
    'resolve-data-container',
    'open-host-read-only-wal',
    'poll-background-test-ready',
    'foreground-bundled-system-app',
    'relaunch-for-resume',
    'poll-ready-for-relaunch',
    'terminate-application',
    'prove-old-pid-absent',
    'launch-new-process',
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
