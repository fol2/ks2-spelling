import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  clampCompanionStage,
  HIGHEST_COMPANION_STAGE,
} from '../src/app/companion-stage-contract.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const {
  stageArtUrl,
  evolutionDecision,
  contextFallbackDecision,
} = await import('../src/app/monster-stage/monster-stage-model.js');

// The web path maps to content/mastery-art/... on disk.
function diskPath(url) {
  return join(ROOT, 'content', url);
}

test('shared companion stage contract owns the authored 0..4 range', () => {
  assert.equal(HIGHEST_COMPANION_STAGE, 4);
  assert.equal(clampCompanionStage(-3), 0);
  assert.equal(clampCompanionStage(2.8), 2);
  assert.equal(clampCompanionStage(9), 4);
  assert.equal(clampCompanionStage(Number.NaN), 0);
  assert.equal(clampCompanionStage(Number.POSITIVE_INFINITY), 0);
});

test('stageArtUrl resolves to committed inklet art for every branch and stage', () => {
  for (const branch of ['b1', 'b2']) {
    for (let stage = 0; stage <= HIGHEST_COMPANION_STAGE; stage += 1) {
      const url = stageArtUrl('inklet', branch, stage);
      assert.equal(
        url,
        `/mastery-art/monsters/inklet/${branch}/inklet-${branch}-${stage}.640.webp`,
      );
      assert.ok(existsSync(diskPath(url)), `missing art on disk: ${url}`);
    }
  }
});

test('stageArtUrl falls back to b1 when branch is null or unknown', () => {
  assert.match(stageArtUrl('inklet', null, 2), /\/b1\/inklet-b1-2\.640\.webp$/u);
  assert.match(stageArtUrl('inklet', undefined, 0), /\/b1\/inklet-b1-0\.640\.webp$/u);
  assert.match(stageArtUrl('inklet', 'b3', 1), /\/b1\/inklet-b1-1\.640\.webp$/u);
});

test('stageArtUrl clamps the stage into the authored 0..4 range', () => {
  assert.match(stageArtUrl('inklet', 'b1', 9), /inklet-b1-4\.640\.webp$/u);
  assert.match(stageArtUrl('inklet', 'b1', -3), /inklet-b1-0\.640\.webp$/u);
  assert.match(stageArtUrl('inklet', 'b1', 2.8), /inklet-b1-2\.640\.webp$/u);
});

test('evolutionDecision evolves only on an increase and clamps its ends', () => {
  assert.deepEqual(evolutionDecision(1, 2), { kind: 'evolve', from: 1, to: 2 });
  assert.deepEqual(evolutionDecision(0, 4), { kind: 'evolve', from: 0, to: 4 });
  assert.deepEqual(evolutionDecision(3, 9), { kind: 'evolve', from: 3, to: 4 });
  assert.deepEqual(evolutionDecision(2, 2), { kind: 'none', from: 2, to: 2 });
  assert.deepEqual(evolutionDecision(3, 1), { kind: 'none', from: 3, to: 1 });
});

test('contextFallbackDecision picks static on context loss or reduced motion', () => {
  assert.equal(contextFallbackDecision({ contextLost: true }), 'static');
  assert.equal(contextFallbackDecision({ reducedMotion: true }), 'static');
  assert.equal(
    contextFallbackDecision({ contextLost: true, reducedMotion: true }),
    'static',
  );
  assert.equal(
    contextFallbackDecision({ contextLost: false, reducedMotion: false }),
    'live',
  );
  assert.equal(contextFallbackDecision({}), 'live');
  assert.equal(contextFallbackDecision(), 'live');
});

test('all companion stage consumers import the shared contract', async () => {
  const [model, scene, masteryArt, progress, celebrations] = await Promise.all([
    readFile(
      join(ROOT, 'src/app/monster-stage/monster-stage-model.js'),
      'utf8',
    ),
    readFile(join(ROOT, 'src/app/monster-stage/monster-scene.js'), 'utf8'),
    readFile(join(ROOT, 'src/app/mastery-art.js'), 'utf8'),
    readFile(join(ROOT, 'src/app/monster-progress-model.js'), 'utf8'),
    readFile(
      join(ROOT, 'src/app/celebrations/celebration-model.js'),
      'utf8',
    ),
  ]);

  assert.match(model, /from ['"]\.\.\/companion-stage-contract\.js['"]/u);
  assert.match(scene, /from ['"]\.\.\/companion-stage-contract\.js['"]/u);
  assert.match(masteryArt, /from ['"]\.\/companion-stage-contract\.js['"]/u);
  assert.match(progress, /from ['"]\.\/companion-stage-contract\.js['"]/u);
  assert.match(
    celebrations,
    /from ['"]\.\.\/companion-stage-contract\.js['"]/u,
  );

  assert.doesNotMatch(model, /STAGE_MAX\s*=\s*4/u);
  assert.doesNotMatch(scene, /Math\.min\(4/u);
  assert.doesNotMatch(masteryArt, /Math\.min\(HIGHEST_MONSTER_STAGE/u);
});

test('monster-scene imports shared stage-fx primitives', async () => {
  const source = await readFile(
    join(ROOT, 'src/app/monster-stage/monster-scene.js'),
    'utf8',
  );
  assert.match(source, /from ['"]\.\/stage-fx\.js['"]/u);
  assert.match(source, /spawnBurst\(/u);
  assert.match(source, /glowPulse\(/u);
  assert.match(source, /shockwaveRing\(/u);
  assert.match(source, /scheduleSway/u);
  // Round-2 depth: the rare preen idle and the shared twinkle primitive.
  assert.match(source, /twinkleSparks\(/u);
  assert.match(source, /schedulePreen/u);

  const fx = await readFile(
    join(ROOT, 'src/app/monster-stage/stage-fx.js'),
    'utf8',
  );
  assert.match(fx, /export function twinkleSparks/u);
});

test('ProductApp splits the monster stage behind React.lazy so the chunk cannot regress', async () => {
  const source = await readFile(join(ROOT, 'src/app/ProductApp.jsx'), 'utf8');
  assert.match(
    source,
    /lazy\(\s*\(\)\s*=>\s*import\(\s*['"]\.\/monster-stage\/MonsterStage\.jsx['"]\s*\)\s*\)/u,
    'MonsterStage must load via React.lazy(() => import(...)) to keep phaser in its own chunk',
  );
});
