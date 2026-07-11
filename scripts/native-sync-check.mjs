import { resolve } from 'node:path';
import {
  EXIT_CODES,
  isMain,
  printJson,
  runCommand,
} from './lib/run-command.mjs';

const ROOT = resolve(import.meta.dirname, '..');

export const SYNC_COMMANDS = Object.freeze([
  Object.freeze(['npm', Object.freeze(['run', 'build'])]),
  Object.freeze(['npx', Object.freeze(['--no-install', 'cap', 'sync'])]),
  Object.freeze([
    process.execPath,
    Object.freeze([
      '--test',
      'tests/ios-project-contract.test.mjs',
      'tests/android-project-contract.test.mjs',
    ]),
  ]),
  Object.freeze([
    'git',
    Object.freeze(['diff', '--exit-code', '--', 'ios', 'android', 'capacitor.config.json']),
  ]),
]);

export async function main() {
  for (const [index, [command, args]] of SYNC_COMMANDS.entries()) {
    const result = await runCommand(command, args, { cwd: ROOT, stream: true });
    if (result.spawnError?.code === 'ENOENT') {
      printJson({ ok: false, code: 'missing_sync_tool', command }, process.stderr);
      return EXIT_CODES.missingTool;
    }
    if (result.exitCode !== 0) {
      const driftCheck = index === SYNC_COMMANDS.length - 1;
      printJson(
        {
          ok: false,
          code: driftCheck ? 'native_sync_drift' : 'native_sync_command_failed',
          command,
          exitCode: result.exitCode,
        },
        process.stderr,
      );
      return driftCheck ? EXIT_CODES.stateMismatch : EXIT_CODES.commandFailed;
    }
  }
  printJson({ ok: true, code: 'native_sync_current' });
  return EXIT_CODES.success;
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
