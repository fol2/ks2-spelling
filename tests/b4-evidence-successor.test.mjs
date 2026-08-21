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

async function commitPath(root, relativePath, contents, message) {
  const dest = join(root, relativePath);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, contents);
  await git(root, ['add', relativePath]);
  await git(root, ['commit', '-qm', message]);
  return (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
}

test('an evidence-only successor of the merge-base still passes the candidate-range contract', async (t) => {
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

test('a source checkpoint then one evidence-only successor passes against the PR merge-base', async (t) => {
  const { root, checkpoint: mergeBase } = await initRepo();
  t.after(() => rm(root, { force: true, recursive: true }));
  const sourceSha = await commitPath(root, 'app.js', 'const version = 2;\n', 'source');
  await writeReport(root, sourceSha);
  await git(root, ['add', REPORT]);
  await git(root, ['commit', '-qm', 'evidence']);

  const result = await proveB4EvidenceSuccessor({
    root,
    baseSha: mergeBase,
    runGit: (args) => git(root, args),
  });
  assert.equal(result.applied, true);
  assert.equal(result.base, mergeBase);
  assert.equal(result.checkpoint, sourceSha);
  assert.notEqual(result.checkpoint, mergeBase);
  assert.deepEqual(result.paths, [REPORT]);
});

test('a checkpoint before the candidate merge-base is rejected as outside the PR range', async (t) => {
  const { root, checkpoint: parent } = await initRepo();
  t.after(() => rm(root, { force: true, recursive: true }));
  const mergeBase = await commitPath(root, 'app.js', 'const version = 1.1;\n', 'main');
  await writeReport(root, parent);
  await git(root, ['add', REPORT]);
  await git(root, ['commit', '-qm', 'evidence']);

  await assert.rejects(
    () =>
      proveB4EvidenceSuccessor({
        root,
        baseSha: mergeBase,
        runGit: (args) => git(root, args),
      }),
    (error) => {
      assert.equal(error.code, 'b4_evidence_successor_invalid');
      assert.match(error.message, /outside the candidate range/u);
      return true;
    },
  );
});

test('a checkpoint that is not a reachable ancestor of HEAD is rejected', async (t) => {
  const { root, checkpoint: mergeBase } = await initRepo();
  t.after(() => rm(root, { force: true, recursive: true }));
  await git(root, ['branch', '-M', 'main']);
  await git(root, ['checkout', '-qb', 'side']);
  const sideSha = await commitPath(root, 'side.js', 'side\n', 'side');
  await git(root, ['checkout', '-q', 'main']);
  await writeReport(root, sideSha);
  await git(root, ['add', REPORT]);
  await git(root, ['commit', '-qm', 'evidence']);

  await assert.rejects(
    () =>
      proveB4EvidenceSuccessor({
        root,
        baseSha: mergeBase,
        runGit: (args) => git(root, args),
      }),
    (error) => {
      assert.equal(error.code, 'b4_evidence_successor_invalid');
      assert.match(error.message, /not a reachable ancestor of HEAD/u);
      return true;
    },
  );
});

test('code committed after the evidence report is rejected as a non-evidence successor', async (t) => {
  const { root, checkpoint: mergeBase } = await initRepo();
  t.after(() => rm(root, { force: true, recursive: true }));
  const sourceSha = await commitPath(root, 'app.js', 'const version = 2;\n', 'source');
  await writeReport(root, sourceSha);
  await git(root, ['add', REPORT]);
  await git(root, ['commit', '-qm', 'evidence']);
  await commitPath(root, 'app.js', 'const version = 3;\n', 'later code');

  await assert.rejects(
    () =>
      proveB4EvidenceSuccessor({
        root,
        baseSha: mergeBase,
        runGit: (args) => git(root, args),
      }),
    (error) => {
      assert.equal(error.code, 'b4_evidence_successor_invalid');
      assert.match(error.message, /non-evidence paths: app\.js/u);
      return true;
    },
  );
});

test('a buried evidence report is still enforced against the truthful PR merge-base', async (t) => {
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

test('a symbolic applicationCheckpoint.commit fails closed before Git ancestry', async (t) => {
  const { root, checkpoint: mergeBase } = await initRepo();
  t.after(() => rm(root, { force: true, recursive: true }));
  await commitPath(root, 'app.js', 'const version = 2;\n', 'source');
  await writeReport(root, 'HEAD~1');
  await git(root, ['add', REPORT]);
  await git(root, ['commit', '-qm', 'evidence']);

  const gitCalls = [];
  await assert.rejects(
    () =>
      proveB4EvidenceSuccessor({
        root,
        baseSha: mergeBase,
        runGit: async (args) => {
          gitCalls.push(args);
          return git(root, args);
        },
      }),
    (error) => {
      assert.equal(error.code, 'b4_evidence_successor_invalid');
      assert.match(error.message, /exactly 40 lowercase hex characters/u);
      return true;
    },
  );
  assert.equal(
    gitCalls.some((args) => args.some((arg) => String(arg).includes('HEAD~1'))),
    false,
    'Git must not receive the symbolic checkpoint',
  );
  assert.equal(
    gitCalls.some((args) => args[0] === 'merge-base' && args[1] === '--is-ancestor'),
    false,
    'ancestry must not run for a symbolic checkpoint',
  );
});

test('an unresolvable applicationCheckpoint.commit fails closed', async (t) => {
  const { root, checkpoint } = await initRepo();
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeReport(root, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  await git(root, ['add', REPORT]);
  await git(root, ['commit', '-qm', 'evidence']);

  await assert.rejects(
    () =>
      proveB4EvidenceSuccessor({
        root,
        baseSha: checkpoint,
        runGit: (args) => git(root, args),
      }),
    (error) => {
      assert.equal(error.code, 'b4_evidence_successor_invalid');
      assert.match(error.message, /cannot be resolved/u);
      return true;
    },
  );
});

test('a missing or malformed B4 development report fails closed', async (t) => {
  const { root, checkpoint } = await initRepo();
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(join(root, 'reports/b4'), { recursive: true });
  await writeFile(join(root, REPORT), '{not json\n');
  await git(root, ['add', REPORT]);
  await git(root, ['commit', '-qm', 'malformed evidence']);

  await assert.rejects(
    () =>
      proveB4EvidenceSuccessor({
        root,
        baseSha: checkpoint,
        runGit: (args) => git(root, args),
      }),
    { code: 'b4_evidence_successor_invalid' },
  );

  await writeFile(join(root, REPORT), `${JSON.stringify({})}\n`);
  await git(root, ['add', REPORT]);
  await git(root, ['commit', '-qm', 'empty checkpoint']);
  await assert.rejects(
    () =>
      proveB4EvidenceSuccessor({
        root,
        baseSha: checkpoint,
        runGit: (args) => git(root, args),
      }),
    /missing applicationCheckpoint\.commit/u,
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
