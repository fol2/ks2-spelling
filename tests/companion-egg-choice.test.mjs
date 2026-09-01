import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applySpellingCommand,
  createInMemorySpellingCommandRepository,
  loadFullSpellingCatalogue,
  loadStarterSpellingCatalogue,
  validateSpellingCommandSnapshotV1,
} from '../src/domain/spelling/index.js';
import {
  applyProductSpellingCommand,
  planChooseCompanionBranch,
} from '../src/app/companion-branch-command.js';
import { buildCodex, setupExpeditionCompanion, trailMeadowCompanions } from '../src/app/codex-model.js';
import { eggChoiceCopy, eggChoiceShouldShow } from '../src/app/egg-choice-moment.js';
import {
  eggChoiceMomentKeyDown,
  eggChoiceMomentMountFocus,
} from '../src/app/egg-choice-moment-runtime.js';
import {
  assignedMonsterBranch,
  companionCanSwitchBranch,
  companionIsPainted,
  pendingEggChoice,
  projectMonstersFromWordSecurity,
} from '../src/app/monster-progress-model.js';
import { createProductLearningController } from '../src/app/product-learning-controller.js';
import { diffMonsterCelebrations } from '../src/app/celebrations/celebration-model.js';
import { planSummaryRewards } from '../src/app/starter-complete-moment-runtime.js';
import { expectedB2Snapshot, snapshotAfterPlan } from './helpers/b2-database-harness.mjs';

const NOW_MS = 1_768_478_400_000;

function progressFor(items) {
  return Object.fromEntries(items.map(({ runtimeItemId }) => [
    runtimeItemId,
    { stage: 4 },
  ]));
}

function snapshotWithProgress(catalogue, items) {
  const snapshot = structuredClone(expectedB2Snapshot('learner-a'));
  snapshot.catalogueId = catalogue.catalogueId;
  snapshot.grantedEntitlementIds = [...catalogue.entitlementIds];
  snapshot.subjectState.data.progress = progressFor(items);
  return validateSpellingCommandSnapshotV1(snapshot, catalogue);
}

function overlay(catalogue, snapshot) {
  return projectMonstersFromWordSecurity({
    rewardTracks: catalogue.rewardTracks,
    items: catalogue.items,
    progress: snapshot.subjectState.data.progress,
    currentState: snapshot.monsterStateByRewardTrackId,
  });
}

function startSessionCommand() {
  return {
    type: 'start-session',
    payload: {
      mode: 'test',
      yearFilter: 'core',
      length: 20,
      practiceOnly: false,
      words: [],
    },
  };
}

test('found crossing with a null branch is the egg-choice beat', () => {
  const inklet = {
    rewardTrackId: 'spelling-core-inklet',
    monsterId: 'inklet',
    thresholds: [1, 10, 30, 60, 100],
    branch: null,
    secureCount: 0,
    caught: false,
    derivedStage: 0,
    earnedStageHighWater: 0,
  };
  const found = { ...inklet, secureCount: 1, caught: true };
  assert.equal(pendingEggChoice([inklet]), null);
  assert.equal(pendingEggChoice([found])?.monsterId, 'inklet');
  assert.equal(companionIsPainted(found), false);
  assert.equal(
    eggChoiceShouldShow({ monsters: [found], screen: 'home' }),
    true,
  );
  assert.equal(
    eggChoiceShouldShow({ monsters: [found], screen: 'practice' }),
    false,
  );
  assert.equal(
    eggChoiceShouldShow({
      monsters: [{ ...found, branch: 'b1' }],
      screen: 'home',
    }),
    false,
  );
});

test('an existing b1 snapshot never prompts and stays painted', () => {
  const saved = {
    rewardTrackId: 'spelling-core-inklet',
    monsterId: 'inklet',
    thresholds: [1, 10, 30, 60, 100],
    branch: 'b1',
    secureCount: 1,
    caught: true,
    derivedStage: 0,
    earnedStageHighWater: 0,
  };
  assert.equal(pendingEggChoice([saved]), null);
  assert.equal(companionIsPainted(saved), true);
  assert.equal(companionCanSwitchBranch(saved), true);
  assert.equal(
    companionCanSwitchBranch({ ...saved, derivedStage: 1, earnedStageHighWater: 1 }),
    false,
  );
});

