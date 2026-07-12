import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  B2_ATOMIC_FAILURE_CHECKPOINTS,
  B2_NATIVE_REPORT_SCHEMA_VERSION,
  B2_PLUGIN_VERSIONS,
  compareB2NativeLogicalEvidence,
  validateB2NativeReport,
} from '../scripts/lib/b2-evidence.mjs';

const COMMIT = '1'.repeat(40);
const FINGERPRINT = '2'.repeat(64);
const SCREENSHOT = Buffer.from('non-empty screenshot bytes');
const SCREENSHOT_SHA256 = createHash('sha256').update(SCREENSHOT).digest('hex');
const LOGICAL_SHA256 = '3'.repeat(64);
const LEARNER_B_SHA256 = '4'.repeat(64);

function report(platform) {
  const isIos = platform === 'ios-simulator';
  return {
    schemaVersion: 1,
    platform,
    testedApplicationCommit: COMMIT,
    applicationFingerprint: FINGERPRINT,
    identity: { applicationId: 'uk.eugnel.ks2spelling' },
    device: {
      name: isIos ? 'KS2 Spelling iPhone 17' : 'KS2_Spelling_API_36',
      runtime: isIos
        ? 'com.apple.CoreSimulator.SimRuntime.iOS-26-5'
        : 'system-images;android-36;google_apis;arm64-v8a',
      osVersion: isIos ? '26.5' : '16',
    },
    nativeVersions: isIos
      ? { xcode: '26.6', iosSdk: '26.5' }
      : { androidApi: 36, buildTools: '36.0.0' },
    pluginVersions: { ...B2_PLUGIN_VERSIONS },
    database: {
      name: 'ks2-spelling',
      physicalFile: 'ks2-spellingSQLite.db',
      schemaVersion: 1,
      foreignKeys: 1,
      journalMode: 'wal',
      synchronous: 2,
      busyTimeout: 5000,
      integrityCheck: 'ok',
      databaseSha256: isIos ? '5'.repeat(64) : '6'.repeat(64),
      walModeObserved: true,
      sidecarsObserved: ['ks2-spellingSQLite.db-wal', 'ks2-spellingSQLite.db-shm'],
      everyObservedSidecarCollectedSafely: true,
    },
    lifecycle: {
      events: ['pause', 'resume'],
      preKillPid: '100',
      postRelaunchPid: '200',
      differentPid: true,
    },
    proof: {
      resumedSessionId: 'session-1',
      preKillRevision: 4,
      finalRevision: 6,
      finalLogicalSnapshotSha256: LOGICAL_SHA256,
      atomicFailureCheckpoints: [...B2_ATOMIC_FAILURE_CHECKPOINTS],
      migrationRollback: 'verified',
      learnerBIsolation: 'verified',
      learnerBInitialSha256: LEARNER_B_SHA256,
      learnerBFinalSha256: LEARNER_B_SHA256,
      monsterState: 'spelling-derived-child-owned',
      starterCampRows: 0,
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
      machineStateSource: isIos
        ? 'durable-proof-metadata'
        : 'uiautomator-hierarchy',
      screenshotSha256: SCREENSHOT_SHA256,
      manualVisualInspection: 'passed',
    },
    cleanup: { deviceStopped: true },
  };
}

function validate(candidate, platform = candidate.platform, screenshotBytes = SCREENSHOT) {
  return validateB2NativeReport(candidate, {
    expectedPlatform: platform,
    expectedApplicationCommit: COMMIT,
    expectedApplicationFingerprint: FINGERPRINT,
    screenshotBytes,
  });
}

test('B2 reports use the strict schema and compare as one logical proof', () => {
  assert.equal(B2_NATIVE_REPORT_SCHEMA_VERSION, 1);
  const ios = report('ios-simulator');
  const android = report('android-emulator');
  assert.equal(validate(ios), ios);
  assert.equal(validate(android), android);
  assert.deepEqual(compareB2NativeLogicalEvidence(ios, android), {
    finalLogicalSnapshotSha256: LOGICAL_SHA256,
    learnerBInitialSha256: LEARNER_B_SHA256,
    learnerBFinalSha256: LEARNER_B_SHA256,
  });
});

test('B2 report validation rejects stale identity, malformed proof and privacy drift', () => {
  const mutations = [
    (value) => { value.unknown = true; },
    (value) => { value.database.unknown = true; },
    (value) => { value.platform = 'android-emulator'; },
    (value) => { value.lifecycle.postRelaunchPid = value.lifecycle.preKillPid; },
    (value) => { value.lifecycle.events = ['resume', 'pause']; },
    (value) => { value.lifecycle.events = ['pause', 'pause', 'resume']; },
    (value) => { value.proof.preKillRevision = 3; },
    (value) => { value.proof.finalRevision = 7; },
    (value) => { value.proof.atomicFailureCheckpoints.pop(); },
    (value) => { value.proof.learnerBFinalSha256 = '9'.repeat(64); },
    (value) => { value.proof.starterCampRows = 1; },
    (value) => { value.privacy.packagedAndroidPermissions = ['android.permission.INTERNET']; },
    (value) => { value.privacy.androidBackupEnabled = true; },
    (value) => { value.privacy.serverUrl = 'https://example.invalid'; },
    (value) => { value.ui.manualVisualInspection = 'pending'; },
    (value) => { value.testedApplicationCommit = '9'.repeat(40); },
    (value) => { value.applicationFingerprint = '9'.repeat(64); },
    (value) => { value.pluginVersions.capacitorSqlite = '8.0.0'; },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(report('ios-simulator'));
    mutate(candidate);
    assert.throws(() => validate(candidate), /B2 native evidence/i);
  }
  assert.throws(
    () => validate(report('ios-simulator'), 'ios-simulator', Buffer.alloc(0)),
    /screenshot/i,
  );
});

test('platform-only report values cannot be crossed', () => {
  const ios = report('ios-simulator');
  ios.device.name = 'KS2_Spelling_API_36';
  assert.throws(() => validate(ios), /device/i);

  const android = report('android-emulator');
  android.nativeVersions = { xcode: '26.6', iosSdk: '26.5' };
  assert.throws(() => validate(android), /nativeVersions/i);
});

test('cross-platform comparison rejects logical divergence', () => {
  const ios = report('ios-simulator');
  const android = report('android-emulator');
  android.proof.finalLogicalSnapshotSha256 = '8'.repeat(64);
  assert.throws(() => compareB2NativeLogicalEvidence(ios, android), /logical/i);

  const databaseDrift = report('android-emulator');
  databaseDrift.database.synchronous = 1;
  assert.throws(
    () => compareB2NativeLogicalEvidence(report('ios-simulator'), databaseDrift),
    /logical/i,
  );

  const checkpointDrift = report('android-emulator');
  checkpointDrift.applicationFingerprint = '7'.repeat(64);
  assert.throws(
    () => compareB2NativeLogicalEvidence(report('ios-simulator'), checkpointDrift),
    /logical/i,
  );
});
