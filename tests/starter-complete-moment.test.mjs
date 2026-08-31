import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadFullSpellingCatalogue,
  loadStarterSpellingCatalogue,
} from '../src/domain/spelling/index.js';
import {
  coreItemCount,
  remainingStarterWordCount,
  starterBandItemCount,
  hatchedCompanionAsksGrownUp,
  starterCompleteLearnerIsEntitled,
  starterCompleteMomentCopy,
  starterCompleteMomentCrossed,
  starterCompleteMomentDecision,
  starterYearBandIsSecure,
  starterYearBandTracks,
  readAndConsumeStarterCompleteMoment,
  monstersFromSnapshot,
} from '../src/app/starter-complete-moment.js';
import {
  acknowledgeStarterCompleteMoment,
  createStarterCompleteAskGrownUpHandler,
  planSummaryRewards,
  revealStarterCompleteAfterCelebrations,
  starterCompleteMomentKeyDown,
  starterCompleteMomentMountFocus,
  starterCompleteMomentRestoreFocus,
} from '../src/app/starter-complete-moment-runtime.js';

function catalogue({ yearBands = { '3-4': 10, '5-6': 10 }, extraItems = [] } = {}) {
  const items = [...extraItems];
  const rewardTracks = [];
  for (const [yearBand, count] of Object.entries(yearBands)) {
    const monsterId = yearBand === '3-4' ? 'inklet' : 'glimmerbug';
    rewardTracks.push({
      rewardTrackId: `spelling-core-${monsterId}`,
      packId: 'ks2-core',
      monsterId,
      yearBand,
      thresholds: [1, count, 30, 60, 100],
    });
    for (let index = 0; index < count; index += 1) {
      items.push({
        runtimeItemId: `ks2-core:${yearBand}:${index}`,
        yearBand,
        coverageTier: 'statutory-core',
      });
    }
  }
  return { items, rewardTracks };
}

function monster(overrides = {}) {
  return {
    rewardTrackId: 'spelling-core-inklet',
    packId: 'ks2-core',
    monsterId: 'inklet',
    thresholds: [1, 10, 30, 60, 100],
    branch: 'b1',
    secureCount: 0,
    caught: false,
    derivedStage: 0,
    earnedStageHighWater: 0,
    ...overrides,
  };
}

function inklet(secureCount) {
  return monster({ secureCount, caught: secureCount > 0 });
}

function glimmerbug(secureCount) {
  return monster({
    rewardTrackId: 'spelling-core-glimmerbug',
    monsterId: 'glimmerbug',
    secureCount,
    caught: secureCount > 0,
  });
}

function phaeton(secureCount) {
  return monster({
    rewardTrackId: 'spelling-core-phaeton',
    monsterId: 'phaeton',
    aggregate: true,
    sourceRewardTrackIds: ['spelling-core-inklet', 'spelling-core-glimmerbug'],
    thresholds: [3, 25, 95, 145, 213],
    secureCount,
  });
}

test('Starter remains 20 core items, ten in each year band, from the catalogue', () => {
  const starter = loadStarterSpellingCatalogue();
  assert.equal(coreItemCount(starter), 20);
  assert.equal(starterBandItemCount(starter, '3-4'), 10);
  assert.equal(starterBandItemCount(starter, '5-6'), 10);
  assert.deepEqual(
    starterYearBandTracks(starter).map((track) => ({
      rewardTrackId: track.rewardTrackId,
      yearBand: track.yearBand,
    })),
    [
      { rewardTrackId: 'spelling-core-inklet', yearBand: '3-4' },
      { rewardTrackId: 'spelling-core-glimmerbug', yearBand: '5-6' },
    ],
  );
});

test('remaining count is full core minus Starter core, not a stored 193', () => {
  const starter = loadStarterSpellingCatalogue();
  const full = loadFullSpellingCatalogue();
  const remaining = remainingStarterWordCount({
    starterCatalogue: starter,
    fullCatalogue: full,
  });
  assert.equal(remaining, coreItemCount(full) - coreItemCount(starter));
  assert.equal(remaining, 193);

  assert.equal(
    remainingStarterWordCount({
      starterCatalogue: catalogue({ yearBands: { '3-4': 2, '5-6': 2 } }),
      fullCatalogue: { items: Array.from({ length: 7 }, () => ({ coverageTier: 'statutory-core' })) },
    }),
    3,
  );
});

