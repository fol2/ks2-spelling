import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  decideNativeCiSelection,
  resolveNativeCiBaseSha,
} from './lib/native-ci-path-filter.mjs';
import { runPinnedSystemGit } from './lib/pinned-system-git.mjs';
import { EXIT_CODES, isMain, printJson } from './lib/run-command.mjs';

const ROOT = resolve(import.meta.dirname, '..');

function splitPaths(stdout) {
  return String(stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function detectNativeCiChanges({
  root = ROOT,
  env = process.env,
  runGit,
} = {}) {
  const git =
    runGit ??
    ((args) =>
      runPinnedSystemGit(args, { root, timeout: 10_000, maxBuffer: 1024 * 1024 }));
  const baseSha = resolveNativeCiBaseSha({
    mergeGroupBaseSha: env.MERGE_GROUP_BASE_SHA,
    pushBeforeSha: env.PUSH_BEFORE_SHA,
  });

  let changedPaths = null;
  if (baseSha) {
    try {
      await git(['rev-parse', '--verify', `${baseSha}^{commit}`]);
      const diff = await git(['diff', '--name-only', baseSha, 'HEAD']);
      changedPaths = splitPaths(diff.stdout);
    } catch {
      changedPaths = null;
    }
  }

  return decideNativeCiSelection({
    certification: env.CERTIFICATION,
    baseSha,
    changedPaths,
  });
}

export async function main({ env = process.env, root = ROOT, runGit } = {}) {
  const decision = await detectNativeCiChanges({ env, root, runGit });
  printJson({ ok: true, ...decision });
  if (env.GITHUB_OUTPUT) {
    await appendFile(env.GITHUB_OUTPUT, `native=${decision.native ? 'true' : 'false'}\n`);
  }
  return EXIT_CODES.success;
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
