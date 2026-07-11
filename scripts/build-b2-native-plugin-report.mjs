import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { resolveAndroidDependencies } from './resolve-android-dependencies.mjs';
import {
  ANDROID_BUILD_COMMAND,
  buildAndroidApplication,
} from './test-android.mjs';
import { IOS_BUILD_COMMAND, buildIosApplication } from './test-ios.mjs';
import {
  NATIVE_DEPENDENCY_PATCH,
  prepareNativeDependencies,
} from './prepare-native-dependencies.mjs';
import { EXIT_CODES, isMain, printJson } from './lib/run-command.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const REPORT_PATH = join(ROOT, 'reports/b2/native-plugin-build.json');
const EXPECTED_PLUGINS = Object.freeze({
  '@capacitor-community/sqlite': Object.freeze({
    version: '8.1.0',
    integrity:
      'sha512-yhKZDAVPDPcM3QE6UGB3LXyV25a6Rve1SjZ1aUpTE0E2isnYTVM0PG9+JOI241f+NdsHzPTE7ESJiYSqKsKnuA==',
  }),
  '@capacitor/app': Object.freeze({
    version: '8.1.0',
    integrity:
      'sha512-MlmttTOWHDedr/G4SrhNRxsXMqY+R75S4MM4eIgzsgCzOYhb/MpCkA5Q3nuOCfL1oHm26xjUzqZ5aupbOwdfYg==',
  }),
});
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
const GENERATED_NATIVE_INPUTS = Object.freeze([
  'android/app/src/main/assets/capacitor.config.json',
  'ios/App/App/capacitor.config.json',
]);
const ANDROID_OUTPUTS = Object.freeze([
  '.native-build/android/build/app/outputs/apk/debug/app-debug.apk',
  '.native-build/android/build/app/outputs/apk/release/app-release-unsigned.apk',
]);
const IOS_OUTPUTS = Object.freeze([
  '.native-build/ios/Build/Products/Debug-iphonesimulator/App.app/App',
  '.native-build/ios/Build/Products/Debug-iphonesimulator/App.app/Frameworks/Capacitor.framework/Capacitor',
  '.native-build/ios/Build/Products/Debug-iphonesimulator/App.app/Frameworks/Cordova.framework/Cordova',
  '.native-build/ios/Build/Products/Debug-iphonesimulator/App.app/Frameworks/SQLCipher.framework/SQLCipher',
]);
const EXPECTED_CAPACITOR_PIN = Object.freeze({
  identity: 'capacitor-swift-pm',
  kind: 'remoteSourceControl',
  location: 'https://github.com/ionic-team/capacitor-swift-pm.git',
  state: Object.freeze({
    revision: '2231987d85b8b0b289320b1d0947b4ae8345cde4',
    version: '8.4.1',
  }),
});

function reportError(message) {
  const error = new Error(message);
  error.code = 'b2_native_plugin_report_invalid';
  return error;
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(join(ROOT, path))).digest('hex');
}

async function inventory(paths) {
  return Promise.all(
    paths.map(async (path) => ({
      path,
      bytes: (await stat(join(ROOT, path))).size,
      sha256: await sha256File(path),
    })),
  );
}

function canonicalPins(packageResolved) {
  if (packageResolved.version !== 3 || !Array.isArray(packageResolved.pins)) {
    throw reportError('Unsupported SwiftPM Package.resolved schema');
  }
  return packageResolved.pins.map(({ identity, kind, location, state }) => ({
    identity,
    kind,
    location,
    state,
  }));
}

function assertExpectedPins(pins) {
  const capacitor = pins.find(({ identity }) => identity === 'capacitor-swift-pm');
  if (JSON.stringify(capacitor) !== JSON.stringify(EXPECTED_CAPACITOR_PIN)) {
    throw reportError('SwiftPM did not resolve exact Capacitor 8.4.1');
  }
  for (const identity of ['sqlcipher.swift', 'zipfoundation']) {
    const pin = pins.find((entry) => entry.identity === identity);
    if (
      pin?.kind !== 'remoteSourceControl' ||
      !/^[0-9a-f]{40}$/.test(pin.state?.revision ?? '') ||
      !/^\d+\.\d+\.\d+$/.test(pin.state?.version ?? '') ||
      Object.hasOwn(pin.state ?? {}, 'branch')
    ) {
      throw reportError(`SwiftPM pin is not exact version plus revision: ${identity}`);
    }
  }
}

function commandAttestation(command) {
  const value = { command: command.command, args: [...command.args] };
  return {
    ...value,
    sha256: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
  };
}

function assertOutputEntry(entry, expectedSourcePin) {
  const expectedKeys = expectedSourcePin
    ? ['bytes', 'path', 'sha256', 'sourcePin']
    : ['bytes', 'path', 'sha256'];
  if (
    JSON.stringify(Object.keys(entry ?? {}).sort()) !== JSON.stringify(expectedKeys) ||
    !Number.isSafeInteger(entry?.bytes) ||
    entry.bytes <= 0 ||
    !/^[a-f0-9]{64}$/.test(entry?.sha256 ?? '')
  ) {
    throw reportError(`Native output evidence is structurally invalid: ${entry?.path}`);
  }
  if (
    expectedSourcePin &&
    JSON.stringify(entry.sourcePin) !== JSON.stringify(expectedSourcePin)
  ) {
    throw reportError(`Native output source pin drifted: ${entry.path}`);
  }
}

