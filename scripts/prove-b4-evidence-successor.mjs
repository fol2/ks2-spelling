import { resolve } from 'node:path';

import { proveB4EvidenceSuccessor, resolveEvidenceCandidateBase } from './lib/b4-evidence-successor.mjs';
import { runPinnedSystemGit } from './lib/pinned-system-git.mjs';
import { EXIT_CODES, isMain, printJson } from './lib/run-command.mjs';

const ROOT = resolve(import.meta.dirname, '..');

export async function main({ env = process.env, root = ROOT, runGit } = {}) {
  const git =
    runGit ??
    ((args) =>
      runPinnedSystemGit(args, { root, timeout: 10_000, maxBuffer: 1024 * 1024 }));
  const baseSha = resolveEvidenceCandidateBase({
    eventName: env.EVENT_NAME,
    mergeGroupBaseSha: env.MERGE_GROUP_BASE_SHA,
    pullRequestBaseSha: env.PULL_REQUEST_BASE_SHA,
    pushBeforeSha: env.PUSH_BEFORE_SHA,
  });

  try {
    const result = await proveB4EvidenceSuccessor({ root, baseSha, runGit: git });
    printJson(result);
    return EXIT_CODES.success;
  } catch (error) {
    printJson(
      {
        ok: false,
        code: error.code ?? 'b4_evidence_successor_invalid',
        message: error.message,
      },
      process.stderr,
    );
    return EXIT_CODES.stateMismatch;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
