import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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

test('TrailScreen mounts TrailMeadow directly with codex-derived companions', async () => {
  const [rootSource, product] = await Promise.all([
    source('src/app/ProductRoot.jsx'),
    source('src/app/ProductApp.jsx'),
  ]);

  assert.match(rootSource, /<ProductApp services=\{services\} \/>/u);
  assert.doesNotMatch(
    rootSource,
    /TrailMeadowPortal|trail-meadow-portal/u,
    'production root must not reintroduce the portal layer',
  );

  assert.match(product, /import \{ TrailMeadow \} from '\.\/trail\/TrailMeadow\.jsx'/u);
  assert.match(product, /<TrailMeadow companions=\{companions\} seed=\{meadowSeed\} \/>/u);
  assert.match(
    product,
    /trailMeadowCompanions\(buildCodex\(learningState\.monsters\)\.roster\)/u,
  );
  assert.match(
    product,
    /`\$\{learningState\.learnerId\}:\$\{profile\.yearGroup\}`/u,
  );
  assert.doesNotMatch(product, /MeadowPet|MEADOW_SLOTS|ROAM_VARIABLES/u);
  assert.match(
    product,
    /id="product-spelling-input"/u,
    'the visible-input recovery must remain in the underlying product',
  );
});

test('the retired meadow portal files stay absent', () => {
  const retired = [
    'src/app/trail/TrailMeadowPortal.jsx',
    'src/app/trail/trail-meadow-portal.css',
  ];

  for (const path of retired) {
    assert.equal(
      existsSync(join(root, path)),
      false,
      `${path} must not return as a second meadow mount path`,
    );
  }
});

test('Trail remains a DOM habitat and does not add a second canvas runtime', async () => {
  const [component, model, trailStyles] = await Promise.all([
    source('src/app/trail/TrailMeadow.jsx'),
    source('src/app/trail/trail-meadow-model.js'),
    source('src/app/trail/trail-meadow.css'),
  ]);

  assert.doesNotMatch(component, /phaser|canvas/iu);
  assert.doesNotMatch(model, /Math\.random/u);
  assert.match(component, /data-motion=\{companion\.motion\}/u);
  assert.match(component, /trail-companion-nest/u);
  assert.match(trailStyles, /\.trail-companion\[data-path='egg'\]/u);
  assert.match(trailStyles, /@keyframes trailGroundRoute/u);
  assert.match(trailStyles, /@keyframes trailFlyRouteA/u);
  assert.match(trailStyles, /@keyframes trailFlyRouteB/u);
  assert.match(trailStyles, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(model, /glimmerbug:\s*'fly-a'/u);
  assert.match(model, /phaeton:\s*'fly-b'/u);
  assert.match(model, /inklet:\s*'walk'/u);
});

test('no CSS filter reaches the companion sprite (#109)', async () => {
  const [trailStyles, hardening] = await Promise.all([
    source('src/app/trail/trail-meadow.css'),
    source('src/app/trail/trail-meadow-hardening.css'),
  ]);

  /* Inside the app's WKWebView, creating a filter layer over the sprite can
     rasterise a buffer clipped and filled to the border box, leaving a grey
     plate that no later paint clears. It reproduces in roughly two of five
     cold installs and never in Safari or Chromium, so no browser check and no
     screenshot diff can catch a regression here — only this assertion can.

     The rule is structural: the sprite and every element that wraps it must
     stay filter-free. `.trail-meadow` decoration (blurred ground, path) is a
     sibling of the companions, not an ancestor, so it is out of scope. */
  const forbidden = [
    '.trail-companion',
    '.trail-companion-route',
    '.trail-companion-facing',
    '.trail-companion-gait',
    '.trail-companion-art',
  ];

  for (const css of [trailStyles, hardening]) {
    for (const [selector, body] of declarationBlocks(css)) {
      const targetsSprite = forbidden.some((name) => (
        new RegExp(`${escapeForRegExp(name)}(?![\\w-])`, 'u').test(selector)
      ));
      if (!targetsSprite) continue;
      assert.doesNotMatch(
        body,
        /(?:^|[\s;])-?(?:webkit-)?filter\s*:/u,
        `${selector.trim()} must not declare a filter — see #109`,
      );
    }
  }
});
