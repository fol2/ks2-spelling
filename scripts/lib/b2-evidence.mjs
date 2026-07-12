import { createHash } from 'node:crypto';

import {
  IOS_DEVICE,
  analyseIosScreenshotBmp,
  parseIosRuntimeVersion,
  runWithIosCaptureCleanup,
  selectExistingIosDevice,
} from '../launch-ios-simulator.mjs';
import {
  ANDROID_DEVICE,
  analyseAndroidScreenshotBmp,
  assertAndroidAvdIdentity,
  assertAndroidAvdPointerIdentity,
  assertAndroidSerialOwnership,
  assertStartedAndroidEmulatorProcess,
  createAndroidCaptureCleanupPlan,
  runAndroidCaptureCleanup,
  waitForAndroidBundledShell,
  waitForAndroidScreenshotShell,
} from '../launch-android-emulator.mjs';

export const B2_NATIVE_REPORT_SCHEMA_VERSION = 1;
export const B2_APPLICATION_ID = 'uk.eugnel.ks2spelling';
export const B2_PLUGIN_VERSIONS = Object.freeze({
  capacitorCore: '8.4.1',
  capacitorApp: '8.1.0',
  capacitorSqlite: '8.1.0',
});
export const B2_ATOMIC_FAILURE_CHECKPOINTS = Object.freeze([
  'after-subject-state',
  'after-practice-session',
  'after-events',
  'after-monster-state',
  'after-camp-state',
  'after-revision',
  'before-commit',
]);

export const B2_IOS_DEVICE = IOS_DEVICE;
export const B2_ANDROID_DEVICE = ANDROID_DEVICE;

export {
  analyseAndroidScreenshotBmp,
  analyseIosScreenshotBmp,
  assertAndroidAvdIdentity,
  assertAndroidAvdPointerIdentity,
  assertAndroidSerialOwnership,
  assertStartedAndroidEmulatorProcess,
  createAndroidCaptureCleanupPlan,
  parseIosRuntimeVersion,
  selectExistingIosDevice,
  waitForAndroidBundledShell,
  waitForAndroidScreenshotShell,
};

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const PID = /^[1-9][0-9]*$/;
const PLATFORMS = new Set(['ios-simulator', 'android-emulator']);

const REPORT_KEYS = Object.freeze([
  'schemaVersion',
  'platform',
  'testedApplicationCommit',
  'applicationFingerprint',
  'identity',
  'device',
  'nativeVersions',
  'pluginVersions',
  'database',
  'lifecycle',
  'proof',
  'privacy',
  'ui',
  'cleanup',
]);

const OBJECT_KEYS = Object.freeze({
  identity: ['applicationId'],
  device: ['name', 'runtime', 'osVersion'],
  pluginVersions: ['capacitorCore', 'capacitorApp', 'capacitorSqlite'],
  database: [
    'name',
    'physicalFile',
    'schemaVersion',
    'foreignKeys',
    'journalMode',
    'synchronous',
    'busyTimeout',
    'integrityCheck',
    'databaseSha256',
    'walModeObserved',
    'sidecarsObserved',
    'everyObservedSidecarCollectedSafely',
  ],
  lifecycle: ['events', 'preKillPid', 'postRelaunchPid', 'differentPid'],
  proof: [
    'resumedSessionId',
    'preKillRevision',
    'finalRevision',
    'finalLogicalSnapshotSha256',
    'atomicFailureCheckpoints',
    'migrationRollback',
    'learnerBIsolation',
    'learnerBInitialSha256',
    'learnerBFinalSha256',
    'monsterState',
    'starterCampRows',
  ],
  privacy: [
    'serverUrl',
    'packagedAndroidPermissions',
    'androidBackupEnabled',
    'addedIosUsageDescriptionKeys',
    'addedIosEntitlements',
  ],
  ui: [
    'diagnosticPhase',
    'machineStateSource',
    'screenshotSha256',
    'manualVisualInspection',
  ],
  cleanup: ['deviceStopped'],
});

const NATIVE_VERSION_KEYS = Object.freeze({
  'ios-simulator': new Set([
    'node',
    'npm',
    'xcode',
    'iosSdk',
    'swift',
    'capacitorIos',
  ]),
  'android-emulator': new Set([
    'node',
    'npm',
    'java',
    'androidApi',
    'buildTools',
    'gradle',
    'capacitorAndroid',
  ]),
});