test('null branch never paints as b1 on Codex, Trail or Setup', () => {
  const unassigned = {
    rewardTrackId: 'spelling-core-inklet',
    packId: 'ks2-core',
    monsterId: 'inklet',
    thresholds: [1, 10, 30, 60, 100],
    branch: null,
    secureCount: 1,
    caught: true,
    derivedStage: 0,
    earnedStageHighWater: 0,
  };
  const codex = buildCodex([unassigned]);
  assert.equal(codex.roster[0].found, false);
  assert.equal(codex.roster[0].painted, false);
  assert.equal(codex.roster[0].discovered, true);
  assert.deepEqual(trailMeadowCompanions(codex.roster), []);
  assert.equal(setupExpeditionCompanion([unassigned], 'y3-4'), null);
  assert.equal(assignedMonsterBranch(unassigned), null);
});

test('choosing Inklet does not assign Glimmerbug', () => {
  const catalogue = loadStarterSpellingCatalogue();
  const y34 = catalogue.items.filter((item) => item.yearBand === '3-4').slice(0, 1);
  const y56 = catalogue.items.filter((item) => item.yearBand === '5-6').slice(0, 1);
  const snapshot = snapshotWithProgress(catalogue, [...y34, ...y56]);
  const monsters = overlay(catalogue, snapshot);
  assert.equal(monsters.find((row) => row.monsterId === 'inklet').caught, true);
  assert.equal(monsters.find((row) => row.monsterId === 'glimmerbug').caught, true);
  assert.equal(pendingEggChoice(monsters).monsterId, 'inklet');

  const plan = planChooseCompanionBranch({
    snapshot,
    catalogue,
    rewardTrackId: 'spelling-core-inklet',
    branch: 'b2',
    nowMs: NOW_MS,
  });
  assert.equal(plan.changed, true);
  assert.equal(
    plan.nextMonsterStateByRewardTrackId['spelling-core-inklet'].branch,
    'b2',
  );
  assert.equal(
    plan.nextMonsterStateByRewardTrackId['spelling-core-glimmerbug'],
    undefined,
  );
  const after = overlay(catalogue, snapshotAfterPlan(snapshot, plan));
  assert.equal(after.find((row) => row.monsterId === 'inklet').branch, 'b2');
  assert.equal(after.find((row) => row.monsterId === 'glimmerbug').branch, null);
  assert.equal(pendingEggChoice(after).monsterId, 'glimmerbug');
});

test('product start-session leaves missing branches unassigned', async () => {
  const catalogue = loadStarterSpellingCatalogue();
  const snapshot = expectedB2Snapshot('learner-a');
  const engine = applySpellingCommand({
    snapshot,
    command: startSessionCommand(),
    contentSnapshot: catalogue,
    now: () => NOW_MS,
    random: () => 0.75,
  });
  assert.ok(Object.keys(engine.nextMonsterStateByRewardTrackId).length > 0);

  const product = applyProductSpellingCommand({
    snapshot,
    command: startSessionCommand(),
    contentSnapshot: catalogue,
    now: () => NOW_MS,
    random: () => 0.75,
  });
  assert.deepEqual(product.nextMonsterStateByRewardTrackId, {});
  assert.equal(product.changed, true);

  const repo = createInMemorySpellingCommandRepository({
    snapshots: [snapshot],
    cataloguesById: { [catalogue.catalogueId]: catalogue },
    now: () => NOW_MS,
  });
  const accepted = await repo.runCommandTransaction('learner-a', (fresh, context) => (
    applyProductSpellingCommand({
      snapshot: fresh,
      command: startSessionCommand(),
      contentSnapshot: catalogue,
      now: () => context.nowMs,
      random: () => 0.75,
    })
  ));
  assert.deepEqual(accepted.nextMonsterStateByRewardTrackId, {});
});

test('save-prefs still does not consume RNG after the product hold', () => {
  const catalogue = loadStarterSpellingCatalogue();
  let calls = 0;
  const plan = applyProductSpellingCommand({
    snapshot: expectedB2Snapshot('learner-a'),
    command: { type: 'save-prefs', payload: { prefs: { autoSpeak: true } } },
    contentSnapshot: catalogue,
    now: () => NOW_MS,
    random: () => {
      calls += 1;
      return 0.25;
    },
  });
  assert.equal(calls, 0);
  assert.deepEqual(plan.nextMonsterStateByRewardTrackId, {});
});

