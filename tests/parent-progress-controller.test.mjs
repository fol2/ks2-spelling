import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createParentProgressController,
} from '../src/app/parent-progress-controller.js';
import {
  loadStarterSpellingCatalogue,
} from '../src/domain/spelling/index.js';
import {
  B2_NOW_MS,
  expectedB2Snapshot,
} from './helpers/b2-database-harness.mjs';

test('Parent progress exposes only a redacted learning summary per local learner', async () => {
  const catalogue = loadStarterSpellingCatalogue();
  const ada = expectedB2Snapshot('learner-ada');
  const runtimeItemId = catalogue.items[0].runtimeItemId;
  ada.subjectState.data.progress[runtimeItemId] = {
    stage: 1,
    attempts: 3,
    correct: 2,
    wrong: 1,
    dueDay: 0,
    lastDay: 20_467,
    lastResult: 'correct',
  };
  ada.monsterStateByRewardTrackId['spelling-core-inklet'] = {
    rewardTrackId: 'spelling-core-inklet',
    packId: 'ks2-core',
    monsterId: 'inklet',
    branch: 'b1',
    secureCount: 0,
    caught: false,
    derivedStage: 0,
    earnedStageHighWater: 0,
  };
  const ben = expectedB2Snapshot('learner-ben');
  const profiles = [
    {
      learnerId: 'learner-ada',
      nickname: 'Ada',
      yearGroup: 'Y3',
      goal: 10,
      colour: '#2E7D8A',
      createdAt: 100,
      updatedAt: 100,
    },
    {
      learnerId: 'learner-ben',
      nickname: 'Ben',
      yearGroup: 'Y5',
      goal: 15,
      colour: '#A7633B',
      createdAt: 200,
      updatedAt: 200,
    },
  ];
  const controller = createParentProgressController({
    profileRepository: {
      async listProfiles() {
        return structuredClone(profiles);
      },
    },
    snapshotStore: {
      async read(learnerId) {
        return structuredClone(
          learnerId === 'learner-ada' ? ada : ben,
        );
      },
    },
    catalogue,
    now: () => B2_NOW_MS,
  });

  await controller.refresh();

  assert.deepEqual(controller.getState(), {
    status: 'ready',
    learners: [
      {
        learnerId: 'learner-ada',
        nickname: 'Ada',
        yearGroup: 'Y3',
        colour: '#2E7D8A',
        publishedItemCount: 20,
        secureItemCount: 0,
        dueItemCount: 1,
        troubleItemCount: 1,
        correctCount: 2,
        wrongCount: 1,
        accuracyPercent: 67,
        guardianDueCount: 0,
        wobblingDueCount: 0,
        nextGuardianReviewDay: null,
        recentRevisionSessions: [],
      },
      {
        learnerId: 'learner-ben',
        nickname: 'Ben',
        yearGroup: 'Y5',
        colour: '#A7633B',
        publishedItemCount: 20,
        secureItemCount: 0,
        dueItemCount: 0,
        troubleItemCount: 0,
        correctCount: 0,
        wrongCount: 0,
        accuracyPercent: null,
        guardianDueCount: 0,
        wobblingDueCount: 0,
        nextGuardianReviewDay: null,
        recentRevisionSessions: [],
      },
    ],
    actionError: null,
  });
  const exposed = JSON.stringify(controller.getState());
  assert.doesNotMatch(exposed, /inklet|monster|camp|reward.?track/i);
  await controller.dispose();
});

test('Parent progress fails closed without replacing its last redacted summary', async () => {
  let fail = false;
  const catalogue = loadStarterSpellingCatalogue();
  const profile = {
    learnerId: 'learner-ada',
    nickname: 'Ada',
    yearGroup: 'Y3',
    goal: 10,
    colour: '#2E7D8A',
    createdAt: 100,
    updatedAt: 100,
  };
  const controller = createParentProgressController({
    profileRepository: {
      async listProfiles() {
        if (fail) throw new Error('database unavailable');
        return [profile];
      },
    },
    snapshotStore: {
      async read(learnerId) {
        return expectedB2Snapshot(learnerId);
      },
    },
    catalogue,
    now: () => B2_NOW_MS,
  });

  await controller.refresh();
  fail = true;
  await assert.rejects(controller.refresh(), /database unavailable/);
  assert.deepEqual(controller.getState(), {
    status: 'unavailable',
    learners: [{
      learnerId: 'learner-ada',
      nickname: 'Ada',
      yearGroup: 'Y3',
      colour: '#2E7D8A',
      publishedItemCount: 20,
      secureItemCount: 0,
      dueItemCount: 0,
      troubleItemCount: 0,
      correctCount: 0,
      wrongCount: 0,
      accuracyPercent: null,
      guardianDueCount: 0,
      wobblingDueCount: 0,
      nextGuardianReviewDay: null,
      recentRevisionSessions: [],
    }],
    actionError: 'parent_progress_unavailable',
  });
  await controller.dispose();
});
