import assert from 'node:assert/strict';
import test from 'node:test';

import { createProductLearningController } from '../src/app/product-learning-controller.js';
import {
  canonicalGuardianDay,
  loadFullSpellingCatalogue,
  validateSpellingCommandSnapshotV1,
} from '../src/domain/spelling/index.js';
import { snapshotAfterPlan } from './helpers/b2-database-harness.mjs';
import { expectedGuardianSnapshot } from './helpers/guardian-fixture.mjs';

const DAY_MS = 86_400_000;
const NOW_MS = 1_768_478_400_000;

function createGuardianWorld({
  initialSnapshot = expectedGuardianSnapshot(),
  storedSnapshot = initialSnapshot,
  nowMs = NOW_MS,
} = {}) {
  const catalogue = loadFullSpellingCatalogue();
  let snapshot = structuredClone(storedSnapshot);
  let clockMs = nowMs;
  let transactionCount = 0;
  const repository = Object.freeze({
    async runCommandTransaction(learnerId, planner) {
      assert.equal(learnerId, snapshot.learnerId);
      const transactionNowMs = clockMs;
      const plan = await planner(
        structuredClone(snapshot),
        Object.freeze({
          nowMs: transactionNowMs,
          todayGuardianDay: canonicalGuardianDay(transactionNowMs),
        }),
      );
      snapshot = snapshotAfterPlan(snapshot, plan);
      transactionCount += 1;
      clockMs += 1;
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
    initialSnapshot,
    random: () => 0.25,
    now: () => clockMs,
  });
  return Object.freeze({
    catalogue,
    controller,
    snapshot: () => structuredClone(snapshot),
    transactionCount: () => transactionCount,
    advanceDays(days) {
      clockMs += days * DAY_MS;
    },
  });
}

function targetFor(controller, catalogue) {
  const runtimeItemId = controller.getState().practice?.runtimeItemId;
  const item = catalogue.items.find(
    (candidate) => candidate.runtimeItemId === runtimeItemId,
  );
  assert.ok(item, 'Guardian practice must identify a catalogue item');
  return item.target;
}

test('Guardian Mission completes once for Camp and becomes due after resting', async () => {
  const world = createGuardianWorld();
  const { controller } = world;

  assert.equal(
    Object.keys(world.snapshot().subjectState.data.progress).length,
    213,
  );
  assert.deepEqual(controller.getState().revisionMission, {
    missionState: 'first-patrol',
    eligibleMissionKind: 'first-patrol',
    guardianDueCount: 0,
    wobblingDueCount: 0,
    nextGuardianDueDay: null,
    todayGuardianDay: 20_468,
    canStartRewardBearing: true,
    canContinueUnrewarded: false,
    campCreditState: 'available',
  });
  assert.equal(controller.getState().camp.canEarnToday, true);

  await controller.startGuardianMission();
  assert.equal(controller.getState().screen, 'practice');
  assert.equal(controller.getState().practice.label, 'Guardian Mission');
  assert.equal(controller.getState().practice.progress.total, 8);
  assert.equal(
    controller.getState().roundBaseline.sessionId,
    controller.getState().practice.sessionId,
  );

  for (let attempt = 0; attempt < 8; attempt += 1) {
    await controller.submitAnswer(targetFor(controller, world.catalogue));
    assert.equal(controller.getState().practice.awaitingAdvance, true);
    assert.deepEqual(
      {
        kind: controller.getState().practice.feedback.kind,
        headline: controller.getState().practice.feedback.headline,
      },
      { kind: 'info', headline: 'Guardian strong.' },
    );
    await controller.continueRound();
  }

  assert.equal(controller.getState().screen, 'summary');
  assert.equal(controller.getState().camp.campHighWater, 1);
  assert.equal(controller.getState().camp.canEarnToday, false);
  assert.ok(
    world.snapshot().eventLog.some(
      ({ type }) => type === 'spelling.guardian.mission-completed',
    ),
  );
  await assert.rejects(
    controller.startGuardianMission(),
    (error) => error?.code === 'guardian_mission_unavailable',
  );

  const raceWorld = createGuardianWorld({
    initialSnapshot: expectedGuardianSnapshot(),
    storedSnapshot: world.snapshot(),
    nowMs: NOW_MS + 1_000,
  });
  raceWorld.controller.showScreen('camp');
  await assert.rejects(
    raceWorld.controller.startGuardianMission(),
    (error) => error?.code === 'guardian_mission_unavailable',
  );
  assert.equal(raceWorld.controller.getState().screen, 'camp');
  assert.equal(
    raceWorld.controller.getState().actionError,
    'guardian_mission_unavailable',
  );
  assert.equal(raceWorld.transactionCount(), 1);
  await raceWorld.controller.dispose();

  const sameDayDue = world.snapshot();
  const todayGuardianDay = canonicalGuardianDay(NOW_MS);
  for (const record of Object.values(
    sameDayDue.subjectState.data.guardianMap,
  )) {
    record.lastReviewedDay = todayGuardianDay - 3;
    record.nextDueDay = todayGuardianDay;
  }
  const unrewardedWorld = createGuardianWorld({
    initialSnapshot: validateSpellingCommandSnapshotV1(
      sameDayDue,
      world.catalogue,
    ),
    nowMs: NOW_MS + 2_000,
  });
  assert.deepEqual(
    {
      missionState: unrewardedWorld.controller.getState().revisionMission
        .missionState,
      canStartRewardBearing: unrewardedWorld.controller.getState()
        .revisionMission.canStartRewardBearing,
      canContinueUnrewarded: unrewardedWorld.controller.getState()
        .revisionMission.canContinueUnrewarded,
    },
    {
      missionState: 'due',
      canStartRewardBearing: false,
      canContinueUnrewarded: true,
    },
  );
  await assert.rejects(
    unrewardedWorld.controller.startGuardianMission(),
    (error) => error?.code === 'guardian_mission_unavailable',
  );
  await unrewardedWorld.controller.startGuardianMission({ intent: 'unrewarded' });
  while (unrewardedWorld.controller.getState().screen === 'practice') {
    const state = unrewardedWorld.controller.getState();
    if (state.practice.awaitingAdvance) {
      await unrewardedWorld.controller.continueRound();
    } else {
      await unrewardedWorld.controller.submitAnswer(
        targetFor(unrewardedWorld.controller, unrewardedWorld.catalogue),
      );
    }
  }
  assert.equal(unrewardedWorld.controller.getState().camp.campHighWater, 1);
  assert.equal(
    unrewardedWorld.snapshot().eventLog.filter(
      ({ type }) => type === 'spelling.guardian.mission-completed',
    ).length,
    2,
  );
  await unrewardedWorld.controller.dispose();

  world.advanceDays(1);
  controller.showScreen('home');
  assert.equal(controller.getState().revisionMission.missionState, 'rested');
  world.advanceDays(2);
  controller.showScreen('camp');
  assert.equal(controller.getState().revisionMission.missionState, 'due');
  assert.equal(controller.getState().camp.canEarnToday, true);

  await controller.dispose();
});

test('Guardian wrong answers can be abandoned without Camp credit', async () => {
  const world = createGuardianWorld();
  const { controller } = world;
  const before = controller.getState();

  await assert.rejects(
    controller.startGuardianMission({ intent: 'later' }),
    TypeError,
  );
  assert.strictEqual(controller.getState(), before);
  assert.equal(world.transactionCount(), 0);

  await controller.startGuardianMission({ intent: 'reward-bearing' });
  await controller.submitAnswer('definitely wrong');
  assert.equal(controller.getState().practice.awaitingAdvance, true);
  assert.deepEqual(
    {
      kind: controller.getState().practice.feedback.kind,
      headline: controller.getState().practice.feedback.headline,
    },
    { kind: 'warn', headline: 'Wobbling.' },
  );
  await controller.endRound();

  assert.equal(controller.getState().camp.campHighWater, 0);
  assert.equal(
    world.snapshot().eventLog.some(
      ({ type }) => type === 'spelling.guardian.mission-completed',
    ),
    false,
  );

  await controller.dispose();
});
