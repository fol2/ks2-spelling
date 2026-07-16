import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseJsonWithoutDuplicateMembers } from '../../src/domain/packs/signed-manifest-contract.js';

export const B3_SCRIPT_AUTHORITY_PLACEHOLDER = '0'.repeat(64);
export const B3_CLOUDFLARE_SCOPE = 'cloudflare-deploy';
export const B3_MANIFEST_KEY = 'packs/b3-sandbox-proof/1.0.0-b3.1/signed-manifest.json';
export const B3_ARCHIVE_KEY = 'packs/b3-sandbox-proof/1.0.0-b3.1/b3-sandbox-proof.zip';
const LOWERCASE_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const R2_ETAG = /^[0-9a-f]{32}$/u;
const DEPLOYMENT_DRAFT_KEYS = Object.freeze([
  'schemaVersion', 'testedApplicationCommit', 'applicationFingerprint', 'worker', 'bucket',
  'signedEnvelopeSha256', 'objects', 'deploymentReadback',
]);
const PUBLIC_WORKER_KEYS = Object.freeze([
  'accountId', 'name', 'publicSandboxOrigin', 'deploymentVersionId',
  'scriptAuthoritySha256', 'compatibilityDate', 'compatibilityFlags', 'bindings',
  'requiredSecretNames', 'remoteSecretNamesVerified',
]);
const PUBLIC_BUCKET_KEYS = Object.freeze([
  'approvedIdentifier', 'private', 'r2DevPublicAccess', 'customDomains',
]);
const PUBLIC_OBJECT_KEYS = Object.freeze([
  'role', 'key', 'sha256', 'size', 'etag', 'customMetadata',
]);
const SMOKE_OBJECT_KEYS = Object.freeze(['role', 'key', 'sha256', 'size', 'etag']);
const DEVICE_SMOKE_KEYS = Object.freeze([
  'schemaVersion', 'deploymentVersionId', 'scriptAuthoritySha256',
  'signedEnvelopeSha256', 'objects', 'capability', 'range',
]);
const REQUIRED_SECRET_NAMES = Object.freeze([
  'APPLE_IAP_ISSUER_ID', 'APPLE_IAP_KEY_ID', 'APPLE_IAP_PRIVATE_KEY',
  'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON', 'ENTITLEMENT_HANDLE_KEY_CURRENT',
  'ENTITLEMENT_HANDLE_KEY_PREVIOUS', 'R2_CAPABILITY_HMAC_KEY',
]);

function cloudflareError(message) {
  const error = new Error(message);
  error.code = 'b3_cloudflare_authority_invalid';
  return error;
}

function validToken(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function exactRecord(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(value, key))) {
    throw cloudflareError(`${label} violates its closed schema`);
  }
  return value;
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
    readFile(resolve(root, 'config/b3-gateway-authority.json')).then(
      (bytes) => parseJsonWithoutDuplicateMembers(bytes, 'B3 gateway authority'),
    ),
    readFile(resolve(root, 'config/b3-pack-object-authority.json')).then(
      (bytes) => parseJsonWithoutDuplicateMembers(bytes, 'B3 object authority'),
    ),
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
      Object.freeze({ operation: 'deploy-exact-bundle', args: Object.freeze([
        'deploy', '--config', '.native-build/b3/wrangler-derived.json', '--no-bundle',
        '--outdir', '.native-build/b3/wrangler-deploy', ...safe,
      ]) }),
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


function publicObjectFromAuthority(authority) {
  return {
    role: authority.role,
    key: authority.key,
    sha256: authority.sha256,
    size: authority.bytes,
    etag: authority.etag,
    customMetadata: structuredClone(authority.metadata),
  };
}

function smokeObjectFromPublic(value) {
  return {
    role: value.role,
    key: value.key,
    sha256: value.sha256,
    size: value.size,
    etag: value.etag,
  };
}

function assertSmokeObject(value, expected, label) {
  exactRecord(value, SMOKE_OBJECT_KEYS, label);
  if (!isDeepStrictEqual(value, smokeObjectFromPublic(expected))) {
    throw cloudflareError(`${label} differs from the deployment draft`);
  }
}

