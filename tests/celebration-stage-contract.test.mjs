import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { celebrationStageDecision } from '../src/app/celebrations/celebration-model.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('celebrationStageDecision is live only for caught/evolve with all guards clear', () => {
  assert.equal(
    celebrationStageDecision({ kind: 'caught' }),
    'live',
  );
  assert.equal(
    celebrationStageDecision({ kind: 'evolve' }),
    'live',
  );
  assert.equal(
    celebrationStageDecision({
      kind: 'caught',
      reducedMotion: false,
      contextLost: false,
      backgrounded: false,
    }),
    'live',
  );
  assert.equal(
    celebrationStageDecision({
      kind: 'evolve',
      reducedMotion: false,
      contextLost: false,
      backgrounded: false,
    }),
    'live',
  );

  assert.equal(celebrationStageDecision({ kind: 'progress' }), 'static');
  assert.equal(celebrationStageDecision({ kind: 'camp-level' }), 'static');
  assert.equal(celebrationStageDecision({ kind: 'other' }), 'static');
  assert.equal(celebrationStageDecision({}), 'static');
  assert.equal(celebrationStageDecision(), 'static');
  assert.equal(celebrationStageDecision({ kind: null }), 'static');

  for (const kind of ['caught', 'evolve']) {
    assert.equal(
      celebrationStageDecision({ kind, reducedMotion: true }),
      'static',
    );
    assert.equal(
      celebrationStageDecision({ kind, contextLost: true }),
      'static',
    );
    assert.equal(
      celebrationStageDecision({ kind, backgrounded: true }),
      'static',
    );
    assert.equal(
      celebrationStageDecision({
        kind,
        reducedMotion: true,
        contextLost: true,
        backgrounded: true,
      }),
      'static',
    );
  }

  assert.equal(
    celebrationStageDecision({
      kind: 'progress',
      reducedMotion: false,
      contextLost: false,
      backgrounded: false,
    }),
    'static',
  );
  assert.equal(
    celebrationStageDecision({
      kind: 'camp-level',
      reducedMotion: false,
      contextLost: false,
      backgrounded: false,
    }),
    'static',
  );
});

test('CelebrationLayer splits CelebrationStage behind React.lazy', async () => {
  const source = await readFile(
    join(ROOT, 'src/app/celebrations/CelebrationLayer.jsx'),
    'utf8',
  );
  assert.match(
    source,
    /lazy\(\s*\(\)\s*=>\s*import\(\s*['"]\.\/CelebrationStage\.jsx['"]\s*\)\s*\)/u,
    'CelebrationStage must load via React.lazy(() => import(...)) to keep phaser in its shared chunk',
  );
  assert.match(source, /<Suspense\s+fallback=\{null\}>/u);
  assert.match(source, /celebrationStageDecision\(/u);
  assert.match(source, /className="celebration-art"/u);
});

test('celebration-scene factory takes Phaser as an argument with no top-level import', async () => {
  const source = await readFile(
    join(ROOT, 'src/app/celebrations/celebration-scene.js'),
    'utf8',
  );
  assert.match(source, /export function createCelebrationScene\s*\(\s*Phaser\s*,/u);
  assert.doesNotMatch(source, /^import\s+.*['"]phaser['"]/mu);
  assert.doesNotMatch(source, /from\s+['"]phaser['"]/u);
  assert.match(source, /from ['"]\.\.\/monster-stage\/stage-fx\.js['"]/u);
  // The live evolution keeps all three shared primitives and takes its schedule
  // from the same beat model the stylesheet mirrors.
  assert.match(source, /spawnBurst\(/u);
  assert.match(source, /glowPulse\(/u);
  assert.match(source, /shockwaveRing\(/u);
  assert.match(source, /celebrationBeats\(/u);
  assert.match(source, /beats\.shockwave/u);
  assert.match(source, /beats\.reveal/u);
});

test('the evolve card opens as a silhouette and clears it at the reveal beat', async () => {
  const styles = await readFile(
    join(ROOT, 'src/app/celebrations/celebrations.css'),
    'utf8',
  );

  assert.match(
    styles,
    /\.celebration-evolve \.celebration-art \{[^}]*celebrationSilhouetteReveal/u,
    'the evolve art must run the silhouette keyframe',
  );
  assert.match(
    styles,
    /@keyframes celebrationSilhouetteReveal \{[\s\S]*?brightness\(0\)/u,
    'the silhouette must open at brightness(0)',
  );
  assert.match(styles, /delays mirror celebrationBeats/u);

  const reduce = styles.lastIndexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(reduce > 0, 'celebrations.css must keep its reduce block');
  const kill = styles.slice(reduce);
  assert.match(kill, /animation: none !important;/u);
  for (const selector of [
    '.celebration-art',
    '.celebration-part',
    '.celebration-eyebrow',
    '.celebration-headline',
    '.celebration-stage-label',
    '.celebration-body',
    '.celebration-meter',
  ]) {
    assert.ok(
      kill.includes(`${selector},`),
      `${selector} must be inside the reduced-motion kill list`,
    );
  }
  // Reduced motion must never be left holding a black square where the art is.
  assert.doesNotMatch(kill, /brightness\(0\)/u);
  assert.match(
    kill,
    /\.celebration-evolve \.celebration-art \{[^}]*filter:[^}]*drop-shadow/u,
  );
});

test('CelebrationStage destroys on background and unmount and blocks pointer events', async () => {
  const source = await readFile(
    join(ROOT, 'src/app/celebrations/CelebrationStage.jsx'),
    'utf8',
  );
  assert.match(source, /game\.destroy\(\s*true\s*\)/u);
  assert.match(source, /backgrounded|!visible|visible/u);
  assert.match(source, /aria-hidden=["']true["']/u);
  assert.match(source, /pointerEvents:\s*['"]none['"]/u);
  assert.match(source, /import\(['"]phaser['"]\)/u);
  assert.match(source, /createCelebrationScene/u);
  assert.match(
    source,
    /resolution:\s*Math\.min\([\s\S]*?,\s*2\)/u,
  );
});

test('stage-fx is shared by celebration-scene and monster-scene', async () => {
  const [fx, celebration, monster] = await Promise.all([
    readFile(join(ROOT, 'src/app/monster-stage/stage-fx.js'), 'utf8'),
    readFile(join(ROOT, 'src/app/celebrations/celebration-scene.js'), 'utf8'),
    readFile(join(ROOT, 'src/app/monster-stage/monster-scene.js'), 'utf8'),
  ]);

  assert.match(fx, /export function spawnBurst/u);
  assert.match(fx, /export function glowPulse/u);
  assert.match(fx, /export function shockwaveRing/u);
  assert.match(celebration, /from ['"]\.\.\/monster-stage\/stage-fx\.js['"]/u);
  assert.match(monster, /from ['"]\.\/stage-fx\.js['"]/u);
  assert.match(celebration, /spawnBurst\(/u);
  assert.match(monster, /spawnBurst\(/u);
});
