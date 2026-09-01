import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadFullSpellingCatalogue,
  loadStarterSpellingCatalogue,
  validateSpellingCommandSnapshotV1,
} from '../src/domain/spelling/index.js';
import { createProductLearningController } from '../src/app/product-learning-controller.js';
import { setupExpeditionCompanion } from '../src/app/codex-model.js';
import {
  expectedB2Snapshot,
  snapshotAfterPlan,
} from './helpers/b2-database-harness.mjs';
import { expectedGuardianSnapshot } from './helpers/guardian-fixture.mjs';

const NOW_MS = 1_768_478_400_000;

function createLearningWorld(
  initialSnapshots = [expectedB2Snapshot('learner-a')],
  catalogue = loadStarterSpellingCatalogue(),
) {
  const snapshots = new Map(
    initialSnapshots.map((snapshot) => [
      snapshot.learnerId,
      structuredClone(snapshot),
    ]),
  );
  let tick = 0;
  const snapshotStore = Object.freeze({
    async read(learnerId) {
      const snapshot = snapshots.get(learnerId);
      if (!snapshot) throw new Error('unknown_test_learner');
      return structuredClone(snapshot);
    },
  });
  const repository = Object.freeze({
    async runCommandTransaction(learnerId, planner) {
      const snapshot = snapshots.get(learnerId);
      if (!snapshot) throw new Error('unknown_test_learner');
      const nowMs = NOW_MS + tick;
      tick += 1;
      const plan = await planner(
        structuredClone(snapshot),
        Object.freeze({ nowMs, todayGuardianDay: 20_468 }),
      );
      snapshots.set(learnerId, snapshotAfterPlan(snapshot, plan));
      return structuredClone(plan);
    },
  });
  return Object.freeze({
    catalogue,
    snapshots,
    transactionCount: () => tick,
    createController(initialSnapshot = initialSnapshots[0] ?? null, options = {}) {
      return createProductLearningController({
        repository,
        snapshotStore,
        catalogue,
        initialSnapshot,
        random: () => 0.25,
        now: () => NOW_MS,
        ...options,
      });
    },
  });
}

function targetFor(controller, catalogue) {
  const runtimeItemId = controller.getState().practice?.runtimeItemId;
  const item = catalogue.items.find(
    (candidate) => candidate.runtimeItemId === runtimeItemId,
  );
  assert.ok(item, 'the practice projection must identify a catalogue item');
  return item.target;
}

function snapshotForCatalogue(catalogue) {
  const snapshot = structuredClone(expectedB2Snapshot('learner-a'));
  snapshot.catalogueId = catalogue.catalogueId;
  snapshot.grantedEntitlementIds = [...catalogue.entitlementIds];
  return validateSpellingCommandSnapshotV1(snapshot, catalogue);
}

function unseenProgress(catalogue) {
  return catalogue.items.map(({ runtimeItemId, target, yearBand, coverageTier }) => ({
    runtimeItemId,
    target,
    yearBand: yearBand ?? null,
    coverageTier: coverageTier ?? null,
    stage: 0,
    attempts: 0,
    correct: 0,
    wrong: 0,
    dueDay: null,
    lastResult: null,
    locked: false,
  }));
}

test('product learning starts a durable Smart Review and restores an interrupted round', async () => {
  const world = createLearningWorld();
  const first = world.createController();

  assert.deepEqual(first.getState(), {
    status: 'ready',
    screen: 'home',
    learnerId: 'learner-a',
    practice: null,
    prefs: { voiceId: 'Iapetus', showCloze: true, autoSpeak: true },
    summary: null,
    progress: unseenProgress(world.catalogue),
    // Without publishedCatalogue the installed starter is the destination.
    packSize: 20,
    vocabularySets: [
      { id: 'core', label: 'Core', count: 20 },
      { id: 'y3-4', label: 'Y3–4', count: 10 },
      { id: 'y5-6', label: 'Y5–6', count: 10 },
    ],
    monsters: [{
      rewardTrackId: 'spelling-core-inklet',
      packId: 'ks2-core',
      monsterId: 'inklet',
      thresholds: [1, 10, 30, 60, 100],
      branch: null,
      secureCount: 0,
      caught: false,
      derivedStage: 0,
      earnedStageHighWater: 0,
    }, {
      rewardTrackId: 'spelling-core-glimmerbug',
      packId: 'ks2-core',
      monsterId: 'glimmerbug',
      thresholds: [1, 10, 30, 60, 100],
      branch: null,
      secureCount: 0,
      caught: false,
      derivedStage: 0,
      earnedStageHighWater: 0,
    }],
    revisionMission: {
      missionState: 'locked',
      eligibleMissionKind: null,
      guardianDueCount: 0,
      wobblingDueCount: 0,
      nextGuardianDueDay: null,
      todayGuardianDay: 20_468,
      canStartRewardBearing: false,
      canContinueUnrewarded: false,
      campCreditState: 'unavailable',
    },
    camp: {
      packId: 'ks2-core',
      campHighWater: 0,
      lastCreditedGuardianDay: null,
      canEarnToday: false,
    },
    roundBaseline: null,
    starterCompleteMomentPresented: false,
    achievements: [],
    records: { milestones: [] },
    actionError: null,
  });

  first.showScreen('setup');
  assert.equal(first.getState().screen, 'setup');
  await first.startRound({ mode: 'smart', length: 5, yearFilter: 'core' });

  const active = first.getState();
  assert.equal(active.status, 'ready');
  assert.equal(active.screen, 'practice');
  assert.equal(active.practice.label, 'Smart review');
  assert.equal(active.practice.mode, 'smart');
  assert.equal(active.practice.fallbackToSmart, false);
  assert.equal(active.practice.progress.total, 5);
  assert.equal(active.practice.progress.checked, 0);
  assert.equal(typeof active.practice.runtimeItemId, 'string');
  assert.equal(typeof active.practice.sentence, 'string');
  assert.equal(Object.hasOwn(active.practice, 'target'), false);
  assert.equal(world.snapshots.get('learner-a').practiceSession.status, 'active');

  const restored = world.createController(
    await Object.freeze({
      read: async () => structuredClone(world.snapshots.get('learner-a')),
    }).read(),
  );
  assert.equal(restored.getState().screen, 'practice');
  assert.equal(
    restored.getState().practice.sessionId,
    active.practice.sessionId,
  );
  assert.equal(
    restored.getState().practice.runtimeItemId,
    active.practice.runtimeItemId,
  );

  await first.dispose();
  await restored.dispose();
});

