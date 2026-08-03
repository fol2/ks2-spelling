/* The boot surfaces are composition, not behaviour: two screens with no state
   worth exercising. What can rot is the styling contract underneath them —
   the retired proof-shell classes creeping back, the recovery screen losing
   its alert or its one way out, or the surface starting to read tokens that
   only exist once the product surface has mounted. These are source pins on
   exactly that. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFile(join(ROOT, path), 'utf8');

test('both boot screens wear the boot surface, not the retired proof shell', async () => {
  const sources = await Promise.all([
    read('src/app/AppLoadingShell.jsx'),
    read('src/app/AppErrorBoundary.jsx'),
  ]);
  for (const source of sources) {
    assert.match(source, /className="app-boot"/u);
    assert.match(source, /className="app-boot-panel"/u);
    assert.match(source, /className="app-boot-kicker"/u);
    assert.match(source, /className="app-boot-title"/u);
    assert.doesNotMatch(source, /className="(?:shell|hero|eyebrow|intro)"/u);
  }
  assert.match(await read('index.html'), /name="theme-color" content="#f8f5ec"/u);
});

test('the recovery screen keeps its alert, its report and its one way out', async () => {
  const boundary = await read('src/app/AppErrorBoundary.jsx');
  assert.match(boundary, /componentDidCatch\(error, info\)/u);
  assert.match(boundary, /role="alert"/u);
  assert.match(
    boundary,
    /Your practice is safe on this device\. Start the app again to carry/u,
  );
  assert.match(boundary, /className="button-primary press app-boot-action"/u);
  assert.match(boundary, /Start again/u);
  assert.match(boundary, /<summary>What went wrong<\/summary>/u);
});

test('the boot surface stands on its own vellum and stills for reduced motion', async () => {
  const css = await read('src/app/app.css');
  const start = css.indexOf('   Boot surface — the overture');
  assert.ok(start > 0, 'app.css must carry a Boot surface section');
  const section = css.slice(start);

  assert.match(section, /\.app-boot \{[^}]*background:[^}]*#f8f5ec;/su);
  assert.match(section, /\.app-boot \{[^}]*color: #1d2b3a;/su);
  assert.match(section, /\.app-boot-title \{[^}]*font-family: Fraunces,/su);
  assert.match(
    section,
    /\.app-boot-title \{[^}]*font-size: clamp\(1\.85rem, 8\.5vw, 2\.5rem\);/su,
  );
  // Safe-area padding on all four sides, and no reach for a palette token that
  // is only declared on `.product-app`.
  assert.equal(section.match(/env\(safe-area-inset-\w+, 0px\)/gu)?.length, 4);
  assert.doesNotMatch(section, /var\(--(?:paper|ink|line|serif|sans|brand|gold|brass)/u);

  const reduce = css.lastIndexOf('@media (prefers-reduced-motion: reduce)');
  const kill = css.slice(reduce, css.indexOf('@media (forced-colors: active)', reduce));
  assert.match(kill, /\.app-boot \*,/u);
  assert.match(kill, /animation: none !important;/u);
});
