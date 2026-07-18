import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ANNOTATION_EXPERIMENTAL_COORDINATE =
  'androidx.annotation:annotation-experimental:1.4.0';
const ANNOTATION_EXPERIMENTAL_POM = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <!-- This module was also published with a richer model, Gradle metadata,  -->
  <!-- which should be used instead. Do not delete the following line which  -->
  <!-- is to indicate to Gradle or any Gradle module metadata file consumer  -->
  <!-- that they should prefer consuming it instead. -->
  <!-- do_not_remove: published-with-gradle-metadata -->
  <modelVersion>4.0.0</modelVersion>
  <groupId>androidx.annotation</groupId>
  <artifactId>annotation-experimental</artifactId>
  <version>1.4.0</version>
  <packaging>aar</packaging>
  <name>Experimental annotation</name>
  <description>Java annotation for use on unstable Android API surfaces. When used in conjunction with the Experimental annotation lint checks, this annotation provides functional parity with Kotlin's Experimental annotation.</description>
  <url>https://developer.android.com/jetpack/androidx/releases/annotation#1.4.0</url>
  <inceptionYear>2019</inceptionYear>
  <organization>
    <name>The Android Open Source Project</name>
  </organization>
  <licenses>
    <license>
      <name>The Apache Software License, Version 2.0</name>
      <url>http://www.apache.org/licenses/LICENSE-2.0.txt</url>
      <distribution>repo</distribution>
    </license>
  </licenses>
  <developers>
    <developer>
      <name>The Android Open Source Project</name>
    </developer>
  </developers>
  <scm>
    <connection>scm:git:https://android.googlesource.com/platform/frameworks/support</connection>
    <url>https://cs.android.com/androidx/platform/frameworks/support</url>
  </scm>
  <dependencies>
    <dependency>
      <groupId>org.jetbrains.kotlin</groupId>
      <artifactId>kotlin-stdlib</artifactId>
      <version>1.7.10</version>
      <scope>compile</scope>
    </dependency>
  </dependencies>
