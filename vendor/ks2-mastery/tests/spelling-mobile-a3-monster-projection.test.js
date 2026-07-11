import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  applySpellingCommand,
  projectSpellingMonsters,
} from '../shared/spelling/mobile/a3/index.js';

const fullCatalogue = JSON.parse(await readFile(
  new URL('../content/spelling.mobile-runtime-full.json', import.meta.url),
  'utf8',
));
const starterCatalogue = JSON.parse(await readFile(
  new URL('../content/spelling.mobile-runtime-starter.json', import.meta.url),
  'utf8',
));

const NOW = 1_768_478_400_000;
const DIRECT_BOUNDARIES = new Map([
  [0, [false, 0]], [1, [true, 0]], [9, [true, 0]], [10, [true, 1]],
  [29, [true, 1]], [30, [true, 2]], [59, [true, 2]], [60, [true, 3]],
  [99, [true, 3]], [100, [true, 4]],
]);
const PHAETON_BOUNDARIES = new Map([
  [0, [false, 0]], [2, [false, 0]], [3, [true, 0]], [24, [true, 0]],
  [25, [true, 1]], [94, [true, 1]], [95, [true, 2]], [144, [true, 2]],
  [145, [true, 3]], [212, [true, 3]], [213, [true, 4]],
]);

function securedProgress(catalogue, count, predicate = () => true) {
  return Object.fromEntries(catalogue.items.filter(predicate).slice(0, count).map((item) => [
    item.runtimeItemId,
    {
      legacySlug: item.legacySlug,
      stage: 4,
      attempts: 4,
      correct: 4,
      wrong: 0,
      dueDay: 20_000,
      lastDay: 19_993,
      lastResult: 'correct',
    },
  ]));
}

function project({ catalogue = fullCatalogue, progress = {}, currentState = {}, random = () => 0 } = {}) {
  return projectSpellingMonsters({
    learnerId: 'learner-a',
    progress,
    rewardTracks: catalogue.rewardTracks,
    items: catalogue.items,
    currentState,
    random,
  });
}

function byTrack(result, rewardTrackId) {
  return result.find((entry) => entry.rewardTrackId === rewardTrackId);
}

function snapshot(catalogue = fullCatalogue) {
  return {
    schemaVersion: 1,
    learnerId: 'learner-a',
    revision: 0,
    packId: catalogue.packId,
    catalogueId: catalogue.catalogueId,
    grantedEntitlementIds: catalogue.catalogueId.endsWith(':full') ? ['full-ks2'] : [],
    subjectState: {
      ui: {},
      data: {
        prefs: { autoSpeak: false },
        progress: {},
        guardianMap: {},
        pattern: { wobblingByRuntimeItemId: {} },
        postMega: null,
        achievements: {},
        persistenceWarning: null,
      },
    },
    practiceSession: null,
    eventLog: [],
    monsterStateByRewardTrackId: {},
    campStateByPackId: {},
  };
}

function advance(current, plan) {
  return {
    ...current,
    revision: plan.nextRevision,
    subjectState: plan.nextSubjectState,
    practiceSession: plan.nextPracticeSession,
    eventLog: plan.nextEventLog,
    monsterStateByRewardTrackId: plan.nextMonsterStateByRewardTrackId,
    campStateByPackId: plan.nextCampStateByPackId,
  };
}

function randomFrom(seed = 42) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let result = Math.imul(value ^ (value >>> 15), 1 | value);
    result ^= result + Math.imul(result ^ (result >>> 7), 61 | result);
    return ((result ^ (result >>> 14)) >>> 0) / 4_294_967_296;
  };
}

