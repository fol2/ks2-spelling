import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ANDROID_ROOT = join(ROOT, 'android');

const APP_BUILD = join(ANDROID_ROOT, 'app/build.gradle');
const ROOT_BUILD = join(ANDROID_ROOT, 'build.gradle');
const VARIABLES = join(ANDROID_ROOT, 'variables.gradle');
const WRAPPER = join(ANDROID_ROOT, 'gradle/wrapper/gradle-wrapper.properties');
const MANIFEST = join(ANDROID_ROOT, 'app/src/main/AndroidManifest.xml');
const STRINGS = join(ANDROID_ROOT, 'app/src/main/res/values/strings.xml');
const BACKUP_RULES = join(ANDROID_ROOT, 'app/src/main/res/xml/backup_rules.xml');
const DATA_EXTRACTION_RULES = join(
  ANDROID_ROOT,
  'app/src/main/res/xml/data_extraction_rules.xml',
);

test('the committed Android project freezes the B1 identity and toolchain', async () => {
  const requiredFiles = [
    APP_BUILD,
    ROOT_BUILD,
    VARIABLES,
    WRAPPER,
    MANIFEST,
    STRINGS,
  ];
  assert.ok(
    requiredFiles.every(existsSync),
    'missing committed Android project or Gradle wrapper',
  );

  const [appBuild, rootBuild, variables, wrapper, strings] = await Promise.all([
    readFile(APP_BUILD, 'utf8'),
    readFile(ROOT_BUILD, 'utf8'),
    readFile(VARIABLES, 'utf8'),
    readFile(WRAPPER, 'utf8'),
    readFile(STRINGS, 'utf8'),
  ]);

  assert.match(appBuild, /namespace = "uk\.eugnel\.ks2spelling"/);
  assert.match(appBuild, /applicationId "uk\.eugnel\.ks2spelling"/);
  assert.match(strings, /<string name="app_name">KS2 Spelling<\/string>/);
  assert.match(strings, /<string name="title_activity_main">KS2 Spelling<\/string>/);
  assert.match(strings, /<string name="package_name">uk\.eugnel\.ks2spelling<\/string>/);
  assert.match(strings, /<string name="custom_url_scheme">uk\.eugnel\.ks2spelling<\/string>/);

  assert.match(variables, /minSdkVersion = 24/);
  assert.match(variables, /compileSdkVersion = 36/);
  assert.match(variables, /targetSdkVersion = 36/);
  assert.match(variables, /buildToolsVersion = ['"]36\.0\.0['"]/);
  assert.match(
    rootBuild,
    /plugins\.withId\(['"]com\.android\.(?:application|library)['"]\)/,
  );
  assert.match(rootBuild, /android\.buildToolsVersion = rootProject\.ext\.buildToolsVersion/);
  assert.match(rootBuild, /dependencyLocking\s*\{/);
  assert.match(rootBuild, /lockAllConfigurations\(\)/);
  assert.match(rootBuild, /gradle\/dependency-locks/);
  assert.match(rootBuild, /com\.android\.tools\.build:gradle:8\.13\.0/);
  assert.match(wrapper, /gradle-8\.14\.3-all\.zip/);

  const capacitorAndroidPackage = JSON.parse(
    await readFile(join(ROOT, 'node_modules/@capacitor/android/package.json'), 'utf8'),
  );
  assert.equal(capacitorAndroidPackage.version, '8.4.1');
});

test('the B2 Android app declares only permission removals and disables backup', async () => {
  assert.ok(existsSync(MANIFEST), 'missing committed Android app manifest');
  assert.ok(
    existsSync(BACKUP_RULES) && existsSync(DATA_EXTRACTION_RULES),
    'missing Android backup exclusion resources',
  );

  const manifest = await readFile(MANIFEST, 'utf8');
  assert.match(manifest, /xmlns:tools="http:\/\/schemas\.android\.com\/tools"/);
  const removalMarkers = [
    ...manifest.matchAll(
      /<(permission|uses-permission)\s+android:name="\$\{applicationId\}\.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION"\s+tools:node="remove"\s*\/>/g,
    ),
  ];
  const biometricRemovalMarkers = [
    ...manifest.matchAll(
      /<uses-permission\s+android:name="android\.permission\.(USE_BIOMETRIC|USE_FINGERPRINT)"\s+tools:node="remove"\s*\/>/g,
    ),
  ];
  assert.deepEqual(removalMarkers.map((match) => match[1]).sort(), [
    'permission',
    'uses-permission',
  ]);
  assert.deepEqual(
    biometricRemovalMarkers.map((match) => match[1]).sort(),
    ['USE_BIOMETRIC', 'USE_FINGERPRINT'],
  );
  let manifestWithoutRemovalMarkers = manifest;
  for (const marker of [...removalMarkers, ...biometricRemovalMarkers]) {
    manifestWithoutRemovalMarkers = manifestWithoutRemovalMarkers.replace(marker[0], '');
  }
  assert.doesNotMatch(manifestWithoutRemovalMarkers, /<(?:permission|uses-permission)\b/);
  assert.match(manifest, /android:allowBackup="false"/);
  assert.match(manifest, /android:fullBackupContent="@xml\/backup_rules"/);
  assert.match(manifest, /android:dataExtractionRules="@xml\/data_extraction_rules"/);
  assert.doesNotMatch(manifest, /android:usesCleartextTraffic\s*=/);
  assert.doesNotMatch(manifest, /android:networkSecurityConfig\s*=/);
  assert.equal(
    existsSync(join(ANDROID_ROOT, 'app/src/main/res/xml/network_security_config.xml')),
    false,
  );
});
