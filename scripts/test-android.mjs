import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  EXIT_CODES,
  isMain,
  printJson,
  runCommand,
} from './lib/run-command.mjs';
import { prepareNativeDependencies } from './prepare-native-dependencies.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const ANDROID_STUDIO_JBR = '/Applications/Android Studio.app/Contents/jbr/Contents/Home';
const DEBUG_APK = join(
  ROOT,
  '.native-build/android/build/app/outputs/apk/debug/app-debug.apk',
);
const RELEASE_APK = join(
  ROOT,
  '.native-build/android/build/app/outputs/apk/release/app-release-unsigned.apk',
);
const BACKUP_DOMAINS = Object.freeze([
  'root',
  'file',
  'database',
  'sharedpref',
  'external',
]);
const DATA_EXTRACTION_DOMAINS = Object.freeze([
  ...BACKUP_DOMAINS,
  'device_root',
  'device_file',
  'device_database',
  'device_sharedpref',
]);

export const GRADLE_INIT_SCRIPT = `gradle.beforeProject { project ->
    def nativeRoot = new File(project.rootProject.projectDir, "../.native-build/android/build")
    def projectPath = project.path == ":" ? "root" : project.path.substring(1).replace(":", "/")
    project.layout.buildDirectory.set(new File(nativeRoot, projectPath))
}
`;

export const ANDROID_BUILD_COMMAND = Object.freeze({
  command: 'android/gradlew',
  args: Object.freeze([
    '--no-daemon',
    '--project-dir',
    'android',
    '--project-cache-dir',
    '../.native-build/android/project-cache',
    '--init-script',
    '../.native-build/android/native-output.init.gradle',
    'testDebugUnitTest',
    'assembleDebug',
    'assembleRelease',
  ]),
});

export const ANDROID_BUILD_EVIDENCE = Object.freeze({
  platform: 'android',
  variant: 'debug',
  signing: 'debug',
});

function packagedPermissionError(message) {
  const error = new Error(message);
  error.code = 'android_packaged_permission_detected';
  return error;
}

function packagedBackupPolicyError(message) {
  const error = new Error(message);
  error.code = 'android_packaged_backup_policy_invalid';
  return error;
}

function requireExactDomains(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw packagedBackupPolicyError(
      `${label} exclusions differ; expected=${expected.join(',')}; actual=${actual.join(',')}`,
    );
  }
  return actual;
}

function parseExclusionDomains(output, label) {
  const exclusions = [
    ...output.matchAll(
      /E: exclude[^\n]*\n\s+A: domain="([^"]+)"[^\n]*\n\s+A: path="([^"]+)"/g,
    ),
  ].map(([, domain, path]) => ({ domain, path }));
  if (exclusions.some(({ path }) => path !== '.')) {
    throw packagedBackupPolicyError(`${label} contains a non-root exclusion path`);
  }
  const domains = exclusions.map(({ domain }) => domain);
  if (new Set(domains).size !== domains.length) {
    throw packagedBackupPolicyError(`${label} contains duplicate exclusions`);
  }
  return domains;
}

export function parsePackagedAndroidManifestPolicy(output) {
  const allowBackup = output.match(/:allowBackup\([^)]*\)=(true|false)/)?.[1];
  const fullBackupContentResourceId = output.match(
    /:fullBackupContent\([^)]*\)=(@0x[a-f0-9]+)/,
  )?.[1];
  const dataExtractionRulesResourceId = output.match(
    /:dataExtractionRules\([^)]*\)=(@0x[a-f0-9]+)/,
  )?.[1];
  if (
    allowBackup !== 'false' ||
    !fullBackupContentResourceId ||
    !dataExtractionRulesResourceId
  ) {
    throw packagedBackupPolicyError(
      'Packaged manifest does not disable backup with both exclusion resources',
    );
  }
  return {
    allowBackup: false,
    fullBackupContent: '@xml/backup_rules',
    fullBackupContentResourceId,
    dataExtractionRules: '@xml/data_extraction_rules',
    dataExtractionRulesResourceId,
  };
}

