import objectAuthorityDocument from '../../config/b3-pack-object-authority.json' with { type: 'json' };
import packAuthorityDocument from '../../config/b3-proof-pack.json' with { type: 'json' };
import sandboxGatewayAuthority from '../../config/b3-gateway-authority.json' with { type: 'json' };
import productionGatewayAuthority from '../../config/ks2-gateway-authority-production.json' with { type: 'json' };
import { PACK_REGISTRY } from '../../src/domain/packs/pack-registry.js';
import { PRODUCTION_PACK_REGISTRY } from '../../src/domain/packs/production-pack-registry.js';
import { issueR2Capability, parseR2CapabilitySecret, verifyR2Capability } from './r2-capability.js';
import { gatewayJsonByteLength, MAX_AUTHORISE_RESPONSE_BYTES } from '../../src/platform/gateway/gateway-payload-limits.js';
import { safeGatewayError } from './store-verifier-port.js';

const AUTHORISE_KEYS = Object.freeze(['sealedRefreshHandle', 'packId', 'version']);
const CAPABILITY_TTL_SECONDS = 600;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const ETAG_HEX = /^[a-f0-9]{32}$/;
const IDENTITY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/;
const ARCHIVE_NAME = /^[a-z0-9][a-z0-9.-]{0,127}\.zip$/;

function authorityByRole(role) {
  const candidates = objectAuthorityDocument.objects.filter((object) => object.role === role);
  if (candidates.length !== 1) throw safeGatewayError();
  return Object.freeze(structuredClone(candidates[0]));
}

function objectFacts({ key, bytes, sha256, etag, metadata }) {
  if (
    typeof key !== 'string' || key.length === 0 ||
    !Number.isSafeInteger(bytes) || bytes <= 0 ||
    !SHA256_HEX.test(sha256 ?? '') || !ETAG_HEX.test(etag ?? '') ||
    !metadata || typeof metadata !== 'object' || Array.isArray(metadata) ||
    Object.values(metadata).some((value) => typeof value !== 'string')
  ) throw safeGatewayError();
  return Object.freeze({ key, bytes, sha256, etag, metadata: Object.freeze({ ...metadata }) });
}

function packRow({ packId, version, archiveName, requiredEntitlementId, manifest, archive }) {
  if (
    !IDENTITY.test(packId ?? '') || !VERSION_PATTERN.test(version ?? '') ||
    !ARCHIVE_NAME.test(archiveName ?? '') || !IDENTITY.test(requiredEntitlementId ?? '')
  ) throw safeGatewayError();
  return Object.freeze({
    packId,
    version,
    archiveName,
    requiredEntitlementId,
    archivePath: `/v1/packs/${packId}/${version}/${archiveName}`,
    manifest: objectFacts(manifest),
    archive: objectFacts(archive),
  });
}

// The b3 row keeps its frozen object authority verbatim, custom b3-* metadata
// included: the two tracked b3 config documents are byte-frozen evidence.
function readB3Row(expectedBucket) {
  const manifest = authorityByRole('signed-manifest');
  const archive = authorityByRole('archive');
  if (
    objectAuthorityDocument.bucketName !== expectedBucket ||
    objectAuthorityDocument.packId !== packAuthorityDocument.packId ||
    objectAuthorityDocument.version !== packAuthorityDocument.version ||
    manifest.sha256 !== packAuthorityDocument.signedEnvelopeSha256 ||
    archive.key !== `packs/${packAuthorityDocument.packId}/${packAuthorityDocument.version}/${packAuthorityDocument.archiveName}` ||
    manifest.key !== `packs/${packAuthorityDocument.packId}/${packAuthorityDocument.version}/signed-manifest.json`
  ) throw safeGatewayError();
  return packRow({
    packId: packAuthorityDocument.packId,
    version: packAuthorityDocument.version,
    archiveName: packAuthorityDocument.archiveName,
    requiredEntitlementId: packAuthorityDocument.requiredEntitlementId,
    manifest,
    archive,
  });
}

