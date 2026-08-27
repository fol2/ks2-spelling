import assert from 'node:assert/strict';
import test from 'node:test';

import { detectPrFocusGate } from '../scripts/detect-pr-focus-gate.mjs';
import {
  F0_ONLY_FILES,
  decidePrFocusGate,
  pathIsF0OnlyDocumentation,
} from '../scripts/lib/pr-focus-gate.mjs';

const BASE = '1'.repeat(40);

test('the F0-only allow-list contains only permanent AI-SDLC guidance', () => {
  const safe = [
    'AGENTS.md',
    'README.md',
    '.github/pull_request_template.md',
    'docs/agents/ai-sdlc.md',
    'docs/agents/domain.md',
    'docs/agents/issue-tracker.md',
    'docs/agents/triage-labels.md',
  ];
  assert.deepEqual([...F0_ONLY_FILES], safe);
  for (const path of safe) {
    assert.equal(pathIsF0OnlyDocumentation(path), true, `${path} should be F0-only`);
  }

  const governed = [
    '',
    '/README.md',
    '../README.md',
    'CONCEPTS.md',
    'docs/agents/new-instruction.md',
    'docs/agents/selector.mjs',
    'docs/adr/0001-example.md',
    'docs/architecture/b1-authority.md',
    'docs/operations/merge-tier-gate.md',
    'docs/solutions/conventions/example.md',
    'docs/legal/privacy-notice.md',
    'docs/records/2026-08-27-verdict.md',
    'docs/superpowers/plans/history.md',
    'reports/b4/evidence.md',
    '.github/workflows/ci.yml',
    'scripts/detect-pr-focus-gate.mjs',
    'tests/pr-focus-gate.test.mjs',
    'src/app/App.jsx',
    'ios/App/App/AppDelegate.swift',
    'android/app/build.gradle',
  ];
  for (const path of governed) {
    assert.equal(pathIsF0OnlyDocumentation(path), false, `${path} should use product gates`);
  }
});

test('removing an exact allow-list entry makes that path fail closed', () => {
  assert.equal(pathIsF0OnlyDocumentation('README.md'), true);
  assert.equal(
    pathIsF0OnlyDocumentation('README.md', {
      files: F0_ONLY_FILES.filter((path) => path !== 'README.md'),
    }),
    false,
  );
});

test('safe documentation-only pull requests stop at F0', () => {
  assert.deepEqual(
    decidePrFocusGate({
      eventName: 'pull_request',
      baseSha: BASE,
      changedPaths: ['AGENTS.md', 'docs/agents/ai-sdlc.md'],
    }),
    {
      product: false,
      gates: 'F0',
      reason: 'safe-documentation-only',
      baseSha: BASE,
    },
  );
});

test('mixed, governed and unknown changes select the product route', () => {
  for (const changedPaths of [
    ['README.md', 'src/app/App.jsx'],
    ['.github/workflows/ci.yml'],
    ['docs/operations/merge-tier-gate.md'],
    ['docs/legal/privacy-notice.md'],
    ['unrecognised/file.md'],
  ]) {
    assert.deepEqual(
      decidePrFocusGate({ eventName: 'pull_request', baseSha: BASE, changedPaths }),
      {
        product: true,
        gates: 'F0,F1,F2',
        reason: 'product-or-governed-input',
        baseSha: BASE,
      },
    );
  }
});

test('unresolved and empty pull-request state fails closed', () => {
  assert.deepEqual(
    decidePrFocusGate({
      eventName: 'pull_request',
      baseSha: null,
      changedPaths: ['README.md'],
    }),
    {
      product: true,
      gates: 'F0,F1,F2',
      reason: 'unresolved-base',
      baseSha: null,
    },
  );
  assert.deepEqual(
    decidePrFocusGate({ eventName: 'pull_request', baseSha: BASE, changedPaths: null }),
    {
      product: true,
      gates: 'F0,F1,F2',
      reason: 'unresolved-diff',
      baseSha: BASE,
    },
  );
  assert.deepEqual(
    decidePrFocusGate({ eventName: 'pull_request', baseSha: BASE, changedPaths: [] }),
    {
      product: true,
      gates: 'F0,F1,F2',
      reason: 'empty-diff',
      baseSha: BASE,
    },
  );
});

test('all non-pull-request events use the full integration route', () => {
  for (const eventName of [
    'merge_group',
    'push',
    'schedule',
    'workflow_dispatch',
    'workflow_call',
  ]) {
    assert.deepEqual(decidePrFocusGate({ eventName }), {
      product: true,
      gates: 'F0,F1,F2',
      reason: 'integration-event',
      baseSha: null,
    });
  }
});

test('the detector reads the exact merge-base-to-head path set without collapsing renames', async () => {
  const calls = [];
  const decision = await detectPrFocusGate({
    env: {
      EVENT_NAME: 'pull_request',
      PULL_REQUEST_BASE_SHA: BASE,
    },
    runGit: async (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return { stdout: `${BASE}\n` };
      if (args[0] === 'diff') {
        return { stdout: 'README.md\ndocs/agents/ai-sdlc.md\n' };
      }
      throw new Error(`unexpected Git call: ${args.join(' ')}`);
    },
  });

  assert.deepEqual(decision, {
    product: false,
    gates: 'F0',
    reason: 'safe-documentation-only',
    baseSha: BASE,
  });
  assert.deepEqual(calls, [
    ['rev-parse', '--verify', `${BASE}^{commit}`],
    [
      'diff',
      '--name-only',
      '--no-renames',
      '--diff-filter=ACDMRTUXB',
      `${BASE}...HEAD`,
    ],
  ]);
});

test('a Git failure cannot create an F0-only false green', async () => {
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
    gates: 'F0,F1,F2',
    reason: 'unresolved-diff',
    baseSha: BASE,
  });
});
