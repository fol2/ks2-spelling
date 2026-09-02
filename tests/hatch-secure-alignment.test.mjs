import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  loadFullSpellingCatalogue,
  loadStarterSpellingCatalogue,
  projectSpellingMonsters,
} from '../src/domain/spelling/index.js';
import { buildCodex } from '../src/app/codex-model.js';
import { createProductLearningController } from '../src/app/product-learning-controller.js';
import { monsterBranch } from '../src/app/monster-progress-model.js';
import { starterYearBandIsSecure } from '../src/app/starter-complete-moment.js';
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

function expectedVocabularySets(catalogue) {
  const core = catalogue.items.filter(
    ({ coverageTier }) => coverageTier == null || coverageTier === 'statutory-core',
  );
  return [
    { id: 'core', label: 'Core', count: core.length },
    {
      id: 'y3-4',
      label: 'Y3–4',
      count: core.filter(({ yearBand }) => yearBand === '3-4').length,
    },
    {
      id: 'y5-6',
      label: 'Y5–6',
      count: core.filter(({ yearBand }) => yearBand === '5-6').length,
    },
  ].filter(({ count }) => count > 0);
}

function controllerFor(snapshot, catalogue, publishedCatalogue) {
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
    ...(publishedCatalogue ? { publishedCatalogue } : {}),
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
  assert.equal(hero.stage, 1, 'Starter band threshold 10 is met, so Inklet hatches');
  assert.equal(hero.count, '10 of 100');
  assert.match(hero.next, /20 more to Scribbla/);
  assert.doesNotMatch(
    hero.next,
    /more to Inklet/,
    'child-facing copy must not keep asking for hatch words the list already shows as secure',
  );
});

