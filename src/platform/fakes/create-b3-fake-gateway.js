import {
  assertClosedArray,
  cloneScriptOutcome,
  fail,
} from '../commerce/store-port.js';
import {
  ENTITLEMENT_GATEWAY_METHODS,
  assertEntitlementGatewayPort,
  validateAuthoriseRequest,
  validateAuthoriseResponse,
  validateHandleRequest,
  validateIdentityResponse,
  validateVerifyRequest,
} from '../gateway/entitlement-gateway-port.js';

const OPTION_KEYS = Object.freeze([
  'verifyOutcomes',
  'completeOutcomes',
  'refreshOutcomes',
  'authoriseOutcomes',
  'uuidFactory',
]);
const SHA_A = 'a'.repeat(64);
const SHA_B = '39b6a788a3686d7cbf1fd4791bce45623af21ef53c60eabc03d955395856218a';
const SHA_C = '4c2ca2eb4d4bb7ac3347b66e3483dcb6aa71b41958704733bfc471c970ce7664';
const ARCHIVE_ETAG = '913d2b2485ca6cd31d467bd7228d7e75';

function identity() {
  return {
    store: 'google',
    productId: 'full_ks2',
    environment: 'sandbox',
    applicationId: 'uk.eugnel.ks2spelling',
    entitlementId: 'full-ks2',
    state: 'active',
    storeTransactionId: 'GPA.1234-5678-9012-34567',
    sealedRefreshHandle: 'b3rh1.1.fake-nonce.fake-ciphertext',
    refreshHandleVersion: 1,
    workerVersionId: 'b3-fake-worker',
    workerScriptAuthoritySha256: SHA_A,
  };
}

function authorisation() {
  const capabilityUrl = [
    ['https:', '', 'b3-gateway.eugnel.uk'].join('/'),
    'v1',
    'packs',
    'b3-sandbox-proof',
    '1.0.0-b3.1',
    'b3-sandbox-proof.zip',
  ].join('/') +
    '?expires=1783987200&cap=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  return {
    ...identity(),
    packId: 'b3-sandbox-proof',
    version: '1.0.0-b3.1',
    signedManifestEnvelopeBase64: 'e30=',
    signedEnvelopeSha256: SHA_B,
    objects: [
      { objectKind: 'manifest', sha256: SHA_B, size: 1_135, etag: 'c76b2858b8345814279a1c92ae64e365' },
      { objectKind: 'archive', sha256: SHA_C, size: 1_324, etag: ARCHIVE_ETAG },
    ],
    archiveCapability: {
      packId: 'b3-sandbox-proof',
      version: '1.0.0-b3.1',
      archiveName: 'b3-sandbox-proof.zip',
      sha256: SHA_C,
      compressedBytes: 1_324,
      etag: ARCHIVE_ETAG,
      capabilityUrl,
    },
  };
}

function readOptions(options) {
  if (options === undefined) return {};
  if (
    !options || typeof options !== 'object' || Array.isArray(options) ||
    Object.getPrototypeOf(options) !== Object.prototype
  ) {
    fail('B3 fake gateway options', 'must be a closed plain record');
  }
  for (const key of Reflect.ownKeys(options)) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (
      typeof key !== 'string' || !OPTION_KEYS.includes(key) ||
      !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
    ) {
      fail('B3 fake gateway options', 'contain an unknown or unsafe field');
    }
  }
  return options;
}

function queue(value, fallback, label) {
  return assertClosedArray(value ?? fallback, label, { max: 128 }).map((outcome) =>
    cloneScriptOutcome(outcome, label));
}

function take(values, label, uuidFactory) {
  if (values.length === 0) {
    const error = new Error(`${label} script is exhausted.`);
    error.code = 'B3_FAKE_SCRIPT_EXHAUSTED';
    throw error;
  }
  const value = values.shift();
  if (value instanceof Error) throw value;
  return { ...cloneScriptOutcome(value, `Fake ${label} outcome`), traceId: uuidFactory() };
}

export function createB3FakeGateway(rawOptions) {
  const options = readOptions(rawOptions);
  const uuidFactory = options.uuidFactory ?? (() => globalThis.crypto.randomUUID());
  if (typeof uuidFactory !== 'function') fail('B3 fake UUID factory');
  const verify = queue(options.verifyOutcomes, [identity()], 'Fake verify outcomes');
  const complete = queue(options.completeOutcomes, [identity()], 'Fake complete outcomes');
  const refresh = queue(options.refreshOutcomes, [identity()], 'Fake refresh outcomes');
  const authorise = queue(
    options.authoriseOutcomes,
    [authorisation()],
    'Fake authorisation outcomes',
  );
  const port = {
    async verifyTransaction(request) {
      const input = validateVerifyRequest(request);
      return validateIdentityResponse(take(verify, 'verifyTransaction', uuidFactory), input);
    },
    async completeTransaction(request) {
      validateHandleRequest(request, 'Transaction completion request');
      return validateIdentityResponse(take(complete, 'completeTransaction', uuidFactory));
    },
    async refreshEntitlement(request) {
      validateHandleRequest(request, 'Entitlement refresh request');
      return validateIdentityResponse(take(refresh, 'refreshEntitlement', uuidFactory));
    },
    async authorisePackDownload(request) {
      const input = validateAuthoriseRequest(request);
      return validateAuthoriseResponse(
        take(authorise, 'authorisePackDownload', uuidFactory),
        input,
      );
    },
  };
  assertEntitlementGatewayPort(port);
  if (Reflect.ownKeys(port).length !== ENTITLEMENT_GATEWAY_METHODS.length) {
    fail('EntitlementGatewayPort');
  }
  return Object.freeze(port);
}