</project>`);

async function importScript(path) {
  return import(pathToFileURL(join(ROOT, path)));
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(join(ROOT, path))).digest('hex');
}

async function runAuditCli(args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/audit-dependencies.mjs', ...args], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

test('default audit consumes the complete resolved Android certification', async () => {
  const { buildDependencyArtifacts } = await importScript('scripts/audit-dependencies.mjs');
  const { report } = await buildDependencyArtifacts({ preBootstrap: false });
  assert.equal(report.mode, 'resolved-toolchain');
  assert.deepEqual(report.permissionEvidence.packagedAndroid, {
    appIdentity: 'uk.eugnel.ks2spelling',
    buildToolsVersion: '36.0.0',
    permissionSurfaceSha256:
      report.permissionEvidence.packagedAndroid.permissionSurfaceSha256,
    declaredPermissions: [],
    requestedPermissions: [
      'android.permission.INTERNET',
      'com.android.vending.BILLING',
      'android.permission.ACCESS_NETWORK_STATE',
    ],
  });
  assert.match(
    report.permissionEvidence.packagedAndroid.permissionSurfaceSha256,
    /^[a-f0-9]{64}$/,
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
      componentCount: 327,
      scopeMembershipCount: 5570,
      packagedRuntimeCount: 74,
      scopeRestrictedToolingCount: 25,
      taskCreatedBuildToolCount: 13,
    },
  );
  assert.equal(report.androidResolution.verificationComponentCount, 442);
  assert.equal(report.androidResolution.verificationArtifactCount, 878);
  const complianceRegister = await readFile(
    join(ROOT, 'docs/compliance/sdk-privacy-register.md'),
    'utf8',
  );
  assert.match(
    complianceRegister,
    new RegExp(
      `finite Gradle verification inventory contains ${report.androidResolution.verificationComponentCount} components and ${report.androidResolution.verificationArtifactCount} artefacts\\.`,
    ),
  );
  assert.equal(
    report.gradleDeclared.filter(({ resolution }) => resolution === 'resolved-toolchain').length,
    17,
  );
  assert.equal(
    report.gradleDeclared.filter(({ resolution }) => resolution === 'inactive-condition').length,
    1,
  );
  await assert.doesNotReject(() => buildDependencyArtifacts({ preBootstrap: true }));
});

test('committed Android certification is identical from warm and empty POM caches', async (t) => {
  const cleanGradleUserHome = await mkdtemp(join(tmpdir(), 'b3-committed-pom-cache-'));
  t.after(() => rm(cleanGradleUserHome, { recursive: true, force: true }));
  const [{ buildAndroidCertification }, { readCachedMavenPom }] = await Promise.all([
    importScript('scripts/certify-android-dependencies.mjs'),
    importScript('scripts/lib/maven-evidence.mjs'),
  ]);
  const committed = JSON.parse(
    await readFile(join(ROOT, 'reports/b3/dependency-audit.json'), 'utf8'),
  ).android;
  assert.equal(
    createHash('sha256').update(ANNOTATION_EXPERIMENTAL_POM).digest('hex'),
    committed.pomClosure.find(
      ({ coordinate }) => coordinate === ANNOTATION_EXPERIMENTAL_COORDINATE,
    ).sha256,
  );
  const warmGradleUserHome = join(ROOT, '.native-build/android/gradle-user-home');
  const committedAnnotationSource = committed.pomClosure.find(
    ({ coordinate }) => coordinate === ANNOTATION_EXPERIMENTAL_COORDINATE,
  ).sourceUrl;
  const warm = await buildAndroidCertification({
    discoverSources: false,
    committed,
    evidenceMode: 'b3',
    gradleUserHome: warmGradleUserHome,
    fetchImpl: async (url) => {
      assert.equal(url, committedAnnotationSource);
      return new Response(ANNOTATION_EXPERIMENTAL_POM);
    },
  });
  const authorityByUrl = new Map(
    committed.pomClosure.map((entry) => [entry.sourceUrl, entry]),
  );
  const clean = await buildAndroidCertification({
    discoverSources: false,
    committed,
    evidenceMode: 'b3',
    gradleUserHome: cleanGradleUserHome,
    fetchImpl: async (url) => {
      const authority = authorityByUrl.get(url);
      assert.ok(authority, `unexpected committed Maven URL: ${url}`);
      if (authority.coordinate === ANNOTATION_EXPERIMENTAL_COORDINATE) {
        return new Response(ANNOTATION_EXPERIMENTAL_POM);
      }
      const cached = await readCachedMavenPom(warmGradleUserHome, authority.coordinate);
      assert.equal(cached.sha256, authority.sha256);
      return new Response(cached.text);
    },
  });
  assert.deepEqual(clean, warm);
});

test('generated JSON and notices are byte-identical across repeated generation', async () => {
  const { assertDependencyEvidenceCurrent, buildDependencyArtifacts } = await importScript(
    'scripts/audit-dependencies.mjs',
  );
  const first = await buildDependencyArtifacts({ preBootstrap: false });
  const second = await buildDependencyArtifacts({ preBootstrap: false });
  assert.equal(first.reportJson, second.reportJson);
  assert.equal(first.pluginAuditJson, second.pluginAuditJson);
  assert.equal(first.noticesMarkdown, second.noticesMarkdown);
  assert.notEqual(
    await readFile(join(ROOT, 'reports/b2/dependency-audit.json'), 'utf8'),
    first.reportJson,
    'B3 live policy must not overwrite frozen B2 evidence',
  );
  assert.doesNotThrow(() =>
    assertDependencyEvidenceCurrent(first, {
      reportJson: first.reportJson,
      pluginAuditJson: first.pluginAuditJson,
      noticesMarkdown: first.noticesMarkdown,
    }),
  );
  assert.throws(
    () =>
      assertDependencyEvidenceCurrent(first, {
        reportJson: '{}\n',
        pluginAuditJson: first.pluginAuditJson,
        noticesMarkdown: first.noticesMarkdown,
      }),
    ({ code }) => code === 'dependency_evidence_stale',
  );
});

test('default audit CLI validates live B3 evidence without mutating frozen B2 reports', async () => {
  const frozenPaths = [
    'reports/b2/dependency-audit.json',
    'reports/b2/native-plugin-audit.json',
    'THIRD_PARTY_NOTICES.md',
  ];
  const before = await Promise.all(frozenPaths.map(sha256));
  const result = await runAuditCli();
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.evidence, 'live-locked-policy');
  assert.deepEqual(await Promise.all(frozenPaths.map(sha256)), before);
});

test('pre-bootstrap write CLI cannot overwrite frozen B2 evidence while B3 is active', async () => {
  const frozenPaths = [
    'reports/b2/dependency-audit.json',
    'reports/b2/native-plugin-audit.json',
    'THIRD_PARTY_NOTICES.md',
  ];
  const before = await Promise.all(frozenPaths.map(sha256));
  const result = await runAuditCli(['--pre-bootstrap', '--write']);
  assert.equal(result.exitCode, 4, result.stdout || result.stderr);
  assert.equal(result.stdout, '');
  const output = JSON.parse(result.stderr);
  assert.equal(output.ok, false);
  assert.equal(output.code, 'b3_frozen_evidence_write_forbidden');
  assert.deepEqual(await Promise.all(frozenPaths.map(sha256)), before);
});
