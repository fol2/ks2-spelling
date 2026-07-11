import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  EXIT_CODES,
  isMain,
  printJson,
  resolveExecutable,
  runCommand,
} from './lib/run-command.mjs';
import { prepareNativeDependencies } from './prepare-native-dependencies.mjs';

const ROOT = resolve(import.meta.dirname, '..');

export const IOS_BUILD_COMMAND = Object.freeze({
  command: 'xcodebuild',
  args: Object.freeze([
    '-project',
    'ios/App/App.xcodeproj',
    '-scheme',
    'KS2Spelling',
    '-sdk',
    'iphonesimulator',
    '-configuration',
    'Debug',
    '-derivedDataPath',
    '.native-build/ios',
    'CODE_SIGNING_ALLOWED=NO',
    'build',
  ]),
});

function iosBuildError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export async function buildIosApplication({ stream = true } = {}) {
  await prepareNativeDependencies();
  if (!(await resolveExecutable(IOS_BUILD_COMMAND.command))) {
    throw iosBuildError('missing_xcodebuild', 'xcodebuild is unavailable');
  }

  const result = await runCommand(IOS_BUILD_COMMAND.command, IOS_BUILD_COMMAND.args, {
    cwd: ROOT,
    stream,
  });
  if (result.exitCode !== 0) {
    throw iosBuildError('ios_build_failed', `xcodebuild failed with ${result.exitCode}`);
  }
  const appPath = join(
    ROOT,
    '.native-build/ios/Build/Products/Debug-iphonesimulator/App.app',
  );
  const requiredProducts = [
    'App',
    'Frameworks/Capacitor.framework/Capacitor',
    'Frameworks/Cordova.framework/Cordova',
    'Frameworks/SQLCipher.framework/SQLCipher',
  ];
  if (
    requiredProducts.some((path) => !existsSync(join(appPath, path))) ||
    existsSync(join(appPath, '_CodeSignature'))
  ) {
    throw iosBuildError(
      'ios_build_output_invalid',
      'Unsigned iOS application or embedded framework output is incomplete',
    );
  }
  return {
    ok: true,
    platform: 'ios',
    scheme: 'KS2Spelling',
    compiled: true,
    sdk: 'iphonesimulator',
    configuration: 'Debug',
    signed: false,
    appPath: '.native-build/ios/Build/Products/Debug-iphonesimulator/App.app',
  };
}

export async function main() {
  try {
    printJson(await buildIosApplication());
    return EXIT_CODES.success;
  } catch (error) {
    printJson({ ok: false, code: error.code, message: error.message }, process.stderr);
    return error.code === 'missing_xcodebuild'
      ? EXIT_CODES.missingTool
      : EXIT_CODES.commandFailed;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
