import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadStarterSpellingCatalogue,
  projectSpellingMonsters,
} from '../src/domain/spelling/index.js';
import { buildCodex } from '../src/app/codex-model.js';
import { createProductLearningController } from '../src/app/product-learning-controller.js';
import { buildWordBank } from '../src/app/word-bank-model.js';
import { expectedB2Snapshot } from './helpers/b2-database-harness.mjs';

const NOW_MS = 1_768_478_400_000;

function withTrackThresholds(monsters, catalogue) {
  const tracks = new Map(
    catalogue.rewardTracks.map((track) => [track.rewardTrackId, track]),
  );
  return monsters.map((monster) => {
    const track = tracks.get(monster.rewardTrackId);
    return {
      ...monster,
      thresholds: [...(track?.thresholds ?? monster.thresholds ?? [])],
    };
  });
}

function controllerFor(snapshot, catalogue) {
  const snapshots = new Map([
    [snapshot.learnerId, structuredClone(snapshot)],
  ]);
  return createProductLearningController({
    repository: Object.freeze({
      async runCommandTransaction() {
        throw new Error('unused');
      },
    }),
    snapshotStore: Object.freeze({
      async read(learnerId) {
        return structuredClone(snapshots.get(learnerId));
      },
    }),
    catalogue,
    initialSnapshot: snapshot,
    random: () => 0.25,
    now: () => NOW_MS,
  });
}

test('hatch remaining matches the word list when every hatch-counting word is secure past stage 4', () => {
  const catalogue = loadStarterSpellingCatalogue();
  const y34 = catalogue.items.filter((item) => item.yearBand === '3-4');
  assert.equal(y34.length, 10, 'Starter Years 3–4 is the Inklet hatch pool');

  // Three words sit exactly at the secure stage; the rest have been practised
  // further. The word list treats every stage >= 4 as secure.
  const progress = Object.fromEntries(y34.map((item, index) => [
    item.runtimeItemId,
    { stage: index < 3 ? 4 : 5 },
  ]));
  const progressRows = y34.map((item) => ({
    runtimeItemId: item.runtimeItemId,
    target: item.target,
    yearBand: item.yearBand,
    coverageTier: item.coverageTier,
    stage: progress[item.runtimeItemId].stage,
    attempts: 5,
    correct: 5,
    wrong: 0,
    dueDay: 99_999,
    lastResult: 'correct',
  }));

  const bank = buildWordBank({ progress: progressRows, vocabSet: 'y3-4' });
  assert.equal(bank.rows.length, 10);
  assert.ok(
    bank.rows.every((row) => row.status === 'secure'),
    'the Years 3–4 list must read as all secure',
  );

  const snapshot = structuredClone(expectedB2Snapshot('learner-a'));
  snapshot.subjectState.data.progress = progress;
  snapshot.monsterStateByRewardTrackId = {
    'spelling-core-inklet': {
      rewardTrackId: 'spelling-core-inklet',
      packId: 'ks2-core',
      monsterId: 'inklet',
      branch: 'b1',
      secureCount: 3,
      caught: true,
      derivedStage: 0,
      earnedStageHighWater: 0,
    },
  };

  const a3Inklet = projectSpellingMonsters({
    learnerId: 'learner-a',
    progress,
    rewardTracks: catalogue.rewardTracks,
    items: catalogue.items,
    currentState: snapshot.monsterStateByRewardTrackId,
    random: () => 0.25,
  }).find((monster) => monster.monsterId === 'inklet');
  assert.equal(
    a3Inklet.secureCount,
    3,
    'A3 still counts only stage === 4, which is the dual-counter trap',
  );
  const a3Codex = buildCodex(withTrackThresholds([a3Inklet], catalogue));
  assert.equal(a3Codex.hero.secureCount, 3);
  assert.match(a3Codex.hero.next, /7 more to Inklet/);

  const inklet = controllerFor(snapshot, catalogue)
    .getState()
    .monsters
    .find((monster) => monster.monsterId === 'inklet');
  const hero = buildCodex([inklet]).hero;
  assert.equal(hero.secureCount, 10, 'hatch evidence must match the all-secure list');
  assert.equal(hero.found, true);
  assert.equal(hero.stage, 1, 'catch threshold 10 is met, so Inklet hatches');
  assert.doesNotMatch(
    hero.next,
    /more to Inklet/,
    'child-facing copy must not keep asking for hatch words the list already shows as secure',
  );
});
