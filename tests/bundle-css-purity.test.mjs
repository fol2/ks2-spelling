/* Source-graph purity for the product CSS boundary: proof-shell styles live
   in b4-shell.css and must not re-enter the production import graph. The
   built-bundle half of this contract lives in app-shell.test.mjs. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFile(join(ROOT, path), 'utf8');

test('app.css keeps the product and boot surfaces without proof-shell classes', async () => {
  const css = await read('src/app/app.css');
  assert.doesNotMatch(css, /\.b4-learner-shell/);
  assert.doesNotMatch(css, /\.status-pill/);
  assert.doesNotMatch(css, /(?:^|\n)\.shell\s*\{/);
  assert.match(css, /\.product-app/);
  assert.match(css, /\.app-boot/);
});

test('b4-shell.css carries the retired proof-shell styles', async () => {
  const css = await read('src/app/b4-shell.css');
  assert.match(css, /\.b4-learner-shell/);
  assert.match(css, /\.status-pill/);
});

test('App.jsx imports b4-shell.css for development proof shells', async () => {
  const source = await read('src/app/App.jsx');
  assert.match(source, /import\s+['"]\.\/b4-shell\.css['"]/);
});

test('production entry points do not import b4-shell.css', async () => {
  const [productRoot, main] = await Promise.all([
    read('src/app/ProductRoot.jsx'),
    read('src/main.jsx'),
  ]);
  assert.doesNotMatch(productRoot, /b4-shell\.css/);
  assert.doesNotMatch(main, /b4-shell\.css/);
});

test('production vite alias resolves @ks2/app-root to ProductRoot.jsx', async () => {
  const config = await read('vite.config.js');
  assert.match(
    config,
    /'@ks2\/app-root':\s*resolve\(\s*ROOT,\s*mode === 'production'\s*\?\s*'src\/app\/ProductRoot\.jsx'\s*:\s*'src\/app\/App\.jsx'\s*,?\s*\)/s,
  );
});
