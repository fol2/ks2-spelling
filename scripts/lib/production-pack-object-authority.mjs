import { createHash, createPublicKey, verify } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseJsonWithoutDuplicateMembers } from '../../src/domain/packs/signed-manifest-contract.js';
import { verifySignedPackManifest } from '../../src/domain/packs/pack-signature-verifier.js';

export const PRODUCTION_PACK_OBJECT_AUTHORITY_RELATIVE =
  'config/ks2-pack-object-authority-production.json';
export const PRODUCTION_GATEWAY_AUTHORITY_RELATIVE =
  'config/ks2-gateway-authority-production.json';
export const PRODUCTION_PACK_SIGNING_KEYRING_RELATIVE =
  'config/production/pack-signing-public-keys.json';
export const PRODUCTION_PACK_OBJECT_BUCKET = 'ks2-spelling-production-packs';
export const PRODUCTION_PACK_OBJECT_SCHEMA_VERSION = 1;
export const PRODUCTION_PACK_VERSION = '1.0.0';
export const PRODUCTION_SIGNING_KEY_ID = 'production-ks2-p256-2026-08';
export const PRODUCTION_PACK_OBJECT_ROLES = Object.freeze(['archive', 'signed-manifest']);
export const PRODUCTION_PACK_IDS = Object.freeze(
  Array.from({ length: 15 }, (_, index) => `full-ks2-shard-${String(index + 1).padStart(2, '0')}`),
);
export const PRODUCTION_PACK_OBJECT_FORBIDDEN_SUBSTRINGS = Object.freeze([
  'b3-sandbox-proof',
  'ks2-spelling-b3-sandbox-packs',
  'b3-test-p256-2026-07',
  'b3-gateway.eugnel.uk',
  'b3-role',
  'b3-sha256',
  'b3-envelope-sha256',
  'b3-size',
]);

const DOCUMENT_KEYS = Object.freeze(['schemaVersion', 'bucketName', 'packs']);
const PACK_KEYS = Object.freeze(['packId', 'version', 'objects']);
const OBJECT_KEYS = Object.freeze(['role', 'key', 'bytes', 'sha256', 'etag', 'metadata']);
const SHA256 = /^[a-f0-9]{64}$/u;
const ETAG = /^[a-f0-9]{32}$/u;
const IDENTITY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/u;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;

function fail(detail) {
  throw new TypeError(`Production pack-object authority ${detail}.`);
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
    actualKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    fail(detail);
  }
  return value;
}

export function digestHex(bytes, algorithm) {
  return createHash(algorithm).update(bytes).digest('hex');
}

export function hashObjectBytes(bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    fail('live object bytes must be a byte array');
  }
  const buffer = Buffer.from(bytes);
  return Object.freeze({
    bytes: buffer.length,
    sha256: digestHex(buffer, 'sha256'),
    etag: digestHex(buffer, 'md5'),
  });
}

export function archiveNameForPack(packId, version = PRODUCTION_PACK_VERSION) {
  return `${packId}-${version}.zip`;
}

export function expectedObjectKey(packId, role, version = PRODUCTION_PACK_VERSION) {
  if (role === 'archive') {
    return `packs/${packId}/${version}/${archiveNameForPack(packId, version)}`;
  }
  if (role === 'signed-manifest') {
    return `packs/${packId}/${version}/signed-manifest.json`;
  }
  fail(`must not name role ${role}`);
}

export function expectedProductionObjectKeys() {
  return Object.freeze(
    PRODUCTION_PACK_IDS.flatMap((packId) => PRODUCTION_PACK_OBJECT_ROLES.map(
      (role) => expectedObjectKey(packId, role),
    )),
  );
}

