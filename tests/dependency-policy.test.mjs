import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
  'reports/b1/android-packaged-permissions.json',
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
    androidPermissionRemovalMarkers: ['permission', 'uses-permission'],
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

test('default audit consumes the complete resolved Android certification', async () => {
  const {
    assertPackagedPermissionEvidenceCurrent,
    buildDependencyArtifacts,
  } = await importScript('scripts/audit-dependencies.mjs');
  const { report } = await buildDependencyArtifacts({ preBootstrap: false });
  assert.equal(report.mode, 'resolved-toolchain');
  assert.deepEqual(report.permissionEvidence.packagedAndroid, {
    schemaVersion: 1,
    apkPath: '.native-build/android/build/app/outputs/apk/debug/app-debug.apk',
    appIdentity: 'uk.eugnel.ks2spelling',
    buildToolsVersion: '36.0.0',
    permissionSurfaceSha256:
      report.permissionEvidence.packagedAndroid.permissionSurfaceSha256,
    sourceBuildInputSha256:
      report.permissionEvidence.packagedAndroid.sourceBuildInputSha256,
    declaredPermissions: [],
    requestedPermissions: [],
  });
  assert.match(
    report.permissionEvidence.packagedAndroid.permissionSurfaceSha256,
    /^[a-f0-9]{64}$/,
  );
  assert.match(
    report.permissionEvidence.packagedAndroid.sourceBuildInputSha256,
    /^[a-f0-9]{64}$/,
  );
  assert.doesNotThrow(() =>
    assertPackagedPermissionEvidenceCurrent(
      report.permissionEvidence.packagedAndroid,
      report.permissionEvidence.packagedAndroid,
    ),
  );
  const machineSpecificApkDiagnostics = ['0'.repeat(64), '1'.repeat(64)];
  assert.notEqual(...machineSpecificApkDiagnostics);
  assert.equal(Object.hasOwn(report.permissionEvidence.packagedAndroid, 'apkSha256'), false);
  assert.doesNotThrow(() =>
    assertPackagedPermissionEvidenceCurrent(
      report.permissionEvidence.packagedAndroid,
      report.permissionEvidence.packagedAndroid,
    ),
  );
  assert.throws(
    () =>
      assertPackagedPermissionEvidenceCurrent(
        {
          ...report.permissionEvidence.packagedAndroid,
          appIdentity: 'uk.eugnel.wrong',
        },
        report.permissionEvidence.packagedAndroid,
      ),
    ({ code }) => code === 'android_packaged_permission_evidence_invalid',
  );
  assert.throws(
    () =>
      assertPackagedPermissionEvidenceCurrent(
        {
          ...report.permissionEvidence.packagedAndroid,
          requestedPermissions: ['android.permission.INTERNET'],
        },
        report.permissionEvidence.packagedAndroid,
      ),
    ({ code }) => code === 'android_packaged_permission_evidence_invalid',
  );
  assert.deepEqual(
    {
      status: report.androidResolution.status,
      componentCount: report.androidResolution.componentCount,
      scopeMembershipCount: report.androidResolution.scopeMembershipCount,
      packagedRuntimeCount: report.androidResolution.packagedRuntimeCount,
      scopeRestrictedToolingCount: report.androidResolution.scopeRestrictedToolingCount,
      taskCreatedBuildToolCount: report.androidResolution.taskCreatedBuildToolCount,
    },
    {
      status: 'resolved-toolchain',
      componentCount: 286,
      scopeMembershipCount: 3133,
      packagedRuntimeCount: 50,
      scopeRestrictedToolingCount: 25,
      taskCreatedBuildToolCount: 12,
    },
  );
  assert.equal(report.androidResolution.verificationComponentCount, 392);
  assert.equal(report.androidResolution.verificationArtifactCount, 769);
  const complianceRegister = await readFile(
    join(ROOT, 'docs/compliance/sdk-privacy-register.md'),
    'utf8',
  );
  assert.match(
    complianceRegister,
    new RegExp(
      `finite Gradle verification inventory of ${report.androidResolution.verificationComponentCount} components and ${report.androidResolution.verificationArtifactCount} artefacts\\.`,
    ),
  );
  assert.equal(
    report.gradleDeclared.filter(({ resolution }) => resolution === 'resolved-toolchain').length,
    15,
  );
  assert.equal(
    report.gradleDeclared.filter(({ resolution }) => resolution === 'inactive-condition').length,
    1,
  );
  await assert.doesNotReject(() => buildDependencyArtifacts({ preBootstrap: true }));
});

