import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { B4_EVIDENCE_PATHS } from '../collect-b4-development-evidence.mjs';
import { presentSha } from './native-ci-path-filter.mjs';

export const B4_DEVELOPMENT_REPORT_PATH = 'reports/b4/b4-development-report.json';
const APPLICATION_CHECKPOINT_COMMIT = /^[a-f0-9]{40}$/u;

function successorError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function resolveEvidenceCandidateBase({
  eventName = '',
  mergeGroupBaseSha = '',
  pullRequestBaseSha = '',
  pushBeforeSha = '',
} = {}) {
  if (eventName === 'merge_group') return presentSha(mergeGroupBaseSha) || null;
  if (eventName === 'pull_request') return presentSha(pullRequestBaseSha) || null;
  return presentSha(pushBeforeSha) || null;
}

function splitPaths(stdout) {
  return String(stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function gitText(runGit, args) {
  const result = await runGit(args);
  return String(result.stdout ?? '').trim();
}

async function isAncestor(runGit, ancestor, descendant) {
  try {
    await runGit(['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch (error) {
    if (error?.code === 1) return false;
    throw successorError(
      'b4_evidence_successor_invalid',
      `B4 evidence-successor checks cannot test ancestry ${ancestor}..${descendant}.`,
    );
  }
}

export async function proveB4EvidenceSuccessor({
  root,
  baseSha = null,
  headRef = 'HEAD',
  runGit,
  evidencePaths = B4_EVIDENCE_PATHS,
  reportPath = B4_DEVELOPMENT_REPORT_PATH,
} = {}) {
  if (typeof runGit !== 'function') {
    throw successorError(
      'b4_evidence_candidate_range_unresolved',
      'B4 evidence-successor checks require a Git runner.',
    );
  }

  let rangeStart = presentSha(baseSha ?? '');
  if (!rangeStart) {
    try {
      rangeStart = await gitText(runGit, ['rev-parse', '--verify', 'HEAD~1']);
    } catch {
      throw successorError(
        'b4_evidence_candidate_range_unresolved',
        'B4 evidence-successor checks cannot resolve a candidate range.',
      );
    }
  }

  let mergeBase;
  try {
    await gitText(runGit, ['rev-parse', '--verify', `${rangeStart}^{commit}`]);
    mergeBase = await gitText(runGit, ['merge-base', rangeStart, headRef]);
  } catch {
    throw successorError(
      'b4_evidence_candidate_range_unresolved',
      `B4 evidence-successor checks cannot resolve merge-base ${rangeStart}..${headRef}.`,
    );
  }

  const headSha = await gitText(runGit, ['rev-parse', '--verify', headRef]);
  const changedPaths = splitPaths(
    await gitText(runGit, ['diff', '--name-only', mergeBase, headRef]),
  );

  if (!changedPaths.includes(reportPath)) {
    return {
      ok: true,
      applied: false,
      reason: 'no-evidence-change-in-candidate-range',
      base: mergeBase,
      head: headSha,
      pathCount: changedPaths.length,
    };
  }

  let checkpoint;
  try {
    const report = JSON.parse(await readFile(join(root, reportPath), 'utf8'));
    checkpoint = presentSha(report?.applicationCheckpoint?.commit ?? '');
  } catch {
    throw successorError(
      'b4_evidence_successor_invalid',
      `B4 development report at ${reportPath} is missing or invalid.`,
    );
  }
  if (!checkpoint) {
    throw successorError(
      'b4_evidence_successor_invalid',
      'B4 development report is missing applicationCheckpoint.commit.',
    );
  }
  if (!APPLICATION_CHECKPOINT_COMMIT.test(checkpoint)) {
    throw successorError(
      'b4_evidence_successor_invalid',
      'B4 development report applicationCheckpoint.commit must be exactly 40 lowercase hex characters.',
    );
  }

  let checkpointSha;
  try {
    checkpointSha = await gitText(runGit, ['rev-parse', '--verify', `${checkpoint}^{commit}`]);
  } catch {
    throw successorError(
      'b4_evidence_successor_invalid',
      `B4 evidence checkpoint ${checkpoint} cannot be resolved.`,
    );
  }

  if (!(await isAncestor(runGit, checkpointSha, headSha))) {
    throw successorError(
      'b4_evidence_successor_invalid',
      `B4 evidence checkpoint ${checkpointSha} is not a reachable ancestor of HEAD ${headSha}.`,
    );
  }
  if (!(await isAncestor(runGit, mergeBase, checkpointSha))) {
    throw successorError(
      'b4_evidence_successor_invalid',
      `B4 evidence checkpoint ${checkpointSha} is outside the candidate range ${mergeBase}..${headSha}.`,
    );
  }

  const actualPaths = splitPaths(
    await gitText(runGit, ['diff', '--name-only', checkpointSha, headRef]),
  );
  if (actualPaths.length === 0) {
    throw successorError(
      'b4_evidence_successor_invalid',
      'B4 evidence-successor range is empty.',
    );
  }
  if (!actualPaths.includes(reportPath)) {
    throw successorError(
      'b4_evidence_successor_invalid',
      `B4 evidence-successor range does not include ${reportPath}.`,
    );
  }

  const allowed = new Set(evidencePaths);
  const extra = actualPaths.filter((path) => !allowed.has(path)).toSorted();
  if (extra.length > 0) {
    throw successorError(
      'b4_evidence_successor_invalid',
      `B4 evidence-successor range includes non-evidence paths: ${extra.join(', ')}.`,
    );
  }

  return {
    ok: true,
    applied: true,
    base: mergeBase,
    head: headSha,
    checkpoint: checkpointSha,
    paths: actualPaths.toSorted(),
  };
}