export function validateB3CloudflareDeploymentDraft(rawValue) {
  const value = exactRecord(rawValue, DEPLOYMENT_DRAFT_KEYS, 'Cloudflare deployment draft');
  exactRecord(value.worker, PUBLIC_WORKER_KEYS, 'Cloudflare deployment draft worker');
  exactRecord(value.worker.bindings, ['r2', 'rateLimit', 'versionMetadata'], 'Cloudflare deployment draft bindings');
  exactRecord(value.bucket, PUBLIC_BUCKET_KEYS, 'Cloudflare deployment draft bucket');
  exactRecord(
    value.deploymentReadback,
    ['deploymentVersionId', 'deployedSourceSha256', 'versionApiMatched',
      'contentBytesMatched', 'objects'],
    'Cloudflare deployment readback',
  );
  if (value.schemaVersion !== 1 || !/^[0-9a-f]{40}$/u.test(value.testedApplicationCommit) ||
      !SHA256.test(value.applicationFingerprint) ||
      value.worker.accountId !== '6d00cb4a0396c17ad6ba617bcbcaa45d' ||
      value.worker.name !== 'ks2-spelling-b3-sandbox' ||
      value.worker.publicSandboxOrigin !== 'https://b3-gateway.eugnel.uk' ||
      !LOWERCASE_UUID_V4.test(value.worker.deploymentVersionId) ||
      !SHA256.test(value.worker.scriptAuthoritySha256) ||
      value.worker.compatibilityDate !== '2026-07-12' ||
      !isDeepStrictEqual(value.worker.compatibilityFlags, ['nodejs_compat']) ||
      !isDeepStrictEqual(value.worker.bindings, {
        r2: 'PACKS', rateLimit: 'GATEWAY_RATE_LIMIT', versionMetadata: 'WORKER_VERSION_METADATA',
      }) ||
      !isDeepStrictEqual(value.worker.requiredSecretNames, REQUIRED_SECRET_NAMES) ||
      value.worker.remoteSecretNamesVerified !== true ||
      !isDeepStrictEqual(value.bucket, {
        approvedIdentifier: 'ks2-spelling-b3-sandbox-packs',
        private: true,
        r2DevPublicAccess: false,
        customDomains: [],
      }) ||
      !SHA256.test(value.signedEnvelopeSha256) || !Array.isArray(value.objects) ||
      value.objects.length !== 2 ||
      value.deploymentReadback.deploymentVersionId !== value.worker.deploymentVersionId ||
      !SHA256.test(value.deploymentReadback.deployedSourceSha256) ||
      value.deploymentReadback.versionApiMatched !== true ||
      value.deploymentReadback.contentBytesMatched !== true ||
      !Array.isArray(value.deploymentReadback.objects) ||
      value.deploymentReadback.objects.length !== 2) {
    throw cloudflareError('Cloudflare deployment draft readback authority is invalid');
  }
  const expectedRoles = ['signed-manifest', 'archive'];
  for (let index = 0; index < expectedRoles.length; index += 1) {
    const object = value.objects[index];
    const readback = value.deploymentReadback.objects[index];
    exactRecord(object, PUBLIC_OBJECT_KEYS, `Cloudflare deployment draft object ${index}`);
    exactRecord(
      readback,
      ['role', 'key', 'sha256', 'size', 'etag', 'headMatched', 'getMatched'],
      `Cloudflare deployment object readback ${index}`,
    );
    const expectedKey = index === 0 ? B3_MANIFEST_KEY : B3_ARCHIVE_KEY;
    const metadataKeys = index === 0
      ? ['b3-envelope-sha256', 'b3-role', 'b3-sha256', 'b3-size']
      : ['b3-role', 'b3-sha256', 'b3-size'];
    exactRecord(object.customMetadata, metadataKeys, `Cloudflare deployment draft metadata ${index}`);
    if (object.role !== expectedRoles[index] || object.key !== expectedKey ||
        !SHA256.test(object.sha256) ||
        !R2_ETAG.test(object.etag) || !Number.isSafeInteger(object.size) || object.size <= 0 ||
        object.customMetadata['b3-role'] !== object.role ||
        object.customMetadata['b3-sha256'] !== object.sha256 ||
        object.customMetadata['b3-size'] !== String(object.size) ||
        (index === 0 && object.customMetadata['b3-envelope-sha256'] !== object.sha256) ||
        !isDeepStrictEqual(readback, {
          ...smokeObjectFromPublic(object), headMatched: true, getMatched: true,
        })) {
      throw cloudflareError('Cloudflare deployment object head/get readback is invalid');
    }
  }
  if (value.signedEnvelopeSha256 !== value.objects[0].sha256) {
    throw cloudflareError('Cloudflare deployment draft envelope authority is invalid');
  }
  return structuredClone(value);
}

