import {
  assertClosedArray,
  assertClosedRecord,
  assertExactPort,
  assertApprovedProductId,
  assertProductId,
  assertSafeInteger,
  assertString,
  cloneFrozenArray,
  fail,
} from '../commerce/store-port.js';
import {
  MAX_OPAQUE_PROOF_CHARS,
  MAX_SEALED_REFRESH_HANDLE_CHARS,
  OPAQUE_PROOF_PATTERN,
} from './gateway-payload-limits.js';

export const ENTITLEMENT_GATEWAY_METHODS = Object.freeze([
  'verifyTransaction',
  'completeTransaction',
  'refreshEntitlement',
  'authorisePackDownload',
]);

const IDENTITY_KEYS = Object.freeze([
  'store',
  'productId',
  'environment',
  'applicationId',
  'entitlementId',
  'state',
  'storeTransactionId',
  'sealedRefreshHandle',
  'refreshHandleVersion',
  'traceId',
  'workerVersionId',
  'workerScriptAuthoritySha256',
]);
const DOWNLOAD_KEYS = Object.freeze([
  ...IDENTITY_KEYS,
  'packId',
  'version',
  'signedManifestEnvelopeBase64',
  'signedEnvelopeSha256',
  'objects',
  'archiveCapability',
]);
const OBJECT_KEYS = Object.freeze(['objectKind', 'sha256', 'size', 'etag']);
const CAPABILITY_KEYS = Object.freeze([
  'packId',
  'version',
  'archiveName',
  'sha256',
  'compressedBytes',
  'etag',
  'capabilityUrl',
]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PACK_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/;

export function validateVerifyRequest(value) {
  assertClosedRecord(
    value,
    ['store', 'environment', 'productId', 'opaqueProof'],
    'Gateway verification request',
  );
  if (value.store !== 'apple' && value.store !== 'google') fail('Gateway store');
  if (value.environment !== 'sandbox') fail('Gateway environment');
  const productId = assertApprovedProductId(value.productId);
  if (
    (value.store === 'apple' && productId !== 'uk.eugnel.ks2spelling.fullks2') ||
    (value.store === 'google' && productId !== 'full_ks2')
  ) {
    fail('Gateway product identity');
  }
  return Object.freeze({
    store: value.store,
    environment: value.environment,
    productId,
    opaqueProof: assertString(value.opaqueProof, 'Opaque store proof', {
      max: MAX_OPAQUE_PROOF_CHARS,
      pattern: OPAQUE_PROOF_PATTERN,
    }),
  });
}

export function validateHandleRequest(value, label = 'Gateway handle request') {
  assertClosedRecord(value, ['sealedRefreshHandle'], label);
  return Object.freeze({
    sealedRefreshHandle: assertString(
      value.sealedRefreshHandle,
      'Sealed refresh handle',
      { max: MAX_SEALED_REFRESH_HANDLE_CHARS },
    ),
  });
}

export function validateAuthoriseRequest(value) {
  assertClosedRecord(
    value,
    ['sealedRefreshHandle', 'packId', 'version'],
    'Pack authorisation request',
  );
  return Object.freeze({
    sealedRefreshHandle: assertString(
      value.sealedRefreshHandle,
      'Sealed refresh handle',
      { max: MAX_SEALED_REFRESH_HANDLE_CHARS },
    ),
    packId: assertString(value.packId, 'Pack identifier', { max: 64, pattern: PACK_ID }),
    version: assertString(value.version, 'Pack version', { max: 64, pattern: VERSION }),
  });
}

function validateStoreTransactionId(store, value) {
  const pattern = store === 'apple'
    ? /^[1-9][0-9]{0,31}$/
    : /^GPA\.[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{5}$/;
  return assertString(value, 'Gateway store transaction identifier', {
    max: 32,
    pattern,
  });
}

function validateIdentityFields(value, keys = IDENTITY_KEYS) {
  assertClosedRecord(value, keys, 'Gateway success response');
  if (value.store !== 'apple' && value.store !== 'google') fail('Gateway response store');
  if (value.environment !== 'sandbox') fail('Gateway response environment');
  if (value.applicationId !== 'uk.eugnel.ks2spelling') fail('Gateway application identity');
  if (value.entitlementId !== 'full-ks2') fail('Gateway entitlement identity');
  if (value.state !== 'active' && value.state !== 'revoked') fail('Gateway entitlement state');
  const productId = assertProductId(value.productId);
  if (
    (value.store === 'apple' && productId !== 'uk.eugnel.ks2spelling.fullks2') ||
    (value.store === 'google' && productId !== 'full_ks2')
  ) {
    fail('Gateway product identity');
  }
  const output = {
    store: value.store,
    productId,
    environment: value.environment,
    applicationId: value.applicationId,
    entitlementId: value.entitlementId,
    state: value.state,
    storeTransactionId: validateStoreTransactionId(value.store, value.storeTransactionId),
    sealedRefreshHandle: assertString(
      value.sealedRefreshHandle,
      'Gateway sealed refresh handle',
      { max: MAX_SEALED_REFRESH_HANDLE_CHARS },
    ),
    refreshHandleVersion: assertSafeInteger(
      value.refreshHandleVersion,
      'Gateway refresh handle version',
      { min: 1, max: 2_147_483_647 },
    ),
    traceId: assertString(value.traceId, 'Gateway trace identifier', {
      min: 36,
      max: 36,
      pattern: UUID_V4,
    }),
    workerVersionId: assertString(value.workerVersionId, 'Worker version identifier', {
      max: 128,
      pattern: /^[A-Za-z0-9._-]+$/,
    }),
    workerScriptAuthoritySha256: assertString(
      value.workerScriptAuthoritySha256,
      'Worker script authority SHA-256',
      { min: 64, max: 64, pattern: SHA256 },
    ),
  };
  return output;
}

export function validateIdentityResponse(value, expected) {
  const output = validateIdentityFields(value);
  if (expected) {
    for (const key of ['store', 'productId', 'environment']) {
      if (expected[key] !== undefined && output[key] !== expected[key]) {
        fail('Gateway response identity', `does not match ${key}`);
      }
    }
  }
  return Object.freeze(output);
}

function validateObjectRecord(value) {
  assertClosedRecord(value, OBJECT_KEYS, 'Pack object authority');
  if (value.objectKind !== 'manifest' && value.objectKind !== 'archive') {
    fail('Pack object kind');
  }
  return Object.freeze({
    objectKind: value.objectKind,
    sha256: assertString(value.sha256, 'Pack object SHA-256', {
      min: 64, max: 64, pattern: SHA256,
    }),
    size: assertSafeInteger(value.size, 'Pack object size', { min: 1 }),
    etag: assertString(value.etag, 'Pack object ETag', { max: 256 }),
  });
}

function validateCapability(value, packId, version) {
  assertClosedRecord(value, CAPABILITY_KEYS, 'Pack archive capability');
  if (value.packId !== packId || value.version !== version) {
    fail('Pack archive capability', 'has mismatched identity');
  }
  return Object.freeze({
    packId,
    version,
    archiveName: assertString(value.archiveName, 'Archive name', {
      max: 128,
      pattern: /^[a-z0-9][a-z0-9._-]*\.zip$/,
    }),
    sha256: assertString(value.sha256, 'Archive SHA-256', {
      min: 64, max: 64, pattern: SHA256,
    }),
    compressedBytes: assertSafeInteger(value.compressedBytes, 'Archive compressed bytes', {
      min: 1,
    }),
    etag: assertString(value.etag, 'Archive ETag', { max: 256 }),
    capabilityUrl: assertString(value.capabilityUrl, 'Archive capability URL', { max: 8_192 }),
  });
}

export function validateAuthoriseResponse(value, expected) {
  const identity = validateIdentityFields(value, DOWNLOAD_KEYS);
  const packId = assertString(value.packId, 'Pack identifier', { max: 64, pattern: PACK_ID });
  const version = assertString(value.version, 'Pack version', { max: 64, pattern: VERSION });
  if (packId !== expected.packId || version !== expected.version) {
    fail('Gateway response identity', 'does not match requested pack');
  }
  const objects = assertClosedArray(value.objects, 'Pack objects', { min: 2, max: 2 });
  const validatedObjects = cloneFrozenArray(objects, validateObjectRecord);
  if (
    validatedObjects[0].objectKind !== 'manifest' ||
    validatedObjects[1].objectKind !== 'archive'
  ) {
    fail('Pack objects', 'must be ordered manifest then archive');
  }
  const capability = validateCapability(value.archiveCapability, packId, version);
  if (
    value.signedEnvelopeSha256 !== validatedObjects[0].sha256 ||
    capability.sha256 !== validatedObjects[1].sha256 ||
    capability.compressedBytes !== validatedObjects[1].size ||
    capability.etag !== validatedObjects[1].etag
  ) {
    fail('Pack download response', 'contains inconsistent object authority');
  }
  return Object.freeze({
    ...identity,
    packId,
    version,
    signedManifestEnvelopeBase64: assertString(
      value.signedManifestEnvelopeBase64,
      'Signed manifest envelope',
      { max: 1_048_576, pattern: /^[A-Za-z0-9+/]+={0,2}$/ },
    ),
    signedEnvelopeSha256: assertString(value.signedEnvelopeSha256, 'Envelope SHA-256', {
      min: 64, max: 64, pattern: SHA256,
    }),
    objects: validatedObjects,
    archiveCapability: capability,
  });
}

export function assertEntitlementGatewayPort(value) {
  return assertExactPort(
    value,
    ENTITLEMENT_GATEWAY_METHODS,
    'EntitlementGatewayPort',
  );
}
