import b3PackObjectAuthority from '../../../config/b3-pack-object-authority.json' with { type: 'json' };
import b3ProofPack from '../../../config/b3-proof-pack.json' with { type: 'json' };
import downloadablePackAuthorities from '../../../config/downloadable-pack-authorities.json' with { type: 'json' };

// The registry is the config-driven table of every pack the download path may
// track: {packId, version, requiredEntitlementId, ceilings} plus the object
// facts a coordinator pins gateway responses against. store-products.json
// packIds[] remains the entitlement→packs join; every joined packId must
// resolve to a row here bound to the same entitlement.
const IDENTITY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ETAG = /^[a-f0-9]{32}$/u;
const ARCHIVE_NAME = /^[a-z0-9][a-z0-9.-]{0,127}\.zip$/u;
const AUTHORITY_KEYS = Object.freeze([
  'packId',
  'version',
  'requiredEntitlementId',
  'archiveName',
  'allowedExtensions',
  'ceilings',
  'manifestSha256',
  'manifestBytes',
  'manifestEtag',
  'archiveSha256',
  'archiveBytes',
  'archiveEtag',
]);
const CEILING_KEYS = Object.freeze(['fileCount', 'compressedBytes', 'extractedBytes']);

function fail(detail) {
  throw new TypeError(`Pack authority ${detail}.`);
}

function requireClosedRecord(value, keys, detail) {
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

function requirePositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function assertPackAuthority(value) {
  requireClosedRecord(value, AUTHORITY_KEYS, 'must be a closed authority record');
  requireClosedRecord(value.ceilings, CEILING_KEYS, 'must declare closed ceilings');
  if (typeof value.packId !== 'string' || !IDENTITY.test(value.packId) ||
      value.packId.length > 64) {
    fail('must name an approved packId');
  }
  if (typeof value.version !== 'string' || !VERSION.test(value.version) ||
      value.version.length > 64) {
    fail('must name an approved version');
  }
  // The download path only tracks entitlement-gated packs; free packs install
  // through the bundled starter path and never appear here.
  if (typeof value.requiredEntitlementId !== 'string' ||
      !IDENTITY.test(value.requiredEntitlementId) ||
      value.requiredEntitlementId.length > 64) {
    fail('must bind to an approved entitlement');
  }
  if (typeof value.archiveName !== 'string' || !ARCHIVE_NAME.test(value.archiveName)) {
    fail('must name an approved archive');
  }
  if (
    !Array.isArray(value.allowedExtensions) ||
    value.allowedExtensions.length === 0 ||
    value.allowedExtensions.some((extension) =>
      typeof extension !== 'string' || !/^\.[a-z0-9]{1,8}$/u.test(extension)) ||
    new Set(value.allowedExtensions).size !== value.allowedExtensions.length
  ) {
    fail('must declare approved extensions');
  }
  if (CEILING_KEYS.some((key) => !requirePositiveInteger(value.ceilings[key]))) {
    fail('must declare positive ceilings');
  }
  if (!SHA256.test(value.manifestSha256) || !SHA256.test(value.archiveSha256)) {
    fail('must pin object digests');
  }
  if (!ETAG.test(value.manifestEtag) || !ETAG.test(value.archiveEtag)) {
    fail('must pin object etags');
  }
  if (!requirePositiveInteger(value.manifestBytes) ||
      !requirePositiveInteger(value.archiveBytes)) {
    fail('must pin object sizes');
  }
  if (value.archiveBytes > value.ceilings.compressedBytes) {
    fail('must keep the archive inside its compressed ceiling');
  }
  return Object.freeze({
    packId: value.packId,
    version: value.version,
    requiredEntitlementId: value.requiredEntitlementId,
    archiveName: value.archiveName,
    allowedExtensions: Object.freeze([...value.allowedExtensions]),
    ceilings: Object.freeze({
      fileCount: value.ceilings.fileCount,
      compressedBytes: value.ceilings.compressedBytes,
      extractedBytes: value.ceilings.extractedBytes,
    }),
    manifestSha256: value.manifestSha256,
    manifestBytes: value.manifestBytes,
    manifestEtag: value.manifestEtag,
    archiveSha256: value.archiveSha256,
    archiveBytes: value.archiveBytes,
    archiveEtag: value.archiveEtag,
  });
}

// The b3 row joins the two frozen configs: config/b3-proof-pack.json names the
// pack identity/ceilings, config/b3-pack-object-authority.json the R2 object
// facts. Both files are byte-frozen evidence (hashed into the committed
// deterministic proof report), so the registry reads them rather than moving them.
function readB3Row() {
  const archive = b3PackObjectAuthority?.objects?.find?.((entry) => entry?.role === 'archive');
  const manifest = b3PackObjectAuthority?.objects?.find?.(
    (entry) => entry?.role === 'signed-manifest',
  );
  if (
    b3ProofPack?.schemaVersion !== 1 ||
    b3PackObjectAuthority?.schemaVersion !== 1 ||
    b3ProofPack.packId !== b3PackObjectAuthority.packId ||
    b3ProofPack.version !== b3PackObjectAuthority.version ||
    !Array.isArray(b3PackObjectAuthority.objects) ||
    b3PackObjectAuthority.objects.length !== 2 ||
    !archive ||
    !manifest ||
    archive.key !==
      `packs/${b3ProofPack.packId}/${b3ProofPack.version}/${b3ProofPack.archiveName}` ||
    manifest.key !==
      `packs/${b3ProofPack.packId}/${b3ProofPack.version}/signed-manifest.json` ||
    manifest.sha256 !== b3ProofPack.signedEnvelopeSha256
  ) {
    fail('configuration is inconsistent');
  }
  return assertPackAuthority({
    packId: b3ProofPack.packId,
    version: b3ProofPack.version,
    requiredEntitlementId: b3ProofPack.requiredEntitlementId,
    archiveName: b3ProofPack.archiveName,
    allowedExtensions: b3ProofPack.allowedExtensions,
    ceilings: b3ProofPack.ceilings,
    manifestSha256: manifest.sha256,
    manifestBytes: manifest.bytes,
    manifestEtag: manifest.etag,
    archiveSha256: archive.sha256,
    archiveBytes: archive.bytes,
    archiveEtag: archive.etag,
  });
}

// Downloadable shard rows are config-only: after the owner signing ceremony
// and R2 upload, each shard's object facts (signed-envelope sha/bytes/etag and
// archive sha/bytes/etag from the tracked authoring report) are appended to
// config/downloadable-pack-authorities.json and appear here without a code
// change. Rows are validated by the same closed authority contract as b3.
export function readDownloadablePackRows(table = downloadablePackAuthorities) {
  if (table?.schemaVersion !== 1 || !Array.isArray(table.packs)) {
    fail('table is not the approved downloadable-pack document');
  }
  return table.packs.map((row) => assertPackAuthority(row));
}

export const PACK_REGISTRY = Object.freeze([
  readB3Row(),
  ...readDownloadablePackRows(),
]);

if (
  new Set(PACK_REGISTRY.map(({ packId }) => packId)).size !== PACK_REGISTRY.length
) {
  fail('registry rows must be unique per packId');
}

export function findPackAuthority(packId, registry = PACK_REGISTRY) {
  if (!Array.isArray(registry)) fail('registry must be a table');
  const row = registry.find((candidate) => candidate?.packId === packId) ?? null;
  if (!row) fail('is not registered');
  return assertPackAuthority(row);
}
