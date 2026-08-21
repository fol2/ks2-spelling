import productionPackSigningKeyring from '../../../config/production/pack-signing-public-keys.json' with { type: 'json' };
import storeProductCatalogue from '../../../config/store-products.json' with { type: 'json' };

const STORE_CATALOGUE_KEYS = Object.freeze(['schemaVersion', 'products']);
const PRODUCT_KEYS = Object.freeze([
  'entitlementId',
  'type',
  'appleProductId',
  'googleProductId',
  'packIds',
]);
const KEYRING_KEYS = Object.freeze(['schemaVersion', 'keys']);
const SIGNING_KEY_KEYS = Object.freeze([
  'keyId',
  'algorithm',
  'publicKeySpkiDerBase64',
  'publicKeySpkiSha256',
  'testOnly',
  'notBefore',
  'notAfter',
  'allowedEnvironments',
  'allowedPackIds',
]);
const PROOF_PACK_KEYS = Object.freeze([
  'schemaVersion',
  'packId',
  'version',
  'requiredEntitlementId',
  'archiveName',
  'signingKeyId',
  'signatureDerSha256',
  'signedEnvelopeSha256',
  'allowedExtensions',
  'ceilings',
]);
const PROOF_PACK_CEILING_KEYS = Object.freeze([
  'fileCount',
  'compressedBytes',
  'extractedBytes',
]);
const GATEWAY_AUTHORITY_KEYS = Object.freeze([
  'schemaVersion',
  'environment',
  'cloudflareAccountId',
  'workerName',
  'privateR2BucketName',
  'publicSandboxOrigin',
  'allowedOrigins',
  'distribution',
]);
const DISTRIBUTION_KEYS = Object.freeze([
  'applicationId',
  'iosKind',
  'androidTrack',
]);
const EXPECTED_PUBLIC_PRODUCTION_ORIGIN = Object.freeze(
  ['https:', '', 'ks2-gateway.eugnel.uk'].join('/'),
);
const EXPECTED_ALLOWED_ORIGINS = Object.freeze([
  ['capacitor:', '', 'localhost'].join('/'),
  ['http:', '', 'localhost'].join('/'),
]);

// The closed enum is the future-IAP seam: a new store product kind is admitted by
// naming it here, and only then by growing an implementation for it. Nothing in this
// slice branches on `type` — every approved product travels the one implemented path.
const KNOWN_PRODUCT_TYPES = Object.freeze([
  'non-consumable',
  'consumable',
  'auto-renewing-subscription',
]);
const IMPLEMENTED_PRODUCT_TYPES = Object.freeze(['non-consumable']);

const KNOWN_STORE_FIELDS = Object.freeze(['appleProductId', 'googleProductId']);

const KEBAB_IDENTITY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const APPLE_PRODUCT_ID = /^[a-z0-9]+(?:\.[a-z0-9]+)+$/u;
const GOOGLE_PRODUCT_ID = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;

function expectedSandboxSigningKey() {
  return Object.freeze({
    keyId: 'b3-test-p256-2026-07',
    algorithm: 'ECDSA_P256_SHA256_DER',
    publicKeySpkiDerBase64:
      'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEYP7UuiVanTHJYet0xjVtaMBJuJI7Yfps5mliLmDyn7Z5A/4QCLi8maQa6elWKLxk8vGyDC1+n1F3o8KU1EYimQ==',
    publicKeySpkiSha256:
      '5a7a78cca4a0f420d9bc62bb669c3c2759e39f723d3ae10dcbe0f0815a07ecd4',
    testOnly: true,
    notBefore: '2026-07-01T00:00:00Z',
    notAfter: '2027-07-01T00:00:00Z',
    allowedEnvironments: Object.freeze(['test', 'sandbox']),
    allowedPackIds: Object.freeze([
      'b3-sandbox-proof',
      'full-ks2-shard-01',
      'full-ks2-shard-02',
      'full-ks2-shard-03',
      'full-ks2-shard-04',
      'full-ks2-shard-05',
      'full-ks2-shard-06',
      'full-ks2-shard-07',
      'full-ks2-shard-08',
      'full-ks2-shard-09',
      'full-ks2-shard-10',
      'full-ks2-shard-11',
      'full-ks2-shard-12',
      'full-ks2-shard-13',
      'full-ks2-shard-14',
      'full-ks2-shard-15',
    ]),
  });
}

