const CAPABILITY_DOMAIN = 'ks2-spelling-r2-capability-v1';
const MAX_TTL_SECONDS = 600;
const encoder = new TextEncoder();

function rawSecret(secret) {
  if (!(secret instanceof Uint8Array) || secret.byteLength !== 32) {
    throw new TypeError('The R2 capability secret must contain exactly 32 raw bytes.');
  }
  return Uint8Array.from(secret);
}

function canonicalExpiry(value, { stringOnly }) {
  if (stringOnly) {
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return null;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || String(parsed) !== value) return null;
    return parsed;
  }
  if (!Number.isSafeInteger(value) || value < 1 || String(value) !== `${value}`) return null;
  return value;
}

function exactObjectKey(value) {
  if (
    typeof value !== 'string' || value.length < 1 || value.length > 1_024 ||
    value.includes('\n') || value.includes('\r') || value.includes('\\') ||
    value.startsWith('/') || value.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) return null;
  return value;
}

function canonicalBase64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeCanonicalBase64url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  let binary;
  try {
    const padding = '='.repeat((4 - (value.length % 4)) % 4);
    binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + padding);
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return canonicalBase64url(bytes) === value ? bytes : null;
}

function message(objectKey, expiresAt) {
  return encoder.encode([
    CAPABILITY_DOMAIN,
    'GET',
    objectKey,
    String(expiresAt),
  ].join('\n'));
}

function nowSeconds(clock) {
  const now = clock();
  if (!Number.isFinite(now)) throw new TypeError('The R2 capability clock is invalid.');
  return Math.floor(now / 1_000);
}

function validLifetime(expiresAt, clock) {
  const now = nowSeconds(clock);
  return expiresAt > now && expiresAt - now <= MAX_TTL_SECONDS;
}

async function cryptoKey(secret, usages) {
  return crypto.subtle.importKey(
    'raw',
    rawSecret(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages,
  );
}

async function sign(objectKey, expiresAt, secret) {
  return new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    await cryptoKey(secret, ['sign']),
    message(objectKey, expiresAt),
  ));
}

export async function issueR2Capability({
  method,
  objectKey,
  expiresAt,
  secret,
  clock = Date.now,
}) {
  const key = exactObjectKey(objectKey);
  const expiry = canonicalExpiry(expiresAt, { stringOnly: false });
  if (method !== 'GET' || key === null || expiry === null || !validLifetime(expiry, clock)) {
    throw new TypeError('The R2 capability request is invalid.');
  }
  return canonicalBase64url(await sign(key, expiry, secret));
}

export async function verifyR2Capability({
  method,
  objectKey,
  expiresAt,
  capability,
  secret,
  clock = Date.now,
}) {
  try {
    const key = exactObjectKey(objectKey);
    const expiry = canonicalExpiry(expiresAt, { stringOnly: true });
    const submitted = decodeCanonicalBase64url(capability);
    if (
      method !== 'GET' || key === null || expiry === null || submitted?.byteLength !== 32 ||
      !validLifetime(expiry, clock)
    ) return false;
    return crypto.subtle.verify(
      'HMAC',
      await cryptoKey(secret, ['verify']),
      submitted,
      message(key, expiry),
    );
  } catch {
    return false;
  }
}

export function parseR2CapabilitySecret(value) {
  const bytes = decodeCanonicalBase64url(value);
  if (bytes?.byteLength !== 32) {
    throw new TypeError('The R2 capability secret is invalid.');
  }
  return bytes;
}
