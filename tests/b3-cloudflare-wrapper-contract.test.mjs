import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  B3_SCRIPT_AUTHORITY_PLACEHOLDER,
  buildB3CloudflareDeploymentPlan,
  bindB3ScriptAuthority,
  orchestrateB3CloudflareDeployment,
  verifyB3CloudflareDeploymentEvidence,
} from '../scripts/lib/b3-cloudflare-evidence.mjs';
import { validateB3CloudflareEvidence } from '../scripts/lib/b3-evidence.mjs';
import { deployB3SandboxGateway } from '../scripts/deploy-b3-sandbox-gateway.mjs';

test('Cloudflare deploy plan is closed, approval-scoped and rejects frozen object-key drift', () => {
  const authority = {
    cloudflareAccountId: '6d00cb4a0396c17ad6ba617bcbcaa45d',
    workerName: 'ks2-spelling-b3-sandbox',
    privateR2BucketName: 'ks2-spelling-b3-sandbox-packs',
    publicSandboxOrigin: 'https://b3-gateway.eugnel.uk',
  };
  const objects = [
    { role: 'signed-manifest', key: 'packs/b3-sandbox-proof/1.0.0-b3.1/signed-manifest.json' },
    { role: 'archive', key: 'packs/b3-sandbox-proof/1.0.0-b3.1/b3-sandbox-proof.zip' },
  ];
  assert.equal(buildB3CloudflareDeploymentPlan({ authority, objects, approvedScope: 'cloudflare-deploy', runToken: 'a'.repeat(64) }).commands.length, 5);
  assert.equal(buildB3CloudflareDeploymentPlan({ authority, objects: [...objects].reverse(), approvedScope: 'cloudflare-deploy', runToken: 'a'.repeat(64) }).commands[3].role, 'signed-manifest');
  assert.throws(() => buildB3CloudflareDeploymentPlan({ authority, objects: [objects[0], objects[0]], approvedScope: 'cloudflare-deploy', runToken: 'a'.repeat(64) }), /object authority/i);
  assert.throws(() => buildB3CloudflareDeploymentPlan({ authority, objects, approvedScope: 'apple-signed-distribution', runToken: 'a'.repeat(64) }), /scope/i);
});

test('Cloudflare deployment performs no primitive mutation before the exact scope gate', async () => {
  let calls = 0;
  const primitives = new Proxy({}, { get: () => async () => { calls += 1; } });
  await assert.rejects(
    deployB3SandboxGateway({
      env: { B3_REMOTE_MUTATION_SCOPE: 'apple-signed-distribution', B3_REMOTE_RUN_TOKEN: 'a'.repeat(64) },
      primitives,
    }),
    /scope/i,
  );
  assert.equal(calls, 0);
});

test('Cloudflare deployment performs no inspection or mutation before strict local authority validation', async () => {
  let calls = 0;
  const primitives = new Proxy({}, { get: () => async () => { calls += 1; } });
  await assert.rejects(
    deployB3SandboxGateway({
      env: { B3_REMOTE_MUTATION_SCOPE: 'cloudflare-deploy', B3_REMOTE_RUN_TOKEN: 'a'.repeat(64) },
      primitives,
      remoteInspector: async () => { calls += 1; },
      localMutationGate: async () => { throw new Error('strict local mutation gate rejected duplicate-key authority'); },
    }),
    /strict local mutation gate rejected/i,
  );
  assert.equal(calls, 0);
});

test('Task22 Cloudflare adapter fails closed when OAuth cannot prove exact R2 metadata', async () => {
  const adapter = await import('../scripts/lib/b3-cloudflare-live-adapter.mjs').catch(() => ({}));
  assert.equal(typeof adapter.createDefaultB3CloudflarePrimitives, 'function');
  await assert.rejects(
    adapter.createDefaultB3CloudflarePrimitives().inspectObject(),
    /cannot securely read object bytes, ETag and exact custom metadata/i,
  );
});

