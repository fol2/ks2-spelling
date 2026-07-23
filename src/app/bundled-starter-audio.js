import evidence from '../../reports/c1/starter-audio-evidence.json' with { type: 'json' };

const REQUEST_KEYS = Object.freeze([
  'packId',
  'version',
  'assetPath',
  'sha256',
  'byteSize',
]);
const SAFE_AUDIO_PATH =
  /^audio\/(?:iapetus|sulafat)\/[a-z0-9][a-z0-9._-]{0,63}\/(?:word|sentence-[0-9]{2}-(?:normal|slow))\.m4a$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAXIMUM_AUDIO_BYTES = 131_072;

function sourceError() {
  return Object.assign(new Error('Bundled Starter audio is unavailable.'), {
    code: 'bundled_starter_audio_unavailable',
  });
}

function requireAuthority(value) {
  const sentinel = value?.sentinel;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 3 ||
    value.packId !== 'ks2-core' ||
    value.version !== '1.0.0' ||
    !sentinel ||
    typeof sentinel !== 'object' ||
    Array.isArray(sentinel) ||
    Reflect.ownKeys(sentinel).length !== 3 ||
    !SAFE_AUDIO_PATH.test(sentinel.assetPath) ||
    !SHA256.test(sentinel.sha256) ||
    !Number.isSafeInteger(sentinel.byteSize) ||
    sentinel.byteSize < 1 ||
    sentinel.byteSize > MAXIMUM_AUDIO_BYTES
  ) {
    throw new TypeError('Bundled Starter audio authority is invalid.');
  }
  return Object.freeze({
    packId: value.packId,
    version: value.version,
    sentinel: Object.freeze({ ...sentinel }),
  });
}

function createDefaultAuthority() {
  const sentinel = evidence.assets?.find(
    ({ assetPath }) => assetPath === 'audio/iapetus/answer/word.m4a',
  );
  return requireAuthority({
    packId: 'ks2-core',
    version: '1.0.0',
    sentinel: sentinel && {
      assetPath: sentinel.assetPath,
      sha256: sentinel.sha256,
      byteSize: sentinel.byteSize,
    },
  });
}

function defaultBaseUrl() {
  if (typeof globalThis.document?.baseURI !== 'string') {
    throw new TypeError('Bundled Starter audio base URL is unavailable.');
  }
  return new URL('starter/', globalThis.document.baseURI).href;
}

function requireBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('Bundled Starter audio base URL is invalid.');
  }
  if (
    !['capacitor:', 'http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !parsed.pathname.endsWith('/starter/')
  ) {
    throw new TypeError('Bundled Starter audio base URL is invalid.');
  }
  return parsed.href;
}

function requireRequest(value, authority) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== REQUEST_KEYS.length ||
    REQUEST_KEYS.some((key) => !Object.hasOwn(value, key)) ||
    value.packId !== authority.packId ||
    value.version !== authority.version ||
    !SAFE_AUDIO_PATH.test(value.assetPath) ||
    !SHA256.test(value.sha256) ||
    !Number.isSafeInteger(value.byteSize) ||
    value.byteSize < 1 ||
    value.byteSize > MAXIMUM_AUDIO_BYTES
  ) {
    throw sourceError();
  }
  return value;
}

async function defaultDigest(bytes) {
  if (typeof globalThis.crypto?.subtle?.digest !== 'function') {
    throw sourceError();
  }
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', bytes),
  );
  return [...digest]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function defaultEncodeBase64(bytes) {
  if (typeof globalThis.btoa !== 'function') throw sourceError();
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16_384) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
  }
  return globalThis.btoa(binary);
}

export function createBundledStarterAudio(options = {}) {
  const authority = requireAuthority(
    options.authority ?? createDefaultAuthority(),
  );
  const baseUrl = requireBaseUrl(options.baseUrl ?? defaultBaseUrl());
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  const digest = options.digest ?? defaultDigest;
  const encodeBase64 = options.encodeBase64 ?? defaultEncodeBase64;
  if (
    typeof fetchImpl !== 'function' ||
    typeof digest !== 'function' ||
    typeof encodeBase64 !== 'function'
  ) {
    throw new TypeError('Bundled Starter audio functions are invalid.');
  }

  async function read(candidate) {
    const request = requireRequest(candidate, authority);
    const url = new URL(request.assetPath, baseUrl);
    if (!url.href.startsWith(baseUrl)) throw sourceError();
    try {
      const response = await fetchImpl(url.href);
      const isCapacitorStatusZero =
        url.protocol === 'capacitor:' &&
        response?.ok === false &&
        response?.status === 0;
      if (
        !response ||
        typeof response.arrayBuffer !== 'function' ||
        (response.ok !== true && !isCapacitorStatusZero)
      ) {
        throw sourceError();
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const actualDigest = await digest(bytes);
      if (
        bytes.byteLength !== request.byteSize ||
        actualDigest !== request.sha256
      ) {
        throw sourceError();
      }
      return Object.freeze({ base64: encodeBase64(bytes) });
    } catch {
      throw sourceError();
    }
  }

  return Object.freeze({
    async checkAvailability() {
      await read({
        packId: authority.packId,
        version: authority.version,
        ...authority.sentinel,
      });
      return Object.freeze({ version: authority.version });
    },
    readInstalledAudio: read,
  });
}