test('direct Monster tracks use unique stage-4 catalogue evidence at every frozen boundary', () => {
  for (const [count, [caught, derivedStage]] of DIRECT_BOUNDARIES) {
    const progress = securedProgress(fullCatalogue, count, (item) => item.yearBand === '3-4');
    const result = project({ progress, random: () => 0.1 });
    assert.deepEqual(byTrack(result, 'spelling-core-inklet'), {
      rewardTrackId: 'spelling-core-inklet',
      packId: 'ks2-core',
      monsterId: 'inklet',
      branch: 'b1',
      secureCount: count,
      caught,
      derivedStage,
      earnedStageHighWater: derivedStage,
    }, `Inklet boundary ${count}`);
  }

  const item = fullCatalogue.items.find(({ yearBand }) => yearBand === '3-4');
  const progress = {
    [item.runtimeItemId]: { legacySlug: item.legacySlug, stage: 4 },
    'ks2-core:not-in-catalogue': { legacySlug: item.legacySlug, stage: 4 },
  };
  assert.equal(byTrack(project({ progress }), 'spelling-core-inklet').secureCount, 1);
});

test('Phaeton recursively aggregates unique direct evidence at every frozen boundary', () => {
  for (const [count, [caught, derivedStage]] of PHAETON_BOUNDARIES) {
    const progress = securedProgress(fullCatalogue, count);
    const phaeton = byTrack(project({ progress, random: () => 0.75 }), 'spelling-core-phaeton');
    assert.deepEqual(phaeton, {
      rewardTrackId: 'spelling-core-phaeton',
      packId: 'ks2-core',
      monsterId: 'phaeton',
      branch: 'b2',
      secureCount: count,
      caught,
      derivedStage,
      earnedStageHighWater: derivedStage,
    }, `Phaeton boundary ${count}`);
  }
});

test('Starter exposes only Inklet, cannot reach milestone 30 and upgrades without resetting Inklet', () => {
  const starterProgress = securedProgress(starterCatalogue, starterCatalogue.items.length);
  const starterInklet = project({ catalogue: starterCatalogue, progress: starterProgress, random: () => 0.75 })[0];
  assert.equal(project({ catalogue: starterCatalogue }).length, 1);
  assert.equal(starterInklet.rewardTrackId, 'spelling-core-inklet');
  assert.equal(starterInklet.secureCount, 20);
  assert.equal(starterInklet.derivedStage, 1);

  let randomCalls = 0;
  const full = project({
    progress: starterProgress,
    currentState: { 'spelling-core-inklet': starterInklet },
    random: () => { randomCalls += 1; return 0.25; },
  });
  assert.deepEqual(full.map(({ rewardTrackId }) => rewardTrackId), [
    'spelling-core-inklet', 'spelling-core-glimmerbug', 'spelling-core-phaeton',
  ]);
  assert.deepEqual(full[0], starterInklet);
  assert.equal(randomCalls, 2, 'Only the two newly installed Full tracks select branches.');
  assert.equal(full.some(({ monsterId }) => ['vellhorn', 'extra'].includes(monsterId)), false);
});

test('aggregate graphs reject missing sources, cycles, duplicate tracks and duplicate item evidence', () => {
  const direct = structuredClone(fullCatalogue.rewardTracks[0]);
  const aggregate = structuredClone(fullCatalogue.rewardTracks[2]);
  assert.throws(
    () => project({ catalogue: { ...fullCatalogue, rewardTracks: [direct, { ...aggregate, sourceRewardTrackIds: ['missing'] }] } }),
    /missing source reward track/i,
  );
  assert.throws(
    () => project({ catalogue: { ...fullCatalogue, rewardTracks: [
      { ...direct, sourceRewardTrackIds: [aggregate.rewardTrackId], yearBand: undefined },
      { ...aggregate, sourceRewardTrackIds: [direct.rewardTrackId] },
    ] } }),
    /cycle/i,
  );
  assert.throws(
    () => project({ catalogue: { ...fullCatalogue, rewardTracks: [direct, structuredClone(direct)] } }),
    /duplicate reward track/i,
  );
  assert.throws(
    () => project({ catalogue: { ...fullCatalogue, items: [fullCatalogue.items[0], structuredClone(fullCatalogue.items[0])] } }),
    /duplicate catalogue item/i,
  );
});