export async function assertB2NativePluginReportCurrent(report, options = {}) {
  if (report?.schemaVersion !== 2) throw reportError('Unsupported report schema');
  if (JSON.stringify(report.packages) !== JSON.stringify(EXPECTED_PLUGINS)) {
    throw reportError('Plugin package identities drifted');
  }
  if (
    JSON.stringify({
      ...NATIVE_DEPENDENCY_PATCH,
      appliedOrVerifiedBy: 'scripts/prepare-native-dependencies.mjs',
      preparedManifestVerified: NATIVE_DEPENDENCY_PATCH.preparedManifestSha256,
    }) !== JSON.stringify(report.preparation)
  ) {
    throw reportError('Native dependency patch provenance drifted');
  }
  if (
    JSON.stringify(report.committedInputs.map(({ path }) => path)) !==
    JSON.stringify(B2_NATIVE_COMMITTED_INPUTS)
  ) {
    throw reportError('Committed input inventory drifted');
  }
  for (const entry of report.committedInputs) {
    if (entry.sha256 !== (await sha256File(entry.path))) {
      throw reportError(`Committed input hash drifted: ${entry.path}`);
    }
  }
  const pins = canonicalPins(
    JSON.parse(
      await readFile(
        join(
          ROOT,
          'ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
        ),
        'utf8',
      ),
    ),
  );
  assertExpectedPins(pins);
  if (JSON.stringify(report.ios.spmPins) !== JSON.stringify(pins)) {
    throw reportError('Committed SwiftPM pins drifted from the build report');
  }
  if (
    JSON.stringify(report.commands) !==
    JSON.stringify({
      ios: commandAttestation(IOS_BUILD_COMMAND),
      android: commandAttestation(ANDROID_BUILD_COMMAND),
    })
  ) {
    throw reportError('Native wrapper command attestation drifted');
  }
  if (
    JSON.stringify(report.builds?.ios) !==
      JSON.stringify({
        ok: true,
        platform: 'ios',
        scheme: 'KS2Spelling',
        compiled: true,
        sdk: 'iphonesimulator',
        configuration: 'Debug',
        signed: false,
        appPath: '.native-build/ios/Build/Products/Debug-iphonesimulator/App.app',
      }) ||
    JSON.stringify(report.builds?.android) !==
      JSON.stringify({
        ok: true,
        platform: 'android',
        unitTestsPassed: true,
        debugCompiled: true,
        debugSigned: true,
        releaseCompiled: true,
        releaseSigned: false,
      })
  ) {
    throw reportError('Native wrapper result attestation is incomplete');
  }
  if (
    JSON.stringify(report.generatedNativeInputs?.map(({ path }) => path)) !==
    JSON.stringify(GENERATED_NATIVE_INPUTS)
  ) {
    throw reportError('Generated native input inventory drifted');
  }
  const generatedPresent = GENERATED_NATIVE_INPUTS.filter((path) =>
    existsSync(join(ROOT, path)),
  );
  if (
    generatedPresent.length !== 0 &&
    generatedPresent.length !== GENERATED_NATIVE_INPUTS.length
  ) {
    throw reportError('Generated native input inventory is incomplete');
  }
  if (generatedPresent.length === GENERATED_NATIVE_INPUTS.length) {
    const currentGenerated = await inventory(GENERATED_NATIVE_INPUTS);
    if (JSON.stringify(currentGenerated) !== JSON.stringify(report.generatedNativeInputs)) {
      throw reportError('Generated native input hashes drifted');
    }
  }
  if (
    JSON.stringify(report.android?.outputInventory?.map(({ path }) => path)) !==
      JSON.stringify(ANDROID_OUTPUTS) ||
    JSON.stringify(report.ios?.outputInventory?.map(({ path }) => path)) !==
      JSON.stringify(IOS_OUTPUTS)
  ) {
    throw reportError('Native build output path inventory drifted');
  }
  for (const entry of report.android.outputInventory) {
    assertOutputEntry(entry, null);
  }
  const iosOutputByPath = new Map(
    report.ios.outputInventory.map((entry) => [entry.path, entry]),
  );
  assertOutputEntry(iosOutputByPath.get(IOS_OUTPUTS[0]), null);
  assertOutputEntry(iosOutputByPath.get(IOS_OUTPUTS[1]), EXPECTED_CAPACITOR_PIN);
  assertOutputEntry(iosOutputByPath.get(IOS_OUTPUTS[2]), EXPECTED_CAPACITOR_PIN);
  const sqlCipherPin = pins.find(({ identity }) => identity === 'sqlcipher.swift');
  assertOutputEntry(iosOutputByPath.get(IOS_OUTPUTS[3]), sqlCipherPin);
  if (options.verifyLocalOutputs !== false) {
    const outputPaths = [...ANDROID_OUTPUTS, ...IOS_OUTPUTS];
    const present = outputPaths.filter((path) => existsSync(join(ROOT, path)));
    if (present.length !== 0 && present.length !== outputPaths.length) {
      throw reportError('Local native build output inventory is incomplete');
    }
    if (present.length === outputPaths.length) {
      const current = await inventory(outputPaths);
      const recorded = [
        ...report.android.outputInventory,
        ...report.ios.outputInventory,
      ].map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
      if (JSON.stringify(current) !== JSON.stringify(recorded)) {
        throw reportError('Local native build output hashes drifted');
      }
    }
  }
  return report;
}

