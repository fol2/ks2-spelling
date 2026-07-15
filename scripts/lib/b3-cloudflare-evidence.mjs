import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const B3_SCRIPT_AUTHORITY_PLACEHOLDER = '0'.repeat(64);
export const B3_CLOUDFLARE_SCOPE = 'cloudflare-deploy';
export const B3_MANIFEST_KEY = 'packs/b3-sandbox-proof/1.0.0-b3.1/signed-manifest.json';
export const B3_ARCHIVE_KEY = 'packs/b3-sandbox-proof/1.0.0-b3.1/b3-sandbox-proof.zip';

function cloudflareError(message) {
  const error = new Error(message);
  error.code = 'b3_cloudflare_authority_invalid';
  return error;
}

function validToken(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function assertGatewayAuthority(value) {
  if (
    value?.cloudflareAccountId !== '6d00cb4a0396c17ad6ba617bcbcaa45d' ||
    value?.workerName !== 'ks2-spelling-b3-sandbox' ||
    value?.privateR2BucketName !== 'ks2-spelling-b3-sandbox-packs' ||
    value?.publicSandboxOrigin !== 'https://b3-gateway.eugnel.uk'
  ) throw cloudflareError('tracked gateway authority mismatch');
}

export function orderTrackedB3Objects(objects) {
  if (!Array.isArray(objects) || objects.length !== 2) throw cloudflareError('tracked object authority mismatch');
  const manifest = objects.find((entry) => entry?.role === 'signed-manifest');
  const archive = objects.find((entry) => entry?.role === 'archive');
  if (!manifest || !archive || manifest.key !== B3_MANIFEST_KEY || archive.key !== B3_ARCHIVE_KEY) {
    throw cloudflareError('tracked object authority mismatch');
  }
  return Object.freeze([structuredClone(manifest), structuredClone(archive)]);
}

export async function readTrackedB3CloudflareAuthority(root) {
  const [gateway, objectAuthority] = await Promise.all([
    readFile(resolve(root, 'config/b3-gateway-authority.json'), 'utf8').then(JSON.parse),
    readFile(resolve(root, 'config/b3-pack-object-authority.json'), 'utf8').then(JSON.parse),
  ]);
  assertGatewayAuthority(gateway);
  if (objectAuthority?.bucketName !== gateway.privateR2BucketName) {
    throw cloudflareError('tracked bucket and object authority differ');
  }
  return Object.freeze({ gateway: structuredClone(gateway), objects: orderTrackedB3Objects(objectAuthority.objects) });
}

export function assertB3RemoteMutationScope({ approvedScope, runToken, expectedScope }) {
  if (approvedScope !== expectedScope) throw cloudflareError(`remote mutation scope must be ${expectedScope}`);
  if (!validToken(runToken)) throw cloudflareError('run token is missing or malformed');
  return true;
}

export function buildB3CloudflareDeploymentPlan({ authority, objects, approvedScope, runToken }) {
  assertGatewayAuthority(authority);
  assertB3RemoteMutationScope({ approvedScope, runToken, expectedScope: B3_CLOUDFLARE_SCOPE });
  const ordered = orderTrackedB3Objects(objects);
  const safe = ['--env-file', '/dev/null'];
  return Object.freeze({
    accountId: authority.cloudflareAccountId,
    commands: Object.freeze([
      Object.freeze({ operation: 'dry-run', args: Object.freeze(['deploy', '--dry-run', '--outdir', '.native-build/b3/wrangler-dry-run', ...safe]) }),
      Object.freeze({ operation: 'deploy-exact-bundle', args: Object.freeze(['deploy', '--outdir', '.native-build/b3/wrangler-deploy', ...safe]) }),
      Object.freeze({ operation: 'retrieve-version-api', method: 'GET', path: `/accounts/${authority.cloudflareAccountId}/workers/scripts/${authority.workerName}/versions` }),
      Object.freeze({ operation: 'upload-no-overwrite-identical-only', role: ordered[0].role, key: ordered[0].key }),
      Object.freeze({ operation: 'upload-no-overwrite-identical-only', role: ordered[1].role, key: ordered[1].key }),
    ]),
  });
}

export function bindB3ScriptAuthority(source) {
  if (typeof source !== 'string') throw cloudflareError('bundled Worker source is not text');
  const normalised = source.replace(/\r\n?/gu, '\n');
  const occurrences = normalised.split(B3_SCRIPT_AUTHORITY_PLACEHOLDER).length - 1;
  if (occurrences !== 1) throw cloudflareError('bundled Worker must contain exactly one script-authority placeholder');
  const scriptAuthoritySha256 = createHash('sha256').update(normalised, 'utf8').digest('hex');
  if (scriptAuthoritySha256.length !== B3_SCRIPT_AUTHORITY_PLACEHOLDER.length) {
    throw cloudflareError('script authority does not preserve placeholder length');
  }
  return Object.freeze({
    scriptAuthoritySha256,
    source: normalised.replace(B3_SCRIPT_AUTHORITY_PLACEHOLDER, scriptAuthoritySha256),
  });
}

export function assertSafeGatewayIdentity(actual, expected) {
  const allowed = ['workerVersionId', 'workerScriptAuthoritySha256'];
  if (!actual || !isDeepStrictEqual(Object.keys(actual).sort(), allowed.sort()) ||
      actual.workerVersionId !== expected.deploymentVersionId ||
      actual.workerScriptAuthoritySha256 !== expected.scriptAuthoritySha256) {
    throw cloudflareError('safe gateway response differs from deployed authority');
  }
  return structuredClone(actual);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertRemoteObject(actual, authority) {
  if (!actual || actual.key !== authority.key || actual.sha256 !== authority.sha256 ||
      actual.size !== authority.bytes || actual.etag !== authority.etag ||
      !isDeepStrictEqual(actual.customMetadata, authority.metadata)) {
    throw cloudflareError(`remote ${authority.role} object differs from tracked byte and metadata authority`);
  }
  return actual;
}

function requirePrimitive(primitives, name) {
  if (typeof primitives?.[name] !== 'function') throw cloudflareError(`approved Cloudflare primitive is missing: ${name}`);
  return primitives[name];
}

export async function orchestrateB3CloudflareDeployment({
  applicationAuthority,
  tracked,
  primitives,
  readAuthorityObject,
}) {
  if (!/^[0-9a-f]{40}$/u.test(applicationAuthority?.testedApplicationCommit ?? '') ||
      !/^[0-9a-f]{64}$/u.test(applicationAuthority?.applicationFingerprint ?? '')) {
    throw cloudflareError('clean application checkpoint authority is invalid');
  }
  assertGatewayAuthority(tracked?.gateway);
  const objects = orderTrackedB3Objects(tracked?.objects);
  if (typeof readAuthorityObject !== 'function') throw cloudflareError('tracked object byte reader is missing');
  const dryRunBundle = requirePrimitive(primitives, 'dryRunBundle');
  const deployExactBundle = requirePrimitive(primitives, 'deployExactBundle');
  const inspectVersionApi = requirePrimitive(primitives, 'inspectVersionApi');
  const inspectWorkerState = requirePrimitive(primitives, 'inspectWorkerState');
  const inspectObject = requirePrimitive(primitives, 'inspectObject');
  const uploadObject = requirePrimitive(primitives, 'uploadObject');
  const smokeGateway = requirePrimitive(primitives, 'smokeGateway');

  const objectBytes = new Map();
  for (const authority of objects) {
    const bytes = Buffer.from(await readAuthorityObject(authority.role));
    if (bytes.length !== authority.bytes || sha256(bytes) !== authority.sha256) {
      throw cloudflareError(`local ${authority.role} bytes differ from tracked authority`);
    }
    objectBytes.set(authority.role, bytes);
  }

  const dryRun = await dryRunBundle({ placeholder: B3_SCRIPT_AUTHORITY_PLACEHOLDER });
  if (!dryRun || typeof dryRun.source !== 'string' || dryRun.normalised !== true) {
    throw cloudflareError('deterministic Wrangler dry-run output is invalid');
  }
  const bound = bindB3ScriptAuthority(dryRun.source);
  const deployedSourceSha256 = sha256(Buffer.from(bound.source, 'utf8'));
  const deployment = await deployExactBundle({
    source: bound.source,
    scriptAuthoritySha256: bound.scriptAuthoritySha256,
    deployedSourceSha256,
  });
  if (!deployment || !/^[A-Za-z0-9._-]{1,128}$/u.test(deployment.deploymentVersionId ?? '') ||
      deployment.deployedSourceSha256 !== deployedSourceSha256) {
    throw cloudflareError('deployed Worker bytes or version authority mismatch');
  }
  const version = await inspectVersionApi({ deploymentVersionId: deployment.deploymentVersionId });
  if (!isDeepStrictEqual(version, {
    deploymentVersionId: deployment.deploymentVersionId,
    deployedSourceSha256,
  })) throw cloudflareError('Cloudflare API version authority mismatch');

  const workerState = await inspectWorkerState();
  const expectedWorkerState = {
    accountId: tracked.gateway.cloudflareAccountId,
    workerName: tracked.gateway.workerName,
    publicSandboxOrigin: tracked.gateway.publicSandboxOrigin,
    bucketName: tracked.gateway.privateR2BucketName,
    compatibilityDate: '2026-07-12',
    compatibilityFlags: ['nodejs_compat'],
    bindings: { r2: 'PACKS', rateLimit: 'GATEWAY_RATE_LIMIT', versionMetadata: 'WORKER_VERSION_METADATA' },
    requiredSecretNames: [
      'APPLE_IAP_ISSUER_ID', 'APPLE_IAP_KEY_ID', 'APPLE_IAP_PRIVATE_KEY',
      'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON', 'ENTITLEMENT_HANDLE_KEY_CURRENT',
      'ENTITLEMENT_HANDLE_KEY_PREVIOUS', 'R2_CAPABILITY_HMAC_KEY',
    ],
    bucketPrivate: true,
    r2DevPublicAccess: false,
    customDomains: [],
  };
  if (!isDeepStrictEqual(workerState, expectedWorkerState)) throw cloudflareError('remote Worker, binding, secret-name or bucket state mismatch');

  const reportObjects = [];
  for (const authority of objects) {
    let remote = await inspectObject({ role: authority.role, key: authority.key });
    if (remote === null) {
      await uploadObject({
        role: authority.role,
        key: authority.key,
        bytes: objectBytes.get(authority.role),
        customMetadata: structuredClone(authority.metadata),
        noOverwrite: true,
      });
      remote = await inspectObject({ role: authority.role, key: authority.key });
    }
    assertRemoteObject(remote, authority);
    reportObjects.push({
      role: authority.role,
      key: authority.key,
      sha256: authority.sha256,
      size: authority.bytes,
      etag: authority.etag,
      customMetadata: structuredClone(authority.metadata),
    });
  }

  const smoke = await smokeGateway({
    deploymentVersionId: deployment.deploymentVersionId,
    scriptAuthoritySha256: bound.scriptAuthoritySha256,
    objects: structuredClone(reportObjects),
  });
  assertSafeGatewayIdentity(smoke?.identity, {
    deploymentVersionId: deployment.deploymentVersionId,
    scriptAuthoritySha256: bound.scriptAuthoritySha256,
  });
  if (!isDeepStrictEqual(smoke?.cors, { nativeOriginsAllowed: true, foreignOriginsRejected: true }) ||
      !isDeepStrictEqual(smoke?.capability, { ttlSeconds: 600, valid: true, tamperedRejected: true, expiredRejected: true, canonicalEncodingRequired: true }) ||
      !isDeepStrictEqual(smoke?.range, { full200: true, partial206: true, conditional304: true, unsatisfied416: true, noRedirects: true, cacheControl: 'private, no-store' }) ||
      !isDeepStrictEqual(smoke?.rateLimit, { everyPublicPostGetCovered: true, limitedStatus: 429, limitedBodyReads: 0, limitedUpstreamCalls: 0, missingBindingFailedClosed: true })) {
    throw cloudflareError('live CORS, capability, range or rate-limit smoke mismatch');
  }
  return {
    schemaVersion: 1,
    testedApplicationCommit: applicationAuthority.testedApplicationCommit,
    applicationFingerprint: applicationAuthority.applicationFingerprint,
    worker: {
      accountId: workerState.accountId,
      name: workerState.workerName,
      publicSandboxOrigin: workerState.publicSandboxOrigin,
      deploymentVersionId: deployment.deploymentVersionId,
      scriptAuthoritySha256: bound.scriptAuthoritySha256,
      compatibilityDate: workerState.compatibilityDate,
      compatibilityFlags: workerState.compatibilityFlags,
      bindings: workerState.bindings,
      requiredSecretNames: workerState.requiredSecretNames,
      remoteSecretNamesVerified: true,
    },
    bucket: {
      approvedIdentifier: workerState.bucketName,
      private: workerState.bucketPrivate,
      r2DevPublicAccess: workerState.r2DevPublicAccess,
      customDomains: workerState.customDomains,
    },
    signedEnvelopeSha256: reportObjects[0].sha256,
    objects: reportObjects,
    capability: smoke.capability,
    range: smoke.range,
    rateLimit: smoke.rateLimit,
  };
}

export async function verifyB3CloudflareDeploymentEvidence({
  evidence,
  applicationAuthority,
  tracked,
  primitives,
}) {
  if (evidence?.testedApplicationCommit !== applicationAuthority?.testedApplicationCommit ||
      evidence?.applicationFingerprint !== applicationAuthority?.applicationFingerprint) {
    throw cloudflareError('Cloudflare evidence is stale relative to the clean application checkpoint');
  }
  assertGatewayAuthority(tracked?.gateway);
  const objects = orderTrackedB3Objects(tracked?.objects);
  const dryRunBundle = requirePrimitive(primitives, 'dryRunBundle');
  const inspectVersionApi = requirePrimitive(primitives, 'inspectVersionApi');
  const inspectWorkerState = requirePrimitive(primitives, 'inspectWorkerState');
  const inspectObject = requirePrimitive(primitives, 'inspectObject');
  const smokeGateway = requirePrimitive(primitives, 'smokeGateway');
  const dryRun = await dryRunBundle({ placeholder: B3_SCRIPT_AUTHORITY_PLACEHOLDER });
  if (!dryRun || typeof dryRun.source !== 'string' || dryRun.normalised !== true) {
    throw cloudflareError('deterministic Wrangler dry-run output is invalid');
  }
  const bound = bindB3ScriptAuthority(dryRun?.source);
  const deployedSourceSha256 = sha256(Buffer.from(bound.source, 'utf8'));
  if (bound.scriptAuthoritySha256 !== evidence.worker.scriptAuthoritySha256) {
    throw cloudflareError('current deterministic Worker script authority differs from live evidence');
  }
  const version = await inspectVersionApi({ deploymentVersionId: evidence.worker.deploymentVersionId });
  if (!isDeepStrictEqual(version, { deploymentVersionId: evidence.worker.deploymentVersionId, deployedSourceSha256 })) {
    throw cloudflareError('Cloudflare API version authority mismatch');
  }
  const workerState = await inspectWorkerState();
  const expectedWorkerState = {
    accountId: evidence.worker.accountId,
    workerName: evidence.worker.name,
    publicSandboxOrigin: evidence.worker.publicSandboxOrigin,
    bucketName: evidence.bucket.approvedIdentifier,
    compatibilityDate: evidence.worker.compatibilityDate,
    compatibilityFlags: evidence.worker.compatibilityFlags,
    bindings: evidence.worker.bindings,
    requiredSecretNames: evidence.worker.requiredSecretNames,
    bucketPrivate: evidence.bucket.private,
    r2DevPublicAccess: evidence.bucket.r2DevPublicAccess,
    customDomains: evidence.bucket.customDomains,
  };
  if (!isDeepStrictEqual(workerState, expectedWorkerState)) throw cloudflareError('live Worker state differs from evidence');
  for (let index = 0; index < objects.length; index += 1) {
    const remote = await inspectObject({ role: objects[index].role, key: objects[index].key });
    assertRemoteObject(remote, objects[index]);
    if (!isDeepStrictEqual(evidence.objects[index], {
      role: objects[index].role,
      key: objects[index].key,
      sha256: objects[index].sha256,
      size: objects[index].bytes,
      etag: objects[index].etag,
      customMetadata: objects[index].metadata,
    })) throw cloudflareError('live object evidence differs from tracked authority');
  }
  const smoke = await smokeGateway({
    deploymentVersionId: evidence.worker.deploymentVersionId,
    scriptAuthoritySha256: evidence.worker.scriptAuthoritySha256,
    objects: structuredClone(evidence.objects),
  });
  assertSafeGatewayIdentity(smoke?.identity, {
    deploymentVersionId: evidence.worker.deploymentVersionId,
    scriptAuthoritySha256: evidence.worker.scriptAuthoritySha256,
  });
  if (!isDeepStrictEqual(smoke?.capability, evidence.capability) ||
      !isDeepStrictEqual(smoke?.range, evidence.range) ||
      !isDeepStrictEqual(smoke?.rateLimit, evidence.rateLimit) ||
      !isDeepStrictEqual(smoke?.cors, { nativeOriginsAllowed: true, foreignOriginsRejected: true })) {
    throw cloudflareError('live gateway smoke differs from evidence');
  }
  return true;
}
