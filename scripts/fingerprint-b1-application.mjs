import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { EXIT_CODES, isMain, printJson } from './lib/run-command.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const TESTED_APPLICATION_COMMIT =
  '9c4891f20048080a7e6ea51bc6751a1ed28281dd';
const REQUIRED_ROOT_INPUTS = Object.freeze([
  '.npmrc',
  '.nvmrc',
  'capacitor.config.json',
  'index.html',
  'package-lock.json',
  'package.json',
  'vite.config.js',
]);
const OPTIONAL_ROOT_INPUTS = new Set([
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
  'AGENTS.md',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'dist',
  'docs',
  'node_modules',
  'reports',
  'tests',
]);

function fingerprintError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isExcludedNestedPath(path) {
  return (
    // These exact Task 9 orchestration files capture evidence but cannot alter packaged bytes.
    path === 'scripts/fingerprint-b1-application.mjs' ||
    path === 'scripts/launch-android-emulator.mjs' ||
    path === 'scripts/launch-ios-simulator.mjs' ||
    path.endsWith('/.gitignore') ||
    // Exclude exact caches/build/test outputs; synced native packaging inputs stay included.
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
    throw fingerprintError('b1_unsafe_input', `Application input is not a regular directory: ${path}`);
  }
}

async function listInputFiles(root, entry) {
  const absolute = join(root, entry);
  const stats = await lstat(absolute);
  if (stats.isSymbolicLink()) {
    throw fingerprintError('b1_unsafe_input', `Application input is a symbolic link: ${entry}`);
  }
  if (stats.isFile()) return [entry];
  if (!stats.isDirectory()) {
    throw fingerprintError('b1_unsafe_input', `Application input is not regular: ${entry}`);
  }
  const files = [];
  async function walk(directory) {
    await assertRegularDirectory(directory);
    for (const child of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, child.name);
      const relativePath = relative(root, path);
      if (isExcludedNestedPath(relativePath)) continue;
      if (child.isSymbolicLink()) {
        throw fingerprintError(
          'b1_unsafe_input',
          `Application input is a symbolic link: ${relativePath}`,
        );
      }
      if (child.isDirectory()) await walk(path);
      else if (child.isFile()) files.push(relativePath);
      else {
        throw fingerprintError('b1_unsafe_input', `Application input is not regular: ${relativePath}`);
      }
    }
  }
  await walk(absolute);
  return files;
}

