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