function evidenceError(field, detail) {
  const error = new Error(`B2 native evidence ${field} ${detail}`);
  error.code = 'b2_native_evidence_invalid';
  return error;
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertExactKeys(value, keys, field) {
  if (!isPlainObject(value)) throw evidenceError(field, 'must be a plain object');
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw evidenceError(field, 'has missing or unknown keys');
  }
}

function assertExact(value, expected, field) {
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw evidenceError(field, 'does not match the exact contract');
  }
}

function assertNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw evidenceError(field, 'must be a non-empty string');
  }
}

function assertSha256(value, field) {
  if (!SHA256.test(value ?? '')) throw evidenceError(field, 'must be SHA-256');
}

function assertNativeVersions(value, platform) {
  if (!isPlainObject(value)) {
    throw evidenceError('nativeVersions', 'must be a plain object');
  }
  const allowed = NATIVE_VERSION_KEYS[platform];
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw evidenceError('nativeVersions', 'contains a mismatched platform-only field');
  }
  for (const [key, version] of Object.entries(value)) {
    if (
      (typeof version !== 'string' || version.length === 0) &&
      (!Number.isInteger(version) || version < 1)
    ) {
      throw evidenceError(`nativeVersions.${key}`, 'must identify a version');
    }
  }
}

function expectedDevice(platform) {
  return platform === 'ios-simulator'
    ? {
        name: IOS_DEVICE.name,
        runtime: IOS_DEVICE.runtime,
        osVersion: '26.5',
      }
    : {
        name: ANDROID_DEVICE.name,
        runtime: ANDROID_DEVICE.image,
      };
}

function validateDevice(device, platform) {
  assertExactKeys(device, OBJECT_KEYS.device, 'device');
  const expected = expectedDevice(platform);
  if (device.name !== expected.name || device.runtime !== expected.runtime) {
    throw evidenceError('device', 'does not match the owned virtual device');
  }
  assertNonEmptyString(device.osVersion, 'device.osVersion');
  if (platform === 'ios-simulator' && device.osVersion !== expected.osVersion) {
    throw evidenceError('device.osVersion', 'does not match iOS 26.5');
  }
  if (platform === 'android-emulator' && device.osVersion !== '16') {
    throw evidenceError('device.osVersion', 'does not match Android 16 / API 36');
  }
}

function validateDatabase(database) {
  assertExactKeys(database, OBJECT_KEYS.database, 'database');
  for (const [field, expected] of Object.entries({
    name: 'ks2-spelling',
    physicalFile: 'ks2-spellingSQLite.db',
    schemaVersion: 1,
    foreignKeys: 1,
    journalMode: 'wal',
    synchronous: 2,
    busyTimeout: 5000,
    integrityCheck: 'ok',
    walModeObserved: true,
    everyObservedSidecarCollectedSafely: true,
  })) assertExact(database[field], expected, `database.${field}`);
  assertSha256(database.databaseSha256, 'database.databaseSha256');
  if (
    !Array.isArray(database.sidecarsObserved) ||
    new Set(database.sidecarsObserved).size !== database.sidecarsObserved.length ||
    database.sidecarsObserved.some(
      (name) => !['ks2-spellingSQLite.db-wal', 'ks2-spellingSQLite.db-shm'].includes(name),
    )
  ) {
    throw evidenceError('database.sidecarsObserved', 'is not a safe sidecar set');
  }
}

function validateLifecycle(lifecycle) {
  assertExactKeys(lifecycle, OBJECT_KEYS.lifecycle, 'lifecycle');
  assertExact(lifecycle.events, ['pause', 'resume'], 'lifecycle.events');
  if (!PID.test(lifecycle.preKillPid) || !PID.test(lifecycle.postRelaunchPid)) {
    throw evidenceError('lifecycle PIDs', 'must be positive process identifiers');
  }
  if (
    lifecycle.preKillPid === lifecycle.postRelaunchPid ||
    lifecycle.differentPid !== true
  ) {
    throw evidenceError('lifecycle PIDs', 'must prove a different relaunched process');
  }
}