test('either Starter year band reaching its own item count is a crossing', () => {
  const starter = catalogue();
  assert.equal(
    starterCompleteMomentCrossed({
      beforeMonsters: [inklet(9), glimmerbug(0)],
      afterMonsters: [inklet(10), glimmerbug(0)],
      starterCatalogue: starter,
    }),
    true,
  );
  assert.equal(
    starterCompleteMomentCrossed({
      beforeMonsters: [inklet(0), glimmerbug(9)],
      afterMonsters: [inklet(0), glimmerbug(10)],
      starterCatalogue: starter,
    }),
    true,
  );
  assert.equal(
    starterYearBandIsSecure([inklet(9), glimmerbug(9)], starter),
    false,
  );
});

test('the per-band threshold is the Starter catalogue count, not a hard-coded ten', () => {
  const eightWordBand = catalogue({ yearBands: { '3-4': 8, '5-6': 12 } });
  assert.equal(starterYearBandIsSecure([inklet(7), glimmerbug(0)], eightWordBand), false);
  assert.equal(starterYearBandIsSecure([inklet(8), glimmerbug(0)], eightWordBand), true);
  assert.equal(starterYearBandIsSecure([inklet(0), glimmerbug(11)], eightWordBand), false);
  assert.equal(starterYearBandIsSecure([inklet(0), glimmerbug(12)], eightWordBand), true);
});

test('aggregate Phaeton evidence is not a Starter year-band threshold', () => {
  const starter = loadStarterSpellingCatalogue();
  assert.equal(
    starterYearBandIsSecure([phaeton(213), inklet(0), glimmerbug(0)], starter),
    false,
  );
});

test('a live round crossing shows once and asks to persist', () => {
  const starter = catalogue();
  assert.deepEqual(
    starterCompleteMomentDecision({
      beforeMonsters: [inklet(9), glimmerbug(0)],
      afterMonsters: [inklet(10), glimmerbug(0)],
      starterCatalogue: starter,
      presented: false,
      remainingWordCount: 193,
      source: 'round',
    }),
    { show: true, persist: true },
  );
});

test('a presented flag suppresses a later live crossing', () => {
  const starter = catalogue();
  assert.deepEqual(
    starterCompleteMomentDecision({
      beforeMonsters: [inklet(0), glimmerbug(9)],
      afterMonsters: [inklet(0), glimmerbug(10)],
      starterCatalogue: starter,
      presented: true,
      remainingWordCount: 193,
      source: 'round',
    }),
    { show: false, persist: true },
  );
});

test('restart, reset, import, replica and reseed consume without showing', () => {
  const starter = catalogue();
  const alreadySecure = {
    beforeMonsters: [inklet(10), glimmerbug(0)],
    afterMonsters: [inklet(10), glimmerbug(0)],
    starterCatalogue: starter,
    presented: false,
    remainingWordCount: 193,
  };
  for (const source of ['restart', 'reset', 'import', 'replica', 'reseed']) {
    assert.deepEqual(
      starterCompleteMomentDecision({ ...alreadySecure, source }),
      { show: false, persist: true },
      `${source} must persist without showing`,
    );
  }
});

test('an entitled device never shows the child-facing moment', () => {
  const starter = catalogue();
  assert.deepEqual(
    starterCompleteMomentDecision({
      beforeMonsters: [inklet(9)],
      afterMonsters: [inklet(10)],
      starterCatalogue: starter,
      presented: false,
      entitled: true,
      remainingWordCount: 193,
      source: 'round',
    }),
    { show: false, persist: true },
  );
});

test('a remaining count of zero is not a signpost', () => {
  const starter = catalogue();
  assert.deepEqual(
    starterCompleteMomentDecision({
      beforeMonsters: [inklet(9)],
      afterMonsters: [inklet(10)],
      starterCatalogue: starter,
      remainingWordCount: 0,
      source: 'round',
    }),
    { show: false, persist: true },
  );
});

test('copy states the derived remaining count and names a grown-up, not a transaction', () => {
  const remaining = remainingStarterWordCount({
    starterCatalogue: loadStarterSpellingCatalogue(),
    fullCatalogue: loadFullSpellingCatalogue(),
  });
  const copy = starterCompleteMomentCopy(remaining);
  assert.equal(copy.body, `There are ${remaining} more words waiting.`);
  assert.equal(copy.grownUpAction, 'Ask a grown-up');
  assert.doesNotMatch(
    `${copy.eyebrow} ${copy.headline} ${copy.body} ${copy.grownUpAction} ${copy.continueAction} ${copy.announcement}`,
    /£|Buy|upgrade|purchase|StoreKit|unlock/iu,
  );
  assert.equal(
    starterCompleteMomentCopy(1).body,
    'There is 1 more word waiting.',
  );
});

