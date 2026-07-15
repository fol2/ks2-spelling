import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SHA256 = /^[a-f0-9]{64}$/;

async function readJson(path) {
  return JSON.parse(await readFile(join(ROOT, path), 'utf8'));
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(join(ROOT, path))).digest('hex');
}

async function importAudit() {
  return import(pathToFileURL(join(ROOT, 'scripts/audit-dependencies.mjs')));
}

test('B2 dependency evidence preserves B1 and binds the exact native build', async () => {
  assert.equal(
    await sha256('reports/b1/dependency-audit.json'),
    '1af859ea0a499c24fb33975149b8777c47225da9a1c388cbb6fc1dc9b0a3385c',
  );
  const [build, audit, plugin] = await Promise.all([
    readJson('reports/b2/native-plugin-build.json'),
    readJson('reports/b2/dependency-audit.json'),
    readJson('reports/b2/native-plugin-audit.json'),
  ]);
  const buildSha256 = await sha256('reports/b2/native-plugin-build.json');
  assert.match(buildSha256, SHA256);
  assert.equal(audit.generatedFrom.nativePluginBuildSha256, buildSha256);
  assert.equal(plugin.nativePluginBuildSha256, buildSha256);
  assert.equal(
    plugin.webViewBundleEvidenceSha256,
    audit.npm.webViewBundle.evidenceSha256,
  );
  assert.equal(
    audit.generatedFrom.webViewBundleEvidenceSha256,
    audit.npm.webViewBundle.evidenceSha256,
  );
  assert.equal(audit.android.componentCount, build.android.dependencyClosure.componentCount);
  assert.equal(
    audit.android.scopeMembershipCount,
    build.android.dependencyClosure.scopeMembershipCount,
  );
  assert.equal(audit.android.components.length, audit.android.componentCount);
  assert.equal(audit.android.lockfiles.length, 5);
  assert.deepEqual(
    audit.android.lockfiles.map(({ path }) => path),
    [
      'android/gradle/dependency-locks/app.lockfile',
      'android/gradle/dependency-locks/capacitor-android.lockfile',
      'android/gradle/dependency-locks/capacitor-app.lockfile',
      'android/gradle/dependency-locks/capacitor-community-sqlite.lockfile',
      'android/gradle/dependency-locks/capacitor-cordova-android-plugins.lockfile',
    ],
  );
  assert.deepEqual(plugin.androidBackupExcludedDomains, [
    'root',
    'file',
    'database',
    'sharedpref',
    'external',
  ]);
  const allDataDomains = [
    'root',
    'file',
    'database',
    'sharedpref',
    'external',
    'device_root',
    'device_file',
    'device_database',
    'device_sharedpref',
  ];
  assert.deepEqual(plugin.androidCloudBackupExcludedDomains, allDataDomains);
  assert.deepEqual(plugin.androidDeviceTransferExcludedDomains, allDataDomains);
  for (const lockfile of audit.android.lockfiles) {
    assert.match(lockfile.sha256, SHA256);
  }
});

