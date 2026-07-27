import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  loadFullSpellingCatalogue,
  projectSpellingMonsters,
} from '../src/domain/spelling/index.js';
import {
  diffMonsterCelebrations,
  secureWordDelta,
} from '../src/app/celebrations/celebration-model.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function deterministicRandom(values) {
  let index = 0;
  return () => values[index++] ?? 0.25;
}

function secureProgress(items) {
  return Object.fromEntries(items.map(({ runtimeItemId }) => [
    runtimeItemId,
    { stage: 4 },
  ]));
}

function asProductProjection(projection, catalogue) {
  const trackById = new Map(
    catalogue.rewardTracks.map((track) => [track.rewardTrackId, track]),
  );
  return projection.map((monster) => {
    const track = trackById.get(monster.rewardTrackId);
    return {
      ...monster,
      thresholds: [...track.thresholds],
    };
  });
}

test('Full KS2 spelling publishes Inklet, Glimmerbug and aggregate Phaeton', () => {
  const catalogue = loadFullSpellingCatalogue();
  assert.deepEqual(
    catalogue.rewardTracks.map(({ rewardTrackId, monsterId }) => ({
      rewardTrackId,
      monsterId,
    })),
    [
      {
        rewardTrackId: 'spelling-core-inklet',
        monsterId: 'inklet',
      },
      {
        rewardTrackId: 'spelling-core-glimmerbug',
        monsterId: 'glimmerbug',
      },
      {
        rewardTrackId: 'spelling-core-phaeton',
        monsterId: 'phaeton',
      },
    ],
  );
  assert.deepEqual(catalogue.rewardTracks[2].sourceRewardTrackIds, [
    'spelling-core-inklet',
    'spelling-core-glimmerbug',
  ]);
  assert.deepEqual(catalogue.rewardTracks[2].thresholds, [3, 25, 95, 145, 213]);
});

test('A3 progression routes secure evidence into both direct pools and their union', () => {
  const catalogue = loadFullSpellingCatalogue();
  const y34 = catalogue.items.filter(({ yearBand }) => yearBand === '3-4').slice(0, 2);
  const y56 = catalogue.items.filter(({ yearBand }) => yearBand === '5-6').slice(0, 1);
  const projected = projectSpellingMonsters({
    learnerId: 'learner-a',
    progress: secureProgress([...y34, ...y56]),
    rewardTracks: catalogue.rewardTracks,
    items: catalogue.items,
    currentState: {},
    random: deterministicRandom([0.25, 0.75, 0.25]),
  });

  assert.deepEqual(
    projected.map((monster) => ({
      monsterId: monster.monsterId,
      branch: monster.branch,
      secureCount: monster.secureCount,
      caught: monster.caught,
      derivedStage: monster.derivedStage,
      earnedStageHighWater: monster.earnedStageHighWater,
    })),
    [
      {
        monsterId: 'inklet',
        branch: 'b1',
        secureCount: 2,
        caught: true,
        derivedStage: 0,
        earnedStageHighWater: 0,
      },
      {
        monsterId: 'glimmerbug',
        branch: 'b2',
        secureCount: 1,
        caught: true,
        derivedStage: 0,
        earnedStageHighWater: 0,
      },
      {
        monsterId: 'phaeton',
        branch: 'b1',
        secureCount: 3,
        caught: true,
        derivedStage: 0,
        earnedStageHighWater: 0,
      },
    ],
  );

  const firstTwentyFive = catalogue.items
    .filter(({ yearBand }) => yearBand === '3-4')
    .slice(0, 25);
  const evolved = projectSpellingMonsters({
    learnerId: 'learner-a',
    progress: secureProgress(firstTwentyFive),
    rewardTracks: catalogue.rewardTracks,
    items: catalogue.items,
    currentState: Object.fromEntries(
      projected.map((monster) => [monster.rewardTrackId, monster]),
    ),
    random: deterministicRandom([]),
  });
  const phaeton = evolved.find(({ monsterId }) => monsterId === 'phaeton');
  assert.equal(phaeton.secureCount, 25);
  assert.equal(phaeton.derivedStage, 1);
  assert.equal(phaeton.earnedStageHighWater, 1);
});