export function parsePackagedAndroidBackupRules(output) {
  if (!/^E: full-backup-content\b/m.test(output)) {
    throw packagedBackupPolicyError('Packaged legacy backup rules root is missing');
  }
  return {
    excludedDomains: requireExactDomains(
      parseExclusionDomains(output, 'legacy backup'),
      BACKUP_DOMAINS,
      'legacy backup',
    ),
  };
}

export function parsePackagedAndroidDataExtractionRules(output) {
  if (!/^E: data-extraction-rules\b/m.test(output)) {
    throw packagedBackupPolicyError('Packaged data-extraction rules root is missing');
  }
  const cloudStart = output.search(/^\s*E: cloud-backup\b/m);
  const transferStart = output.search(/^\s*E: device-transfer\b/m);
  if (cloudStart < 0 || transferStart <= cloudStart) {
    throw packagedBackupPolicyError('Packaged backup and transfer sections are missing');
  }
  return {
    cloudBackupExcludedDomains: requireExactDomains(
      parseExclusionDomains(output.slice(cloudStart, transferStart), 'cloud backup'),
      DATA_EXTRACTION_DOMAINS,
      'cloud backup',
    ),
    deviceTransferExcludedDomains: requireExactDomains(
      parseExclusionDomains(output.slice(transferStart), 'device transfer'),
      DATA_EXTRACTION_DOMAINS,
      'device transfer',
    ),
  };
}

async function dumpPackagedXml(aapt2, apk, file) {
  const result = await runCommand(aapt2, ['dump', 'xmltree', '--file', file, apk], {
    cwd: ROOT,
  });
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    throw packagedBackupPolicyError(`aapt2 could not inspect packaged ${file}`);
  }
  return result.stdout;
}

export async function verifyPackagedAndroidBackupPolicy(options = {}) {
  const resolution = resolveAndroidEnvironment();
  const androidSdkRoot = options.androidSdkRoot ?? resolution.androidSdkRoot;
  const buildTools36 =
    options.buildTools36 ??
    (androidSdkRoot ? await findBuildTools36(androidSdkRoot) : null);
  if (!androidSdkRoot || !buildTools36 || !existsSync(DEBUG_APK)) {
    throw packagedBackupPolicyError('Android APK inspection inputs are unavailable');
  }
  const aapt2 = join(androidSdkRoot, 'build-tools', buildTools36, 'aapt2');
  const [manifestOutput, backupOutput, dataExtractionOutput] = await Promise.all([
    dumpPackagedXml(aapt2, DEBUG_APK, 'AndroidManifest.xml'),
    dumpPackagedXml(aapt2, DEBUG_APK, 'res/xml/backup_rules.xml'),
    dumpPackagedXml(aapt2, DEBUG_APK, 'res/xml/data_extraction_rules.xml'),
  ]);
  return {
    packagedManifest: {
      ...parsePackagedAndroidManifestPolicy(manifestOutput),
      xmlTreeSha256: createHash('sha256').update(manifestOutput).digest('hex'),
    },
    packagedBackupRules: {
      ...parsePackagedAndroidBackupRules(backupOutput),
      xmlTreeSha256: createHash('sha256').update(backupOutput).digest('hex'),
    },
    packagedDataExtractionRules: {
      ...parsePackagedAndroidDataExtractionRules(dataExtractionOutput),
      xmlTreeSha256: createHash('sha256').update(dataExtractionOutput).digest('hex'),
    },
  };
}

export function parsePackagedAndroidPermissions(output) {
  let appIdentity = null;
  const declaredPermissions = [];
  const requestedPermissions = [];
  for (const line of output.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
    const packageName = line.match(/^package:\s+([^\s]+)$/)?.[1];
    if (packageName) {
      if (appIdentity !== null) {
        throw packagedPermissionError('Duplicate package identity in aapt2 output');
      }
      appIdentity = packageName;
      continue;
    }
    const declared = line.match(/^permission:\s+(.+)$/)?.[1];
    if (declared) {
      declaredPermissions.push(declared);
      continue;
    }
    const requested = line.match(/^uses-permission:\s+name='([^']+)'$/)?.[1];
    if (requested) {
      requestedPermissions.push(requested);
      continue;
    }
    throw packagedPermissionError(`Unparsed aapt2 permission output: ${line}`);
  }
  if (declaredPermissions.length || requestedPermissions.length) {
    throw packagedPermissionError(
      `Packaged Android permission surface is not empty; declared=${declaredPermissions.join(',')}; requested=${requestedPermissions.join(',')}`,
    );
  }
  if (appIdentity !== 'uk.eugnel.ks2spelling') {
    throw packagedPermissionError(`Unexpected packaged Android identity: ${appIdentity}`);
  }
  return { appIdentity, declaredPermissions, requestedPermissions };
}

