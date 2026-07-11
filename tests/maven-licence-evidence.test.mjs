import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function importEvidence() {
  return import(pathToFileURL(join(ROOT, 'scripts/lib/maven-evidence.mjs')));
}

async function importCertifier() {
  return import(pathToFileURL(join(ROOT, 'scripts/certify-android-dependencies.mjs')));
}

test('Maven POM parsing preserves exact direct licence fields and parent identity', async () => {
  const { parseMavenPom } = await importEvidence();
  const parsed = parseMavenPom(`<?xml version="1.0"?>
<project>
  <parent><groupId>org.parent</groupId><artifactId>parent</artifactId><version>2</version></parent>
  <licenses><license>
    <name><![CDATA[CDDL + GPLv2 with classpath exception]]></name>
    <url>https://example.test/a&amp;b</url>
    <distribution>repo</distribution>
    <comments>Keep both terms</comments>
  </license></licenses>
</project>`);

  assert.equal(parsed.parentCoordinate, 'org.parent:parent:2');
  assert.deepEqual(parsed.licences, [
    {
      name: 'CDDL + GPLv2 with classpath exception',
      url: 'https://example.test/a&b',
      distribution: 'repo',
      comments: 'Keep both terms',
    },
  ]);
});

test('scope-restricted Maven terms pass only for the exact tooling component', async () => {
  const { applyMavenLicencePolicy } = await importCertifier();
  const signature = 'sha256:' + 'a'.repeat(64);
  const policy = {
    classifications: {
      [signature]: {
        expression: 'LicenseRef-Custom',
        scopePolicy: 'tooling-or-test-only',
      },
    },
    componentOverrides: {},
    scopeRestrictedComponents: {
      'org.example:tool:1': 'LicenseRef-Custom',
    },
  };
  const evidence = {
    licences: [
      { name: 'Custom', url: 'https://example.test/licence', distribution: '', comments: '' },
    ],
  };
  assert.deepEqual(
    applyMavenLicencePolicy({
      coordinate: 'org.example:tool:1',
      distribution: 'tooling-or-test-only',
      signatures: [signature],
      effective: evidence,
      policy,
    }),
    { expression: 'LicenseRef-Custom', scopePolicy: 'tooling-or-test-only' },
  );
  assert.throws(
    () =>
      applyMavenLicencePolicy({
        coordinate: 'org.example:tool:1',
        distribution: 'packaged-runtime',
        signatures: [signature],
        effective: evidence,
        policy,
      }),
    ({ code }) => code === 'maven_licence_policy_violation',
  );
  assert.throws(
    () =>
      applyMavenLicencePolicy({
        coordinate: 'org.example:unreviewed-dual:1',
        distribution: 'tooling-or-test-only',
        signatures: [signature, 'sha256:' + 'b'.repeat(64)],
        effective: evidence,
        policy: {
          classifications: {
            [signature]: {
              expression: 'MIT',
              scopePolicy: 'any',
            },
            ['sha256:' + 'b'.repeat(64)]: {
              expression: 'Apache-2.0',
              scopePolicy: 'any',
            },
          },
          componentOverrides: {},
          scopeRestrictedComponents: {},
        },
      }),
    ({ code }) => code === 'maven_licence_policy_violation',
  );
});

test('committed Android certification comparison rejects coordinate and scope drift', async () => {
  const { assertAndroidCertificationCurrent } = await importCertifier();
  const committed = {
    schemaVersion: 1,
    components: [
      {
        coordinate: 'org.example:library:1',
        scopes: [{ project: ':app', configuration: 'debugRuntimeClasspath', buildscript: false }],
      },
    ],
  };
  assert.doesNotThrow(() => assertAndroidCertificationCurrent(committed, committed));
  const coordinateDrift = structuredClone(committed);
  coordinateDrift.components[0].coordinate = 'org.example:library:2';
  assert.throws(
    () => assertAndroidCertificationCurrent(coordinateDrift, committed),
    ({ code }) => code === 'android_certification_stale',
  );
  const scopeDrift = structuredClone(committed);
  scopeDrift.components[0].scopes.push({
    project: ':app',
    configuration: 'releaseRuntimeClasspath',
    buildscript: false,
  });
  assert.throws(
    () => assertAndroidCertificationCurrent(scopeDrift, committed),
    ({ code }) => code === 'android_certification_stale',
  );
});