test('public projection rejects mixed packs, malformed or foreign item identities and undeclared current state', () => {
  const foreignTrack = {
    ...structuredClone(fullCatalogue.rewardTracks[1]),
    rewardTrackId: 'foreign-glimmerbug',
    packId: 'foreign-pack',
  };
  assert.throws(
    () => project({ catalogue: { ...fullCatalogue, rewardTracks: [fullCatalogue.rewardTracks[0], foreignTrack] } }),
    /same pack/i,
  );

  const malformedRuntime = structuredClone(fullCatalogue.items);
  malformedRuntime[0].runtimeItemId = 'not-a-runtime-id';
  assert.throws(
    () => project({ catalogue: { ...fullCatalogue, items: malformedRuntime } }),
    /runtime item|identity/i,
  );

  const foreignPack = structuredClone(fullCatalogue.items);
  foreignPack[0].packId = 'foreign-pack';
  assert.throws(
    () => project({ catalogue: { ...fullCatalogue, items: foreignPack } }),
    /pack/i,
  );

  const foreignRuntime = structuredClone(fullCatalogue.items);
  foreignRuntime[0].runtimeItemId = `foreign-pack:${foreignRuntime[0].itemId}`;
  foreignRuntime[0].packId = 'foreign-pack';
  assert.throws(
    () => project({ catalogue: { ...fullCatalogue, items: foreignRuntime } }),
    /pack/i,
  );

  const mismatchedItemId = structuredClone(fullCatalogue.items);
  mismatchedItemId[0].itemId = 'different-item';
  assert.throws(
    () => project({ catalogue: { ...fullCatalogue, items: mismatchedItemId } }),
    /identity/i,
  );

  const malformedYearBand = structuredClone(fullCatalogue.items);
  malformedYearBand[0].yearBand = '';
  assert.throws(
    () => project({ catalogue: { ...fullCatalogue, items: malformedYearBand } }),
    /yearBand/i,
  );

  assert.throws(
    () => project({ currentState: { 'spelling-extra-vellhorn': {
      rewardTrackId: 'spelling-extra-vellhorn', packId: 'ks2-core', monsterId: 'vellhorn',
      branch: 'b1', secureCount: 0, caught: false, derivedStage: 0, earnedStageHighWater: 0,
    } } }),
    /undeclared.*current|current.*undeclared/i,
  );
});

test('branches are selected once while caught and earned high-water never regress after contraction', () => {
  const previous = {
    rewardTrackId: 'spelling-core-inklet',
    packId: 'ks2-core',
    monsterId: 'inklet',
    branch: 'b2',
    secureCount: 100,
    caught: true,
    derivedStage: 4,
    earnedStageHighWater: 4,
  };
  let randomCalls = 0;
  const contracted = byTrack(project({
    progress: securedProgress(fullCatalogue, 1, (item) => item.yearBand === '3-4'),
    currentState: { 'spelling-core-inklet': previous },
    random: () => { randomCalls += 1; return 0; },
  }), 'spelling-core-inklet');
  assert.equal(contracted.branch, 'b2');
  assert.equal(contracted.secureCount, 1);
  assert.equal(contracted.derivedStage, 0);
  assert.equal(contracted.earnedStageHighWater, 4);
  assert.equal(contracted.caught, true);
  assert.equal(randomCalls, 2, 'Only the two newly declared Full tracks select branches.');

  randomCalls = 0;
  const initialised = project({ random: () => { randomCalls += 1; return 0.999; } });
  assert.equal(randomCalls, 3);
  assert.ok(initialised.every(({ branch }) => branch === 'b2'));
});