const EXPECTED_PRODUCTION_SIGNING_KEY = Object.freeze({
  keyId: 'production-ks2-p256-2026-08',
  algorithm: 'ECDSA_P256_SHA256_DER',
  publicKeySpkiDerBase64:
    'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEU06jemaXTUtazmoYXARLD7xfXpTpsxAMbgwRqgOAQIWvmL7yQgn/GQ4T4MTiQ98rq4C+K4Q7t0LxrpaIgdDvfg==',
  publicKeySpkiSha256:
    '5e0a462087cd86f1a67bd4d6ebdd2a60909fc963400d2b55475c618b2ebe10bb',
  testOnly: false,
  notBefore: '2026-08-17T00:00:00Z',
  notAfter: '2036-08-16T00:00:00Z',
  allowedEnvironments: Object.freeze(['production']),
  allowedPackIds: Object.freeze([
    'full-ks2-shard-01',
    'full-ks2-shard-02',
    'full-ks2-shard-03',
    'full-ks2-shard-04',
    'full-ks2-shard-05',
    'full-ks2-shard-06',
    'full-ks2-shard-07',
    'full-ks2-shard-08',
    'full-ks2-shard-09',
    'full-ks2-shard-10',
    'full-ks2-shard-11',
    'full-ks2-shard-12',
    'full-ks2-shard-13',
    'full-ks2-shard-14',
    'full-ks2-shard-15',
  ]),
});

function fail(label, detail) {
  throw new TypeError(`${label} ${detail}.`);
}

function assertClosedRecord(value, keys, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    fail(label, 'must be a plain object');
  }
  const actualKeys = Reflect.ownKeys(value);
  if (
    actualKeys.length !== keys.length ||
    actualKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    fail(label, 'must contain exactly the approved fields');
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail(label, 'must contain only own enumerable data fields');
    }
  }
  return value;
}

function assertExactArray(value, expected, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(label, 'must equal the approved ordered values');
  }
  const keys = Reflect.ownKeys(value);
  const expectedKeys = [...expected.map((_, index) => String(index)), 'length'];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) {
    fail(label, 'must equal the approved ordered values');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!lengthDescriptor || lengthDescriptor.value !== expected.length) {
    fail(label, 'must equal the approved ordered values');
  }
  for (let index = 0; index < expected.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value') ||
      descriptor.value !== expected[index]
    ) {
      fail(label, 'must equal the approved ordered values');
    }
  }
}

function readClosedArray(value, expectedLength, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(label, 'must contain an approved array');
  }
  const keys = Reflect.ownKeys(value);
  const expectedKeys = [
    ...Array.from({ length: expectedLength }, (_, index) => String(index)),
    'length',
  ];
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key)) ||
    !lengthDescriptor ||
    lengthDescriptor.value !== expectedLength
  ) {
    fail(label, 'must contain exactly the approved array entries');
  }
  return Array.from({ length: expectedLength }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail(label, 'must contain only own enumerable array data');
    }
    return descriptor.value;
  });
}

function assertExactRecord(value, expected, keys, label) {
  assertClosedRecord(value, keys, label);
  for (const key of keys) {
    const expectedValue = expected[key];
    if (Array.isArray(expectedValue)) {
      assertExactArray(value[key], expectedValue, label);
    } else if (value[key] !== expectedValue) {
      fail(label, `has an unapproved ${key}`);
    }
  }
}

function readOpenArray(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(label, 'must contain an approved array');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!lengthDescriptor || !Number.isSafeInteger(lengthDescriptor.value)) {
    fail(label, 'must contain an approved array');
  }
  return readClosedArray(value, lengthDescriptor.value, label);
}

let signablePackIdCache = null;

// A catalogue may only sell packs some approved signing key can verify: an unsignable
// packId would be a product the device can pay for and then never trust on arrival.
function signablePackIds() {
  if (signablePackIdCache === null) {
    assertProductionPackKeyring(productionPackSigningKeyring);
    signablePackIdCache = new Set(
      productionPackSigningKeyring.keys.flatMap((key) => [...key.allowedPackIds]),
    );
  }
  return signablePackIdCache;
}

