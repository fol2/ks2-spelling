const PIN_PATTERN = /^[0-9]{6}$/u;
const WEAK_SEQUENCES = new Set([
  '012345',
  '123456',
  '234567',
  '345678',
  '456789',
  '987654',
  '876543',
  '765432',
  '654321',
  '543210',
]);
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export const PARENT_PIN_ITERATIONS = 210_000;

function pinError(code) {
  const error = new TypeError(code);
  error.code = code;
  return error;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return globalThis.btoa(binary);
}

function base64ToBytes(value, expectedLength, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !BASE64.test(value)
  ) {
    throw pinError(`${label}_invalid`);
  }
  let binary;
  try {
    binary = globalThis.atob(value);
  } catch {
    throw pinError(`${label}_invalid`);
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (
    bytes.length !== expectedLength ||
    bytesToBase64(bytes) !== value
  ) {
    throw pinError(`${label}_invalid`);
  }
  return bytes;
}

function requireCredential(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 4 ||
    !Object.hasOwn(value, 'algorithm') ||
    !Object.hasOwn(value, 'iterations') ||
    !Object.hasOwn(value, 'saltBase64') ||
    !Object.hasOwn(value, 'verifierBase64') ||
    value.algorithm !== 'PBKDF2-SHA-256' ||
    value.iterations !== PARENT_PIN_ITERATIONS
  ) {
    throw pinError('parent_pin_credential_invalid');
  }
  return Object.freeze({
    algorithm: value.algorithm,
    iterations: value.iterations,
    saltBase64: bytesToBase64(
      base64ToBytes(value.saltBase64, 16, 'parent_pin_salt'),
    ),
    verifierBase64: bytesToBase64(
      base64ToBytes(value.verifierBase64, 32, 'parent_pin_verifier'),
    ),
  });
}

async function derive({ crypto, pin, salt, iterations }) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt,
    iterations,
  }, key, 256);
  return new Uint8Array(bits);
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export function validateParentPin(value) {
  if (
    typeof value !== 'string' ||
    !PIN_PATTERN.test(value) ||
    /^(.)\1{5}$/u.test(value) ||
    WEAK_SEQUENCES.has(value)
  ) {
    throw pinError('Parent PIN must be six non-trivial digits.');
  }
  return value;
}

export function validateParentPinCredential(value) {
  return requireCredential(value);
}

export function createParentPinCrypto({
  crypto = globalThis.crypto,
  randomBytes,
} = {}) {
  if (
    !crypto ||
    typeof crypto !== 'object' ||
    typeof crypto.subtle?.importKey !== 'function' ||
    typeof crypto.subtle?.deriveBits !== 'function'
  ) {
    throw new TypeError('Parent PIN requires Web Crypto PBKDF2.');
  }
  const createRandomBytes = randomBytes ?? ((length) => {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
  });
  if (typeof createRandomBytes !== 'function') {
    throw new TypeError('Parent PIN random byte source must be a function.');
  }

  return Object.freeze({
    async create(candidate) {
      const pin = validateParentPin(candidate);
      const salt = createRandomBytes(16);
      if (
        !(salt instanceof Uint8Array) ||
        salt.length !== 16
      ) {
        throw new TypeError('Parent PIN salt must contain exactly 16 bytes.');
      }
      const verifier = await derive({
        crypto,
        pin,
        salt,
        iterations: PARENT_PIN_ITERATIONS,
      });
      return Object.freeze({
        algorithm: 'PBKDF2-SHA-256',
        iterations: PARENT_PIN_ITERATIONS,
        saltBase64: bytesToBase64(salt),
        verifierBase64: bytesToBase64(verifier),
      });
    },
    async verify(candidate, value) {
      const pin = validateParentPin(candidate);
      const credential = requireCredential(value);
      const salt = base64ToBytes(
        credential.saltBase64,
        16,
        'parent_pin_salt',
      );
      const expected = base64ToBytes(
        credential.verifierBase64,
        32,
        'parent_pin_verifier',
      );
      const actual = await derive({
        crypto,
        pin,
        salt,
        iterations: credential.iterations,
      });
      return constantTimeEqual(actual, expected);
    },
  });
}
