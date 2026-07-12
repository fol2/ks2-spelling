import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';

import { fingerprintB2Application } from './fingerprint-b2-application.mjs';
import {
  B2_ATOMIC_FAILURE_CHECKPOINTS,
  compareB2NativeLogicalEvidence,
  validateB2NativeReport,
} from './lib/b2-evidence.mjs';
import { EXIT_CODES, isMain, printJson } from './lib/run-command.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const EXIT_REPORT_PATH = 'reports/b2/b2-exit-report.json';
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const execFileAsync = promisify(execFile);

export const B1_ENTRY_AUTHORITY = Object.freeze({
  repository: 'https://github.com/fol2/ks2-spelling.git',
  mergedCommit: '47c8ae791ccb521c8aafdfd297f1c211fd5981d4',
  mergedTree: 'ce0f2f483c0f21975ef3807a2a668b6d32b5c24e',
  hostedCiUrl: 'https://github.com/fol2/ks2-spelling/actions/runs/29160017974',
  b1DependencyAuditSha256:
    '1af859ea0a499c24fb33975149b8777c47225da9a1c388cbb6fc1dc9b0a3385c',
  b1ExitReportSha256:
    '8ca42ff4c6eef28b9861eae8749996a0c1e05aff5b784f789eadb817a638ab2a',
});

const LEGACY_BACKUP_DOMAINS = Object.freeze([
  'root',
  'file',
  'database',
  'sharedpref',
  'external',
]);
const CURRENT_BACKUP_DOMAINS = Object.freeze([
  ...LEGACY_BACKUP_DOMAINS,
  'device_root',
  'device_file',
  'device_database',
  'device_sharedpref',
]);
const BACKUP_RULES_SHA256 =
  '0d9990aea651376c460947c4b349b48c6dea1babfb268189732de71511d2b7e0';
const DATA_EXTRACTION_RULES_SHA256 =
  '74d80216ccbc8774c3699ead4a8406fe2c404d8d33333538d65bdd856d178208';
const REQUIRED_SPM_PINS = Object.freeze({
  'capacitor-swift-pm': '8.4.1',
  'sqlcipher.swift': '4.17.0',
  zipfoundation: '0.9.20',
});
const REQUIRED_LOCKFILES = Object.freeze([
  'android/gradle/dependency-locks/app.lockfile',
  'android/gradle/dependency-locks/capacitor-android.lockfile',
  'android/gradle/dependency-locks/capacitor-app.lockfile',
  'android/gradle/dependency-locks/capacitor-community-sqlite.lockfile',
  'android/gradle/dependency-locks/capacitor-cordova-android-plugins.lockfile',
]);
const REQUIRED_ANDROID_GENERATED_INPUTS = Object.freeze([
  'package.json',
  'scripts/certify-android-dependencies.mjs',
  'scripts/resolve-android-dependencies.mjs',
  'scripts/lib/maven-evidence.mjs',
  'config/dependency-policy.json',
  'config/maven-licence-policy.json',
  'config/third-party-notices-overrides.json',
  'android/gradle/verification-metadata.xml',
  ...REQUIRED_LOCKFILES,
]);
const NON_GOALS = Object.freeze({
  productionChildUi: false,
  parentUi: false,
  profileUi: false,
  productionProfileCrud: false,
  parentPin: false,
  biometrics: false,
  reset: false,
  delete: false,
  platformBackup: false,
  backupSqlite: false,
  retentionCompaction: false,
  twentyMegabyteRecovery: false,
  billing: false,
  inAppPurchases: false,
  purchases: false,
  entitlements: false,
  packDownload: false,
  packActivation: false,
  productionAudio: false,
  fullKs2Ui: false,
  guardianUi: false,
  bossUi: false,
  patternQuestUi: false,
  campUi: false,
  heroMode: false,
  heroCamp: false,
  finalTheme: false,
  finalAssets: false,
  physicalDevices: false,
  accessibilityCertification: false,
  performanceCertification: false,
  storeSigning: false,
  releaseCompliance: false,
  releaseMetadata: false,
});
export const B2_NON_GOAL_KEYS = Object.freeze(Object.keys(NON_GOALS).toSorted());
const CHECKPOINT_EVIDENCE_PATHS = new Set([
  'reports/b2/b2-exit-report.json',
  'reports/b2/ios-simulator-proof.json',
  'reports/b2/ios-simulator-proof.png',
  'reports/b2/android-emulator-proof.json',
  'reports/b2/android-emulator-proof.png',
]);
const REQUIRED_EVIDENCE_SUCCESSOR_PATHS = Object.freeze([
  'reports/b2/b2-exit-report.json',
  'reports/b2/ios-simulator-proof.json',
  'reports/b2/android-emulator-proof.json',
]);