function assertApprovedProduct(product, claimed, label) {
  assertClosedRecord(product, PRODUCT_KEYS, label);
  if (typeof product.entitlementId !== 'string' || !KEBAB_IDENTITY.test(product.entitlementId)) {
    fail(label, 'has an unapproved entitlementId');
  }
  if (!KNOWN_PRODUCT_TYPES.includes(product.type)) {
    fail(label, 'has an unapproved type');
  }
  if (!IMPLEMENTED_PRODUCT_TYPES.includes(product.type)) {
    fail(label, `declares the ${product.type} type, which has no implementation`);
  }
  if (typeof product.appleProductId !== 'string' ||
    !APPLE_PRODUCT_ID.test(product.appleProductId)) {
    fail(label, 'has an unapproved appleProductId');
  }
  if (typeof product.googleProductId !== 'string' ||
    !GOOGLE_PRODUCT_ID.test(product.googleProductId)) {
    fail(label, 'has an unapproved googleProductId');
  }
  const packIds = readOpenArray(product.packIds, label);
  if (packIds.length === 0) fail(label, 'must give every product at least one pack');
  // Packs are deliberately NOT unique across products: a bundle and a narrower product
  // may both deliver the same shard. Entitlements and store product ids must be unique.
  const ownPackIds = new Set();
  for (const packId of packIds) {
    if (typeof packId !== 'string' || !KEBAB_IDENTITY.test(packId)) {
      fail(label, 'has an unapproved packId');
    }
    if (!signablePackIds().has(packId)) {
      fail(label, 'has a packId no approved signing key can verify');
    }
    if (ownPackIds.has(packId)) fail(label, 'must not repeat a packId within one product');
    ownPackIds.add(packId);
  }
  for (const identity of [
    `entitlement ${product.entitlementId}`,
    `apple ${product.appleProductId}`,
    `google ${product.googleProductId}`,
  ]) {
    if (claimed.has(identity)) fail(label, 'must not claim an identity twice');
    claimed.add(identity);
  }
  return product;
}

export function assertStoreProductCatalogue(value) {
  const label = 'Store product catalogue';
  assertClosedRecord(value, STORE_CATALOGUE_KEYS, label);
  if (value.schemaVersion !== 1) {
    fail(label, 'must declare the approved schema V1 shape');
  }
  const products = readOpenArray(value.products, label);
  if (products.length === 0) fail(label, 'must contain at least one product');
  const claimed = new Set();
  for (const product of products) assertApprovedProduct(product, claimed, label);
  return value;
}

export function listStoreProducts() {
  assertStoreProductCatalogue(storeProductCatalogue);
  return Object.freeze(storeProductCatalogue.products.map((product) => Object.freeze({
    ...product,
    packIds: Object.freeze([...product.packIds]),
  })));
}

export function findStoreProductByEntitlementId(entitlementId) {
  const label = 'Store product entitlement';
  if (typeof entitlementId !== 'string') fail(label, 'must be an identifier');
  const product = listStoreProducts()
    .find((candidate) => candidate.entitlementId === entitlementId) ?? null;
  if (!product) fail(label, 'is not approved');
  return product;
}

export function mapStoreProductToEntitlement(value) {
  const label = 'Store product mapping';
  assertClosedRecord(value, ['store', 'productId'], label);
  const field = { apple: 'appleProductId', google: 'googleProductId' }[value.store];
  const product = KNOWN_STORE_FIELDS.includes(field)
    ? listStoreProducts().find((candidate) => candidate[field] === value.productId) ?? null
    : null;
  if (!product) fail(label, 'is not approved');
  return product.entitlementId;
}

export function assertPackKeyring(value) {
  const label = 'Pack keyring';
  assertClosedRecord(value, KEYRING_KEYS, label);
  if (value.schemaVersion !== 1) {
    fail(label, 'must contain the one approved schema V1 key');
  }
  const keys = readOpenArray(value.keys, label);
  if (keys.length !== 2) {
    fail(label, 'must contain exactly two signing keys (sandbox and production)');
  }
  assertExactRecord(keys[0], expectedSandboxSigningKey(), SIGNING_KEY_KEYS, label);
  assertExactRecord(keys[1], EXPECTED_PRODUCTION_SIGNING_KEY, SIGNING_KEY_KEYS, label);
  return value;
}

export function assertProductionPackKeyring(value) {
  const label = 'Production pack keyring';
  assertClosedRecord(value, KEYRING_KEYS, label);
  if (value.schemaVersion !== 1) {
    fail(label, 'must contain the approved schema V1 production key');
  }
  const keys = readOpenArray(value.keys, label);
  if (keys.length !== 1) {
    fail(label, 'must contain exactly one production signing key');
  }
  assertExactRecord(keys[0], EXPECTED_PRODUCTION_SIGNING_KEY, SIGNING_KEY_KEYS, label);
  return value;
}