test('product learning publishes no post-commit notification when its transaction fails', async () => {
  const world = createLearningWorld();
  const notifications = [];
  const controller = world.createController(undefined, {
    repository: Object.freeze({
      async runCommandTransaction() {
        throw new Error('transaction failed');
      },
    }),
    async onCommandCommitted(learnerId) {
      notifications.push(learnerId);
    },
  });

  await assert.rejects(
    controller.startRound({ mode: 'smart', length: 5, yearFilter: 'core' }),
    /transaction failed/,
  );
  assert.deepEqual(notifications, []);
  await controller.dispose();
});

test('product learning keeps a committed local command successful when its post-commit notification fails', async () => {
  const world = createLearningWorld();
  const notifications = [];
  const controller = world.createController(undefined, {
    async onCommandCommitted(learnerId) {
      notifications.push(learnerId);
      throw new Error('replica unavailable');
    },
  });

  await controller.startRound({ mode: 'smart', length: 5, yearFilter: 'core' });
  assert.deepEqual(notifications, ['learner-a']);
  assert.equal(world.snapshots.get('learner-a').revision, 1);
  assert.equal(controller.getState().screen, 'practice');
  assert.equal(controller.getState().actionError, null);
  await controller.dispose();
});

test('product learning leaves Saving and shows feedback while replica publication is still pending', async () => {
  const world = createLearningWorld();
  const controller = world.createController(undefined, {
    onCommandCommitted() {
      return new Promise(() => {});
    },
  });

  const settlesWithin = async (promise) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('learning command remained inside Saving')),
            2_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  await settlesWithin(
    controller.startRound({ mode: 'smart', length: 5, yearFilter: 'core' }),
  );
  await settlesWithin(
    controller.submitAnswer(targetFor(controller, world.catalogue)),
  );

  const state = controller.getState();
  assert.equal(state.status, 'ready');
  assert.equal(state.screen, 'practice');
  assert.equal(state.practice.awaitingAdvance, true);
  assert.ok(state.practice.feedback);
  assert.equal(state.actionError, null);
  await controller.dispose();
});

test('product learning leaves Saving on the Full catalogue while replica publication is still pending', async () => {
  const catalogue = loadFullSpellingCatalogue();
  const world = createLearningWorld(
    [snapshotForCatalogue(catalogue)],
    catalogue,
  );
  const controller = world.createController(undefined, {
    publishedCatalogue: catalogue,
    onCommandCommitted() {
      return new Promise(() => {});
    },
  });

  const settlesWithin = async (promise) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Full-catalogue learning command remained inside Saving')),
            2_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  await settlesWithin(
    controller.startRound({ mode: 'smart', length: 5, yearFilter: 'core' }),
  );
  await settlesWithin(
    controller.submitAnswer(targetFor(controller, catalogue)),
  );
  await settlesWithin(controller.continueRound());

  const state = controller.getState();
  assert.equal(state.status, 'ready');
  assert.equal(state.screen, 'practice');
  assert.equal(state.packSize, 213);
  assert.equal(state.actionError, null);
  await controller.dispose();
});

function savingSpanMs(controller, operation) {
  let entered = null;
  const unsubscribe = controller.subscribe((state) => {
    if (state.status === 'saving' && entered === null) entered = performance.now();
  });
  return operation().then(() => {
    unsubscribe.remove();
    const state = controller.getState();
    assert.equal(state.status, 'ready');
    assert.notEqual(entered, null);
    return performance.now() - entered;
  });
}