test('effective Maven licence evidence follows parents with exact provenance and no guessing', async () => {
  const { resolveEffectiveMavenLicences } = await importEvidence();
  const poms = new Map([
    [
      'org.child:child:1',
      {
        text: '<project><parent><groupId>org.parent</groupId><artifactId>parent</artifactId><version>2</version></parent></project>',
        sha256: 'a'.repeat(64),
        sourceUrl: 'https://repo.example/org/child/child/1/child-1.pom',
      },
    ],
    [
      'org.parent:parent:2',
      {
        text: '<project><licenses><license><name>Apache-2.0</name><url>https://apache.example</url></license></licenses></project>',
        sha256: 'b'.repeat(64),
        sourceUrl: 'https://repo.example/org/parent/parent/2/parent-2.pom',
      },
    ],
  ]);
  const evidence = await resolveEffectiveMavenLicences(
    ['org.child:child:1'],
    async (coordinate) => poms.get(coordinate) ?? null,
  );
  assert.deepEqual(evidence[0], {
    coordinate: 'org.child:child:1',
    declaredBy: 'org.parent:parent:2',
    inherited: true,
    pom: {
      sha256: 'b'.repeat(64),
      sourceUrl: 'https://repo.example/org/parent/parent/2/parent-2.pom',
    },
    licences: [
      {
        name: 'Apache-2.0',
        url: 'https://apache.example',
        distribution: '',
        comments: '',
      },
    ],
  });
});

test('missing, cyclic or property-based Maven parent evidence fails closed', async () => {
  const { resolveEffectiveMavenLicences } = await importEvidence();
  await assert.rejects(
    () =>
      resolveEffectiveMavenLicences(['org.child:child:1'], async () => ({
        text: '<project/>',
        sha256: 'a'.repeat(64),
        sourceUrl: 'https://repo.example/child.pom',
      })),
    ({ code }) => code === 'maven_licence_unknown',
  );
  await assert.rejects(
    () =>
      resolveEffectiveMavenLicences(['org.child:child:1'], async () => ({
        text: '<project><parent><groupId>${group}</groupId><artifactId>parent</artifactId><version>1</version></parent></project>',
        sha256: 'a'.repeat(64),
        sourceUrl: 'https://repo.example/child.pom',
      })),
    ({ code }) => code === 'maven_licence_unknown',
  );
});

test('licence signatures ignore distribution only and runtime scope promotion is explicit', async () => {
  const { classifyAndroidDistribution, mavenLicenceSignature } = await importEvidence();
  const licence = {
    name: 'Apache-2.0',
    url: 'https://www.apache.org/licenses/LICENSE-2.0.txt',
    distribution: 'repo',
    comments: '',
  };
  assert.equal(
    mavenLicenceSignature([licence]),
    mavenLicenceSignature([{ ...licence, distribution: '' }]),
  );
  assert.match(mavenLicenceSignature([licence]), /^sha256:[a-f0-9]{64}$/);

  const tooling = {
    scopes: [{ project: ':', configuration: 'classpath', buildscript: true }],
  };
  assert.equal(classifyAndroidDistribution(tooling), 'tooling-or-test-only');
  assert.equal(
    classifyAndroidDistribution({
      scopes: [
        ...tooling.scopes,
        { project: ':app', configuration: 'debugRuntimeClasspath', buildscript: false },
        { project: ':app', configuration: 'releaseRuntimeClasspath', buildscript: false },
      ],
    }),
    'packaged-runtime',
  );
  assert.throws(
    () =>
      classifyAndroidDistribution({
        scopes: [
          { project: ':app', configuration: 'futureMagicScope', buildscript: false },
        ],
      }),
    ({ code }) => code === 'maven_licence_unknown',
  );
  assert.throws(
    () =>
      classifyAndroidDistribution({
        scopes: [
          { project: ':app', configuration: 'releaseRuntimeClasspath', buildscript: false },
        ],
      }),
    ({ code }) => code === 'maven_licence_unknown',
  );
});
