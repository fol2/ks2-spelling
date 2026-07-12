import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKFLOW_PATH = join(ROOT, '.github/workflows/ci.yml');

async function readWorkflow() {
  return readFile(WORKFLOW_PATH, 'utf8');
}

test('every B2 CI lane checks out full Git history for evidence anchors', async () => {
  const workflow = await readWorkflow();
  const checkoutUses = workflow.match(
    /uses: actions\/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6/g,
  );
  const fullHistoryCheckouts = workflow.match(
    /uses: actions\/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6\n\s+with:\n\s+fetch-depth: 0/g,
  );
  assert.equal(checkoutUses?.length, 3);
  assert.equal(fullHistoryCheckouts?.length, checkoutUses.length);
});

test('B2 CI keeps exactly three jobs on Node 24.18.0 and preserves native boundaries', async () => {
  const workflow = await readWorkflow();
  assert.match(workflow, /^name: B2 continuous integration$/m);
  assert.equal((workflow.match(/^  [a-z][a-z-]+:\n    name:/gm) ?? []).length, 3);
  assert.equal((workflow.match(/node-version: "24\.18\.0"/g) ?? []).length, 3);
  assert.doesNotMatch(workflow, /node-version-file:/);
  assert.match(workflow, /branches:\n\s+- main\n\s+- jamesto\/mobile-b2-persistence/);
  assert.match(workflow, /xcode_major.*-ge 26/);
  assert.match(workflow, /"platforms;android-36" "build-tools;36\.0\.0"/);
});

test('hosted CI validates committed B2 proof without claiming virtual-device recapture', async () => {
  const workflow = await readWorkflow();
  assert.match(workflow, /npm run test:upstream:a3/);
  for (const focused of [
    'tests/sqlite-command-repository.test.mjs',
    'tests/sqlite-adapter-parity.test.mjs',
    'tests/sqlite-atomicity.test.mjs',
    'tests/sqlite-multi-learner.test.mjs',
    'tests/database-lifecycle-coordinator.test.mjs',
    'tests/b2-proof-controller.test.mjs',
  ]) assert.match(workflow, new RegExp(focused.replaceAll('.', '\\.')));
  assert.match(workflow, /npm run native:sync:check/);
  assert.match(workflow, /npm run test:ios/);
  assert.match(workflow, /npm run test:android/);
  assert.match(workflow, /npm run certify:android/);
  assert.match(workflow, /node scripts\/build-b2-exit-report\.mjs --check/);
  assert.doesNotMatch(workflow, /prove:b2:(?:ios|android)/);
  assert.doesNotMatch(workflow, /launch:(?:ios|android)/);
});

test('Android CI uses the exact installed sdkmanager path', async () => {
  const workflow = await readWorkflow();
  const executable = '$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager';
  const executableCheck = `test -x "${executable}"`;
  const install =
    `"${executable}" --install ` +
    '"platform-tools" "platforms;android-36" "build-tools;36.0.0"';
  assert.ok(workflow.indexOf(executableCheck) >= 0);
  assert.ok(workflow.indexOf(install) > workflow.indexOf(executableCheck));
  assert.doesNotMatch(workflow, /^\s*sdkmanager\b/m);
});