test('tap b2 persists b2 and later overlay art stays on b2', () => {
  const catalogue = loadStarterSpellingCatalogue();
  const y34 = catalogue.items.filter((item) => item.yearBand === '3-4');
  const found = snapshotWithProgress(catalogue, y34.slice(0, 1));
  const chosen = planChooseCompanionBranch({
    snapshot: found,
    catalogue,
    rewardTrackId: 'spelling-core-inklet',
    branch: 'b2',
    nowMs: NOW_MS,
  });
  const afterFound = snapshotAfterPlan(found, chosen);
  const grown = structuredClone(afterFound);
  grown.subjectState.data.progress = progressFor(y34.slice(0, 10));
  const hatched = overlay(catalogue, grown).find((row) => row.monsterId === 'inklet');
  assert.equal(hatched.branch, 'b2');
  assert.equal(hatched.derivedStage, 1);
  assert.equal(companionCanSwitchBranch(hatched), false);
  const frozen = planChooseCompanionBranch({
    snapshot: grown,
    catalogue,
    rewardTrackId: 'spelling-core-inklet',
    branch: 'b1',
    nowMs: NOW_MS,
  });
  assert.equal(frozen.changed, false);
  assert.equal(
    frozen.nextMonsterStateByRewardTrackId['spelling-core-inklet'].branch,
    'b2',
  );
});

test('switch before hatch replaces the persisted branch', () => {
  const catalogue = loadStarterSpellingCatalogue();
  const y34 = catalogue.items.filter((item) => item.yearBand === '3-4').slice(0, 1);
  const found = snapshotWithProgress(catalogue, y34);
  const first = snapshotAfterPlan(found, planChooseCompanionBranch({
    snapshot: found,
    catalogue,
    rewardTrackId: 'spelling-core-inklet',
    branch: 'b1',
    nowMs: NOW_MS,
  }));
  const switched = planChooseCompanionBranch({
    snapshot: first,
    catalogue,
    rewardTrackId: 'spelling-core-inklet',
    branch: 'b2',
    nowMs: NOW_MS,
  });
  assert.equal(
    switched.nextMonsterStateByRewardTrackId['spelling-core-inklet'].branch,
    'b2',
  );
});

test('in-memory A3 repository accepts a choose-branch plan', async () => {
  const catalogue = loadStarterSpellingCatalogue();
  const y34 = catalogue.items.filter((item) => item.yearBand === '3-4').slice(0, 1);
  const snapshot = snapshotWithProgress(catalogue, y34);
  const repo = createInMemorySpellingCommandRepository({
    snapshots: [snapshot],
    cataloguesById: { [catalogue.catalogueId]: catalogue },
    now: () => NOW_MS,
  });
  const plan = await repo.runCommandTransaction('learner-a', (fresh, context) => (
    planChooseCompanionBranch({
      snapshot: fresh,
      catalogue,
      rewardTrackId: 'spelling-core-inklet',
      branch: 'b2',
      nowMs: context.nowMs,
    })
  ));
  assert.equal(
    plan.nextMonsterStateByRewardTrackId['spelling-core-inklet'].branch,
    'b2',
  );
});

test('product controller start-session then choose-branch writes only that track', async () => {
  const catalogue = loadStarterSpellingCatalogue();
  const y34 = catalogue.items.filter((item) => item.yearBand === '3-4').slice(0, 1);
  const snapshot = snapshotWithProgress(catalogue, y34);
  const snapshots = new Map([[snapshot.learnerId, structuredClone(snapshot)]]);
  const controller = createProductLearningController({
    repository: Object.freeze({
      async runCommandTransaction(learnerId, planner) {
        const fresh = structuredClone(snapshots.get(learnerId));
        const plan = await planner(fresh, Object.freeze({
          nowMs: NOW_MS,
          todayGuardianDay: 20_468,
        }));
        snapshots.set(learnerId, snapshotAfterPlan(fresh, plan));
        return structuredClone(plan);
      },
    }),
    snapshotStore: Object.freeze({
      async read(learnerId) {
        return structuredClone(snapshots.get(learnerId));
      },
    }),
    catalogue,
    initialSnapshot: snapshot,
    random: () => 0.75,
    now: () => NOW_MS,
  });

  await controller.startRound({ mode: 'smart', length: 5, yearFilter: 'y3-4' });
  assert.deepEqual(snapshots.get('learner-a').monsterStateByRewardTrackId, {});
  assert.equal(controller.getState().monsters[0].branch, null);

  await controller.chooseCompanionBranch({
    rewardTrackId: 'spelling-core-inklet',
    branch: 'b2',
  });
  const saved = snapshots.get('learner-a').monsterStateByRewardTrackId;
  assert.equal(saved['spelling-core-inklet'].branch, 'b2');
  assert.equal(saved['spelling-core-glimmerbug'], undefined);
  assert.equal(
    controller.getState().monsters.find((row) => row.monsterId === 'inklet').branch,
    'b2',
  );
  await controller.dispose();
});