export async function buildB2NativePluginReport() {
  const preparation = await prepareNativeDependencies();
  const iosEvidence = await buildIosApplication();
  const androidEvidence = await buildAndroidApplication();
  const androidResolution = await resolveAndroidDependencies();
  const packageResolved = JSON.parse(
    await readFile(
      join(
        ROOT,
        'ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
      ),
      'utf8',
    ),
  );
  const spmPins = canonicalPins(packageResolved);
  assertExpectedPins(spmPins);
  const generatedNativeInputs = await inventory(GENERATED_NATIVE_INPUTS);
  const androidOutputs = await inventory(ANDROID_OUTPUTS);
  const iosOutputs = await inventory(IOS_OUTPUTS);
  const capacitorPin = spmPins.find(({ identity }) => identity === 'capacitor-swift-pm');
  const sqlCipherPin = spmPins.find(({ identity }) => identity === 'sqlcipher.swift');
  const annotatedIosOutputs = iosOutputs.map((entry) => {
    if (/\/(?:Capacitor|Cordova)\.framework\//.test(entry.path)) {
      return { ...entry, sourcePin: capacitorPin };
    }
    if (/\/SQLCipher\.framework\//.test(entry.path)) {
      return { ...entry, sourcePin: sqlCipherPin };
    }
    return entry;
  });
  const report = {
    schemaVersion: 2,
    packages: EXPECTED_PLUGINS,
    preparation: {
      ...NATIVE_DEPENDENCY_PATCH,
      appliedOrVerifiedBy: 'scripts/prepare-native-dependencies.mjs',
      preparedManifestVerified: preparation.preparedManifestSha256,
    },
    commands: {
      ios: commandAttestation(IOS_BUILD_COMMAND),
      android: commandAttestation(ANDROID_BUILD_COMMAND),
    },
    committedInputs: await inventory(B2_NATIVE_COMMITTED_INPUTS),
    generatedNativeInputs,
    builds: {
      ios: iosEvidence,
      android: {
        ok: androidEvidence.ok,
        platform: androidEvidence.platform,
        unitTestsPassed: androidEvidence.unitTestsPassed,
        debugCompiled: androidEvidence.debugCompiled,
        debugSigned: androidEvidence.debugSigned,
        releaseCompiled: androidEvidence.releaseCompiled,
        releaseSigned: androidEvidence.releaseSigned,
      },
    },
    android: {
      dependencyClosure: {
        componentCount: androidResolution.componentCount,
        scopeMembershipCount: androidResolution.scopeMembershipCount,
      },
      packagedPermissions: {
        appIdentity: androidEvidence.appIdentity,
        buildToolsVersion: androidEvidence.buildToolsVersion,
        permissionSurfaceSha256: androidEvidence.permissionSurfaceSha256,
        declaredPermissions: androidEvidence.declaredPermissions,
        requestedPermissions: androidEvidence.requestedPermissions,
      },
      packagedManifest: androidEvidence.packagedManifest,
      packagedBackupRules: androidEvidence.packagedBackupRules,
      packagedDataExtractionRules: androidEvidence.packagedDataExtractionRules,
      outputInventory: androidOutputs,
    },
    ios: {
      spmPins,
      addedUsageDescriptionKeys: [],
      addedEntitlements: [],
      outputInventory: annotatedIosOutputs,
    },
    nativeConfig: {
      sqliteMode: 'no-encryption',
      webFallbackInitialised: false,
      serverUrlConfigured: false,
    },
    approval: 'build-proof-only',
    finalPrivacyApproval: false,
    finalExportApproval: false,
  };
  await assertB2NativePluginReportCurrent(report);
  return report;
}

export async function main(args = process.argv.slice(2)) {
  try {
    if (args.includes('--check')) {
      await assertB2NativePluginReportCurrent(
        JSON.parse(await readFile(REPORT_PATH, 'utf8')),
      );
      printJson({ ok: true, code: 'b2_native_plugin_report_current' });
      return EXIT_CODES.success;
    }
    const report = await buildB2NativePluginReport();
    await mkdir(dirname(REPORT_PATH), { recursive: true });
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    printJson({ ok: true, code: 'b2_native_plugin_report_written' });
    return EXIT_CODES.success;
  } catch (error) {
    printJson(
      { ok: false, code: error.code ?? 'b2_native_plugin_report_failed', message: error.message },
      process.stderr,
    );
    return EXIT_CODES.stateMismatch;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
