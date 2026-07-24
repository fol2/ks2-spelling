import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import payloadAuthority from '../config/starter-pack-payload.json' with { type: 'json' };
import { validateDataOnlyInventory } from '../src/domain/packs/data-only-pack-contract.js';
import { canonicaliseRfc8785Bytes } from '../src/domain/packs/rfc8785.js';
import { loadStarterSpellingCatalogue } from '../src/domain/spelling/index.js';
import { validateStarterAudioEvidence } from './lib/starter-audio-evidence.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_ROOT = resolve(ROOT, '.native-build/c1/starter-pack');
const REPORT_TARGET = resolve(ROOT, 'reports/c1/starter-pack-build.json');
const UTF8_FLAG = 0x0800;
const REGULAR_MODE = 0o100644;
const MAXIMUM_SOURCE_BYTES = 2 * 1_024 * 1_024;
const MAXIMUM_AUDIO_BYTES = 2 * 1_024 * 1_024;
const AUTHORITY_KEYS = Object.freeze([
  'schemaVersion',
  'packId',
  'catalogueId',
  'version',
  'archiveName',
  'requiredEntitlementId',
  'signingState',
  'allowedExtensions',
  'ceilings',
  'catalogueSource',
  'audioSourceRoot',
  'audioEvidenceSource',
]);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function fail(detail, options) {
  throw new Error(`Starter pack builder ${detail}.`, options);
}

function exactKeys(value, keys, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    fail(`${label} must contain exactly the reviewed fields`);
  }
}

function validateAuthority(value) {
  exactKeys(value, AUTHORITY_KEYS, 'authority');
  exactKeys(
    value.ceilings,
    ['fileCount', 'compressedBytes', 'extractedBytes'],
    'ceilings',
  );
  if (
    value.schemaVersion !== 1 ||
    value.packId !== 'ks2-core' ||
    value.catalogueId !== 'ks2-core:starter' ||
    value.version !== '1.0.0' ||
    value.archiveName !== 'ks2-core-starter-1.0.0.zip' ||
    value.requiredEntitlementId !== null ||
    value.signingState !== 'deferred-to-final-visible-owner-gate' ||
    JSON.stringify(value.allowedExtensions) !== JSON.stringify(['.json', '.m4a']) ||
    value.ceilings.fileCount !== 841 ||
    value.ceilings.compressedBytes !== 16 * 1_024 * 1_024 ||
    value.ceilings.extractedBytes !== 16 * 1_024 * 1_024 ||
    value.catalogueSource !==
      'vendor/ks2-mastery/content/spelling.mobile-runtime-starter.json' ||
    value.audioSourceRoot !== 'content/starter-pack' ||
    value.audioEvidenceSource !== 'reports/c1/starter-audio-evidence.json'
  ) {
    fail('authority identity, free-access boundary or ceilings drifted');
  }
  return value;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

async function readBoundedRegular(path, maximumBytes) {
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size <= 0 ||
    before.size > maximumBytes
  ) {
    fail(`rejected unsafe or oversized source ${relative(ROOT, path)}`);
  }
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (
    bytes.byteLength !== before.size ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs
  ) {
    fail(`rejected changing source ${relative(ROOT, path)}`);
  }
  return bytes;
}

async function inventoryFiles(root) {
  const paths = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) fail('rejected a symbolic-link payload source');
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        paths.push(relative(root, path).split(sep).join('/'));
      } else {
        fail('rejected a non-regular payload source');
      }
    }
  }
  await visit(root);
  return paths.sort();
}

