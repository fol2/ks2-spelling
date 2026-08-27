import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { detectPrFocusGate } from '../scripts/detect-pr-focus-gate.mjs';
import {
  SAFE_DOCUMENTATION_FILES,
  SAFE_DOCUMENTATION_PREFIXES,
  decidePrFocusGate,
  pathIsSafeDocumentation,
} from '../scripts/lib/pr-focus-gate.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKFLOW_PATH = join(ROOT, '.github/workflows/ci.yml');
const BASE = '1'.repeat(40);

function extractJob(workflow, jobName) {
  const marker = `  ${jobName}:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing CI job: ${jobName}`);
  const remainder = workflow.slice(start + marker.length);
  const next = remainder.search(/^  [a-z][a-z-]+:\n/m);
  return next === -1
    ? workflow.slice(start)
    : workflow.slice(start, start + marker.length + next);
}

test('the F0 allow-list contains only explicit canonical Markdown documentation surfaces', () => {
  for (const path of [
    'AGENTS.md',
    'CONCEPTS.md',
    'README.md',
    '.github/pull_request_template.md',
    'docs/agents/ai-sdlc.md',
    'docs/adr/0001-local-first.md',
    'docs/architecture/b3-commerce-pack-authority.md',
    'docs/operations/merge-tier-gate.md',
    'docs/solutions/workflow-issues/example.md',
  ]) {
    assert.equal(pathIsSafeDocumentation(path), true, `${path} should remain F0-safe`);
  }

  for (const path of [
    '.github/workflows/ci.yml',
    'scripts/detect-pr-focus-gate.mjs',
    'tests/pr-focus-gate.test.mjs',
    'package.json',
    'src/app/ProductRoot.jsx',
    'ios/App/App/AppDelegate.swift',
    'android/app/build.gradle',
    'docs/legal/privacy-notice.md',
    'docs/records/2026-08-27-verdict.md',
    'docs/superpowers/plans/old-plan.md',
    'reports/b4/b4-development-report.json',
    'docs/operations/runbook.sh',
    '../README.md',
    './README.md',
    'docs\\agents\\ai-sdlc.md',
    'README.md\nAGENTS.md',
    'docs/agents/foo\tbar.md',
    'docs/agents/foo\rbar.md',
    'docs/agents/foo\u0085bar.md',
    'docs/agents/foo\u2028bar.md',
    ' README.md',
    'README.md ',
  ]) {
    assert.equal(pathIsSafeDocumentation(path), false, `${JSON.stringify(path)} must fail closed`);
  }

  assert.ok(SAFE_DOCUMENTATION_FILES.length > 0);
  assert.ok(SAFE_DOCUMENTATION_PREFIXES.length > 0);
});

test('a pure allow-listed documentation PR selects only F0', () => {
  assert.deepEqual(
    decidePrFocusGate({
      eventName: 'pull_request',
      baseSha: BASE,
      changedPaths: ['README.md', 'docs/agents/ai-sdlc.md'],
    }),
    { product: false, focus: 'F0', reason: 'safe-documentation-only' },
  );
});

test('mixed, product and CI diffs select the product lane', () => {
  for (const changedPaths of [
    ['README.md', 'src/main.jsx'],
    ['.github/workflows/ci.yml'],
    ['tests/pr-focus-gate.test.mjs'],
    ['docs/legal/privacy-notice.md'],
  ]) {
    const decision = decidePrFocusGate({
      eventName: 'pull_request',
      baseSha: BASE,
      changedPaths,
    });
    assert.equal(decision.product, true);
    assert.equal(decision.focus, 'F0,F1,F2');
    assert.equal(decision.reason, 'product-or-unknown-change');
    assert.equal(decision.triggerPath, changedPaths.at(-1));
  }
});

test('the selector fails closed on unresolved input and every integration event', () => {
  assert.deepEqual(
    decidePrFocusGate({
      eventName: 'pull_request',
      baseSha: null,
      changedPaths: ['README.md'],
    }),
    { product: true, focus: 'F0,F1,F2', reason: 'unresolved-base' },
  );
  assert.deepEqual(
    decidePrFocusGate({
      eventName: 'pull_request',
      baseSha: BASE,
      changedPaths: null,
    }),
    { product: true, focus: 'F0,F1,F2', reason: 'unresolved-diff' },
  );
  assert.deepEqual(
    decidePrFocusGate({
      eventName: 'pull_request',
      baseSha: BASE,
      changedPaths: [],
    }),
    { product: true, focus: 'F0,F1,F2', reason: 'empty-diff' },
  );
  for (const eventName of ['merge_group', 'push', 'schedule', 'workflow_dispatch', 'workflow_call']) {
    assert.deepEqual(decidePrFocusGate({ eventName }), {
      product: true,
      focus: 'F0,F1,F2',
      reason: 'integration-event',
    });
  }
});

