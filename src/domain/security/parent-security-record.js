import {
  validateParentPinCredential,
} from './parent-pin-contract.js';

const RECORD_KEYS = Object.freeze([
  'schemaVersion',
  'algorithm',
  'iterations',
  'saltBase64',
  'verifierBase64',
  'failedAttempts',
  'lockedUntil',
  'biometricEnabled',
  'updatedAt',
]);

function recordError(message = 'Parent security record is invalid.') {
  const error = new TypeError(message);
  error.code = 'parent_security_record_invalid';
  return error;
}

function requireSafeNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw recordError(`Parent security ${label} is invalid.`);
  }
  return value;
}

export function validateParentSecurityRecord(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== RECORD_KEYS.length ||
    RECORD_KEYS.some((key) => !Object.hasOwn(value, key)) ||
    value.schemaVersion !== 1 ||
    typeof value.biometricEnabled !== 'boolean'
  ) {
    throw recordError();
  }
  const credential = validateParentPinCredential({
    algorithm: value.algorithm,
    iterations: value.iterations,
    saltBase64: value.saltBase64,
    verifierBase64: value.verifierBase64,
  });
  const failedAttempts = requireSafeNonNegativeInteger(
    value.failedAttempts,
    'failed attempts',
  );
  if (failedAttempts > 5) {
    throw recordError('Parent security failed attempts exceed the limit.');
  }
  const lockedUntil = requireSafeNonNegativeInteger(
    value.lockedUntil,
    'lock time',
  );
  const updatedAt = requireSafeNonNegativeInteger(
    value.updatedAt,
    'updated time',
  );
  return Object.freeze({
    schemaVersion: 1,
    ...credential,
    failedAttempts,
    lockedUntil,
    biometricEnabled: value.biometricEnabled,
    updatedAt,
  });
}
