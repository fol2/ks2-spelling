import objectAuthorityDocument from '../../config/b3-pack-object-authority.json' with { type: 'json' };
import packAuthorityDocument from '../../config/b3-proof-pack.json' with { type: 'json' };
import gatewayAuthorityDocument from '../../config/b3-gateway-authority.json' with { type: 'json' };
import { issueR2Capability, parseR2CapabilitySecret, verifyR2Capability } from './r2-capability.js';
import { gatewayJsonByteLength, MAX_GATEWAY_BODY_BYTES } from '../../src/platform/gateway/gateway-payload-limits.js';
import { safeGatewayError } from './store-verifier-port.js';

const AUTHORISE_KEYS = Object.freeze(['sealedRefreshHandle', 'packId', 'version']);
const PACK_ID = packAuthorityDocument.packId;
const VERSION = packAuthorityDocument.version;
const ARCHIVE_NAME = packAuthorityDocument.archiveName;
const PUBLIC_ORIGIN = gatewayAuthorityDocument.publicSandboxOrigin;
const EXPECTED_BUCKET = gatewayAuthorityDocument.privateR2BucketName;
const CAPABILITY_TTL_SECONDS = 600;

function authorityByRole(role) {
  const candidates = objectAuthorityDocument.objects.filter((object) => object.role === role);
  if (candidates.length !== 1) throw safeGatewayError();
  return Object.freeze(structuredClone(candidates[0]));
}

const MANIFEST_AUTHORITY = authorityByRole('signed-manifest');
const ARCHIVE_AUTHORITY = authorityByRole('archive');
const ARCHIVE_PATH = `/v1/packs/${PACK_ID}/${VERSION}/${ARCHIVE_NAME}`;

function assertStaticAuthority() {
  if (
    objectAuthorityDocument.bucketName !== EXPECTED_BUCKET ||
    objectAuthorityDocument.packId !== PACK_ID || objectAuthorityDocument.version !== VERSION ||
    MANIFEST_AUTHORITY.sha256 !== packAuthorityDocument.signedEnvelopeSha256 ||
    ARCHIVE_AUTHORITY.key !== `packs/${PACK_ID}/${VERSION}/${ARCHIVE_NAME}` ||
    MANIFEST_AUTHORITY.key !== `packs/${PACK_ID}/${VERSION}/signed-manifest.json`
  ) throw safeGatewayError();
}

function assertExactMetadata(object, authority, { range } = {}) {
  const metadata = object?.customMetadata;
  const expectedKeys = Object.keys(authority.metadata).sort();
  const actualKeys = metadata && typeof metadata === 'object' ? Object.keys(metadata).sort() : [];
  const metadataMatches =
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key, index) => actualKeys[index] === key && metadata[key] === authority.metadata[key]);
  if (
    object === null || typeof object !== 'object' ||
    object.key !== authority.key || object.size !== authority.bytes || object.etag !== authority.etag ||
    !metadataMatches ||
    (range && (
      object.range?.offset !== range.offset || object.range?.length !== range.length
    ))
  ) throw safeGatewayError();
  return object;
}

async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readBoundedBody(object, expectedBytes) {
  const reader = object.body?.getReader?.();
  if (!reader) throw safeGatewayError();
  const output = new Uint8Array(expectedBytes);
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || offset + value.byteLength > expectedBytes) {
        await reader.cancel().catch(() => undefined);
        throw safeGatewayError();
      }
      output.set(value, offset);
      offset += value.byteLength;
    }
  } catch (error) {
    if (error?.code === 'GATEWAY_UNAVAILABLE') throw error;
    throw safeGatewayError();
  }
  if (offset !== expectedBytes) throw safeGatewayError();
  return output;
}

function standardBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function exactPackBinding(env) {
  if (
    typeof env?.PACKS?.head !== 'function' || typeof env?.PACKS?.get !== 'function' ||
    typeof env.R2_CAPABILITY_HMAC_KEY !== 'string'
  ) throw safeGatewayError();
  let secret;
  try {
    secret = parseR2CapabilitySecret(env.R2_CAPABILITY_HMAC_KEY);
  } catch {
    throw safeGatewayError();
  }
  return Object.freeze({ bucket: env.PACKS, secret });
}

function objectRecord(kind, authority) {
  return Object.freeze({
    objectKind: kind,
    sha256: authority.sha256,
    size: authority.bytes,
    etag: authority.etag,
  });
}

function immutableHeaders(origin, extra = {}) {
  const headers = new Headers({
    Vary: 'Origin',
    'Cache-Control': 'private, no-store',
    'Accept-Ranges': 'bytes',
    ETag: `"${ARCHIVE_AUTHORITY.etag}"`,
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Range, ETag',
    ...extra,
  });
  headers.set('Access-Control-Allow-Origin', origin);
  return headers;
}

function parseRange(value, size) {
  if (value === null) return null;
  const match = /^bytes=([0-9]*)-([0-9]*)$/.exec(value);
  if (!match || (match[1] === '' && match[2] === '')) return false;
  if ((match[1].length > 1 && match[1].startsWith('0')) || (match[2].length > 1 && match[2].startsWith('0'))) {
    return false;
  }
  if (match[1] === '') {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength < 1) return false;
    const length = Math.min(suffixLength, size);
    return { offset: size - length, length };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] === '' ? size - 1 : Number(match[2]);
  if (
    !Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) ||
    start >= size || requestedEnd < start
  ) return false;
  const end = Math.min(requestedEnd, size - 1);
  return { offset: start, length: end - start + 1 };
}

