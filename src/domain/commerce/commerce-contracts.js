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
const EXPECTED_PUBLIC_SANDBOX_ORIGIN = Object.freeze(
  ['https:', '', 'b3-gateway.eugnel.uk'].join('/'),
);
const EXPECTED_ALLOWED_ORIGINS = Object.freeze([
  ['capacitor:', '', 'localhost'].join('/'),
  ['http:', '', 'localhost'].join('/'),
]);

const EXPECTED_PRODUCT = Object.freeze({
  entitlementId: 'full-ks2',
  type: 'non-consumable',
  appleProductId: 'uk.eugnel.ks2spelling.fullks2',
  googleProductId: 'full_ks2',
  packIds: Object.freeze(['b3-sandbox-proof']),
});

const EXPECTED_SIGNING_KEY = Object.freeze({
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
  allowedPackIds: Object.freeze(['b3-sandbox-proof']),
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

export function assertStoreProductCatalogue(value) {
  const label = 'Store product catalogue';
  assertClosedRecord(value, STORE_CATALOGUE_KEYS, label);
  if (value.schemaVersion !== 1) {
    fail(label, 'must contain the one approved schema V1 product');
  }
  const [product] = readClosedArray(value.products, 1, label);
  assertExactRecord(product, EXPECTED_PRODUCT, PRODUCT_KEYS, label);
  return value;
}

export function mapStoreProductToEntitlement(value) {
  const label = 'Store product mapping';
  assertClosedRecord(value, ['store', 'productId'], label);
  assertStoreProductCatalogue(storeProductCatalogue);
  const product = storeProductCatalogue.products[0];
  const expectedProductId = {
    apple: product.appleProductId,
    google: product.googleProductId,
  }[value.store];
  if (typeof expectedProductId !== 'string' || value.productId !== expectedProductId) {
    fail(label, 'is not approved');
  }
  return product.entitlementId;
}

export function assertPackKeyring(value) {
  const label = 'Pack keyring';
  assertClosedRecord(value, KEYRING_KEYS, label);
  if (value.schemaVersion !== 1) {
    fail(label, 'must contain the one approved schema V1 key');
  }
  const [key] = readClosedArray(value.keys, 1, label);
  assertExactRecord(key, EXPECTED_SIGNING_KEY, SIGNING_KEY_KEYS, label);
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
    publicSandboxOrigin: EXPECTED_PUBLIC_SANDBOX_ORIGIN,
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
