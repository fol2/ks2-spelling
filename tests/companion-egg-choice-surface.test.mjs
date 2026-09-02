import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createServer } from 'vite';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PURCHASE_LANGUAGE = /£|GBP|USD|\$\d|\bBuy\b|\bupgrade\b|\bpurchase\b|\bStoreKit\b|\bunlock\b/iu;

async function read(path) {
  return readFile(join(ROOT, path), 'utf8');
}

test('egg-choice sources omit purchase language', async () => {
  const files = [
    'src/app/EggChoiceMoment.jsx',
    'src/app/egg-choice-moment.js',
    'src/app/egg-choice-moment-runtime.js',
    'src/app/companion-branch-command.js',
  ];
  for (const file of files) {
    const source = await read(file);
    assert.doesNotMatch(source, PURCHASE_LANGUAGE, file);
    assert.doesNotMatch(source, /parentCommerce\.purchase|store\.purchase/u, file);
    assert.doesNotMatch(source, /\bversion\b|\bskin\b|\bA\/B\b/iu, file);
  }
});

test('egg-choice CSS declares 44px targets and a visible focus ring', async () => {
  const css = await read('src/app/app.css');
  assert.match(css, /\.egg-choice-egg\s*\{[^}]*min-height:\s*2\.75rem/u);
  assert.match(css, /\.egg-choice-egg\s*\{[^}]*min-width:\s*2\.75rem/u);
  assert.match(css, /\.egg-choice-egg:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--focus\)/u);
  assert.match(css, /\.codex-other-egg\s*\{[^}]*min-height:\s*2\.75rem/u);
  assert.match(css, /@media \(min-width: 24\.5625rem\)/u);
});

test('SSR of EggChoiceMoment is a dialog with two egg actions', async (t) => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const vite = await createServer({
    configFile: join(ROOT, 'vite.config.js'),
    server: { middlewareMode: true },
    appType: 'custom',
  });
  t.after(() => vite.close());
  const { EggChoiceMoment } = await vite.ssrLoadModule(
    '/src/app/EggChoiceMoment.jsx',
  );
  const html = renderToStaticMarkup(
    React.createElement(EggChoiceMoment, {
      monster: { monsterId: 'inklet', rewardTrackId: 'spelling-core-inklet' },
      onChoose() {},
    }),
  );
  assert.match(html, /data-egg-choice-moment="true"/);
  assert.match(html, /Which egg is yours\?/);
  assert.match(html, /Tap one\./);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /<h1 id="egg-choice-title">/);
  assert.equal((html.match(/<button /g) ?? []).length, 2);
  assert.match(html, /data-branch="b1"/);
  assert.match(html, /data-branch="b2"/);
  assert.match(html, /inklet-b1-0\.640\.webp/);
  assert.match(html, /inklet-b2-0\.640\.webp/);
  assert.equal((html.match(/This egg/g) ?? []).length, 2);
  assert.doesNotMatch(html, PURCHASE_LANGUAGE);
  assert.doesNotMatch(html, /Confirm|Skip|Buy|unlock/i);
});

test('ProductApp still plans starter-complete through the untouched runtime', async () => {
  const [product, runtime, overlay] = await Promise.all([
    read('src/app/ProductApp.jsx'),
    read('src/app/starter-complete-moment-runtime.js'),
    read('src/app/StarterCompleteMoment.jsx'),
  ]);
  assert.match(product, /planSummaryRewards/);
  assert.match(product, /StarterCompleteMoment/);
  assert.match(product, /celebrationEvents,/);
  assert.match(product, /eggChoicePending:/);
  assert.match(runtime, /starterCompleteMomentDecision/);
  assert.match(overlay, /data-starter-complete-moment="true"/);
});
