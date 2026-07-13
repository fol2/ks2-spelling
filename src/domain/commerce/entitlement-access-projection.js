const ENTITLEMENT_KEYS = Object.freeze([
  'entitlementId',
  'store',
  'productId',
  'state',
  'sealedRefreshHandle',
  'refreshHandleVersion',
  'verifiedAt',
  'refreshedAt',
  'revocationAt',
]);
const IDENTIFIER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PRODUCT_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

function requireExactArray(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError('Entitlements must be an ordinary array.');
  }
  const keys = Reflect.ownKeys(value);
  const expected = [...Array.from({ length: value.length }, (_, index) => String(index)), 'length'];
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new TypeError('Entitlements array must not expose extra properties.');
  }
  return value;
}

function readExactRecord(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError('Entitlement must be an ordinary record.');
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== ENTITLEMENT_KEYS.length ||
    keys.some((key) => typeof key !== 'string' || !ENTITLEMENT_KEYS.includes(key))
  ) {
    throw new TypeError('Entitlement record has an invalid shape.');
  }
  const result = Object.create(null);
  for (const key of ENTITLEMENT_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, 'value') ||
      !descriptor.enumerable
    ) {
      throw new TypeError('Entitlement fields must be enumerable own data properties.');
    }
    result[key] = descriptor.value;
  }
  return result;
}

function requireTimestamp(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a safe non-negative integer.`);
  }
  return value;
}

function validateEntitlement(value) {
  const row = readExactRecord(value);
  if (!IDENTIFIER.test(row.entitlementId)) {
    throw new TypeError('entitlementId must be a canonical identifier.');
  }
  if (!['apple', 'google'].includes(row.store) || !PRODUCT_ID.test(row.productId)) {
    throw new TypeError('Entitlement store or product is invalid.');
  }
  if (!['active', 'revoked'].includes(row.state)) {
    throw new TypeError('Entitlement state is invalid.');
  }
  const handleIsNull = row.sealedRefreshHandle === null;
  const versionIsNull = row.refreshHandleVersion === null;
  if (
    handleIsNull !== versionIsNull ||
    (!handleIsNull &&
      (typeof row.sealedRefreshHandle !== 'string' ||
        row.sealedRefreshHandle.length === 0 ||
        !Number.isSafeInteger(row.refreshHandleVersion) ||
        row.refreshHandleVersion <= 0))
  ) {
    throw new TypeError('Entitlement refresh handle tuple is invalid.');
  }
  requireTimestamp(row.verifiedAt, 'verifiedAt');
  requireTimestamp(row.refreshedAt, 'refreshedAt');
  requireTimestamp(row.revocationAt, 'revocationAt', { nullable: true });
  if (row.refreshedAt < row.verifiedAt) {
    throw new TypeError('refreshedAt must not predate verifiedAt.');
  }
  if (
    (row.state === 'active' && row.revocationAt !== null) ||
    (row.state === 'revoked' &&
      (row.revocationAt === null || !handleIsNull))
  ) {
    throw new TypeError('Entitlement lifecycle fields are inconsistent.');
  }
  return row;
}

function createReadonlySet(values) {
  const backing = new Set(values);
  let facade;
  facade = Object.create(null);
  Object.defineProperties(facade, {
    size: { enumerable: true, value: backing.size },
    has: { enumerable: true, value: (value) => backing.has(value) },
    values: { enumerable: true, value: () => backing.values() },
    keys: { enumerable: true, value: () => backing.keys() },
    entries: { enumerable: true, value: () => backing.entries() },
    forEach: {
      enumerable: true,
      value(callback, thisArg) {
        if (typeof callback !== 'function') {
          throw new TypeError('ReadonlySet forEach callback must be a function.');
        }
        backing.forEach((value) => callback.call(thisArg, value, value, facade));
      },
    },
    [Symbol.iterator]: { enumerable: true, value: () => backing.values() },
  });
  return Object.freeze(facade);
}

export function projectActiveEntitlements(rows) {
  requireExactArray(rows);
  const seen = new Set();
  const active = [];
  for (let index = 0; index < rows.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(rows, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw new TypeError('Entitlements array entries must be enumerable data properties.');
    }
    const row = validateEntitlement(descriptor.value);
    if (seen.has(row.entitlementId)) {
      throw new TypeError(`Duplicate entitlement authority: ${row.entitlementId}.`);
    }
    seen.add(row.entitlementId);
    if (row.state === 'active') active.push(row.entitlementId);
  }
  active.sort();
  return createReadonlySet(active);
}