function exitError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assert(condition, field, detail = 'does not match the B2 exit contract') {
  if (!condition) throw exitError('b2_exit_evidence_invalid', `${field} ${detail}`);
}

function assertExact(actual, expected, field) {
  assert(isDeepStrictEqual(actual, expected), field);
}

function assertSha256(value, field) {
  assert(SHA256.test(value ?? ''), field, 'must be a SHA-256 value');
}

export function assertExactB2NonGoals(value) {
  assert(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
    'B2 non-goals',
    'must be a plain object',
  );
  assertExact(Object.keys(value).toSorted(), B2_NON_GOAL_KEYS, 'B2 non-goals keys');
  for (const key of B2_NON_GOAL_KEYS) {
    assertExact(value[key], false, `B2 non-goals.${key}`);
  }
  return value;
}

async function readInput(root, path, { json = true } = {}) {
  let bytes;
  try {
    bytes = await readFile(join(root, path));
  } catch (cause) {
    throw exitError('b2_exit_input_missing', `Required B2 exit input is missing: ${path}`, {
      cause,
    });
  }
  if (bytes.byteLength === 0) {
    throw exitError('b2_exit_input_invalid', `Required B2 exit input is empty: ${path}`);
  }
  let value = null;
  if (json) {
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw exitError('b2_exit_input_invalid', `Required B2 exit input is not JSON: ${path}`);
    }
  }
  return { path, bytes, sha256: sha256(bytes), value };
}

function findCommittedInput(build, path) {
  const matches = build.committedInputs?.filter((input) => input?.path === path) ?? [];
  assert(matches.length === 1, `nativePluginBuild.committedInputs[${path}]`);
  assertSha256(matches[0].sha256, `nativePluginBuild.committedInputs[${path}].sha256`);
  return matches[0];
}

async function validateBoundFile(root, build, path) {
  const input = findCommittedInput(build, path);
  const file = await readInput(root, path, { json: false });
  assertExact(file.sha256, input.sha256, `${path} SHA-256`);
  return { path, sha256: file.sha256 };
}

function validateNativeBuild(build) {
  assertExact(build.schemaVersion, 2, 'nativePluginBuild.schemaVersion');
  assertExact(build.approval, 'build-proof-only', 'nativePluginBuild.approval');
  assertExact(build.finalPrivacyApproval, false, 'nativePluginBuild.finalPrivacyApproval');
  assertExact(build.finalExportApproval, false, 'nativePluginBuild.finalExportApproval');
  assertExact(
    build.nativeConfig,
    {
      sqliteMode: 'no-encryption',
      webFallbackInitialised: false,
      serverUrlConfigured: false,
    },
    'nativePluginBuild.nativeConfig',
  );
  assertExact(build.packages?.['@capacitor-community/sqlite'], {
    version: '8.1.0',
    integrity:
      'sha512-yhKZDAVPDPcM3QE6UGB3LXyV25a6Rve1SjZ1aUpTE0E2isnYTVM0PG9+JOI241f+NdsHzPTE7ESJiYSqKsKnuA==',
  }, 'nativePluginBuild.packages[@capacitor-community/sqlite]');
  assertExact(build.packages?.['@capacitor/app'], {
    version: '8.1.0',
    integrity:
      'sha512-MlmttTOWHDedr/G4SrhNRxsXMqY+R75S4MM4eIgzsgCzOYhb/MpCkA5Q3nuOCfL1oHm26xjUzqZ5aupbOwdfYg==',
  }, 'nativePluginBuild.packages[@capacitor/app]');
  assert(
    build.builds?.ios?.ok === true &&
      build.builds.ios.compiled === true &&
      build.builds.ios.signed === false &&
      build.builds.ios.sdk === 'iphonesimulator',
    'nativePluginBuild.builds.ios',
  );
  assert(
    build.builds?.android?.ok === true &&
      build.builds.android.unitTestsPassed === true &&
      build.builds.android.debugCompiled === true &&
      build.builds.android.releaseCompiled === true &&
      build.builds.android.releaseSigned === false,
    'nativePluginBuild.builds.android',
  );
  assertExact(
    build.android?.packagedPermissions?.declaredPermissions,
    [],
    'nativePluginBuild.android.packagedPermissions.declaredPermissions',
  );
  assertExact(
    build.android?.packagedPermissions?.requestedPermissions,
    [],
    'nativePluginBuild.android.packagedPermissions.requestedPermissions',
  );
  assertExact(
    build.android?.packagedManifest?.allowBackup,
    false,
    'nativePluginBuild.android.packagedManifest.allowBackup',
  );
  assertExact(
    build.android?.packagedBackupRules?.excludedDomains,
    LEGACY_BACKUP_DOMAINS,
    'nativePluginBuild.android.packagedBackupRules.excludedDomains',
  );
  assertExact(
    build.android?.packagedBackupRules?.xmlTreeSha256,
    BACKUP_RULES_SHA256,
    'nativePluginBuild.android.packagedBackupRules.xmlTreeSha256',
  );
  assertExact(
    build.android?.packagedDataExtractionRules?.cloudBackupExcludedDomains,
    CURRENT_BACKUP_DOMAINS,
    'nativePluginBuild.android.packagedDataExtractionRules.cloudBackupExcludedDomains',
  );
  assertExact(
    build.android?.packagedDataExtractionRules?.deviceTransferExcludedDomains,
    CURRENT_BACKUP_DOMAINS,
    'nativePluginBuild.android.packagedDataExtractionRules.deviceTransferExcludedDomains',
  );
  assertExact(
    build.android?.packagedDataExtractionRules?.xmlTreeSha256,
    DATA_EXTRACTION_RULES_SHA256,
    'nativePluginBuild.android.packagedDataExtractionRules.xmlTreeSha256',
  );
}