function downloadRequest(url) {
  if (url.pathname !== ARCHIVE_PATH) return null;
  const match = /^\?expires=([1-9][0-9]*)&cap=([A-Za-z0-9_-]{43})$/.exec(url.search);
  if (!match) return null;
  return Object.freeze({ expiresAt: match[1], capability: match[2] });
}

export function createPackAccessService({ clock = Date.now } = {}) {
  assertStaticAuthority();

  return Object.freeze({
    assertAuthoriseRequest(value) {
      if (
        value === null || typeof value !== 'object' || Array.isArray(value) ||
        Reflect.ownKeys(value).sort().join('\n') !== [...AUTHORISE_KEYS].sort().join('\n') ||
        typeof value.sealedRefreshHandle !== 'string' || value.sealedRefreshHandle.length < 1 ||
        value.packId !== PACK_ID || value.version !== VERSION
      ) throw safeGatewayError('REQUEST_INVALID');
      return Object.freeze({
        sealedRefreshHandle: value.sealedRefreshHandle,
        packId: PACK_ID,
        version: VERSION,
      });
    },

    assertBindings(env) {
      return exactPackBinding(env);
    },

    async authorise({ request, identity, env }) {
      if (identity.state !== 'active' || identity.entitlementId !== 'full-ks2') {
        throw safeGatewayError('ENTITLEMENT_REVOKED');
      }
      const { bucket, secret } = exactPackBinding(env);
      const manifestObject = assertExactMetadata(
        await bucket.get(MANIFEST_AUTHORITY.key),
        MANIFEST_AUTHORITY,
      );
      const manifestBytes = await readBoundedBody(manifestObject, MANIFEST_AUTHORITY.bytes);
      if (await sha256(manifestBytes) !== MANIFEST_AUTHORITY.sha256) throw safeGatewayError();
      assertExactMetadata(await bucket.head(ARCHIVE_AUTHORITY.key), ARCHIVE_AUTHORITY);

      const expiresAt = Math.floor(clock() / 1_000) + CAPABILITY_TTL_SECONDS;
      const capability = await issueR2Capability({
        method: 'GET',
        objectKey: ARCHIVE_AUTHORITY.key,
        expiresAt,
        secret,
        clock,
      });
      const result = Object.freeze({
        ...identity,
        packId: request.packId,
        version: request.version,
        signedManifestEnvelopeBase64: standardBase64(manifestBytes),
        signedEnvelopeSha256: MANIFEST_AUTHORITY.sha256,
        objects: Object.freeze([
          objectRecord('manifest', MANIFEST_AUTHORITY),
          objectRecord('archive', ARCHIVE_AUTHORITY),
        ]),
        archiveCapability: Object.freeze({
          packId: request.packId,
          version: request.version,
          archiveName: ARCHIVE_NAME,
          sha256: ARCHIVE_AUTHORITY.sha256,
          compressedBytes: ARCHIVE_AUTHORITY.bytes,
          etag: ARCHIVE_AUTHORITY.etag,
          capabilityUrl: `${PUBLIC_ORIGIN}${ARCHIVE_PATH}?expires=${expiresAt}&cap=${capability}`,
        }),
      });
      if (gatewayJsonByteLength(result) > MAX_GATEWAY_BODY_BYTES) throw safeGatewayError();
      return result;
    },

    matchesDownloadPath(pathname) {
      return pathname === ARCHIVE_PATH;
    },

    matchesDownloadNamespace(pathname) {
      return pathname === '/v1/packs' || pathname.startsWith('/v1/packs/');
    },

    matchesDownloadRequest(url) {
      return downloadRequest(url) !== null;
    },

    async download({ request, url, env, origin }) {
      const submitted = downloadRequest(url);
      if (submitted === null) throw safeGatewayError('REQUEST_INVALID');
      const { bucket, secret } = exactPackBinding(env);
      if (!await verifyR2Capability({
        method: request.method,
        objectKey: ARCHIVE_AUTHORITY.key,
        expiresAt: submitted.expiresAt,
        capability: submitted.capability,
        secret,
        clock,
      })) throw safeGatewayError('REQUEST_INVALID');

      const range = parseRange(request.headers.get('range'), ARCHIVE_AUTHORITY.bytes);
      if (range === false) {
        return Object.freeze({
          status: 416,
          body: null,
          headers: immutableHeaders(origin, {
            'Content-Range': `bytes */${ARCHIVE_AUTHORITY.bytes}`,
            'Content-Length': '0',
          }),
        });
      }
      if (request.headers.get('if-none-match') === `"${ARCHIVE_AUTHORITY.etag}"`) {
        assertExactMetadata(await bucket.head(ARCHIVE_AUTHORITY.key), ARCHIVE_AUTHORITY);
        return Object.freeze({ status: 304, body: null, headers: immutableHeaders(origin) });
      }

      const object = assertExactMetadata(
        await bucket.get(ARCHIVE_AUTHORITY.key, range ? { range } : undefined),
        ARCHIVE_AUTHORITY,
        range ? { range } : undefined,
      );
      if (!object.body || typeof object.body.getReader !== 'function') throw safeGatewayError();
      const headers = immutableHeaders(origin, {
        'Content-Type': 'application/zip',
        'Content-Length': String(range?.length ?? ARCHIVE_AUTHORITY.bytes),
      });
      if (range) {
        headers.set(
          'Content-Range',
          `bytes ${range.offset}-${range.offset + range.length - 1}/${ARCHIVE_AUTHORITY.bytes}`,
        );
      }
      return Object.freeze({ status: range ? 206 : 200, body: object.body, headers });
    },
  });
}
