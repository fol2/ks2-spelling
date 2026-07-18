import {
  decodeCanonicalBase64,
  PACK_SIGNING_ALGORITHM,
} from './signed-manifest-contract.js';
import { assertPackKeyring } from '../commerce/commerce-contracts.js';

const P256_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02,
  0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03,
  0x42, 0x00, 0x04,
]);

function fail(detail) {
  throw new TypeError(`Pack verification key ${detail}.`);
}

function readClock(clock) {
  if (typeof clock !== 'function') fail('selection requires an injected clock');
  const value = clock();
  const milliseconds = value instanceof Date ? value.getTime() : Number.NaN;
  if (!Number.isFinite(milliseconds)) fail('selection clock returned an invalid date');
  return milliseconds;
}

export function parsePackKeyValidityBoundary(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    fail(`${label} must be a UTC timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail(`${label} must be a valid UTC timestamp`);
  const canonical = new Date(milliseconds).toISOString();
  const expectedCanonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  if (canonical !== expectedCanonical) {
    fail(`${label} must be an exact canonical UTC calendar timestamp`);
  }
  return milliseconds;
}

function assertStringArray(value, label) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length === 0 ||
    value.some((item) => typeof item !== 'string' || item.length === 0)
  ) {
    fail(`${label} must be a non-empty string array`);
  }
}

function assertP256SpkiDer(bytes) {
  if (
    bytes.length !== P256_SPKI_PREFIX.length + 64 ||
    P256_SPKI_PREFIX.some((byte, index) => bytes[index] !== byte)
  ) {
    fail('public key must be canonical P-256 SPKI DER');
  }
}

function selectCandidate({ keyring, keyId, environment, clock }) {
  assertPackKeyring(keyring);
  if (typeof keyId !== 'string' || keyId.length === 0) fail('keyId is required');
  if (typeof environment !== 'string' || environment.length === 0) {
    fail('environment is required');
  }
  const matches = keyring.keys.filter((key) => key?.keyId === keyId);
  if (matches.length !== 1) fail('selection requires exactly one known keyId');
  const key = matches[0];
  if (key.algorithm !== PACK_SIGNING_ALGORITHM) fail('algorithm is not approved');
  assertStringArray(key.allowedEnvironments, 'allowed environments');
  assertStringArray(key.allowedPackIds, 'allowed pack IDs');
  if (!key.allowedEnvironments.includes(environment)) {
    fail('is not approved for this environment');
  }
  if (environment === 'production' && key.testOnly === true) {
    fail('test-only key is not approved for the production environment');
  }
  const now = readClock(clock);
  const notBefore = parsePackKeyValidityBoundary(key.notBefore, 'notBefore');
  const notAfter = parsePackKeyValidityBoundary(key.notAfter, 'notAfter');
  if (notBefore > notAfter) fail('validity window is inverted');
  if (now < notBefore) fail('is outside its validity window and not yet valid');
  if (now > notAfter) fail('is outside its validity window and has expired');
  const publicKeySpkiDer = decodeCanonicalBase64(
    key.publicKeySpkiDerBase64,
    'public key SPKI DER base64',
  );
  assertP256SpkiDer(publicKeySpkiDer);
  return Object.freeze({ ...key, publicKeySpkiDer });
}

export function selectPackVerificationKeyCandidate(input) {
  return selectCandidate(input);
}

export function selectPackVerificationKey(input) {
  const selected = selectCandidate(input);
  if (typeof input.packId !== 'string' || !selected.allowedPackIds.includes(input.packId)) {
    fail('is not approved for this pack');
  }
  return selected;
}