function canonicalSpmPins(build, dependencyAudit, packageResolved) {
  const buildPins = build.ios?.spmPins;
  assert(Array.isArray(buildPins), 'nativePluginBuild.ios.spmPins');
  assertExact(
    buildPins.map(({ identity }) => identity).toSorted(),
    Object.keys(REQUIRED_SPM_PINS).toSorted(),
    'nativePluginBuild.ios.spmPins identities',
  );
  const auditPins = dependencyAudit.spm;
  assert(Array.isArray(auditPins), 'dependencyAudit.spm');
  assertExact(packageResolved.version, 3, 'Package.resolved version');
  assert(Array.isArray(packageResolved.pins), 'Package.resolved pins');
  return buildPins
    .map((pin) => {
      const expectedVersion = REQUIRED_SPM_PINS[pin.identity];
      assertExact(pin.kind, 'remoteSourceControl', `SPM ${pin.identity} kind`);
      assertExact(pin.state?.version, expectedVersion, `SPM ${pin.identity} version`);
      assert(COMMIT.test(pin.state?.revision ?? ''), `SPM ${pin.identity} revision`);
      assert(
        typeof pin.location === 'string' && pin.location.startsWith('https://github.com/'),
        `SPM ${pin.identity} location`,
      );
      const resolvedMatches = packageResolved.pins.filter(
        (candidate) => candidate?.identity === pin.identity,
      );
      assert(resolvedMatches.length === 1, `Package.resolved pin ${pin.identity}`);
      assertExact(resolvedMatches[0], pin, `Package.resolved pin ${pin.identity}`);
      const auditMatches = auditPins.filter((candidate) => candidate?.identity === pin.identity);
      assert(auditMatches.length === 1, `dependencyAudit.spm[${pin.identity}]`);
      assertExact(auditMatches[0].revision, pin.state.revision, `SPM ${pin.identity} audit revision`);
      assertExact(auditMatches[0].version, expectedVersion, `SPM ${pin.identity} audit version`);
      assertExact(auditMatches[0].source, pin.location, `SPM ${pin.identity} audit source`);
      assertExact(
        auditMatches[0].requirement,
        { kind: 'version', version: expectedVersion },
        `SPM ${pin.identity} audit requirement`,
      );
      return {
        identity: pin.identity,
        version: expectedVersion,
        revision: pin.state.revision,
      };
    })
    .toSorted((left, right) => left.identity.localeCompare(right.identity));
}