function validateDeviceSmokeProjection(rawValue, draft) {
  const value = exactRecord(rawValue, DEVICE_SMOKE_KEYS, 'B3 device gateway smoke');
  if (value.schemaVersion !== 1 ||
      value.deploymentVersionId !== draft.worker.deploymentVersionId ||
      value.scriptAuthoritySha256 !== draft.worker.scriptAuthoritySha256 ||
      value.signedEnvelopeSha256 !== draft.signedEnvelopeSha256 ||
      !Array.isArray(value.objects) || value.objects.length !== 2) {
    throw cloudflareError('B3 device gateway smoke is not bound to the deployment draft');
  }
  value.objects.forEach((object, index) =>
    assertSmokeObject(object, draft.objects[index], `B3 device gateway smoke object ${index}`));
  exactRecord(value.capability, [
    'ttlSeconds', 'valid', 'tamperedRejected', 'expiredRejected',
    'canonicalEncodingRequired',
  ], 'B3 device capability smoke');
  exactRecord(value.range, [
    'full200', 'partial206', 'conditional304', 'unsatisfied416',
    'noRedirects', 'cacheControl',
  ], 'B3 device Range smoke');
  if (!isDeepStrictEqual(value.capability, {
    ttlSeconds: 600,
    valid: true,
    tamperedRejected: true,
    expiredRejected: true,
    canonicalEncodingRequired: true,
  }) || !isDeepStrictEqual(value.range, {
    full200: true,
    partial206: true,
    conditional304: true,
    unsatisfied416: true,
    noRedirects: true,
    cacheControl: 'private, no-store',
  })) {
    throw cloudflareError('B3 device capability or Range smoke is invalid');
  }
  return structuredClone(value);
}

export function validateB3DeviceGatewaySmokeProjection(rawValue, rawDraft) {
  return validateDeviceSmokeProjection(
    rawValue,
    validateB3CloudflareDeploymentDraft(rawDraft),
  );
}