test('generated JSON and notices are byte-identical across repeated generation', async () => {
  const { assertDependencyEvidenceCurrent, buildDependencyArtifacts } = await importScript(
    'scripts/audit-dependencies.mjs',
  );
  const first = await buildDependencyArtifacts({ preBootstrap: false });
  const second = await buildDependencyArtifacts({ preBootstrap: false });
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
  const { assertGradleEvidenceMatchesPolicy, discoverGradleInputs, parseGradleEvidence } =
    await importScript('scripts/audit-dependencies.mjs');
  const policy = JSON.parse(
    await readFile(join(ROOT, 'config/dependency-policy.json'), 'utf8'),
  );
  const sources = (await discoverGradleInputs()).parserSources;
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
      'inline conditional map coordinate',
      "dependencies { if (true) runtimeOnly group: 'evil.inline', name: 'map-sdk', version: '4.1.0' }",
    ],
    [
      'inline conditional local project',
      "dependencies { if (true) implementation project(':evil-inline-project') }",
    ],
    [
      'inline conditional file tree',
      "dependencies { if (true) implementation fileTree(dir: 'evil-inline-libs', include: ['*.jar']) }",
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
    [
      'dynamic Ivy URL',
      'repositories { ivy { url = providers.gradleProperty("evilRepo") } }',
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

test('Gradle input path and SHA-256 allow-list is an exact finite backstop', async () => {
  const {
    assertGradleInputInventoryMatchesPolicy,
    discoverGradleInputs,
    parseGradleEvidence,
  } = await importScript('scripts/audit-dependencies.mjs');
  const policy = JSON.parse(
    await readFile(join(ROOT, 'config/dependency-policy.json'), 'utf8'),
  );
  const discovered = await discoverGradleInputs();

  assert.doesNotThrow(() =>
    assertGradleInputInventoryMatchesPolicy(discovered.inventory, policy),
  );
  assert.deepEqual(
    policy.gradleInputFiles.map(({ path }) => path),
    [
      'android/app/build.gradle',
      'android/app/capacitor.build.gradle',
      'android/build.gradle',
      'android/capacitor.settings.gradle',
      'android/gradle.properties',
      'android/gradle/b1-dependency-resolution.init.gradle',
      'android/gradle/wrapper/gradle-wrapper.jar',
      'android/gradle/wrapper/gradle-wrapper.properties',
      'android/gradlew',
      'android/gradlew.bat',
      'android/settings.gradle',
      'android/variables.gradle',
      'node_modules/@capacitor/android/capacitor/build.gradle',
    ],
  );
  const parsed = parseGradleEvidence(discovered.parserSources);
  const discoveredByPath = new Map(discovered.inventory.map((entry) => [entry.path, entry.sha256]));
  for (const source of parsed.sourceFiles) {
    assert.equal(source.sha256, discoveredByPath.get(source.path), source.path);
  }

  const appBuildPath = 'android/app/build.gradle';
  const settingsPath = 'android/settings.gradle';
  const appBuild = discovered.parserSources.find(({ path }) => path === appBuildPath).text;
  const settings = discovered.parserSources.find(({ path }) => path === settingsPath).text;
  const tamperCases = [
    [
      'inline map',
      appBuildPath,
      `${appBuild}\ndependencies { if (true) runtimeOnly group: 'evil.inline', name: 'map-sdk', version: '4.1.0' }\n`,
    ],
    [
      'inline project',
      appBuildPath,
      `${appBuild}\ndependencies { if (true) implementation project(':evil-inline-project') }\n`,
    ],
    [
      'inline fileTree',
      appBuildPath,
      `${appBuild}\ndependencies { if (true) implementation fileTree(dir: 'evil-inline-libs', include: ['*.jar']) }\n`,
    ],
    [
      'dynamic Ivy provider',
      settingsPath,
      `${settings}\nrepositories { ivy { url = providers.gradleProperty("evilRepo") } }\n`,
    ],
  ];
  for (const [name, path, text] of tamperCases) {
    const tampered = discovered.inventory.map((entry) =>
      entry.path === path
        ? { ...entry, sha256: createHash('sha256').update(text).digest('hex') }
        : entry,
    );
    assert.throws(
      () => assertGradleInputInventoryMatchesPolicy(tampered, policy),
      ({ code }) => code === 'gradle_input_drift',
      name,
    );
  }

  for (const path of [
    'android/buildSrc/build.gradle',
    'android/gradle/libs.versions.toml',
  ]) {
    assert.throws(
      () =>
        assertGradleInputInventoryMatchesPolicy(
          [...discovered.inventory, { path, sha256: '0'.repeat(64) }],
          policy,
        ),
      ({ code }) => code === 'gradle_input_drift',
      path,
    );
  }
  assert.throws(
    () => assertGradleInputInventoryMatchesPolicy(discovered.inventory.slice(1), policy),
    ({ code }) => code === 'gradle_input_drift',
    'missing approved Gradle input',
  );

  const cleanRoot = await mkdtemp(join(tmpdir(), 'ks2-spelling-gradle-inputs-'));
  try {
    for (const { path } of policy.gradleInputFiles) {
      await mkdir(dirname(join(cleanRoot, path)), { recursive: true });
      await copyFile(join(ROOT, path), join(cleanRoot, path));
    }
    const cleanCheckoutInputs = await discoverGradleInputs(cleanRoot);
    assert.equal(
      cleanCheckoutInputs.inventory.some(({ path }) =>
        path.startsWith('android/capacitor-cordova-android-plugins/'),
      ),
      false,
    );
    assert.doesNotThrow(() =>
      assertGradleInputInventoryMatchesPolicy(cleanCheckoutInputs.inventory, policy),
    );

    const externalRoot = join(cleanRoot, 'external');
    await mkdir(externalRoot, { recursive: true });
    const externalBuildSrc = join(externalRoot, 'buildSrc');
    await mkdir(externalBuildSrc);
    await writeFile(join(externalBuildSrc, 'build.gradle'), 'repositories { jcenter() }\n');
    await symlink(externalBuildSrc, join(cleanRoot, 'android/buildSrc'), 'dir');
    await assert.rejects(
      () => discoverGradleInputs(cleanRoot),
      ({ code }) => code === 'unsafe_audited_path',
      'symlinked buildSrc directory',
    );
    await rm(join(cleanRoot, 'android/buildSrc'));

    const allowedBuildPath = join(cleanRoot, 'android/app/build.gradle');
    const externalAllowedBuild = join(externalRoot, 'app-build.gradle');
    await copyFile(allowedBuildPath, externalAllowedBuild);
    await rm(allowedBuildPath);
    await symlink(externalAllowedBuild, allowedBuildPath);
    await assert.rejects(
      () => discoverGradleInputs(cleanRoot),
      ({ code }) => code === 'unsafe_audited_path',
      'symlinked approved build.gradle',
    );
    await rm(allowedBuildPath);
    await copyFile(join(ROOT, 'android/app/build.gradle'), allowedBuildPath);

    const linkedRoot = join(cleanRoot, 'linked-root');
    await mkdir(linkedRoot);
    await symlink(join(cleanRoot, 'android'), join(linkedRoot, 'android'), 'dir');
    await assert.rejects(
      () => discoverGradleInputs(linkedRoot),
      ({ code }) => code === 'unsafe_audited_path',
      'symlinked audited Android root',
    );

    const capacitorBuildPath = join(
      cleanRoot,
      'node_modules/@capacitor/android/capacitor/build.gradle',
    );
    const externalCapacitorBuild = join(externalRoot, 'capacitor-build.gradle');
    await copyFile(capacitorBuildPath, externalCapacitorBuild);
    await rm(capacitorBuildPath);
    await symlink(externalCapacitorBuild, capacitorBuildPath);
    await assert.rejects(
      () => discoverGradleInputs(cleanRoot),
      ({ code }) => code === 'unsafe_audited_path',
      'symlinked explicit Capacitor build source',
    );
  } finally {
    await rm(cleanRoot, { recursive: true, force: true });
  }
});
