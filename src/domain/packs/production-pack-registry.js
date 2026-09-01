import productionPackObjectAuthority from '../../../config/ks2-pack-object-authority-production.json' with { type: 'json' };
import {
  PACK_REGISTRY,
  assertPackAuthority,
  readDownloadablePackRows,
} from './pack-registry.js';

const PRODUCTION_BUCKET = 'ks2-spelling-production-packs';
const OBJECT_KEYS = Object.freeze(['role', 'key', 'bytes', 'sha256', 'etag', 'metadata']);
const SHA256 = /^[a-f0-9]{64}$/u;
const ETAG = /^[a-f0-9]{32}$/u;

function fail(detail) {
  throw new TypeError(`Production pack registry ${detail}.`);
}

function closedRecord(value, keys, detail) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    fail(detail);
  }
  const actualKeys = Reflect.ownKeys(value);
  if (
    actualKeys.length !== keys.length ||
    actualKeys.some((key) => typeof key !== 'string' || !keys.includes(key)) ||
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value');
    })
  ) {
    fail(detail);
  }
  return value;
}

function objectByRole(pack, role) {
  const matches = pack.objects.filter((object) => object.role === role);
  if (matches.length !== 1) fail(`must declare exactly one ${role} object for ${pack.packId}`);
  const object = closedRecord(matches[0], OBJECT_KEYS, `object ${role} for ${pack.packId}`);
  if (
    object.role !== role ||
    typeof object.key !== 'string' ||
    !Number.isSafeInteger(object.bytes) ||
    object.bytes <= 0 ||
    !SHA256.test(object.sha256) ||
    !ETAG.test(object.etag) ||
    !object.metadata ||
    typeof object.metadata !== 'object' ||
    Array.isArray(object.metadata) ||
    Reflect.ownKeys(object.metadata).length !== 0
  ) {
    fail(`has an invalid ${role} object for ${pack.packId}`);
  }
  return object;
}

// Production R2 holds the same zip bytes as the downloadable registry and a
// separately signed envelope. The overlay keeps identity, ceilings and archive
// pins from the downloadable table and replaces only the production-signed
// manifest object facts. Archive drift is a lockstep failure, not a silent
// mix of the two documents.
export function overlayProductionPackObjectFacts(
  downloadableRows,
  productionDocument,
) {
  if (
    productionDocument?.schemaVersion !== 1 ||
    productionDocument.bucketName !== PRODUCTION_BUCKET ||
    !Array.isArray(productionDocument.packs)
  ) {
    fail('document is not the approved production pack-object authority');
  }
  if (!Array.isArray(downloadableRows) || downloadableRows.length === 0) {
    fail('needs the downloadable shard table');
  }
  if (productionDocument.packs.length !== downloadableRows.length) {
    fail('must cover the same packs as the downloadable table');
  }
  const seen = new Set();
  return Object.freeze(downloadableRows.map((row) => {
    const pack = productionDocument.packs.find((candidate) =>
      candidate?.packId === row.packId && candidate?.version === row.version);
    if (!pack) fail(`is missing ${row.packId}@${row.version}`);
    if (seen.has(row.packId)) fail(`has a duplicate packId ${row.packId}`);
    seen.add(row.packId);
    const manifest = objectByRole(pack, 'signed-manifest');
    const archive = objectByRole(pack, 'archive');
    if (
      archive.key !== `packs/${row.packId}/${row.version}/${row.archiveName}` ||
      archive.sha256 !== row.archiveSha256 ||
      archive.bytes !== row.archiveBytes ||
      archive.etag !== row.archiveEtag
    ) {
      fail(`archive facts drifted from the downloadable table for ${row.packId}`);
    }
    if (manifest.key !== `packs/${row.packId}/${row.version}/signed-manifest.json`) {
      fail(`manifest key is invalid for ${row.packId}`);
    }
    if (
      manifest.sha256 === row.manifestSha256 ||
      manifest.etag === row.manifestEtag ||
      manifest.bytes === row.manifestBytes
    ) {
      fail(`must not reuse sandbox-signed manifest facts for ${row.packId}`);
    }
    return assertPackAuthority({
      packId: row.packId,
      version: row.version,
      requiredEntitlementId: row.requiredEntitlementId,
      archiveName: row.archiveName,
      allowedExtensions: [...row.allowedExtensions],
      ceilings: { ...row.ceilings },
      manifestSha256: manifest.sha256,
      manifestBytes: manifest.bytes,
      manifestEtag: manifest.etag,
      archiveSha256: row.archiveSha256,
      archiveBytes: row.archiveBytes,
      archiveEtag: row.archiveEtag,
    });
  }));
}

export const PRODUCTION_PACK_REGISTRY = overlayProductionPackObjectFacts(
  readDownloadablePackRows(),
  productionPackObjectAuthority,
);

export function packRegistryForEnvironment(environment) {
  if (environment === 'production') return PRODUCTION_PACK_REGISTRY;
  if (environment === 'sandbox') return PACK_REGISTRY;
  throw new TypeError('Pack trust environment is invalid.');
}
