import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REQUIRED_PLUGINS = Object.freeze({
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
});
const DOMAINS = Object.freeze(['root', 'file', 'database', 'sharedpref', 'external']);
const DEVICE_DOMAINS = Object.freeze([
  'device_root',
  'device_file',
  'device_database',
  'device_sharedpref',
]);

async function readJson(path) {
  return JSON.parse(await readFile(join(ROOT, path), 'utf8'));
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(join(ROOT, path))).digest('hex');
}

function assertAllDomainExclusions(xml, domains) {
  for (const domain of domains) {
    assert.match(
      xml,
      new RegExp(`<exclude\\s+domain=["']${domain}["']\\s+path=["']\\.["']\\s*\\/>`),
      `missing all-path exclusion for ${domain}`,
    );
  }
}

test('B2 plugins are exact npm dependencies with frozen registry integrity', async () => {
  const [packageJson, packageLock] = await Promise.all([
    readJson('package.json'),
    readJson('package-lock.json'),
  ]);
  for (const [name, expected] of Object.entries(REQUIRED_PLUGINS)) {
    assert.equal(packageJson.dependencies[name], expected.version);
    assert.equal(packageLock.packages[''].dependencies[name], expected.version);
    const lockEntry = packageLock.packages[`node_modules/${name}`];
    assert.equal(lockEntry?.version, expected.version);
    assert.equal(lockEntry?.integrity, expected.integrity);
  }
});