async function validateAndroidGeneratedInventory(root, dependencyAudit) {
  const inventory = dependencyAudit.android?.generatedFrom;
  assert(Array.isArray(inventory), 'dependencyAudit.android.generatedFrom');
  assertExact(
    inventory.map(({ path }) => path).toSorted(),
    [...REQUIRED_ANDROID_GENERATED_INPUTS].toSorted(),
    'dependencyAudit.android.generatedFrom paths',
  );
  const result = [];
  for (const expectedPath of REQUIRED_ANDROID_GENERATED_INPUTS) {
    const matches = inventory.filter(({ path }) => path === expectedPath);
    assert(matches.length === 1, `dependencyAudit.android.generatedFrom[${expectedPath}]`);
    assertSha256(matches[0].sha256, `${expectedPath} generated SHA-256`);
    const actual = await readInput(root, expectedPath, { json: false });
    assertExact(actual.sha256, matches[0].sha256, `${expectedPath} generated SHA-256`);
    result.push({ path: expectedPath, sha256: actual.sha256 });
  }
  return result;
}

function validateDependencyAudit(dependencyAudit, nativeBuildSha256) {
  assertExact(dependencyAudit.schemaVersion, 2, 'dependencyAudit.schemaVersion');
  assertExact(
    dependencyAudit.generatedFrom?.nativePluginBuildSha256,
    nativeBuildSha256,
    'dependencyAudit.generatedFrom.nativePluginBuildSha256',
  );
  for (const [field, expected] of Object.entries({
    childDataCollected: false,
    childDataTransmitted: false,
    analytics: false,
    advertising: false,
    storeCommerce: false,
    localDatabase: true,
    sqliteMode: 'no-encryption',
    sqlCipherPackaged: true,
    applicationEncryptionAtRestProved: false,
    usEncryptionExportClassification: 'unresolved-before-store-release',
    approval: 'B2-proof-only',
  })) assertExact(dependencyAudit.b2Truth?.[field], expected, `dependencyAudit.b2Truth.${field}`);
  assertExact(dependencyAudit.b2Truth?.appPermissions, [], 'dependencyAudit.b2Truth.appPermissions');
  assertExact(
    dependencyAudit.b2Truth?.runtimeNetworkEndpoints,
    [],
    'dependencyAudit.b2Truth.runtimeNetworkEndpoints',
  );
  assertExact(
    dependencyAudit.permissionEvidence?.iosEntitlements,
    [],
    'dependencyAudit.permissionEvidence.iosEntitlements',
  );
  assertExact(
    dependencyAudit.permissionEvidence?.iosUsageDescriptionKeys,
    [],
    'dependencyAudit.permissionEvidence.iosUsageDescriptionKeys',
  );
  assertExact(
    dependencyAudit.permissionEvidence?.packagedAndroid?.declaredPermissions,
    [],
    'dependencyAudit.permissionEvidence.packagedAndroid.declaredPermissions',
  );
  assertExact(
    dependencyAudit.permissionEvidence?.packagedAndroid?.requestedPermissions,
    [],
    'dependencyAudit.permissionEvidence.packagedAndroid.requestedPermissions',
  );
  assertSha256(
    dependencyAudit.generatedFrom?.packageLockSha256,
    'dependencyAudit.generatedFrom.packageLockSha256',
  );
  assertSha256(
    dependencyAudit.generatedFrom?.webViewBundleEvidenceSha256,
    'dependencyAudit.generatedFrom.webViewBundleEvidenceSha256',
  );
}

