import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

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
      componentCount: 326,
      scopeMembershipCount: 5568,
      packagedRuntimeCount: 74,
      scopeRestrictedToolingCount: 25,
      taskCreatedBuildToolCount: 13,
    },
  );
  assert.equal(report.androidResolution.verificationComponentCount, 441);
  assert.equal(report.androidResolution.verificationArtifactCount, 875);
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
    16,
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