test('B2 uses only native SQLite with explicit no-encryption configuration', async () => {
  const config = await readJson('capacitor.config.json');
  assert.equal(Object.hasOwn(config, 'server'), false);
  assert.equal(config.webDir, 'dist');
  assert.deepEqual(config.plugins, {
    CapacitorSQLite: {
      iosDatabaseLocation: 'Library/CapacitorDatabase',
      iosIsEncryption: false,
      iosBiometric: { biometricAuth: false },
      androidIsEncryption: false,
      androidBiometric: { biometricAuth: false },
    },
  });
  const sourceFiles = (await readdir(join(ROOT, 'src'), { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
  const source = (
    await Promise.all(sourceFiles.map((path) => readFile(path, 'utf8')))
  ).join('\n');
  assert.doesNotMatch(source, /jeep-sqlite|customElements\.define\s*\(\s*['"]jeep-sqlite/i);
});

test('Android source policy removes biometric permissions and excludes every backup domain', async () => {
  const [manifest, backupRules, dataExtractionRules] = await Promise.all([
    readFile(join(ROOT, 'android/app/src/main/AndroidManifest.xml'), 'utf8'),
    readFile(join(ROOT, 'android/app/src/main/res/xml/backup_rules.xml'), 'utf8'),
    readFile(join(ROOT, 'android/app/src/main/res/xml/data_extraction_rules.xml'), 'utf8'),
  ]);
  assert.match(manifest, /android:allowBackup="false"/);
  assert.match(manifest, /android:fullBackupContent="@xml\/backup_rules"/);
  assert.match(manifest, /android:dataExtractionRules="@xml\/data_extraction_rules"/);
  for (const permission of ['USE_BIOMETRIC', 'USE_FINGERPRINT']) {
    assert.match(
      manifest,
      new RegExp(
        `<uses-permission\\s+android:name="android\\.permission\\.${permission}"\\s+tools:node="remove"\\s*\\/>`,
      ),
    );
  }
  assertAllDomainExclusions(backupRules, DOMAINS);
  assertAllDomainExclusions(dataExtractionRules, [...DOMAINS, ...DEVICE_DOMAINS]);
  for (const section of ['cloud-backup', 'device-transfer']) {
    assert.match(dataExtractionRules, new RegExp(`<${section}>[\\s\\S]*<\\/${section}>`));
  }
});

test('Android materialises the complete five-module finite dependency closure', async () => {
  const lockDirectory = join(ROOT, 'android/gradle/dependency-locks');
  const lockfiles = (await readdir(lockDirectory))
    .filter((name) => name.endsWith('.lockfile'))
    .sort();
  assert.deepEqual(lockfiles, [
    'app.lockfile',
    'capacitor-android.lockfile',
    'capacitor-app.lockfile',
    'capacitor-community-sqlite.lockfile',
    'capacitor-cordova-android-plugins.lockfile',
  ]);
  for (const name of lockfiles) {
    const contents = await readFile(join(lockDirectory, name), 'utf8');
    assert.doesNotMatch(contents, /(?:^|:)(?:latest|[^:\n]*\+|[^:\n]*SNAPSHOT)(?==|:)/im);
  }
  const verification = await readFile(
    join(ROOT, 'android/gradle/verification-metadata.xml'),
    'utf8',
  );
  assert.match(verification, /<verify-metadata>true<\/verify-metadata>/);
  assert.doesNotMatch(verification, /<(?:md5|sha1|sha512)\b/);
  assert.ok([...verification.matchAll(/<sha256\s+value="([a-f0-9]{64})"/g)].length > 0);
});

test('iOS adds no usage-description key or app entitlement', async () => {
  const infoPlist = await readFile(join(ROOT, 'ios/App/App/Info.plist'), 'utf8');
  assert.doesNotMatch(infoPlist, /<key>NS[^<]*UsageDescription<\/key>/);
  const iosFiles = await readdir(join(ROOT, 'ios'), { recursive: true, withFileTypes: true });
  assert.deepEqual(
    iosFiles
      .filter((entry) => entry.isFile() && entry.name.endsWith('.entitlements'))
      .map((entry) => join(entry.parentPath, entry.name)),
    [],
  );
});

test('native build report proves the B2 compile and packaged policy surface', async () => {
  assert.ok(existsSync(join(ROOT, 'reports/b2/native-plugin-build.json')));
  const report = await readJson('reports/b2/native-plugin-build.json');
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(report.packages, REQUIRED_PLUGINS);
  assert.deepEqual(report.builds.ios, {
    compiled: true,
    sdk: 'iphonesimulator',
    configuration: 'Debug',
    signed: false,
  });
  assert.deepEqual(report.builds.android, {
    unitTestsPassed: true,
    debugCompiled: true,
    debugSigned: true,
    releaseCompiled: true,
    releaseSigned: false,
  });
  assert.equal(report.android.packagedManifest.allowBackup, false);
  assert.equal(report.android.packagedManifest.fullBackupContent, '@xml/backup_rules');
  assert.equal(
    report.android.packagedManifest.dataExtractionRules,
    '@xml/data_extraction_rules',
  );
  assert.deepEqual(report.android.packagedPermissions.declaredPermissions, []);
  assert.deepEqual(report.android.packagedPermissions.requestedPermissions, []);
  assert.deepEqual(report.android.packagedBackupRules.excludedDomains, DOMAINS);
  assert.deepEqual(
    report.android.packagedDataExtractionRules.cloudBackupExcludedDomains,
    [...DOMAINS, ...DEVICE_DOMAINS],
  );
  assert.deepEqual(
    report.android.packagedDataExtractionRules.deviceTransferExcludedDomains,
    [...DOMAINS, ...DEVICE_DOMAINS],
  );
  assert.deepEqual(report.ios.addedUsageDescriptionKeys, []);
  assert.deepEqual(report.ios.addedEntitlements, []);
  const expectedLockfiles = [
    'android/gradle/dependency-locks/app.lockfile',
    'android/gradle/dependency-locks/capacitor-android.lockfile',
    'android/gradle/dependency-locks/capacitor-app.lockfile',
    'android/gradle/dependency-locks/capacitor-community-sqlite.lockfile',
    'android/gradle/dependency-locks/capacitor-cordova-android-plugins.lockfile',
  ];
  assert.deepEqual(
    report.android.dependencyClosure.lockfiles.map(({ path }) => path),
    expectedLockfiles,
  );
  for (const entry of report.android.dependencyClosure.lockfiles) {
    assert.equal(entry.sha256, await sha256(entry.path));
  }
  assert.equal(report.android.dependencyClosure.componentCount, 314);
  assert.equal(report.android.dependencyClosure.scopeMembershipCount, 5452);
  assert.equal(
    report.android.dependencyClosure.verificationMetadataSha256,
    await sha256('android/gradle/verification-metadata.xml'),
  );
  assert.equal(report.approval, 'build-proof-only');
  assert.equal(report.finalPrivacyApproval, false);
  assert.equal(report.finalExportApproval, false);
});
