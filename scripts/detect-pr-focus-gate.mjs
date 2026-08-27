import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { decidePrFocusGate, presentSha } from './lib/pr-focus-gate.mjs';
import { runPinnedSystemGit } from './lib/pinned-system-git.mjs';
import { EXIT_CODES, isMain, printJson } from './lib/run-command.mjs';

const ROOT = resolve(import.meta.dirname, '..');

function splitPaths(stdout) {
  return String(stdout ?? '')
    .split('\0')
    .filter(Boolean);
}

export async function detectPrFocusGate({
  root = ROOT,
  env = process.env,
  runGit,
} = {}) {
  const eventName = String(env.EVENT_NAME ?? '');
  const baseSha = presentSha(env.PULL_REQUEST_BASE_SHA ?? '') || null;
  let changedPaths = null;

  if (eventName === 'pull_request' && baseSha) {
    const git =
      runGit ??
      ((args) =>
        runPinnedSystemGit(args, {
          root,
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
        }));

    let baseResolved = false;
    try {
      await git(['rev-parse', '--verify', `${baseSha}^{commit}`]);
      baseResolved = true;
    } catch {
      baseResolved = false;
    }

    if (baseResolved) {
      const range = `${baseSha}...HEAD`;
      // Change integrity is part of F0. Do not turn a whitespace/error finding
      // into a conservative product route; fail the exact PR candidate instead.
      await git(['diff', '--check', range, '--']);
      try {
        const diff = await git([
          'diff',
          '--name-only',
          '--no-renames',
          '-z',
          range,
          '--',
        ]);
        changedPaths = splitPaths(diff.stdout);
      } catch {
        changedPaths = null;
      }
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
        `focus=${decision.focus}`,
        `reason=${decision.reason}`,
        '',
      ].join('\n'),
    );
  }
  if (env.GITHUB_STEP_SUMMARY) {
    const trigger = decision.triggerPath
      ? `\n- Trigger path: ${JSON.stringify(decision.triggerPath)}`
      : '';
    await appendFile(
      env.GITHUB_STEP_SUMMARY,
      `### AI-SDLC Focus Gate\n\n- Gates: \`${decision.focus}\`\n- Product lane: \`${decision.product ? 'yes' : 'no'}\`\n- Reason: \`${decision.reason}\`${trigger}\n`,
    );
  }
  return EXIT_CODES.success;
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