test('unassigned found crossings do not emit a caught celebration', () => {
  const before = [{
    rewardTrackId: 'spelling-core-inklet',
    monsterId: 'inklet',
    thresholds: [1, 10, 30, 60, 100],
    branch: null,
    secureCount: 0,
    caught: false,
    derivedStage: 0,
    earnedStageHighWater: 0,
  }];
  const after = [{ ...before[0], secureCount: 1, caught: true }];
  assert.deepEqual(diffMonsterCelebrations(before, after), []);
});

test('starter-complete still opens when the hatched companion already has a branch', () => {
  const starter = loadStarterSpellingCatalogue();
  const inklet = {
    rewardTrackId: 'spelling-core-inklet',
    monsterId: 'inklet',
    thresholds: [1, 10, 30, 60, 100],
    branch: 'b1',
    secureCount: 10,
    caught: true,
    derivedStage: 1,
    earnedStageHighWater: 1,
  };
  const plan = planSummaryRewards({
    previousScreen: 'practice',
    next: {
      screen: 'summary',
      monsters: [inklet],
      roundBaseline: { monsters: [], sessionId: 's1', achievementIds: [] },
      records: { milestones: [] },
      achievements: [],
      starterCompleteMomentPresented: false,
    },
    remainingWordCount: 193,
    entitled: false,
    starterCatalogue: starter,
  });
  assert.equal(plan.eggChoice, null);
  assert.equal(plan.openMoment, true);
});

test('egg-choice queues ahead of starter-complete when the branch is still null', () => {
  const starter = loadStarterSpellingCatalogue();
  const inklet = {
    rewardTrackId: 'spelling-core-inklet',
    monsterId: 'inklet',
    thresholds: [1, 10, 30, 60, 100],
    branch: null,
    secureCount: 10,
    caught: true,
    derivedStage: 1,
    earnedStageHighWater: 1,
  };
  const plan = planSummaryRewards({
    previousScreen: 'practice',
    next: {
      screen: 'summary',
      monsters: [inklet],
      roundBaseline: { monsters: [], sessionId: 's1', achievementIds: [] },
      records: { milestones: [] },
      achievements: [],
      starterCompleteMomentPresented: false,
    },
    remainingWordCount: 193,
    entitled: false,
    starterCatalogue: starter,
  });
  assert.equal(plan.eggChoice.monsterId, 'inklet');
  assert.equal(plan.openMoment, false);
  assert.deepEqual(plan.pendingMoment, { remainingWordCount: 193 });
});

test('keyboard helper moves between the two eggs', () => {
  const first = { id: 'first' };
  const second = { id: 'second' };
  assert.equal(
    eggChoiceMomentKeyDown({ key: 'ArrowRight', preventDefault() {} }, {
      firstEl: first,
      secondEl: second,
    }).focus,
    second,
  );
  assert.equal(
    eggChoiceMomentKeyDown({ key: 'ArrowUp', preventDefault() {} }, {
      firstEl: first,
      secondEl: second,
    }).focus,
    first,
  );
  const focused = [];
  eggChoiceMomentMountFocus({
    focus(options) {
      focused.push(options);
    },
  });
  assert.deepEqual(focused, [{ preventScroll: true }]);
});

test('egg-choice copy has no purchase language', () => {
  const copy = eggChoiceCopy();
  assert.equal(copy.headline, 'Which egg is yours?');
  assert.equal(copy.body, 'Tap one.');
  assert.doesNotMatch(
    `${copy.headline} ${copy.body} ${copy.announcement}`,
    /£|GBP|USD|\$\d|\bBuy\b|\bupgrade\b|\bpurchase\b|\bStoreKit\b|\bunlock\b/iu,
  );
});

test('Full Phaeton found threshold stays three union words', () => {
  const catalogue = loadFullSpellingCatalogue();
  const y34 = catalogue.items.filter((item) => item.yearBand === '3-4').slice(0, 2);
  const y56 = catalogue.items.filter((item) => item.yearBand === '5-6').slice(0, 1);
  const snapshot = snapshotWithProgress(catalogue, [...y34, ...y56]);
  const phaeton = overlay(catalogue, snapshot).find((row) => row.monsterId === 'phaeton');
  assert.equal(phaeton.secureCount, 3);
  assert.equal(phaeton.caught, true);
  assert.equal(phaeton.derivedStage, 0);
  assert.equal(phaeton.branch, null);
  assert.equal(phaeton.thresholds[0], 3);
  assert.equal(phaeton.thresholds[1], 25);
  assert.equal(pendingEggChoice(overlay(catalogue, snapshot)).monsterId, 'inklet');
});