test('Full-catalogue answer Saving stays in the same league as Starter and does not wait for iCloud', async () => {
  async function timeSubmit(catalogue, onCommandCommitted = null) {
    const world = createLearningWorld(
      [snapshotForCatalogue(catalogue)],
      catalogue,
    );
    const controller = world.createController(undefined, {
      publishedCatalogue: catalogue,
      onCommandCommitted,
    });
    await controller.startRound({ mode: 'smart', length: 5, yearFilter: 'core' });
    const submitMs = await savingSpanMs(
      controller,
      () => controller.submitAnswer(targetFor(controller, catalogue)),
    );
    const continueMs = await savingSpanMs(
      controller,
      () => controller.continueRound(),
    );
    await controller.dispose();
    return { submitMs, continueMs };
  }

  const starter = await timeSubmit(loadStarterSpellingCatalogue());
  const full = await timeSubmit(loadFullSpellingCatalogue(), () => new Promise(() => {}));
  const ceiling = (starterMs) => Math.max(80, starterMs * 4);
  assert.ok(
    full.submitMs <= ceiling(starter.submitMs),
    `Full submit Saving lasted ${full.submitMs.toFixed(1)}ms vs Starter ${starter.submitMs.toFixed(1)}ms`,
  );
  assert.ok(
    full.continueMs <= ceiling(starter.continueMs),
    `Full continue Saving lasted ${full.continueMs.toFixed(1)}ms vs Starter ${starter.continueMs.toFixed(1)}ms`,
  );
});

test('product learning marks local commit before publishing answer feedback', async (t) => {
  performance.clearMarks('product:local-commit');
  performance.clearMarks('product:feedback-published');
  t.after(() => {
    performance.clearMarks('product:local-commit');
    performance.clearMarks('product:feedback-published');
  });
  const world = createLearningWorld();
  const controller = world.createController();
  await controller.startRound({ mode: 'smart', length: 5, yearFilter: 'core' });
  performance.clearMarks('product:local-commit');
  performance.clearMarks('product:feedback-published');

  await controller.submitAnswer(targetFor(controller, world.catalogue));

  const committed = performance.getEntriesByName('product:local-commit');
  const feedback = performance.getEntriesByName('product:feedback-published');
  assert.equal(committed.length, 1);
  assert.equal(feedback.length, 1);
  assert.ok(committed[0].startTime <= feedback[0].startTime);
  assert.deepEqual(
    performance.getEntriesByType('mark')
      .filter(({ name }) => name.startsWith('product:'))
      .map(({ name }) => name),
    ['product:local-commit', 'product:feedback-published'],
  );
  await controller.dispose();
});

test('product learning requires a clock function', () => {
  const world = createLearningWorld();
  assert.throws(
    () => world.createController(undefined, { now: null }),
    /now.*function/i,
  );
});

test('product learning publishes only non-empty catalogue pools and draws from the selected year band', async () => {
  const catalogue = await loadFullSpellingCatalogue();
  const world = createLearningWorld(
    [snapshotForCatalogue(catalogue)],
    catalogue,
  );
  const controller = world.createController();

  assert.deepEqual(controller.getState().vocabularySets, [
    { id: 'core', label: 'Core', count: 213 },
    { id: 'y3-4', label: 'Y3–4', count: 109 },
    { id: 'y5-6', label: 'Y5–6', count: 104 },
  ]);
  assert.equal(controller.getState().progress.length, 213);
  assert.ok(
    controller.getState().progress.every(
      ({ attempts, dueDay, lastResult }) =>
        attempts === 0 && dueDay === null && lastResult === null,
    ),
  );

  await controller.startRound({
    mode: 'smart',
    length: 5,
    yearFilter: 'y5-6',
  });
  const runtimeItemId = controller.getState().practice.runtimeItemId;
  assert.equal(
    catalogue.items.find((item) => item.runtimeItemId === runtimeItemId)?.yearBand,
    '5-6',
  );

  await controller.dispose();
});

test('trial Setup vocabulary sets stay on the installed catalogue when Full is only the destination', async () => {
  const starter = loadStarterSpellingCatalogue();
  const published = loadFullSpellingCatalogue();
  const starterCore = starter.items.filter(
    ({ coverageTier }) => coverageTier == null || coverageTier === 'statutory-core',
  );
  const publishedCore = published.items.filter(
    ({ coverageTier }) => coverageTier == null || coverageTier === 'statutory-core',
  );
  assert.ok(publishedCore.length > starterCore.length);

  const world = createLearningWorld(
    [expectedB2Snapshot('learner-a')],
    starter,
  );
  const controller = world.createController(undefined, {
    publishedCatalogue: published,
  });
  const state = controller.getState();

  assert.equal(state.packSize, published.items.length);
  assert.equal(state.progress.length, published.items.length);
  assert.deepEqual(state.vocabularySets, [
    { id: 'core', label: 'Core', count: starterCore.length },
    {
      id: 'y3-4',
      label: 'Y3–4',
      count: starterCore.filter(({ yearBand }) => yearBand === '3-4').length,
    },
    {
      id: 'y5-6',
      label: 'Y5–6',
      count: starterCore.filter(({ yearBand }) => yearBand === '5-6').length,
    },
  ]);
  assert.notEqual(state.vocabularySets[0].count, publishedCore.length);

  await controller.startRound({
    mode: 'smart',
    length: 5,
    yearFilter: 'y5-6',
  });
  const runtimeItemId = controller.getState().practice.runtimeItemId;
  assert.equal(
    starter.items.find((item) => item.runtimeItemId === runtimeItemId)?.yearBand,
    '5-6',
  );

  await controller.dispose();
});

