import { resolve } from 'node:path';

import { runPinnedSystemGit } from './lib/pinned-system-git.mjs';
import { EXIT_CODES, isMain, runCommand } from './lib/run-command.mjs';

const ROOT = resolve(import.meta.dirname, '..');

export const CHANGED_TEST_GIT_ARGS = Object.freeze([
  'diff',
  '--name-only',
  '--diff-filter=ACMR',
  'HEAD',
  '--',
  'tests/*.test.mjs',
]);

function splitPaths(stdout) {
  return String(stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function listChangedTestFiles({ root = ROOT, runGit } = {}) {
  const git =
    runGit ??
    ((args) =>
      runPinnedSystemGit(args, { root, timeout: 10_000, maxBuffer: 1024 * 1024 }));
  const result = await git([...CHANGED_TEST_GIT_ARGS]);
  return splitPaths(result.stdout);
}

export async function runChangedTests({
  files,
  runTests,
  write = (text) => {
    process.stdout.write(text);
  },
} = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    write('no changed tests\n');
    return EXIT_CODES.success;
  }
  return runTests(files);
}

export async function main({
  root = ROOT,
  runGit,
  runTests,
  write,
} = {}) {
  const files = await listChangedTestFiles({ root, runGit });
  return runChangedTests({
    files,
    write,
    runTests:
      runTests ??
      (async (selected) => {
        const result = await runCommand(process.execPath, ['--test', ...selected], {
          cwd: root,
          stream: true,
        });
        return result.exitCode === 0 ? EXIT_CODES.success : result.exitCode;
      }),
  });
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
