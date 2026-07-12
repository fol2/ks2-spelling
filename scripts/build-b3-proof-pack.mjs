import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateDataOnlyInventory } from '../src/domain/packs/data-only-pack-contract.js';
import { canonicaliseRfc8785Bytes } from '../src/domain/packs/rfc8785.js';
import {
  PACK_SIGNING_ALGORITHM,
  PACK_SIGNING_DOMAIN,
} from '../src/domain/packs/signed-manifest-contract.js';
import { verifySignedPackManifest } from '../src/domain/packs/pack-signature-verifier.js';
import { verifyHostileZipCorpus } from '../tests/helpers/hostile-zip-builder.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUTPUT = resolve(ROOT, '.native-build/b3/pack');
const UTF8_FLAG = 0x0800;
const REGULAR_MODE = 0o100644;
const SOURCE_ROOT = resolve(ROOT, 'tests/fixtures/b3-pack-source');
const SOURCE_PATHS = Object.freeze(['audio/proof-word.m4a', 'catalogue.json']);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function fail(detail) {
  throw new Error(`B3 proof-pack verify-only builder ${detail}.`);
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function digest(bytes, algorithm = 'sha256') {
  return createHash(algorithm).update(bytes).digest('hex');
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function equalBytes(left, right) {
  return left.length === right.length && left.equals(right);
}

function parseArguments(arguments_) {
  let outputDirectory = DEFAULT_OUTPUT;
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    if (option === '--output-directory') {
      const value = arguments_[index + 1];
      if (!value || value.startsWith('--')) fail('requires a value for --output-directory');
      outputDirectory = resolve(value);
      index += 1;
    } else {
      fail(`does not support authoring or signing option ${JSON.stringify(option)}`);
    }
  }
  return outputDirectory;
}

function createStoredZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8');
    const checksum = crc32(file.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x5c2c, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(file.bytes.length, 18);
    local.writeUInt32LE(file.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, file.bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x5c2c, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(file.bytes.length, 20);
    central.writeUInt32LE(file.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((REGULAR_MODE << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + file.bytes.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(ROOT, path), 'utf8'));
}

function objectAuthority({ config, archive, signedEnvelope }) {
  const baseKey = `packs/${config.packId}/${config.version}`;
  const records = [
    {
      role: 'archive',
      key: `${baseKey}/${config.archiveName}`,
      bytes: archive.length,
      sha256: digest(archive),
      etag: digest(archive, 'md5'),
    },
    {
      role: 'signed-manifest',
      key: `${baseKey}/signed-manifest.json`,
      bytes: signedEnvelope.length,
      sha256: digest(signedEnvelope),
      etag: digest(signedEnvelope, 'md5'),
    },
  ];
  return {
    schemaVersion: 1,
    bucketName: 'ks2-spelling-b3-sandbox-packs',
    packId: config.packId,
    version: config.version,
    objects: records.map((record) => ({
      ...record,
      metadata: {
        'b3-role': record.role,
        'b3-sha256': record.sha256,
        'b3-size': String(record.bytes),
        ...(record.role === 'signed-manifest'
          ? { 'b3-envelope-sha256': record.sha256 }
          : {}),
      },
    })),
  };
}

const outputDirectory = parseArguments(process.argv.slice(2));
const config = await readJson('config/b3-proof-pack.json');
const keyring = await readJson('config/pack-signing-public-keys.json');
const hostileCorpus = await verifyHostileZipCorpus(
  resolve(ROOT, 'tests/fixtures/b3-hostile-zips'),
);
const hostileManifestBytes = hostileCorpus.manifestBytes;
const hostileManifest = JSON.parse(hostileManifestBytes);
const files = await Promise.all(SOURCE_PATHS.map(async (path) => ({
  path,
  bytes: await readFile(resolve(SOURCE_ROOT, path)),
})));
const archive = createStoredZip(files);
const manifest = {
  schemaVersion: 1,
  packId: config.packId,
  version: config.version,
  requiredEntitlementId: config.requiredEntitlementId,
  archive: {
    name: config.archiveName,
    sha256: digest(archive),
    bytes: archive.length,
  },
  allowedExtensions: config.allowedExtensions,
  ceilings: config.ceilings,
  files: files.map((file) => ({
    path: file.path,
    sha256: digest(file.bytes),
    bytes: file.bytes.length,
  })),
};
validateDataOnlyInventory({
  manifest: {
    allowedExtensions: manifest.allowedExtensions,
    ceilings: manifest.ceilings,
    files: manifest.files,
  },
  entries: files.map((file) => ({
    path: file.path,
    compressedBytes: file.bytes.length,
    extractedBytes: file.bytes.length,
  })),
});

const canonicalManifest = Buffer.from(canonicaliseRfc8785Bytes(manifest));
const signatureDer = await readFile(
  resolve(ROOT, 'tests/fixtures/keys/b3-sandbox-proof-manifest-signature.der'),
);
if (digest(signatureDer) !== config.signatureDerSha256) {
  fail('rejected a DER signature whose frozen SHA-256 does not match config');
}
const candidateEnvelope = jsonBytes({
  schemaVersion: 1,
  algorithm: PACK_SIGNING_ALGORITHM,
  keyId: config.signingKeyId,
  payloadEncoding: 'RFC8785_UTF8',
  domain: PACK_SIGNING_DOMAIN,
  canonicalManifestBase64: canonicalManifest.toString('base64'),
  signatureDerBase64: signatureDer.toString('base64'),
});
const signedEnvelope = await readFile(resolve(ROOT, 'tests/fixtures/b3-signed-manifest.json'));
if (!equalBytes(candidateEnvelope, signedEnvelope)) {
  fail('rejected generated envelope bytes that differ from the committed fixture');
}
if (digest(signedEnvelope) !== config.signedEnvelopeSha256) {
  fail('rejected a signed envelope whose frozen SHA-256 does not match config');
}

const publicKey = createPublicKey({
  key: Buffer.from(keyring.keys[0].publicKeySpkiDerBase64, 'base64'),
  format: 'der',
  type: 'spki',
});
const verification = await verifySignedPackManifest({
  envelopeBytes: signedEnvelope,
  keyring,
  environment: 'sandbox',
  clock: () => new Date('2026-07-12T12:00:00.000Z'),
  verifyP256Der: async ({ signatureDer: signature, signingInput }) =>
    verify('sha256', signingInput, publicKey, signature),
});
if (
  verification.manifest.packId !== config.packId ||
  verification.manifest.version !== config.version ||
  verification.keyId !== config.signingKeyId
) {
  fail('rejected signed manifest identity drift');
}

const authority = objectAuthority({ config, archive, signedEnvelope });
const report = {
  schemaVersion: 1,
  status: 'pass',
  environment: 'sandbox',
  builderMode: 'verify-only',
  packId: config.packId,
  version: config.version,
  source: files.map((file) => ({
    path: file.path,
    sha256: digest(file.bytes),
    bytes: file.bytes.length,
  })),
  archive: {
    file: config.archiveName,
    sha256: digest(archive),
    bytes: archive.length,
    etag: digest(archive, 'md5'),
  },
  canonicalManifest: {
    file: 'canonical-manifest.json',
    sha256: digest(canonicalManifest),
    bytes: canonicalManifest.length,
  },
  signatureDer: {
    keyId: config.signingKeyId,
    algorithm: PACK_SIGNING_ALGORITHM,
    sha256: digest(signatureDer),
    bytes: signatureDer.length,
  },
  signedEnvelope: {
    file: 'signed-manifest.json',
    sha256: digest(signedEnvelope),
    bytes: signedEnvelope.length,
    etag: digest(signedEnvelope, 'md5'),
  },
  hostileZipCorpus: {
    manifestSha256: digest(hostileManifestBytes),
    fixtureCount: hostileManifest.fixtures.length,
    categories: hostileManifest.fixtures.map(({ category }) => category),
  },
};
const reportBytes = jsonBytes(report);
const authorityBytes = jsonBytes(authority);
const trackedReportBytes = await readFile(resolve(ROOT, 'reports/b3/b3-proof-pack-build.json'));
const trackedAuthorityBytes = await readFile(
  resolve(ROOT, 'config/b3-pack-object-authority.json'),
);
if (!equalBytes(reportBytes, trackedReportBytes)) {
  fail('rejected proof-pack report drift from the committed authority');
}
if (!equalBytes(authorityBytes, trackedAuthorityBytes)) {
  fail('rejected private-R2 object drift from the committed authority');
}

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(resolve(outputDirectory, config.archiveName), archive),
  writeFile(resolve(outputDirectory, 'canonical-manifest.json'), canonicalManifest),
  writeFile(resolve(outputDirectory, 'signed-manifest.json'), signedEnvelope),
  writeFile(resolve(outputDirectory, 'b3-proof-pack-build.json'), reportBytes),
]);

process.stdout.write(
  `B3 proof pack verified: ${digest(archive)} ${digest(signedEnvelope)}\n`,
);