function validateNativeAudit(nativeAudit, nativeBuild, nativeBuildSha256, dependencyAuditSha256) {
  assertExact(nativeAudit.schemaVersion, 1, 'nativePluginAudit.schemaVersion');
  assertExact(nativeAudit.approval, 'B2-proof-only', 'nativePluginAudit.approval');
  assertExact(
    nativeAudit.nativePluginBuildSha256,
    nativeBuildSha256,
    'nativePluginAudit.nativePluginBuildSha256',
  );
  assertExact(
    nativeAudit.dependencyAuditSha256,
    dependencyAuditSha256,
    'nativePluginAudit.dependencyAuditSha256',
  );
  assertExact(nativeAudit.androidPackagedPermissions, [], 'nativePluginAudit permissions');
  assertExact(nativeAudit.androidBackupEnabled, false, 'nativePluginAudit backup');
  assertExact(
    nativeAudit.androidBackupExcludedDomains,
    LEGACY_BACKUP_DOMAINS,
    'nativePluginAudit legacy backup domains',
  );
  assertExact(
    nativeAudit.androidCloudBackupExcludedDomains,
    CURRENT_BACKUP_DOMAINS,
    'nativePluginAudit cloud backup domains',
  );
  assertExact(
    nativeAudit.androidDeviceTransferExcludedDomains,
    CURRENT_BACKUP_DOMAINS,
    'nativePluginAudit device-transfer domains',
  );
  assertExact(
    nativeAudit.androidBackupRulesSha256,
    BACKUP_RULES_SHA256,
    'nativePluginAudit legacy backup hash',
  );
  assertExact(
    nativeAudit.androidDataExtractionRulesSha256,
    DATA_EXTRACTION_RULES_SHA256,
    'nativePluginAudit data extraction hash',
  );
  assertExact(nativeAudit.iosAddedUsageDescriptionKeys, [], 'nativePluginAudit iOS usage keys');
  assertExact(nativeAudit.iosAddedEntitlements, [], 'nativePluginAudit iOS entitlements');
  assertExact(nativeAudit.sqlCipherPackaged, true, 'nativePluginAudit SQLCipher');
  assertExact(nativeAudit.sqliteMode, 'no-encryption', 'nativePluginAudit SQLite mode');
  assertExact(
    nativeAudit.applicationEncryptionAtRestProved,
    false,
    'nativePluginAudit encryption-at-rest claim',
  );
  assertExact(
    nativeAudit.usEncryptionExportClassification,
    'unresolved-before-store-release',
    'nativePluginAudit export classification',
  );
  assertExact(nativeAudit.webFallbackInitialised, false, 'nativePluginAudit web fallback');
}

function serialiseExitReport(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

async function defaultRunGit(args, { root }) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    return {
      exitCode: Number.isInteger(error.code) ? error.code : 1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? error.message ?? ''),
    };
  }
}

function exactGitLine(value, field) {
  const line = value.trim();
  assert(!line.includes('\n') && line.length > 0, field, 'is malformed');
  return line;
}

function statusPaths(status) {
  if (!status.trim()) return [];
  return status.trimEnd().split('\n').map((line) => {
    assert(line.length >= 4, 'git status', 'contains a malformed entry');
    const prefix = line.slice(0, 2);
    const path = line.slice(3);
    assert(!path.includes(' -> ') && !path.startsWith('"'), 'git status', 'contains an unsupported entry');
    assert(/^(?:\?\?|[ MADRCU?!]{2})$/.test(prefix), 'git status', 'contains an unknown state');
    return path;
  });
}

export async function assertB2CheckpointSemantics({
  mode,
  root = ROOT,
  testedApplicationCommit,
  runGit = defaultRunGit,
} = {}) {
  assert(['write', 'check'].includes(mode), 'checkpoint mode', 'must be write or check');
  assert(COMMIT.test(testedApplicationCommit ?? ''), 'tested application commit', 'is malformed');
  const invoke = async (args) => runGit(args, { root: resolve(root) });
  const commitObject = await invoke(['cat-file', '-e', `${testedApplicationCommit}^{commit}`]);
  assert(commitObject.exitCode === 0, 'tested application commit', 'does not exist');
  const headResult = await invoke(['rev-parse', 'HEAD']);
  assert(headResult.exitCode === 0, 'HEAD', 'cannot be resolved');
  const head = exactGitLine(headResult.stdout, 'HEAD');
  assert(COMMIT.test(head), 'HEAD', 'is malformed');
  const ancestor = await invoke(['merge-base', '--is-ancestor', testedApplicationCommit, head]);
  assert(ancestor.exitCode === 0, 'tested application commit', 'is stale or not an ancestor of HEAD');
  const status = await invoke(['status', '--porcelain=v1', '--untracked-files=all']);
  assert(status.exitCode === 0, 'git status', 'cannot be read');
  const dirtyPaths = statusPaths(status.stdout);

  if (mode === 'write') {
    assertExact(head, testedApplicationCommit, 'write checkpoint HEAD');
    assert(
      dirtyPaths.every((path) => CHECKPOINT_EVIDENCE_PATHS.has(path)),
      'write checkpoint',
      'contains dirty application, native, configuration or verifier inputs',
    );
    return { mode, head, dirtyEvidencePaths: dirtyPaths.toSorted() };
  }

  if (head === testedApplicationCommit) {
    assert(
      dirtyPaths.every((path) => CHECKPOINT_EVIDENCE_PATHS.has(path)),
      'check checkpoint',
      'contains dirty application, native, configuration or verifier inputs',
    );
    return {
      mode,
      phase: 'application-checkpoint',
      head,
      dirtyEvidencePaths: dirtyPaths.toSorted(),
    };
  }
  assertExact(dirtyPaths, [], 'check checkpoint worktree');
  const parentsResult = await invoke(['rev-list', '--parents', '-n', '1', head]);
  assert(parentsResult.exitCode === 0, 'check checkpoint parents', 'cannot be read');
  const parents = exactGitLine(parentsResult.stdout, 'check checkpoint parents').split(' ');
  assertExact(parents, [head, testedApplicationCommit], 'check checkpoint parents');
  const diffResult = await invoke(['diff', '--name-only', testedApplicationCommit, head]);
  assert(diffResult.exitCode === 0, 'check checkpoint diff', 'cannot be read');
  const changed = diffResult.stdout.trim() ? diffResult.stdout.trimEnd().split('\n') : [];
  assert(changed.length > 0, 'check checkpoint diff', 'is empty');
  assert(
    changed.every((path) => CHECKPOINT_EVIDENCE_PATHS.has(path)),
    'check checkpoint diff',
    'contains a non-evidence input',
  );
  for (const path of REQUIRED_EVIDENCE_SUCCESSOR_PATHS) {
    assert(changed.includes(path), 'check checkpoint diff', `does not include ${path}`);
  }
  return {
    mode,
    phase: 'evidence-only-successor',
    head,
    changedEvidencePaths: changed.toSorted(),
  };
}

