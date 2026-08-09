import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKFLOW_PATH = join(ROOT, '.github/workflows/nightly-alert.yml');
const CI_WORKFLOW_PATH = join(ROOT, '.github/workflows/ci.yml');

async function readWorkflow(path = WORKFLOW_PATH) {
  return readFile(path, 'utf8');
}

test('the alert observes completions of the real B4 CI workflow', async () => {
  const workflow = await readWorkflow();
  assert.match(workflow, /^on:\n\s+workflow_run:/m);
  assert.match(workflow, /workflows:\n\s+- "B4 continuous integration"/);
  assert.match(workflow, /types:\n\s+- completed/);

  // The observed name must be the name ci.yml actually declares, or the alert
  // silently never fires.
  const ci = await readWorkflow(CI_WORKFLOW_PATH);
  assert.match(ci, /^name: B4 continuous integration$/m);
});

test('only scheduled runs with a decided conclusion reach the tracking job', async () => {
  const workflow = await readWorkflow();
  assert.match(workflow, /github\.event\.workflow_run\.event == 'schedule'/);
  assert.match(workflow, /github\.event\.workflow_run\.conclusion == 'failure'/);
  assert.match(workflow, /github\.event\.workflow_run\.conclusion == 'success'/);
});

test('both the red and the recovery path exist so an open issue means red now', async () => {
  const workflow = await readWorkflow();
  assert.match(workflow, /gh issue create/);
  assert.match(workflow, /gh issue comment/);
  assert.match(workflow, /gh issue close/);
  // Label-keyed lookup, not title matching: titles carry run numbers.
  assert.match(workflow, /--label ci-nightly-red/);
  assert.match(workflow, /gh label create ci-nightly-red[\s\S]*?--force/);
});

test('the alert holds only issue write access and never reads the tree', async () => {
  const workflow = await readWorkflow();
  assert.match(workflow, /^permissions:\n\s+issues: write\n/m);
  assert.doesNotMatch(workflow, /contents: write/);
  assert.doesNotMatch(workflow, /pull-requests: write/);

  // A workflow_run job runs with a writable token against the base repo. It has
  // no reason to check out a tree, and checking one out is the first half of the
  // classic pwn-request shape.
  assert.doesNotMatch(workflow, /actions\/checkout/);
});

test('event data reaches the shell only as a quoted environment variable', async () => {
  const workflow = await readWorkflow();
  const expressionLines = workflow
    .split('\n')
    .filter((line) => line.includes('${{'));
  assert.ok(expressionLines.length > 0, 'expected the alert to read event data');

  // Every GitHub expression must be either an env: binding or the concurrency
  // key — the two places that never reach a shell. That property is what keeps
  // a value carrying shell metacharacters from becoming a command, and it holds
  // however the steps are later rearranged.
  for (const line of expressionLines) {
    assert.match(
      line.trim(),
      /^(?:[A-Z][A-Z0-9_]*|group): [\w-]*\$\{\{ [^}]+ \}\}$/,
      `GitHub expression somewhere it could reach a shell: ${line.trim()}`,
    );
  }
});

test('the concurrency key is per-run so no alert can cancel another', async () => {
  const workflow = await readWorkflow();
  // Keyed to workflow_run.id: a shared group would let a later skipped
  // pull_request completion cancel a still-pending scheduled alert.
  assert.match(
    workflow,
    /group: nightly-alert-\$\{\{ github\.event\.workflow_run\.id \}\}/,
  );
  assert.match(workflow, /cancel-in-progress: false/);
});