// Shard rows are derived from the channel pack registry, never a second
// hand-maintained object table: keys follow the packs/<packId>/<version>
// layout and the object facts are that registry's signed-envelope and archive
// pins. Shard objects deliberately declare EMPTY custom metadata (owner
// decision, 2026-08-13 hosting runbook): the load-bearing pins are the
// config-declared sha256/bytes/etag asserted per object plus device-side
// signature verification; b3-* labels remain a b3-pack-only convention.
function readShardRows(registry) {
  if (!Array.isArray(registry) || registry.length === 0) throw safeGatewayError();
  return registry.map((row) => packRow({
    packId: row.packId,
    version: row.version,
    archiveName: row.archiveName,
    requiredEntitlementId: row.requiredEntitlementId,
    manifest: {
      key: `packs/${row.packId}/${row.version}/signed-manifest.json`,
      bytes: row.manifestBytes,
      sha256: row.manifestSha256,
      etag: row.manifestEtag,
      metadata: {},
    },
    archive: {
      key: `packs/${row.packId}/${row.version}/${row.archiveName}`,
      bytes: row.archiveBytes,
      sha256: row.archiveSha256,
      etag: row.archiveEtag,
      metadata: {},
    },
  }));
}

function buildPackTable(rows) {
  const byPackId = new Map();
  const byArchivePath = new Map();
  for (const row of rows) {
    if (byPackId.has(row.packId) || byArchivePath.has(row.archivePath)) {
      throw safeGatewayError();
    }
    byPackId.set(row.packId, row);
    byArchivePath.set(row.archivePath, row);
  }
  return Object.freeze({ byPackId, byArchivePath });
}