export function serialiseProductionPackObjectAuthority(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function assertProductionPackObjectIdentities(text) {
  if (typeof text !== 'string' || text.length === 0) {
    fail('must serialise to text');
  }
  for (const forbidden of PRODUCTION_PACK_OBJECT_FORBIDDEN_SUBSTRINGS) {
    if (text.includes(forbidden)) {
      fail(`must not contain sandbox identity ${forbidden}`);
    }
  }
  return text;
}

function assertObjectRecord(value, packId, role) {
  requireClosedRecord(value, OBJECT_KEYS, 'object must be a closed record');
  const expectedKey = expectedObjectKey(packId, role);
  if (value.role !== role) fail(`object role must be ${role}`);
  if (value.key !== expectedKey) fail(`object key must be ${expectedKey}`);
  const maxBytes = role === 'archive' ? MAX_ARCHIVE_BYTES : MAX_MANIFEST_BYTES;
  if (!Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > maxBytes) {
    fail(`${role} byte count is outside the approved bound`);
  }
  if (typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) {
    fail(`${role} SHA-256 is invalid`);
  }
  if (typeof value.etag !== 'string' || !ETAG.test(value.etag)) {
    fail(`${role} etag is invalid`);
  }
  requireClosedRecord(value.metadata, [], `${role} metadata must be empty`);
  return value;
}

function assertPackRecord(value, packId) {
  requireClosedRecord(value, PACK_KEYS, 'pack must be a closed record');
  if (value.packId !== packId || typeof value.packId !== 'string' || !IDENTITY.test(value.packId)) {
    fail(`must name pack ${packId}`);
  }
  if (value.version !== PRODUCTION_PACK_VERSION || !VERSION.test(value.version)) {
    fail(`pack ${packId} must use version ${PRODUCTION_PACK_VERSION}`);
  }
  if (!Array.isArray(value.objects) || value.objects.length !== PRODUCTION_PACK_OBJECT_ROLES.length) {
    fail(`pack ${packId} must declare exactly two objects`);
  }
  PRODUCTION_PACK_OBJECT_ROLES.forEach((role, index) => {
    assertObjectRecord(value.objects[index], packId, role);
  });
  return value;
}

export function assertProductionPackObjectAuthority(value) {
  requireClosedRecord(value, DOCUMENT_KEYS, 'must be a closed document');
  if (value.schemaVersion !== PRODUCTION_PACK_OBJECT_SCHEMA_VERSION) {
    fail('schemaVersion must be 1');
  }
  if (value.bucketName !== PRODUCTION_PACK_OBJECT_BUCKET) {
    fail('must name the live production bucket');
  }
  if (!Array.isArray(value.packs) || value.packs.length !== PRODUCTION_PACK_IDS.length) {
    fail('must cover exactly the fifteen Full-KS2 shard packs');
  }
  PRODUCTION_PACK_IDS.forEach((packId, index) => {
    assertPackRecord(value.packs[index], packId);
  });
  const keys = value.packs.flatMap((pack) => pack.objects.map((object) => object.key));
  if (new Set(keys).size !== expectedProductionObjectKeys().length) {
    fail('must cover exactly thirty distinct object keys');
  }
  assertProductionPackObjectIdentities(serialiseProductionPackObjectAuthority(value));
  return structuredClone(value);
}

export function assertProductionPackObjectAuthorityBytes(bytes, label = 'production pack-object authority') {
  const document = parseJsonWithoutDuplicateMembers(bytes, label);
  assertProductionPackObjectAuthority(document);
  const serialised = serialiseProductionPackObjectAuthority(document);
  const actual = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!actual.equals(Buffer.from(serialised, 'utf8'))) {
    fail('committed bytes must match the canonical serialisation');
  }
  return document;
}

export async function readProductionPackObjectAuthority(root) {
  const bytes = await readFile(resolve(root, PRODUCTION_PACK_OBJECT_AUTHORITY_RELATIVE));
  return assertProductionPackObjectAuthorityBytes(bytes);
}

export async function assertProductionPackObjectAuthorityMatchesGateway(root, document) {
  const gateway = parseJsonWithoutDuplicateMembers(
    await readFile(resolve(root, PRODUCTION_GATEWAY_AUTHORITY_RELATIVE)),
    'production gateway authority',
  );
  if (gateway.privateR2BucketName !== PRODUCTION_PACK_OBJECT_BUCKET) {
    fail('production gateway authority names a different bucket');
  }
  if (document.bucketName !== gateway.privateR2BucketName) {
    fail('bucket name must match the production gateway authority');
  }
  return true;
}

function normaliseListingObject(entry) {
  const key = entry?.key;
  const size = entry?.size ?? entry?.bytes;
  const etag = String(entry?.etag ?? '').replaceAll('"', '').toLowerCase();
  const customMetadata = entry?.custom_metadata ?? entry?.customMetadata ?? entry?.metadata;
  if (typeof key !== 'string' || key.length === 0) fail('live listing is missing an object key');
  if (!Number.isSafeInteger(size) || size <= 0) fail(`live object ${key} has no byte count`);
  if (!ETAG.test(etag)) fail(`live object ${key} has no single-part etag`);
  if (
    customMetadata == null
    || typeof customMetadata !== 'object'
    || Array.isArray(customMetadata)
    || Object.keys(customMetadata).length !== 0
  ) {
    fail(`live object ${key} must declare empty custom metadata`);
  }
  return Object.freeze({ key, size, etag, metadata: Object.freeze({}) });
}

