import { safeGatewayError } from './store-verifier-port.js';
import {
  MAX_OPAQUE_PROOF_CHARS,
  MAX_REFRESH_HANDLE_VERSION,
  OPAQUE_PROOF_PATTERN,
} from '../../src/platform/gateway/gateway-payload-limits.js';

const FORMAT = 'b3rh1';
const PAYLOAD_KEYS = Object.freeze([
  'store', 'productId', 'environment', 'applicationId', 'storeTransactionId',
  'opaqueProof', 'issuedAt',
]);
const OPENED_KEYS = Object.freeze(['format', 'keyVersion', ...PAYLOAD_KEYS]);
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function fail() {
  throw safeGatewayError('HANDLE_INVALID');
}

function canonicalBase64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) fail();
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  let binary;
  try {
    binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + padding);
  } catch {
    fail();
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (canonicalBase64url(bytes) !== value) fail();
  return bytes;
}

function parseKeyRecord(value) {
  const match = /^v([1-9][0-9]*):([A-Za-z0-9_-]+)$/.exec(value ?? '');
  if (!match) fail();
  const version = Number(match[1]);
  if (
    !Number.isSafeInteger(version) || version > MAX_REFRESH_HANDLE_VERSION ||
    String(version) !== match[1]
  ) fail();
  const bytes = decodeBase64url(match[2]);
  if (bytes.byteLength !== 32) fail();
  return Object.freeze({ version, bytes });
}

export function parseRefreshHandleKeyring(value) {
  if (
    value === null || typeof value !== 'object' || Array.isArray(value) ||
    Reflect.ownKeys(value).sort().join('\n') !== ['current', 'previous'].sort().join('\n')
  ) fail();
  const current = parseKeyRecord(value.current);
  const previous = parseKeyRecord(value.previous);
  if (current.version === previous.version) fail();
  if (current.bytes.every((byte, index) => byte === previous.bytes[index])) fail();
  return Object.freeze({ current, previous });
}

function assertContext(value) {
  const keys = ['store', 'productId', 'environment', 'applicationId'];
  if (
    value === null || typeof value !== 'object' || Array.isArray(value) ||
    Reflect.ownKeys(value).sort().join('\n') !== keys.sort().join('\n') ||
    !['apple', 'google'].includes(value.store) || value.environment !== 'sandbox' ||
    value.applicationId !== 'uk.eugnel.ks2spelling' ||
    typeof value.productId !== 'string' || value.productId.length === 0
  ) fail();
  return value;
}

function assertPayload(value, opened = false) {
  const keys = opened ? OPENED_KEYS : PAYLOAD_KEYS;
  if (
    value === null || typeof value !== 'object' || Array.isArray(value) ||
    Reflect.ownKeys(value).sort().join('\n') !== [...keys].sort().join('\n')
  ) fail();
  assertContext({
    store: value.store,
    productId: value.productId,
    environment: value.environment,
    applicationId: value.applicationId,
  });
  const pattern = value.store === 'apple'
    ? /^[1-9][0-9]{0,31}$/
    : /^GPA\.[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{5}$/;
  if (
    typeof value.storeTransactionId !== 'string' || !pattern.test(value.storeTransactionId) ||
    typeof value.opaqueProof !== 'string' || value.opaqueProof.length === 0 ||
    value.opaqueProof.length > MAX_OPAQUE_PROOF_CHARS || !OPAQUE_PROOF_PATTERN.test(value.opaqueProof) ||
    !Number.isSafeInteger(value.issuedAt) || value.issuedAt < 0 ||
    (opened && (value.format !== FORMAT || !Number.isSafeInteger(value.keyVersion) || value.keyVersion < 1))
  ) fail();
  return value;
}

function aad(version, context) {
  return encoder.encode([
    FORMAT, String(version), context.store, context.productId,
    context.environment, context.applicationId,
  ].join('\n'));
}

async function cryptoKey(record) {
  return crypto.subtle.importKey('raw', record.bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

const defaultNonceRegistry = createNonceRegistry({ maxEntries: 16_384, maxAttempts: 8 });

export function createNonceRegistry({ maxEntries = 16_384, maxAttempts = 8 } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    fail();
  }
  const entries = new Set();
  return Object.freeze({
    reserve(randomBytes) {
      if (typeof randomBytes !== 'function') fail();
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const bytes = randomBytes(12);
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 12) fail();
        const encoded = canonicalBase64url(bytes);
        if (entries.has(encoded)) continue;
        entries.add(encoded);
        if (entries.size > maxEntries) entries.delete(entries.values().next().value);
        return Uint8Array.from(bytes);
      }
      fail();
    },
  });
}

export async function sealRefreshHandle(payload, options) {
  assertPayload(payload);
  const keyring = options?.keyring;
  if (!keyring?.current) fail();
  const randomBytes = options.randomBytes ?? ((length) => crypto.getRandomValues(new Uint8Array(length)));
  const nonce = (options.nonceRegistry ?? defaultNonceRegistry).reserve(randomBytes);
  const body = Object.freeze({ format: FORMAT, keyVersion: keyring.current.version, ...payload });
  const plaintext = encoder.encode(JSON.stringify(body));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad(keyring.current.version, payload), tagLength: 128 },
    await cryptoKey(keyring.current),
    plaintext,
  );
  return [FORMAT, keyring.current.version, canonicalBase64url(nonce), canonicalBase64url(new Uint8Array(ciphertext))].join('.');
}

export async function openRefreshHandle(handle, context, { keyring } = {}) {
  assertContext(context);
  const parts = typeof handle === 'string' ? handle.split('.') : [];
  if (parts.length !== 4 || parts[0] !== FORMAT || !/^[1-9][0-9]*$/.test(parts[1])) fail();
  const version = Number(parts[1]);
  if (!Number.isSafeInteger(version) || String(version) !== parts[1]) fail();
  const record = [keyring?.current, keyring?.previous].find((candidate) => candidate?.version === version);
  if (!record) fail();
  const nonce = decodeBase64url(parts[2]);
  const ciphertext = decodeBase64url(parts[3]);
  if (nonce.byteLength !== 12 || ciphertext.byteLength < 17) fail();
  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad(version, context), tagLength: 128 },
      await cryptoKey(record),
      ciphertext,
    );
  } catch {
    fail();
  }
  let payload;
  try {
    payload = JSON.parse(decoder.decode(plaintext));
  } catch {
    fail();
  }
  assertPayload(payload, true);
  if (payload.keyVersion !== version) fail();
  for (const key of ['store', 'productId', 'environment', 'applicationId']) {
    if (payload[key] !== context[key]) fail();
  }
  return Object.freeze(payload);
}

export async function resealRefreshHandle(handle, context, options) {
  const payload = await openRefreshHandle(handle, context, options);
  const cleanPayload = Object.fromEntries(PAYLOAD_KEYS.map((key) => [key, payload[key]]));
  const rotated = payload.keyVersion !== options.keyring.current.version;
  const sealedRefreshHandle = rotated
    ? await sealRefreshHandle(cleanPayload, options)
    : handle;
  return Object.freeze({
    payload,
    sealedRefreshHandle,
    refreshHandleVersion: options.keyring.current.version,
    rotated,
  });
}