function resolveReleaseChannel(releaseChannel) {
  if (releaseChannel === 'production') {
    if (productionGatewayAuthority.privateR2BucketName !== 'ks2-spelling-production-packs') {
      throw safeGatewayError();
    }
    return Object.freeze({
      publicOrigin: productionGatewayAuthority.publicSandboxOrigin,
      rows: readShardRows(PRODUCTION_PACK_REGISTRY),
    });
  }
  if (releaseChannel !== 'sandbox') throw safeGatewayError();
  return Object.freeze({
    publicOrigin: sandboxGatewayAuthority.publicSandboxOrigin,
    rows: [readB3Row(sandboxGatewayAuthority.privateR2BucketName), ...readShardRows(PACK_REGISTRY)],
  });
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

function immutableHeaders(origin, row, extra = {}) {
  const headers = new Headers({
    Vary: 'Origin',
    'Cache-Control': 'private, no-store',
    'Accept-Ranges': 'bytes',
    ETag: `"${row.archive.etag}"`,
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

function downloadRequest(url, packTable) {
  const row = packTable.byArchivePath.get(url.pathname);
  if (!row) return null;
  const match = /^\?expires=([1-9][0-9]*)&cap=([A-Za-z0-9_-]{43})$/.exec(url.search);
  if (!match) return null;
  return Object.freeze({ row, expiresAt: match[1], capability: match[2] });
}

export function createPackAccessService({ clock = Date.now, releaseChannel = 'sandbox' } = {}) {
  const channel = resolveReleaseChannel(releaseChannel);
  const packTable = buildPackTable(channel.rows);
  const publicOrigin = channel.publicOrigin;

  return Object.freeze({
    assertAuthoriseRequest(value) {
      const row = value === null || typeof value !== 'object'
        ? undefined
        : packTable.byPackId.get(value.packId);
      if (
        value === null || typeof value !== 'object' || Array.isArray(value) ||
        Reflect.ownKeys(value).sort().join('\n') !== [...AUTHORISE_KEYS].sort().join('\n') ||
        typeof value.sealedRefreshHandle !== 'string' || value.sealedRefreshHandle.length < 1 ||
        !row || value.version !== row.version
      ) throw safeGatewayError('REQUEST_INVALID');
      return Object.freeze({
        sealedRefreshHandle: value.sealedRefreshHandle,
        packId: row.packId,
        version: row.version,
      });
    },

    assertBindings(env) {
      return exactPackBinding(env);
    },

    async authorise({ request, identity, env }) {
      const row = packTable.byPackId.get(request.packId);
      if (!row || request.version !== row.version) throw safeGatewayError('REQUEST_INVALID');
      if (identity.state !== 'active' || identity.entitlementId !== row.requiredEntitlementId) {
        throw safeGatewayError('ENTITLEMENT_REVOKED');
      }
      const { bucket, secret } = exactPackBinding(env);
      const manifestObject = assertExactMetadata(
        await bucket.get(row.manifest.key),
        row.manifest,
      );
      const manifestBytes = await readBoundedBody(manifestObject, row.manifest.bytes);
      if (await sha256(manifestBytes) !== row.manifest.sha256) throw safeGatewayError();
      assertExactMetadata(await bucket.head(row.archive.key), row.archive);

      const expiresAt = Math.floor(clock() / 1_000) + CAPABILITY_TTL_SECONDS;
      const capability = await issueR2Capability({
        method: 'GET',
        objectKey: row.archive.key,
        expiresAt,
        secret,
        clock,
      });
      const result = Object.freeze({
        ...identity,
        packId: row.packId,
        version: row.version,
        signedManifestEnvelopeBase64: standardBase64(manifestBytes),
        signedEnvelopeSha256: row.manifest.sha256,
        objects: Object.freeze([
          objectRecord('manifest', row.manifest),
          objectRecord('archive', row.archive),
        ]),
        archiveCapability: Object.freeze({
          packId: row.packId,
          version: row.version,
          archiveName: row.archiveName,
          sha256: row.archive.sha256,
          compressedBytes: row.archive.bytes,
          etag: row.archive.etag,
          capabilityUrl: `${publicOrigin}${row.archivePath}?expires=${expiresAt}&cap=${capability}`,
        }),
      });
      if (gatewayJsonByteLength(result) > MAX_AUTHORISE_RESPONSE_BYTES) throw safeGatewayError();
      return result;
    },

    matchesDownloadPath(pathname) {
      return packTable.byArchivePath.has(pathname);
    },

    matchesDownloadNamespace(pathname) {
      return pathname === '/v1/packs' || pathname.startsWith('/v1/packs/');
    },

    matchesDownloadRequest(url) {
      return downloadRequest(url, packTable) !== null;
    },

    async download({ request, url, env, origin }) {
      const submitted = downloadRequest(url, packTable);
      if (submitted === null) throw safeGatewayError('REQUEST_INVALID');
      const { row } = submitted;
      const { bucket, secret } = exactPackBinding(env);
      if (!await verifyR2Capability({
        method: request.method,
        objectKey: row.archive.key,
        expiresAt: submitted.expiresAt,
        capability: submitted.capability,
        secret,
        clock,
      })) throw safeGatewayError('REQUEST_INVALID');

      const range = parseRange(request.headers.get('range'), row.archive.bytes);
      if (range === false) {
        return Object.freeze({
          status: 416,
          body: null,
          headers: immutableHeaders(origin, row, {
            'Content-Range': `bytes */${row.archive.bytes}`,
            'Content-Length': '0',
          }),
        });
      }
      if (request.headers.get('if-none-match') === `"${row.archive.etag}"`) {
        assertExactMetadata(await bucket.head(row.archive.key), row.archive);
        return Object.freeze({ status: 304, body: null, headers: immutableHeaders(origin, row) });
      }

      const object = assertExactMetadata(
        await bucket.get(row.archive.key, range ? { range } : undefined),
        row.archive,
        range ? { range } : undefined,
      );
      if (!object.body || typeof object.body.getReader !== 'function') throw safeGatewayError();
      const headers = immutableHeaders(origin, row, {
        'Content-Type': 'application/zip',
        'Content-Length': String(range?.length ?? row.archive.bytes),
      });
      if (range) {
        headers.set(
          'Content-Range',
          `bytes ${range.offset}-${range.offset + range.length - 1}/${row.archive.bytes}`,
        );
      }
      return Object.freeze({ status: range ? 206 : 200, body: object.body, headers });
    },
  });
}
