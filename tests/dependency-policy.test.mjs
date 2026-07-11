import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REQUIRED_FILES = [
  'config/dependency-policy.json',
  'scripts/audit-dependencies.mjs',
  'scripts/generate-third-party-notices.mjs',
  'docs/compliance/sdk-privacy-register.md',
  'THIRD_PARTY_NOTICES.md',
  'reports/b1/dependency-audit.json',
];

async function importScript(path) {
  return import(pathToFileURL(join(ROOT, path)));
}

test('the dependency policy and deterministic evidence files are committed', async () => {
  assert.ok(
    REQUIRED_FILES.every((path) => existsSync(join(ROOT, path))),
    'missing dependency policy, compliance register or generated evidence',
  );
  const packageJson = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(
    packageJson.scripts['audit:dependencies'],
    'node scripts/audit-dependencies.mjs',
  );
  assert.equal(
    packageJson.scripts['generate:notices'],
    'node scripts/generate-third-party-notices.mjs',
  );
});

test('pre-bootstrap audit classifies resolved npm and SPM truth without resolving Android', async () => {
  const { buildDependencyArtifacts } = await importScript('scripts/audit-dependencies.mjs');
  const { report } = await buildDependencyArtifacts({ preBootstrap: true });

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.mode, 'pre-bootstrap');
  assert.equal(report.androidResolution, 'pending-toolchain');
  assert.equal(report.npm.production.length, 7);
  assert.equal(report.npm.directBuildTools.length, 4);
  assert.ok(report.npm.lockPackageCount >= 150);
  for (const dependency of [
    ...report.npm.production,
    ...report.npm.directBuildTools,
    ...report.spm,
  ]) {
    for (const field of [
      'name',
      'version',
      'source',
      'licence',
      'role',
      'platform',
      'permissions',
      'dataAccess',
      'networkEndpoints',
      'applePrivacyManifest',
      'googleDataSafety',
      'owner',
      'reviewDate',
    ]) {
      assert.ok(Object.hasOwn(dependency, field), `${dependency.name} missing ${field}`);
    }
  }
  assert.deepEqual(report.plugins.approved, []);
  assert.deepEqual(report.permissionEvidence, {
    androidUsesPermissions: [],
    iosEntitlements: [],
    iosUsageDescriptionKeys: [],
  });
  assert.deepEqual(report.b1Truth, {
    childDataCollected: false,
    childDataTransmitted: false,
    analytics: false,
    advertising: false,
    appPermissions: [],
    storeCommerce: false,
    runtimeNetworkEndpoints: [],
    disclosureStatus: 'B1 evidence only; not a final store disclosure',
  });
  assert.equal(report.spm[0].name, 'capacitor-swift-pm');
  assert.equal(report.spm[0].version, '8.4.1');
  assert.equal(report.spm[0].revision, '2231987d85b8b0b289320b1d0947b4ae8345cde4');
  assert.equal(report.spm[0].privacyManifests.length, 2);
  assert.ok(report.gradleDeclared.length >= 15);
  assert.ok(report.gradleDeclared.every(({ resolution }) => resolution === 'pending-toolchain'));
});

test('default audit rejects unresolved Android while pre-bootstrap permits only its marker', async () => {
  const { buildDependencyArtifacts } = await importScript('scripts/audit-dependencies.mjs');
  await assert.rejects(
    () => buildDependencyArtifacts({ preBootstrap: false }),
    ({ code }) => code === 'android_resolution_pending',
  );
  await assert.doesNotReject(() => buildDependencyArtifacts({ preBootstrap: true }));
});

