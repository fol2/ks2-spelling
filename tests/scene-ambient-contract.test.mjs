import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');

async function source(path) {
  return readFile(resolve(root, path), 'utf8');
}

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/* Yield [selector, body] for every rule, ignoring at-rule preludes so nested
   blocks inside @media are visited with their own selectors. */
function* declarationBlocks(css) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//gu, '');
  const pattern = /([^{}]+)\{([^{}]*)\}/gu;
  let match = pattern.exec(withoutComments);
  while (match !== null) {
    const selector = match[1];
    if (!selector.trim().startsWith('@')) yield [selector, match[2]];
    match = pattern.exec(withoutComments);
  }
}

function sceneSource(product) {
  const start = product.indexOf('function Scene(');
  const end = product.indexOf('\nfunction WaypointBar', start);
  assert.ok(start >= 0 && end > start, 'Scene must sit before WaypointBar');
  return product.slice(start, end);
}

function subjectOf(part) {
  return part.trim().split(/[\s>+~]/u).filter(Boolean).pop() ?? '';
}

function selectorHasSubject(selector, className) {
  const needle = new RegExp(`${escapeForRegExp(className)}(?![\\w-])`, 'u');
  return selector.split(',').some((part) => needle.test(subjectOf(part)));
}

function declares(body, property, value) {
  return new RegExp(
    `(?:^|[\\s;])${escapeForRegExp(property)}\\s*:\\s*${value}`,
    'u',
  ).test(body);
}

const AMBIENT_KEYFRAMES = ['sceneDrift', 'sceneHaze', 'sceneMote'];
const STILL_SUBJECTS = [
  '.round-card',
  '.round-foot',
  '.round-stage',
  '.answer-line',
  '.waypoint-bar',
];

function animationMentions(body, name) {
  return new RegExp(
    `(?:^|[\\s;])animation(?:-name)?\\s*:\\s*[^;]*\\b${escapeForRegExp(name)}\\b`,
    'u',
  ).test(body);
}

test('Scene mounts an aria-hidden ambient overlay with three motes when a plate is present', async () => {
  const product = await source('src/app/ProductApp.jsx');
  const scene = sceneSource(product);

  assert.match(
    scene,
    /\{plate && <span className="scene-plate" aria-hidden="true" \/>\}/u,
  );
  assert.match(
    scene,
    /<span className="scene-ambient" aria-hidden="true">/u,
  );
  assert.equal(
    scene.match(/className="scene-ambient-mote"/gu)?.length,
    3,
    'three motes — the harness motes treatment needs them in the tree',
  );
  assert.match(
    scene,
    /\{veil && <span className="scene-veil" aria-hidden="true" \/>\}/u,
  );

  const css = await source('src/app/app.css');
  for (const name of ['.scene-plate', '.scene-veil', '.scene-ambient']) {
    let held = false;
    for (const [selector, body] of declarationBlocks(css)) {
      if (!selectorHasSubject(selector, name)) continue;
      if (declares(body, 'pointer-events', 'none\\b')) held = true;
      assert.doesNotMatch(
        body,
        /(?:^|[\s;])pointer-events\s*:\s*(?:auto|all)\b/u,
        `${selector.trim()} must not re-enable pointer events on ${name}`,
      );
    }
    assert.ok(held, `${name} must declare pointer-events: none`);
  }
});

