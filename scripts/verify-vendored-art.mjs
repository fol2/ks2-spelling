import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROVENANCE_PATH = 'provenance/ks2-mastery-art.json';
const ART_ROOT = 'content/mastery-art';
const EXPECTED_FILE_COUNT = 55;
const EXPECTED_BYTES_BUDGET = 6_291_456;
const PROVENANCE_KEYS = Object.freeze([
  'authority',
  'extraction',
  'upstreamRepository',
  'upstreamCommit',
  'fileCount',
  'totalBytes',
  'totalBytesBudget',
  'files',
]);
const FILE_RECORD_KEYS = Object.freeze(['path', 'upstreamPath', 'sha256', 'bytes']);
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function recordIssue(issues, message) {
  issues.push(message);
}

function hasExactKeys(value, expectedKeys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

async function readBytes(path, label, issues) {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      recordIssue(issues, `${label} is not a regular file: ${path}`);
      return null;
    }
    return await readFile(path);
  } catch (error) {
    recordIssue(issues, `missing ${label}: ${path} (${error.code ?? error.message})`);
    return null;
  }
}

function parseJson(bytes, label, issues) {
  if (!bytes) return null;
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    recordIssue(issues, `invalid JSON in ${label}: ${error.message}`);
    return null;
  }
}

async function listArtFiles(artRoot, issues) {
  const files = [];

  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      recordIssue(
        issues,
        `missing art directory: ${directory} (${error.code ?? error.message})`,
      );
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        recordIssue(issues, `unexpected art symlink: ${relative(artRoot, path)}`);
      } else if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        files.push(relative(artRoot, path).split(sep).join('/'));
      } else {
        recordIssue(issues, `unexpected art filesystem entry: ${relative(artRoot, path)}`);
      }
    }
  }

  await visit(artRoot);
  return files.sort();
}

function compareExactSet(actual, expected, onMissing, onExtra) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  for (const value of expectedSet) if (!actualSet.has(value)) onMissing(value);
  for (const value of actualSet) if (!expectedSet.has(value)) onExtra(value);
}

function validateProvenanceShape(provenance, issues) {
  if (!provenance) return null;
  if (!hasExactKeys(provenance, PROVENANCE_KEYS)) {
    recordIssue(issues, 'provenance record does not contain exactly the reviewed fields');
    return null;
  }
  if (
    typeof provenance.authority !== 'string' ||
    provenance.authority.length === 0 ||
    typeof provenance.extraction !== 'string' ||
    provenance.extraction.length === 0 ||
    typeof provenance.upstreamRepository !== 'string' ||
    provenance.upstreamRepository.length === 0 ||
    typeof provenance.upstreamCommit !== 'string' ||
    !/^[0-9a-f]{40}$/u.test(provenance.upstreamCommit) ||
    provenance.fileCount !== EXPECTED_FILE_COUNT ||
    provenance.totalBytesBudget !== EXPECTED_BYTES_BUDGET ||
    !Number.isInteger(provenance.totalBytes) ||
    provenance.totalBytes < 0 ||
    !Array.isArray(provenance.files)
  ) {
    recordIssue(issues, 'provenance identity, file count or budget fields are invalid');
    return null;
  }
  if (provenance.files.length !== EXPECTED_FILE_COUNT) {
    recordIssue(
      issues,
      `provenance file list length drift: expected ${EXPECTED_FILE_COUNT}, received ${provenance.files.length}`,
    );
  }
  if (provenance.totalBytes > provenance.totalBytesBudget) {
    recordIssue(
      issues,
      `art byte budget exceeded: ${provenance.totalBytes} > ${provenance.totalBytesBudget}`,
    );
  }

  const paths = [];
  let summedBytes = 0;
  for (const [index, record] of provenance.files.entries()) {
    if (!hasExactKeys(record, FILE_RECORD_KEYS)) {
      recordIssue(issues, `provenance file record ${index} is missing required fields`);
      continue;
    }
    if (
      typeof record.path !== 'string' ||
      !record.path.startsWith(`${ART_ROOT}/`) ||
      record.path.includes('..') ||
      typeof record.upstreamPath !== 'string' ||
      record.upstreamPath.length === 0 ||
      typeof record.sha256 !== 'string' ||
      !HASH_PATTERN.test(record.sha256) ||
      !Number.isInteger(record.bytes) ||
      record.bytes <= 0
    ) {
      recordIssue(issues, `provenance file record ${index} has an invalid path, hash or size`);
      continue;
    }
    paths.push(record.path);
    summedBytes += record.bytes;
  }

  if (new Set(paths).size !== paths.length) {
    recordIssue(issues, 'provenance file list contains duplicate paths');
  }
  if (summedBytes !== provenance.totalBytes) {
    recordIssue(
      issues,
      `provenance totalBytes drift: declared ${provenance.totalBytes}, summed ${summedBytes}`,
    );
  }
  return provenance;
}

