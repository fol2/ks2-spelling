import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'maven-evidence-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeCachedPom(root, coordinate, hashDirectory, text) {
  const [group, name, version] = coordinate.split(':');
  const directory = join(
    root,
    'caches/modules-2/files-2.1',
    group,
    name,
    version,
    hashDirectory,
  );
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}-${version}.pom`), text);
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
  assert.deepEqual(
    applyMavenLicencePolicy({
      coordinate: 'org.example:runtime:1',
      distribution: 'packaged-runtime',
      signatures: [signature],
      effective: evidence,
      policy: {
        ...policy,
        scopeRestrictedComponents: {},
        packagedRuntimeComponents: {
          'org.example:runtime:1': 'LicenseRef-Custom',
        },
      },
    }),
    { expression: 'LicenseRef-Custom', scopePolicy: 'any' },
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

test('verified Maven POM resolution treats cache as an optimisation beneath exact SHA authority', async () => {
  const { resolveVerifiedMavenPom } = await importEvidence();
  const coordinate = 'androidx.annotation:annotation-experimental:1.4.0';
  const pom = Buffer.from(
    '<project><licenses><license><name>Apache-2.0</name><url>https://apache.org/licenses/LICENSE-2.0</url></license></licenses></project>',
  );
  const calls = [];

  await withTemporaryDirectory(async (gradleUserHome) => {
    const resolved = await resolveVerifiedMavenPom({
      gradleUserHome,
      coordinate,
      expectedSha256: digest(pom),
      repositoryBases: ['https://dl.google.com/dl/android/maven2/'],
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return new Response(pom, {
          status: 200,
          headers: { 'content-length': String(pom.length) },
        });
      },
    });

    assert.equal(resolved.sha256, digest(pom));
    assert.equal(resolved.text, pom.toString('utf8'));
    assert.equal(resolved.repository, 'https://dl.google.com/dl/android/maven2/');
    assert.equal(
      resolved.sourceUrl,
      'https://dl.google.com/dl/android/maven2/androidx/annotation/annotation-experimental/1.4.0/annotation-experimental-1.4.0.pom',
    );
    await writeCachedPom(gradleUserHome, coordinate, 'warm', pom);
    const warmCacheResolved = await resolveVerifiedMavenPom({
      gradleUserHome,
      coordinate,
      expectedSha256: digest(pom),
      repositoryBases: ['https://dl.google.com/dl/android/maven2/'],
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return new Response(pom);
      },
    });
    assert.deepEqual(
      {
        text: warmCacheResolved.text,
        sha256: warmCacheResolved.sha256,
        repository: warmCacheResolved.repository,
        sourceUrl: warmCacheResolved.sourceUrl,
      },
      {
        text: resolved.text,
        sha256: resolved.sha256,
        repository: resolved.repository,
        sourceUrl: resolved.sourceUrl,
      },
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.redirect, 'manual');
  });
});

test('verified Maven POM resolution rejects missing authority, redirects, timeouts and oversized or wrong bytes', async () => {
  const { resolveVerifiedMavenPom } = await importEvidence();
  const coordinate = 'org.example:library:1.0.0';
  const exact = Buffer.from('<project/>');
  const repositoryBases = ['https://repo.maven.apache.org/maven2/'];

  await withTemporaryDirectory(async (gradleUserHome) => {
    let calls = 0;
    await assert.rejects(
      () => resolveVerifiedMavenPom({
        gradleUserHome,
        coordinate,
        expectedSha256: null,
        repositoryBases,
        fetchImpl: async () => {
          calls += 1;
          return new Response(exact);
        },
      }),
      ({ code }) => code === 'maven_pom_authority_invalid',
    );
    assert.equal(calls, 0);

    for (const response of [
      new Response(null, {
        status: 302,
        headers: { location: 'https://unapproved.example/library.pom' },
      }),
      new Response('x', { headers: { 'content-length': '1048577' } }),
      new Response('wrong'),
    ]) {
      await assert.rejects(
        () => resolveVerifiedMavenPom({
          gradleUserHome,
          coordinate,
          expectedSha256: digest(exact),
          repositoryBases,
          maximumBytes: 1024 * 1024,
          fetchImpl: async () => response,
        }),
        ({ code }) => code === 'maven_source_unresolved',
      );
    }

    await assert.rejects(
      () => resolveVerifiedMavenPom({
        gradleUserHome,
        coordinate,
        expectedSha256: digest(exact),
        repositoryBases,
        timeoutMilliseconds: 5,
        fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      }),
      ({ code }) => code === 'maven_source_unresolved',
    );

    await assert.rejects(
      () => resolveVerifiedMavenPom({
        gradleUserHome,
        coordinate: 'org.example:../unsafe:1.0.0',
        expectedSha256: digest(exact),
        repositoryBases,
        fetchImpl: async () => {
          throw new Error('must not fetch');
        },
      }),
      ({ code }) => code === 'maven_licence_unknown',
    );
  });
});

test('verified Maven POM resolution never repairs unsafe or conflicting cache entries from the network', async () => {
  const { resolveVerifiedMavenPom } = await importEvidence();
  const coordinate = 'org.example:library:1.0.0';
  const exact = Buffer.from('<project/>');

  for (const prepare of [
    async (root) => {
      await writeCachedPom(root, coordinate, 'wrong', '<project id="wrong"/>');
    },
    async (root) => {
      await writeCachedPom(root, coordinate, 'first', '<project id="first"/>');
      await writeCachedPom(root, coordinate, 'second', '<project id="second"/>');
    },
    async (root) => {
      const [group, name, version] = coordinate.split(':');
      const coordinateRoot = join(
        root,
        'caches/modules-2/files-2.1',
        group,
        name,
        version,
      );
      await mkdir(coordinateRoot, { recursive: true });
      await symlink(tmpdir(), join(coordinateRoot, 'unsafe'));
    },
  ]) {
    await withTemporaryDirectory(async (gradleUserHome) => {
      await prepare(gradleUserHome);
      let calls = 0;
      await assert.rejects(
        () => resolveVerifiedMavenPom({
          gradleUserHome,
          coordinate,
          expectedSha256: digest(exact),
          repositoryBases: ['https://repo.maven.apache.org/maven2/'],
          fetchImpl: async () => {
            calls += 1;
            return new Response(exact);
          },
        }),
        ({ code }) =>
          code === 'maven_licence_unknown' || code === 'maven_pom_checksum_mismatch',
      );
      assert.equal(calls, 0);
    });
  }
});

test('verified Maven POM resolution deterministically falls through approved repositories', async () => {
  const { resolveVerifiedMavenPom } = await importEvidence();
  const coordinate = 'org.example:library:1.0.0';
  const exact = Buffer.from('<project/>');

  await withTemporaryDirectory(async (gradleUserHome) => {
    const calls = [];
    const resolved = await resolveVerifiedMavenPom({
      gradleUserHome,
      coordinate,
      expectedSha256: digest(exact),
      repositoryBases: [
        'https://first.example/maven/',
        'https://second.example/maven/',
        'https://third.example/maven/',
      ],
      fetchImpl: async (url) => {
        calls.push(url);
        if (url.startsWith('https://first.example/')) return new Response(null, { status: 404 });
        if (url.startsWith('https://second.example/')) return new Response('wrong');
        return new Response(exact);
      },
    });

    assert.deepEqual(
      calls.map((url) => new URL(url).origin),
      ['https://first.example', 'https://second.example', 'https://third.example'],
    );
    assert.equal(resolved.repository, 'https://third.example/maven/');
  });
});

test('verified Maven POM resolution fetches missing recursive parents for licence inheritance', async () => {
  const { resolveEffectiveMavenLicences, resolveVerifiedMavenPom } = await importEvidence();
  const childCoordinate = 'org.example:child:1.0.0';
  const parentCoordinate = 'org.example:parent:2.0.0';
  const child = Buffer.from(
    '<project><parent><groupId>org.example</groupId><artifactId>parent</artifactId><version>2.0.0</version></parent></project>',
  );
  const parent = Buffer.from(
    '<project><licenses><license><name>Apache-2.0</name><url>https://apache.org/licenses/LICENSE-2.0</url></license></licenses></project>',
  );
  const authorities = new Map([
    [childCoordinate, digest(child)],
    [parentCoordinate, digest(parent)],
  ]);

  await withTemporaryDirectory(async (gradleUserHome) => {
    await writeCachedPom(gradleUserHome, childCoordinate, 'child', child);
    const evidence = await resolveEffectiveMavenLicences(
      [childCoordinate],
      async (coordinate) => resolveVerifiedMavenPom({
        gradleUserHome,
        coordinate,
        expectedSha256: authorities.get(coordinate),
        repositoryBases: ['https://repo.example/maven/'],
        fetchImpl: async (url) => {
          if (url.endsWith('child/1.0.0/child-1.0.0.pom')) {
            return new Response(child);
          }
          assert.match(url, /parent\/2\.0\.0\/parent-2\.0\.0\.pom$/);
          return new Response(parent);
        },
      }),
    );

    assert.equal(evidence[0].declaredBy, parentCoordinate);
    assert.equal(evidence[0].inherited, true);
    assert.equal(evidence[0].licences[0].name, 'Apache-2.0');
  });
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
        { project: ':app', configuration: 'debugRuntimeClasspath', buildscript: false },
      ],
    }),
    'packaged-runtime',
  );
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
  assert.equal(
    classifyAndroidDistribution({
      scopes: [
        { project: ':app', configuration: 'releaseRuntimeClasspath', buildscript: false },
      ],
    }),
    'packaged-runtime',
  );
});