test('Codex and Trail use catch thresholds, earned stages and persisted branch art', async (t) => {
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: join(ROOT, 'vite.config.js'),
    server: { middlewareMode: true },
    appType: 'custom',
  });
  t.after(() => vite.close());

  const catalogue = loadFullSpellingCatalogue();
  const y34 = catalogue.items.filter(({ yearBand }) => yearBand === '3-4').slice(0, 2);
  const y56 = catalogue.items.filter(({ yearBand }) => yearBand === '5-6').slice(0, 1);
  const projection = projectSpellingMonsters({
    learnerId: 'learner-a',
    progress: secureProgress([...y34, ...y56]),
    rewardTracks: catalogue.rewardTracks,
    items: catalogue.items,
    currentState: {},
    random: deterministicRandom([0.25, 0.75, 0.25]),
  });
  const monsters = asProductProjection(projection, catalogue);
  const { buildCodex, trailMeadowCompanions } = await vite.ssrLoadModule(
    '/src/app/codex-model.js',
  );
  const { monsterArt } = await vite.ssrLoadModule('/src/app/mastery-art.js');

  const codex = buildCodex(monsters, 'spelling-core-glimmerbug');
  assert.equal(codex.roster.length, 3);
  assert.equal(codex.foundCount, '03');
  assert.equal(codex.secureWords, 3, 'aggregate Phaeton evidence is not double-counted');
  assert.deepEqual(
    trailMeadowCompanions(codex.roster).map(({ monsterId }) => monsterId),
    ['inklet', 'glimmerbug', 'phaeton'],
  );
  assert.equal(codex.hero.branch, 'b2');
  assert.equal(codex.hero.art, monsterArt('glimmerbug', 0, 'b2'));
  assert.notEqual(
    monsterArt('glimmerbug', 0, 'b1'),
    monsterArt('glimmerbug', 0, 'b2'),
  );

  const beforeCatch = monsters.map((monster) => (
    monster.monsterId === 'phaeton'
      ? {
        ...monster,
        secureCount: 2,
        caught: false,
        derivedStage: 0,
        earnedStageHighWater: 0,
      }
      : monster
  ));
  const hiddenPhaeton = buildCodex(beforeCatch, 'spelling-core-phaeton').hero;
  assert.equal(hiddenPhaeton.found, false);
  assert.equal(hiddenPhaeton.next, 'Secure 3 spellings across both pools to find it');

  const retainedEvolution = buildCodex([
    {
      ...monsters[0],
      secureCount: 9,
      caught: true,
      derivedStage: 0,
      earnedStageHighWater: 2,
    },
  ]).hero;
  assert.equal(retainedEvolution.stage, 2);
  assert.equal(retainedEvolution.title, 'Scribbla');
  assert.equal(retainedEvolution.art, monsterArt('inklet', 2, 'b1'));
});

test('result gains and celebrations do not regress or double-count aggregate evidence', () => {
  const before = [
    {
      rewardTrackId: 'spelling-core-inklet',
      monsterId: 'inklet',
      branch: 'b2',
      sourceRewardTrackIds: [],
      secureCount: 9,
      caught: true,
      derivedStage: 0,
      earnedStageHighWater: 1,
    },
    {
      rewardTrackId: 'spelling-core-phaeton',
      monsterId: 'phaeton',
      branch: 'b1',
      sourceRewardTrackIds: [
        'spelling-core-inklet',
        'spelling-core-glimmerbug',
      ],
      secureCount: 13,
      caught: true,
      derivedStage: 0,
      earnedStageHighWater: 0,
    },
  ];
  const after = [
    {
      ...before[0],
      secureCount: 10,
      derivedStage: 1,
      earnedStageHighWater: 2,
    },
    {
      ...before[1],
      secureCount: 14,
    },
  ];

  assert.equal(secureWordDelta(before, after), 1);
  assert.deepEqual(diffMonsterCelebrations(before, after), [{
    kind: 'evolve',
    monsterId: 'inklet',
    branch: 'b2',
    stage: 2,
    rewardTrackId: 'spelling-core-inklet',
  }]);
});

test('ProductApp passes the saved branch into the live Monster Stage', async () => {
  const source = await readFile(join(ROOT, 'src/app/ProductApp.jsx'), 'utf8');
  assert.match(
    source,
    /<MonsterStage[\s\S]*?monsterId=\{hero\.monsterId\}[\s\S]*?branch=\{hero\.branch\}[\s\S]*?stage=\{hero\.stage\}/u,
  );
});