export class VendoredArtVerificationError extends Error {
  constructor(issues) {
    super(`Vendored art verification failed:\n- ${issues.join('\n- ')}`);
    this.name = 'VendoredArtVerificationError';
    this.issues = issues;
  }
}

export async function verifyVendoredArt({ rootDir = DEFAULT_ROOT } = {}) {
  const root = resolve(rootDir);
  const issues = [];
  const provenanceBytes = await readBytes(
    resolve(root, PROVENANCE_PATH),
    'art provenance record',
    issues,
  );
  const provenance = validateProvenanceShape(
    parseJson(provenanceBytes, 'art provenance record', issues),
    issues,
  );

  const artRoot = resolve(root, ART_ROOT);
  try {
    const stats = await lstat(artRoot);
    if (stats.isSymbolicLink()) {
      recordIssue(issues, 'art root is a symlink');
    } else if (!stats.isDirectory()) {
      recordIssue(issues, 'art root is not a directory');
    }
  } catch (error) {
    recordIssue(issues, `missing art root: ${artRoot} (${error.code ?? error.message})`);
  }

  const listedRelative = Array.isArray(provenance?.files)
    ? provenance.files
        .map((record) => record?.path)
        .filter((path) => typeof path === 'string')
        .map((path) => path.slice(`${ART_ROOT}/`.length))
        .sort()
    : [];
  const actualRelative = await listArtFiles(artRoot, issues);
  compareExactSet(
    actualRelative,
    listedRelative,
    (path) => recordIssue(issues, `missing art file: ${ART_ROOT}/${path}`),
    (path) => recordIssue(issues, `unexpected art file: ${ART_ROOT}/${path}`),
  );

  if (Array.isArray(provenance?.files)) {
    for (const record of provenance.files) {
      if (!record || typeof record.path !== 'string') continue;
      const absolute = resolve(root, record.path);
      const bytes = await readBytes(absolute, `art file ${record.path}`, issues);
      if (!bytes) continue;
      if (bytes.byteLength !== record.bytes) {
        recordIssue(
          issues,
          `byte length mismatch for ${record.path}: expected ${record.bytes}, received ${bytes.byteLength}`,
        );
      }
      if (sha256(bytes) !== record.sha256) {
        recordIssue(issues, `recorded hash mismatch for ${record.path}`);
      }
    }
  }

  if (issues.length > 0) throw new VendoredArtVerificationError(issues);
  return {
    filesVerified: EXPECTED_FILE_COUNT,
    totalBytes: provenance.totalBytes,
    totalBytesBudget: provenance.totalBytesBudget,
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    const result = await verifyVendoredArt();
    process.stdout.write(
      `Vendored art verified: ${result.filesVerified}/${EXPECTED_FILE_COUNT} files; ` +
        `${result.totalBytes} bytes within budget ${result.totalBytesBudget}.\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
