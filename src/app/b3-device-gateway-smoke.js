import { validateB3GatewaySmokeAuthority } from './b3-live-proof-protocol.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ETAG = /^[0-9a-f]{32}$/u;
const CAPABILITY_URL = /^https:\/\/b3-gateway\.eugnel\.uk\/v1\/packs\/b3-sandbox-proof\/1\.0\.0-b3\.1\/b3-sandbox-proof\.zip\?expires=([1-9][0-9]*)&cap=([A-Za-z0-9_-]{43})$/u;
const MAX_ERROR_BYTES = 4_096;

function smokeError(message) {
  return new TypeError(`B3 device gateway smoke ${message}.`);
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(value, key))) {
    throw smokeError(`${label} is not closed`);
  }
  return value;
}

async function sha256(bytes) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function withinDeadline(promise, timeoutMs, onTimeout, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(smokeError(`${label} exceeded its deadline`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readBounded(response, maximumBytes, exactBytes, timeoutMs) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    if (exactBytes === 0) return new Uint8Array();
    throw smokeError('response body is unavailable');
  }
  const declared = response.headers?.get?.('content-length');
  const chunks = [];
  let length = 0;
  try {
    if (declared !== null && declared !== undefined &&
        (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > maximumBytes)) {
      throw smokeError('response body exceeds its declared byte bound');
    }
    while (true) {
      const result = await withinDeadline(
        Promise.resolve().then(() => reader.read()),
        timeoutMs,
        () => {},
        'response body read',
      );
      if (!result || result.done === true) break;
      if (!(result.value instanceof Uint8Array) || length + result.value.byteLength > maximumBytes) {
        throw smokeError('response body exceeds its actual byte bound');
      }
      chunks.push(result.value);
      length += result.value.byteLength;
    }
    if ((declared !== null && declared !== undefined && Number(declared) !== length) ||
        (exactBytes !== null && length !== exactBytes)) {
      throw smokeError('response body size differs from authority');
    }
  } catch (error) {
    try {
      await withinDeadline(
        Promise.resolve().then(() => reader.cancel()).catch(() => undefined),
        timeoutMs,
        () => {},
        'response body cancellation',
      );
    } catch {
      // The original bounded read or authority error remains authoritative.
    }
    throw error;
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function assertResponse(response, status) {
  if (!response || response.status !== status || response.redirected === true) {
    throw smokeError('response status or redirect authority is invalid');
  }
  return response;
}

function requestOptions(headers = {}) {
  return {
    method: 'GET',
    headers,
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
    referrer: '',
    referrerPolicy: 'no-referrer',
  };
}

function assertInput(value) {
  if (!value || typeof value !== 'object' || !UUID_V4.test(value.workerVersionId) ||
      !SHA256.test(value.workerScriptAuthoritySha256) ||
      !SHA256.test(value.signedEnvelopeSha256) || !Array.isArray(value.objects) ||
      value.objects.length !== 2) {
    throw smokeError('authorisation authority is invalid');
  }
  const [manifest, archive] = value.objects;
  for (const object of value.objects) {
    exactObject(object, ['objectKind', 'sha256', 'size', 'etag'], 'object authority');
    if (!SHA256.test(object.sha256) || !Number.isSafeInteger(object.size) || object.size <= 0 ||
        !ETAG.test(object.etag)) throw smokeError('object authority is invalid');
  }
  exactObject(value.archiveCapability, [
    'packId', 'version', 'archiveName', 'sha256', 'compressedBytes', 'etag', 'capabilityUrl',
  ], 'archive access authority');
  const match = CAPABILITY_URL.exec(value.archiveCapability.capabilityUrl);
  if (manifest.objectKind !== 'manifest' || archive.objectKind !== 'archive' ||
      value.signedEnvelopeSha256 !== manifest.sha256 ||
      value.archiveCapability.packId !== 'b3-sandbox-proof' ||
      value.archiveCapability.version !== '1.0.0-b3.1' ||
      value.archiveCapability.archiveName !== 'b3-sandbox-proof.zip' ||
      value.archiveCapability.sha256 !== archive.sha256 ||
      value.archiveCapability.compressedBytes !== archive.size ||
      value.archiveCapability.etag !== archive.etag || !match) {
    throw smokeError('archive access binding is invalid');
  }
  const expiresAt = Number(match[1]);
  if (!Number.isSafeInteger(expiresAt)) throw smokeError('access expiry is invalid');
  return { manifest, archive, capabilityUrl: value.archiveCapability.capabilityUrl, expiresAt };
}

export function createB3DeviceGatewaySmokeProbe({
  fetchImpl,
  clock = Date.now,
  wait,
  operationTimeoutMs = 10_000,
} = {}) {
  if (typeof fetchImpl !== 'function' || typeof clock !== 'function' || typeof wait !== 'function' ||
      !Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1 ||
      operationTimeoutMs > 10_000) {
    throw smokeError('dependencies are invalid');
  }
  return async (authorisation) => {
    const { manifest, archive, capabilityUrl, expiresAt } = assertInput(authorisation);
    const initialLifetimeMs = (expiresAt * 1_000) - clock();
    if (initialLifetimeMs <= 599_000 || initialLifetimeMs > 600_000) {
      throw smokeError('initial access lifetime is not the Worker 600-second authority');
    }
    const fetchClosed = async (url, options) => {
      const controller = new AbortController();
      const response = await withinDeadline(
        Promise.resolve().then(() => fetchImpl(url, { ...options, signal: controller.signal })),
        operationTimeoutMs,
        () => controller.abort(),
        'fetch',
      );
      if (response?.redirected === true) throw smokeError('redirect was observed');
      return response;
    };
    const full = assertResponse(await fetchClosed(capabilityUrl, requestOptions()), 200);
    if (full.headers?.get?.('cache-control') !== 'private, no-store') {
      throw smokeError('cache policy differs from authority');
    }
    if (full.headers?.get?.('etag') !== `"${archive.etag}"` ||
        full.headers?.get?.('accept-ranges') !== 'bytes') {
      throw smokeError('full ETag or Accept-Ranges differs from authority');
    }
    const fullBytes = await readBounded(full, archive.size, archive.size, operationTimeoutMs);
    if (await sha256(fullBytes) !== archive.sha256) throw smokeError('full byte SHA differs');

    const partial = assertResponse(await fetchClosed(
      capabilityUrl,
      requestOptions({ Range: 'bytes=0-0' }),
    ), 206);
    if (partial.headers?.get?.('content-range') !== `bytes 0-0/${archive.size}`) {
      throw smokeError('partial content range differs');
    }
    const partialBytes = await readBounded(partial, 1, 1, operationTimeoutMs);
    if (partialBytes[0] !== fullBytes[0]) throw smokeError('partial byte differs from full bytes');

    const conditional = assertResponse(await fetchClosed(
      capabilityUrl,
      requestOptions({ 'If-None-Match': `"${archive.etag}"` }),
    ), 304);
    if (conditional.body !== null) throw smokeError('304 response body is not empty');

    const unsatisfied = assertResponse(await fetchClosed(
      capabilityUrl,
      requestOptions({ Range: `bytes=${archive.size}-${archive.size}` }),
    ), 416);
    if (unsatisfied.body !== null ||
        unsatisfied.headers?.get?.('content-range') !== `bytes */${archive.size}`) {
      throw smokeError('416 response authority differs');
    }

    const tamperedUrl = `${capabilityUrl.slice(0, -1)}${capabilityUrl.endsWith('A') ? 'B' : 'A'}`;
    const tampered = assertResponse(await fetchClosed(tamperedUrl, requestOptions()), 400);
    await readBounded(tampered, MAX_ERROR_BYTES, null, operationTimeoutMs);
    const nonCanonicalUrl = capabilityUrl.replace('&cap=', '&cap=%41');
    const nonCanonical = assertResponse(await fetchClosed(nonCanonicalUrl, requestOptions()), 400);
    await readBounded(nonCanonical, MAX_ERROR_BYTES, null, operationTimeoutMs);

    const startedAt = clock();
    await wait(600_000);
    if (clock() - startedAt < 600_000) throw smokeError('expiry clock did not advance 600 seconds');
    if (clock() <= expiresAt * 1_000) await wait((expiresAt * 1_000) - clock() + 1);
    if (clock() <= expiresAt * 1_000) throw smokeError('expiry clock did not pass capability expiry');
    const expired = assertResponse(await fetchClosed(capabilityUrl, requestOptions()), 400);
    await readBounded(expired, MAX_ERROR_BYTES, null, operationTimeoutMs);

    return validateB3GatewaySmokeAuthority({
      schemaVersion: 1,
      deploymentVersionId: authorisation.workerVersionId,
      scriptAuthoritySha256: authorisation.workerScriptAuthoritySha256,
      signedEnvelopeSha256: authorisation.signedEnvelopeSha256,
      objects: [
        {
          role: 'signed-manifest',
          key: 'packs/b3-sandbox-proof/1.0.0-b3.1/signed-manifest.json',
          sha256: manifest.sha256, size: manifest.size, etag: manifest.etag,
        },
        {
          role: 'archive',
          key: 'packs/b3-sandbox-proof/1.0.0-b3.1/b3-sandbox-proof.zip',
          sha256: archive.sha256, size: archive.size, etag: archive.etag,
        },
      ],
      accessBehaviour: {
        ttlSeconds: 600, valid: true, tamperedRejected: true,
        expiredRejected: true, canonicalEncodingRequired: true,
      },
      byteServingBehaviour: {
        full200: true, partial206: true, conditional304: true,
        unsatisfied416: true, noRedirects: true, cacheControl: 'private, no-store',
      },
    });
  };
}
