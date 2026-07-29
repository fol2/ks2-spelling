import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

async function source(path) {
  return readFile(resolve(import.meta.dirname, '..', path), 'utf8');
}

test('ProductRoot layers the living habitat over PR55 without replacing ProductApp', async () => {
  const [root, portal, product] = await Promise.all([
    source('src/app/ProductRoot.jsx'),
    source('src/app/trail/TrailMeadowPortal.jsx'),
    source('src/app/ProductApp.jsx'),
  ]);

  assert.match(root, /<ProductApp services=\{services\} \/>/u);
  assert.match(root, /<TrailMeadowPortal services=\{services\} \/>/u);
  assert.match(portal, /import \{ createPortal \} from 'react-dom'/u);
  assert.match(portal, /services\.controller\.subscribe\(setProfileState\)/u);
  assert.match(portal, /services\.learning\.subscribe\(setLearningState\)/u);
  assert.match(portal, /\.trail-scene \.meadow/u);
  assert.match(portal, /target\.dataset\.integratedTrail = 'true'/u);
  assert.match(portal, /<TrailMeadow/u);
  assert.match(portal, /trailMeadowCompanions\(learningState\.monsters\)/u);

  assert.doesNotMatch(
    product,
    /TrailMeadowPortal/u,
    'the device-test layer must not fork PR55\'s shipping app shell',
  );
  assert.match(
    product,
    /id="product-spelling-input"/u,
    'the visible-input recovery must remain in the underlying product',
  );
});

test('the portal hides only the superseded meadow children and preserves the screen controls', async () => {
  const styles = await source('src/app/trail/trail-meadow-portal.css');
  assert.match(
    styles,
    /\.meadow\[data-integrated-trail='true'\] > \.meadow-halo/u,
  );
  assert.match(
    styles,
    /\.meadow\[data-integrated-trail='true'\] > \.meadow-pet/u,
  );
  assert.match(
    styles,
    /> \.trail-meadow/u,
  );
  assert.doesNotMatch(styles, /trail-launch|trail-chrome|trail-due/u);
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