test('the detector checks and classifies the exact pull-request merge-base range', async () => {
  const calls = [];
  const decision = await detectPrFocusGate({
    env: {
      EVENT_NAME: 'pull_request',
      PULL_REQUEST_BASE_SHA: BASE,
    },
    runGit: async (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return { stdout: `${BASE}\n` };
      if (args[0] === 'diff' && args[1] === '--check') return { stdout: '' };
      if (args[0] === 'diff' && args[1] === '--name-only') {
        return { stdout: 'README.md\0docs/agents/ai-sdlc.md\0' };
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    },
  });

  assert.deepEqual(decision, {
    product: false,
    focus: 'F0',
    reason: 'safe-documentation-only',
  });
  assert.deepEqual(calls, [
    ['rev-parse', '--verify', `${BASE}^{commit}`],
    ['diff', '--check', `${BASE}...HEAD`, '--'],
    ['diff', '--name-only', '--no-renames', '-z', `${BASE}...HEAD`, '--'],
  ]);
});

test('an exact-range change-integrity failure is not downgraded to a product route', async () => {
  await assert.rejects(
    detectPrFocusGate({
      env: {
        EVENT_NAME: 'pull_request',
        PULL_REQUEST_BASE_SHA: BASE,
      },
      runGit: async (args) => {
        if (args[0] === 'rev-parse') return { stdout: `${BASE}\n` };
        if (args[0] === 'diff' && args[1] === '--check') {
          throw new Error('whitespace error');
        }
        throw new Error(`unexpected git ${args.join(' ')}`);
      },
    }),
    /whitespace error/u,
  );
});

test('an unresolved base cannot grant the F0-only route', async () => {
  const decision = await detectPrFocusGate({
    env: {
      EVENT_NAME: 'pull_request',
      PULL_REQUEST_BASE_SHA: BASE,
    },
    runGit: async () => {
      throw new Error('unavailable base');
    },
  });
  assert.deepEqual(decision, {
    product: true,
    focus: 'F0,F1,F2',
    reason: 'unresolved-diff',
  });
});

test('the Domain and web lane trusts F0 only after the classifier contract', async () => {
  const workflow = await readFile(WORKFLOW_PATH, 'utf8');
  const domain = extractJob(workflow, 'domain-web');

  assert.equal(
    (domain.match(/node scripts\/detect-pr-focus-gate\.mjs/gu) ?? []).length,
    1,
  );
  assert.match(domain, /id: focus/u);
  assert.match(domain, /EVENT_NAME: \$\{\{ github\.event_name \}\}/u);
  assert.match(
    domain,
    /PULL_REQUEST_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/u,
  );
  assert.match(domain, /- name: Check exact change integrity\n\s+run: git diff --check/u);
  assert.match(
    domain,
    /- name: Run F0 documentation and CI contracts\n\s+if: steps\.focus\.outputs\.product == 'false'/u,
  );
  assert.match(
    domain,
    /- name: Install exact root dependencies\n\s+if: steps\.focus\.outputs\.product == 'true'\n\s+run: npm ci/u,
  );
  for (const name of [
    'Verify frozen B2, vendored and A3 authorities',
    'Materialise deterministic proof-pack inputs',
    'Regenerate deterministic B3 proof',
    'Lint source and verification code',
  ]) {
    const step = domain.slice(domain.indexOf(`- name: ${name}`));
    assert.match(step, /if: steps\.focus\.outputs\.product == 'true'/u);
  }
  assert.match(
    domain,
    /if: github\.event_name == 'pull_request' && steps\.focus\.outputs\.product == 'true'\n\s+run: npm run test:fast/u,
  );
  assert.match(
    domain,
    /if: github\.event_name != 'pull_request'\n\s+run: >-\n\s+node --test/u,
  );
});
