import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadStarterSpellingCatalogue,
} from '../src/domain/spelling/index.js';
import { createProductLearningController } from '../src/app/product-learning-controller.js';
import {
  expectedB2Snapshot,
  snapshotAfterPlan,
} from './helpers/b2-database-harness.mjs';

const NOW_MS = 1_768_478_400_000;

function createLearningWorld(
  initialSnapshots = [expectedB2Snapshot('learner-a')],
) {
  const catalogue = loadStarterSpellingCatalogue();
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
    createController(initialSnapshot = initialSnapshots[0] ?? null) {
      return createProductLearningController({
        repository,
        snapshotStore,
        catalogue,
        initialSnapshot,
        random: () => 0.25,
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

test('product learning starts a durable Smart Review and restores an interrupted round', async () => {
  const world = createLearningWorld();
  const first = world.createController();

  assert.deepEqual(first.getState(), {
    status: 'ready',
    screen: 'home',
    learnerId: 'learner-a',
    practice: null,
    summary: null,
    progress: [],
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
    camp: {
      packId: 'ks2-core',
      campHighWater: 0,
      lastCreditedGuardianDay: null,
    },
    actionError: null,
  });

  first.showScreen('setup');
  assert.equal(first.getState().screen, 'setup');
  await first.startRound({ mode: 'smart', length: 5 });

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

test('product learning keeps correction and safe abandonment inside the A3 transaction result', async () => {
  const world = createLearningWorld();
  const controller = world.createController();
  await controller.startRound({ mode: 'smart', length: 5 });

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
  assert.equal(controller.getState().screen, 'home');
  assert.equal(controller.getState().summary, null);
  assert.equal(
    world.snapshots.get('learner-a').practiceSession.status,
    'abandoned',
  );

  await controller.dispose();
});

test('product learning projects saved progress, Monster and Camp views without changing learner bytes', async () => {
  const world = createLearningWorld();
  const controller = world.createController();
  await controller.startRound({ mode: 'smart', length: 5 });

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
  assert.equal(controller.getState().progress.length, 5);
  assert.ok(
    controller.getState().progress.every(
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
  await controller.selectLearner('learner-a');
  assert.equal(controller.getState().screen, 'home');
  assert.equal(controller.getState().progress.length, 5);

  await controller.dispose();
});