test('a hatched trial companion keeps a re-openable Ask-a-grown-up entry', () => {
  assert.equal(hatchedCompanionAsksGrownUp({ stage: 1, entitled: false }), true);
  assert.equal(hatchedCompanionAsksGrownUp({ stage: 0, entitled: false }), false);
  assert.equal(hatchedCompanionAsksGrownUp({ stage: 1, entitled: true }), false);
});

test('child paywall entitled matches overlay: Full session or active commerce', () => {
  assert.equal(
    starterCompleteLearnerIsEntitled({
      catalogueId: 'ks2-core:starter',
      entitlementState: 'none',
    }),
    false,
  );
  assert.equal(
    starterCompleteLearnerIsEntitled({
      catalogueId: 'ks2-core:starter',
      entitlementState: 'active',
    }),
    true,
  );
  assert.equal(
    starterCompleteLearnerIsEntitled({
      catalogueId: 'ks2-core:full',
      entitlementState: 'none',
    }),
    true,
  );
  assert.equal(
    starterCompleteLearnerIsEntitled({
      catalogueId: 'ks2-core:starter',
      entitlementState: 'revoked',
    }),
    false,
  );
});

test('snapshot monster rows feed the same year-band predicate', () => {
  const starter = catalogue();
  const snapshot = {
    monsterStateByRewardTrackId: {
      'spelling-core-inklet': { monsterId: 'inklet', secureCount: 10 },
    },
  };
  assert.equal(
    starterYearBandIsSecure(monstersFromSnapshot(snapshot), starter),
    true,
  );
});

test('readAndConsume persists a replica-applied secure roster without showing', async () => {
  const records = new Map();
  const store = {
    async read(learnerId) {
      return records.get(learnerId) ?? null;
    },
    async write(learnerId, record) {
      records.set(learnerId, { presented: record.presented === true });
      return records.get(learnerId);
    },
  };
  const presented = await readAndConsumeStarterCompleteMoment({
    store,
    learnerId: 'learner-a',
    monsters: [inklet(10)],
    starterCatalogue: catalogue(),
    remainingWordCount: 193,
    source: 'replica',
  });
  assert.equal(presented, true);
  assert.deepEqual(records.get('learner-a'), { presented: true });

  const again = starterCompleteMomentDecision({
    beforeMonsters: [inklet(9)],
    afterMonsters: [inklet(10)],
    starterCatalogue: catalogue(),
    presented: true,
    remainingWordCount: 193,
    source: 'round',
  });
  assert.equal(again.show, false);
});

function summaryNext({ monsters, beforeMonsters, presented = false }) {
  return {
    screen: 'summary',
    monsters,
    starterCompleteMomentPresented: presented,
    roundBaseline: {
      sessionId: 'session-1',
      monsters: beforeMonsters,
      camp: { packId: 'ks2-core', campHighWater: 0 },
    },
    camp: { packId: 'ks2-core', campHighWater: 0 },
    records: { milestones: [] },
    achievements: [],
  };
}

test('a live crossing with celebration events stays closed until the queue is done', () => {
  const starter = loadStarterSpellingCatalogue();
  const remaining = remainingStarterWordCount({
    starterCatalogue: starter,
    fullCatalogue: loadFullSpellingCatalogue(),
  });
  const plan = planSummaryRewards({
    previousScreen: 'practice',
    next: summaryNext({
      beforeMonsters: [inklet(9)],
      monsters: [inklet(10)],
    }),
    remainingWordCount: remaining,
    entitled: false,
    starterCatalogue: starter,
  });
  assert.ok(plan.celebrationEvents.length > 0);
  assert.equal(plan.openMoment, false);
  assert.deepEqual(plan.pendingMoment, { remainingWordCount: remaining });
  assert.equal(revealStarterCompleteAfterCelebrations(plan.pendingMoment), true);
});

test('a live crossing with an empty celebration queue opens the signpost immediately', () => {
  const starter = loadStarterSpellingCatalogue();
  const remaining = remainingStarterWordCount({
    starterCatalogue: starter,
    fullCatalogue: loadFullSpellingCatalogue(),
  });
  const plan = planSummaryRewards({
    previousScreen: 'practice',
    next: summaryNext({
      beforeMonsters: [],
      monsters: [inklet(10)],
    }),
    remainingWordCount: remaining,
    entitled: false,
    starterCatalogue: starter,
  });
  assert.deepEqual(plan.celebrationEvents, []);
  assert.equal(plan.openMoment, true);
  assert.deepEqual(plan.pendingMoment, { remainingWordCount: remaining });
});

