import { lstat, readFile, readdir } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';

export const B3_DELETED_AUTHORITY_MODULES = Object.freeze([
  'b3-capture-bundle-store.mjs',
  'b3-capture-recovery-store.mjs',
  'b3-abandoned-capture.mjs',
  'b3-host-capture-state.mjs',
  'b3-issued-command.mjs',
  'b3-physical-observation-journal.mjs',
  'b3-device-observation.mjs',
]);

export const B3_OBSOLETE_AUTHORITY_SYMBOLS = Object.freeze([
  'persistB3DeviceGatewaySmokeProjection',
  'captureB3ValidatedDeviceObservation',
  'resumeB3IssuedDeviceObservation',
  'resumeB3AmbiguousIssuedCommandAfterReinstall',
  'recoverB3AmbiguousCaptureAfterReinstall',
  'createNextB3HostCommand',
  'advanceB3HostCaptureOne',
  'readB3CaptureCheckpoint',
  'writeB3CaptureCheckpoint',
  'appendB3PhysicalObservation',
]);

export const B3_OBSOLETE_DEVICE_SMOKE_OUTPUT =
  'reports/b3/cloudflare-device-smoke.json';

export const B3_FINAL_OUTPUTS = Object.freeze([
  'reports/b3/cloudflare-sandbox-proof.json',
  'reports/b3/ios-sandbox-proof.json',
  'reports/b3/ios-sandbox-proof.png',
  'reports/b3/android-sandbox-proof.json',
  'reports/b3/android-sandbox-proof.png',
  'reports/b3/b3-exit-report.json',
]);

const DEFAULT_ROOTS = Object.freeze([
  '.github/workflows',
  'android',
  'gateway',
  'ios',
  'scripts',
  'src',
  'tests',
  'package.json',
  'capacitor.config.json',
  'vite.config.js',
]);
const EXCLUDED_DIRECTORY_NAMES = new Set([
  '.git',
  '.gradle',
  '.native-build',
  '.swiftpm',
  'DerivedData',
  'Pods',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'reports',
  'vendor',
]);
const EXCLUDED_PREFIXES = Object.freeze(['tests/fixtures/']);
const TEXT_EXTENSIONS = new Set([
  '.cjs', '.gradle', '.java', '.js', '.json', '.jsx', '.kt', '.kts', '.mjs',
  '.properties', '.sh', '.swift', '.ts', '.tsx', '.xml', '.yaml', '.yml',
]);
const ROOT_TEXT_FILES = new Set(['package.json', 'capacitor.config.json', 'vite.config.js']);
const MAXIMUM_FILES = 4_096;
const MAXIMUM_FILE_BYTES = 2 * 1024 * 1024;
const MAXIMUM_TOTAL_BYTES = 64 * 1024 * 1024;
const OBSOLETE_SYMBOL_PROOF_PATHS = new Set([
  'tests/b3-android-wrapper-contract.test.mjs',
  'tests/b3-ios-wrapper-contract.test.mjs',
  'tests/b3-legacy-authority-deletion.test.mjs',
  'tests/b3-store-backed-live-capture.test.mjs',
  'tests/helpers/b3-repository-invariant-scanner.mjs',
]);
const DEVICE_SMOKE_PROOF_PATHS = new Set([
  'tests/b3-cloudflare-wrapper-contract.test.mjs',
  'tests/b3-legacy-authority-deletion.test.mjs',
  'tests/helpers/b3-repository-invariant-scanner.mjs',
]);

function scannerError(message) {
  return Object.assign(new Error(message), { code: 'b3_repository_scan_invalid' });
}

function slashPath(value) {
  return value.split(sep).join('/');
}

function regexEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function excluded(relativePath, name, isDirectory) {
  const normalised = slashPath(relativePath);
  if (EXCLUDED_PREFIXES.some((prefix) => normalised.startsWith(prefix))) return true;
  return isDirectory && EXCLUDED_DIRECTORY_NAMES.has(name);
}

function textFile(relativePath) {
  return ROOT_TEXT_FILES.has(relativePath) || TEXT_EXTENSIONS.has(extname(relativePath));
}

