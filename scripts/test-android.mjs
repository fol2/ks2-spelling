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

const ROOT = resolve(import.meta.dirname, '..');
const ANDROID_STUDIO_JBR = '/Applications/Android Studio.app/Contents/jbr/Contents/Home';
const DEBUG_APK = join(
  ROOT,
  '.native-build/android/build/app/outputs/apk/debug/app-debug.apk',
);

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
  ]),
});

export const ANDROID_BUILD_EVIDENCE = Object.freeze({
  ok: true,
  platform: 'android',
  variant: 'debug',
  signing: 'debug',
  releaseSigned: false,
  declaredPermissions: [],
  requestedPermissions: [],
});

function packagedPermissionError(message) {
  const error = new Error(message);
  error.code = 'android_packaged_permission_detected';
  return error;
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
  const javaCandidates = [env.JAVA_HOME, ANDROID_STUDIO_JBR].filter(Boolean);
  const javaHome =
    javaCandidates.find((candidate) => pathExists(join(candidate, 'bin/java'))) ?? null;
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
    androidSdkRoot,
  };
}

async function findBuildTools36(androidSdkRoot) {
  try {
    const versions = await readdir(join(androidSdkRoot, 'build-tools'));
    return versions.find((version) => version === '36.0.0' || version.startsWith('36.')) ?? null;
  } catch {
    return null;
  }
}

export async function main() {
  const resolution = resolveAndroidEnvironment();
  if (!resolution.ready) {
    printJson(
      { ok: false, code: 'missing_android_toolchain', missing: resolution.missing },
      process.stderr,
    );
    return EXIT_CODES.missingTool;
  }

  const platform36 = join(resolution.androidSdkRoot, 'platforms/android-36/android.jar');
  const buildTools36 = await findBuildTools36(resolution.androidSdkRoot);
  const missingPackages = [];
  if (!existsSync(platform36)) missingPackages.push('platforms;android-36');
  if (!buildTools36) missingPackages.push('build-tools;36');
  if (missingPackages.length) {
    printJson(
      { ok: false, code: 'missing_android_sdk_packages', missing: missingPackages },
      process.stderr,
    );
    return EXIT_CODES.missingTool;
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
    stream: true,
  });
  if (result.exitCode !== 0) {
    printJson({ ok: false, code: 'android_build_failed', exitCode: result.exitCode });
    return EXIT_CODES.commandFailed;
  }
  let permissionEvidence;
  try {
    permissionEvidence = await verifyPackagedAndroidPermissions({
      androidSdkRoot: resolution.androidSdkRoot,
      buildTools36,
    });
  } catch (error) {
    printJson(
      { ok: false, code: error.code, message: error.message },
      process.stderr,
    );
    return EXIT_CODES.stateMismatch;
  }
  printJson({
    ...ANDROID_BUILD_EVIDENCE,
    ...permissionEvidence,
    diagnosticApkSha256: createHash('sha256')
      .update(await readFile(DEBUG_APK))
      .digest('hex'),
  });
  return EXIT_CODES.success;
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
