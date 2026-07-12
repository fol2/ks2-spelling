import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function importScript(path) {
  return import(pathToFileURL(join(ROOT, path)));
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
    requestedPermissions: [],
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
      componentCount: 314,
      scopeMembershipCount: 5452,
      packagedRuntimeCount: 61,
      scopeRestrictedToolingCount: 25,
      taskCreatedBuildToolCount: 12,
    },
  );
  assert.equal(report.androidResolution.verificationComponentCount, 427);
  assert.equal(report.androidResolution.verificationArtifactCount, 847);
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
  assert.equal(first.pluginAuditJson, second.pluginAuditJson);
  assert.equal(first.noticesMarkdown, second.noticesMarkdown);
  assert.equal(
    await readFile(join(ROOT, 'reports/b2/dependency-audit.json'), 'utf8'),
    first.reportJson,
  );
  assert.equal(
    await readFile(join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8'),
    first.noticesMarkdown,
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
