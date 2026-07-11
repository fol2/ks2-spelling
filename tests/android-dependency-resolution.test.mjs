import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

async function importResolver() {
  return import(pathToFileURL(join(ROOT, 'scripts/resolve-android-dependencies.mjs')));
}

function rawResolution() {
  return {
    schemaVersion: 1,
    components: [
      {
        group: 'org.example',
        name: 'runtime',
        version: '2.0.0',
        scopes: [
          { project: ':app', configuration: 'debugRuntimeClasspath', buildscript: false },
        ],
        artifacts: [{ name: 'runtime-2.0.0.jar', sha256: SHA_B }],
      },
      {
        group: 'com.example',
        name: 'build-tool',
        version: '1.0.0',
        scopes: [{ project: ':', configuration: 'classpath', buildscript: true }],
        artifacts: [{ name: 'build-tool-1.0.0.jar', sha256: SHA_A }],
      },
    ],
    poms: [
      {
        group: 'org.example',
        name: 'runtime',
        version: '2.0.0',
        file: '/ignored/local/runtime.pom',
        sha256: SHA_A,
      },
      {
        group: 'com.example',
        name: 'build-tool',
        version: '1.0.0',
        file: '/ignored/local/build-tool.pom',
        sha256: SHA_B,
      },
    ],
  };
}

test('Android dependency certification files and scoped lockfiles are committed', async () => {
  for (const path of [
    'android/gradle/b1-dependency-resolution.init.gradle',
    'scripts/resolve-android-dependencies.mjs',
    'android/gradle/dependency-locks/app.lockfile',
    'android/gradle/dependency-locks/capacitor-android.lockfile',
    'android/gradle/dependency-locks/capacitor-cordova-android-plugins.lockfile',
    'android/gradle/verification-metadata.xml',
  ]) {
    assert.ok(existsSync(join(ROOT, path)), path);
  }
  const initScript = await readFile(
    join(ROOT, 'android/gradle/b1-dependency-resolution.init.gradle'),
    'utf8',
  );
  assert.match(initScript, /project\.buildscript\.configurations/);
  assert.match(initScript, /ModuleComponentIdentifier/);
  assert.match(initScript, /MavenPomArtifact/);
  assert.match(initScript, /sha256/);
  const packageJson = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(
    packageJson.scripts['certify:android'],
    'node scripts/certify-android-dependencies.mjs',
  );
});

test('Gradle verification metadata covers every resolved POM and binary checksum', async () => {
  const {
    assertVerificationMetadataCoversResolution,
    assertVerificationMetadataMatchesInventory,
    parseVerificationMetadataInventory,
  } = await importResolver();
  const canonical = {
    schemaVersion: 1,
    componentCount: 1,
    scopeMembershipCount: 1,
    components: [
      {
        coordinate: 'com.example:library:1.0.0',
        group: 'com.example',
        name: 'library',
        version: '1.0.0',
        scopes: [{ project: ':app', configuration: 'debugRuntimeClasspath', buildscript: false }],
        artifacts: [{ name: 'library-1.0.0.jar', sha256: SHA_A }],
        pom: { sha256: SHA_B },
      },
    ],
  };
  const metadata = `<?xml version="1.0"?>
<verification-metadata>
  <configuration><verify-metadata>true</verify-metadata><verify-signatures>false</verify-signatures></configuration>
  <components><component group="com.example" name="library" version="1.0.0">
    <artifact name="library-1.0.0.jar"><sha256 value="${SHA_A}"/></artifact>
    <artifact name="library-1.0.0.pom"><sha256 value="${SHA_B}"/></artifact>
  </component></components>
</verification-metadata>`;
  assert.doesNotThrow(() =>
    assertVerificationMetadataCoversResolution(canonical, metadata),
  );
  assert.throws(
    () =>
      assertVerificationMetadataCoversResolution(
        canonical,
        metadata.replace(SHA_A, SHA_B),
      ),
    ({ code }) => code === 'android_verification_metadata_invalid',
  );
  const inventory = parseVerificationMetadataInventory(metadata);
  assert.equal(inventory.componentCount, 1);
  assert.equal(inventory.artifactCount, 2);
  assert.doesNotThrow(() =>
    assertVerificationMetadataMatchesInventory(metadata, inventory),
  );
  const extraComponent = metadata.replace(
    '</components>',
    `<component name="extra" version="1" group="evil"><artifact name="extra-1.pom"><sha256 value="${SHA_A}"/></artifact></component></components>`,
  );
  assert.throws(
    () => assertVerificationMetadataMatchesInventory(extraComponent, inventory),
    ({ code }) => code === 'android_verification_metadata_invalid',
  );
  const extraArtifact = metadata.replace(
    '</component>',
    `<artifact name="unexpected.jar"><sha256 value="${SHA_A}"/></artifact></component>`,
  );
  assert.throws(
    () => assertVerificationMetadataMatchesInventory(extraArtifact, inventory),
    ({ code }) => code === 'android_verification_metadata_invalid',
  );
  const duplicateChecksum = metadata.replace(
    `<sha256 value="${SHA_A}"/>`,
    `<sha256 value="${SHA_A}"/><sha256 value="${SHA_A}"/>`,
  );
  assert.throws(
    () => parseVerificationMetadataInventory(duplicateChecksum),
    ({ code }) => code === 'android_verification_metadata_invalid',
  );
  for (const invalidAttributes of [
    `group="com.example" name="library" version="1.0.0" evil='x'`,
    'group="com.example" name="library" version="1.0.0" bare-junk',
  ]) {
    assert.throws(
      () =>
        parseVerificationMetadataInventory(
          metadata.replace(
            'group="com.example" name="library" version="1.0.0"',
            invalidAttributes,
          ),
        ),
      ({ code }) => code === 'android_verification_metadata_invalid',
    );
  }
  assert.throws(
    () =>
      parseVerificationMetadataInventory(
        metadata.replace(
          `<sha256 value="${SHA_A}"/>`,
          `<sha256 value="${SHA_A}" unknown='x'/>`,
        ),
      ),
    ({ code }) => code === 'android_verification_metadata_invalid',
  );
});