export async function fingerprintB1Application({ root = ROOT } = {}) {
  const absoluteRoot = resolve(root);
  await assertRegularDirectory(absoluteRoot);
  const rootEntries = (await readdir(absoluteRoot, { withFileTypes: true })).map(
    ({ name }) => name,
  );
  for (const required of REQUIRED_ROOT_INPUTS) {
    if (!rootEntries.includes(required)) {
      throw fingerprintError(
        'b1_required_input_missing',
        `Required application input is missing: ${required}`,
      );
    }
  }
  const unregistered = rootEntries.filter(
    (entry) =>
      !REQUIRED_ROOT_INPUTS.includes(entry) &&
      !OPTIONAL_ROOT_INPUTS.has(entry) &&
      !EXCLUDED_ROOT_ENTRIES.has(entry),
  );
  if (unregistered.length) {
    throw fingerprintError(
      'b1_unregistered_root_input',
      `Unregistered root application input: ${unregistered.sort().join(', ')}`,
    );
  }
  const inputRoots = [
    ...REQUIRED_ROOT_INPUTS,
    ...[...OPTIONAL_ROOT_INPUTS].filter((entry) => rootEntries.includes(entry)),
  ].sort();
  const paths = (
    await Promise.all(inputRoots.map((entry) => listInputFiles(absoluteRoot, entry)))
  )
    .flat()
    .sort();
  const files = [];
  const aggregate = createHash('sha256');
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

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

export async function writeB1ExitReport({ visualReviewApproved = false } = {}) {
  if (!visualReviewApproved) {
    throw fingerprintError(
      'b1_visual_review_required',
      'Both native screenshots require explicit visual review before exit-report generation',
    );
  }
  const iosPath = join(ROOT, 'reports/b1/ios-simulator-launch.json');
  const androidPath = join(ROOT, 'reports/b1/android-emulator-launch.json');
  const [iosText, androidText, currentFingerprint] = await Promise.all([
    readFile(iosPath, 'utf8'),
    readFile(androidPath, 'utf8'),
    fingerprintB1Application({ root: ROOT }),
  ]);
  const ios = JSON.parse(iosText);
  const android = JSON.parse(androidText);
  for (const report of [ios, android]) {
    if (
      report.testedApplicationCommit !== TESTED_APPLICATION_COMMIT ||
      JSON.stringify(report.applicationFingerprint) !==
        JSON.stringify(currentFingerprint) ||
      report.bundle?.serverUrl !== null ||
      sha256(await readFile(join(ROOT, report.screenshot?.path ?? ''))) !==
        report.screenshot?.sha256
    ) {
      throw fingerprintError(
        'b1_launch_evidence_stale',
        'Native launch evidence is stale or incomplete',
      );
    }
  }
  if (
    ios.platform !== 'ios-simulator' ||
    android.platform !== 'android-emulator' ||
    ios.uiReadiness?.source !== 'screenshot-bmp-dark-shell-ratio' ||
    ios.uiReadiness?.width !== 1206 ||
    ios.uiReadiness?.height !== 2622 ||
    !(ios.uiReadiness?.darkPixelRatio >= 0.3) ||
    !Number.isInteger(ios.uiReadiness?.attempts) ||
    ios.uiReadiness.attempts < 1 ||
    ios.bundle.indexHtmlSha256 !== android.bundle.indexHtmlSha256 ||
    android.packagedPermissions?.declared?.length !== 0 ||
    android.packagedPermissions?.requested?.length !== 0 ||
    android.uiReadiness?.status !== 'ready' ||
    JSON.stringify(android.uiReadiness?.requiredTexts) !==
      JSON.stringify([
        'KS2 Spelling',
        'Starter content: 20 words',
        'Bundled locally',
      ]) ||
    !/^[a-f0-9]{64}$/.test(android.uiReadiness?.hierarchySha256 ?? '') ||
    !Number.isInteger(android.uiReadiness?.attempts) ||
    android.uiReadiness.attempts < 1
  ) {
    throw fingerprintError(
      'b1_launch_evidence_invalid',
      'Native launch evidence does not prove the same permission-free bundled application',
    );
  }
  const report = {
    schemaVersion: 1,
    status: 'pass',
    testedApplicationCommit: TESTED_APPLICATION_COMMIT,
    applicationFingerprint: currentFingerprint,
    serverUrl: null,
    bundledIndexHtmlSha256: ios.bundle.indexHtmlSha256,
    platforms: {
      ios: {
        report: 'reports/b1/ios-simulator-launch.json',
        sha256: sha256(iosText),
      },
      android: {
        report: 'reports/b1/android-emulator-launch.json',
        sha256: sha256(androidText),
      },
    },
    visualReview: {
      identicalBundledB1Shell: true,
      iosErrorOrLiveReloadScreen: false,
      androidErrorOrLiveReloadScreen: false,
    },
  };
  await mkdir(join(ROOT, 'reports/b1'), { recursive: true });
  await writeFile(
    join(ROOT, 'reports/b1/b1-exit-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  return report;
}

export async function main(args = process.argv.slice(2)) {
  try {
    if (args.includes('--write-exit-report')) {
      const report = await writeB1ExitReport({
        visualReviewApproved: args.includes('--visual-review-approved'),
      });
      printJson({ ok: true, exitReport: 'reports/b1/b1-exit-report.json', report });
    } else {
      printJson({ ok: true, applicationFingerprint: await fingerprintB1Application() });
    }
    return EXIT_CODES.success;
  } catch (error) {
    printJson(
      { ok: false, code: error.code ?? 'b1_fingerprint_failed', message: error.message },
      process.stderr,
    );
    return EXIT_CODES.stateMismatch;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
