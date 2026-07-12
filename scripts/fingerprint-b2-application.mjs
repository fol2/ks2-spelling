import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

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
const REQUIRED_INPUT_ROOTS = Object.freeze([
  'android',
  'config',
  'ios',
  'provenance',
  'scripts',
  'src',
  'vendor',
]);
const OPTIONAL_INPUT_ROOTS = new Set(['public']);
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
const REQUIRED_AUTHORITY_INPUTS = Object.freeze([
  'config/dependency-policy.json',
  'config/maven-licence-policy.json',
  'config/mobile-identity.json',
  'config/third-party-notices-overrides.json',
  'provenance/ks2-mastery-gate-a.json',
  'src/main.jsx',
  'src/app/b2-proof-controller.js',
  'src/app/create-b2-app-services.js',
  'src/platform/database/capacitor-sqlite-connection.js',
  'src/platform/database/migrate-database.js',
  'src/platform/database/schema-v1.js',
  'src/platform/lifecycle/capacitor-app-lifecycle.js',
  'vendor/ks2-mastery/content/spelling.mobile-a1-kernel-manifest.json',
  'vendor/ks2-mastery/content/spelling.mobile-a2-contract-manifest.json',
  'vendor/ks2-mastery/content/spelling.mobile-a3-contract-manifest.json',
  'vendor/ks2-mastery/content/spelling.mobile-runtime-full.json',
  'vendor/ks2-mastery/content/spelling.mobile-runtime-starter.json',
  'vendor/ks2-mastery/shared/spelling/mobile/a3/command-repository.js',
  'scripts/lib/b2-evidence.mjs',
  'scripts/lib/b2-isolated-database-evidence.mjs',
  'scripts/fingerprint-b2-application.mjs',
  'scripts/native-sync-check.mjs',
  'scripts/prepare-native-dependencies.mjs',
  'scripts/test-ios.mjs',
  'scripts/test-android.mjs',
  'scripts/verify-vendored-contract.mjs',
  'android/build.gradle',
  'android/settings.gradle',
  'android/app/build.gradle',
  'android/app/src/main/AndroidManifest.xml',
  'android/app/src/main/assets/capacitor.config.json',
  'android/app/src/main/assets/capacitor.plugins.json',
  'android/app/src/main/assets/public/index.html',
  'ios/App/App.xcodeproj/project.pbxproj',
  'ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
  'ios/App/App/AppDelegate.swift',
  'ios/App/App/Info.plist',
  'ios/App/App/capacitor.config.json',
  'ios/App/App/public/index.html',
]);
const TASK_AWARE_PROOF_INPUTS = Object.freeze({
  'prove:b2:ios': {
    command: 'node scripts/prove-b2-ios.mjs',
    path: 'scripts/prove-b2-ios.mjs',
  },
  'prove:b2:android': {
    command: 'node scripts/prove-b2-android.mjs',
    path: 'scripts/prove-b2-android.mjs',
  },
});

function fingerprintError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function portablePath(root, path) {
  return relative(root, path).split(sep).join('/');
}

export function assertSafeB2FingerprintPaths(paths) {
  const canonicalPaths = new Map();
  const nonNormalised = [];
  for (const path of paths) {
    const hasControlCharacter =
      typeof path === 'string' &&
      [...path].some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint <= 31 || codePoint === 127;
      });
    if (
      typeof path !== 'string' ||
      !path ||
      hasControlCharacter ||
      path.includes('\\') ||
      path.includes(':') ||
      isAbsolute(path) ||
      posix.isAbsolute(path) ||
      posix.normalize(path) !== path ||
      path.startsWith('./') ||
      path.split('/').some((part) => !part || part === '.' || part === '..')
    ) {
      throw fingerprintError('b2_unsafe_path', `Unsafe fingerprint path: ${path}`);
    }
    const normalised = path.normalize('NFC');
    const collisionKey = normalised.toLowerCase();
    if (canonicalPaths.has(collisionKey)) {
      throw fingerprintError(
        'b2_path_collision',
        `Fingerprint paths collide: ${canonicalPaths.get(collisionKey)} and ${path}`,
      );
    }
    canonicalPaths.set(collisionKey, path);
    if (normalised !== path) nonNormalised.push(path);
  }
  if (nonNormalised.length > 0) {
    throw fingerprintError(
      'b2_unsafe_path',
      `Fingerprint paths are not NFC-normalised: ${nonNormalised.join(', ')}`,
    );
  }
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
  for (const required of REQUIRED_INPUT_ROOTS) {
    if (!rootEntries.includes(required)) {
      throw fingerprintError(
        'b2_required_input_missing',
        `Required behavioural input root is missing: ${required}`,
      );
    }
  }
  const unregistered = rootEntries.filter(
    (entry) =>
      !REQUIRED_ROOT_INPUTS.includes(entry) &&
      !REQUIRED_INPUT_ROOTS.includes(entry) &&
      !OPTIONAL_INPUT_ROOTS.has(entry) &&
      !EXCLUDED_ROOT_ENTRIES.has(entry),
  );
  if (unregistered.length > 0) {
    throw fingerprintError(
      'b2_unregistered_root_input',
      `Unregistered root application input: ${unregistered.toSorted().join(', ')}`,
    );
  }
  let packageJson;
  try {
    packageJson = JSON.parse(await readFile(join(absoluteRoot, 'package.json'), 'utf8'));
  } catch {
    throw fingerprintError('b2_unsafe_input', 'package.json is not valid JSON');
  }
  const taskAwareInputs = [];
  for (const [scriptName, authority] of Object.entries(TASK_AWARE_PROOF_INPUTS)) {
    if (packageJson.scripts?.[scriptName] === undefined) continue;
    if (packageJson.scripts[scriptName] !== authority.command) {
      throw fingerprintError(
        'b2_unsafe_input',
        `${scriptName} does not use the exact B2 proof authority`,
      );
    }
    taskAwareInputs.push(authority.path);
  }
  const roots = [
    ...REQUIRED_ROOT_INPUTS,
    ...REQUIRED_INPUT_ROOTS,
    ...[...OPTIONAL_INPUT_ROOTS].filter((entry) => rootEntries.includes(entry)),
  ].toSorted();
  const paths = (await Promise.all(roots.map((entry) => listInputFiles(absoluteRoot, entry))))
    .flat()
    .toSorted();
  assertSafeB2FingerprintPaths(paths);
  for (const required of [...REQUIRED_AUTHORITY_INPUTS, ...taskAwareInputs]) {
    if (!paths.includes(required)) {
      throw fingerprintError(
        'b2_required_input_missing',
        `Required behavioural authority input is missing: ${required}`,
      );
    }
  }
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