test('committed verification metadata closes fresh-cache POM and module selection', async () => {
  const { parseVerificationMetadataInventory } = await importResolver();
  const metadata = await readFile(
    join(ROOT, 'android/gradle/verification-metadata.xml'),
    'utf8',
  );
  const inventory = parseVerificationMetadataInventory(metadata);
  const components = new Map(
    inventory.components.map(({ coordinate, artifacts }) => [
      coordinate,
      new Map(artifacts.map(({ name, sha256 }) => [name, sha256])),
    ]),
  );
  const freshCacheClosure = [
    {
      coordinate: 'com.google.guava:guava-parent:33.3.1-jre',
      name: 'guava-parent-33.3.1-jre.pom',
      sha256: '55441db27e8869dfefe053059bdf478bdc7e95585642bf391f0023345fd56287',
    },
    {
      coordinate: 'org.junit:junit-bom:5.10.2',
      name: 'junit-bom-5.10.2.module',
      sha256: 'de23b114b3e4119a8fe6eb17bed5a3852816698bace67071579d6d927ebb080a',
    },
  ];

  for (const artifact of freshCacheClosure) {
    assert.equal(
      components.get(artifact.coordinate)?.get(artifact.name),
      artifact.sha256,
      `${artifact.coordinate}:${artifact.name}`,
    );
  }
});

test('raw Gradle resolution is canonicalised as unique modules with exact scopes and checksums', async () => {
  const { canonicaliseGradleResolution } = await importResolver();
  const canonical = canonicaliseGradleResolution(rawResolution());

  assert.equal(canonical.schemaVersion, 1);
  assert.equal(canonical.componentCount, 2);
  assert.equal(canonical.scopeMembershipCount, 2);
  assert.deepEqual(
    canonical.components.map(({ coordinate }) => coordinate),
    ['com.example:build-tool:1.0.0', 'org.example:runtime:2.0.0'],
  );
  assert.equal(JSON.stringify(canonical).includes('/ignored/local'), false);
  assert.deepEqual(canonical.components[0].pom, { sha256: SHA_B });
});

test('raw Gradle resolution fails closed on duplicate, missing or malformed evidence', async () => {
  const { canonicaliseGradleResolution } = await importResolver();

  const duplicate = rawResolution();
  duplicate.components.push(structuredClone(duplicate.components[0]));
  assert.throws(
    () => canonicaliseGradleResolution(duplicate),
    ({ code }) => code === 'android_resolution_invalid',
  );

  const missingPom = rawResolution();
  missingPom.poms.pop();
  assert.throws(
    () => canonicaliseGradleResolution(missingPom),
    ({ code }) => code === 'android_resolution_invalid',
  );

  const malformed = rawResolution();
  malformed.components[0].artifacts[0].sha256 = 'not-a-sha';
  assert.throws(
    () => canonicaliseGradleResolution(malformed),
    ({ code }) => code === 'android_resolution_invalid',
  );
});

test('committed Android certification is bound to every resolver and policy input', async () => {
  const reportText = await readFile(
    join(ROOT, 'reports/b1/android-dependency-resolution.json'),
    'utf8',
  );
  const report = JSON.parse(reportText);
  assert.equal(report.componentCount, 286);
  assert.equal(report.taskCreatedBuildToolCount, 12);
  assert.equal(report.verificationInventory.componentCount, 392);
  assert.equal(report.verificationInventory.artifactCount, 767);
  assert.equal(reportText.includes('/Users/'), false);
  const inputs = new Set(report.generatedFrom.map(({ path }) => path));
  for (const path of [
    'package.json',
    'scripts/certify-android-dependencies.mjs',
    'scripts/resolve-android-dependencies.mjs',
    'scripts/lib/maven-evidence.mjs',
    'config/dependency-policy.json',
    'config/maven-licence-policy.json',
    'android/gradle/verification-metadata.xml',
  ]) {
    assert.ok(inputs.has(path), path);
  }
});
