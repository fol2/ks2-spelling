import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  diffMonsterCelebrations,
  secureWordDelta,
} from '../src/app/celebrations/celebration-model.js';

function monster(overrides = {}) {
  return {
    rewardTrackId: 'spelling-core-inklet',
    packId: 'ks2-core',
    monsterId: 'inklet',
    thresholds: [1, 10, 30, 60, 100],
    branch: 'b1',
    secureCount: 0,
    caught: false,
    derivedStage: 0,
    earnedStageHighWater: 0,
    ...overrides,
  };
}

test('diffMonsterCelebrations emits caught when caught flips false→true', () => {
  assert.deepEqual(
    diffMonsterCelebrations(
      [monster({ caught: false, derivedStage: 0 })],
      [monster({ caught: true, derivedStage: 0, secureCount: 1 })],
    ),
    [{
      kind: 'caught',
      monsterId: 'inklet',
      branch: 'b1',
      stage: 0,
      rewardTrackId: 'spelling-core-inklet',
    }],
  );
});

test('diffMonsterCelebrations emits evolve when derivedStage increases', () => {
  assert.deepEqual(
    diffMonsterCelebrations(
      [monster({ caught: true, derivedStage: 1, secureCount: 10 })],
      [monster({ caught: true, derivedStage: 3, secureCount: 30 })],
    ),
    [{
      kind: 'evolve',
      monsterId: 'inklet',
      branch: 'b1',
      stage: 3,
      rewardTrackId: 'spelling-core-inklet',
    }],
  );
});

test('diffMonsterCelebrations puts caught before evolve when both fire', () => {
  assert.deepEqual(
    diffMonsterCelebrations(
      [monster({ caught: false, derivedStage: 0, secureCount: 0 })],
      [monster({ caught: true, derivedStage: 1, secureCount: 1 })],
    ),
    [
      {
        kind: 'caught',
        monsterId: 'inklet',
        branch: 'b1',
        stage: 1,
        rewardTrackId: 'spelling-core-inklet',
      },
      {
        kind: 'evolve',
        monsterId: 'inklet',
        branch: 'b1',
        stage: 1,
        rewardTrackId: 'spelling-core-inklet',
      },
    ],
  );
});

test('diffMonsterCelebrations returns empty when nothing changes', () => {
  const same = [monster({ caught: true, derivedStage: 2, secureCount: 12 })];
  assert.deepEqual(diffMonsterCelebrations(same, same), []);
});

test('diffMonsterCelebrations ignores tracks missing on either side', () => {
  assert.deepEqual(
    diffMonsterCelebrations(
      [monster()],
      [monster({
        rewardTrackId: 'other-track',
        monsterId: 'phaeton',
        caught: true,
        derivedStage: 2,
      })],
    ),
    [],
  );
  assert.deepEqual(
    diffMonsterCelebrations(
      [],
      [monster({ caught: true, derivedStage: 1 })],
    ),
    [],
  );
});

test('secureWordDelta sums only secureCount increases', () => {
  assert.equal(
    secureWordDelta(
      [
        monster({ secureCount: 2 }),
        monster({
          rewardTrackId: 'other',
          monsterId: 'phaeton',
          secureCount: 5,
        }),
      ],
      [
        monster({ secureCount: 5 }),
        monster({
          rewardTrackId: 'other',
          monsterId: 'phaeton',
          secureCount: 4,
        }),
        monster({
          rewardTrackId: 'new-only',
          monsterId: 'glimmerbug',
          secureCount: 9,
        }),
      ],
    ),
    3,
  );
  assert.equal(secureWordDelta([monster()], [monster()]), 0);
});

test('ProductApp wires CelebrationLayer into the summary screen', async () => {
  const source = await readFile(
    resolve(import.meta.dirname, '../src/app/ProductApp.jsx'),
    'utf8',
  );
  assert.ok(
    source.includes("from './celebrations/CelebrationLayer.jsx'"),
    'ProductApp must import CelebrationLayer',
  );
  assert.ok(
    source.includes('<CelebrationLayer'),
    'SummaryScreen must render CelebrationLayer',
  );
  assert.ok(
    source.includes('diffMonsterCelebrations'),
    'ProductApp must diff monsters at summary entry',
  );
});