test('changed non-learning plans defer first projection, while no-change plans byte-copy state without randomness', () => {
  const current = snapshot();
  let randomCalls = 0;
  const changed = applySpellingCommand({
    snapshot: current,
    command: { type: 'save-prefs', payload: { prefs: { autoSpeak: true } } },
    contentSnapshot: fullCatalogue,
    now: () => NOW,
    random: () => { randomCalls += 1; return 0.25; },
  });
  assert.equal(changed.changed, true);
  assert.equal(randomCalls, 0);
  assert.deepEqual(changed.projections.monsters, []);
  assert.deepEqual(changed.nextMonsterStateByRewardTrackId, current.monsterStateByRewardTrackId);
  assert.deepEqual(changed.nextCampStateByPackId, current.campStateByPackId);

  const stable = {
    ...current,
    monsterStateByRewardTrackId: structuredClone(changed.nextMonsterStateByRewardTrackId),
  };
  const beforeBytes = JSON.stringify(stable.monsterStateByRewardTrackId);
  randomCalls = 0;
  const unchanged = applySpellingCommand({
    snapshot: stable,
    command: { type: 'acknowledge-persistence-warning', payload: {} },
    contentSnapshot: fullCatalogue,
    now: () => NOW,
    random: () => { randomCalls += 1; return 0.75; },
  });
  assert.equal(unchanged.changed, false);
  assert.equal(JSON.stringify(unchanged.nextMonsterStateByRewardTrackId), beforeBytes);
  assert.equal(randomCalls, 0);
});

test('changed plans with complete branches reproject Monsters without consuming randomness', () => {
  const current = snapshot();
  current.subjectState.data.progress = securedProgress(fullCatalogue, 30);
  current.monsterStateByRewardTrackId = Object.fromEntries(project({
    progress: current.subjectState.data.progress,
    random: () => 0.25,
  }).map((entry) => [entry.rewardTrackId, entry]));
  const plan = applySpellingCommand({
    snapshot: current,
    command: { type: 'save-prefs', payload: { prefs: { autoSpeak: true } } },
    contentSnapshot: fullCatalogue,
    now: () => NOW,
    random: () => { throw new Error('Complete branches must not draw randomness.'); },
  });
  assert.deepEqual(plan.projections.monsters, Object.values(plan.nextMonsterStateByRewardTrackId));
  assert.deepEqual(plan.nextMonsterStateByRewardTrackId, current.monsterStateByRewardTrackId);
});

test('non-learning mutations defer Monster initialisation without perturbing the next seeded A1 session', () => {
  const startCommand = {
    type: 'start-session',
    payload: { mode: 'test', yearFilter: 'core', length: 20, practiceOnly: false, words: [] },
  };

  const baselinePrefs = snapshot();
  baselinePrefs.subjectState.data.prefs.autoSpeak = true;
  const baselinePrefsPlan = applySpellingCommand({
    snapshot: baselinePrefs,
    command: startCommand,
    contentSnapshot: fullCatalogue,
    now: () => NOW,
    random: randomFrom(77),
  });
  let prefsRandomCalls = 0;
  const prefsRandom = randomFrom(77);
  const countPrefsRandom = () => { prefsRandomCalls += 1; return prefsRandom(); };
  let afterPrefs = snapshot();
  const savePrefs = applySpellingCommand({
    snapshot: afterPrefs,
    command: { type: 'save-prefs', payload: { prefs: { autoSpeak: true } } },
    contentSnapshot: fullCatalogue,
    now: () => NOW,
    random: countPrefsRandom,
  });
  assert.equal(prefsRandomCalls, 0);
  assert.deepEqual(savePrefs.nextMonsterStateByRewardTrackId, {});
  afterPrefs = advance(afterPrefs, savePrefs);
  const afterPrefsStart = applySpellingCommand({
    snapshot: afterPrefs,
    command: startCommand,
    contentSnapshot: fullCatalogue,
    now: () => NOW,
    random: countPrefsRandom,
  });
  assert.deepEqual(afterPrefsStart.result.state.session, baselinePrefsPlan.result.state.session);
  assert.equal(Object.keys(afterPrefsStart.nextMonsterStateByRewardTrackId).length, 3);

  const baselineWarning = snapshot();
  baselineWarning.subjectState.data.persistenceWarning = {
    reason: 'storage-save-failed', occurredAt: 1, acknowledged: true,
  };
  const baselineWarningPlan = applySpellingCommand({
    snapshot: baselineWarning,
    command: startCommand,
    contentSnapshot: fullCatalogue,
    now: () => NOW,
    random: randomFrom(91),
  });
  let warningRandomCalls = 0;
  const warningRandom = randomFrom(91);
  const countWarningRandom = () => { warningRandomCalls += 1; return warningRandom(); };
  let afterWarning = snapshot();
  afterWarning.subjectState.data.persistenceWarning = {
    reason: 'storage-save-failed', occurredAt: 1, acknowledged: false,
  };
  const acknowledge = applySpellingCommand({
    snapshot: afterWarning,
    command: { type: 'acknowledge-persistence-warning', payload: {} },
    contentSnapshot: fullCatalogue,
    now: () => NOW,
    random: countWarningRandom,
  });
  assert.equal(warningRandomCalls, 0);
  assert.deepEqual(acknowledge.nextMonsterStateByRewardTrackId, {});
  afterWarning = advance(afterWarning, acknowledge);
  const afterWarningStart = applySpellingCommand({
    snapshot: afterWarning,
    command: startCommand,
    contentSnapshot: fullCatalogue,
    now: () => NOW,
    random: countWarningRandom,
  });
  assert.deepEqual(afterWarningStart.result.state.session, baselineWarningPlan.result.state.session);
  assert.equal(Object.keys(afterWarningStart.nextMonsterStateByRewardTrackId).length, 3);
});