export async function buildB2ExitReport({
  root = ROOT,
  expectedApplicationCommit,
  expectedApplicationFingerprint,
  authority = B1_ENTRY_AUTHORITY,
} = {}) {
  const absoluteRoot = resolve(root);
  assert(COMMIT.test(expectedApplicationCommit ?? ''), 'expected application commit', 'is missing or malformed');
  assertSha256(expectedApplicationFingerprint, 'expected application fingerprint');
  const paths = {
    b1Exit: 'reports/b1/b1-exit-report.json',
    b1Dependency: 'reports/b1/dependency-audit.json',
    nativeBuild: 'reports/b2/native-plugin-build.json',
    nativeAudit: 'reports/b2/native-plugin-audit.json',
    dependencyAudit: 'reports/b2/dependency-audit.json',
    iosReport: 'reports/b2/ios-simulator-proof.json',
    iosScreenshot: 'reports/b2/ios-simulator-proof.png',
    androidReport: 'reports/b2/android-emulator-proof.json',
    androidScreenshot: 'reports/b2/android-emulator-proof.png',
  };
  const [
    b1Exit,
    b1Dependency,
    nativeBuildInput,
    nativeAuditInput,
    dependencyAuditInput,
    iosInput,
    iosScreenshot,
    androidInput,
    androidScreenshot,
  ] = await Promise.all([
    readInput(absoluteRoot, paths.b1Exit, { json: false }),
    readInput(absoluteRoot, paths.b1Dependency, { json: false }),
    readInput(absoluteRoot, paths.nativeBuild),
    readInput(absoluteRoot, paths.nativeAudit),
    readInput(absoluteRoot, paths.dependencyAudit),
    readInput(absoluteRoot, paths.iosReport),
    readInput(absoluteRoot, paths.iosScreenshot, { json: false }),
    readInput(absoluteRoot, paths.androidReport),
    readInput(absoluteRoot, paths.androidScreenshot, { json: false }),
  ]);
  assertExact(b1Exit.sha256, authority.b1ExitReportSha256, 'frozen B1 exit report SHA-256');
  assertExact(
    b1Dependency.sha256,
    authority.b1DependencyAuditSha256,
    'frozen B1 dependency audit SHA-256',
  );

  validateB2NativeReport(iosInput.value, {
    expectedPlatform: 'ios-simulator',
    expectedApplicationCommit,
    expectedApplicationFingerprint,
    screenshotBytes: iosScreenshot.bytes,
  });
  validateB2NativeReport(androidInput.value, {
    expectedPlatform: 'android-emulator',
    expectedApplicationCommit,
    expectedApplicationFingerprint,
    screenshotBytes: androidScreenshot.bytes,
  });
  const logical = compareB2NativeLogicalEvidence(iosInput.value, androidInput.value);

  const nativeBuild = nativeBuildInput.value;
  const nativeAudit = nativeAuditInput.value;
  const dependencyAudit = dependencyAuditInput.value;
  validateNativeBuild(nativeBuild);
  validateDependencyAudit(dependencyAudit, nativeBuildInput.sha256);
  validateNativeAudit(
    nativeAudit,
    nativeBuild,
    nativeBuildInput.sha256,
    dependencyAuditInput.sha256,
  );
  assertExact(
    nativeAudit.webViewBundleEvidenceSha256,
    dependencyAudit.generatedFrom.webViewBundleEvidenceSha256,
    'WebView bundle evidence SHA-256',
  );

  const packageLock = await validateBoundFile(absoluteRoot, nativeBuild, 'package-lock.json');
  assertExact(
    packageLock.sha256,
    dependencyAudit.generatedFrom.packageLockSha256,
    'package-lock report SHA-256',
  );
  const packageResolved = await validateBoundFile(
    absoluteRoot,
    nativeBuild,
    'ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
  );
  const packageResolvedDocument = (
    await readInput(absoluteRoot, packageResolved.path)
  ).value;
  const verificationMetadata = await validateBoundFile(
    absoluteRoot,
    nativeBuild,
    'android/gradle/verification-metadata.xml',
  );
  const lockfiles = [];
  assertExact(
    dependencyAudit.android?.lockfiles?.map(({ path }) => path).toSorted(),
    [...REQUIRED_LOCKFILES].toSorted(),
    'dependencyAudit.android.lockfiles',
  );
  for (const path of REQUIRED_LOCKFILES) {
    const bound = await validateBoundFile(absoluteRoot, nativeBuild, path);
    const auditMatches = dependencyAudit.android.lockfiles.filter((item) => item?.path === path);
    assert(auditMatches.length === 1, `dependencyAudit.android.lockfiles[${path}]`);
    assertExact(auditMatches[0].sha256, bound.sha256, `${path} dependency audit SHA-256`);
    lockfiles.push(bound);
  }
  const pins = canonicalSpmPins(nativeBuild, dependencyAudit, packageResolvedDocument);
  const androidGeneratedInputs = await validateAndroidGeneratedInventory(
    absoluteRoot,
    dependencyAudit,
  );

  const report = {
    schemaVersion: 1,
    status: 'pass',
    b1Authority: {
      repository: authority.repository ?? B1_ENTRY_AUTHORITY.repository,
      mergedCommit: authority.mergedCommit ?? B1_ENTRY_AUTHORITY.mergedCommit,
      mergedTree: authority.mergedTree ?? B1_ENTRY_AUTHORITY.mergedTree,
      hostedCiUrl: authority.hostedCiUrl ?? B1_ENTRY_AUTHORITY.hostedCiUrl,
      dependencyAudit: { path: paths.b1Dependency, sha256: b1Dependency.sha256 },
      exitReport: { path: paths.b1Exit, sha256: b1Exit.sha256 },
    },
    testedApplicationCommit: expectedApplicationCommit,
    applicationFingerprint: expectedApplicationFingerprint,
    inputs: {
      nativePluginBuild: { path: paths.nativeBuild, sha256: nativeBuildInput.sha256 },
      nativePluginAudit: { path: paths.nativeAudit, sha256: nativeAuditInput.sha256 },
      dependencyAudit: { path: paths.dependencyAudit, sha256: dependencyAuditInput.sha256 },
      packageLock,
      webViewBundleEvidenceSha256: dependencyAudit.generatedFrom.webViewBundleEvidenceSha256,
      swiftPackageManager: { packageResolved, pins },
      androidMaven: { verificationMetadata, lockfiles, generatedInputs: androidGeneratedInputs },
    },
    nativeEvidence: {
      ios: {
        report: { path: paths.iosReport, sha256: iosInput.sha256 },
        screenshot: { path: paths.iosScreenshot, sha256: iosScreenshot.sha256 },
      },
      android: {
        report: { path: paths.androidReport, sha256: androidInput.sha256 },
        screenshot: { path: paths.androidScreenshot, sha256: androidScreenshot.sha256 },
      },
      canonicalLogicalSnapshotSha256: logical.finalLogicalSnapshotSha256,
    },
    database: {
      name: 'ks2-spelling',
      physicalFile: 'ks2-spellingSQLite.db',
      schemaVersion: 1,
      pragmas: {
        foreignKeys: 1,
        journalMode: 'wal',
        synchronous: 2,
        busyTimeout: 5000,
      },
      integrityCheck: 'ok',
      migrationRollback: 'verified',
    },
    atomicity: {
      failureCheckpoints: B2_ATOMIC_FAILURE_CHECKPOINTS,
      transientEffectsAfterCommitOnly: true,
    },
    lifecycle: {
      events: ['pause', 'resume'],
      processTerminationDifferentPid: true,
      sessionResume: true,
    },
    learnerIsolation: {
      twoLearners: true,
      learnerBUntouched: true,
      learnerBSha256: logical.learnerBInitialSha256,
      starterCampRows: 0,
      monsterState: 'spelling-derived-child-owned',
    },
    privacy: {
      serverUrl: null,
      androidPermissions: [],
      androidAllowBackup: false,
      legacyBackupExcludedDomains: LEGACY_BACKUP_DOMAINS,
      cloudBackupExcludedDomains: CURRENT_BACKUP_DOMAINS,
      deviceTransferExcludedDomains: CURRENT_BACKUP_DOMAINS,
      addedIosUsageDescriptionKeys: [],
      addedIosEntitlements: [],
    },
    cryptography: {
      sqlCipherPackaged: true,
      sqliteMode: 'no-encryption',
      applicationEncryptionAtRestProved: false,
      usEncryptionExportClassification: 'unresolved-before-store-release',
    },
    visual: {
      status: 'diagnostic-proof-only',
      visualThemeAssetMigrationDeferred: true,
      migrationOrder: 'after-gate-b-go-before-c3-child-ui',
    },
    nonGoals: { ...NON_GOALS },
  };
  assertExactB2NonGoals(report.nonGoals);
  return report;
}