export async function verifyPackagedAndroidPermissions(options = {}) {
  const resolution = resolveAndroidEnvironment();
  const androidSdkRoot = options.androidSdkRoot ?? resolution.androidSdkRoot;
  const buildTools36 =
    options.buildTools36 ??
    (androidSdkRoot ? await findBuildTools36(androidSdkRoot) : null);
  if (!androidSdkRoot || !buildTools36) {
    throw packagedPermissionError('Android Build Tools 36 are unavailable');
  }
  if (!existsSync(DEBUG_APK)) {
    throw packagedPermissionError('Debug APK is missing for packaged permission inspection');
  }
  const aapt2 = join(androidSdkRoot, 'build-tools', buildTools36, 'aapt2');
  const result = await runCommand(aapt2, ['dump', 'permissions', DEBUG_APK], {
    cwd: ROOT,
  });
  if (result.exitCode !== 0) {
    throw packagedPermissionError(`aapt2 permission inspection failed with ${result.exitCode}`);
  }
  const permissions = parsePackagedAndroidPermissions(result.stdout);
  const permissionSurfaceSha256 = createHash('sha256')
    .update(JSON.stringify(permissions))
    .digest('hex');
  return {
    ...permissions,
    apkPath: '.native-build/android/build/app/outputs/apk/debug/app-debug.apk',
    permissionSurfaceSha256,
    buildToolsVersion: buildTools36,
  };
}

export function resolveAndroidEnvironment({ env = process.env, pathExists = existsSync } = {}) {
  const javaCandidates = [
    { path: env.JAVA_HOME, source: 'JAVA_HOME' },
    { path: ANDROID_STUDIO_JBR, source: 'android-studio-jbr' },
  ]
    .filter(({ path }) => Boolean(path))
    .map(({ path, source }) => ({ path: resolve(path), source }));
  const selectedJava =
    javaCandidates.find(({ path }) => pathExists(join(path, 'bin/java'))) ?? null;
  const javaHome = selectedJava?.path ?? null;
  const javaSource =
    javaHome === resolve(ANDROID_STUDIO_JBR)
      ? 'android-studio-jbr'
      : selectedJava?.source ?? null;
  const sdkCandidates = [env.ANDROID_HOME, join(env.HOME ?? '', 'Library/Android/sdk')].filter(
    Boolean,
  );
  const androidSdkRoot = sdkCandidates.find((candidate) => pathExists(candidate)) ?? null;
  const missing = [];
  if (!javaHome) missing.push('jbr');
  if (!androidSdkRoot) missing.push('androidSdk');
  return {
    ready: missing.length === 0,
    missing,
    javaHome,
    javaSource,
    androidSdkRoot,
  };
}

async function findBuildTools36(androidSdkRoot) {
  try {
    const versions = await readdir(join(androidSdkRoot, 'build-tools'));
    return versions.includes('36.0.0') ? '36.0.0' : null;
  } catch {
    return null;
  }
}

