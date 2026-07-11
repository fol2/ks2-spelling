import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  EXIT_CODES,
  isMain,
  printJson,
  runCommand,
} from './lib/run-command.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const ANDROID_STUDIO_JBR = '/Applications/Android Studio.app/Contents/jbr/Contents/Home';

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
});

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
  printJson(ANDROID_BUILD_EVIDENCE);
  return EXIT_CODES.success;
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
