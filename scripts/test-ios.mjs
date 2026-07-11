import { resolve } from 'node:path';
import {
  EXIT_CODES,
  isMain,
  printJson,
  resolveExecutable,
  runCommand,
} from './lib/run-command.mjs';

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

export async function main() {
  if (!(await resolveExecutable(IOS_BUILD_COMMAND.command))) {
    printJson({ ok: false, code: 'missing_xcodebuild' }, process.stderr);
    return EXIT_CODES.missingTool;
  }

  const result = await runCommand(IOS_BUILD_COMMAND.command, IOS_BUILD_COMMAND.args, {
    cwd: ROOT,
    stream: true,
  });
  if (result.exitCode !== 0) {
    printJson({ ok: false, code: 'ios_build_failed', exitCode: result.exitCode });
    return EXIT_CODES.commandFailed;
  }
  printJson({ ok: true, platform: 'ios', scheme: 'KS2Spelling', signed: false });
  return EXIT_CODES.success;
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
