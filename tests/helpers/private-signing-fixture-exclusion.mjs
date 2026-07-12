import { createPrivateKey } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, relative, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const AUTHORISED_FIXTURE_DIRECTORY = 'tests/fixtures/keys';
const PRIVATE_FIXTURE_FILENAME = 'b3-public-test-vector-p256-private.pem';
const AUTHORISED_PRIVATE_FIXTURE_URL = new URL(
  `../fixtures/keys/${PRIVATE_FIXTURE_FILENAME}`,
  import.meta.url,
);
const AUTHORISED_FIXTURE_PATHS = new Set([
  `${AUTHORISED_FIXTURE_DIRECTORY}/README.md`,
  `${AUTHORISED_FIXTURE_DIRECTORY}/${PRIVATE_FIXTURE_FILENAME}`,
  `${AUTHORISED_FIXTURE_DIRECTORY}/b3-sandbox-proof-manifest-signature.der`,
]);
// These are the packageable subroots of the application inputs frozen by the
// B2 fingerprint authority. Tests, reports and dependency caches are excluded.
const FINGERPRINTED_PACKAGEABLE_DIRECTORIES = Object.freeze([
  'public',
  'src',
  'config',
  'scripts',
  'vendor/ks2-mastery/content',
  'vendor/ks2-mastery/shared',
  'ios',
  'android',
]);

const GATEWAY_PACKAGEABLE_DIRECTORIES = Object.freeze([
  'gateway/src',
  'gateway/config',
  'gateway/scripts',
  'gateway/dist',
  'gateway/build',
]);

const GENERATED_PACKAGEABLE_DIRECTORIES = Object.freeze([
  'dist',
  '.native-build/b3',
  '.native-build/ios/Build/Products',
]);

const PACKAGEABLE_DIRECTORIES = Object.freeze([
  ...FINGERPRINTED_PACKAGEABLE_DIRECTORIES,
  ...GATEWAY_PACKAGEABLE_DIRECTORIES,
  ...GENERATED_PACKAGEABLE_DIRECTORIES,
  'tests/fixtures',
]);

const PACKAGEABLE_FILES = Object.freeze([
  'index.html',
  'package.json',
  'package-lock.json',
  'capacitor.config.json',
  'vite.config.js',
  'gateway/package.json',
  'gateway/package-lock.json',
  'gateway/wrangler.json',
  'gateway/wrangler.jsonc',
  'gateway/wrangler.toml',
  'gateway/tsconfig.json',
]);

const ARCHIVE_EXTENSIONS = new Set(['.aab', '.aar', '.apk', '.ipa', '.jar', '.zip']);
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 50_000;
const MAX_ARCHIVE_DEPTH = 3;
const EXCLUDED_DIRECTORY_NAMES = new Set(['.git', '.gradle', 'node_modules']);
const EXCLUDED_DIRECTORY_PATHS = new Set([
  'ios/App/CapApp-SPM/.swiftpm',
  'ios/Pods',
]);

const authorisedPrivateFixture = await readFile(AUTHORISED_PRIVATE_FIXTURE_URL);
const authorisedPrivateKey = createPrivateKey(authorisedPrivateFixture);
const privatePkcs8Der = authorisedPrivateKey.export({
  format: 'der',
  type: 'pkcs8',
});
const privateJwk = authorisedPrivateKey.export({ format: 'jwk' });
if (typeof privateJwk.d !== 'string') {
  throw new TypeError('Authorised private signing fixture has no P-256 scalar.');
}
const privateScalar = Buffer.from(privateJwk.d, 'base64url');

const MARKERS = Object.freeze([
  {
    name: 'PKCS#8 private PEM marker',
    bytes: Buffer.from('-----BEGIN PRIVATE KEY-----', 'ascii'),
  },
  {
    name: 'SEC1 private PEM marker',
    bytes: Buffer.from('-----BEGIN EC PRIVATE KEY-----', 'ascii'),
  },
  {
    name: 'PKCS#8 DER private key bytes',
    bytes: privatePkcs8Der,
  },
  {
    name: 'PKCS#8 DER canonical base64',
    bytes: Buffer.from(privatePkcs8Der.toString('base64'), 'ascii'),
  },
  {
    name: 'PKCS#8 DER canonical base64url',
    bytes: Buffer.from(privatePkcs8Der.toString('base64url'), 'ascii'),
  },
  {
    name: 'RFC6979 private scalar bytes',
    bytes: privateScalar,
  },
  {
    name: 'RFC6979 private scalar canonical base64',
    bytes: Buffer.from(privateScalar.toString('base64'), 'ascii'),
  },
  {
    name: 'RFC6979 private scalar canonical base64url',
    bytes: Buffer.from(privateScalar.toString('base64url'), 'ascii'),
  },
  {
    name: 'RFC6979 private scalar hex text',
    bytes: Buffer.from(privateScalar.toString('hex'), 'ascii'),
    asciiCaseInsensitive: true,
  },
  {
    name: 'private fixture filename or reference',
    bytes: Buffer.from(PRIVATE_FIXTURE_FILENAME, 'ascii'),
    asciiCaseInsensitive: true,
  },
]);

