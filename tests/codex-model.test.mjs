import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

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

test('Codex found flag and Trail meadow omit unfound companions', async (t) => {
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: join(ROOT, 'vite.config.js'),
    server: { middlewareMode: true },
    appType: 'custom',
  });
  t.after(() => vite.close());

  const {
    buildCodex,
    trailMeadowCompanions,
  } = await vite.ssrLoadModule('/src/app/codex-model.js');
  const { HIGHEST_MONSTER_STAGE } = await vite.ssrLoadModule('/src/app/mastery-art.js');

  assert.equal(HIGHEST_MONSTER_STAGE, 4);

  const unfound = buildCodex([monster()]);
  assert.equal(unfound.roster[0].found, false);
  assert.equal(unfound.roster[0].stage, 0);
  assert.equal(unfound.roster[0].title, '???');
  assert.equal(unfound.roster[0].stageLabel, 'Not yet found');
  assert.deepEqual(trailMeadowCompanions(unfound.roster, 4), []);

  // Stage vocabulary: egg (0) → hatched (1) → youth (2) → adult (3) → grand evo (4).
  const egg = buildCodex([
    monster({ caught: true, secureCount: 1, derivedStage: 0 }),
  ]);
  assert.equal(egg.roster[0].found, true);
  assert.equal(egg.roster[0].title, 'Inklet Egg');
  assert.equal(egg.roster[0].stageLabel, 'Stage 0 of 4');
  assert.equal(trailMeadowCompanions(egg.roster, 4).length, 1);
  assert.equal(trailMeadowCompanions(egg.roster, 4)[0].art, egg.roster[0].art);

  const hatched = buildCodex([
    monster({ caught: true, secureCount: 10, derivedStage: 1 }),
  ]);
  assert.equal(hatched.roster[0].title, 'Inklet');
  assert.equal(hatched.roster[0].stage, 1);

  const youth = buildCodex([
    monster({ caught: true, secureCount: 30, derivedStage: 2 }),
  ]);
  assert.equal(youth.roster[0].title, 'Scribbla');

  const adult = buildCodex([
    monster({ caught: true, secureCount: 60, derivedStage: 3 }),
  ]);
  assert.equal(adult.roster[0].title, 'Quillorn');

  const grand = buildCodex([
    monster({ caught: true, secureCount: 100, derivedStage: 4 }),
  ]);
  assert.equal(grand.roster[0].title, 'Mega Quillorn');
  assert.equal(grand.roster[0].stageLabel, 'Stage 4 of 4');
  assert.equal(grand.roster[0].next, 'Fully grown');

  // Legacy snapshots without `caught` still count as found once a word is secure.
  const legacy = buildCodex([
    monster({ caught: false, secureCount: 1, derivedStage: 0 }),
  ]);
  assert.equal(legacy.roster[0].found, true);
  assert.equal(trailMeadowCompanions(legacy.roster).length, 1);

  const mixed = buildCodex([
    monster({ caught: true, secureCount: 1, derivedStage: 0 }),
    monster({
      rewardTrackId: 'spelling-core-glimmerbug',
      monsterId: 'glimmerbug',
      caught: false,
      secureCount: 0,
    }),
    monster({
      rewardTrackId: 'spelling-core-phaeton',
      monsterId: 'phaeton',
      caught: true,
      secureCount: 20,
      derivedStage: 2,
      thresholds: [1, 5, 15, 40, 80],
    }),
  ]);
  const meadow = trailMeadowCompanions(mixed.roster, 4);
  assert.deepEqual(
    meadow.map((entry) => entry.monsterId),
    ['inklet', 'phaeton'],
  );
  assert.equal(meadow[1].title, 'Cometwing');
  assert.equal(meadow[1].art, mixed.roster[2].art);
});

