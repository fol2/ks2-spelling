import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  B2_ATOMIC_FAILURE_CHECKPOINTS,
  B2_NATIVE_REPORT_SCHEMA_VERSION,
  B2_PLUGIN_VERSIONS,
  compareB2NativeLogicalEvidence,
  decodeB2MachineUtf8,
  validateB2NativeReport,
} from '../scripts/lib/b2-evidence.mjs';

const COMMIT = '1'.repeat(40);
const FINGERPRINT = '2'.repeat(64);
const SCREENSHOT = Buffer.from('non-empty screenshot bytes');
const SCREENSHOT_SHA256 = createHash('sha256').update(SCREENSHOT).digest('hex');
const LOGICAL_SHA256 = '3'.repeat(64);
const LEARNER_B_SHA256 = '4'.repeat(64);

test('machine evidence UTF-8 decoding preserves authority bytes and rejects invalid text', () => {
  const authority = 'password="false" token="machine-value"';
  assert.equal(decodeB2MachineUtf8(Buffer.from(authority)), authority);
  assert.throws(
    () => decodeB2MachineUtf8(Uint8Array.from([0xc3, 0x28])),
    /valid UTF-8/,
  );
  assert.throws(() => decodeB2MachineUtf8('not bytes'), /machine evidence bytes/);
});

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
      ? { xcode: '26.6 (17F113)', iosSdk: '26.5', capacitorIos: '8.4.1' }
      : { androidApi: 36, buildTools: '36.0.0', capacitorAndroid: '8.4.1' },
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

test('cross-platform comparison permits only explicit platform and physical evidence', () => {
  const ios = report('ios-simulator');
  const android = report('android-emulator');
  android.database.databaseSha256 = '7'.repeat(64);
  android.database.sidecarsObserved = [];
  android.lifecycle.preKillPid = '300';
  android.lifecycle.postRelaunchPid = '400';
  android.ui.screenshotSha256 = '8'.repeat(64);
  assert.doesNotThrow(() => compareB2NativeLogicalEvidence(ios, android));
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

test('native version evidence has exact required platform keys and frozen values', () => {
  const mutations = [
    (value) => { value.nativeVersions = {}; },
    (value) => { delete value.nativeVersions.iosSdk; },
    (value) => { value.nativeVersions.extra = 'unexpected'; },
    (value) => { value.nativeVersions.xcode = ''; },
    (value) => { value.nativeVersions.xcode = 26; },
    (value) => { value.nativeVersions.iosSdk = '26.4'; },
    (value) => { value.nativeVersions.capacitorIos = '8.4.0'; },
  ];
  for (const mutate of mutations) {
    const candidate = report('ios-simulator');
    mutate(candidate);
    assert.throws(() => validate(candidate), /nativeVersions/i);
  }

  const androidMutations = [
    (value) => { delete value.nativeVersions.androidApi; },
    (value) => { value.nativeVersions.androidApi = '36'; },
    (value) => { value.nativeVersions.androidApi = 35; },
    (value) => { value.nativeVersions.buildTools = ''; },
    (value) => { value.nativeVersions.capacitorAndroid = '8.3.0'; },
  ];
  for (const mutate of androidMutations) {
    const candidate = report('android-emulator');
    mutate(candidate);
    assert.throws(() => validate(candidate), /nativeVersions/i);
  }
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

test('cross-platform comparison covers every shared logical and status field', () => {
  const sharedPaths = [
    ['schemaVersion'],
    ['testedApplicationCommit'],
    ['applicationFingerprint'],
    ['identity', 'applicationId'],
    ['pluginVersions', 'capacitorCore'],
    ['pluginVersions', 'capacitorApp'],
    ['pluginVersions', 'capacitorSqlite'],
    ['database', 'name'],
    ['database', 'physicalFile'],
    ['database', 'schemaVersion'],
    ['database', 'foreignKeys'],
    ['database', 'journalMode'],
    ['database', 'synchronous'],
    ['database', 'busyTimeout'],
    ['database', 'integrityCheck'],
    ['database', 'walModeObserved'],
    ['database', 'everyObservedSidecarCollectedSafely'],
    ['lifecycle', 'events'],
    ['lifecycle', 'differentPid'],
    ['proof', 'resumedSessionId'],
    ['proof', 'preKillRevision'],
    ['proof', 'finalRevision'],
    ['proof', 'finalLogicalSnapshotSha256'],
    ['proof', 'atomicFailureCheckpoints'],
    ['proof', 'migrationRollback'],
    ['proof', 'learnerBIsolation'],
    ['proof', 'learnerBInitialSha256'],
    ['proof', 'learnerBFinalSha256'],
    ['proof', 'monsterState'],
    ['proof', 'starterCampRows'],
    ['privacy', 'serverUrl'],
    ['privacy', 'packagedAndroidPermissions'],
    ['privacy', 'androidBackupEnabled'],
    ['privacy', 'addedIosUsageDescriptionKeys'],
    ['privacy', 'addedIosEntitlements'],
    ['ui', 'diagnosticPhase'],
    ['ui', 'manualVisualInspection'],
    ['cleanup', 'deviceStopped'],
  ];
  for (const path of sharedPaths) {
    const android = report('android-emulator');
    const owner = path.slice(0, -1).reduce((value, key) => value[key], android);
    const key = path.at(-1);
    owner[key] = Array.isArray(owner[key])
      ? [...owner[key], 'drift']
      : typeof owner[key] === 'boolean'
        ? !owner[key]
        : typeof owner[key] === 'number'
          ? owner[key] + 1
          : `${owner[key]}-drift`;
    assert.throws(
      () => compareB2NativeLogicalEvidence(report('ios-simulator'), android),
      /logical/i,
      path.join('.'),
    );
  }
});
