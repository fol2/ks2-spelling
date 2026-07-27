import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

test('ProductApp delegates the Trail habitat without regressing Setup companions', async () => {
  const source = await readFile(
    resolve(import.meta.dirname, '../src/app/ProductApp.jsx'),
    'utf8',
  );
  assert.match(
    source,
    /import \{ TrailMeadow \} from ['"]\.\/trail\/TrailMeadow\.jsx['"]/u,
  );
  assert.match(
    source,
    /import \{ buildCodex, setupExpeditionCompanion, trailMeadowCompanions \} from ['"]\.\/codex-model\.js['"]/u,
    'the Trail refactor must preserve the latest Setup owned-companion projection',
  );
  assert.match(source, /<TrailMeadow[\s\S]*?companions=\{/u);
  assert.match(source, /plateY="58%"/u);
  assert.doesNotMatch(source, /const MEADOW_SLOTS/u);
  assert.doesNotMatch(source, /function MeadowPet/u);
});

test('legacy floating-slot CSS is removed and the habitat owns motion', async () => {
  const [appStyles, trailStyles, component] = await Promise.all([
    readFile(resolve(import.meta.dirname, '../src/app/app.css'), 'utf8'),
    readFile(
      resolve(import.meta.dirname, '../src/app/trail/trail-meadow.css'),
      'utf8',
    ),
    readFile(
      resolve(import.meta.dirname, '../src/app/trail/TrailMeadow.jsx'),
      'utf8',
    ),
  ]);

  assert.doesNotMatch(appStyles, /@keyframes roamG/u);
  assert.doesNotMatch(appStyles, /\.meadow-pet/u);
  assert.match(trailStyles, /\.trail-companion\[data-path='egg'\]/u);
  assert.match(trailStyles, /@keyframes trailGroundRoute/u);
  assert.match(trailStyles, /@keyframes trailFlyRouteA/u);
  assert.match(trailStyles, /@keyframes trailFlyRouteB/u);
  assert.match(trailStyles, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(component, /data-motion=\{companion\.motion\}/u);
  assert.match(component, /trail-companion-nest/u);
});

test('Trail remains a DOM habitat and does not add a second canvas runtime', async () => {
  const [component, model] = await Promise.all([
    readFile(
      resolve(import.meta.dirname, '../src/app/trail/TrailMeadow.jsx'),
      'utf8',
    ),
    readFile(
      resolve(import.meta.dirname, '../src/app/trail/trail-meadow-model.js'),
      'utf8',
    ),
  ]);
  assert.doesNotMatch(component, /phaser|canvas/iu);
  assert.doesNotMatch(model, /Math\.random/u);
  assert.match(model, /glimmerbug:\s*'fly-a'/u);
  assert.match(model, /phaeton:\s*'fly-b'/u);
  assert.match(model, /inklet:\s*'walk'/u);
});