test('product learning publishes legacy catalogue rows as core vocabulary metadata', async () => {
  const catalogue = structuredClone(loadStarterSpellingCatalogue());
  for (const item of catalogue.items) delete item.coverageTier;
  const world = createLearningWorld(
    [snapshotForCatalogue(catalogue)],
    catalogue,
  );
  const controller = world.createController();

  assert.deepEqual(controller.getState().vocabularySets, [
    { id: 'core', label: 'Core', count: 20 },
    { id: 'y3-4', label: 'Y3–4', count: 10 },
    { id: 'y5-6', label: 'Y5–6', count: 10 },
  ]);
  assert.ok(
    controller.getState().progress.every(
      ({ coverageTier }) => coverageTier === null,
    ),
  );

  await controller.dispose();
});

test('product learning hands the Word Bank one word of catalogue material, read-only', async () => {
  const world = createLearningWorld();
  const controller = world.createController();
  const item = world.catalogue.items.find(
    ({ runtimeItemId }) => runtimeItemId === 'ks2-core:busy',
  );

  const material = controller.wordMaterial('ks2-core:busy');
  assert.deepEqual(material, item);
  // The reply is a copy of the pack, not a handle on it.
  assert.notEqual(material, item);
  assert.throws(() => {
    material.explanation = 'rewritten';
  }, TypeError);
  assert.throws(() => {
    material.familyWords.push('invented');
  }, TypeError);

  assert.equal(controller.wordMaterial('ks2-core:not-in-this-pack'), null);
  assert.equal(controller.wordMaterial(undefined), null);
  assert.equal(world.transactionCount(), 0);

  await controller.dispose();
});

test('product learning practises one Word Bank word without moving the review schedule', async () => {
  const world = createLearningWorld();
  const controller = world.createController();
  const target = world.catalogue.items.find(
    ({ runtimeItemId }) => runtimeItemId === 'ks2-core:busy',
  );

  await assert.rejects(controller.practiseWord('ks2-core:not-here'), TypeError);
  assert.equal(world.transactionCount(), 0);

  await controller.practiseWord(target.runtimeItemId);
  const started = controller.getState();
  assert.equal(started.screen, 'practice');
  assert.equal(started.practice.mode, 'single');
  // The engine's own name for a practiceOnly drill.
  assert.equal(started.practice.label, 'Word bank practice');
  assert.equal(started.practice.runtimeItemId, target.runtimeItemId);
  assert.equal(started.practice.progress.total, 1);
  // A fresh baseline, so the summary this round ends on cannot replay the
  // celebrations of the round before it.
  assert.equal(started.roundBaseline.sessionId, started.practice.sessionId);

  await controller.submitAnswer(target.target);
  await controller.continueRound();
  // One word means the round only ever holds that word.
  assert.equal(
    controller.getState().practice.runtimeItemId,
    target.runtimeItemId,
  );
  await controller.submitAnswer(target.target);
  await controller.continueRound();

  const finished = controller.getState();
  assert.equal(finished.screen, 'summary');
  assert.deepEqual(
    finished.progress.find(
      ({ runtimeItemId }) => runtimeItemId === target.runtimeItemId,
    ),
    unseenProgress(world.catalogue).find(
      ({ runtimeItemId }) => runtimeItemId === target.runtimeItemId,
    ),
  );
  // A rehearsal earns nothing either: no companion moves, no Camp credit.
  assert.deepEqual(finished.monsters, controller.getState().roundBaseline.monsters);

  await controller.dispose();
});

test('product learning routes Trouble Drill and SATs Test through the shared controller', async () => {
  const troubleWorld = createLearningWorld();
  const trouble = troubleWorld.createController();
  await trouble.startRound({
    mode: 'trouble',
    length: 5,
    yearFilter: 'y3-4',
  });
  assert.equal(trouble.getState().practice.fallbackToSmart, true);
  await trouble.dispose();

  const testWorld = createLearningWorld();
  const sats = testWorld.createController();
  await sats.startRound({
    mode: 'test',
    length: 20,
    yearFilter: 'core',
  });
  assert.equal(sats.getState().practice.mode, 'test');
  assert.equal(sats.getState().practice.label, 'SATs 20 test');
  assert.equal(sats.getState().practice.progress.total, 20);
  await sats.dispose();
});

