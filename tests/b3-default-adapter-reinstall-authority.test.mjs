import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  B3_TEST_COMMIT,
  B3_TEST_HASH,
} from './helpers/b3-evidence-fixtures.mjs';

const execFileAsync = promisify(execFile);
const HELPER = new URL(
  './helpers/b3-default-adapter-reinstall-authority-child.mjs',
  import.meta.url,
);

async function fixture(t, label) {
  const root = await mkdtemp(join(tmpdir(), `b3-default-reinstall-${label}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const distribution = join(root, '.native-build', 'b3', 'distribution');
  await mkdir(distribution, { recursive: true, mode: 0o700 });
  for (const path of [
    join(root, '.native-build'),
    join(root, '.native-build', 'b3'),
    distribution,
  ]) await chmod(path, 0o700);
  await writeFile(join(distribution, 'build-authority.json'), JSON.stringify({
    schemaVersion: 1,
    testedApplicationCommit: B3_TEST_COMMIT,
    applicationFingerprint: B3_TEST_HASH,
    versionName: '0.3.0-b3',
    iosBuildNumber: '19',
    androidVersionCode: 19,
  }), { mode: 0o600 });
  return root;
}

async function run(root, platform, order) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    '--experimental-test-module-mocks',
    HELPER.pathname,
    platform,
    order,
  ], { cwd: root, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  assert.equal(stderr, '');
  return JSON.parse(stdout);
}

test('public default adapters consume one shared reinstall acknowledgement in either order',
  async (t) => {
    for (const platform of ['ios', 'android']) {
      for (const order of ['recovery-first', 'planned-first']) {
        await t.test(`${platform}:${order}`, async (t) => {
          const root = await fixture(t, `${platform}-${order}`);
          const result = await run(root, platform, order);
          assert.equal(result.ok, true, result.error?.message);
          assert.equal(result.platform, platform);
          assert.equal(result.order, order);
          assert.equal(result.disposals, 1);
          if (order === 'recovery-first') {
            assert.deepEqual(result.recovery, { status: 'recovered' });
            assert.equal(result.plannedInstruction, 'REINSTALL_EXACT_BUILD');
            assert.equal(result.plannedAdvances, 0);
            assert.equal(result.recoveryCallbackCalls, 1);
          } else {
            assert.equal(result.plannedAdvanceError, 'planned-resume-advanced-once');
            assert.equal(result.plannedAdvances, 1);
            assert.deepEqual(result.recovery, { status: 'operator-required' });
            assert.equal(result.recoveryCallbackCalls, 0);
          }
        });
      }
    }
  });