export function assertB3ProofPack(value) {
  const label = 'B3 proof pack';
  assertClosedRecord(value, PROOF_PACK_KEYS, label);
  const expected = {
    schemaVersion: 1,
    packId: 'b3-sandbox-proof',
    version: '1.0.0-b3.1',
    requiredEntitlementId: 'full-ks2',
    archiveName: 'b3-sandbox-proof.zip',
    signingKeyId: 'b3-test-p256-2026-07',
    signatureDerSha256: 'a29963a93137589dd46ddb18684d1a6c30851f86a39e17cf830276a8ff430bc5',
    signedEnvelopeSha256: '39b6a788a3686d7cbf1fd4791bce45623af21ef53c60eabc03d955395856218a',
    allowedExtensions: ['.json', '.m4a'],
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (Array.isArray(expectedValue)) {
      assertExactArray(value[key], expectedValue, label);
    } else if (value[key] !== expectedValue) {
      fail(label, `has an unapproved ${key}`);
    }
  }
  assertClosedRecord(value.ceilings, PROOF_PACK_CEILING_KEYS, label);
  const expectedCeilings = {
    fileCount: 16,
    compressedBytes: 1_048_576,
    extractedBytes: 4_194_304,
  };
  for (const [key, expectedValue] of Object.entries(expectedCeilings)) {
    if (value.ceilings[key] !== expectedValue) {
      fail(label, `has an unapproved ${key} ceiling`);
    }
  }
  return value;
}

export function assertB3GatewayAuthority(value) {
  const label = 'B3 gateway authority';
  assertClosedRecord(value, GATEWAY_AUTHORITY_KEYS, label);
  const expected = {
    schemaVersion: 1,
    environment: 'sandbox',
    cloudflareAccountId: '6d00cb4a0396c17ad6ba617bcbcaa45d',
    workerName: 'ks2-spelling-b3-sandbox',
    privateR2BucketName: 'ks2-spelling-b3-sandbox-packs',
    publicSandboxOrigin: ['https:', '', 'b3-gateway.eugnel.uk'].join('/'),
    allowedOrigins: EXPECTED_ALLOWED_ORIGINS,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (Array.isArray(expectedValue)) {
      assertExactArray(value[key], expectedValue, label);
    } else if (value[key] !== expectedValue) {
      fail(label, `has an unapproved ${key}`);
    }
  }
  assertExactRecord(
    value.distribution,
    {
      applicationId: 'uk.eugnel.ks2spelling',
      iosKind: 'development',
      androidTrack: 'internal',
    },
    DISTRIBUTION_KEYS,
    label,
  );

  const publicOrigin = new URL(value.publicSandboxOrigin);
  if (
    publicOrigin.protocol !== 'https:' ||
    publicOrigin.username ||
    publicOrigin.password ||
    publicOrigin.port ||
    publicOrigin.pathname !== '/' ||
    publicOrigin.search ||
    publicOrigin.hash ||
    publicOrigin.origin !== value.publicSandboxOrigin
  ) {
    fail(label, 'must use the exact credential-free HTTPS origin');
  }
  return value;
}

export function assertGatewayAuthority(value) {
  return value?.environment === 'production'
    ? assertProductionGatewayAuthority(value)
    : assertB3GatewayAuthority(value);
}

export function assertProductionGatewayAuthority(value) {
  const label = 'Production gateway authority';
  assertClosedRecord(value, GATEWAY_AUTHORITY_KEYS, label);
  const expected = {
    schemaVersion: 1,
    environment: 'production',
    cloudflareAccountId: '6d00cb4a0396c17ad6ba617bcbcaa45d',
    workerName: 'ks2-spelling-production',
    privateR2BucketName: 'ks2-spelling-production-packs',
    publicSandboxOrigin: EXPECTED_PUBLIC_PRODUCTION_ORIGIN,
    allowedOrigins: EXPECTED_ALLOWED_ORIGINS,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (Array.isArray(expectedValue)) {
      assertExactArray(value[key], expectedValue, label);
    } else if (value[key] !== expectedValue) {
      fail(label, `has an unapproved ${key}`);
    }
  }
  assertExactRecord(
    value.distribution,
    {
      applicationId: 'uk.eugnel.ks2spelling',
      iosKind: 'release',
      androidTrack: 'production',
    },
    DISTRIBUTION_KEYS,
    label,
  );

  const publicOrigin = new URL(value.publicSandboxOrigin);
  if (
    publicOrigin.protocol !== 'https:' ||
    publicOrigin.username ||
    publicOrigin.password ||
    publicOrigin.port ||
    publicOrigin.pathname !== '/' ||
    publicOrigin.search ||
    publicOrigin.hash ||
    publicOrigin.origin !== value.publicSandboxOrigin
  ) {
    fail(label, 'must use the exact credential-free HTTPS origin');
  }
  return value;
}
