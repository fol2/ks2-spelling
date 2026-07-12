import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readFrozenB2Blob } from './lib/frozen-b2-git.mjs';
import { EXIT_CODES, isMain, printJson } from './lib/run-command.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const REPORT_RELATIVE_PATH = 'reports/b2/native-plugin-build.json';
const REPORT_SHA256 = 'a72e95958e287be21f34588a167f12fd59058ab003dfe3f559b3ba244988a6f9';

export const B2_NATIVE_COMMITTED_INPUTS = Object.freeze([
  'package.json',
  'package-lock.json',
  'capacitor.config.json',
  'android/app/src/main/AndroidManifest.xml',
  'android/app/src/main/res/xml/backup_rules.xml',
  'android/app/src/main/res/xml/data_extraction_rules.xml',
  'android/app/capacitor.build.gradle',
  'android/capacitor.settings.gradle',
  'android/gradle/dependency-locks/app.lockfile',
  'android/gradle/dependency-locks/capacitor-android.lockfile',
  'android/gradle/dependency-locks/capacitor-app.lockfile',
  'android/gradle/dependency-locks/capacitor-community-sqlite.lockfile',
  'android/gradle/dependency-locks/capacitor-cordova-android-plugins.lockfile',
  'android/gradle/verification-metadata.xml',
  'ios/App/CapApp-SPM/Package.swift',
  'ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
  'ios/App/App/Info.plist',
  'scripts/prepare-native-dependencies.mjs',
  'scripts/build-b2-native-plugin-report.mjs',
  'scripts/test-ios.mjs',
  'scripts/test-android.mjs',
  'tests/native-dependency-preparation.test.mjs',
  'tests/b2-native-plugin-build-policy.test.mjs',
  'tests/app-shell.test.mjs',
  'tests/android-project-contract.test.mjs',
  'tests/ios-project-contract.test.mjs',
  'tests/native-wrapper-contract.test.mjs',
]);

function reportError(message) {
  const error = new Error(message);
  error.code = 'b2_native_plugin_report_invalid';
  return error;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readImmutableReport(root) {
  const path = join(root, REPORT_RELATIVE_PATH);
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    throw reportError('Frozen B2 native plugin report is unavailable');
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw reportError('Frozen B2 native plugin report is not a regular file');
  }
  const bytes = await readFile(path);
  if (sha256(bytes) !== REPORT_SHA256) {
    throw reportError('Frozen B2 native plugin report bytes drifted');
  }
  try {
    return { bytes, report: JSON.parse(bytes.toString('utf8')) };
  } catch {
    throw reportError('Frozen B2 native plugin report is not valid JSON');
  }
}

export async function assertB2NativePluginReportCurrent(
  report,
  {
    root = ROOT,
    frozenReader = (path) => readFrozenB2Blob({ root, path }),
  } = {},
) {
  const immutable = await readImmutableReport(root);
  if (!isDeepStrictEqual(report, immutable.report)) {
    throw reportError('B2 native plugin report does not match immutable report bytes');
  }
  if (
    !Array.isArray(report.committedInputs) ||
    !isDeepStrictEqual(
      report.committedInputs.map(({ path }) => path),
      B2_NATIVE_COMMITTED_INPUTS,
    )
  ) {
    throw reportError('Committed input inventory drifted');
  }
  for (const entry of report.committedInputs) {
    if (entry.sha256 !== sha256(await frozenReader(entry.path))) {
      throw reportError(`Committed input hash drifted: ${entry.path}`);
    }
  }
  return report;
}

export async function buildB2NativePluginReport({
  root = ROOT,
  frozenReader = (path) => readFrozenB2Blob({ root, path }),
} = {}) {
  const { report } = await readImmutableReport(root);
  await assertB2NativePluginReportCurrent(report, { root, frozenReader });
  return report;
}

export async function main(args = process.argv.slice(2)) {
  try {
    if (resolveB2NativeReportMode(args) === 'check') {
      await buildB2NativePluginReport();
      printJson({ ok: true, code: 'b2_native_plugin_report_current' });
      return EXIT_CODES.success;
    }
    throw reportError('B2 native plugin evidence is frozen and cannot be rebuilt at B3 HEAD');
  } catch (error) {
    printJson(
      { ok: false, code: error.code ?? 'b2_native_plugin_report_failed', message: error.message },
      process.stderr,
    );
    return EXIT_CODES.stateMismatch;
  }
}

export function resolveB2NativeReportMode(args) {
  return Array.isArray(args) &&
    (args.length === 0 || (args.length === 1 && args[0] === '--check'))
    ? 'check'
    : 'reject';
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
