import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { EXIT_CODES, isMain, printJson } from './lib/run-command.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const REQUIRED_ROOT_INPUTS = Object.freeze([
  '.npmrc',
  '.nvmrc',
  'capacitor.config.json',
  'index.html',
  'package-lock.json',
  'package.json',
  'vite.config.js',
]);
const OPTIONAL_INPUT_ROOTS = new Set([
  'android',
  'config',
  'ios',
  'provenance',
  'public',
  'scripts',
  'src',
  'vendor',
]);
const EXCLUDED_ROOT_ENTRIES = new Set([
  '.git',
  '.github',
  '.gitignore',
  '.native-build',
  '.superpowers',
  'AGENTS.md',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'dist',
  'docs',
  'node_modules',
  'reports',
  'screenshots',
  'tests',
]);

function fingerprintError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function portablePath(root, path) {
  return relative(root, path).split(sep).join('/');
}

export function isB2ApplicationFingerprintInput(path) {
  return !(
    path.endsWith('/.gitignore') ||
    path === 'ios/App/CapApp-SPM/README.md' ||
    path.startsWith('android/.gradle/') ||
    path.startsWith('android/build/') ||
    path.startsWith('android/app/build/') ||
    path.startsWith('android/app/src/test/') ||
    path.startsWith('android/app/src/androidTest/') ||
    path.startsWith('ios/App/CapApp-SPM/.swiftpm/')
  );
}

async function assertRegularDirectory(path) {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw fingerprintError(
      'b2_unsafe_input',
      `Application input is not a regular directory: ${path}`,
    );
  }
}

async function listInputFiles(root, entry) {
  const absolute = join(root, entry);
  const stats = await lstat(absolute);
  if (stats.isSymbolicLink()) {
    throw fingerprintError('b2_unsafe_input', `Application input is a symbolic link: ${entry}`);
  }
  if (stats.isFile()) return [entry];
  if (!stats.isDirectory()) {
    throw fingerprintError('b2_unsafe_input', `Application input is not regular: ${entry}`);
  }
  const files = [];
  async function walk(directory) {
    await assertRegularDirectory(directory);
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const path = join(directory, child.name);
      const relativePath = portablePath(root, path);
      if (!isB2ApplicationFingerprintInput(relativePath)) continue;
      if (child.isSymbolicLink()) {
        throw fingerprintError(
          'b2_unsafe_input',
          `Application input is a symbolic link: ${relativePath}`,
        );
      }
      if (child.isDirectory()) await walk(path);
      else if (child.isFile()) files.push(relativePath);
      else {
        throw fingerprintError(
          'b2_unsafe_input',
          `Application input is not regular: ${relativePath}`,
        );
      }
    }
  }
  await walk(absolute);
  return files;
}

export async function fingerprintB2Application({ root = ROOT } = {}) {
  const absoluteRoot = resolve(root);
  await assertRegularDirectory(absoluteRoot);
  const rootEntries = (await readdir(absoluteRoot, { withFileTypes: true })).map(
    ({ name }) => name,
  );
  for (const required of REQUIRED_ROOT_INPUTS) {
    if (!rootEntries.includes(required)) {
      throw fingerprintError(
        'b2_required_input_missing',
        `Required application input is missing: ${required}`,
      );
    }
  }
  const unregistered = rootEntries.filter(
    (entry) =>
      !REQUIRED_ROOT_INPUTS.includes(entry) &&
      !OPTIONAL_INPUT_ROOTS.has(entry) &&
      !EXCLUDED_ROOT_ENTRIES.has(entry),
  );
  if (unregistered.length > 0) {
    throw fingerprintError(
      'b2_unregistered_root_input',
      `Unregistered root application input: ${unregistered.toSorted().join(', ')}`,
    );
  }
  const roots = [
    ...REQUIRED_ROOT_INPUTS,
    ...[...OPTIONAL_INPUT_ROOTS].filter((entry) => rootEntries.includes(entry)),
  ].toSorted();
  const paths = (await Promise.all(roots.map((entry) => listInputFiles(absoluteRoot, entry))))
    .flat()
    .toSorted();
  const aggregate = createHash('sha256');
  const files = [];
  for (const path of paths) {
    const content = await readFile(join(absoluteRoot, path));
    const sha256 = createHash('sha256').update(content).digest('hex');
    files.push({ path, sha256 });
    aggregate.update(path);
    aggregate.update('\0');
    aggregate.update(sha256);
    aggregate.update('\0');
  }
  return {
    algorithm: 'sha256',
    sha256: aggregate.digest('hex'),
    fileCount: files.length,
    files,
  };
}

export async function main() {
  try {
    printJson({ ok: true, applicationFingerprint: await fingerprintB2Application() });
    return EXIT_CODES.success;
  } catch (error) {
    printJson(
      { ok: false, code: error.code ?? 'b2_fingerprint_failed', message: error.message },
      process.stderr,
    );
    return EXIT_CODES.stateMismatch;
  }
}

if (isMain(import.meta.url)) process.exitCode = await main();
