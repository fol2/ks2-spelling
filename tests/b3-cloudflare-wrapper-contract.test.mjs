import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  B3_SCRIPT_AUTHORITY_PLACEHOLDER,
  assembleB3CloudflareEvidence,
  buildB3CloudflareDeploymentPlan,
  bindB3ScriptAuthority,
  orchestrateB3CloudflareDeployment,
  validateB3CloudflareDeploymentDraft,
  verifyB3CloudflareDeploymentEvidence,
} from '../scripts/lib/b3-cloudflare-evidence.mjs';
import { validateB3CloudflareEvidence } from '../scripts/lib/b3-evidence.mjs';
import { deployB3SandboxGateway } from '../scripts/deploy-b3-sandbox-gateway.mjs';
import { proveB3Cloudflare } from '../scripts/prove-b3-cloudflare.mjs';

const WORKER_VERSION_ID = 'a8f32f60-16b9-4ca6-9b4a-f771dd5302f7';
const R2_ETAGS = Object.freeze({
  'signed-manifest': 'c76b2858b8345814279a1c92ae64e365',
  archive: '913d2b2485ca6cd31d467bd7228d7e75',
});

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
  const plan = buildB3CloudflareDeploymentPlan({ authority, objects, approvedScope: 'cloudflare-deploy', runToken: 'a'.repeat(64) });
  assert.equal(plan.commands.length, 5);
  assert.deepEqual(plan.commands[1].args, [
    'deploy', '--config', '.native-build/b3/wrangler-derived.json', '--no-bundle',
    '--outdir', '.native-build/b3/wrangler-deploy', '--env-file', '/dev/null',
  ]);
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

test('Task19F Cloudflare adapter exposes closed live primitives and requires explicit repository authority', async () => {
  const adapter = await import('../scripts/lib/b3-cloudflare-live-adapter.mjs').catch(() => ({}));
  assert.equal(typeof adapter.createDefaultB3CloudflarePrimitives, 'function');
  assert.throws(() => adapter.createDefaultB3CloudflarePrimitives(), /repository root/i);
  assert.deepEqual(
    Object.keys(adapter.createDefaultB3CloudflarePrimitives({ root: process.cwd() })).sort(),
    ['deployExactBundle', 'dryRunBundle', 'inspectObject', 'inspectVersionApi', 'inspectWorkerState', 'smokeGateway', 'uploadObject'].sort(),
  );
  await assert.rejects(
    adapter.createDefaultB3CloudflarePrimitives({ root: process.cwd() }).smokeGateway({}),
    /smoke input authority is unavailable/i,
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
    role, key, bytes: bytes[role].length, sha256: sha(bytes[role]), etag: R2_ETAGS[role],
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
      return { deploymentVersionId: WORKER_VERSION_ID, deployedSourceSha256: value.deployedSourceSha256 };
    },
    inspectVersionApi: async () => ({ deploymentVersionId: WORKER_VERSION_ID, deployedSourceSha256: deployed.deployedSourceSha256 }),
    inspectWorkerState: async () => ({
      deploymentVersionId: WORKER_VERSION_ID,
      deployedSourceSha256: deployed.deployedSourceSha256,
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
      rateLimit: behaviour.rateLimit,
    }),
  };
  return { tracked, bytes, primitives, uploadCalls: () => uploadCalls };
}

function deviceSmokeProjection(draft) {
  return {
    schemaVersion: 1,
    deploymentVersionId: draft.worker.deploymentVersionId,
    scriptAuthoritySha256: draft.worker.scriptAuthoritySha256,
    signedEnvelopeSha256: draft.signedEnvelopeSha256,
    objects: draft.objects.map(({ role, key, sha256, size, etag }) => ({
      role, key, sha256, size, etag,
    })),
    capability: {
      ttlSeconds: 600, valid: true, tamperedRejected: true,
      expiredRejected: true, canonicalEncodingRequired: true,
    },
    range: {
      full200: true, partial206: true, conditional304: true,
      unsatisfied416: true, noRedirects: true, cacheControl: 'private, no-store',
    },
  };
}