export const PRODUCTION_VERIFICATION_INSTANT = new Date('2026-08-21T00:00:00.000Z');

export function canonicalCeremonyObjectPath(ceremonyDir, key) {
  return join(ceremonyDir, key);
}

export function verifyP256DerWithNodeCrypto({ publicKeySpkiDer, signatureDer, signingInput }) {
  return verify(
    'sha256',
    signingInput,
    createPublicKey({ key: publicKeySpkiDer, format: 'der', type: 'spki' }),
    signatureDer,
  );
}

export async function readProductionPackSigningKeyring(root, readFileImpl = readFile) {
  return parseJsonWithoutDuplicateMembers(
    await readFileImpl(resolve(root, PRODUCTION_PACK_SIGNING_KEYRING_RELATIVE)),
    'production pack-signing public keys',
  );
}

function parseSignedManifestEnvelopeOrFail(bytes, key) {
  try {
    return parseJsonWithoutDuplicateMembers(bytes, key);
  } catch {
    fail(`${key} is not a closed signed-manifest envelope`);
  }
}

export async function verifyProductionSignedManifestEnvelope({
  envelopeBytes,
  key,
  keyring,
  clock = () => new Date(PRODUCTION_VERIFICATION_INSTANT),
  verifyP256Der = verifyP256DerWithNodeCrypto,
}) {
  if (!keyring) fail('production signing keyring is missing');
  const label = key ?? 'signed-manifest';
  const envelope = parseSignedManifestEnvelopeOrFail(envelopeBytes, label);
  if (envelope?.keyId !== PRODUCTION_SIGNING_KEY_ID) {
    fail(`${label} is signed by ${envelope?.keyId ?? 'no key'}, not ${PRODUCTION_SIGNING_KEY_ID}`);
  }
  try {
    return await verifySignedPackManifest({
      envelopeBytes,
      keyring,
      environment: 'production',
      clock,
      verifyP256Der,
    });
  } catch (error) {
    fail(`${label} failed verifySignedPackManifest: ${error.message}`);
  }
}

export async function listCeremonyRelativeFiles(ceremonyDir, { readdirImpl = readdir } = {}) {
  const files = [];
  async function walk(current, relative) {
    let entries;
    try {
      entries = await readdirImpl(current, { withFileTypes: true });
    } catch (error) {
      fail(`cannot read ceremony directory ${relative || '.'}: ${error.message}`);
    }
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) fail(`must not contain symlink ${rel}`);
      if (entry.isDirectory()) {
        await walk(path, rel);
      } else if (entry.isFile()) {
        files.push(rel);
      } else {
        fail(`must not contain unexpected entry ${rel}`);
      }
    }
  }
  await walk(ceremonyDir, '');
  return files.sort();
}

export async function readCompleteCeremonyDirectory({
  ceremonyDir,
  readFileImpl = readFile,
  readdirImpl = readdir,
}) {
  if (typeof ceremonyDir !== 'string' || ceremonyDir.length === 0) {
    fail('requires a complete ceremony directory');
  }
  const expectedKeys = expectedProductionObjectKeys();
  const actual = await listCeremonyRelativeFiles(ceremonyDir, { readdirImpl });
  const actualSet = new Set(actual);
  const expectedSet = new Set(expectedKeys);
  const missing = expectedKeys.filter((key) => !actualSet.has(key));
  const extra = actual.filter((key) => !expectedSet.has(key));
  if (missing.length > 0 || extra.length > 0) {
    const details = [];
    if (missing.length > 0) details.push(`missing ${missing.join(', ')}`);
    if (extra.length > 0) details.push(`extra ${extra.join(', ')}`);
    fail(
      'ceremony directory must contain exactly 15 archives and 15 signed-manifest envelopes ' +
        `in the canonical packs/<packId>/<version>/ layout (${details.join('; ')})`,
    );
  }
  const bytesByKey = new Map();
  for (const key of expectedKeys) {
    try {
      const bytes = await readFileImpl(canonicalCeremonyObjectPath(ceremonyDir, key));
      if (bytes == null) fail(`cannot read ceremony object ${key}: reader returned no bytes`);
      bytesByKey.set(key, Buffer.from(bytes));
    } catch (error) {
      if (error instanceof TypeError && String(error.message).startsWith('Production pack-object authority')) {
        throw error;
      }
      fail(`cannot read ceremony object ${key}: ${error.message}`);
    }
  }
  return bytesByKey;
}

