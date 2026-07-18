import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DESIGN = 'docs/superpowers/specs/2026-07-09-standalone-spelling-mobile-application-design.md';
const PROGRAMME = 'docs/superpowers/plans/2026-07-09-standalone-spelling-mobile-programme.md';
const B3_PLAN = 'docs/superpowers/plans/2026-07-12-standalone-spelling-mobile-b3-sandbox-billing-signed-download-proof.md';
const LIVE_AMENDMENT = 'docs/superpowers/plans/2026-07-15-b3-task19-live-adapters-amendment.md';

async function source(relative) {
  await access(resolve(ROOT, relative));
  return readFile(resolve(ROOT, relative), 'utf8');
}

test('B3 foundation design and programme authority are tracked in this repository', async () => {
  const [design, programme, b3Plan, amendment] = await Promise.all([
    source(DESIGN),
    source(PROGRAMME),
    source(B3_PLAN),
    source(LIVE_AMENDMENT),
  ]);

  for (const foundation of [design, programme]) {
    assert.match(foundation, /4501607a9b58f2fb252b4cce64ba056e6f60c630/u);
    assert.match(foundation, /129ba457cccf21df03f4be813b4f4ed6e7d9f6ad/u);
    assert.doesNotMatch(foundation, /\/Users\/|\.\.\/\.\.\/\.\.\/\.\.\/ks2-mastery/u);
  }
  for (const handoff of [b3Plan, amendment]) {
    assert.match(handoff, /2026-07-09-standalone-spelling-mobile-application-design\.md/u);
    assert.match(handoff, /2026-07-09-standalone-spelling-mobile-programme\.md/u);
    assert.doesNotMatch(handoff, /\/Users\/jamesto\/Coding\/ks2-mastery/u);
    assert.doesNotMatch(handoff, /\.\.\/\.\.\/\.\.\/\.\.\/ks2-mastery/u);
  }
});