test('product learning rejects unavailable or malformed round options before persistence', async () => {
  let getterReads = 0;
  const accessorOptions = {
    mode: 'smart',
    length: 5,
    get yearFilter() {
      getterReads += 1;
      return 'core';
    },
  };
  const customPrototypeOptions = Object.assign(
    Object.create({ inherited: true }),
    { mode: 'smart', length: 5, yearFilter: 'core' },
  );
  const symbolOptions = {
    mode: 'smart',
    length: 5,
    yearFilter: 'core',
    [Symbol('extra')]: true,
  };
  const nonEnumerableOptions = {
    mode: 'smart',
    length: 5,
    yearFilter: 'core',
  };
  Object.defineProperty(nonEnumerableOptions, 'yearFilter', {
    value: 'core',
    enumerable: false,
  });

  const invalidOptions = [
    // 'y5-6' stopped being invalid with the #168 Starter rebalance: the band
    // now has published words, so its filter is selectable on a free install.
    { mode: 'smart', length: 5, yearFilter: 'nonexistent-band' },
    { mode: 'test', length: 5, yearFilter: 'core' },
    { mode: 'test', length: 20, yearFilter: 'y3-4' },
    { mode: 'unknown', length: 5, yearFilter: 'core' },
    { mode: 'smart', length: 5, yearFilter: 'core', extra: true },
    accessorOptions,
    customPrototypeOptions,
    symbolOptions,
    nonEnumerableOptions,
  ];

  const world = createLearningWorld();
  const controller = world.createController();
  const beforeState = controller.getState();
  const beforeSnapshot = structuredClone(world.snapshots.get('learner-a'));

  for (const options of invalidOptions) {
    await assert.rejects(controller.startRound(options), TypeError);
    assert.strictEqual(controller.getState(), beforeState);
    assert.deepEqual(world.snapshots.get('learner-a'), beforeSnapshot);
    assert.equal(world.transactionCount(), 0);
  }
  assert.equal(getterReads, 0);

  await controller.dispose();
});

test('product learning keeps correction and safe abandonment inside the A3 transaction result', async () => {
  const world = createLearningWorld();
  const controller = world.createController();
  await controller.startRound({
    mode: 'smart',
    length: 5,
    yearFilter: 'core',
  });

  await assert.rejects(
    controller.submitAnswer('  '),
    (error) => error?.code === 'product_answer_required',
  );
  assert.equal(world.snapshots.get('learner-a').revision, 1);

  await controller.submitAnswer('definitely wrong');
  let state = controller.getState();
  assert.equal(state.practice.feedback.kind, 'error');
  assert.equal(state.practice.feedback.answer, '');
  assert.equal(state.practice.awaitingAdvance, false);

  await controller.submitAnswer('still wrong');
  state = controller.getState();
  assert.equal(state.practice.feedback.kind, 'error');
  assert.equal(state.practice.feedback.answer, targetFor(controller, world.catalogue));

  await controller.submitAnswer(targetFor(controller, world.catalogue));
  state = controller.getState();
  assert.equal(state.practice.feedback.kind, 'info');
  assert.equal(state.practice.awaitingAdvance, true);
  await controller.continueRound();
  assert.equal(controller.getState().screen, 'practice');
  assert.equal(controller.getState().practice.awaitingAdvance, false);

  await controller.endRound();
  assert.equal(controller.getState().screen, 'summary');
  assert.equal(
    controller.getState().summary.message,
    'You ended this round early. Every word you answered has been saved.',
    'ending early reports the words reached rather than discarding them',
  );
  assert.equal(controller.getState().summary.totalWords, 1);
  assert.equal(
    world.snapshots.get('learner-a').practiceSession.status,
    'abandoned',
  );
  controller.showScreen('home');
  assert.equal(controller.getState().summary, null);

  await controller.dispose();
});

test('product learning skips a word and ends an untouched round without a summary', async () => {
  const world = createLearningWorld();
  const controller = world.createController();
  await controller.startRound({
    mode: 'smart',
    length: 5,
    yearFilter: 'core',
  });
  const firstWord = targetFor(controller, world.catalogue);

  await controller.skipWord();
  let state = controller.getState();
  assert.equal(state.screen, 'practice');
  assert.equal(state.practice.feedback.headline, 'Skipped for now.');
  assert.notEqual(targetFor(controller, world.catalogue), firstWord);
  assert.equal(state.practice.progress.checked, 0, 'a skip is not an answer');

  await controller.endRound();
  state = controller.getState();
  assert.equal(state.screen, 'home', 'a round with no answers has no summary');
  assert.equal(state.summary, null);

  await controller.dispose();
});

test('product learning persists round preferences in the A3 prefs bag', async () => {
  const world = createLearningWorld();
  const controller = world.createController();
  assert.deepEqual(controller.getState().prefs, {
    voiceId: 'Iapetus',
    showCloze: true,
    autoSpeak: true,
  });

  controller.showScreen('setup');
  await controller.savePrefs({ voiceId: 'Sulafat', showCloze: false });
  assert.equal(
    controller.getState().screen,
    'setup',
    'saving a preference must not move the learner off the setup screen',
  );
  assert.deepEqual(controller.getState().prefs, {
    voiceId: 'Sulafat',
    showCloze: false,
    autoSpeak: true,
  });
  await controller.savePrefs({ autoSpeak: false });
  assert.equal(controller.getState().prefs.autoSpeak, false);

  await assert.rejects(controller.savePrefs({ voiceId: 'Nobody' }), TypeError);
  await assert.rejects(controller.savePrefs({ showCloze: 'yes' }), TypeError);

  const restored = world.createController(
    structuredClone(world.snapshots.get('learner-a')),
  );
  assert.deepEqual(restored.getState().prefs, {
    voiceId: 'Sulafat',
    showCloze: false,
    autoSpeak: false,
  });

  await controller.dispose();
  await restored.dispose();
});

