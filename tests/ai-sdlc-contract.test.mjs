import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function read(path) {
  return readFile(join(ROOT, path), 'utf8');
}

test('AGENTS is the compact execution kernel for all four rules', async () => {
  const [agents, full] = await Promise.all([
    read('AGENTS.md'),
    read('docs/agents/ai-sdlc.md'),
  ]);

  assert.ok(agents.length < 10_000, 'AGENTS.md must stay compact');
  assert.ok(agents.length < full.length, 'details belong in the AI-SDLC SSOT');
  assert.match(agents, /docs\/agents\/ai-sdlc\.md/u);
  assert.match(agents, /AI-SDLC development DNA/u);
  assert.match(agents, /minimise wall time/u);
  assert.match(agents, /minimise token and context consumption/u);
  assert.match(agents, /never trade assurance for speed or tokens/u);
  assert.match(agents, /Humans are above the loop/u);
  assert.match(agents, /one owner, one branch and\s+one ordinary PR/u);
  for (const gate of ['F0', 'F1', 'F2', 'F3', 'F4']) {
    assert.match(agents, new RegExp(`\\*\\*${gate} \\u2014`, 'u'));
  }
});

test('the full SSOT binds Anthropic principles to KS2-specific evidence', async () => {
  const sdlc = await read('docs/agents/ai-sdlc.md');
  assert.match(sdlc, /https:\/\/claude\.com\/blog\/the-ai-native-sdlc-playbook/u);
  assert.match(sdlc, /Humans above the loop/u);
  assert.match(sdlc, /smallest sufficient context/u);
  assert.match(sdlc, /Discovery or research/u);
  assert.match(sdlc, /one owner,\s*one branch and one ordinary PR/u);
  assert.match(sdlc, /physical-device keyboard/u);
  assert.match(sdlc, /Signing, certificates, store mutation, deployment, release/u);
  assert.match(sdlc, /Token minimisation is not thought minimisation/u);
});


test('every F0 guidance dependency remains present and structurally governed', async () => {
  const [domain, triage] = await Promise.all([
    read('docs/agents/domain.md'),
    read('docs/agents/triage-labels.md'),
  ]);

  assert.match(domain, /^# Domain Docs$/mu);
  assert.match(domain, /CONCEPTS\.md/u);
  assert.match(domain, /docs\/solutions\//u);
  assert.match(triage, /^# Triage Labels$/mu);
  for (const label of [
    'needs-triage',
    'needs-info',
    'ready-for-agent',
    'ready-for-human',
    'wontfix',
  ]) {
    assert.ok(
      triage.includes('`' + label + '`'),
      `missing triage label: ${label}`,
    );
  }
});

test('the PR template captures exact state, selected proof and non-effects', async () => {
  const template = await read('.github/pull_request_template.md');
  for (const section of [
    '## Intent',
    '## Scope',
    '## Exact state',
    '## Focus route and evidence',
    '## Review',
    '## Non-effects',
  ]) {
    assert.ok(template.includes(section), `missing ${section}`);
  }
  assert.match(template, /base:/u);
  assert.match(template, /head:/u);
  assert.match(template, /Focus-Gates:/u);
  assert.match(template, /deliberate omissions/u);
  assert.match(template, /residual uncertainty/u);
});

test('CI keeps exact job names and full integration while allowing only F0 docs', async () => {
  const workflow = await read('.github/workflows/ci.yml');

  assert.match(workflow, /name: Domain and web/u);
  assert.match(workflow, /name: Android unsigned debug and release compile/u);
  assert.match(workflow, /name: iOS unsigned Simulator compile/u);
  assert.match(workflow, /merge_group:/u);
  assert.match(workflow, /push:\n    branches:\n      - main\n/u);
  assert.doesNotMatch(workflow, /jamesto\/mobile-b3-billing-download/u);
  assert.doesNotMatch(workflow, /jamesto\/mobile-b4-vertical-slice/u);

  const routes = [...workflow.matchAll(/node scripts\/detect-pr-focus-gate\.mjs/gu)];
  assert.equal(routes.length, 1);
  assert.match(workflow, /git diff --check/u);
  assert.match(workflow, /steps\.focus\.outputs\.product == 'false'/u);
  assert.match(workflow, /steps\.focus\.outputs\.product == 'true'/u);
  assert.match(
    workflow,
    /github\.event_name == 'pull_request' && steps\.focus\.outputs\.product == 'true'/u,
  );

  const android = workflow.slice(workflow.indexOf('  android-compile:'));
  const ios = workflow.slice(workflow.indexOf('  ios-compile:'));
  assert.match(android, /if: github\.event_name != 'pull_request'/u);
  assert.match(ios, /if: github\.event_name != 'pull_request'/u);
  assert.equal(
    [...workflow.matchAll(/node scripts\/detect-native-ci-changes\.mjs/gu)].length,
    2,
  );
});

test('current guidance points to one AI-SDLC authority and truthful CI tiers', async () => {
  const [readme, issueTracker, mergeTier] = await Promise.all([
    read('README.md'),
    read('docs/agents/issue-tracker.md'),
    read('docs/operations/merge-tier-gate.md'),
  ]);

  assert.match(readme, /docs\/agents\/ai-sdlc\.md/u);
  assert.match(readme, /Feature-branch pushes do not create\s+a duplicate CI run/u);
  assert.match(issueTracker, /one owner, one branch and one ordinary\s+PR/u);
  assert.match(issueTracker, /agent owns orientation, implementation/u);
  assert.match(mergeTier, /F0-only safe documentation/u);
  assert.match(mergeTier, /fail closed into this route/u);
  assert.match(mergeTier, /complete merge candidate integration boundary/u);
});
