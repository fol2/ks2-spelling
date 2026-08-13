import { listStoreProducts } from '../../src/domain/commerce/commerce-contracts.js';
import {
  MAX_GATEWAY_BODY_BYTES,
  MAX_OPAQUE_PROOF_CHARS,
  MAX_SEALED_REFRESH_HANDLE_CHARS,
  OPAQUE_PROOF_PATTERN,
  gatewayJsonByteLength,
} from '../../src/platform/gateway/gateway-payload-limits.js';

const VERIFY_KEYS = Object.freeze(['store', 'environment', 'productId', 'opaqueProof']);
const HANDLE_KEYS = Object.freeze(['sealedRefreshHandle']);
const APPLICATION_ID = 'uk.eugnel.ks2spelling';

// The store product catalogue read through the domain contracts is the only
// product/entitlement authority: the gateway accepts exactly the (store,
// productId) pairs the app can sell, and nothing else.
export function deriveStoreProductAuthorities(products) {
  return Object.freeze({
    apple: new Map(products.map((product) => [product.appleProductId, product.entitlementId])),
    google: new Map(products.map((product) => [product.googleProductId, product.entitlementId])),
  });
}

const PRODUCTS_BY_STORE = deriveStoreProductAuthorities(listStoreProducts());

export class GatewayError extends Error {
  constructor(code, status, retryable) {
    super(code === 'HANDLE_INVALID'
      ? 'The refresh handle is invalid.'
      : code === 'REQUEST_INVALID'
        ? 'The gateway request is invalid.'
        : 'The entitlement gateway request failed.');
    Object.defineProperty(this, 'name', { value: 'GatewayError' });
    Object.defineProperties(this, {
      code: { value: code, enumerable: true },
      status: { value: status, enumerable: true },
      retryable: { value: retryable, enumerable: true },
    });
  }
}

export function safeGatewayError(code = 'GATEWAY_UNAVAILABLE') {
  const definitions = {
    PROOF_REJECTED: [400, false],
    PRODUCT_MISMATCH: [400, false],
    STORE_TRANSACTION_ID_INVALID: [400, false],
    HANDLE_INVALID: [400, false],
    ENTITLEMENT_REVOKED: [403, false],
    REQUEST_INVALID: [400, false],
    RATE_LIMITED: [429, true],
    STORE_UNAVAILABLE: [503, true],
    GATEWAY_UNAVAILABLE: [503, true],
  };
  const [status, retryable] = definitions[code] ?? definitions.GATEWAY_UNAVAILABLE;
  return new GatewayError(code in definitions ? code : 'GATEWAY_UNAVAILABLE', status, retryable);
}

function assertClosedObject(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw safeGatewayError('REQUEST_INVALID');
  }
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    throw safeGatewayError('REQUEST_INVALID');
  }
  return value;
}

function assertString(value, { min = 1, max = MAX_GATEWAY_BODY_BYTES, pattern } = {}) {
  if (
    typeof value !== 'string' || value.length < min || value.length > max ||
    (pattern && !pattern.test(value))
  ) {
    throw safeGatewayError('REQUEST_INVALID');
  }
  return value;
}

export function approvedProductIds(store) {
  const products = PRODUCTS_BY_STORE[store];
  if (!products) throw safeGatewayError('REQUEST_INVALID');
  return Object.freeze([...products.keys()]);
}

export function entitlementAuthority(store, productId) {
  const products = PRODUCTS_BY_STORE[store];
  if (!products) throw safeGatewayError('REQUEST_INVALID');
  const entitlementId = products.get(productId);
  if (entitlementId === undefined) throw safeGatewayError('PRODUCT_MISMATCH');
  return entitlementId;
}

export function assertVerifyRequest(value) {
  assertClosedObject(value, VERIFY_KEYS);
  if (value.environment !== 'sandbox') throw safeGatewayError('REQUEST_INVALID');
  entitlementAuthority(value.store, value.productId);
  return Object.freeze({
    store: value.store,
    environment: 'sandbox',
    productId: value.productId,
    opaqueProof: assertString(value.opaqueProof, {
      max: MAX_OPAQUE_PROOF_CHARS,
      pattern: OPAQUE_PROOF_PATTERN,
    }),
  });
}

export function assertHandleRequest(value) {
  assertClosedObject(value, HANDLE_KEYS);
  const sealedRefreshHandle = assertString(value.sealedRefreshHandle, {
    max: MAX_SEALED_REFRESH_HANDLE_CHARS,
  });
  if (gatewayJsonByteLength({ sealedRefreshHandle }) > MAX_GATEWAY_BODY_BYTES) {
    throw safeGatewayError('REQUEST_INVALID');
  }
  return Object.freeze({ sealedRefreshHandle });
}

export function assertStoreResult(value, expected) {
  const keys = [
    'store', 'productId', 'environment', 'applicationId', 'entitlementId',
    'state', 'storeTransactionId', 'opaqueProof',
  ];
  const optionalAcknowledged = Object.hasOwn(value ?? {}, 'acknowledged');
  assertClosedObject(value, optionalAcknowledged ? [...keys, 'acknowledged'] : keys);
  const entitlementId = entitlementAuthority(value.store, value.productId);
  if (
    value.store !== expected.store || value.productId !== expected.productId ||
    value.environment !== 'sandbox' || value.applicationId !== APPLICATION_ID ||
    value.entitlementId !== entitlementId
  ) throw safeGatewayError('PRODUCT_MISMATCH');
  if (!['active', 'revoked', 'pending', 'cancelled'].includes(value.state)) {
    throw safeGatewayError('PROOF_REJECTED');
  }
  const safeId = value.store === 'apple'
    ? /^[1-9][0-9]{0,31}$/
    : /^GPA\.[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{5}$/;
  const ownsDurableTransactionAuthority = value.state === 'active' || value.state === 'revoked';
  if (
    (ownsDurableTransactionAuthority &&
      (typeof value.storeTransactionId !== 'string' || !safeId.test(value.storeTransactionId))) ||
    (!ownsDurableTransactionAuthority && value.storeTransactionId !== null)
  ) {
    throw safeGatewayError('STORE_TRANSACTION_ID_INVALID');
  }
  if (
    typeof value.opaqueProof !== 'string' || value.opaqueProof.length === 0 ||
    value.opaqueProof.length > MAX_OPAQUE_PROOF_CHARS || !OPAQUE_PROOF_PATTERN.test(value.opaqueProof)
  ) {
    throw safeGatewayError('PROOF_REJECTED');
  }
  if (optionalAcknowledged && typeof value.acknowledged !== 'boolean') {
    throw safeGatewayError('PROOF_REJECTED');
  }
  return Object.freeze({ ...value });
}

export function assertExactStoreVerifier(value) {
  if (value === null || typeof value !== 'object') throw safeGatewayError();
  const keys = Reflect.ownKeys(value).sort();
  if (keys.join('\n') !== ['complete', 'refresh', 'verify'].sort().join('\n')) throw safeGatewayError();
  for (const method of keys) if (typeof value[method] !== 'function') throw safeGatewayError();
  return value;
}

export function applicationAuthority() {
  return APPLICATION_ID;
}
