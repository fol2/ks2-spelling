import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  listChangedTestFiles,
  runChangedTests,
} from '../scripts/run-changed-tests.mjs';

const execFileAsync = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGE_PATH = join(ROOT, 'package.json');

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

test('empty selection alone reports no changed tests and exits 0', async () => {
  const writes = [];
  const exitCode = await runChangedTests({
    files: [],
    runTests: async () => {
      throw new Error('node --test must not run when nothing is selected');
    },
    write: (text) => writes.push(text),
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(writes, ['no changed tests\n']);
});

test('a failing selected test keeps a non-zero exit and does not report no changed tests', async () => {
  const writes = [];
  const exitCode = await runChangedTests({
    files: ['tests/example.test.mjs'],
    runTests: async () => 1,
    write: (text) => writes.push(text),
  });
  assert.equal(exitCode, 1);
  assert.equal(writes.join('').includes('no changed tests'), false);
});

test('test:changed is the dedicated runner and does not or-chain a failing node --test', async () => {
  const packageJson = JSON.parse(await readFile(PACKAGE_PATH, 'utf8'));
  assert.equal(packageJson.scripts['test:changed'], 'node scripts/run-changed-tests.mjs');
  assert.doesNotMatch(
    packageJson.scripts['test:changed'],
    /&&[\s\S]*\|\| echo 'no changed tests'/u,
  );
});

test('git-selected failing tests propagate through the runner', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ks2-test-changed-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  await git(root, ['init', '-q']);
  await git(root, ['config', 'user.email', 'ci@example.com']);
  await git(root, ['config', 'user.name', 'CI']);
  await mkdir(join(root, 'tests'));
  await writeFile(
    join(root, 'tests/example.test.mjs'),
    "import test from 'node:test';\ntest('passes', () => {});\n",
  );
  await git(root, ['add', 'tests/example.test.mjs']);
  await git(root, ['commit', '-qm', 'add passing test']);
  await writeFile(
    join(root, 'tests/example.test.mjs'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fails', () => { assert.equal(1, 2); });\n",
  );

  const files = await listChangedTestFiles({
    root,
    runGit: (args) => git(root, args),
  });
  assert.deepEqual(files, ['tests/example.test.mjs']);

  const writes = [];
  const exitCode = await runChangedTests({
    files,
    runTests: async () => 1,
    write: (text) => writes.push(text),
  });
  assert.equal(exitCode, 1);
  assert.equal(writes.join('').includes('no changed tests'), false);
});
