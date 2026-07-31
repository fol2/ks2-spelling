import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  celebrationCopy,
  celebrationDurationMs,
  celebrationEventKey,
  celebrationPalette,
  celebrationProgressMeterCopy,
  diffMonsterCelebrations,
  monsterCelebrationArtUrl,
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

test('diffMonsterCelebrations emits caught when found state flips false→true', () => {
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

test('diffMonsterCelebrations emits evolve when earned display stage increases', () => {
  assert.deepEqual(
    diffMonsterCelebrations(
      [monster({ caught: true, derivedStage: 1, secureCount: 10 })],
      [monster({
        caught: true,
        derivedStage: 1,
        earnedStageHighWater: 3,
        secureCount: 30,
      })],
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

test('combined catch and evolution reveals the egg before the evolved form', () => {
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
        stage: 0,
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

test('ordinary direct-companion gains receive one compact progress moment', () => {
  assert.deepEqual(
    diffMonsterCelebrations(
      [monster({ caught: true, secureCount: 2 })],
      [monster({ caught: true, secureCount: 4 })],
    ),
    [{
      kind: 'progress',
      monsterId: 'inklet',
      branch: 'b1',
      stage: 0,
      rewardTrackId: 'spelling-core-inklet',
      secureGain: 2,
      secureCount: 4,
      target: 100,
      nextThreshold: 10,
      percentBefore: 2,
      percentAfter: 4,
    }],
  );
});

test('progress cannot reveal a direct companion before its catch threshold', () => {
  const thresholds = [3, 10, 30, 60, 100];
  assert.deepEqual(
    diffMonsterCelebrations(
      [monster({ thresholds, secureCount: 0, caught: false })],
      [monster({ thresholds, secureCount: 1, caught: false })],
    ),
    [],
  );
});

test('ordinary aggregate gain is not celebrated twice but aggregate milestones remain', () => {
  const phaeton = (overrides = {}) => monster({
    rewardTrackId: 'spelling-core-phaeton',
    monsterId: 'phaeton',
    thresholds: [3, 25, 95, 145, 213],
    secureCount: 3,
    caught: true,
    ...overrides,
  });

  assert.deepEqual(
    diffMonsterCelebrations(
      [phaeton()],
      [phaeton({ secureCount: 4 })],
    ),
    [],
  );

  assert.deepEqual(
    diffMonsterCelebrations(
      [phaeton({ caught: false, secureCount: 2 })],
      [phaeton({ caught: true, secureCount: 3 })],
    ),
    [{
      kind: 'caught',
      monsterId: 'phaeton',
      branch: 'b1',
      stage: 0,
      rewardTrackId: 'spelling-core-phaeton',
    }],
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

test('secureWordDelta sums only direct secureCount increases', () => {
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

test('celebration copy distinguishes progress, catch and final evolution', () => {
  const progress = diffMonsterCelebrations(
    [monster({ caught: true, secureCount: 8 })],
    [monster({ caught: true, secureCount: 9 })],
  )[0];
  assert.deepEqual(celebrationCopy(progress), {
    eyebrow: 'Companion progress',
    headline: 'Inklet grew stronger',
    stageLabel: 'Inklet Egg · 9 / 100 secure',
    body: '1 spelling became secure. 1 more secure spelling to Inklet.',
    announcement: 'Inklet gained 1 secure spelling. 1 more secure spelling to Inklet.',
  });
  assert.equal(celebrationProgressMeterCopy(progress), '9 / 100 secure');
  assert.equal(celebrationDurationMs(progress), 2400);

  const caught = {
    kind: 'caught',
    monsterId: 'phaeton',
    stage: 0,
  };
  assert.equal(celebrationCopy(caught).eyebrow, 'Legendary companion found');
  assert.equal(celebrationCopy(caught).headline, 'Phaeton joined your trail!');

  const finalEvolution = {
    kind: 'evolve',
    monsterId: 'glimmerbug',
    stage: 4,
  };
  assert.deepEqual(celebrationPalette(finalEvolution), {
    primary: '#b43cd9',
    secondary: '#eab3d7',
    pale: '#f8e7f1',
  });
  assert.equal(celebrationCopy(finalEvolution).eyebrow, 'Final evolution');
  assert.equal(celebrationCopy(finalEvolution).headline, 'Mega Lanternwing');
  assert.equal(celebrationDurationMs(finalEvolution), 4000);
});

test('fully evolved progress reports real secure count without an impossible fraction', () => {
  const event = {
    kind: 'progress',
    monsterId: 'inklet',
    stage: 4,
    secureGain: 2,
    secureCount: 109,
    target: 100,
    nextThreshold: null,
  };
  assert.equal(
    celebrationProgressMeterCopy(event),
    '109 secure · fully evolved',
  );
  assert.equal(
    celebrationCopy(event).stageLabel,
    'Mega Quillorn · 109 secure · fully evolved',
  );
});

test('celebration event identity includes branch and progress payload', () => {
  const event = {
    kind: 'progress',
    rewardTrackId: 'spelling-core-glimmerbug',
    branch: 'b2',
    stage: 2,
    secureCount: 31,
    secureGain: 2,
  };
  assert.equal(
    celebrationEventKey(event, 3),
    'spelling-core-glimmerbug:progress:b2:2:31:2:3',
  );
  assert.notEqual(
    celebrationEventKey(event, 3),
    celebrationEventKey({ ...event, secureCount: 32 }, 3),
  );
});

test('celebration art keeps the saved branch, clamps stages and refuses fake IDs', () => {
  assert.equal(
    monsterCelebrationArtUrl('glimmerbug', 'b2', 4),
    '/mastery-art/monsters/glimmerbug/b2/glimmerbug-b2-4.640.webp',
  );
  assert.equal(
    monsterCelebrationArtUrl('inklet', 'unknown', 99),
    '/mastery-art/monsters/inklet/b1/inklet-b1-4.640.webp',
  );
  assert.equal(monsterCelebrationArtUrl('', 'b1', 0), null);
  assert.equal(monsterCelebrationArtUrl('../inklet', 'b1', 0), null);
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

test('celebration layer hardens modal focus, timers, scrolling and haptics', async () => {
  const [source, styles, hardening, haptics] = await Promise.all([
    readFile(
      resolve(import.meta.dirname, '../src/app/celebrations/CelebrationLayer.jsx'),
      'utf8',
    ),
    readFile(
      resolve(import.meta.dirname, '../src/app/celebrations/celebrations.css'),
      'utf8',
    ),
    readFile(
      resolve(
        import.meta.dirname,
        '../src/app/celebrations/celebration-hardening.css',
      ),
      'utf8',
    ),
    readFile(
      resolve(import.meta.dirname, '../src/platform/haptics/capacitor-haptics.js'),
      'utf8',
    ),
  ]);

  assert.match(source, /import ['"]\.\/celebrations\.css['"]/u);
  assert.match(source, /import ['"]\.\/celebration-hardening\.css['"]/u);
  assert.match(source, /document\.visibilityState/u);
  assert.match(source, /remainingMs\.current/u);
  assert.match(source, /dialogRef\.current\?\.focus/u);
  assert.match(source, /keyboardEvent\.key === 'Escape'/u);
  assert.match(source, /keyboardEvent\.key === 'Tab'/u);
  assert.match(source, /haptics\?\.celebrationStart\?\./u);
  assert.match(source, /setIndex\(list\.length\)/u);
  assert.match(source, /className="celebration-meter"/u);
  assert.match(source, /className="celebration-scroll"/u);

  assert.match(styles, /\.celebration-overlay\s*\{[\s\S]*?position:\s*fixed/u);
  assert.match(styles, /\.celebration-progress\s+\.celebration-art/u);
  assert.match(styles, /@keyframes celebrationEvolutionFlash/u);
  assert.match(styles, /@keyframes celebrationProgress/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/u);

  assert.match(hardening, /\.celebration-scroll\s*\{/u);
  assert.match(hardening, /overscroll-behavior:\s*contain/u);
  assert.match(hardening, /@media \(forced-colors: active\)/u);

  assert.match(haptics, /function fireAndForget/u);
  assert.match(haptics, /Promise\.resolve\(operation\(\)\)/u);
  assert.match(haptics, /kind === 'caught'/u);
  assert.match(haptics, /ImpactStyle\.Heavy/u);
  assert.match(haptics, /ImpactStyle\.Light/u);
  assert.match(haptics, /uiTick\(\)/u);
  assert.match(source, /sfx\?\.play\(/u);
  assert.match(source, /'catch'/u);
  assert.match(source, /'evolve'/u);
});
