import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadFullSpellingCatalogue,
  loadStarterSpellingCatalogue,
  validateSpellingCommandSnapshotV1,
} from '../src/domain/spelling/index.js';
import { createProductLearningController } from '../src/app/product-learning-controller.js';
import {
  expectedB2Snapshot,
  snapshotAfterPlan,
} from './helpers/b2-database-harness.mjs';

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
    // The active pack's size, so the setup panel can report what is unseen.
    packSize: 20,
    vocabularySets: [
      { id: 'core', label: 'Core', count: 20 },
      { id: 'y3-4', label: 'Y3–4', count: 20 },
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
    { id: 'y3-4', label: 'Y3–4', count: 20 },
  ]);
  assert.ok(
    controller.getState().progress.every(
      ({ coverageTier }) => coverageTier === null,
    ),
  );

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
    { mode: 'smart', length: 5, yearFilter: 'y5-6' },
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
  const world = createLearningWorld();
  const controller = world.createController(world.snapshots.get('learner-a'), {
    roundBaselineStore: fakeStore,
  });

  await controller.startRound({
    mode: 'smart',
    length: 5,
    yearFilter: 'core',
  });

  const state = controller.getState();
  assert.equal(state.roundBaseline.sessionId, state.practice.sessionId);
  // Captured after start-session lands, so it matches the practice roster.
  assert.deepEqual(state.roundBaseline.monsters, state.monsters);
  assert.deepEqual(state.roundBaseline.camp, {
    packId: 'ks2-core',
    campHighWater: 0,
    lastCreditedGuardianDay: null,
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].learnerId, 'learner-a');
  assert.deepEqual(writes[0].record, {
    schemaVersion: 1,
    learnerId: 'learner-a',
    sessionId: state.practice.sessionId,
    monsters: state.monsters,
    camp: state.roundBaseline.camp,
  });

  await controller.dispose();
});

test('product learning adopts a matching initialRoundBaseline mid-session', async () => {
  const world = createLearningWorld();
  const first = world.createController();
  await first.startRound({ mode: 'smart', length: 5, yearFilter: 'core' });
  const midSession = structuredClone(world.snapshots.get('learner-a'));
  const baseline = {
    schemaVersion: 1,
    learnerId: 'learner-a',
    sessionId: first.getState().practice.sessionId,
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
  await first.startRound({ mode: 'smart', length: 5, yearFilter: 'core' });
  const midA = structuredClone(world.snapshots.get('learner-a'));
  const baselineA = {
    schemaVersion: 1,
    learnerId: 'learner-a',
    sessionId: first.getState().practice.sessionId,
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