test('Starter trial: twenty secured words hatch Inklet and Glimmerbug against the published 100-word climb', () => {
  const catalogue = loadStarterSpellingCatalogue();
  const published = loadFullSpellingCatalogue();
  const y34 = catalogue.items.filter((item) => item.yearBand === '3-4');
  const y56 = catalogue.items.filter((item) => item.yearBand === '5-6');
  assert.equal(y34.length, 10);
  assert.equal(y56.length, 10);
  assert.equal(catalogue.items.length, 20);
  assert.equal(
    catalogue.rewardTracks.some((track) => track.monsterId === 'phaeton'),
    false,
    'Starter pack JSON still omits Phaeton as a hatch track',
  );
  const phaetonTrack = published.rewardTracks.find(
    (track) => track.monsterId === 'phaeton',
  );
  assert.deepEqual(phaetonTrack.thresholds, [3, 25, 95, 145, 213]);
  assert.ok(
    catalogue.items.length < phaetonTrack.thresholds[1],
    'Starter 20 cannot fund Aetherwisp at 25',
  );

  // Live iPad split: Years 3–4 all Mega (stage 5), Years 5–6 mixed 4/5.
  // Word Bank reads every row Secure; A3 still counts only stage === 4.
  const progress = Object.fromEntries([
    ...y34.map((item) => [item.runtimeItemId, { stage: 5 }]),
    ...y56.map((item, index) => [item.runtimeItemId, { stage: index < 4 ? 4 : 5 }]),
  ]);
  const progressRows = catalogue.items.map((item) => ({
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

  const bank = buildWordBank({ progress: progressRows, vocabSet: 'core' });
  assert.equal(bank.rows.length, 20);
  assert.ok(bank.rows.every((row) => row.status === 'secure'));

  const snapshot = structuredClone(expectedB2Snapshot('learner-a'));
  snapshot.subjectState.data.progress = progress;
  snapshot.monsterStateByRewardTrackId = {
    'spelling-core-inklet': {
      rewardTrackId: 'spelling-core-inklet',
      packId: 'ks2-core',
      monsterId: 'inklet',
      branch: 'b1',
      secureCount: 0,
      caught: true,
      derivedStage: 0,
      earnedStageHighWater: 0,
    },
    'spelling-core-glimmerbug': {
      rewardTrackId: 'spelling-core-glimmerbug',
      packId: 'ks2-core',
      monsterId: 'glimmerbug',
      branch: 'b1',
      secureCount: 4,
      caught: true,
      derivedStage: 0,
      earnedStageHighWater: 0,
    },
  };

  const a3 = projectSpellingMonsters({
    learnerId: 'learner-a',
    progress,
    rewardTracks: catalogue.rewardTracks,
    items: catalogue.items,
    currentState: snapshot.monsterStateByRewardTrackId,
    random: () => 0.25,
  });
  assert.equal(
    a3.find((monster) => monster.monsterId === 'inklet').secureCount,
    0,
  );
  assert.equal(
    a3.find((monster) => monster.monsterId === 'glimmerbug').secureCount,
    4,
  );
  const a3Codex = buildCodex(withTrackThresholds(a3, catalogue));
  assert.equal(a3Codex.hero.count, '0 of 100');
  assert.match(a3Codex.hero.next, /10 more to Inklet/i);
  const a3Glimmer = buildCodex(
    withTrackThresholds(a3, catalogue),
    'spelling-core-glimmerbug',
  ).hero;
  assert.equal(a3Glimmer.count, '4 of 100');
  assert.match(a3Glimmer.next, /6 more to Glimmerbug/i);

  const state = controllerFor(snapshot, catalogue, published).getState();
  assert.equal(state.revisionMission.missionState, 'locked');
  assert.equal(state.revisionMission.campCreditState, 'unavailable');
  assert.ok(
    starterYearBandIsSecure(state.monsters, catalogue),
    'either Starter band at its own count is the #163 paywall trigger',
  );

  const codex = buildCodex(state.monsters);
  assert.equal(codex.roster.length, 3);
  assert.equal(codex.secureWords, 20);
  const inklet = codex.roster.find((entry) => entry.monsterId === 'inklet');
  const glimmer = codex.roster.find((entry) => entry.monsterId === 'glimmerbug');
  const phaeton = state.monsters.find((monster) => monster.monsterId === 'phaeton');
  const phaetonEntry = codex.roster.find((entry) => entry.monsterId === 'phaeton');
  assert.equal(inklet.stage, 1);
  assert.equal(inklet.title, 'Inklet');
  assert.equal(inklet.count, '10 of 100');
  assert.doesNotMatch(inklet.next, /more to Inklet/i);
  assert.match(inklet.next, /20 more to Scribbla/);
  assert.equal(glimmer.stage, 1);
  assert.equal(glimmer.title, 'Glimmerbug');
  assert.equal(glimmer.count, '10 of 100');
  assert.doesNotMatch(glimmer.next, /more to Glimmerbug/i);
  assert.equal(phaeton.secureCount, 20);
  assert.equal(phaeton.derivedStage, 0, 'twenty Starter words cannot reach Aetherwisp');
  assert.deepEqual(phaeton.thresholds, [3, 25, 95, 145, 213]);
  assert.equal(phaeton.branch, null);
  assert.equal(monsterBranch(phaeton), 'b1');
  assert.equal(phaetonEntry.branch, null);
  assert.equal(phaetonEntry.found, false);
  assert.equal(phaetonEntry.discovered, true);
  assert.equal(phaetonEntry.stage, 0);
  assert.equal(phaetonEntry.title, '???');
});

test('Full catalogue Inklet still uses the published 100-word growth line', () => {
  const catalogue = loadFullSpellingCatalogue();
  const y34 = catalogue.items.filter((item) => item.yearBand === '3-4').slice(0, 10);
  const progress = Object.fromEntries(y34.map((item) => [item.runtimeItemId, { stage: 5 }]));
  const snapshot = structuredClone(expectedB2Snapshot('learner-a'));
  snapshot.catalogueId = catalogue.catalogueId;
  snapshot.grantedEntitlementIds = [...catalogue.entitlementIds];
  snapshot.subjectState.data.progress = progress;
  snapshot.monsterStateByRewardTrackId = {
    'spelling-core-inklet': {
      rewardTrackId: 'spelling-core-inklet',
      packId: 'ks2-core',
      monsterId: 'inklet',
      branch: 'b1',
      secureCount: 10,
      caught: true,
      derivedStage: 1,
      earnedStageHighWater: 1,
    },
  };

  const inklet = controllerFor(snapshot, catalogue)
    .getState()
    .monsters
    .find((monster) => monster.monsterId === 'inklet');
  assert.deepEqual(inklet.thresholds, [1, 10, 30, 60, 100]);
  const hero = buildCodex([inklet]).hero;
  assert.equal(hero.secureCount, 10);
  assert.equal(hero.stage, 1);
  assert.equal(hero.count, '10 of 100');
  assert.match(hero.next, /20 more to Scribbla/);
});

test('trial Camp and word bank use the published full catalogue as the destination', () => {
  const starter = loadStarterSpellingCatalogue();
  const published = loadFullSpellingCatalogue();
  const publishedCoreCount = published.items.filter((item) => (
    item.coverageTier == null || item.coverageTier === 'statutory-core'
  )).length;
  assert.ok(publishedCoreCount > starter.items.length);

  const y34 = starter.items.filter((item) => item.yearBand === '3-4');
  const progress = Object.fromEntries(y34.map((item) => [
    item.runtimeItemId,
    { stage: 5 },
  ]));
  const snapshot = structuredClone(expectedB2Snapshot('learner-a'));
  snapshot.subjectState.data.progress = progress;

  const state = controllerFor(snapshot, starter, published).getState();
  assert.equal(state.packSize, published.items.length);
  assert.equal(state.progress.length, published.items.length);
  assert.deepEqual(state.vocabularySets, expectedVocabularySets(starter));
  assert.notDeepEqual(
    state.vocabularySets,
    expectedVocabularySets(published),
    'Setup must not advertise Full pools that a trial round cannot draw',
  );
  assert.equal(
    state.progress.filter((row) => row.locked === true).length,
    published.items.length - starter.items.length,
  );
  assert.ok(state.progress.every((row) => (
    starter.items.some((item) => item.runtimeItemId === row.runtimeItemId)
      ? row.locked !== true
      : row.locked === true
  )));

  const bank = buildWordBank({
    progress: state.progress,
    vocabularySets: state.vocabularySets,
    vocabSet: 'core',
  });
  assert.equal(bank.total, publishedCoreCount);
  assert.equal(bank.setTotal, publishedCoreCount);
  assert.ok(
    bank.rows.some((row) => row.locked === true),
    'unpurchased words stay in the list as locked rows',
  );
  assert.ok(
    bank.rows.every((row) => row.locked !== true || row.status === 'locked'),
  );

  const inklet = state.monsters.find((monster) => monster.monsterId === 'inklet');
  assert.equal(inklet.secureCount, 10);
  assert.equal(inklet.derivedStage, 1);
  assert.deepEqual(inklet.thresholds, [1, 10, 30, 60, 100]);
  assert.equal(buildCodex([inklet]).hero.count, '10 of 100');
  const phaeton = state.monsters.find((monster) => monster.monsterId === 'phaeton');
  assert.equal(phaeton.monsterId, 'phaeton');
  assert.equal(phaeton.secureCount, 10);
  assert.equal(phaeton.derivedStage, 0);
  assert.deepEqual(phaeton.thresholds, [3, 25, 95, 145, 213]);
  const phaetonEntry = buildCodex(state.monsters, 'spelling-core-phaeton').hero;
  assert.equal(phaetonEntry.found, false);
  assert.equal(phaetonEntry.discovered, true);
  assert.equal(phaetonEntry.stage, 0);
  assert.equal(phaetonEntry.title, '???');
  assert.equal(monsterBranch(phaeton), 'b1');
});

test('Setup vocabulary sets project the installed catalogue, not the published destination', async () => {
  const source = await readFile(
    new URL('../src/app/product-learning-controller.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /vocabularySets: vocabularySetsProjection\(catalogue\)/);
  assert.doesNotMatch(
    source,
    /vocabularySets: vocabularySetsProjection\(displayCatalogue\)/,
  );
  assert.match(source, /monsters: monsterProjection\(snapshot, displayCatalogue\)/);
  assert.doesNotMatch(
    source,
    /monsters: monsterProjection\(snapshot, catalogue\)/,
  );
});