test('bundled Worker authority replaces only the fixed equal-length placeholder', () => {
  const source = `const BUILD = '${B3_SCRIPT_AUTHORITY_PLACEHOLDER}';\r\nexport default BUILD;\r\n`;
  const bound = bindB3ScriptAuthority(source);
  assert.match(bound.source, /const BUILD = '[0-9a-f]{64}'/);
  assert.equal(bound.source.includes('\r'), false);
  assert.equal(bound.source.includes(B3_SCRIPT_AUTHORITY_PLACEHOLDER), false);
  assert.throws(() => bindB3ScriptAuthority('no placeholder'), /placeholder/i);
  assert.throws(() => bindB3ScriptAuthority(source + source), /placeholder/i);
});

function cloudflareHarness({ badIdentity = false } = {}) {
  const bytes = { 'signed-manifest': Buffer.from('signed-manifest'), archive: Buffer.from('archive') };
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  const object = (role, key) => ({
    role, key, bytes: bytes[role].length, sha256: sha(bytes[role]), etag: `${role}-etag`,
    metadata: {
      'b3-role': role, 'b3-sha256': sha(bytes[role]), 'b3-size': String(bytes[role].length),
      ...(role === 'signed-manifest' ? { 'b3-envelope-sha256': sha(bytes[role]) } : {}),
    },
  });
  const tracked = {
    gateway: {
      cloudflareAccountId: '6d00cb4a0396c17ad6ba617bcbcaa45d', workerName: 'ks2-spelling-b3-sandbox',
      privateR2BucketName: 'ks2-spelling-b3-sandbox-packs', publicSandboxOrigin: 'https://b3-gateway.eugnel.uk',
    },
    objects: [
      object('archive', 'packs/b3-sandbox-proof/1.0.0-b3.1/b3-sandbox-proof.zip'),
      object('signed-manifest', 'packs/b3-sandbox-proof/1.0.0-b3.1/signed-manifest.json'),
    ],
  };
  let deployed;
  let uploadCalls = 0;
  const remoteByRole = Object.fromEntries(tracked.objects.map((entry) => [entry.role, {
    key: entry.key, sha256: entry.sha256, size: entry.bytes, etag: entry.etag,
    customMetadata: entry.metadata,
  }]));
  const behaviour = {
    capability: { ttlSeconds: 600, valid: true, tamperedRejected: true, expiredRejected: true, canonicalEncodingRequired: true },
    range: { full200: true, partial206: true, conditional304: true, unsatisfied416: true, noRedirects: true, cacheControl: 'private, no-store' },
    rateLimit: { everyPublicPostGetCovered: true, limitedStatus: 429, limitedBodyReads: 0, limitedUpstreamCalls: 0, missingBindingFailedClosed: true },
  };
  const primitives = {
    dryRunBundle: async () => ({ source: `const BUILD = '${B3_SCRIPT_AUTHORITY_PLACEHOLDER}';\n`, normalised: true }),
    deployExactBundle: async (value) => {
      deployed = value;
      return { deploymentVersionId: 'version-1', deployedSourceSha256: value.deployedSourceSha256 };
    },
    inspectVersionApi: async () => ({ deploymentVersionId: 'version-1', deployedSourceSha256: deployed.deployedSourceSha256 }),
    inspectWorkerState: async () => ({
      accountId: tracked.gateway.cloudflareAccountId, workerName: tracked.gateway.workerName,
      publicSandboxOrigin: tracked.gateway.publicSandboxOrigin, bucketName: tracked.gateway.privateR2BucketName,
      compatibilityDate: '2026-07-12', compatibilityFlags: ['nodejs_compat'],
      bindings: { r2: 'PACKS', rateLimit: 'GATEWAY_RATE_LIMIT', versionMetadata: 'WORKER_VERSION_METADATA' },
      requiredSecretNames: ['APPLE_IAP_ISSUER_ID', 'APPLE_IAP_KEY_ID', 'APPLE_IAP_PRIVATE_KEY', 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON', 'ENTITLEMENT_HANDLE_KEY_CURRENT', 'ENTITLEMENT_HANDLE_KEY_PREVIOUS', 'R2_CAPABILITY_HMAC_KEY'],
      bucketPrivate: true, r2DevPublicAccess: false, customDomains: [],
    }),
    inspectObject: async ({ role }) => remoteByRole[role],
    uploadObject: async () => { uploadCalls += 1; },
    smokeGateway: async ({ deploymentVersionId, scriptAuthoritySha256 }) => ({
      identity: { workerVersionId: badIdentity ? 'wrong-version' : deploymentVersionId, workerScriptAuthoritySha256: scriptAuthoritySha256 },
      cors: { nativeOriginsAllowed: true, foreignOriginsRejected: true },
      ...behaviour,
    }),
  };
  return { tracked, bytes, primitives, uploadCalls: () => uploadCalls };
}

test('Cloudflare orchestration owns byte binding, API, object and live-smoke verification', async () => {
  const harness = cloudflareHarness();
  const applicationAuthority = { testedApplicationCommit: 'b'.repeat(40), applicationFingerprint: 'a'.repeat(64) };
  const evidence = validateB3CloudflareEvidence(await orchestrateB3CloudflareDeployment({
    applicationAuthority, tracked: harness.tracked, primitives: harness.primitives,
    readAuthorityObject: async (role) => harness.bytes[role],
  }));
  assert.equal(harness.uploadCalls(), 0);
  assert.equal(evidence.objects[0].role, 'signed-manifest');
  assert.equal(await verifyB3CloudflareDeploymentEvidence({ evidence, applicationAuthority, tracked: harness.tracked, primitives: harness.primitives }), true);
  await assert.rejects(verifyB3CloudflareDeploymentEvidence({
    evidence, applicationAuthority: { ...applicationAuthority, testedApplicationCommit: 'c'.repeat(40) },
    tracked: harness.tracked, primitives: harness.primitives,
  }), /stale/i);
  await assert.rejects(verifyB3CloudflareDeploymentEvidence({
    evidence, applicationAuthority, tracked: harness.tracked,
    primitives: { ...harness.primitives, inspectVersionApi: async () => ({ deploymentVersionId: 'wrong', deployedSourceSha256: 'c'.repeat(64) }) },
  }), /API version authority/i);
  await assert.rejects(verifyB3CloudflareDeploymentEvidence({
    evidence, applicationAuthority, tracked: harness.tracked,
    primitives: { ...harness.primitives, inspectObject: async () => null },
  }), /object differs/i);
  await assert.rejects(verifyB3CloudflareDeploymentEvidence({
    evidence, applicationAuthority, tracked: harness.tracked,
    primitives: { ...harness.primitives, smokeGateway: async () => ({ identity: { workerVersionId: 'wrong', workerScriptAuthoritySha256: evidence.worker.scriptAuthoritySha256 } }) },
  }), /gateway response/i);
});

test('Cloudflare orchestration rejects invented identities and malformed dry-run bytes', async () => {
  const applicationAuthority = { testedApplicationCommit: 'b'.repeat(40), applicationFingerprint: 'a'.repeat(64) };
  const badIdentity = cloudflareHarness({ badIdentity: true });
  await assert.rejects(orchestrateB3CloudflareDeployment({
    applicationAuthority, tracked: badIdentity.tracked, primitives: badIdentity.primitives,
    readAuthorityObject: async (role) => badIdentity.bytes[role],
  }), /gateway response|authority/i);
  const malformed = cloudflareHarness();
  malformed.primitives.dryRunBundle = async () => ({ source: 'no placeholder', normalised: true });
  await assert.rejects(orchestrateB3CloudflareDeployment({
    applicationAuthority, tracked: malformed.tracked, primitives: malformed.primitives,
    readAuthorityObject: async (role) => malformed.bytes[role],
  }), /placeholder/i);
  assert.equal(malformed.uploadCalls(), 0);
});
