import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');

async function source(path) {
  return readFile(resolve(root, path), 'utf8');
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
