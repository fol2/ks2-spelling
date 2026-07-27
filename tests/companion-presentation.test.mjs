import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  companionPalette,
  companionPresentation,
  companionStageName,
  HIGHEST_COMPANION_STAGE,
  isKnownCompanion,
} from '../src/app/companion-presentation.js';

test('companion presentation is one immutable authority for the spelling roster', () => {
  assert.equal(HIGHEST_COMPANION_STAGE, 4);
  assert.deepEqual(
    ['inklet', 'glimmerbug', 'phaeton', 'vellhorn'].map((monsterId) => {
      const presentation = companionPresentation(monsterId);
      return {
        monsterId,
        name: presentation.name,
        band: presentation.band,
        stages: presentation.stages.length,
        legendary: presentation.legendary,
      };
    }),
    [
      {
        monsterId: 'inklet',
        name: 'Inklet',
        band: 'Years 3–4',
        stages: 5,
        legendary: false,
      },
      {
        monsterId: 'glimmerbug',
        name: 'Glimmerbug',
        band: 'Years 5–6',
        stages: 5,
        legendary: false,
      },
      {
        monsterId: 'phaeton',
        name: 'Phaeton',
        band: 'Legendary',
        stages: 5,
        legendary: true,
      },
      {
        monsterId: 'vellhorn',
        name: 'Vellhorn',
        band: 'Extra',
        stages: 5,
        legendary: false,
      },
    ],
  );

  for (const monsterId of ['inklet', 'glimmerbug', 'phaeton', 'vellhorn']) {
    const presentation = companionPresentation(monsterId);
    assert.equal(Object.isFrozen(presentation), true);
    assert.equal(Object.isFrozen(presentation.stages), true);
    assert.equal(isKnownCompanion(monsterId), true);
  }
});

test('shared stage names and palettes clamp safely and retain branded copy', () => {
  assert.equal(companionStageName('inklet', -10), 'Inklet Egg');
  assert.equal(companionStageName('inklet', 99), 'Mega Quillorn');
  assert.equal(companionStageName('glimmerbug', 2), 'Lumisprite');
  assert.equal(companionStageName('phaeton', 4), 'Phaeton');
  assert.deepEqual(companionPalette('glimmerbug'), {
    primary: '#b43cd9',
    secondary: '#eab3d7',
    pale: '#f8e7f1',
  });

  assert.equal(isKnownCompanion('unknown'), false);
  assert.equal(companionPresentation('unknown').name, 'Companion');
  assert.equal(companionStageName('unknown', 3), 'Strong companion');
});

test('Codex and celebration copy import the shared authority instead of cloning it', async () => {
  const [codex, celebrations] = await Promise.all([
    readFile(resolve(import.meta.dirname, '../src/app/codex-model.js'), 'utf8'),
    readFile(
      resolve(import.meta.dirname, '../src/app/celebrations/celebration-model.js'),
      'utf8',
    ),
  ]);

  assert.match(codex, /from ['"]\.\/companion-presentation\.js['"]/u);
  assert.match(
    celebrations,
    /from ['"]\.\.\/companion-presentation\.js['"]/u,
  );
  assert.doesNotMatch(codex, /const COMPANIONS\s*=/u);
  assert.doesNotMatch(celebrations, /const MONSTER_PRESENTATION\s*=/u);
});