export async function assembleB3CloudflareEvidence({
  draft: rawDraft,
  smokeProjection: rawSmokeProjection,
  smokeGateway,
}) {
  const draft = validateB3CloudflareDeploymentDraft(rawDraft);
  const deviceSmoke = validateB3DeviceGatewaySmokeProjection(rawSmokeProjection, draft);
  if (typeof smokeGateway !== 'function') {
    throw cloudflareError('approved host-safe gateway smoke primitive is missing');
  }
  const safeInput = {
    deploymentVersionId: draft.worker.deploymentVersionId,
    scriptAuthoritySha256: draft.worker.scriptAuthoritySha256,
    objects: draft.objects.map(smokeObjectFromPublic),
  };
  const safeSmoke = await smokeGateway(structuredClone(safeInput));
  exactRecord(safeSmoke, ['identity', 'cors', 'rateLimit'], 'host-safe gateway smoke');
  assertSafeGatewayIdentity(safeSmoke.identity, {
    deploymentVersionId: draft.worker.deploymentVersionId,
    scriptAuthoritySha256: draft.worker.scriptAuthoritySha256,
  });
  exactRecord(safeSmoke.cors, ['nativeOriginsAllowed', 'foreignOriginsRejected'], 'host-safe CORS smoke');
  exactRecord(safeSmoke.rateLimit, [
    'everyPublicPostGetCovered', 'limitedStatus', 'limitedBodyReads',
    'limitedUpstreamCalls', 'missingBindingFailedClosed',
  ], 'host-safe rate-limit smoke');
  if (!isDeepStrictEqual(safeSmoke.cors, {
    nativeOriginsAllowed: true, foreignOriginsRejected: true,
  }) || !isDeepStrictEqual(safeSmoke.rateLimit, {
    everyPublicPostGetCovered: true,
    limitedStatus: 429,
    limitedBodyReads: 0,
    limitedUpstreamCalls: 0,
    missingBindingFailedClosed: true,
  })) {
    throw cloudflareError('host-safe CORS or rate-limit smoke is invalid');
  }
  return {
    schemaVersion: 1,
    testedApplicationCommit: draft.testedApplicationCommit,
    applicationFingerprint: draft.applicationFingerprint,
    worker: structuredClone(draft.worker),
    bucket: structuredClone(draft.bucket),
    signedEnvelopeSha256: draft.signedEnvelopeSha256,
    objects: structuredClone(draft.objects),
    capability: deviceSmoke.capability,
    range: deviceSmoke.range,
    rateLimit: structuredClone(safeSmoke.rateLimit),
  };
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
  if (!deployment || !LOWERCASE_UUID_V4.test(deployment.deploymentVersionId ?? '') ||
      deployment.deployedSourceSha256 !== deployedSourceSha256) {
    throw cloudflareError('deployed Worker bytes or version authority mismatch');
  }
  const version = await inspectVersionApi({
    deploymentVersionId: deployment.deploymentVersionId,
    deployedSourceSha256,
    scriptAuthoritySha256: bound.scriptAuthoritySha256,
  });
  if (!isDeepStrictEqual(version, {
    deploymentVersionId: deployment.deploymentVersionId,
    deployedSourceSha256,
  })) throw cloudflareError('Cloudflare API version authority mismatch');

  const workerState = await inspectWorkerState();
  const expectedWorkerState = {
    deploymentVersionId: deployment.deploymentVersionId,
    deployedSourceSha256,
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
    reportObjects.push(publicObjectFromAuthority(authority));
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
    deploymentReadback: {
      deploymentVersionId: deployment.deploymentVersionId,
      deployedSourceSha256,
      versionApiMatched: true,
      contentBytesMatched: true,
      objects: reportObjects.map((object) => ({
        ...smokeObjectFromPublic(object),
        headMatched: true,
        getMatched: true,
      })),
    },
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
  const version = await inspectVersionApi({
    deploymentVersionId: evidence.worker.deploymentVersionId,
    deployedSourceSha256,
    scriptAuthoritySha256: bound.scriptAuthoritySha256,
  });
  if (!isDeepStrictEqual(version, { deploymentVersionId: evidence.worker.deploymentVersionId, deployedSourceSha256 })) {
    throw cloudflareError('Cloudflare API version authority mismatch');
  }
  const workerState = await inspectWorkerState();
  const expectedWorkerState = {
    deploymentVersionId: evidence.worker.deploymentVersionId,
    deployedSourceSha256,
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
    objects: evidence.objects.map(smokeObjectFromPublic),
  });
  exactRecord(smoke, ['identity', 'cors', 'rateLimit'], 'host-safe gateway smoke');
  assertSafeGatewayIdentity(smoke?.identity, {
    deploymentVersionId: evidence.worker.deploymentVersionId,
    scriptAuthoritySha256: evidence.worker.scriptAuthoritySha256,
  });
  if (!isDeepStrictEqual(smoke?.rateLimit, evidence.rateLimit) ||
      !isDeepStrictEqual(smoke?.cors, { nativeOriginsAllowed: true, foreignOriginsRejected: true })) {
    throw cloudflareError('host-safe gateway smoke differs from evidence');
  }
  return true;
}
