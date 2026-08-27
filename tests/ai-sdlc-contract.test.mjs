import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function source(path) {
  return readFile(join(ROOT, path), 'utf8');
}

test('the root agent kernel progressively discloses the complete AI-SDLC', async () => {
  const agents = await source('AGENTS.md');
  assert.match(agents, /^# KS2 Spelling Agent Contract$/m);
  assert.match(agents, /docs\/agents\/ai-sdlc\.md/u);
  assert.match(agents, /smallest sufficient context/u);
  assert.match(agents, /Human position/u);
  assert.match(agents, /James stays above the loop/u);
  assert.match(agents, /one branch and\s+one ordinary PR/u);
  assert.match(agents, /no-remote-code boundary/u);
  assert.match(agents, /scripts\/detect-pr-focus-gate\.mjs/u);
  assert.match(agents, /docs\/superpowers\/\*\*.*docs\/records\/\*\* are frozen/u);
});

test('the full SSOT binds all four rules, F0-F4 and KS2-specific proof', async () => {
  const sdlc = await source('docs/agents/ai-sdlc.md');
  assert.match(sdlc, /^# KS2 Spelling AI-Native SDLC$/m);
  assert.match(sdlc, /claude\.com\/blog\/the-ai-native-sdlc-playbook/u);
  for (const heading of [
    'AI-SDLC DNA',
    'Minimise wall time, maximise effectiveness',
    'Minimise token consumption',
    'No compromise',
  ]) {
    assert.match(sdlc, new RegExp(heading.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'));
  }
  assert.match(
    sdlc,
    /smallest sufficient context \+ smallest decisive experiment \+ smallest relevant gate \+ one integration boundary/u,
  );
  for (const gate of ['F0', 'F1', 'F2', 'F3', 'F4']) {
    assert.ok(sdlc.includes(`**${gate}`), `missing ${gate} gate`);
  }
  assert.match(sdlc, /physical-device\s+semantics/iu);
  assert.match(sdlc, /SQLite transaction/u);
  assert.match(sdlc, /StoreKit sandbox/u);
  assert.match(sdlc, /server\.url/u);
  assert.match(sdlc, /zero `npm ci` dependency bootstrap/u);
  assert.match(sdlc, /escaped-defect evidence does not\s+worsen/u);
});

test('the PR template records evidence, review and external non-effects without ceremony', async () => {
  const template = await source('.github/pull_request_template.md');
  assert.match(template, /^Focus-Gates: AUTO$/m);
  assert.match(template, /^F3-Actual-Runtime: no$/m);
  assert.match(template, /^F4-External-Effect: no$/m);
  for (const heading of ['Intent', 'Exact state', 'Evidence', 'Review', 'Non-effects']) {
    assert.match(template, new RegExp(`^## ${heading}$`, 'm'));
  }
  assert.match(template, /one branch, one ordinary PR/u);
  assert.match(template, /only observed evidence/u);
});

test('README, issue tracking and merge-tier docs expose one coherent operating model', async () => {
  const [readme, tracker, mergeTier] = await Promise.all([
    source('README.md'),
    source('docs/agents/issue-tracker.md'),
    source('docs/operations/merge-tier-gate.md'),
  ]);
  assert.match(readme, /docs\/agents\/ai-sdlc\.md/u);
  assert.match(readme, /F0-only\s+documentation\s+route/u);
  assert.match(tracker, /one independently mergeable outcome/u);
  assert.match(tracker, /one branch and one ordinary PR/u);
  assert.match(tracker, /Research does not need an issue, branch or PR per experiment/u);
  assert.match(mergeTier, /safe documentation-only PR/u);
  assert.match(mergeTier, /zero project-dependency bootstrap/u);
  assert.match(mergeTier, /Unknown, mixed or unresolved input fails closed/u);
});