function normaliseRoot(root) {
  if (root instanceof URL) {
    if (root.protocol !== 'file:') {
      throw new TypeError('Private signing fixture scan root must be a file URL.');
    }
    return resolve(fileURLToPath(root));
  }
  if (typeof root !== 'string' || root.length === 0) {
    throw new TypeError('Private signing fixture scan root must be a path.');
  }
  return resolve(root);
}

function scanError(detail) {
  throw new Error(`Private signing fixture exclusion failed: ${detail}.`);
}

function asciiLowercase(bytes) {
  const lowered = Buffer.from(bytes);
  for (let index = 0; index < lowered.length; index += 1) {
    if (lowered[index] >= 65 && lowered[index] <= 90) {
      lowered[index] += 32;
    }
  }
  return lowered;
}

function assertNoMarker(bytes, displayPath) {
  let loweredBytes;
  for (const marker of MARKERS) {
    const found = marker.asciiCaseInsensitive
      ? (loweredBytes ??= asciiLowercase(bytes)).indexOf(
          asciiLowercase(marker.bytes),
        ) !== -1
      : bytes.indexOf(marker.bytes) !== -1;
    if (found) {
      scanError(`${marker.name} found in packageable input ${displayPath}`);
    }
  }
}

function assertSafeRelativePath(root, absolutePath) {
  const path = relative(root, absolutePath).split(sep).join('/');
  if (!path || path === '..' || path.startsWith('../')) {
    scanError('a packageable path escaped the repository root');
  }
  return path;
}

function readUInt16(bytes, offset, displayPath) {
  if (offset < 0 || offset + 2 > bytes.length) {
    scanError(`truncated archive field in ${displayPath}`);
  }
  return bytes.readUInt16LE(offset);
}

function readUInt32(bytes, offset, displayPath) {
  if (offset < 0 || offset + 4 > bytes.length) {
    scanError(`truncated archive field in ${displayPath}`);
  }
  return bytes.readUInt32LE(offset);
}

function findEndOfCentralDirectory(bytes) {
  const minimumOffset = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  return -1;
}

function scanArchive(bytes, displayPath, budget, depth) {
  if (depth > MAX_ARCHIVE_DEPTH) {
    scanError(`archive nesting exceeded the bounded depth in ${displayPath}`);
  }
  const endOffset = findEndOfCentralDirectory(bytes);
  if (endOffset < 0) {
    scanError(`archive central directory is missing in ${displayPath}`);
  }
  const disk = readUInt16(bytes, endOffset + 4, displayPath);
  const centralDisk = readUInt16(bytes, endOffset + 6, displayPath);
  const diskEntries = readUInt16(bytes, endOffset + 8, displayPath);
  const totalEntries = readUInt16(bytes, endOffset + 10, displayPath);
  const centralSize = readUInt32(bytes, endOffset + 12, displayPath);
  const centralOffset = readUInt32(bytes, endOffset + 16, displayPath);
  const commentLength = readUInt16(bytes, endOffset + 20, displayPath);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== totalEntries ||
    totalEntries > MAX_ARCHIVE_ENTRIES ||
    endOffset + 22 + commentLength !== bytes.length ||
    centralOffset + centralSize !== endOffset
  ) {
    scanError(`archive bounds are unsupported or malformed in ${displayPath}`);
  }

  let cursor = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (readUInt32(bytes, cursor, displayPath) !== 0x02014b50) {
      scanError(`archive central entry is malformed in ${displayPath}`);
    }
    const flags = readUInt16(bytes, cursor + 8, displayPath);
    const method = readUInt16(bytes, cursor + 10, displayPath);
    const compressedSize = readUInt32(bytes, cursor + 20, displayPath);
    const extractedSize = readUInt32(bytes, cursor + 24, displayPath);
    const nameLength = readUInt16(bytes, cursor + 28, displayPath);
    const extraLength = readUInt16(bytes, cursor + 30, displayPath);
    const entryCommentLength = readUInt16(bytes, cursor + 32, displayPath);
    const localOffset = readUInt32(bytes, cursor + 42, displayPath);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (
      nameEnd + extraLength + entryCommentLength > endOffset ||
      compressedSize === 0xffffffff ||
      extractedSize === 0xffffffff ||
      localOffset === 0xffffffff ||
      extractedSize > MAX_FILE_BYTES ||
      (flags & 1) !== 0 ||
      (method !== 0 && method !== 8)
    ) {
      scanError(`archive entry is unsupported or unbounded in ${displayPath}`);
    }
    const entryNameBytes = bytes.subarray(nameStart, nameEnd);
    assertNoMarker(entryNameBytes, `${displayPath}!entry-${index}`);
    const entryName = entryNameBytes.toString('utf8');

    if (readUInt32(bytes, localOffset, displayPath) !== 0x04034b50) {
      scanError(`archive local entry is malformed in ${displayPath}`);
    }
    const localNameLength = readUInt16(bytes, localOffset + 26, displayPath);
    const localExtraLength = readUInt16(bytes, localOffset + 28, displayPath);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) {
      scanError(`archive entry data is truncated in ${displayPath}`);
    }
    const compressed = bytes.subarray(dataStart, dataEnd);
    const content = method === 0
      ? Buffer.from(compressed)
      : inflateRawSync(compressed, { maxOutputLength: MAX_FILE_BYTES });
    if (content.length !== extractedSize) {
      scanError(`archive entry size is inconsistent in ${displayPath}`);
    }
    budget.expandedBytes += content.length;
    if (budget.expandedBytes > MAX_TOTAL_BYTES) {
      scanError(`archive expansion exceeded the bounded total in ${displayPath}`);
    }
    const entryDisplayPath = `${displayPath}!${entryName}`;
    assertNoMarker(content, entryDisplayPath);
    if (ARCHIVE_EXTENSIONS.has(extname(entryName).toLowerCase())) {
      scanArchive(content, entryDisplayPath, budget, depth + 1);
    }
    cursor = nameEnd + extraLength + entryCommentLength;
  }
  if (cursor !== centralOffset + centralSize) {
    scanError(`archive central directory length drifted in ${displayPath}`);
  }
}