test('B2 policy certifies exact npm and resolution-kind-aware SwiftPM identities', async () => {
  const audit = await readJson('reports/b2/dependency-audit.json');
  const npm = new Map(audit.npm.production.map((entry) => [entry.name, entry]));
  assert.equal(audit.npm.allPackages.length, audit.npm.lockPackageCount);
  for (const entry of audit.npm.allPackages) {
    assert.match(entry.integrity, /^sha(512|1)-/);
    assert.match(entry.source, /^https:\/\/registry\.npmjs\.org\//);
    assert.ok(entry.licence);
    assert.ok(entry.privacyRole);
    assert.equal(typeof entry.packaged, 'boolean');
    assert.ok(entry.restrictedExportClassification);
    assert.ok(entry.restrictedClassification);
    assert.ok(entry.exportClassification);
  }
  assert.equal(
    npm.get('@capacitor-community/sqlite').integrity,
    'sha512-yhKZDAVPDPcM3QE6UGB3LXyV25a6Rve1SjZ1aUpTE0E2isnYTVM0PG9+JOI241f+NdsHzPTE7ESJiYSqKsKnuA==',
  );
  assert.equal(
    npm.get('@capacitor/app').integrity,
    'sha512-MlmttTOWHDedr/G4SrhNRxsXMqY+R75S4MM4eIgzsgCzOYhb/MpCkA5Q3nuOCfL1oHm26xjUzqZ5aupbOwdfYg==',
  );
  assert.deepEqual(
    audit.spm.map(({ identity, requirement, revision }) => ({ identity, requirement, revision })),
    [
      {
        identity: 'capacitor-swift-pm',
        requirement: { kind: 'version', version: '8.4.1' },
        revision: '2231987d85b8b0b289320b1d0947b4ae8345cde4',
      },
      {
        identity: 'sqlcipher.swift',
        requirement: { kind: 'version', version: '4.17.0' },
        revision: '205df55271aa1ba512a9bfe3fd1813bc9ac52a19',
      },
      {
        identity: 'zipfoundation',
        requirement: { kind: 'version', version: '0.9.20' },
        revision: '22787ffb59de99e5dc1fbfe80b19c97a904ad48d',
      },
    ],
  );
  for (const entry of [...audit.npm.production, ...audit.spm, ...audit.android.components]) {
    assert.ok(entry.source ?? entry.pom?.sourceUrl, `${entry.name ?? entry.coordinate} source`);
    assert.ok(entry.licence, `${entry.name ?? entry.coordinate} licence`);
  }
  for (const entry of [
    ...audit.android.components,
    ...audit.android.taskCreatedBuildTools,
  ]) {
    assert.equal(typeof entry.packaged, 'boolean');
    assert.ok(entry.privacyRole);
    assert.ok(entry.restrictedClassification);
    assert.ok(entry.exportClassification);
    for (const artefact of entry.artifacts) {
      assert.match(artefact.sha256, SHA256);
      assert.match(artefact.sourceUrl, /^https:\/\//);
    }
  }
  const androidSqlCipher = audit.android.components.find(
    ({ coordinate }) => coordinate === 'net.zetetic:sqlcipher-android:4.10.0',
  );
  assert.equal(androidSqlCipher.packaged, true);
  assert.equal(androidSqlCipher.exportClassification, 'unresolved-before-store-release');
});

test('B2 privacy and store-release boundary is exact and honest', async () => {
  const plugin = await readJson('reports/b2/native-plugin-audit.json');
  assert.deepEqual(
    {
      sqliteMode: plugin.sqliteMode,
      webFallbackInitialised: plugin.webFallbackInitialised,
      androidPackagedPermissions: plugin.androidPackagedPermissions,
      iosAddedUsageDescriptionKeys: plugin.iosAddedUsageDescriptionKeys,
      iosAddedEntitlements: plugin.iosAddedEntitlements,
      androidBackupEnabled: plugin.androidBackupEnabled,
      androidDataExtraction: plugin.androidDataExtraction,
      sqlCipherPackaged: plugin.sqlCipherPackaged,
      applicationEncryptionAtRestProved: plugin.applicationEncryptionAtRestProved,
      usEncryptionExportClassification: plugin.usEncryptionExportClassification,
      approval: plugin.approval,
    },
    {
      sqliteMode: 'no-encryption',
      webFallbackInitialised: false,
      androidPackagedPermissions: [],
      iosAddedUsageDescriptionKeys: [],
      iosAddedEntitlements: [],
      androidBackupEnabled: false,
      androidDataExtraction: 'all-domains-excluded-until-c2',
      sqlCipherPackaged: true,
      applicationEncryptionAtRestProved: false,
      usEncryptionExportClassification: 'unresolved-before-store-release',
      approval: 'B2-proof-only',
    },
  );
  const infoPlist = await readFile(join(ROOT, 'ios/App/App/Info.plist'), 'utf8');
  assert.doesNotMatch(infoPlist, /ITSAppUsesNonExemptEncryption/);
  const register = await readFile(join(ROOT, 'docs/compliance/sdk-privacy-register.md'), 'utf8');
  assert.match(register, /B2 proof only/);
  assert.match(register, /SQLCipher[^\n]+packaged/i);
  assert.match(register, /unresolved before store release/i);
  assert.match(register, /does not prove encryption at rest/i);
});

test('active notices publish totals consistent with the active dependency report', async () => {
  const androidBuild = await readFile(join(ROOT, 'android/app/build.gradle'), 'utf8');
  const evidenceStage = /com\.android\.billingclient:billing:9\.1\.0/.test(androidBuild)
    ? 'b3'
    : 'b2';
  const audit = await readJson(`reports/${evidenceStage}/dependency-audit.json`);
  const notices = await readFile(join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.match(notices, new RegExp(`npm lock identities: ${audit.npm.lockPackageCount}`));
  assert.match(notices, new RegExp(`SwiftPM identities: ${audit.spm.length}`));
  assert.match(
    notices,
    new RegExp(`Maven selected module identities: ${audit.android.componentCount}`),
  );
  assert.match(
    notices,
    new RegExp(
      `Maven verification inventory: ${audit.android.verificationInventory.componentCount} components and ${audit.android.verificationInventory.artifactCount} artefacts`,
    ),
  );
});

test('B2 audits the exact four packaged iOS privacy manifests and reasons', async () => {
  const audit = await readJson('reports/b2/dependency-audit.json');
  const plugin = await readJson('reports/b2/native-plugin-audit.json');
  const expected = [
    {
      path: 'Frameworks/Capacitor.framework/PrivacyInfo.xcprivacy',
      sha256: '1bac827f49b2b8a5358491b9698203bf191791a6f1ba3a3ace3b1285d52d2d17',
      tracking: false,
      collectedDataTypes: [],
      trackingDomains: [],
      requiredReasonApis: [],
    },
    {
      path: 'Frameworks/Cordova.framework/PrivacyInfo.xcprivacy',
      sha256: '5a9b8fc0cddb10201bb47cc2804b3f004c7251476622d25bfc4eb54ed46e1084',
      tracking: false,
      collectedDataTypes: [],
      trackingDomains: [],
      requiredReasonApis: [],
    },
    {
      path: 'Frameworks/SQLCipher.framework/PrivacyInfo.xcprivacy',
      sha256: '9362796ba800a7b4169834eff8bde990866f40114ff7baac002b8bae543e8dd1',
      tracking: false,
      collectedDataTypes: [],
      trackingDomains: [],
      requiredReasonApis: [
        {
          category: 'NSPrivacyAccessedAPICategoryDiskSpace',
          reasons: ['E174.1'],
        },
        {
          category: 'NSPrivacyAccessedAPICategoryFileTimestamp',
          reasons: ['3B52.1', 'C617.1'],
        },
      ],
    },
    {
      path: 'ZIPFoundation_ZIPFoundation.bundle/PrivacyInfo.xcprivacy',
      sha256: '9a2f930cedb8d58309a581b9bf9bf3673685ec02ae2197d9f1c56828b718dffd',
      tracking: false,
      collectedDataTypes: [],
      trackingDomains: [],
      requiredReasonApis: [
        {
          category: 'NSPrivacyAccessedAPICategoryFileTimestamp',
          reasons: ['0A2A.1'],
        },
      ],
    },
  ];
  assert.deepEqual(audit.ios.packagedPrivacyManifests, expected);
  assert.deepEqual(plugin.iosPackagedPrivacyManifests, expected);
  const {
    assertIosPackagedPrivacyManifestEvidenceCurrent,
    resolveIosPackagedPrivacyManifestEvidence,
  } = await importAudit();
  assert.doesNotThrow(() =>
    assertIosPackagedPrivacyManifestEvidenceCurrent(expected, expected),
  );
  for (const tampered of [
    expected.slice(1),
    [...expected, { ...expected[0], path: 'Extra/PrivacyInfo.xcprivacy' }],
    expected.map((entry, index) =>
      index === 0 ? { ...entry, sha256: '0'.repeat(64) } : entry,
    ),
    expected.map((entry, index) =>
      index === 2
        ? {
            ...entry,
            requiredReasonApis: [
              { category: 'NSPrivacyAccessedAPICategoryDiskSpace', reasons: ['wrong'] },
            ],
          }
        : entry,
    ),
  ]) {
    assert.throws(
      () => assertIosPackagedPrivacyManifestEvidenceCurrent(tampered, expected),
      ({ code }) => code === 'ios_packaged_privacy_manifest_drift',
    );
  }
  assert.deepEqual(
    await resolveIosPackagedPrivacyManifestEvidence({
      appPath: join(
        ROOT,
        '.native-build/ios/Build/Products/Debug-iphonesimulator/App.app',
      ),
      committed: expected,
    }),
    expected,
  );
  assert.deepEqual(
    await resolveIosPackagedPrivacyManifestEvidence({
      appPath: join(ROOT, '.native-build/ios/intentionally-absent/App.app'),
      committed: expected,
    }),
    expected,
  );
  await assert.rejects(
    () =>
      resolveIosPackagedPrivacyManifestEvidence({
        appPath: join(ROOT, '.native-build/ios/intentionally-absent/App.app'),
        committed: expected,
        requireFresh: true,
      }),
    ({ code }) => code === 'ios_packaged_privacy_manifest_missing',
  );
});

test('B2 npm packaging comes only from the deterministic write-false bundle inventory', async () => {
  const audit = await readJson('reports/b2/dependency-audit.json');
  assert.deepEqual(audit.npm.webViewBundle.packageNames, [
    '@capacitor-community/sqlite',
    '@capacitor/app',
    '@capacitor/core',
    'react',
    'react-dom',
    'scheduler',
  ]);
  assert.equal(audit.npm.webViewBundle.moduleCount, 64);
  assert.equal(audit.npm.webViewBundle.mode, 'vite-rollup-write-false');
  assert.match(audit.npm.webViewBundle.evidenceSha256, SHA256);
  assert.ok(audit.npm.webViewBundle.modules.length === 64);
  const packaged = audit.npm.allPackages
    .filter((entry) => entry.packaged)
    .map(({ name }) => name)
    .sort();
  assert.deepEqual(packaged, [
    '@capacitor-community/sqlite',
    '@capacitor/app',
    '@capacitor/core',
    'react',
    'react-dom',
    'scheduler',
  ]);
  for (const packageName of ['@capacitor/android', '@capacitor/ios']) {
    const entry = audit.npm.allPackages.find(
      (candidate) => candidate.name === packageName && candidate.locator === `node_modules/${packageName}`,
    );
    assert.equal(entry.packaged, false, packageName);
    assert.equal(entry.distribution, 'native-build-source', packageName);
  }
  for (const packageName of [
    '@capacitor-community/sqlite',
    '@capacitor/app',
    '@capacitor/core',
  ]) {
    const entry = audit.npm.allPackages.find(
      ({ locator }) => locator === `node_modules/${packageName}`,
    );
    assert.equal(entry.packaged, true, packageName);
    assert.equal(entry.distribution, 'webview-bundle', packageName);
  }
  for (const packageName of ['jeep-sqlite', 'sql.js', '@stencil/core', 'localforage']) {
    const entries = audit.npm.allPackages.filter(({ name }) => name === packageName);
    assert.ok(entries.length > 0, packageName);
    assert.ok(entries.every(({ packaged }) => packaged === false), packageName);
    assert.ok(
      entries.every(({ distribution }) => distribution === 'installed-not-packaged'),
      packageName,
    );
  }
  const { assertWebViewBundleEvidenceCurrent } = await importAudit();
  assert.doesNotThrow(() =>
    assertWebViewBundleEvidenceCurrent(audit.npm.webViewBundle, audit.npm.webViewBundle),
  );
  assert.throws(
    () =>
      assertWebViewBundleEvidenceCurrent(
        { ...audit.npm.webViewBundle, packageNames: ['jeep-sqlite'] },
        audit.npm.webViewBundle,
      ),
    ({ code }) => code === 'webview_bundle_evidence_drift',
  );
});

test('unpackaged npm identities never claim bundled or packaged artefact status', async () => {
  const audit = await readJson('reports/b2/dependency-audit.json');
  assert.equal(audit.npm.allPackages.length, 189);
  for (const entry of audit.npm.allPackages) {
    assert.ok(entry.role, `${entry.locator} role`);
    assert.ok(entry.platform, `${entry.locator} platform`);
    assert.ok(entry.privacyRole, `${entry.locator} privacy role`);
    if (!entry.packaged) {
      assert.doesNotMatch(
        `${entry.role} ${entry.platform} ${entry.privacyRole}`,
        /\bbundled\b|packaged (?:artefact|runtime|code)/i,
        entry.locator,
      );
    }
  }
  assert.deepEqual(
    audit.npm.allPackages
      .filter(({ distribution }) => distribution === 'native-build-source')
      .map(({ name }) => name)
      .sort(),
    ['@capacitor/android', '@capacitor/ios'],
  );
});