test('product learning projects saved progress, Monster and Camp views without changing learner bytes', async () => {
  const world = createLearningWorld();
  const controller = world.createController();
  await controller.startRound({
    mode: 'smart',
    length: 5,
    yearFilter: 'core',
  });

  while (controller.getState().screen === 'practice') {
    const state = controller.getState();
    if (state.practice.awaitingAdvance) {
      await controller.continueRound();
    } else {
      await controller.submitAnswer(targetFor(controller, world.catalogue));
    }
  }

  const completedRevision = world.snapshots.get('learner-a').revision;
  assert.equal(controller.getState().screen, 'summary');
  assert.equal(controller.getState().summary.totalWords, 5);
  assert.equal(controller.getState().summary.accuracy, 100);
  assert.equal(controller.getState().summary.mode, 'smart');

  controller.showScreen('progress');
  assert.equal(controller.getState().screen, 'progress');
  const attempted = controller.getState().progress.filter(
    ({ attempts }) => attempts > 0,
  );
  assert.equal(attempted.length, 5);
  assert.ok(
    attempted.every(
      ({ runtimeItemId, target, stage, correct }) =>
        runtimeItemId.startsWith('ks2-core:') &&
        typeof target === 'string' &&
        stage === 1 &&
        correct === 1,
    ),
  );

  controller.showScreen('monster');
  assert.equal(controller.getState().monsters[0].monsterId, 'inklet');
  assert.equal(controller.getState().monsters[0].branch, 'b1');
  controller.showScreen('camp');
  assert.equal(controller.getState().camp.packId, 'ks2-core');
  controller.showScreen('home');
  assert.equal(controller.getState().screen, 'home');
  assert.equal(world.snapshots.get('learner-a').revision, completedRevision);

  await controller.selectLearner(null);
  assert.equal(controller.getState().screen, 'profiles');
  assert.equal(controller.getState().learnerId, null);
  assert.equal(controller.getState().revisionMission, null);
  assert.equal(controller.getState().camp, null);
  await controller.selectLearner('learner-a');
  assert.equal(controller.getState().screen, 'home');
  assert.equal(
    controller.getState().progress.filter(({ attempts }) => attempts > 0).length,
    5,
  );

  await controller.dispose();
});

test('product learning captures a round baseline at startRound and persists it', async () => {
  const writes = [];
  const fakeStore = Object.freeze({
    async read() {
      return null;
    },
    async write(learnerId, record) {
      writes.push({ learnerId, record: structuredClone(record) });
      return structuredClone(record);
    },
  });
  const catalogue = loadFullSpellingCatalogue();
  const world = createLearningWorld(
    [snapshotForCatalogue(catalogue)],
    catalogue,
  );
  const controller = world.createController(world.snapshots.get('learner-a'), {
    roundBaselineStore: fakeStore,
  });

  await controller.startRound({
    mode: 'smart',
    length: 5,
    yearFilter: 'y5-6',
  });

  const state = controller.getState();
  assert.equal(state.roundBaseline.sessionId, state.practice.sessionId);
  assert.equal(
    state.roundBaseline.companionRewardTrackId,
    'spelling-core-glimmerbug',
  );
  // Captured after start-session lands, so it matches the practice roster.
  assert.deepEqual(state.roundBaseline.monsters, state.monsters);
  assert.deepEqual(state.roundBaseline.camp, {
    packId: 'ks2-core',
    campHighWater: 0,
    lastCreditedGuardianDay: null,
  });
  assert.deepEqual(state.roundBaseline.achievementIds, []);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].learnerId, 'learner-a');
  assert.deepEqual(writes[0].record, {
    schemaVersion: 1,
    learnerId: 'learner-a',
    sessionId: state.practice.sessionId,
    companionRewardTrackId: 'spelling-core-glimmerbug',
    achievementIds: [],
    monsters: state.monsters,
    camp: state.roundBaseline.camp,
  });

  await controller.dispose();
});

test('product learning gives Guardian the furthest-grown found companion', async () => {
  const catalogue = loadFullSpellingCatalogue();
  const initialSnapshot = expectedGuardianSnapshot();
  const world = createLearningWorld([initialSnapshot], catalogue);
  const controller = world.createController();

  await controller.startGuardianMission();
  const state = controller.getState();
  assert.equal(
    state.roundBaseline.companionRewardTrackId,
    setupExpeditionCompanion(state.monsters)?.rewardTrackId ?? null,
  );

  await controller.dispose();
});

