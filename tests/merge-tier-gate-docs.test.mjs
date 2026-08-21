import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGE_PATH = join(ROOT, 'package.json');
const WORKFLOW_PATH = join(ROOT, '.github/workflows/ci.yml');
const DOC_PATH = join(ROOT, 'docs/operations/merge-tier-gate.md');
const NATIVE_DOC_PATH = join(ROOT, 'docs/operations/native-development.md');

test('durable merge-tier documentation distinguishes source proof from live GitHub ruleset proof', async () => {
  const [docs, workflow] = await Promise.all([
    readFile(DOC_PATH, 'utf8'),
    readFile(WORKFLOW_PATH, 'utf8'),
  ]);

  assert.match(docs, /^# Merge-tier gate: source contract versus live GitHub governance$/m);
  assert.match(docs, /does not prove live GitHub rulesets, branch protection or merge-queue settings/u);
  assert.match(docs, /Inspect live settings; a source file cannot certify them/u);

  assert.match(workflow, /^  pull_request:$/m);
  assert.match(workflow, /^  merge_group:$/m);
  assert.match(workflow, /^  schedule:\n    - cron: "0 6 \* \* \*"$/m);
  assert.match(workflow, /^  workflow_dispatch:$/m);
  assert.match(docs, /`pull_request` runs only the fast Domain and web lane/u);
  assert.match(
    docs,
    /`merge_group`, `push`, `schedule` and `workflow_dispatch` run the full three-job gate/u,
  );
  assert.match(docs, /Android unsigned debug and release compile/u);
  assert.match(docs, /iOS unsigned Simulator compile/u);
  assert.match(docs, /Domain and web/u);
  assert.match(docs, /issue #229/u);
  assert.match(docs, /A green exact-main push run is not a green nightly baseline/u);
  assert.match(
    docs,
    /The B4 workflow file `\.github\/workflows\/ci\.yml` is itself a native\/full-merge input/u,
  );
  assert.match(
    docs,
    /This source contract does not prove a hosted merge_group executed those jobs/u,
  );
  assert.match(
    docs,
    /Only `checkpoint\.\.HEAD` is allow-listed as evidence-only/u,
  );
  assert.match(
    docs,
    /must be exactly 40\nlowercase hex characters/u,
  );
});

test('verify:b3 does not claim gateway coverage it does not run', async () => {
  const [packageJson, docs, nativeDocs] = await Promise.all([
    readFile(PACKAGE_PATH, 'utf8').then((text) => JSON.parse(text)),
    readFile(DOC_PATH, 'utf8'),
    readFile(NATIVE_DOC_PATH, 'utf8'),
  ]);
  const command = packageJson.scripts['verify:b3'];
  const includesGateway = /gateway|wrangler/u.test(command);
  assert.equal(includesGateway, false);
  assert.match(
    docs,
    /verify:b3 does not run gateway Worker tests, lint, Wrangler dry-run or gateway audit/u,
  );
  assert.match(
    nativeDocs,
    /verify:b3 does not run gateway Worker tests, lint, Wrangler dry-run or gateway audit/u,
  );
  assert.match(docs, /Hosted Domain and web merge lane/u);
});
