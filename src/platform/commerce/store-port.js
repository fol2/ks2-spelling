export const STORE_METHODS = Object.freeze([
  'queryProducts',
  'purchase',
  'queryTransactions',
  'restore',
  'finishTransaction',
  'subscribeTransactionUpdates',
]);

const PRODUCT_KEYS = Object.freeze([
  'productId',
  'displayName',
  'description',
  'displayPrice',
  'currencyCode',
]);
const OBSERVATION_BASE_KEYS = Object.freeze([
  'store',
  'environment',
  'productId',
  'outcome',
  'transactionRef',
]);
const PROOF_OUTCOMES = new Set(['purchased', 'revoked']);
const OUTCOMES = new Set([
  'cancelled',
  'pending',
  'purchased',
  'revoked',
  'unverified',
]);

export function fail(label, detail = 'is invalid') {
  throw new TypeError(`${label} ${detail}.`);
}

export function assertClosedRecord(value, keys, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    fail(label, 'must be a closed plain record');
  }
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    fail(label, 'must contain exactly the approved fields');
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail(label, 'must contain only own enumerable data fields');
    }
  }
  return value;
}

export function assertClosedArray(value, label, { min = 0, max = 64 } = {}) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(label, 'must be a closed array');
  }
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (!Number.isSafeInteger(length) || length < min || length > max) {
    fail(label, 'has an invalid length');
  }
  const expected = [
    ...Array.from({ length }, (_, index) => String(index)),
    'length',
  ];
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== expected.length ||
    actual.some((key) => typeof key !== 'string' || !expected.includes(key))
  ) {
    fail(label, 'must not contain holes or additional fields');
  }
  const output = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail(label, 'must contain only own enumerable data entries');
    }
    output.push(descriptor.value);
  }
  return output;
}

export function assertString(value, label, {
  min = 1,
  max = 256,
  pattern,
} = {}) {
  if (
    typeof value !== 'string' ||
    value.length < min ||
    value.length > max ||
    value.includes('\u0000') ||
    (pattern && !pattern.test(value))
  ) {
    fail(label);
  }
  return value;
}

export function assertSafeInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(label);
  return value;
}

export function cloneFrozenRecord(record, keys) {
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, record[key]])));
}

export function cloneClosedData(value, label = 'Scripted value', depth = 0) {
  if (depth > 12) fail(label, 'is nested too deeply');
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return assertClosedArray(value, label, { max: 128 }).map((entry) =>
      cloneClosedData(entry, label, depth + 1));
  }
  if (
    !value || typeof value !== 'object' ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    fail(label, 'must contain plain data only');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > 64 || keys.some((key) => typeof key !== 'string')) {
    fail(label, 'contains unsafe fields');
  }
  const output = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail(label, 'must contain data fields only');
    }
    output[key] = cloneClosedData(descriptor.value, label, depth + 1);
  }
  return output;
}

export function cloneFrozenArray(values, mapper = (value) => value) {
  return Object.freeze(values.map(mapper));
}

export function assertPromise(value, label) {
  if (!(value instanceof Promise)) fail(label, 'must return a Promise');
  return value;
}

export function assertExactPort(value, methods, label) {
  assertClosedRecord(value, methods, label);
  for (const method of methods) {
    if (typeof value[method] !== 'function') fail(label, `${method} must be a function`);
  }
  return value;
}

export function assertProductId(value, label = 'Product identifier') {
  return assertString(value, label, {
    max: 128,
    pattern: /^(?:[a-z][a-z0-9]*(?:[._][a-z0-9]+)+|[a-z][a-z0-9_]*)$/,
  });
}

export function assertApprovedProductId(value, label = 'Product identifier') {
  const productId = assertProductId(value, label);
  if (
    productId !== 'uk.eugnel.ks2spelling.fullks2' &&
    productId !== 'full_ks2'
  ) {
    fail(label, 'is not an approved B3 product');
  }
  return productId;
}

export function validateProductIdsRequest(value) {
  assertClosedRecord(value, ['productIds'], 'Store product request');
  const productIds = assertClosedArray(value.productIds, 'Store product identifiers', {
    min: 1,
    max: 16,
  });
  const seen = new Set();
  for (const productId of productIds) {
    assertApprovedProductId(productId);
    if (seen.has(productId)) fail('Store product identifiers', 'must be unique');
    seen.add(productId);
  }
  return Object.freeze({ productIds: Object.freeze([...productIds]) });
}

export function validateProductRequest(value) {
  assertClosedRecord(value, ['productId'], 'Store purchase request');
  return Object.freeze({ productId: assertApprovedProductId(value.productId) });
}

export function validateFinishRequest(value) {
  assertClosedRecord(value, ['transactionRef'], 'Store finish request');
  return Object.freeze({
    transactionRef: assertString(value.transactionRef, 'Native transaction reference', {
      max: 4_096,
    }),
  });
}

export function validateProduct(value) {
  assertClosedRecord(value, PRODUCT_KEYS, 'Store product result');
  const output = {
    productId: assertProductId(value.productId),
    displayName: assertString(value.displayName, 'Product display name', { max: 256 }),
    description: assertString(value.description, 'Product description', { max: 1_024 }),
    displayPrice: assertString(value.displayPrice, 'Product display price', { max: 64 }),
    currencyCode: assertString(value.currencyCode, 'Product currency code', {
      min: 3,
      max: 3,
      pattern: /^[A-Z]{3}$/,
    }),
  };
  return Object.freeze(output);
}

export function validateObservation(value) {
  const outcomeDescriptor =
    value && typeof value === 'object'
      ? Object.getOwnPropertyDescriptor(value, 'outcome')
      : undefined;
  const outcome = outcomeDescriptor && Object.hasOwn(outcomeDescriptor, 'value')
    ? outcomeDescriptor.value
    : undefined;
  const base = assertClosedRecord(
    value,
    PROOF_OUTCOMES.has(outcome)
      ? [...OBSERVATION_BASE_KEYS, 'opaqueProof']
      : OBSERVATION_BASE_KEYS,
    'Store transaction observation',
  );
  if (!OUTCOMES.has(outcome)) fail('Store transaction outcome');
  if (base.store !== 'apple' && base.store !== 'google') fail('Store transaction store');
  if (base.environment !== 'sandbox') fail('Store transaction environment');
  const productId = assertProductId(base.productId);
  if (
    (base.store === 'apple' && productId !== 'uk.eugnel.ks2spelling.fullks2') ||
    (base.store === 'google' && productId !== 'full_ks2')
  ) {
    fail('Store transaction product identity');
  }
  const output = {
    store: base.store,
    environment: base.environment,
    productId,
    outcome,
    transactionRef: assertString(
      base.transactionRef,
      'Native transaction reference',
      { max: 4_096 },
    ),
  };
  if (PROOF_OUTCOMES.has(outcome)) {
    output.opaqueProof = assertString(base.opaqueProof, 'Opaque store proof', {
      max: 65_536,
    });
  }
  return Object.freeze(output);
}

export function validateFinishResult(value) {
  assertClosedRecord(value, ['completion'], 'Store finish result');
  if (value.completion !== 'finished' && value.completion !== 'pending') {
    fail('Store finish completion');
  }
  return Object.freeze({ completion: value.completion });
}

export function assertStorePort(value) {
  return assertExactPort(value, STORE_METHODS, 'StorePort');
}