function createStoredZip(files) {
  if (files.length === 0 || files.length > 65_535) {
    fail('file count cannot be represented by the bounded ZIP format');
  }
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8');
    if (
      name.length === 0 ||
      name.length > 65_535 ||
      file.bytes.length > 0xffff_ffff ||
      offset > 0xffff_ffff
    ) {
      fail('payload member exceeds the bounded ZIP32 format');
    }
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
  if (offset + central.length + 22 > 0xffff_ffff) {
    fail('archive exceeds the bounded ZIP32 format');
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

function parseArguments(arguments_) {
  if (arguments_.length === 0) return { initialiseReport: false };
  if (arguments_.length === 1 && arguments_[0] === '--initialise-report') {
    return { initialiseReport: true };
  }
  fail('supports only no arguments or --initialise-report');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const authority = validateAuthority(payloadAuthority);
  const cataloguePath = resolve(ROOT, authority.catalogueSource);
  const audioRoot = resolve(ROOT, authority.audioSourceRoot, 'audio');
  const evidencePath = resolve(ROOT, authority.audioEvidenceSource);
  const [catalogueBytes, evidenceBytes] = await Promise.all([
    readBoundedRegular(cataloguePath, MAXIMUM_SOURCE_BYTES),
    readBoundedRegular(evidencePath, MAXIMUM_SOURCE_BYTES),
  ]);
  let parsedCatalogue;
  let parsedEvidence;
  try {
    parsedCatalogue = JSON.parse(catalogueBytes);
    parsedEvidence = JSON.parse(evidenceBytes);
  } catch (cause) {
    fail('source authority is not valid JSON', { cause });
  }
  const catalogue = loadStarterSpellingCatalogue();
  if (JSON.stringify(parsedCatalogue) !== JSON.stringify(catalogue)) {
    fail('catalogue bytes differ from the frozen runtime catalogue');
  }
  validateStarterAudioEvidence(parsedEvidence, { catalogue });
  const expectedAudioPaths = parsedEvidence.assets
    .map(({ assetPath }) => assetPath.slice('audio/'.length))
    .sort();
  if (
    parsedEvidence.assets.some(({ assetPath }) => !assetPath.startsWith('audio/')) ||
    JSON.stringify(await inventoryFiles(audioRoot)) !== JSON.stringify(expectedAudioPaths)
  ) {
    fail('audio payload has a missing or orphaned member');
  }

  const audioFiles = await Promise.all(parsedEvidence.assets.map(async (record) => {
    const bytes = await readBoundedRegular(
      resolve(ROOT, authority.audioSourceRoot, record.assetPath),
      MAXIMUM_AUDIO_BYTES,
    );
    if (bytes.length !== record.byteSize || digest(bytes) !== record.sha256) {
      fail(`audio payload drifted at ${record.assetPath}`);
    }
    return { path: record.assetPath, bytes };
  }));
  const files = [
    { path: 'catalogue.json', bytes: catalogueBytes },
    ...audioFiles,
  ];
  const archive = createStoredZip(files);
  const manifest = {
    schemaVersion: 1,
    packId: authority.packId,
    version: authority.version,
    requiredEntitlementId: authority.requiredEntitlementId,
    archive: {
      name: authority.archiveName,
      sha256: digest(archive),
      bytes: archive.length,
    },
    allowedExtensions: authority.allowedExtensions,
    ceilings: authority.ceilings,
    files: files.map((file) => ({
      path: file.path,
      sha256: digest(file.bytes),
      bytes: file.bytes.length,
    })),
  };
  const inventory = validateDataOnlyInventory({
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
  if (
    archive.length > authority.ceilings.compressedBytes ||
    inventory.fileCount !== authority.ceilings.fileCount
  ) {
    fail('archive exceeds its reviewed ceiling or exact file count');
  }
  const canonicalManifest = Buffer.from(canonicaliseRfc8785Bytes(manifest));
  if (canonicalManifest.length > 1_048_576) {
    fail('canonical manifest exceeds the native signed-envelope bound');
  }
  const report = {
    schemaVersion: 1,
    status: 'pass',
    artifactKind: 'unsigned-production-payload-handoff',
    signingStatus: authority.signingState,
    packId: authority.packId,
    version: authority.version,
    catalogueId: authority.catalogueId,
    source: {
      catalogue: {
        path: authority.catalogueSource,
        sha256: digest(catalogueBytes),
        bytes: catalogueBytes.length,
      },
      audioEvidence: {
        path: authority.audioEvidenceSource,
        sha256: digest(evidenceBytes),
        bytes: evidenceBytes.length,
        assetCount: parsedEvidence.assetCount,
      },
    },
    archive: {
      file: authority.archiveName,
      sha256: digest(archive),
      bytes: archive.length,
      fileCount: inventory.fileCount,
      extractedBytes: inventory.extractedBytes,
    },
    canonicalManifest: {
      file: 'unsigned-canonical-manifest.json',
      sha256: digest(canonicalManifest),
      bytes: canonicalManifest.length,
      requiredEntitlementId: null,
    },
    ceilings: authority.ceilings,
  };
  const reportBytes = jsonBytes(report);
  if (options.initialiseReport) {
    await mkdir(dirname(REPORT_TARGET), { recursive: true });
    await writeFile(REPORT_TARGET, reportBytes, { flag: 'wx' });
  } else {
    const tracked = await readBoundedRegular(REPORT_TARGET, MAXIMUM_SOURCE_BYTES);
    if (!tracked.equals(reportBytes)) {
      fail('tracked build report differs from the current payload');
    }
  }
  await mkdir(OUTPUT_ROOT, { recursive: true });
  await Promise.all([
    writeFile(resolve(OUTPUT_ROOT, authority.archiveName), archive),
    writeFile(resolve(OUTPUT_ROOT, 'unsigned-canonical-manifest.json'), canonicalManifest),
    writeFile(resolve(OUTPUT_ROOT, 'starter-pack-build.json'), reportBytes),
  ]);
  process.stdout.write(
    `Starter pack payload verified: ${inventory.fileCount} files, ${archive.length} bytes, unsigned.\n`,
  );
}

await main();