async function collectFiles(root, candidatePath, files) {
  let metadata;
  try {
    metadata = await lstat(candidatePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  const displayPath = assertSafeRelativePath(root, candidatePath);
  const pathParts = displayPath.split('/');
  if (
    metadata.isDirectory() &&
    (
      pathParts.some((part) => EXCLUDED_DIRECTORY_NAMES.has(part)) ||
      EXCLUDED_DIRECTORY_PATHS.has(displayPath)
    )
  ) {
    return;
  }
  if (AUTHORISED_FIXTURE_PATHS.has(displayPath)) {
    return;
  }
  if (displayPath.toLowerCase().includes(PRIVATE_FIXTURE_FILENAME)) {
    scanError(`private fixture path found in packageable input ${displayPath}`);
  }
  if (metadata.isSymbolicLink()) {
    scanError(`symbolic link is forbidden in packageable input ${displayPath}`);
  }
  if (metadata.isFile()) {
    files.push({ absolutePath: candidatePath, displayPath, size: metadata.size });
    return;
  }
  if (!metadata.isDirectory()) {
    scanError(`non-file packageable input is forbidden at ${displayPath}`);
  }
  const entries = await readdir(candidatePath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    await collectFiles(root, join(candidatePath, entry.name), files);
  }
}

export async function assertPrivateSigningFixtureExcluded({ root }) {
  const absoluteRoot = normaliseRoot(root);
  const files = [];
  for (const directory of PACKAGEABLE_DIRECTORIES) {
    await collectFiles(absoluteRoot, join(absoluteRoot, directory), files);
  }
  for (const file of PACKAGEABLE_FILES) {
    await collectFiles(absoluteRoot, join(absoluteRoot, file), files);
  }
  const uniqueFiles = [...new Map(
    files.map((file) => [file.absolutePath, file]),
  ).values()].sort((left, right) => left.displayPath.localeCompare(right.displayPath, 'en'));
  if (uniqueFiles.length > MAX_FILES) {
    scanError('packageable file count exceeded the bounded maximum');
  }

  let bytesScanned = 0;
  const budget = { expandedBytes: 0 };
  for (const file of uniqueFiles) {
    if (file.size > MAX_FILE_BYTES) {
      scanError(`packageable input exceeded the per-file byte bound at ${file.displayPath}`);
    }
    bytesScanned += file.size;
    if (bytesScanned > MAX_TOTAL_BYTES) {
      scanError('packageable inputs exceeded the bounded total bytes');
    }
    const bytes = await readFile(file.absolutePath);
    assertNoMarker(bytes, file.displayPath);
    if (ARCHIVE_EXTENSIONS.has(extname(file.displayPath).toLowerCase())) {
      scanArchive(bytes, file.displayPath, budget, 1);
    }
  }

  return Object.freeze({
    authorisedFixtureDirectory: AUTHORISED_FIXTURE_DIRECTORY,
    filesScanned: uniqueFiles.length,
    bytesScanned,
    expandedArchiveBytesScanned: budget.expandedBytes,
  });
}
