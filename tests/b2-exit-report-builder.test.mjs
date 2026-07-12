import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { B2_ATOMIC_FAILURE_CHECKPOINTS } from '../scripts/lib/b2-evidence.mjs';

const COMMIT = '1'.repeat(40);
const FINGERPRINT = '2'.repeat(64);
const LOGICAL_DIGEST = '3'.repeat(64);
const LEARNER_B_DIGEST = '4'.repeat(64);
const SCREENSHOT = Buffer.from('complete diagnostic proof screenshot');
const EVIDENCE_HEAD = 'e'.repeat(40);
const EXPECTED_NON_GOALS = [
  'accessibilityCertification',
  'backupSqlite',
  'billing',
  'biometrics',
  'bossUi',
  'delete',
  'downloads',
  'entitlements',
  'finalVisualDesign',
  'fullKs2Ui',
  'guardianUi',
  'heroCamp',
  'heroMode',
  'parentPin',
  'parentUi',
  'patternQuestUi',
  'physicalDeviceCertification',
  'platformBackup',
  'productionAudio',
  'productionProfiles',
  'purchases',
  'releaseMetadata',
  'reset',
  'storeSigning',
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function write(root, path, value) {
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), bytes);
  return sha256(bytes);
}

function nativeReport(platform, screenshotSha256) {
  return {
    schemaVersion: 1,
    platform,
    testedApplicationCommit: COMMIT,
    applicationFingerprint: FINGERPRINT,
    identity: { applicationId: 'uk.eugnel.ks2spelling' },
    device:
      platform === 'ios-simulator'
        ? {
            name: 'KS2 Spelling iPhone 17',
            runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
            osVersion: '26.5',
          }
        : {
            name: 'KS2_Spelling_API_36',
            runtime: 'system-images;android-36;google_apis;arm64-v8a',
            osVersion: '16',
          },
    nativeVersions:
      platform === 'ios-simulator'
        ? { xcode: '26.6 (17F113)', iosSdk: '26.5', capacitorIos: '8.4.1' }
        : { buildTools: '36.0.0', androidApi: 36, capacitorAndroid: '8.4.1' },
    pluginVersions: {
      capacitorCore: '8.4.1',
      capacitorApp: '8.1.0',
      capacitorSqlite: '8.1.0',
    },
    database: {
      name: 'ks2-spelling',
      physicalFile: 'ks2-spellingSQLite.db',
      schemaVersion: 1,
      foreignKeys: 1,
      journalMode: 'wal',
      synchronous: 2,
      busyTimeout: 5000,
      integrityCheck: 'ok',
      databaseSha256: platform === 'ios-simulator' ? '5'.repeat(64) : '6'.repeat(64),
      walModeObserved: true,
      sidecarsObserved: ['ks2-spellingSQLite.db-wal', 'ks2-spellingSQLite.db-shm'],
      everyObservedSidecarCollectedSafely: true,
    },
    lifecycle: {
      events: ['pause', 'resume'],
      preKillPid: platform === 'ios-simulator' ? '101' : '201',
      postRelaunchPid: platform === 'ios-simulator' ? '102' : '202',
      differentPid: true,
    },
    proof: {
      resumedSessionId: 'session-a',
      preKillRevision: 4,
      finalRevision: 6,
      finalLogicalSnapshotSha256: LOGICAL_DIGEST,
      atomicFailureCheckpoints: B2_ATOMIC_FAILURE_CHECKPOINTS,
      migrationRollback: 'verified',
      learnerBIsolation: 'verified',
      learnerBInitialSha256: LEARNER_B_DIGEST,
      learnerBFinalSha256: LEARNER_B_DIGEST,
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
      machineStateSource:
        platform === 'ios-simulator' ? 'durable-proof-metadata' : 'uiautomator-hierarchy',
      screenshotSha256,
      manualVisualInspection: 'passed',
    },
    cleanup: { deviceStopped: true },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ks2-spelling-b2-exit-'));
  const spmPins = [
    {
      identity: 'capacitor-swift-pm',
      kind: 'remoteSourceControl',
      location: 'https://github.com/ionic-team/capacitor-swift-pm.git',
      state: { revision: 'a'.repeat(40), version: '8.4.1' },
    },
    {
      identity: 'sqlcipher.swift',
      kind: 'remoteSourceControl',
      location: 'https://github.com/sqlcipher/SQLCipher.swift.git',
      state: { revision: 'b'.repeat(40), version: '4.17.0' },
    },
    {
      identity: 'zipfoundation',
      kind: 'remoteSourceControl',
      location: 'https://github.com/weichsel/ZIPFoundation.git',
      state: { revision: 'c'.repeat(40), version: '0.9.20' },
    },
  ];
  const packageJsonSha256 = await write(root, 'package.json', '{"name":"fixture"}\n');
  const packageLockSha256 = await write(root, 'package-lock.json', 'exact package lock\n');
  const packageResolvedSha256 = await write(
    root,
    'ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
    { version: 3, pins: spmPins },
  );
  const verificationMetadataSha256 = await write(
    root,
    'android/gradle/verification-metadata.xml',
    '<verification-metadata />\n',
  );
  const lockfiles = [];
  for (const name of [
    'app',
    'capacitor-android',
    'capacitor-app',
    'capacitor-community-sqlite',
    'capacitor-cordova-android-plugins',
  ]) {
    const path = `android/gradle/dependency-locks/${name}.lockfile`;
    lockfiles.push({ path, sha256: await write(root, path, `${name}\n`) });
  }
  const generatedInputs = [];
  for (const path of [
    'scripts/certify-android-dependencies.mjs',
    'scripts/resolve-android-dependencies.mjs',
    'scripts/lib/maven-evidence.mjs',
    'config/dependency-policy.json',
    'config/maven-licence-policy.json',
    'config/third-party-notices-overrides.json',
  ]) generatedInputs.push({ path, sha256: await write(root, path, `${path}\n`) });
  const b1ExitSha256 = await write(root, 'reports/b1/b1-exit-report.json', 'b1 exit\n');
  const b1DependencySha256 = await write(
    root,
    'reports/b1/dependency-audit.json',
    'b1 dependencies\n',
  );
  const screenshotSha256 = await write(
    root,
    'reports/b2/ios-simulator-proof.png',
    SCREENSHOT,
  );
  await write(root, 'reports/b2/android-emulator-proof.png', SCREENSHOT);
  const ios = nativeReport('ios-simulator', screenshotSha256);
  const android = nativeReport('android-emulator', screenshotSha256);
  await write(root, 'reports/b2/ios-simulator-proof.json', ios);
  await write(root, 'reports/b2/android-emulator-proof.json', android);

  const nativeBuild = {
    schemaVersion: 2,
    approval: 'build-proof-only',
    finalPrivacyApproval: false,
    finalExportApproval: false,
    nativeConfig: {
      sqliteMode: 'no-encryption',
      webFallbackInitialised: false,
      serverUrlConfigured: false,
    },
    packages: {
      '@capacitor-community/sqlite': {
        version: '8.1.0',
        integrity:
          'sha512-yhKZDAVPDPcM3QE6UGB3LXyV25a6Rve1SjZ1aUpTE0E2isnYTVM0PG9+JOI241f+NdsHzPTE7ESJiYSqKsKnuA==',
      },
      '@capacitor/app': {
        version: '8.1.0',
        integrity:
          'sha512-MlmttTOWHDedr/G4SrhNRxsXMqY+R75S4MM4eIgzsgCzOYhb/MpCkA5Q3nuOCfL1oHm26xjUzqZ5aupbOwdfYg==',
      },
    },
    builds: {
      ios: { ok: true, compiled: true, signed: false, sdk: 'iphonesimulator' },
      android: {
        ok: true,
        unitTestsPassed: true,
        debugCompiled: true,
        releaseCompiled: true,
        releaseSigned: false,
      },
    },
    ios: { spmPins },
    committedInputs: [
      { path: 'package.json', sha256: packageJsonSha256 },
      { path: 'package-lock.json', sha256: packageLockSha256 },
      {
        path:
          'ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
        sha256: packageResolvedSha256,
      },
      {
        path: 'android/gradle/verification-metadata.xml',
        sha256: verificationMetadataSha256,
      },
      ...lockfiles,
    ],
    android: {
      packagedPermissions: { declaredPermissions: [], requestedPermissions: [] },
      packagedManifest: { allowBackup: false },
      packagedBackupRules: {
        excludedDomains: ['root', 'file', 'database', 'sharedpref', 'external'],
        xmlTreeSha256:
          '0d9990aea651376c460947c4b349b48c6dea1babfb268189732de71511d2b7e0',
      },
      packagedDataExtractionRules: {
        cloudBackupExcludedDomains: [
          'root',
          'file',
          'database',
          'sharedpref',
          'external',
          'device_root',
          'device_file',
          'device_database',
          'device_sharedpref',
        ],
        deviceTransferExcludedDomains: [
          'root',
          'file',
          'database',
          'sharedpref',
          'external',
          'device_root',
          'device_file',
          'device_database',
          'device_sharedpref',
        ],
        xmlTreeSha256:
          '74d80216ccbc8774c3699ead4a8406fe2c404d8d33333538d65bdd856d178208',
      },
    },
  };
  const nativeBuildText = `${JSON.stringify(nativeBuild, null, 2)}\n`;
  const nativeBuildSha256 = await write(
    root,
    'reports/b2/native-plugin-build.json',
    nativeBuildText,
  );
  const webViewBundleEvidenceSha256 = '9'.repeat(64);
  const dependencyAudit = {
    schemaVersion: 2,
    generatedFrom: {
      packageLockSha256,
      spmResolvedVersion: 3,
      nativePluginBuildSha256: nativeBuildSha256,
      webViewBundleEvidenceSha256,
    },
    b2Truth: {
      childDataCollected: false,
      childDataTransmitted: false,
      analytics: false,
      advertising: false,
      appPermissions: [],
      storeCommerce: false,
      runtimeNetworkEndpoints: [],
      localDatabase: true,
      sqliteMode: 'no-encryption',
      sqlCipherPackaged: true,
      applicationEncryptionAtRestProved: false,
      usEncryptionExportClassification: 'unresolved-before-store-release',
      approval: 'B2-proof-only',
    },
    permissionEvidence: {
      iosEntitlements: [],
      iosUsageDescriptionKeys: [],
      packagedAndroid: { declaredPermissions: [], requestedPermissions: [] },
    },
    spm: nativeBuild.ios.spmPins.map(({ identity, location, state }) => ({
      identity,
      source: location,
      requirement: { kind: 'version', version: state.version },
      revision: state.revision,
      version: state.version,
    })),
    android: {
      lockfiles,
      generatedFrom: [
        { path: 'package.json', sha256: packageJsonSha256 },
        ...generatedInputs,
        { path: 'android/gradle/verification-metadata.xml', sha256: verificationMetadataSha256 },
        ...lockfiles,
      ],
    },
  };
  const dependencyText = `${JSON.stringify(dependencyAudit, null, 2)}\n`;
  const dependencyAuditSha256 = await write(
    root,
    'reports/b2/dependency-audit.json',
    dependencyText,
  );
  const nativeAudit = {
    schemaVersion: 1,
    approval: 'B2-proof-only',
    nativePluginBuildSha256: nativeBuildSha256,
    dependencyAuditSha256,
    webViewBundleEvidenceSha256,
    androidPackagedPermissions: [],
    androidBackupEnabled: false,
    androidBackupRulesSha256: nativeBuild.android.packagedBackupRules.xmlTreeSha256,
    androidBackupExcludedDomains: nativeBuild.android.packagedBackupRules.excludedDomains,
    androidDataExtractionRulesSha256:
      nativeBuild.android.packagedDataExtractionRules.xmlTreeSha256,
    androidCloudBackupExcludedDomains:
      nativeBuild.android.packagedDataExtractionRules.cloudBackupExcludedDomains,
    androidDeviceTransferExcludedDomains:
      nativeBuild.android.packagedDataExtractionRules.deviceTransferExcludedDomains,
    iosAddedUsageDescriptionKeys: [],
    iosAddedEntitlements: [],
    sqlCipherPackaged: true,
    sqliteMode: 'no-encryption',
    applicationEncryptionAtRestProved: false,
    usEncryptionExportClassification: 'unresolved-before-store-release',
    webFallbackInitialised: false,
  };
  await write(root, 'reports/b2/native-plugin-audit.json', nativeAudit);
  return {
    root,
    authority: {
      b1ExitReportSha256: b1ExitSha256,
      b1DependencyAuditSha256: b1DependencySha256,
    },
  };
}

async function withFixture(callback) {
  const value = await fixture();
  try {
    await callback(value);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
}

async function mutateJson(root, path, mutate) {
  const value = JSON.parse(await readFile(join(root, path), 'utf8'));
  mutate(value);
  await write(root, path, value);
}

async function builder() {
  return import('../scripts/build-b2-exit-report.mjs');
}

test('B2 exit builder binds the complete valid native, dependency and policy proof', async () => {
  await withFixture(async ({ root, authority }) => {
    const { buildB2ExitReport } = await builder();
    const report = await buildB2ExitReport({
      root,
      expectedApplicationCommit: COMMIT,
      expectedApplicationFingerprint: FINGERPRINT,
      authority,
    });
    assert.equal(report.status, 'pass');
    assert.deepEqual(report.b1Authority, {
      repository: 'https://github.com/fol2/ks2-spelling.git',
      mergedCommit: '47c8ae791ccb521c8aafdfd297f1c211fd5981d4',
      mergedTree: 'ce0f2f483c0f21975ef3807a2a668b6d32b5c24e',
      hostedCiUrl: 'https://github.com/fol2/ks2-spelling/actions/runs/29160017974',
      dependencyAudit: {
        path: 'reports/b1/dependency-audit.json',
        sha256: authority.b1DependencyAuditSha256,
      },
      exitReport: {
        path: 'reports/b1/b1-exit-report.json',
        sha256: authority.b1ExitReportSha256,
      },
    });
    assert.equal(report.testedApplicationCommit, COMMIT);
    assert.equal(report.applicationFingerprint, FINGERPRINT);
    assert.equal(report.nativeEvidence.canonicalLogicalSnapshotSha256, LOGICAL_DIGEST);
    assert.deepEqual(report.atomicity.failureCheckpoints, B2_ATOMIC_FAILURE_CHECKPOINTS);
    assert.equal(report.lifecycle.processTerminationDifferentPid, true);
    assert.equal(report.lifecycle.sessionResume, true);
    assert.equal(report.learnerIsolation.learnerBUntouched, true);
    assert.equal(report.privacy.serverUrl, null);
    assert.equal(report.privacy.androidAllowBackup, false);
    assert.equal(report.cryptography.sqlCipherPackaged, true);
    assert.equal(report.cryptography.applicationEncryptionAtRestProved, false);
    assert.equal(report.visual.status, 'diagnostic-proof-only');
    assert.deepEqual(Object.keys(report.nonGoals).toSorted(), EXPECTED_NON_GOALS);
    assert.equal(Object.keys(report.nonGoals).length, EXPECTED_NON_GOALS.length);
    for (const key of EXPECTED_NON_GOALS) assert.equal(report.nonGoals[key], false, key);
    assert.equal(report.inputs.androidMaven.lockfiles.length, 5);
    assert.equal(report.inputs.swiftPackageManager.pins.length, 3);
  });
});

test('B2 exit builder rejects screenshot and package/SPM/Maven binding drift', async () => {
  const cases = [
    {
      name: 'screenshot bytes',
      mutate: async (root) => write(root, 'reports/b2/ios-simulator-proof.png', 'changed'),
    },
    {
      name: 'package lock bytes',
      mutate: async (root) => write(root, 'package-lock.json', 'changed lock'),
    },
    {
      name: 'Package.resolved schema',
      mutate: async (root) =>
        mutateJson(
          root,
          'ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
          (value) => { value.version = 2; },
        ),
    },
    {
      name: 'SPM source location',
      mutate: async (root) =>
        mutateJson(root, 'reports/b2/dependency-audit.json', (value) => {
          value.spm[0].source = 'https://example.invalid/drift.git';
        }),
    },
    {
      name: 'verification metadata generated binding',
      mutate: async (root) =>
        mutateJson(root, 'reports/b2/dependency-audit.json', (value) => {
          value.android.generatedFrom.find(
            ({ path }) => path === 'android/gradle/verification-metadata.xml',
          ).sha256 = 'f'.repeat(64);
        }),
    },
    {
      name: 'Maven lockfile binding',
      mutate: async (root) =>
        mutateJson(root, 'reports/b2/dependency-audit.json', (value) => {
          value.android.lockfiles[0].sha256 = 'f'.repeat(64);
        }),
    },
  ];
  for (const fixtureCase of cases) {
    await withFixture(async ({ root, authority }) => {
      const { buildB2ExitReport } = await builder();
      await fixtureCase.mutate(root);
      await assert.rejects(
        buildB2ExitReport({
          root,
          expectedApplicationCommit: COMMIT,
          expectedApplicationFingerprint: FINGERPRINT,
          authority,
        }),
        fixtureCase.name,
      );
    });
  }
});

test('B2 exit builder rejects native, dependency and plugin report cross-hash drift', async () => {
  const cases = [
    ['dependency to native build', 'reports/b2/dependency-audit.json', (value) => {
      value.generatedFrom.nativePluginBuildSha256 = 'f'.repeat(64);
    }],
    ['plugin to native build', 'reports/b2/native-plugin-audit.json', (value) => {
      value.nativePluginBuildSha256 = 'f'.repeat(64);
    }],
    ['plugin to dependency audit', 'reports/b2/native-plugin-audit.json', (value) => {
      value.dependencyAuditSha256 = 'f'.repeat(64);
    }],
    ['plugin to WebView bundle', 'reports/b2/native-plugin-audit.json', (value) => {
      value.webViewBundleEvidenceSha256 = 'f'.repeat(64);
    }],
  ];
  for (const [name, path, mutate] of cases) {
    await withFixture(async ({ root, authority }) => {
      const { buildB2ExitReport } = await builder();
      await mutateJson(root, path, mutate);
      await assert.rejects(
        buildB2ExitReport({
          root,
          expectedApplicationCommit: COMMIT,
          expectedApplicationFingerprint: FINGERPRINT,
          authority,
        }),
        name,
      );
    });
  }
});

test('B2 exit builder rejects co-ordinated backup hash tampering against trusted policy', async () => {
  await withFixture(async ({ root, authority }) => {
    const { buildB2ExitReport } = await builder();
    await mutateJson(root, 'reports/b2/native-plugin-build.json', (value) => {
      value.android.packagedBackupRules.xmlTreeSha256 = 'f'.repeat(64);
      value.android.packagedDataExtractionRules.xmlTreeSha256 = 'e'.repeat(64);
    });
    const nativeBuildBytes = await readFile(join(root, 'reports/b2/native-plugin-build.json'));
    const nativeBuildSha256 = sha256(nativeBuildBytes);
    await mutateJson(root, 'reports/b2/dependency-audit.json', (value) => {
      value.generatedFrom.nativePluginBuildSha256 = nativeBuildSha256;
    });
    const dependencyBytes = await readFile(join(root, 'reports/b2/dependency-audit.json'));
    const dependencySha256 = sha256(dependencyBytes);
    await mutateJson(root, 'reports/b2/native-plugin-audit.json', (value) => {
      value.nativePluginBuildSha256 = nativeBuildSha256;
      value.dependencyAuditSha256 = dependencySha256;
      value.androidBackupRulesSha256 = 'f'.repeat(64);
      value.androidDataExtractionRulesSha256 = 'e'.repeat(64);
    });
    await assert.rejects(
      buildB2ExitReport({
        root,
        expectedApplicationCommit: COMMIT,
        expectedApplicationFingerprint: FINGERPRINT,
        authority,
      }),
      /backup|extraction|SHA-256/i,
    );
  });
});

function gitFixture({
  head = EVIDENCE_HEAD,
  parent = COMMIT,
  ancestor = true,
  status = '',
  diff = [
    'reports/b2/b2-exit-report.json',
    'reports/b2/ios-simulator-proof.json',
    'reports/b2/android-emulator-proof.json',
  ],
  commitExists = true,
} = {}) {
  return async (args) => {
    const command = args.join(' ');
    if (args[0] === 'cat-file') return { exitCode: commitExists ? 0 : 1, stdout: '', stderr: '' };
    if (args[0] === 'rev-parse') return { exitCode: 0, stdout: `${head}\n`, stderr: '' };
    if (args[0] === 'merge-base') return { exitCode: ancestor ? 0 : 1, stdout: '', stderr: '' };
    if (args[0] === 'status') return { exitCode: 0, stdout: status, stderr: '' };
    if (args[0] === 'rev-list') {
      return { exitCode: 0, stdout: `${head} ${parent}\n`, stderr: '' };
    }
    if (args[0] === 'diff') return { exitCode: 0, stdout: `${diff.join('\n')}\n`, stderr: '' };
    throw new Error(`Unexpected git fixture command: ${command}`);
  };
}

test('production checkpoint semantics bind write to clean application HEAD and check to its evidence-only successor', async () => {
  const { assertB2CheckpointSemantics } = await builder();
  assert.deepEqual(
    await assertB2CheckpointSemantics({
      mode: 'write',
      testedApplicationCommit: COMMIT,
      runGit: gitFixture({
        head: COMMIT,
        status:
          ' M reports/b2/ios-simulator-proof.json\n' +
          '?? reports/b2/b2-exit-report.json\n',
      }),
    }),
    {
      mode: 'write',
      head: COMMIT,
      dirtyEvidencePaths: [
        'reports/b2/b2-exit-report.json',
        'reports/b2/ios-simulator-proof.json',
      ],
    },
  );
  const checked = await assertB2CheckpointSemantics({
    mode: 'check',
    testedApplicationCommit: COMMIT,
    runGit: gitFixture(),
  });
  assert.equal(checked.head, EVIDENCE_HEAD);
  assert.equal(checked.phase, 'evidence-only-successor');
  assert.deepEqual(checked.changedEvidencePaths, [
    'reports/b2/android-emulator-proof.json',
    'reports/b2/b2-exit-report.json',
    'reports/b2/ios-simulator-proof.json',
  ]);
  assert.deepEqual(
    await assertB2CheckpointSemantics({
      mode: 'check',
      testedApplicationCommit: COMMIT,
      runGit: gitFixture({
        head: COMMIT,
        status: ' M reports/b2/ios-simulator-proof.json\n',
      }),
    }),
    {
      mode: 'check',
      phase: 'application-checkpoint',
      head: COMMIT,
      dirtyEvidencePaths: ['reports/b2/ios-simulator-proof.json'],
    },
  );
});

test('production checkpoint semantics reject HEAD substitution, unrelated commits and dirty inputs', async () => {
  const { assertB2CheckpointSemantics } = await builder();
  const cases = [
    {
      name: 'unrelated successor',
      mode: 'check',
      runGit: gitFixture({ parent: 'f'.repeat(40) }),
    },
    {
      name: 'non-evidence successor',
      mode: 'check',
      runGit: gitFixture({
        diff: [
          'reports/b2/b2-exit-report.json',
          'reports/b2/ios-simulator-proof.json',
          'reports/b2/android-emulator-proof.json',
          'src/main.jsx',
        ],
      }),
    },
    {
      name: 'dirty evidence successor',
      mode: 'check',
      runGit: gitFixture({ status: ' M scripts/build-b2-exit-report.mjs\n' }),
    },
    {
      name: 'stale non-ancestor',
      mode: 'check',
      runGit: gitFixture({ ancestor: false }),
    },
    {
      name: 'missing tested commit',
      mode: 'check',
      runGit: gitFixture({ commitExists: false }),
    },
    {
      name: 'write after application HEAD',
      mode: 'write',
      runGit: gitFixture(),
    },
    {
      name: 'write with dirty verifier',
      mode: 'write',
      runGit: gitFixture({
        head: COMMIT,
        status: ' M tests/b2-exit-report.live.mjs\n',
      }),
    },
  ];
  for (const fixture of cases) {
    await assert.rejects(
      assertB2CheckpointSemantics({
        mode: fixture.mode,
        testedApplicationCommit: COMMIT,
        runGit: fixture.runGit,
      }),
      fixture.name,
    );
  }
});

test('B2 exit builder rejects stale commit and application fingerprint', async () => {
  for (const field of ['expectedApplicationCommit', 'expectedApplicationFingerprint']) {
    await withFixture(async ({ root, authority }) => {
      const { buildB2ExitReport } = await builder();
      await assert.rejects(
        buildB2ExitReport({
          root,
          expectedApplicationCommit: field === 'expectedApplicationCommit' ? 'f'.repeat(40) : COMMIT,
          expectedApplicationFingerprint:
            field === 'expectedApplicationFingerprint' ? 'f'.repeat(64) : FINGERPRINT,
          authority,
        }),
        /stale|fingerprint|commit/i,
      );
    });
  }
});

test('B2 exit builder rejects missing required evidence', async () => {
  await withFixture(async ({ root, authority }) => {
    const { buildB2ExitReport } = await builder();
    await rm(join(root, 'reports/b2/native-plugin-audit.json'));
    await assert.rejects(
      buildB2ExitReport({
        root,
        expectedApplicationCommit: COMMIT,
        expectedApplicationFingerprint: FINGERPRINT,
        authority,
      }),
      /missing|ENOENT|native-plugin-audit/i,
    );
  });
});

test('B2 exit builder rejects mismatched cross-platform logical digests', async () => {
  await withFixture(async ({ root, authority }) => {
    const { buildB2ExitReport } = await builder();
    const path = join(root, 'reports/b2/android-emulator-proof.json');
    const android = JSON.parse(await readFile(path, 'utf8'));
    android.proof.finalLogicalSnapshotSha256 = 'f'.repeat(64);
    await write(root, 'reports/b2/android-emulator-proof.json', android);
    await assert.rejects(
      buildB2ExitReport({
        root,
        expectedApplicationCommit: COMMIT,
        expectedApplicationFingerprint: FINGERPRINT,
        authority,
      }),
      /logical|shared evidence differs/i,
    );
  });
});

test('B2 exit builder rejects permissions and backup policy drift', async () => {
  for (const mutate of [
    (value) => value.androidPackagedPermissions.push('android.permission.INTERNET'),
    (value) => { value.androidBackupEnabled = true; },
    (value) => value.androidDeviceTransferExcludedDomains.pop(),
  ]) {
    await withFixture(async ({ root, authority }) => {
      const { buildB2ExitReport } = await builder();
      const path = join(root, 'reports/b2/native-plugin-audit.json');
      const audit = JSON.parse(await readFile(path, 'utf8'));
      mutate(audit);
      await write(root, 'reports/b2/native-plugin-audit.json', audit);
      await assert.rejects(
        buildB2ExitReport({
          root,
          expectedApplicationCommit: COMMIT,
          expectedApplicationFingerprint: FINGERPRINT,
          authority,
        }),
        /permission|backup|transfer|domain/i,
      );
    });
  }
});

test('B2 exit builder rejects lifecycle proof failures', async () => {
  for (const mutate of [
    (value) => { value.lifecycle.differentPid = false; },
    (value) => { value.lifecycle.events = ['pause']; },
    (value) => { value.proof.migrationRollback = 'failed'; },
    (value) => { value.proof.learnerBFinalSha256 = 'f'.repeat(64); },
  ]) {
    await withFixture(async ({ root, authority }) => {
      const { buildB2ExitReport } = await builder();
      const path = join(root, 'reports/b2/ios-simulator-proof.json');
      const report = JSON.parse(await readFile(path, 'utf8'));
      mutate(report);
      await write(root, 'reports/b2/ios-simulator-proof.json', report);
      await assert.rejects(
        buildB2ExitReport({
          root,
          expectedApplicationCommit: COMMIT,
          expectedApplicationFingerprint: FINGERPRINT,
          authority,
        }),
        /lifecycle|migration|learner|evidence/i,
      );
    });
  }
});

test('B2 exit report write/check is deterministic and byte-for-byte fail closed', async () => {
  await withFixture(async ({ root, authority }) => {
    const { checkB2ExitReport, writeB2ExitReport } = await builder();
    await writeB2ExitReport({
      root,
      expectedApplicationCommit: COMMIT,
      expectedApplicationFingerprint: FINGERPRINT,
      authority,
    });
    await assert.doesNotReject(
      checkB2ExitReport({
        root,
        expectedApplicationCommit: COMMIT,
        expectedApplicationFingerprint: FINGERPRINT,
        authority,
      }),
    );
    await writeFile(join(root, 'reports/b2/b2-exit-report.json'), '{}\n');
    await assert.rejects(
      checkB2ExitReport({
        root,
        expectedApplicationCommit: COMMIT,
        expectedApplicationFingerprint: FINGERPRINT,
        authority,
      }),
      /byte-for-byte|stale/i,
    );
  });
});