export function crossCheckLocalCeremonyBytes({
  key,
  localBytes,
  liveBytes,
  liveSha256,
  liveEtag,
}) {
  if (localBytes == null) fail(`ceremony is missing ${key}`);
  const local = hashObjectBytes(localBytes);
  if (local.etag !== liveEtag) {
    fail(`local ceremony MD5 for ${key} differs from the live single-part etag`);
  }
  if (local.sha256 !== liveSha256 || local.bytes !== liveBytes) {
    fail(`local ceremony bytes for ${key} differ from the live object`);
  }
  return true;
}

function assertCompleteCeremonyInventory(ceremonyBytesByKey, expectedKeys) {
  if (ceremonyBytesByKey == null) return;
  if (!(ceremonyBytesByKey instanceof Map)) {
    fail('ceremony inventory must be a complete key map');
  }
  for (const key of expectedKeys) {
    if (!ceremonyBytesByKey.has(key) || ceremonyBytesByKey.get(key) == null) {
      fail(`ceremony is missing ${key}`);
    }
  }
  for (const key of ceremonyBytesByKey.keys()) {
    if (!expectedKeys.includes(key)) fail(`ceremony contains unexpected object ${key}`);
  }
  if (ceremonyBytesByKey.size !== expectedKeys.length) {
    fail(`ceremony must contain exactly ${expectedKeys.length} objects`);
  }
}

export async function buildProductionPackObjectAuthorityFromLive({
  listObjects,
  getObject,
  ceremonyBytesByKey,
  keyring,
  clock = () => new Date(PRODUCTION_VERIFICATION_INSTANT),
  verifyP256Der = verifyP256DerWithNodeCrypto,
}) {
  if (typeof listObjects !== 'function' || typeof getObject !== 'function') {
    fail('live object reader is missing');
  }
  if (!keyring) fail('production signing keyring is missing');
  const listing = (await listObjects()).map(normaliseListingObject);
  const listingByKey = new Map(listing.map((entry) => [entry.key, entry]));
  const expectedKeys = expectedProductionObjectKeys();
  if (listingByKey.size !== expectedKeys.length) {
    fail(`live bucket must contain exactly ${expectedKeys.length} objects, not ${listingByKey.size}`);
  }
  for (const key of expectedKeys) {
    if (!listingByKey.has(key)) fail(`live bucket is missing ${key}`);
  }
  for (const key of listingByKey.keys()) {
    if (!expectedKeys.includes(key)) fail(`live bucket contains unexpected object ${key}`);
  }
  assertCompleteCeremonyInventory(ceremonyBytesByKey, expectedKeys);

  const packs = [];
  for (const packId of PRODUCTION_PACK_IDS) {
    const objects = [];
    for (const role of PRODUCTION_PACK_OBJECT_ROLES) {
      const key = expectedObjectKey(packId, role);
      const live = listingByKey.get(key);
      const bytes = Buffer.from(await getObject(key));
      const hashed = hashObjectBytes(bytes);
      if (hashed.bytes !== live.size) fail(`live GET byte count for ${key} differs from the listing`);
      if (hashed.etag !== live.etag) {
        fail(`live GET MD5 for ${key} differs from the single-part listing etag`);
      }
      if (ceremonyBytesByKey) {
        crossCheckLocalCeremonyBytes({
          key,
          localBytes: ceremonyBytesByKey.get(key),
          liveBytes: hashed.bytes,
          liveSha256: hashed.sha256,
          liveEtag: hashed.etag,
        });
      }
      if (role === 'signed-manifest') {
        await verifyProductionSignedManifestEnvelope({
          envelopeBytes: bytes,
          key,
          keyring,
          clock,
          verifyP256Der,
        });
      }
      objects.push({
        role,
        key,
        bytes: hashed.bytes,
        sha256: hashed.sha256,
        etag: hashed.etag,
        metadata: {},
      });
    }
    packs.push({
      packId,
      version: PRODUCTION_PACK_VERSION,
      objects,
    });
  }

  return assertProductionPackObjectAuthority({
    schemaVersion: PRODUCTION_PACK_OBJECT_SCHEMA_VERSION,
    bucketName: PRODUCTION_PACK_OBJECT_BUCKET,
    packs,
  });
}

export function assertDocumentsMatch(actual, expected, detail = 'differs from the committed document') {
  const left = serialiseProductionPackObjectAuthority(assertProductionPackObjectAuthority(actual));
  const right = serialiseProductionPackObjectAuthority(assertProductionPackObjectAuthority(expected));
  if (left !== right) fail(detail);
  return true;
}