test('Codex defaults to the first found companion but honours an explicit selection', async (t) => {
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: join(ROOT, 'vite.config.js'),
    server: { middlewareMode: true },
    appType: 'custom',
  });
  t.after(() => vite.close());

  const { buildCodex } = await vite.ssrLoadModule('/src/app/codex-model.js');
  const roster = [
    monster(),
    monster({
      rewardTrackId: 'spelling-core-glimmerbug',
      monsterId: 'glimmerbug',
      caught: true,
      secureCount: 10,
      derivedStage: 1,
      earnedStageHighWater: 1,
    }),
  ];

  const defaultCodex = buildCodex(roster);
  assert.equal(defaultCodex.hero.monsterId, 'glimmerbug');
  assert.equal(defaultCodex.hero.title, 'Glimmerbug');

  const selectedCodex = buildCodex(roster, 'spelling-core-inklet');
  assert.equal(selectedCodex.hero.monsterId, 'inklet');
  assert.equal(selectedCodex.hero.found, false);
  assert.equal(selectedCodex.hero.title, '???');
});

test('Set off picks the furthest grown owned companion, never a hard-coded Inklet', async (t) => {
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: join(ROOT, 'vite.config.js'),
    server: { middlewareMode: true },
    appType: 'custom',
  });
  t.after(() => vite.close());

  const { setupExpeditionCompanion } = await vite.ssrLoadModule(
    '/src/app/codex-model.js',
  );

  assert.equal(setupExpeditionCompanion([]), null);
  assert.equal(setupExpeditionCompanion([], 'y5-6'), null);
  assert.equal(setupExpeditionCompanion([monster()]), null);

  const ownedMonsters = [
    monster({
      caught: true,
      secureCount: 10,
      derivedStage: 1,
      earnedStageHighWater: 1,
    }),
    monster({
      rewardTrackId: 'spelling-core-glimmerbug',
      monsterId: 'glimmerbug',
      caught: true,
      secureCount: 40,
      derivedStage: 2,
      earnedStageHighWater: 2,
      thresholds: [1, 5, 15, 40, 80],
    }),
    monster({
      rewardTrackId: 'spelling-core-phaeton',
      monsterId: 'phaeton',
      caught: false,
      secureCount: 0,
      thresholds: [1, 5, 15, 40, 80],
    }),
  ];
  const owned = setupExpeditionCompanion(ownedMonsters);
  assert.equal(owned.monsterId, 'glimmerbug');
  assert.equal(owned.stage, 2);
  assert.equal(owned.found, true);
  assert.match(owned.art, /glimmerbug-b1-2\.640\.webp$/u);
  assert.equal(
    setupExpeditionCompanion(ownedMonsters, 'y3-4').monsterId,
    'inklet',
  );
  assert.equal(
    setupExpeditionCompanion(ownedMonsters, 'y5-6').monsterId,
    'glimmerbug',
  );
  const sleeping = setupExpeditionCompanion([
    monster({ caught: true, secureCount: 100, derivedStage: 4 }),
    monster({
      rewardTrackId: 'spelling-core-glimmerbug',
      monsterId: 'glimmerbug',
      thresholds: [1, 5, 15, 40, 80],
    }),
  ], 'y5-6');
  assert.equal(sleeping.found, false);
  assert.match(sleeping.art, /glimmerbug-b1-0\.640\.webp$/u);
  assert.equal(
    setupExpeditionCompanion(ownedMonsters, 'core').monsterId,
    'glimmerbug',
  );

  const tied = setupExpeditionCompanion([
    monster({
      caught: true,
      secureCount: 30,
      derivedStage: 2,
      earnedStageHighWater: 2,
    }),
    monster({
      rewardTrackId: 'spelling-core-glimmerbug',
      monsterId: 'glimmerbug',
      caught: true,
      secureCount: 15,
      derivedStage: 2,
      earnedStageHighWater: 2,
      thresholds: [1, 5, 15, 40, 80],
    }),
  ]);
  assert.equal(tied.monsterId, 'inklet');
});