test('Guardian wrong answers and later contraction cannot reduce earned Monster high-water', () => {
  const current = snapshot();
  current.subjectState.data.progress = securedProgress(fullCatalogue, fullCatalogue.items.length);
  current.subjectState.data.postMega = {
    unlockedAt: NOW - 86_400_000,
    unlockedContentReleaseId: 'spelling-r7',
    unlockedPublishedCoreCount: fullCatalogue.items.length,
    unlockedBy: 'all-core-stage-4',
  };
  current.subjectState.data.guardianMap['ks2-core:answer'] = {
    legacySlug: 'answer', reviewLevel: 2, nextDueDay: Math.floor(NOW / 86_400_000),
    lastReviewedDay: Math.floor(NOW / 86_400_000) - 1, streak: 0, lapses: 1,
    renewals: 0, wobbling: true,
  };
  current.monsterStateByRewardTrackId = Object.fromEntries(
    project({ progress: current.subjectState.data.progress, random: () => 0.25 })
      .map((entry) => [entry.rewardTrackId, entry]),
  );

  const start = applySpellingCommand({
    snapshot: current,
    command: { type: 'start-session', payload: { mode: 'guardian', yearFilter: 'core', length: 1, practiceOnly: false, words: [] } },
    contentSnapshot: fullCatalogue,
    now: () => NOW,
    random: () => 0.25,
  });
  const active = {
    ...current,
    revision: start.nextRevision,
    subjectState: start.nextSubjectState,
    practiceSession: start.nextPracticeSession,
    eventLog: start.nextEventLog,
    monsterStateByRewardTrackId: start.nextMonsterStateByRewardTrackId,
  };
  const wrong = applySpellingCommand({
    snapshot: active,
    command: { type: 'submit-answer', payload: { typed: 'wrong' } },
    contentSnapshot: fullCatalogue,
    now: () => NOW,
    random: () => 0.25,
  });
  assert.equal(wrong.nextMonsterStateByRewardTrackId['spelling-core-phaeton'].earnedStageHighWater, 4);

  const contracted = project({
    progress: securedProgress(fullCatalogue, 2),
    currentState: wrong.nextMonsterStateByRewardTrackId,
    random: () => { throw new Error('All Full branches already exist.'); },
  });
  assert.ok(contracted.every(({ earnedStageHighWater }) => earnedStageHighWater === 4));
});