function androidBuildError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export async function buildAndroidApplication({ stream = true } = {}) {
  try {
    await prepareNativeDependencies();
  } catch (error) {
    throw androidBuildError(error.code, error.message);
  }
  const resolution = resolveAndroidEnvironment();
  if (!resolution.ready) {
    throw androidBuildError(
      'missing_android_toolchain',
      `Missing Android toolchain: ${resolution.missing.join(', ')}`,
    );
  }

  const platform36 = join(resolution.androidSdkRoot, 'platforms/android-36/android.jar');
  const buildTools36 = await findBuildTools36(resolution.androidSdkRoot);
  const missingPackages = [];
  if (!existsSync(platform36)) missingPackages.push('platforms;android-36');
  if (!buildTools36) missingPackages.push('build-tools;36.0.0');
  if (missingPackages.length) {
    throw androidBuildError(
      'missing_android_sdk_packages',
      `Missing Android SDK packages: ${missingPackages.join(', ')}`,
    );
  }

  const nativeRoot = join(ROOT, '.native-build/android');
  await mkdir(nativeRoot, { recursive: true });
  await writeFile(join(nativeRoot, 'native-output.init.gradle'), GRADLE_INIT_SCRIPT, 'utf8');
  const env = {
    ...process.env,
    JAVA_HOME: resolution.javaHome,
    ANDROID_HOME: resolution.androidSdkRoot,
    GRADLE_USER_HOME: join(nativeRoot, 'gradle-user-home'),
  };
  const result = await runCommand(ANDROID_BUILD_COMMAND.command, ANDROID_BUILD_COMMAND.args, {
    cwd: ROOT,
    env,
    stream,
  });
  if (result.exitCode !== 0) {
    throw androidBuildError(
      'android_build_failed',
      `Android build failed with ${result.exitCode}`,
    );
  }
  let permissionEvidence;
  let backupEvidence;
  try {
    permissionEvidence = await verifyPackagedAndroidPermissions({
      androidSdkRoot: resolution.androidSdkRoot,
      buildTools36,
    });
    backupEvidence = await verifyPackagedAndroidBackupPolicy({
      androidSdkRoot: resolution.androidSdkRoot,
      buildTools36,
    });
  } catch (error) {
    throw androidBuildError(error.code, error.message);
  }
  if (!existsSync(RELEASE_APK)) {
    throw androidBuildError('android_release_missing', 'Unsigned release APK is missing');
  }
  const apksigner = join(
    resolution.androidSdkRoot,
    'build-tools',
    buildTools36,
    'apksigner',
  );
  const debugSignature = await runCommand(apksigner, ['verify', DEBUG_APK], {
    cwd: ROOT,
    env,
  });
  const releaseSignature = await runCommand(apksigner, ['verify', RELEASE_APK], {
    cwd: ROOT,
    env,
  });
  if (
    debugSignature.exitCode !== 0 ||
    releaseSignature.exitCode === 0 ||
    !/DOES NOT VERIFY|Missing META-INF\/MANIFEST\.MF/.test(
      `${releaseSignature.stdout}\n${releaseSignature.stderr}`,
    )
  ) {
    throw androidBuildError(
      'android_signing_evidence_invalid',
      'Debug or unsigned-release APK signing state is unexpected',
    );
  }
  return {
    ok: true,
    ...ANDROID_BUILD_EVIDENCE,
    unitTestsPassed: true,
    debugCompiled: existsSync(DEBUG_APK),
    debugSigned: debugSignature.exitCode === 0,
    releaseCompiled: existsSync(RELEASE_APK),
    releaseSigned: releaseSignature.exitCode === 0,
    ...permissionEvidence,
    ...backupEvidence,
    debugApkPath: '.native-build/android/build/app/outputs/apk/debug/app-debug.apk',
    releaseApkPath:
      '.native-build/android/build/app/outputs/apk/release/app-release-unsigned.apk',
    diagnosticApkSha256: createHash('sha256')
      .update(await readFile(DEBUG_APK))
      .digest('hex'),
  };
}

export function androidExitCodeForError(error) {
  if (
    error?.code === 'missing_android_toolchain' ||
    error?.code === 'missing_android_sdk_packages'
  ) {
    return EXIT_CODES.missingTool;
  }
  if (error?.code === 'android_build_failed') return EXIT_CODES.commandFailed;
  return EXIT_CODES.stateMismatch;
}

export async function main() {
  try {
    printJson(await buildAndroidApplication());
    return EXIT_CODES.success;
  } catch (error) {
    printJson({ ok: false, code: error.code, message: error.message }, process.stderr);
    return androidExitCodeForError(error);
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