function validateProof(proof) {
  assertExactKeys(proof, OBJECT_KEYS.proof, 'proof');
  assertNonEmptyString(proof.resumedSessionId, 'proof.resumedSessionId');
  assertExact(proof.preKillRevision, 4, 'proof.preKillRevision');
  assertExact(proof.finalRevision, 6, 'proof.finalRevision');
  assertSha256(proof.finalLogicalSnapshotSha256, 'proof.finalLogicalSnapshotSha256');
  assertExact(
    proof.atomicFailureCheckpoints,
    B2_ATOMIC_FAILURE_CHECKPOINTS,
    'proof.atomicFailureCheckpoints',
  );
  assertExact(proof.migrationRollback, 'verified', 'proof.migrationRollback');
  assertExact(proof.learnerBIsolation, 'verified', 'proof.learnerBIsolation');
  assertSha256(proof.learnerBInitialSha256, 'proof.learnerBInitialSha256');
  assertSha256(proof.learnerBFinalSha256, 'proof.learnerBFinalSha256');
  if (proof.learnerBInitialSha256 !== proof.learnerBFinalSha256) {
    throw evidenceError('proof learner-B digests', 'must remain equal');
  }
  assertExact(
    proof.monsterState,
    'spelling-derived-child-owned',
    'proof.monsterState',
  );
  assertExact(proof.starterCampRows, 0, 'proof.starterCampRows');
}

function validatePrivacy(privacy) {
  assertExactKeys(privacy, OBJECT_KEYS.privacy, 'privacy');
  assertExact(privacy.serverUrl, null, 'privacy.serverUrl');
  assertExact(
    privacy.packagedAndroidPermissions,
    [],
    'privacy.packagedAndroidPermissions',
  );
  assertExact(privacy.androidBackupEnabled, false, 'privacy.androidBackupEnabled');
  assertExact(
    privacy.addedIosUsageDescriptionKeys,
    [],
    'privacy.addedIosUsageDescriptionKeys',
  );
  assertExact(privacy.addedIosEntitlements, [], 'privacy.addedIosEntitlements');
}

function validateUi(ui, platform, screenshotBytes) {
  assertExactKeys(ui, OBJECT_KEYS.ui, 'ui');
  assertExact(ui.diagnosticPhase, 'complete', 'ui.diagnosticPhase');
  assertExact(
    ui.machineStateSource,
    platform === 'ios-simulator'
      ? 'durable-proof-metadata'
      : 'uiautomator-hierarchy',
    'ui.machineStateSource',
  );
  assertSha256(ui.screenshotSha256, 'ui.screenshotSha256');
  if (!(screenshotBytes instanceof Uint8Array) || screenshotBytes.byteLength === 0) {
    throw evidenceError('screenshot', 'bytes are missing');
  }
  const actual = createHash('sha256').update(screenshotBytes).digest('hex');
  if (actual !== ui.screenshotSha256) {
    throw evidenceError('screenshot', 'bytes do not match screenshotSha256');
  }
  assertExact(ui.manualVisualInspection, 'passed', 'ui.manualVisualInspection');
}

export function validateB2NativeReport(
  report,
  {
    expectedPlatform,
    expectedApplicationCommit,
    expectedApplicationFingerprint,
    screenshotBytes,
  } = {},
) {
  assertExactKeys(report, REPORT_KEYS, 'report');
  assertExact(report.schemaVersion, B2_NATIVE_REPORT_SCHEMA_VERSION, 'schemaVersion');
  if (!PLATFORMS.has(report.platform) || report.platform !== expectedPlatform) {
    throw evidenceError('platform', 'does not match the expected platform');
  }
  if (!COMMIT.test(expectedApplicationCommit ?? '')) {
    throw evidenceError('expected application commit', 'is missing or malformed');
  }
  if (
    !COMMIT.test(report.testedApplicationCommit ?? '') ||
    report.testedApplicationCommit !== expectedApplicationCommit
  ) {
    throw evidenceError('testedApplicationCommit', 'is stale');
  }
  if (!SHA256.test(expectedApplicationFingerprint ?? '')) {
    throw evidenceError('expected application fingerprint', 'is missing or malformed');
  }
  if (
    !SHA256.test(report.applicationFingerprint ?? '') ||
    report.applicationFingerprint !== expectedApplicationFingerprint
  ) {
    throw evidenceError('applicationFingerprint', 'is stale');
  }
  assertExactKeys(report.identity, OBJECT_KEYS.identity, 'identity');
  assertExact(report.identity.applicationId, B2_APPLICATION_ID, 'identity.applicationId');
  validateDevice(report.device, report.platform);
  assertNativeVersions(report.nativeVersions, report.platform);
  assertExactKeys(report.pluginVersions, OBJECT_KEYS.pluginVersions, 'pluginVersions');
  assertExact(report.pluginVersions, B2_PLUGIN_VERSIONS, 'pluginVersions');
  validateDatabase(report.database);
  validateLifecycle(report.lifecycle);
  validateProof(report.proof);
  validatePrivacy(report.privacy);
  validateUi(report.ui, report.platform, screenshotBytes);
  assertExactKeys(report.cleanup, OBJECT_KEYS.cleanup, 'cleanup');
  assertExact(report.cleanup.deviceStopped, true, 'cleanup.deviceStopped');
  return report;
}