async function collectPath({ root, absolutePath, relativePath, files, totals }) {
  const metadata = await lstat(absolutePath);
  if (metadata.isSymbolicLink()) {
    throw scannerError(`B3 repository scan rejects symbolic link ${relativePath}`);
  }
  if (metadata.isDirectory()) {
    const entries = await readdir(absolutePath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childRelative = slashPath(relativePath.length === 0
        ? entry.name
        : `${relativePath}/${entry.name}`);
      if (excluded(childRelative, entry.name, entry.isDirectory())) continue;
      await collectPath({
        root,
        absolutePath: resolve(absolutePath, entry.name),
        relativePath: childRelative,
        files,
        totals,
      });
    }
    return;
  }
  if (!metadata.isFile()) {
    throw scannerError(`B3 repository scan rejects non-regular entry ${relativePath}`);
  }
  if (!textFile(relativePath)) return;
  if (metadata.size > MAXIMUM_FILE_BYTES) {
    throw scannerError(`B3 repository scan file exceeds its bound: ${relativePath}`);
  }
  totals.files += 1;
  totals.bytes += metadata.size;
  if (totals.files > MAXIMUM_FILES || totals.bytes > MAXIMUM_TOTAL_BYTES) {
    throw scannerError('B3 repository scan exceeded its closed file or byte bound');
  }
  const bytes = await readFile(absolutePath);
  if (bytes.includes(0)) {
    throw scannerError(`B3 repository scan text file contains a NUL byte: ${relativePath}`);
  }
  files.push(Object.freeze({
    path: slashPath(relative(root, absolutePath)),
    source: bytes.toString('utf8'),
  }));
}

export async function scanB3RepositorySources({ root, roots = DEFAULT_ROOTS } = {}) {
  if (typeof root !== 'string' || root.length === 0 || !Array.isArray(roots) ||
      roots.length === 0 || roots.some((entry) => typeof entry !== 'string' ||
        entry.length === 0 || entry.startsWith('/') || entry.includes('..'))) {
    throw scannerError('B3 repository scan authority is invalid');
  }
  const canonicalRoot = resolve(root);
  const files = [];
  const totals = { files: 0, bytes: 0 };
  for (const scanRoot of roots) {
    const absolutePath = resolve(canonicalRoot, scanRoot);
    if (!absolutePath.startsWith(`${canonicalRoot}${sep}`) && absolutePath !== canonicalRoot) {
      throw scannerError('B3 repository scan root escaped its authority');
    }
    await collectPath({
      root: canonicalRoot,
      absolutePath,
      relativePath: slashPath(scanRoot),
      files,
      totals,
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze({
    files: Object.freeze(files),
    filesScanned: totals.files,
    bytesScanned: totals.bytes,
  });
}

function deletedImportPattern(moduleName) {
  const module = regexEscape(moduleName);
  return new RegExp(
    String.raw`(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"\x60][^'"\x60\r\n]*${module}['"\x60]`,
    'u',
  );
}

function isB3ProductionPath(path) {
  return /^scripts\/lib\/b3-[^/]+\.(?:js|mjs)$/u.test(path) ||
    /^scripts\/[^/]*b3[^/]*\.(?:js|mjs)$/u.test(path) ||
    /^src\/app\/b3-[^/]+\.(?:js|mjs)$/u.test(path) ||
    (/^(?:android|gateway|ios)\//u.test(path) && /b3/iu.test(path));
}

function reportLiterals(source) {
  const reports = [];
  const pattern = /(['"\x60])(reports\/[^'"\x60\r\n]*)\1/gu;
  for (const match of source.matchAll(pattern)) reports.push(match[2]);
  return reports;
}

export function findB3RepositoryInvariantViolations(files) {
  if (!Array.isArray(files)) throw scannerError('B3 repository scan files are invalid');
  const violations = [];
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || typeof file.source !== 'string') {
      throw scannerError('B3 repository scan file entry is invalid');
    }
    for (const moduleName of B3_DELETED_AUTHORITY_MODULES) {
      if (deletedImportPattern(moduleName).test(file.source)) {
        violations.push(Object.freeze({
          kind: 'deleted-module-import',
          path: file.path,
          authority: moduleName,
        }));
      }
    }
    if (!OBSOLETE_SYMBOL_PROOF_PATHS.has(file.path)) {
      for (const symbol of B3_OBSOLETE_AUTHORITY_SYMBOLS) {
        if (new RegExp(String.raw`\b${regexEscape(symbol)}\b`, 'u').test(file.source)) {
          violations.push(Object.freeze({
            kind: 'obsolete-authority-symbol',
            path: file.path,
            authority: symbol,
          }));
        }
      }
    }
    if (!DEVICE_SMOKE_PROOF_PATHS.has(file.path) &&
        file.source.includes(B3_OBSOLETE_DEVICE_SMOKE_OUTPUT)) {
      violations.push(Object.freeze({
        kind: 'obsolete-device-smoke-authority',
        path: file.path,
        authority: B3_OBSOLETE_DEVICE_SMOKE_OUTPUT,
      }));
    }
    if (isB3ProductionPath(file.path)) {
      for (const output of reportLiterals(file.source)) {
        if (output === 'reports/' &&
            file.path === 'scripts/fingerprint-b3-application.mjs') continue;
        if (output !== 'reports/b3' && !output.startsWith('reports/b3/')) {
          violations.push(Object.freeze({
            kind: 'b3-output-namespace',
            path: file.path,
            authority: output,
          }));
        }
      }
    }
  }
  return Object.freeze(violations);
}