test('generated JSON and notices are byte-identical across repeated generation', async () => {
  const { assertDependencyEvidenceCurrent, buildDependencyArtifacts } = await importScript(
    'scripts/audit-dependencies.mjs',
  );
  const first = await buildDependencyArtifacts({ preBootstrap: true });
  const second = await buildDependencyArtifacts({ preBootstrap: true });
  assert.equal(first.reportJson, second.reportJson);
  assert.equal(first.noticesMarkdown, second.noticesMarkdown);
  assert.equal(
    await readFile(join(ROOT, 'reports/b1/dependency-audit.json'), 'utf8'),
    first.reportJson,
  );
  assert.equal(
    await readFile(join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8'),
    first.noticesMarkdown,
  );
  assert.doesNotThrow(() =>
    assertDependencyEvidenceCurrent(first, {
      reportJson: first.reportJson,
      noticesMarkdown: first.noticesMarkdown,
    }),
  );
  assert.throws(
    () =>
      assertDependencyEvidenceCurrent(first, {
        reportJson: '{}\n',
        noticesMarkdown: first.noticesMarkdown,
      }),
    ({ code }) => code === 'dependency_evidence_stale',
  );
});

test('future native candidates are explicit Not approved entries and remain uninstalled', async () => {
  const policy = JSON.parse(
    await readFile(join(ROOT, 'config/dependency-policy.json'), 'utf8'),
  );
  assert.deepEqual(
    policy.candidatePlugins.map(({ capability }) => capability),
    ['SQLite', 'Filesystem', 'Billing', 'Biometric', 'Lifecycle'],
  );
  assert.ok(policy.candidatePlugins.every(({ status }) => status === 'Not approved'));

  const packageJson = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const installed = new Set([
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {}),
  ]);
  for (const { packageName } of policy.candidatePlugins) {
    assert.equal(installed.has(packageName), false, `${packageName} must remain uninstalled`);
  }

  const register = await readFile(join(ROOT, 'docs/compliance/sdk-privacy-register.md'), 'utf8');
  assert.match(register, /## Not approved candidates/);
  for (const capability of ['SQLite', 'Filesystem', 'Billing', 'Biometric', 'Lifecycle']) {
    assert.match(register, new RegExp(`\\| ${capability} \\|[^\\n]+\\| Not approved \\|`));
  }
});

test('Gradle evidence rejects every unregistered coordinate, repository form and flat directory', async () => {
  const { assertGradleEvidenceMatchesPolicy, parseGradleEvidence } = await importScript(
    'scripts/audit-dependencies.mjs',
  );
  const policy = JSON.parse(
    await readFile(join(ROOT, 'config/dependency-policy.json'), 'utf8'),
  );
  const sources = await Promise.all(
    [
      'android/build.gradle',
      'android/app/build.gradle',
      'android/variables.gradle',
      'node_modules/@capacitor/android/capacitor/build.gradle',
    ].map(async (path) => ({ path, text: await readFile(join(ROOT, path), 'utf8') })),
  );
  assert.doesNotThrow(() =>
    assertGradleEvidenceMatchesPolicy(parseGradleEvidence(sources), policy),
  );

  const tamperCases = [
    ['extra coordinate', 'dependencies { implementation "evil.tracker:sdk:1.0.0" }'],
    ['runtime-only coordinate', 'dependencies { runtimeOnly "evil.runtime:sdk:3.0.0" }'],
    [
      'inline conditional coordinate',
      'dependencies { if (true) implementation "evil.inline:sdk:4.0.0" }',
    ],
    [
      'dynamic add coordinate',
      'dependencies { add("implementation", "evil.add:sdk:5.0.0") }',
    ],
    [
      'dynamic add version alias',
      'dependencies { add("implementation", libs.versions.evil) }',
    ],
    [
      'platform coordinate',
      'dependencies { implementation(platform("evil.platform:bom:2.0.0")) }',
    ],
    ['unresolved dependency syntax', 'dependencies { implementation libs.evilSdk }'],
    ['parenthesised version alias', 'dependencies { runtimeOnly(libs.evilSdk) }'],
    ['unexpected local project', "dependencies { runtimeOnly project(':evil-local') }"],
    ['jcenter', 'repositories { jcenter() }'],
    ['maven local', 'repositories { mavenLocal() }'],
    ['single quoted Maven URL', "repositories { maven { url = 'https://evil.example/m2' } }"],
    [
      'uri Maven URL',
      "repositories { maven { url = uri('https://evil.example/uri-m2') } }",
    ],
    ['unexpected flat directory', "repositories { flatDir { dirs 'unregistered-libs' } }"],
    [
      'parenthesised unexpected flat directory',
      'repositories { flatDir { dirs("unregistered-parenthesised-libs") } }',
    ],
  ];
  for (const [name, text] of tamperCases) {
    assert.throws(
      () =>
        assertGradleEvidenceMatchesPolicy(
          parseGradleEvidence([...sources, { path: `tamper/${name}.gradle`, text }]),
          policy,
        ),
      ({ code }) =>
        ['gradle_declaration_drift', 'unapproved_gradle_source', 'unapproved_flat_dir'].includes(
          code,
        ),
      name,
    );
  }

  const commentedCoordinateSources = sources.map((source) =>
    source.path === 'android/build.gradle'
      ? {
          ...source,
          text: source.text.replace(
            "classpath 'com.google.gms:google-services:4.4.4'",
            "// classpath 'com.google.gms:google-services:4.4.4'",
          ),
        }
      : source,
  );
  assert.throws(
    () =>
      assertGradleEvidenceMatchesPolicy(
        parseGradleEvidence(commentedCoordinateSources),
        policy,
      ),
    ({ code }) => code === 'gradle_declaration_drift',
    'commented-out coordinates cannot satisfy the exact set',
  );
});