test('Cloudflare orchestration writes an internal deployment draft and final assembly requires one device smoke', async () => {
  const harness = cloudflareHarness();
  const applicationAuthority = { testedApplicationCommit: 'b'.repeat(40), applicationFingerprint: 'a'.repeat(64) };
  let hostSmokeCalls = 0;
  const safeSmoke = harness.primitives.smokeGateway;
  harness.primitives.smokeGateway = async (value) => {
    hostSmokeCalls += 1;
    assert.deepEqual(Object.keys(value).sort(), [
      'deploymentVersionId', 'objects', 'scriptAuthoritySha256',
    ]);
    assert.equal(JSON.stringify(value).includes('capabilityUrl'), false);
    assert.equal(JSON.stringify(value).includes('sealedRefreshHandle'), false);
    return safeSmoke(value);
  };
  const draft = validateB3CloudflareDeploymentDraft(await orchestrateB3CloudflareDeployment({
    applicationAuthority, tracked: harness.tracked, primitives: harness.primitives,
    readAuthorityObject: async (role) => harness.bytes[role],
  }));
  assert.equal(hostSmokeCalls, 0);
  assert.equal(Object.hasOwn(draft, 'capability'), false);
  assert.equal(Object.hasOwn(draft, 'range'), false);
  assert.equal(Object.hasOwn(draft, 'rateLimit'), false);
  assert.equal(draft.deploymentReadback.versionApiMatched, true);
  assert.equal(draft.deploymentReadback.contentBytesMatched, true);
  assert.deepEqual(
    draft.deploymentReadback.objects.map(({ headMatched, getMatched }) => ({ headMatched, getMatched })),
    [{ headMatched: true, getMatched: true }, { headMatched: true, getMatched: true }],
  );
  assert.throws(
    () => validateB3CloudflareEvidence(draft),
    /closed schema|Cloudflare evidence/i,
  );
  await assert.rejects(
    assembleB3CloudflareEvidence({
      draft,
      smokeProjection: null,
      smokeGateway: harness.primitives.smokeGateway,
    }),
    /device gateway smoke|closed schema/i,
  );
  const evidence = validateB3CloudflareEvidence(await assembleB3CloudflareEvidence({
    draft,
    smokeProjection: deviceSmokeProjection(draft),
    smokeGateway: harness.primitives.smokeGateway,
  }));
  assert.equal(hostSmokeCalls, 1);
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
  const wrongSmoke = deviceSmokeProjection(draft);
  wrongSmoke.deploymentVersionId = 'b8f32f60-16b9-4ca6-9b4a-f771dd5302f7';
  await assert.rejects(
    () => assembleB3CloudflareEvidence({
      draft, smokeProjection: wrongSmoke, smokeGateway: harness.primitives.smokeGateway,
    }),
    /smoke|deployment|authority/i,
  );
  const extraSmoke = deviceSmokeProjection(draft);
  extraSmoke.rawCapabilityUrl = 'https://example.invalid/?cap=must-not-cross';
  await assert.rejects(
    assembleB3CloudflareEvidence({
      draft,
      smokeProjection: extraSmoke,
      smokeGateway: harness.primitives.smokeGateway,
    }),
    /closed schema/i,
  );
  const extraObject = deviceSmokeProjection(draft);
  extraObject.objects.push(structuredClone(extraObject.objects[0]));
  await assert.rejects(
    assembleB3CloudflareEvidence({
      draft,
      smokeProjection: extraObject,
      smokeGateway: harness.primitives.smokeGateway,
    }),
    /bound|object|smoke/i,
  );
  const conflictingObject = deviceSmokeProjection(draft);
  conflictingObject.objects[1].sha256 = 'f'.repeat(64);
  await assert.rejects(
    assembleB3CloudflareEvidence({
      draft,
      smokeProjection: conflictingObject,
      smokeGateway: harness.primitives.smokeGateway,
    }),
    /object|draft/i,
  );
  await assert.rejects(
    assembleB3CloudflareEvidence({
      draft,
      smokeProjection: deviceSmokeProjection(draft),
      smokeGateway: async () => ({
        identity: {
          workerVersionId: draft.worker.deploymentVersionId,
          workerScriptAuthoritySha256: draft.worker.scriptAuthoritySha256,
        },
        cors: { nativeOriginsAllowed: true, foreignOriginsRejected: true },
        rateLimit: {
          everyPublicPostGetCovered: true, limitedStatus: 429, limitedBodyReads: 0,
          limitedUpstreamCalls: 0, missingBindingFailedClosed: true,
        },
        capability: { selfAuthored: true },
      }),
    }),
    /host-safe gateway smoke|closed schema/i,
  );
  const stdoutOnly = structuredClone(draft);
  stdoutOnly.deploymentReadback.contentBytesMatched = false;
  await assert.rejects(
    () => assembleB3CloudflareEvidence({
      draft: stdoutOnly,
      smokeProjection: deviceSmokeProjection(draft),
      smokeGateway: harness.primitives.smokeGateway,
    }),
    /content|readback|draft/i,
  );
  const headOnly = structuredClone(draft);
  headOnly.deploymentReadback.objects[0].getMatched = false;
  await assert.rejects(
    () => assembleB3CloudflareEvidence({
      draft: headOnly,
      smokeProjection: deviceSmokeProjection(draft),
      smokeGateway: harness.primitives.smokeGateway,
    }),
    /object|head|get|readback/i,
  );
});