test('product learning adopts a matching initialRoundBaseline mid-session', async () => {
  const world = createLearningWorld();
  const first = world.createController();
  await first.startRound({ mode: 'smart', length: 5, yearFilter: 'y3-4' });
  const midSession = structuredClone(world.snapshots.get('learner-a'));
  const baseline = {
    schemaVersion: 1,
    learnerId: 'learner-a',
    sessionId: first.getState().practice.sessionId,
    companionRewardTrackId:
      first.getState().roundBaseline.companionRewardTrackId,
    monsters: structuredClone(first.getState().roundBaseline.monsters),
    camp: structuredClone(first.getState().roundBaseline.camp),
  };
  await first.dispose();

  const restored = world.createController(midSession, {
    initialRoundBaseline: baseline,
  });
  assert.equal(restored.getState().screen, 'practice');
  assert.equal(
    restored.getState().roundBaseline.sessionId,
    midSession.subjectState.ui.session.id,
  );
  assert.deepEqual(
    restored.getState().roundBaseline.monsters,
    baseline.monsters,
  );
  assert.equal(
    restored.getState().roundBaseline.companionRewardTrackId,
    'spelling-core-inklet',
  );
  await restored.dispose();

  const mismatched = world.createController(midSession, {
    initialRoundBaseline: { ...baseline, sessionId: 'session-other' },
  });
  assert.equal(mismatched.getState().roundBaseline, null);
  await mismatched.dispose();
});

test('product learning selectLearner clears and re-reads the round baseline', async () => {
  const world = createLearningWorld([
    expectedB2Snapshot('learner-a'),
    expectedB2Snapshot('learner-b'),
  ]);
  const first = world.createController();
  await first.startRound({ mode: 'smart', length: 5, yearFilter: 'y3-4' });
  const midA = structuredClone(world.snapshots.get('learner-a'));
  const baselineA = {
    schemaVersion: 1,
    learnerId: 'learner-a',
    sessionId: first.getState().practice.sessionId,
    companionRewardTrackId:
      first.getState().roundBaseline.companionRewardTrackId,
    monsters: structuredClone(first.getState().roundBaseline.monsters),
    camp: structuredClone(first.getState().roundBaseline.camp),
  };
  await first.dispose();

  world.snapshots.set('learner-a', midA);
  const reads = [];
  const fakeStore = Object.freeze({
    async read(learnerId) {
      reads.push(learnerId);
      return learnerId === 'learner-a' ? structuredClone(baselineA) : null;
    },
    async write() {
      throw new Error('write should not run in this test');
    },
  });

  const controller = world.createController(expectedB2Snapshot('learner-b'), {
    roundBaselineStore: fakeStore,
  });
  assert.equal(controller.getState().roundBaseline, null);

  await controller.selectLearner('learner-a');
  assert.deepEqual(reads, ['learner-a']);
  assert.equal(
    controller.getState().roundBaseline.sessionId,
    baselineA.sessionId,
  );
  assert.equal(
    controller.getState().roundBaseline.companionRewardTrackId,
    'spelling-core-inklet',
  );

  await controller.selectLearner(null);
  assert.equal(controller.getState().roundBaseline, null);
  assert.equal(controller.getState().screen, 'profiles');

  await controller.dispose();
});

test('product learning startRound ignores round baseline store write failures', async () => {
  const fakeStore = Object.freeze({
    async read() {
      return null;
    },
    async write() {
      throw new Error('disk full');
    },
  });
  const world = createLearningWorld();
  const controller = world.createController(world.snapshots.get('learner-a'), {
    roundBaselineStore: fakeStore,
  });

  await controller.startRound({
    mode: 'smart',
    length: 5,
    yearFilter: 'core',
  });
  assert.equal(controller.getState().screen, 'practice');
  assert.equal(
    controller.getState().roundBaseline.sessionId,
    controller.getState().practice.sessionId,
  );

  await controller.dispose();
});

test('product learning projects allowlisted achievement chips and memoises by revision', async () => {
  const seeded = structuredClone(expectedB2Snapshot('learner-a'));
  seeded.subjectState.data.achievements = {
    GUARDIAN_7_DAY: { unlockedAt: 1_700_000_000_000 },
    '_progress:guardian:days': { days: [20_461, 20_462, 20_463] },
  };
  const world = createLearningWorld([seeded]);
  const controller = world.createController(seeded);

  const chips = controller.getState().achievements;
  assert.equal(chips.length, 1);
  assert.equal(chips[0].id, 'GUARDIAN_7_DAY');
  assert.equal(chips[0].title, 'Guardian 7-day Maintainer');
  assert.equal(
    chips[0].body,
    'Kept Guardian Missions going on 7 different days.',
  );
  assert.equal(chips[0].unlockedAt, 1_700_000_000_000);

  controller.showScreen('camp');
  assert.equal(
    controller.getState().achievements,
    chips,
    'same-revision publishes must reuse the memoised achievements array',
  );
  controller.showScreen('home');
  assert.equal(controller.getState().achievements, chips);

  const revisionBefore = world.snapshots.get('learner-a').revision;
  await controller.savePrefs({ voiceId: 'Sulafat' });
  assert.notEqual(
    world.snapshots.get('learner-a').revision,
    revisionBefore,
    'savePrefs must bump the durable revision',
  );
  const afterBump = controller.getState().achievements;
  assert.notEqual(
    afterBump,
    chips,
    'a revision bump must recompute the achievements projection',
  );
  assert.deepEqual(afterBump, chips);

  await controller.startRound({ mode: 'smart', length: 5, yearFilter: 'core' });
  assert.deepEqual(
    controller.getState().roundBaseline.achievementIds,
    ['GUARDIAN_7_DAY'],
  );

  await controller.selectLearner(null);
  assert.deepEqual(controller.getState().achievements, []);

  await controller.dispose();
});

