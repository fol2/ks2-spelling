import assert from 'node:assert/strict';
import test from 'node:test';

import { createProductLearningController } from '../src/app/product-learning-controller.js';
import { loadStarterSpellingCatalogue } from '../src/domain/spelling/index.js';
import {
  expectedB2Snapshot,
  snapshotAfterPlan,
} from './helpers/b2-database-harness.mjs';

const NOW_MS = 1_768_478_400_000;

function deferred() {
  let resolve;
  const promise = new Promise((release) => {
    resolve = release;
  });
  return Object.freeze({ promise, resolve });
}

test('saving an answer preserves the same Practice screen and input projection', async () => {
  const catalogue = loadStarterSpellingCatalogue();
  let snapshot = structuredClone(expectedB2Snapshot('learner-a'));
  let commandCount = 0;
  const submitStarted = deferred();
  const allowSubmitToCommit = deferred();

  const repository = Object.freeze({
    async runCommandTransaction(learnerId, planner) {
      assert.equal(learnerId, 'learner-a');
      const plan = await planner(
        structuredClone(snapshot),
        Object.freeze({
          nowMs: NOW_MS + commandCount,
          todayGuardianDay: 20_468,
        }),
      );
      commandCount += 1;
      if (commandCount === 2) {
        submitStarted.resolve();
        await allowSubmitToCommit.promise;
      }
      snapshot = snapshotAfterPlan(snapshot, plan);
      return structuredClone(plan);
    },
  });
  const snapshotStore = Object.freeze({
    async read() {
      return structuredClone(snapshot);
    },
  });
  const controller = createProductLearningController({
    repository,
    snapshotStore,
    catalogue,
    initialSnapshot: snapshot,
    random: () => 0.25,
  });

  await controller.startRound({
    mode: 'smart',
    length: 5,
    yearFilter: 'core',
  });
  const before = controller.getState();
  assert.equal(before.screen, 'practice');
  assert.ok(before.practice);
  const target = catalogue.items.find(
    ({ runtimeItemId }) => runtimeItemId === before.practice.runtimeItemId,
  )?.target;
  assert.equal(typeof target, 'string');

  const pending = controller.submitAnswer(target);
  await submitStarted.promise;

  const saving = controller.getState();
  assert.equal(saving.status, 'saving');
  assert.equal(saving.screen, 'practice');
  assert.ok(saving.practice);
  assert.equal(saving.practice.sessionId, before.practice.sessionId);
  assert.equal(saving.practice.runtimeItemId, before.practice.runtimeItemId);
  assert.equal(saving.practice.awaitingAdvance, false);
  assert.equal(saving.practice.feedback, null);
  assert.throws(
    () => controller.showScreen('home'),
    (error) => error?.code === 'product_learning_busy',
  );

  allowSubmitToCommit.resolve();
  await pending;

  const saved = controller.getState();
  assert.equal(saved.status, 'ready');
  assert.equal(saved.screen, 'practice');
  assert.equal(saved.practice.sessionId, before.practice.sessionId);
  assert.equal(saved.practice.runtimeItemId, before.practice.runtimeItemId);
  assert.equal(saved.practice.awaitingAdvance, true);
  assert.equal(saved.practice.feedback.kind, 'info');

  await controller.dispose();
});