export async function writeB2ExitReport(options = {}) {
  const report = await buildB2ExitReport(options);
  const root = resolve(options.root ?? ROOT);
  const path = join(root, EXIT_REPORT_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serialiseExitReport(report), 'utf8');
  return report;
}

export async function checkB2ExitReport(options = {}) {
  const root = resolve(options.root ?? ROOT);
  const expected = serialiseExitReport(await buildB2ExitReport(options));
  let actual;
  try {
    actual = await readFile(join(root, EXIT_REPORT_PATH), 'utf8');
  } catch {
    throw exitError('b2_exit_report_missing', `${EXIT_REPORT_PATH} is missing`);
  }
  let parsed;
  try {
    parsed = JSON.parse(actual);
  } catch {
    throw exitError('b2_exit_report_stale', `${EXIT_REPORT_PATH} is not valid JSON`);
  }
  assertExactB2NonGoals(parsed.nonGoals);
  if (actual !== expected) {
    throw exitError(
      'b2_exit_report_stale',
      `${EXIT_REPORT_PATH} is stale; expected a byte-for-byte match`,
    );
  }
  return parsed;
}

async function liveOptions() {
  const [ios, android, fingerprint] = await Promise.all([
    readInput(ROOT, 'reports/b2/ios-simulator-proof.json'),
    readInput(ROOT, 'reports/b2/android-emulator-proof.json'),
    fingerprintB2Application({ root: ROOT }),
  ]);
  assertExact(
    ios.value.testedApplicationCommit,
    android.value.testedApplicationCommit,
    'native tested application commits',
  );
  assertExact(
    ios.value.applicationFingerprint,
    android.value.applicationFingerprint,
    'native application fingerprints',
  );
  assertExact(
    fingerprint.sha256,
    ios.value.applicationFingerprint,
    'current application fingerprint',
  );
  return {
    root: ROOT,
    expectedApplicationCommit: ios.value.testedApplicationCommit,
    expectedApplicationFingerprint: fingerprint.sha256,
  };
}

export async function main(args = process.argv.slice(2)) {
  try {
    if (args.length !== 1 || !['--write', '--check'].includes(args[0])) {
      throw exitError('b2_exit_usage', 'Usage: build-b2-exit-report.mjs --write|--check');
    }
    const options = await liveOptions();
    await assertB2CheckpointSemantics({
      mode: args[0] === '--write' ? 'write' : 'check',
      root: ROOT,
      testedApplicationCommit: options.expectedApplicationCommit,
    });
    const report =
      args[0] === '--write'
        ? await writeB2ExitReport(options)
        : await checkB2ExitReport(options);
    printJson({ ok: true, exitReport: EXIT_REPORT_PATH, report });
    return EXIT_CODES.success;
  } catch (error) {
    printJson(
      { ok: false, code: error.code ?? 'b2_exit_failed', message: error.message },
      process.stderr,
    );
    return error.code === 'b2_exit_usage' ? EXIT_CODES.usage : EXIT_CODES.stateMismatch;
  }
}

if (isMain(import.meta.url)) process.exitCode = await main();
