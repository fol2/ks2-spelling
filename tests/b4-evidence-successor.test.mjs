import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  B4_DEVELOPMENT_REPORT_PATH,
  proveB4EvidenceSuccessor,
  resolveEvidenceCandidateBase,
} from '../scripts/lib/b4-evidence-successor.mjs';

const execFileAsync = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKFLOW_PATH = join(ROOT, '.github/workflows/ci.yml');
const REPORT = B4_DEVELOPMENT_REPORT_PATH;

function gitEnv() {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_AUTHOR_NAME = 'CI';
  env.GIT_AUTHOR_EMAIL = 'ci@example.com';
  env.GIT_COMMITTER_NAME = 'CI';
  env.GIT_COMMITTER_EMAIL = 'ci@example.com';
  return env;
}

async function git(root, args) {
  const { stdout, stderr } = await execFileAsync('/usr/bin/git', args, {
    cwd: root,
    env: gitEnv(),
    encoding: 'utf8',
  });
  return { stdout, stderr };
}

async function initRepo() {
  const root = await mkdtemp(join(tmpdir(), 'ks2-b4-evidence-'));
  await git(root, ['init', '-q']);
  await git(root, ['config', 'user.email', 'ci@example.com']);
  await git(root, ['config', 'user.name', 'CI']);
  await writeFile(join(root, 'app.js'), 'const version = 1;\n');
  await git(root, ['add', 'app.js']);
  await git(root, ['commit', '-qm', 'checkpoint']);
  const checkpoint = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  return { root, checkpoint };
}

async function writeReport(root, checkpoint) {
  await mkdir(join(root, 'reports/b4'), { recursive: true });
  await writeFile(
    join(root, REPORT),
    `${JSON.stringify({ applicationCheckpoint: { commit: checkpoint } })}\n`,
  );
}

test('candidate-range resolution prefers merge_group and pull_request bases over HEAD~1', () => {
  const zero = '0'.repeat(40);
  assert.equal(
    resolveEvidenceCandidateBase({
      eventName: 'merge_group',
      mergeGroupBaseSha: 'aa'.repeat(20),
      pushBeforeSha: 'bb'.repeat(20),
    }),
    'aa'.repeat(20),
  );
  assert.equal(
    resolveEvidenceCandidateBase({
      eventName: 'pull_request',
      pullRequestBaseSha: 'cc'.repeat(20),
      pushBeforeSha: 'bb'.repeat(20),
    }),
    'cc'.repeat(20),
  );
  assert.equal(
    resolveEvidenceCandidateBase({
      eventName: 'push',
      pushBeforeSha: zero,
    }),
    null,
  );
  assert.equal(
    resolveEvidenceCandidateBase({
      eventName: 'schedule',
      mergeGroupBaseSha: '',
      pullRequestBaseSha: '',
      pushBeforeSha: '',
    }),
    null,
  );
});

test('an evidence-only successor of the merge-base passes the candidate-range contract', async (t) => {
  const { root, checkpoint } = await initRepo();
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeReport(root, checkpoint);
  await git(root, ['add', REPORT]);
  await git(root, ['commit', '-qm', 'evidence']);

  const result = await proveB4EvidenceSuccessor({
    root,
    baseSha: checkpoint,
    runGit: (args) => git(root, args),
  });
  assert.equal(result.applied, true);
  assert.equal(result.checkpoint, checkpoint);
  assert.deepEqual(result.paths, [REPORT]);
});

test('a buried evidence change is still enforced against the truthful candidate range', async (t) => {
  const { root, checkpoint } = await initRepo();
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeReport(root, checkpoint);
  await git(root, ['add', REPORT]);
  await git(root, ['commit', '-qm', 'evidence']);
  await writeFile(join(root, 'app.js'), 'const version = 2;\n');
  await git(root, ['add', 'app.js']);
  await git(root, ['commit', '-qm', 'later code']);

  const headParent = (await git(root, ['rev-parse', 'HEAD~1'])).stdout.trim();
  const headOnly = await proveB4EvidenceSuccessor({
    root,
    baseSha: headParent,
    runGit: (args) => git(root, args),
  });
  assert.equal(headOnly.applied, false, 'HEAD~1 hides the buried evidence change');

  await assert.rejects(
    () =>
      proveB4EvidenceSuccessor({
        root,
        baseSha: checkpoint,
        runGit: (args) => git(root, args),
      }),
    /non-evidence paths: app\.js/u,
  );
});

test('code-only candidate ranges report that the contract does not apply after inspecting the range', async (t) => {
  const { root, checkpoint } = await initRepo();
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(join(root, 'app.js'), 'const version = 2;\n');
  await git(root, ['add', 'app.js']);
  await git(root, ['commit', '-qm', 'code']);

  const result = await proveB4EvidenceSuccessor({
    root,
    baseSha: checkpoint,
    runGit: (args) => git(root, args),
  });
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'no-evidence-change-in-candidate-range');
  assert.equal(result.pathCount, 1);
});

test('an unresolved candidate range fails closed instead of skipping', async (t) => {
  const { root } = await initRepo();
  t.after(() => rm(root, { force: true, recursive: true }));
  await assert.rejects(
    () =>
      proveB4EvidenceSuccessor({
        root,
        baseSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        runGit: (args) => git(root, args),
      }),
    {
      code: 'b4_evidence_candidate_range_unresolved',
    },
  );
});

test('the hosted evidence gate runs on every merge path and diffs the candidate range', async () => {
  const workflow = await readFile(WORKFLOW_PATH, 'utf8');
  const domainStart = workflow.indexOf('  domain-web:');
  const androidStart = workflow.indexOf('  android-compile:');
  const domain = workflow.slice(domainStart, androidStart);
  const step = domain.slice(domain.indexOf('Prove B4 evidence commits are evidence-only successors'));

  assert.match(step, /node scripts\/prove-b4-evidence-successor\.mjs/);
  assert.match(step, /EVENT_NAME: \$\{\{ github\.event_name \}\}/);
  assert.match(step, /MERGE_GROUP_BASE_SHA: \$\{\{ github\.event\.merge_group\.base_sha \}\}/);
  assert.match(step, /PULL_REQUEST_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(step, /PUSH_BEFORE_SHA: \$\{\{ github\.event\.before \}\}/);
  assert.doesNotMatch(workflow, /github\.event_name != 'merge_group' && github\.ref != 'refs\/heads\/main'/);
  assert.doesNotMatch(
    step.slice(0, step.indexOf('node scripts/prove-b4-evidence-successor.mjs')),
    /\bif:/,
  );
  assert.doesNotMatch(step, /git diff --name-only HEAD\^ HEAD/);
});