test('product learning projects milestone records and memoises by revision', async () => {
  const seeded = structuredClone(expectedB2Snapshot('learner-a'));
  seeded.eventLog = [
    {
      id: 'spelling.mastery-milestone:learner-a:5',
      type: 'spelling.mastery-milestone',
      subjectId: 'spelling',
      learnerId: 'learner-a',
      sessionId: 'session-x',
      mode: 'smart',
      milestone: 5,
      secureCount: 5,
      createdAt: 1,
    },
    {
      id: 'spelling.session-completed:learner-a:session-x',
      type: 'spelling.session-completed',
      subjectId: 'spelling',
      learnerId: 'learner-a',
      sessionId: 'session-x',
      mode: 'smart',
      sessionType: 'learning',
      totalWords: 5,
      mistakeCount: 0,
      createdAt: 2,
    },
  ];
  const world = createLearningWorld([seeded]);
  const controller = world.createController(seeded);

  const records = controller.getState().records;
  assert.deepEqual(records.milestones, [{
    milestone: 5,
    sessionId: 'session-x',
    createdAt: 1,
  }]);
  controller.showScreen('camp');
  assert.equal(
    controller.getState().records,
    records,
    'same-revision publishes must reuse the memoised records object',
  );

  await controller.selectLearner(null);
  const emptyRecords = controller.getState().records;
  assert.deepEqual(emptyRecords, { milestones: [] });
  await controller.selectLearner('learner-a');
  await controller.selectLearner(null);
  assert.equal(
    controller.getState().records,
    emptyRecords,
    'learner deselection must reuse the empty records singleton',
  );

  await controller.dispose();
});

test('the free Starter publishes both year bands and practises Years 5-6 (#168)', async () => {
  // The rebalance's observable proof: Y5-6 was suppressed by the count > 0
  // filter in vocabularySetsProjection, so its chip appearing and its filter
  // starting a round are what show the swap actually landed on a free install.
  const world = createLearningWorld();
  const controller = world.createController();

  const state = controller.getState();
  assert.deepEqual(state.vocabularySets, [
    { id: 'core', label: 'Core', count: 20 },
    { id: 'y3-4', label: 'Y3–4', count: 10 },
    { id: 'y5-6', label: 'Y5–6', count: 10 },
  ]);
  assert.deepEqual(
    state.monsters.map(({ monsterId }) => monsterId),
    ['inklet', 'glimmerbug'],
  );
  // Camp and Guardian stay behind the full entitlement on a free install.
  assert.equal(state.revisionMission.missionState, 'locked');

  await controller.startRound({ mode: 'smart', length: 5, yearFilter: 'y5-6' });
  const { runtimeItemId } = controller.getState().practice;
  assert.equal(
    world.catalogue.items.find((item) => item.runtimeItemId === runtimeItemId)?.yearBand,
    '5-6',
  );

  await controller.dispose();
});

test('selectLearner consumes an already-secure Starter band without a later round show', async () => {
  const writes = [];
  const store = {
    async read() {
      return null;
    },
    async write(learnerId, record) {
      writes.push({ learnerId, record: structuredClone(record) });
      return structuredClone(record);
    },
  };
  const snapshot = structuredClone(expectedB2Snapshot('learner-a'));
  const starter = loadStarterSpellingCatalogue();
  snapshot.subjectState.data.progress = Object.fromEntries(
    starter.items
      .filter((item) => item.yearBand === '3-4')
      .map((item) => [item.runtimeItemId, { stage: 5 }]),
  );
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
  const world = createLearningWorld([snapshot]);
  const controller = world.createController(null, {
    starterCompleteMomentStore: store,
  });
  await controller.selectLearner('learner-a');
  assert.equal(controller.getState().starterCompleteMomentPresented, true);
  assert.deepEqual(writes, [{
    learnerId: 'learner-a',
    record: { presented: true },
  }]);
  await controller.dispose();
});

test('markStarterCompleteMomentPresented persists the one-time flag', async () => {
  const writes = [];
  const store = {
    async read() {
      return null;
    },
    async write(learnerId, record) {
      writes.push({ learnerId, record: structuredClone(record) });
      return structuredClone(record);
    },
  };
  const world = createLearningWorld();
  const controller = world.createController(undefined, {
    starterCompleteMomentStore: store,
  });
  await controller.markStarterCompleteMomentPresented();
  assert.equal(controller.getState().starterCompleteMomentPresented, true);
  assert.deepEqual(writes, [{
    learnerId: 'learner-a',
    record: { presented: true },
  }]);
  await controller.dispose();
});

test('markStarterCompleteMomentPresented leaves the flag unset when write fails', async () => {
  const store = {
    async read() {
      return null;
    },
    async write() {
      throw new Error('disk_full');
    },
  };
  const world = createLearningWorld();
  const controller = world.createController(undefined, {
    starterCompleteMomentStore: store,
  });
  await assert.rejects(
    controller.markStarterCompleteMomentPresented(),
    /disk_full/,
  );
  assert.equal(controller.getState().starterCompleteMomentPresented, false);
  await controller.dispose();
});
