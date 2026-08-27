import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  decidePrFocusGate,
  presentFocusSha,
} from './lib/pr-focus-gate.mjs';
import { runPinnedSystemGit } from './lib/pinned-system-git.mjs';
import { EXIT_CODES, isMain, printJson } from './lib/run-command.mjs';

const ROOT = resolve(import.meta.dirname, '..');

function splitPaths(stdout) {
  return String(stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function detectPrFocusGate({
  root = ROOT,
  env = process.env,
  runGit,
} = {}) {
  const eventName = String(env.EVENT_NAME ?? '').trim();
  const baseSha = presentFocusSha(env.PULL_REQUEST_BASE_SHA ?? '');
  if (eventName !== 'pull_request') {
    return decidePrFocusGate({ eventName, baseSha });
  }

  let changedPaths = null;
  if (baseSha) {
    const git =
      runGit ??
      ((args) =>
        runPinnedSystemGit(args, {
          root,
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
        }));
    try {
      await git(['rev-parse', '--verify', `${baseSha}^{commit}`]);
      const diff = await git([
        'diff',
        '--name-only',
        '--diff-filter=ACDMRTUXB',
        `${baseSha}...HEAD`,
      ]);
      changedPaths = splitPaths(diff.stdout);
    } catch {
      changedPaths = null;
    }
  }

  return decidePrFocusGate({ eventName, baseSha, changedPaths });
}

export async function main({ env = process.env, root = ROOT, runGit } = {}) {
  const decision = await detectPrFocusGate({ env, root, runGit });
  printJson({ ok: true, ...decision });
  if (env.GITHUB_OUTPUT) {
    await appendFile(
      env.GITHUB_OUTPUT,
      [
        `product=${decision.product ? 'true' : 'false'}`,
        `gates=${decision.gates}`,
        `reason=${decision.reason}`,
        `base_sha=${decision.baseSha ?? ''}`,
        '',
      ].join('\n'),
    );
  }
  return EXIT_CODES.success;
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