test('Scene writes data-ambient-paused from document visibilitychange', async () => {
  const scene = sceneSource(await source('src/app/ProductApp.jsx'));

  assert.match(scene, /document\.hidden/u);
  assert.match(
    scene,
    /document\.addEventListener\(\s*['"]visibilitychange['"]/u,
  );
  assert.match(
    scene,
    /removeEventListener\(\s*['"]visibilitychange['"]/u,
  );
  assert.match(
    scene,
    /data-ambient-paused=\{hidden \? ['"]true['"] : undefined\}/u,
  );
});

test('paused scenes stop plate and ambient animations without cancelling them', async () => {
  const css = await source('src/app/app.css');
  const pauseSelectors = [];
  for (const [selector, body] of declarationBlocks(css)) {
    if (!/\[data-ambient-paused=['"]true['"]\]/u.test(selector)) continue;
    if (!declares(body, 'animation-play-state', 'paused\\s*!important')) continue;
    pauseSelectors.push(selector);
  }
  assert.ok(
    pauseSelectors.length > 0,
    'a [data-ambient-paused=\'true\'] rule must set animation-play-state: paused',
  );
  const joined = pauseSelectors.join(',');
  assert.match(joined, /\.scene-plate/u);
  assert.match(joined, /\.scene-ambient/u);
  assert.match(joined, /\.scene-ambient-mote/u);
});

test('ambient keyframes attach to setup/round plates and overlays, not the spelling surface', async () => {
  const css = await source('src/app/app.css');
  const found = Object.fromEntries(AMBIENT_KEYFRAMES.map((name) => [name, []]));

  for (const [selector, body] of declarationBlocks(css)) {
    for (const name of AMBIENT_KEYFRAMES) {
      if (!animationMentions(body, name)) continue;
      found[name].push(selector);

      for (const still of STILL_SUBJECTS) {
        assert.equal(
          selectorHasSubject(selector, still),
          false,
          `${selector.trim()} must not attach ${name} to ${still}`,
        );
      }
      assert.equal(
        selector.split(',').some((part) => /^(?:input|textarea)(?:[.#:[\s]|$)/u.test(subjectOf(part))),
        false,
        `${selector.trim()} must not attach ${name} to the practice input`,
      );
    }
  }

  for (const name of AMBIENT_KEYFRAMES) {
    assert.ok(
      found[name].length > 0,
      `${name} must be referenced from a declaration`,
    );
    assert.ok(
      found[name].some((selector) => (
        /\.setup-scene|\.round-scene/u.test(selector)
        && /\.scene-plate|\.scene-ambient/u.test(selector)
      )),
      `${name} must be referenced from a .setup-scene / .round-scene plate or ambient selector`,
    );
  }
});

test('reduced-motion keeps the painted plate and leaves haze/motes at opacity 0', async () => {
  const css = await source('src/app/app.css');
  const reduceStart = css.lastIndexOf('@media (prefers-reduced-motion: reduce)');
  const forcedStart = css.indexOf('@media (forced-colors: active)', reduceStart);
  assert.ok(reduceStart >= 0 && forcedStart > reduceStart, 'the global reduce block must precede forced-colors');
  const kill = css.slice(reduceStart, forcedStart);

  assert.match(kill, /\.product-app \*/u);
  assert.match(kill, /animation:\s*none\s*!important/u);
  assert.doesNotMatch(
    kill,
    /\.scene-plate[^{]*\{[^}]*display\s*:\s*none/u,
    'reduced-motion must not hide the plate — that path is forced-colors',
  );

  let hazeRest = false;
  let moteRest = false;
  for (const [selector, body] of declarationBlocks(css)) {
    if (selectorHasSubject(selector, '.scene-ambient::before')
      || /\.scene-ambient::before/u.test(selector)) {
      if (declares(body, 'opacity', '0(?:\\s*;|$)')) hazeRest = true;
    }
    if (selectorHasSubject(selector, '.scene-ambient-mote')) {
      if (declares(body, 'opacity', '0(?:\\s*;|$)')) moteRest = true;
    }
  }
  assert.ok(hazeRest, '.scene-ambient::before must rest at opacity 0');
  assert.ok(moteRest, '.scene-ambient-mote must rest at opacity 0');

  for (const [selector, body] of declarationBlocks(kill)) {
    const haze = /\.scene-ambient::before/u.test(selector);
    const mote = selectorHasSubject(selector, '.scene-ambient-mote');
    if (!haze && !mote) continue;
    assert.doesNotMatch(
      body,
      /(?:^|[\s;])opacity\s*:\s*(?!0(?:\s|;|$))/u,
      `${selector.trim()} must not give haze/motes a visible reduced-motion rest`,
    );
  }
});

test('Scene does not add a canvas or timer runtime for ambient motion', async () => {
  const scene = sceneSource(await source('src/app/ProductApp.jsx'));
  assert.doesNotMatch(scene, /phaser|canvas|requestAnimationFrame|setInterval/iu);
});

test('the design harness documents ?ambient= and sets the dataset only for drift and motes', async () => {
  const harness = await source('design/harness.jsx');
  const commentEnd = harness.indexOf('*/');
  assert.ok(commentEnd > 0, 'harness must keep its query-flag comment');
  assert.match(
    harness.slice(0, commentEnd),
    /\?ambient=/u,
    'the query-flag comment must document ?ambient=',
  );
  assert.match(
    harness,
    /document\.documentElement\.dataset\.ambient\s*=/u,
  );
  assert.match(
    harness,
    /ambient === ['"]drift['"]\s*\|\|\s*ambient === ['"]motes['"]/u,
    'only drift and motes may write the dataset — invalid/absent stays the product default',
  );
  assert.match(
    harness,
    /delete document\.documentElement\.dataset\.ambient/u,
    'leaving ?ambient= must clear a previous comparison so the product default returns',
  );
});

test('ambient layers keep z-index auto so they cannot cover setup hero or tray', async () => {
  const css = await source('src/app/app.css');
  for (const [selector, body] of declarationBlocks(css)) {
    if (!selectorHasSubject(selector, '.scene-ambient')
      && !selectorHasSubject(selector, '.scene-veil')
      && !selectorHasSubject(selector, '.scene-plate')) {
      continue;
    }
    assert.doesNotMatch(
      body,
      /(?:^|[\s;])z-index\s*:/u,
      `${selector.trim()} must stay z-index:auto — a raised plate/ambient/veil covers setup's in-flow hero and tray`,
    );
  }
});

test('forced-colors hides the ambient overlay with the plate and veil', async () => {
  const css = await source('src/app/app.css');
  const forced = css.slice(css.indexOf('@media (forced-colors: active)'));
  let hidden = false;
  for (const [selector, body] of declarationBlocks(forced)) {
    if (!declares(body, 'display', 'none\\b')) continue;
    if (/\.scene-plate/u.test(selector) && /\.scene-ambient/u.test(selector)) {
      hidden = true;
    }
  }
  assert.ok(
    hidden,
    'the forced-colors hide list that already covers .scene-plate must also name .scene-ambient',
  );
});
