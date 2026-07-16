import { createHash, createPrivateKey } from 'node:crypto';
import { lstat, open, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, relative, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { verifyHostileZipCorpusSnapshot } from './hostile-zip-builder.mjs';

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
  // Xcode's Products directory also contains non-packageable object modules,
  // framework copies and dSYMs. Scan the exact installed simulator bundle;
  // signed B3 distribution artefacts remain covered by .native-build/b3.
  '.native-build/ios/Build/Products/Debug-iphonesimulator/App.app',
  '.native-build/android/build/app/intermediates/java_res/debugUnitTest/'
    + 'processDebugUnitTestJavaRes/out/b3-hostile-zips',
  'android/app/build/intermediates/java_res/debugUnitTest/'
    + 'processDebugUnitTestJavaRes/out/b3-hostile-zips',
  'android/app/build/intermediates/java_res/b3SandboxProofDebugUnitTest/'
    + 'processB3SandboxProofDebugUnitTestJavaRes/out/b3-hostile-zips',
  'android/app/build/intermediates/java_res/b3SandboxProofReleaseUnitTest/'
    + 'processB3SandboxProofReleaseUnitTestJavaRes/out/b3-hostile-zips',
]);

const PACKAGEABLE_DIRECTORIES = Object.freeze([
  ...FINGERPRINTED_PACKAGEABLE_DIRECTORIES,
  ...GATEWAY_PACKAGEABLE_DIRECTORIES,
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
const HOSTILE_ZIP_FIXTURE_PREFIX = 'tests/fixtures/b3-hostile-zips/';
const NATIVE_HOSTILE_ZIP_FIXTURE_PREFIX =
  'android/app/src/test/resources/b3-hostile-zips/';
const GENERATED_ANDROID_HOSTILE_ZIP_FIXTURE_PREFIX =
  'android/app/build/intermediates/java_res/debugUnitTest/'
  + 'processDebugUnitTestJavaRes/out/b3-hostile-zips/';
const GENERATED_ANDROID_B3_DEBUG_HOSTILE_ZIP_FIXTURE_PREFIX =
  'android/app/build/intermediates/java_res/b3SandboxProofDebugUnitTest/'
  + 'processB3SandboxProofDebugUnitTestJavaRes/out/b3-hostile-zips/';
const GENERATED_ANDROID_B3_RELEASE_HOSTILE_ZIP_FIXTURE_PREFIX =
  'android/app/build/intermediates/java_res/b3SandboxProofReleaseUnitTest/'
  + 'processB3SandboxProofReleaseUnitTestJavaRes/out/b3-hostile-zips/';
const GENERATED_NATIVE_ANDROID_HOSTILE_ZIP_FIXTURE_PREFIX =
  '.native-build/android/build/app/intermediates/java_res/debugUnitTest/'
  + 'processDebugUnitTestJavaRes/out/b3-hostile-zips/';
const HOSTILE_ZIP_MANIFEST_SHA256 =
  'b76b8fd52820b1ac69e1ebced81ba99f4c9c78809136d06e76eedb4c4f04bc58';
const hostileZipManifestBytes = await readFile(
  new URL('../fixtures/b3-hostile-zips/manifest.json', import.meta.url),
);
if (
  createHash('sha256').update(hostileZipManifestBytes).digest('hex')
  !== HOSTILE_ZIP_MANIFEST_SHA256
) {
  throw new Error('The frozen hostile ZIP filename and SHA-256 authority drifted.');
}
const hostileZipManifest = JSON.parse(hostileZipManifestBytes);
const HOSTILE_ZIP_FILE_AUTHORITY = new Map([
  ['manifest.json', HOSTILE_ZIP_MANIFEST_SHA256],
  ...hostileZipManifest.fixtures.map((fixture) => [fixture.file, fixture.sha256]),
]);
if (
  HOSTILE_ZIP_FILE_AUTHORITY.size !== hostileZipManifest.fixtures.length + 1
  || [...HOSTILE_ZIP_FILE_AUTHORITY].some(
    ([name, sha256]) => !/^[a-z0-9][a-z0-9-]*\.zip$|^manifest\.json$/.test(name)
      || !/^[0-9a-f]{64}$/.test(sha256),
  )
) {
  throw new Error('The frozen hostile ZIP filename and SHA-256 authority is malformed.');
}
const HOSTILE_ZIP_COPY_PREFIXES = Object.freeze([
  HOSTILE_ZIP_FIXTURE_PREFIX,
  NATIVE_HOSTILE_ZIP_FIXTURE_PREFIX,
  GENERATED_ANDROID_HOSTILE_ZIP_FIXTURE_PREFIX,
  GENERATED_ANDROID_B3_DEBUG_HOSTILE_ZIP_FIXTURE_PREFIX,
  GENERATED_ANDROID_B3_RELEASE_HOSTILE_ZIP_FIXTURE_PREFIX,
  GENERATED_NATIVE_ANDROID_HOSTILE_ZIP_FIXTURE_PREFIX,
]);
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 50_000;
const MAX_ARCHIVE_DEPTH = 3;
const MAX_GENERATED_SNAPSHOT_ATTEMPTS = 32;
const MAX_GENERATED_SNAPSHOT_MILLISECONDS = 15_000;
const SCAN_LIMIT_KEYS = Object.freeze([
  'maxRawBytes',
  'maxExpandedArchiveBytes',
  'maxArchiveEntries',
]);
const DEFAULT_SCAN_LIMITS = Object.freeze({
  maxRawBytes: MAX_TOTAL_BYTES,
  maxExpandedArchiveBytes: MAX_TOTAL_BYTES,
  maxArchiveEntries: MAX_ARCHIVE_ENTRIES,
});
const EXCLUDED_DIRECTORY_NAMES = new Set(['.git', '.gradle', 'node_modules']);
const EXCLUDED_DIRECTORY_PATHS = new Set([
  'ios/App/CapApp-SPM/.swiftpm',
  'ios/Pods',
  // Gradle intermediates are non-packageable duplicate work products. Final
  // APK/AAB outputs remain under android/app/build/outputs and are scanned;
  // the deliberately malformed hostile-ZIP copies are scanned separately by
  // the exact generated roots above.
  'android/app/build/intermediates',
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

class GeneratedSnapshotChanged extends Error {}

function metadataIdentity(metadata) {
  return [
    metadata.dev,
    metadata.ino,
    metadata.mode,
    metadata.size,
    metadata.mtimeNs,
    metadata.ctimeNs,
  ].join(':');
}

function handleChangedPath(displayPath, mutable) {
  if (mutable) {
    throw new GeneratedSnapshotChanged(displayPath);
  }
  scanError(`static packageable input changed during scan at ${displayPath}`);
}

function normaliseScanLimits(scanLimits) {
  if (scanLimits === undefined) return DEFAULT_SCAN_LIMITS;
  if (
    !scanLimits ||
    typeof scanLimits !== 'object' ||
    Array.isArray(scanLimits) ||
    Object.getPrototypeOf(scanLimits) !== Object.prototype ||
    Reflect.ownKeys(scanLimits).length !== SCAN_LIMIT_KEYS.length ||
    Reflect.ownKeys(scanLimits).some(
      (key) => typeof key !== 'string' || !SCAN_LIMIT_KEYS.includes(key),
    )
  ) {
    throw new TypeError('Private signing fixture scan limits must use the exact test seam.');
  }
  for (const key of SCAN_LIMIT_KEYS) {
    if (
      !Number.isSafeInteger(scanLimits[key]) ||
      scanLimits[key] <= 0 ||
      scanLimits[key] > DEFAULT_SCAN_LIMITS[key]
    ) {
      throw new TypeError('Private signing fixture scan limits must be positive safe integers.');
    }
  }
  return Object.freeze({ ...scanLimits });
}

function chargeRawBytes(budget, limits, byteCount) {
  budget.rawBytes += byteCount;
  if (budget.rawBytes > limits.maxRawBytes) {
    scanError('raw byte work budget exceeded the bounded total');
  }
}

function chargeArchiveEntries(budget, limits, entryCount, displayPath) {
  budget.archiveEntries += entryCount;
  if (budget.archiveEntries > limits.maxArchiveEntries) {
    scanError(`archive entry work budget exceeded the bounded total in ${displayPath}`);
  }
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

function scanArchive(bytes, displayPath, budget, limits, depth) {
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
  chargeArchiveEntries(budget, limits, totalEntries, displayPath);

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
    if (budget.expandedBytes > limits.maxExpandedArchiveBytes) {
      scanError(`archive expansion work budget exceeded the bounded total in ${displayPath}`);
    }
    const entryDisplayPath = `${displayPath}!${entryName}`;
    assertNoMarker(content, entryDisplayPath);
    if (ARCHIVE_EXTENSIONS.has(extname(entryName).toLowerCase())) {
      scanArchive(content, entryDisplayPath, budget, limits, depth + 1);
    }
    cursor = nameEnd + extraLength + entryCommentLength;
  }
  if (cursor !== centralOffset + centralSize) {
    scanError(`archive central directory length drifted in ${displayPath}`);
  }
}

async function collectFiles(
  root,
  candidatePath,
  files,
  directories,
  { allowMissingRoot, mutable },
) {
  let metadata;
  try {
    metadata = await lstat(candidatePath, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      if (allowMissingRoot) return false;
      handleChangedPath(assertSafeRelativePath(root, candidatePath), mutable);
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
    files.push({
      absolutePath: candidatePath,
      displayPath,
      identity: metadataIdentity(metadata),
      size: Number(metadata.size),
    });
    return true;
  }
  if (!metadata.isDirectory()) {
    scanError(`non-file packageable input is forbidden at ${displayPath}`);
  }
  directories.push({
    absolutePath: candidatePath,
    displayPath,
    identity: metadataIdentity(metadata),
  });
  let entries;
  try {
    entries = await readdir(candidatePath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') handleChangedPath(displayPath, mutable);
    throw error;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    await collectFiles(root, join(candidatePath, entry.name), files, directories, {
      allowMissingRoot: false,
      mutable,
    });
  }
  return true;
}

async function readStableFile(file, mutable, budget, limits) {
  let handle;
  try {
    handle = await open(file.absolutePath, 'r');
  } catch (error) {
    if (error?.code === 'ENOENT') handleChangedPath(file.displayPath, mutable);
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || metadataIdentity(before) !== file.identity) {
      handleChangedPath(file.displayPath, mutable);
    }
    const bytes = await handle.readFile();
    chargeRawBytes(budget, limits, bytes.length);
    const after = await handle.stat({ bigint: true });
    let pathAfter;
    try {
      pathAfter = await lstat(file.absolutePath, { bigint: true });
    } catch (error) {
      if (error?.code === 'ENOENT') handleChangedPath(file.displayPath, mutable);
      throw error;
    }
    if (
      metadataIdentity(before) !== metadataIdentity(after) ||
      metadataIdentity(after) !== metadataIdentity(pathAfter) ||
      bytes.length !== Number(after.size)
    ) {
      handleChangedPath(file.displayPath, mutable);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function assertDirectorySnapshotStable(directories, mutable) {
  for (const directory of directories) {
    let current;
    try {
      current = await lstat(directory.absolutePath, { bigint: true });
    } catch (error) {
      if (error?.code === 'ENOENT') handleChangedPath(directory.displayPath, mutable);
      throw error;
    }
    if (!current.isDirectory() || metadataIdentity(current) !== directory.identity) {
      handleChangedPath(directory.displayPath, mutable);
    }
  }
}

async function scanCollectedFiles(files, mutable, budget, limits) {
  const uniqueFiles = [...new Map(files.map((file) => [file.absolutePath, file])).values()]
    .sort((left, right) => left.displayPath.localeCompare(right.displayPath, 'en'));
  if (uniqueFiles.length > MAX_FILES) scanError('packageable file count exceeded the bounded maximum');

  let bytesScanned = 0;
  const fingerprint = [];
  const hostileCorpusSnapshots = new Map(
    HOSTILE_ZIP_COPY_PREFIXES.map((prefix) => [prefix, new Map()]),
  );
  for (const file of uniqueFiles) {
    if (file.size > MAX_FILE_BYTES) {
      scanError(`packageable input exceeded the per-file byte bound at ${file.displayPath}`);
    }
    bytesScanned += file.size;
    const bytes = await readStableFile(file, mutable, budget, limits);
    assertNoMarker(bytes, file.displayPath);
    const hostilePrefix = HOSTILE_ZIP_COPY_PREFIXES.find(
      (prefix) => file.displayPath.startsWith(prefix),
    );
    let approvedHostileCopy = false;
    if (hostilePrefix !== undefined) {
      const relativeName = file.displayPath.slice(hostilePrefix.length);
      const expectedSha256 = HOSTILE_ZIP_FILE_AUTHORITY.get(relativeName);
      if (expectedSha256 === undefined) {
        scanError(`unexpected hostile ZIP authority file at ${file.displayPath}`);
      }
      const actualSha256 = createHash('sha256').update(bytes).digest('hex');
      if (actualSha256 !== expectedSha256) {
        scanError(`hostile ZIP copy is not byte-identical to the frozen SHA-256 authority at ${file.displayPath}`);
      }
      hostileCorpusSnapshots.get(hostilePrefix).set(relativeName, bytes);
      approvedHostileCopy = true;
    }
    // These tracked ZIP bytes are deliberately malformed inspector inputs.
    // The frozen filename plus SHA-256 authority above is the only archive-parser
    // exemption. Raw private-material marker scanning has already run.
    if (
      ARCHIVE_EXTENSIONS.has(extname(file.displayPath).toLowerCase()) &&
      !approvedHostileCopy
    ) {
      scanArchive(bytes, file.displayPath, budget, limits, 1);
    }
    fingerprint.push([
      file.displayPath,
      file.identity,
      createHash('sha256').update(bytes).digest('hex'),
    ].join('\u0000'));
  }
  for (const [prefix, snapshot] of hostileCorpusSnapshots) {
    if (snapshot.size === 0) continue;
    if (snapshot.size !== HOSTILE_ZIP_FILE_AUTHORITY.size) {
      scanError(`hostile ZIP copy is incomplete against the exact authority at ${prefix}`);
    }
    for (const name of HOSTILE_ZIP_FILE_AUTHORITY.keys()) {
      if (!snapshot.has(name)) {
        scanError(`hostile ZIP copy is missing exact authority file ${prefix}${name}`);
      }
    }
    if (prefix === HOSTILE_ZIP_FIXTURE_PREFIX) {
      verifyHostileZipCorpusSnapshot(snapshot);
    }
  }

  return Object.freeze({
    filesScanned: uniqueFiles.length,
    bytesScanned,
    fingerprint,
  });
}

async function scanGeneratedDirectory({
  root,
  directory,
  generatedSnapshotObserver,
  budget,
  limits,
}) {
  const startedAt = Date.now();
  let previousFingerprint;
  for (let attempt = 0; attempt < MAX_GENERATED_SNAPSHOT_ATTEMPTS; attempt += 1) {
    if (Date.now() - startedAt > MAX_GENERATED_SNAPSHOT_MILLISECONDS) break;
    try {
      const files = [];
      const directories = [];
      const present = await collectFiles(
        root,
        join(root, directory),
        files,
        directories,
        { allowMissingRoot: true, mutable: true },
      );
      const result = await scanCollectedFiles(files, true, budget, limits);
      await generatedSnapshotObserver?.({ directory, attempt });
      await assertDirectorySnapshotStable(directories, true);
      const verificationResult = await scanCollectedFiles(files, true, budget, limits);
      await assertDirectorySnapshotStable(directories, true);
      if (JSON.stringify(result.fingerprint) !== JSON.stringify(verificationResult.fingerprint)) {
        throw new GeneratedSnapshotChanged(directory);
      }
      const fingerprint = JSON.stringify({
        present,
        directories: directories.map((entry) => [entry.displayPath, entry.identity]),
        files: verificationResult.fingerprint,
      });
      if (Date.now() - startedAt > MAX_GENERATED_SNAPSHOT_MILLISECONDS) break;
      if (fingerprint === previousFingerprint) return verificationResult;
      previousFingerprint = fingerprint;
    } catch (error) {
      if (!(error instanceof GeneratedSnapshotChanged)) throw error;
      previousFingerprint = undefined;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  }
  scanError(`generated packageable output did not reach a stable snapshot at ${directory}`);
}

export async function assertPrivateSigningFixtureExcluded({
  root,
  generatedSnapshotObserver,
  staticSnapshotObserver,
  scanLimits,
}) {
  if (
    generatedSnapshotObserver !== undefined &&
    typeof generatedSnapshotObserver !== 'function'
  ) {
    throw new TypeError('Generated snapshot observer must be a function.');
  }
  if (staticSnapshotObserver !== undefined && typeof staticSnapshotObserver !== 'function') {
    throw new TypeError('Static snapshot observer must be a function.');
  }
  const limits = normaliseScanLimits(scanLimits);
  const budget = { rawBytes: 0, expandedBytes: 0, archiveEntries: 0 };
  const absoluteRoot = normaliseRoot(root);
  const staticFiles = [];
  const staticDirectories = [];
  for (const directory of PACKAGEABLE_DIRECTORIES) {
    await collectFiles(
      absoluteRoot,
      join(absoluteRoot, directory),
      staticFiles,
      staticDirectories,
      { allowMissingRoot: true, mutable: false },
    );
  }
  for (const file of PACKAGEABLE_FILES) {
    await collectFiles(
      absoluteRoot,
      join(absoluteRoot, file),
      staticFiles,
      staticDirectories,
      { allowMissingRoot: true, mutable: false },
    );
  }
  await staticSnapshotObserver?.();
  const staticResult = await scanCollectedFiles(staticFiles, false, budget, limits);
  await assertDirectorySnapshotStable(staticDirectories, false);
  const generatedResults = [];
  for (const directory of GENERATED_PACKAGEABLE_DIRECTORIES) {
    generatedResults.push(await scanGeneratedDirectory({
      root: absoluteRoot,
      directory,
      generatedSnapshotObserver,
      budget,
      limits,
    }));
  }

  const filesScanned = staticResult.filesScanned + generatedResults.reduce(
    (sum, result) => sum + result.filesScanned,
    0,
  );
  const bytesScanned = staticResult.bytesScanned + generatedResults.reduce(
    (sum, result) => sum + result.bytesScanned,
    0,
  );
  const expandedArchiveBytesScanned = budget.expandedBytes;
  if (filesScanned > MAX_FILES) scanError('packageable file count exceeded the bounded maximum');
  if (bytesScanned > MAX_TOTAL_BYTES) {
    scanError('packageable inputs exceeded the bounded total bytes');
  }

  return Object.freeze({
    authorisedFixtureDirectory: AUTHORISED_FIXTURE_DIRECTORY,
    filesScanned,
    bytesScanned,
    expandedArchiveBytesScanned,
  });
}