export function compareB2NativeLogicalEvidence(iosReport, androidReport) {
  if (
    iosReport?.platform !== 'ios-simulator' ||
    androidReport?.platform !== 'android-emulator'
  ) {
    throw evidenceError('cross-platform logical proof', 'has mismatched platforms');
  }
  const fields = [
    'finalLogicalSnapshotSha256',
    'learnerBInitialSha256',
    'learnerBFinalSha256',
  ];
  const sharedEvidence = [
    ['testedApplicationCommit'],
    ['applicationFingerprint'],
    ['identity'],
    ['pluginVersions'],
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
    ['privacy', 'serverUrl'],
    ['privacy', 'packagedAndroidPermissions'],
    ['privacy', 'androidBackupEnabled'],
    ['privacy', 'addedIosUsageDescriptionKeys'],
    ['privacy', 'addedIosEntitlements'],
  ];
  for (const path of sharedEvidence) {
    const iosValue = path.reduce((value, key) => value?.[key], iosReport);
    const androidValue = path.reduce((value, key) => value?.[key], androidReport);
    if (JSON.stringify(iosValue) !== JSON.stringify(androidValue)) {
      throw evidenceError('cross-platform logical proof', `${path.join('.')} differs`);
    }
  }
  const compared = {};
  for (const field of fields) {
    if (iosReport.proof?.[field] !== androidReport.proof?.[field]) {
      throw evidenceError('cross-platform logical proof', `${field} differs`);
    }
    compared[field] = iosReport.proof[field];
  }
  for (const field of [
    'resumedSessionId',
    'preKillRevision',
    'finalRevision',
    'atomicFailureCheckpoints',
    'migrationRollback',
    'learnerBIsolation',
    'monsterState',
    'starterCampRows',
  ]) {
    if (JSON.stringify(iosReport.proof?.[field]) !== JSON.stringify(androidReport.proof?.[field])) {
      throw evidenceError('cross-platform logical proof', `${field} differs`);
    }
  }
  return compared;
}

export function createB2IosFreshInstallPlan({ udid, appPath }) {
  assertNonEmptyString(udid, 'iOS owned device UDID');
  assertNonEmptyString(appPath, 'iOS application path');
  return [
    ['xcrun', ['simctl', 'uninstall', udid, IOS_DEVICE.bundleId]],
    ['xcrun', ['simctl', 'install', udid, appPath]],
  ];
}

export function createB2AndroidFreshInstallPlan({ apkPath }) {
  assertNonEmptyString(apkPath, 'Android application path');
  return [
    [
      'adb',
      ['-s', ANDROID_DEVICE.serial, 'uninstall', ANDROID_DEVICE.packageId],
    ],
    ['adb', ['-s', ANDROID_DEVICE.serial, 'install', apkPath]],
  ];
}

export function runWithB2IosCleanup({ ownsDevice, udid, work, shutdown }) {
  return runWithIosCaptureCleanup({
    capture: ownsDevice,
    device: ownsDevice ? { udid } : null,
    work,
    shutdown,
  });
}

export async function runWithB2AndroidCleanup({
  cleanupPlan,
  work,
  killOwnedSerial,
  terminateProcessGroup,
}) {
  try {
    return await work();
  } finally {
    await runAndroidCaptureCleanup({
      plan: cleanupPlan,
      killOwnedSerial,
      terminateProcessGroup,
    });
  }
}
