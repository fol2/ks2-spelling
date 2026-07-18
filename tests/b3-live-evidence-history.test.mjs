import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { B3_FINAL_PROOF_OUTPUT_PATHS } from '../scripts/lib/b3-final-proof-output.mjs';

const COMMIT = '1'.repeat(40);
const HEAD = '2'.repeat(40);
const FIRST_FIVE = B3_FINAL_PROOF_OUTPUT_PATHS.slice(0, 5);
const SOURCE_ROOT = new URL('../', import.meta.url);
const DETERMINISTIC_REPORTS = Object.freeze([
  'reports/b3/b3-proof-pack-build.json',
  'reports/b3/native-build.json',
  'reports/b3/dependency-audit.json',
  'reports/b3/deterministic-proof.json',
]);

async function rootWith(paths = []) {
  const root = await mkdtemp(join(tmpdir(), 'ks2-spelling-b3-history-'));
  for (const path of DETERMINISTIC_REPORTS) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await copyFile(new URL(path, SOURCE_ROOT), join(root, path));
  }
  for (const path of paths) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    const value = path.endsWith('cloudflare-sandbox-proof.json')
      ? `${JSON.stringify({ testedApplicationCommit: COMMIT })}\n`
      : 'evidence\n';
    await writeFile(join(root, path), value);
  }
  return root;
}

function gitFixture({ status = '', history = {}, diff = B3_FINAL_PROOF_OUTPUT_PATHS } = {}) {
  const calls = [];
  const runGit = async (args) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return { stdout: `${HEAD}\n`, stderr: '' };
    if (args[0] === 'status') return { stdout: status, stderr: '' };
    if (args[0] === 'log') {
      const path = args.at(-1);
      return { stdout: history[path] ? `${history[path].join('\n')}\n` : '', stderr: '' };
    }
    if (args[0] === 'rev-list') return { stdout: `${HEAD} ${COMMIT}\n`, stderr: '' };
    if (args[0] === 'diff') return { stdout: `${diff.join('\n')}\n`, stderr: '' };
    throw new Error(`Unexpected Git command: ${args.join(' ')}`);
  };
  return { calls, runGit };
}

async function check(root, options = {}) {
  const { checkB3LiveEvidenceTopology } = await import('../scripts/build-b3-exit-report.mjs');
  return checkB3LiveEvidenceTopology({ root, operation: 'check-ci', ...options });
}

test('pending requires six independent never-present history queries and a clean tree', async () => {
  const root = await rootWith();
  try {
    const git = gitFixture();
    assert.deepEqual(await check(root, { runGit: git.runGit }), {
      mode: 'pending',
      testedApplicationCommit: HEAD,
    });
    assert.deepEqual(
      git.calls.filter(([command]) => command === 'log').map((args) => args.at(-1)),
      B3_FINAL_PROOF_OUTPUT_PATHS,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('pending rejects a deterministic B3 report that is no longer green', async () => {
  const root = await rootWith();
  try {
    const path = join(root, 'reports/b3/deterministic-proof.json');
    const report = JSON.parse(await readFile(path, 'utf8'));
    report.status = 'fail';
    await writeFile(path, `${JSON.stringify(report)}\n`);
    await assert.rejects(
      check(root, { runGit: gitFixture().runGit }),
      /deterministic proof authority is invalid/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('one-to-five current paths always fail', async () => {
  for (const count of [1, 5]) {
    const root = await rootWith(B3_FINAL_PROOF_OUTPUT_PATHS.slice(0, count));
    try {
      await assert.rejects(check(root, { runGit: gitFixture().runGit }), /partial|topology/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('prior one, five or six paths make later zero evidence permanently invalid', async () => {
  for (const count of [1, 5, 6]) {
    const root = await rootWith();
    const history = Object.fromEntries(
      B3_FINAL_PROOF_OUTPUT_PATHS.slice(0, count).map((path) => [path, [HEAD]]),
    );
    try {
      await assert.rejects(check(root, { runGit: gitFixture({ history }).runGit }), /history|deleted/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('complete is one clean evidence-only successor containing exactly six paths', async () => {
  const root = await rootWith(B3_FINAL_PROOF_OUTPUT_PATHS);
  const history = Object.fromEntries(B3_FINAL_PROOF_OUTPUT_PATHS.map((path) => [path, [HEAD]]));
  try {
    assert.deepEqual(await check(root, { runGit: gitFixture({ history }).runGit }), {
      mode: 'complete',
      testedApplicationCommit: COMMIT,
    });
    await assert.rejects(
      check(root, {
        runGit: gitFixture({ history, diff: [...B3_FINAL_PROOF_OUTPUT_PATHS, 'src/main.jsx'] }).runGit,
      }),
      /non-evidence|six paths|successor/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('write accepts exactly five fresh evidence outputs and rejects unrelated dirt', async () => {
  const root = await rootWith(FIRST_FIVE);
  const status = FIRST_FIVE.map((path) => `?? ${path}\n`).join('');
  try {
    const { checkB3LiveEvidenceTopology } = await import('../scripts/build-b3-exit-report.mjs');
    assert.deepEqual(
      await checkB3LiveEvidenceTopology({
        root, operation: 'write', runGit: gitFixture({ status }).runGit,
      }),
      { mode: 'write', testedApplicationCommit: HEAD },
    );
    await assert.rejects(
      checkB3LiveEvidenceTopology({
        root,
        operation: 'write',
        runGit: gitFixture({ status: `${status} M scripts/prove-b3-ios.mjs\n` }).runGit,
      }),
      /dirty|unrelated|evidence/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