test('acknowledgeStarterCompleteMoment dismisses only after persist succeeds', async () => {
  const calls = [];
  const inFlight = { current: false };
  const ok = await acknowledgeStarterCompleteMoment({
    inFlight,
    async persist() { calls.push('persist'); },
    dismiss() { calls.push('dismiss'); },
  });
  assert.equal(ok, true);
  assert.deepEqual(calls, ['persist', 'dismiss']);
  assert.equal(inFlight.current, false);
});

test('acknowledgeStarterCompleteMoment keeps the moment on persist rejection', async () => {
  const calls = [];
  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const ok = await acknowledgeStarterCompleteMoment({
      inFlight: { current: false },
      async persist() {
        calls.push('persist');
        throw new Error('disk_full');
      },
      dismiss() { calls.push('dismiss'); },
    });
    await Promise.resolve();
    assert.equal(ok, false);
    assert.deepEqual(calls, ['persist']);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('acknowledgeStarterCompleteMoment keeps the moment when persist is unavailable', async () => {
  const calls = [];
  const ok = await acknowledgeStarterCompleteMoment({
    inFlight: { current: false },
    persist() {
      throw new TypeError('Starter complete persist is unavailable.');
    },
    dismiss() { calls.push('dismiss'); },
  });
  assert.equal(ok, false);
  assert.deepEqual(calls, []);
});

test('acknowledgeStarterCompleteMoment ignores a second call while persist is in flight', async () => {
  const calls = [];
  const inFlight = { current: false };
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const first = acknowledgeStarterCompleteMoment({
    inFlight,
    async persist() {
      calls.push('persist');
      await held;
    },
    dismiss() { calls.push('dismiss'); },
  });
  const second = await acknowledgeStarterCompleteMoment({
    inFlight,
    async persist() { calls.push('persist-2'); },
    dismiss() { calls.push('dismiss-2'); },
  });
  assert.equal(second, false);
  release();
  assert.equal(await first, true);
  assert.deepEqual(calls, ['persist', 'dismiss']);
});

test('createStarterCompleteAskGrownUpHandler opens Parent only after persist succeeds', async () => {
  const calls = [];
  const ask = createStarterCompleteAskGrownUpHandler({
    async persist() { calls.push('persist'); return true; },
    openParent() { calls.push('openParent'); },
  });
  assert.equal(await ask(), true);
  assert.deepEqual(calls, ['persist', 'openParent']);
});

test('createStarterCompleteAskGrownUpHandler does not open Parent when persist fails', async () => {
  const calls = [];
  const ask = createStarterCompleteAskGrownUpHandler({
    async persist() { calls.push('persist'); return false; },
    openParent() { calls.push('openParent'); },
  });
  assert.equal(await ask(), false);
  assert.deepEqual(calls, ['persist']);
});

test('starterCompleteMoment helpers return Escape-continue, Tab wrap and restore-focus actions', () => {
  const continueEl = { id: 'continue' };
  const grownUpEl = { id: 'grown-up' };
  const prevented = [];
  const escape = starterCompleteMomentKeyDown(
    { key: 'Escape', preventDefault() { prevented.push('escape'); } },
    { continueEl, grownUpEl },
  );
  assert.deepEqual(escape, { action: 'continue' });
  assert.deepEqual(prevented, ['escape']);

  const wrapForward = starterCompleteMomentKeyDown(
    { key: 'Tab', shiftKey: false, preventDefault() { prevented.push('tab'); } },
    { continueEl, grownUpEl, active: grownUpEl },
  );
  assert.deepEqual(wrapForward, { focus: continueEl });

  const wrapBack = starterCompleteMomentKeyDown(
    { key: 'Tab', shiftKey: true, preventDefault() { prevented.push('shift-tab'); } },
    { continueEl, grownUpEl, active: continueEl },
  );
  assert.deepEqual(wrapBack, { focus: grownUpEl });

  const focused = [];
  starterCompleteMomentMountFocus({
    focus(options) { focused.push(options); },
  });
  assert.deepEqual(focused, [{ preventScroll: true }]);

  const restored = [];
  starterCompleteMomentRestoreFocus({ focus() { restored.push('previous'); } });
  assert.deepEqual(restored, ['previous']);
});