test('Cloudflare proof finalises only after the ignored draft and device smoke both exist', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-cloudflare-finalise-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'reports/b3'), { recursive: true });
  const harness = cloudflareHarness();
  const applicationAuthority = {
    testedApplicationCommit: 'b'.repeat(40),
    applicationFingerprint: 'a'.repeat(64),
  };
  const draft = await orchestrateB3CloudflareDeployment({
    applicationAuthority,
    tracked: harness.tracked,
    primitives: harness.primitives,
    readAuthorityObject: async (role) => harness.bytes[role],
  });
  await assert.rejects(
    readFile(join(root, 'reports/b3/cloudflare-sandbox-proof.json')),
    /ENOENT/u,
  );
  const evidence = await proveB3Cloudflare({
    root,
    primitives: harness.primitives,
    applicationAuthority,
    draft,
    smokeProjection: deviceSmokeProjection(draft),
    trackedAuthorityReader: async () => harness.tracked,
    write: true,
  });
  assert.deepEqual(
    validateB3CloudflareEvidence(JSON.parse(
      await readFile(join(root, 'reports/b3/cloudflare-sandbox-proof.json'), 'utf8'),
    )),
    evidence,
  );
  assert.deepEqual(await proveB3Cloudflare({
    root,
    primitives: harness.primitives,
    applicationAuthority,
    draft,
    smokeProjection: deviceSmokeProjection(draft),
    trackedAuthorityReader: async () => harness.tracked,
    write: true,
  }), evidence);
  await assert.rejects(
    readFile(join(root, 'reports/b3/cloudflare-deployment-draft.json')),
    /ENOENT/u,
  );
  await assert.rejects(
    readFile(join(root, 'reports/b3/cloudflare-device-smoke.json')),
    /ENOENT/u,
  );
});

test('Cloudflare production smoke authority is read from the iOS capture store', async () => {
  const source = await readFile(
    new URL('../scripts/prove-b3-cloudflare.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /openB3CaptureStore\(\{ platform: 'ios' \}\)/u);
  assert.match(source, /readCapture\(\)[\s\S]*gatewaySmokeProjection/u);
  assert.doesNotMatch(source, /cloudflare-device-smoke\.json/u);
});

test('deploy wrapper success writes only the ignored fixed deployment-draft path', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-cloudflare-draft-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const harness = cloudflareHarness();
  const draft = await deployB3SandboxGateway({
    root,
    env: {
      B3_REMOTE_MUTATION_SCOPE: 'cloudflare-deploy',
      B3_REMOTE_RUN_TOKEN: 'a'.repeat(64),
    },
    applicationAuthority: {
      testedApplicationCommit: 'b'.repeat(40),
      applicationFingerprint: 'a'.repeat(64),
    },
    localMutationGate: async () => {},
    prerequisiteChecker: async () => ({ status: 'pass', gates: [] }),
    trackedAuthorityReader: async () => harness.tracked,
    remoteInspector: async () => ({}),
    primitives: harness.primitives,
    readAuthorityObject: async (role) => harness.bytes[role],
    write: true,
  });
  const path = join(root, '.native-build/b3/evidence/cloudflare-deployment-draft.json');
  assert.deepEqual(
    validateB3CloudflareDeploymentDraft(JSON.parse(await readFile(path, 'utf8'))),
    draft,
  );
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(
    readFile(join(root, '.native-build/b3/evidence/cloudflare-deployment.json')),
    /ENOENT/u,
  );
  await assert.rejects(
    readFile(join(root, 'reports/b3/cloudflare-sandbox-proof.json')),
    /ENOENT/u,
  );
});

test('Cloudflare orchestration rejects invented identities and malformed dry-run bytes', async () => {
  const applicationAuthority = { testedApplicationCommit: 'b'.repeat(40), applicationFingerprint: 'a'.repeat(64) };
  const malformed = cloudflareHarness();
  malformed.primitives.dryRunBundle = async () => ({ source: 'no placeholder', normalised: true });
  await assert.rejects(orchestrateB3CloudflareDeployment({
    applicationAuthority, tracked: malformed.tracked, primitives: malformed.primitives,
    readAuthorityObject: async (role) => malformed.bytes[role],
  }), /placeholder/i);
  assert.equal(malformed.uploadCalls(), 0);

  const invalidVersion = cloudflareHarness();
  let inspectCalls = 0;
  invalidVersion.primitives.deployExactBundle = async (value) => ({
    deploymentVersionId: 'A8F32F60-16B9-4CA6-9B4A-F771DD5302F7',
    deployedSourceSha256: value.deployedSourceSha256,
  });
  invalidVersion.primitives.inspectVersionApi = async () => {
    inspectCalls += 1;
    throw new Error('API inspection must not be reached');
  };
  await assert.rejects(orchestrateB3CloudflareDeployment({
    applicationAuthority,
    tracked: invalidVersion.tracked,
    primitives: invalidVersion.primitives,
    readAuthorityObject: async (role) => invalidVersion.bytes[role],
  }), /Worker bytes or version authority mismatch/i);
  assert.equal(inspectCalls, 0);
});
