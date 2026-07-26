import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applySpellingCommand,
  loadStarterSpellingCatalogue,
} from '../src/domain/spelling/index.js';
import {
  expectedB2Snapshot,
  snapshotAfterPlan,
} from './helpers/b2-database-harness.mjs';

// Planner-level contracts for the Workshop trio (smart | trouble | test).
// Cross-checked against ks2-mastery docs/spelling-parity.md:
// - Trouble with no weak words falls back to Smart Review (matched).
// - Trouble after wrongs selects those weak words (matched).
// - SATs Test is single-attempt with no retry/correction phase (matched).
// Intentional product delta: this mobile shell starts rounds with yearFilter
// 'y3-4' and product lengths 5|10|20; the A3 engine still forces test mode to
// the statutory 20-word core pool regardless of the requested length/filter.

const NOW_MS = 1_768_478_400_000;
const START_PAYLOAD_BASE = Object.freeze({
  yearFilter: 'y3-4',
  practiceOnly: false,
  words: [],
});

function createPlannerWorld(initialSnapshot = expectedB2Snapshot('learner-a')) {
  const catalogue = loadStarterSpellingCatalogue();
  let snapshot = structuredClone(initialSnapshot);
  let tick = 0;

  function apply(command) {
    const nowMs = NOW_MS + tick;
    tick += 1;
    const plan = applySpellingCommand({
      snapshot: structuredClone(snapshot),
      command,
      contentSnapshot: catalogue,
      now: () => nowMs,
      random: () => 0.25,
    });
    snapshot = snapshotAfterPlan(snapshot, plan);
    return plan;
  }

  return Object.freeze({
    catalogue,
    get snapshot() {
      return snapshot;
    },
    apply,
    startSession(mode, length = 5) {
      return apply({
        type: 'start-session',
        payload: {
          mode,
          length,
          ...START_PAYLOAD_BASE,
        },
      });
    },
    targetFor(runtimeItemId) {
      const item = catalogue.items.find(
        (candidate) => candidate.runtimeItemId === runtimeItemId,
      );
      assert.ok(item, 'catalogue must contain the live runtime item');
      return item.target;
    },
  });
}

function liveSession(planOrSnapshot) {
  if (planOrSnapshot?.result?.state?.session) {
    return planOrSnapshot.result.state.session;
  }
  return planOrSnapshot?.subjectState?.ui?.session ?? null;
}

async function seedWrongAnswers(world, count = 3) {
  world.startSession('smart', 5);
  const wrongIds = [];

  while (world.snapshot.subjectState.ui.phase === 'session') {
    const session = liveSession(world.snapshot);
    const runtimeItemId = session.currentRuntimeItemId;
    const shouldMiss = wrongIds.length < count && !wrongIds.includes(runtimeItemId);

    if (shouldMiss) {
      wrongIds.push(runtimeItemId);
      world.apply({ type: 'submit-answer', payload: { typed: 'zzzzwrong' } });
      assert.equal(liveSession(world.snapshot).phase, 'retry');
      world.apply({ type: 'submit-answer', payload: { typed: 'zzzzwrong2' } });
      assert.equal(liveSession(world.snapshot).phase, 'correction');
      world.apply({
        type: 'submit-answer',
        payload: { typed: world.targetFor(runtimeItemId) },
      });
    } else {
      world.apply({
        type: 'submit-answer',
        payload: { typed: world.targetFor(runtimeItemId) },
      });
    }

    if (
      world.snapshot.subjectState.ui.phase === 'session' &&
      world.snapshot.subjectState.ui.awaitingAdvance
    ) {
      world.apply({ type: 'continue-session', payload: {} });
    }
  }

  assert.equal(world.snapshot.subjectState.ui.phase, 'summary');
  assert.equal(wrongIds.length, count);
  for (const runtimeItemId of wrongIds) {
    assert.ok(
      world.snapshot.subjectState.data.progress[runtimeItemId]?.wrong > 0,
      `${runtimeItemId} must record a wrong answer`,
    );
  }
  return wrongIds;
}

test('trouble with a fresh snapshot falls back to Smart Review', () => {
  const world = createPlannerWorld();
  const plan = world.startSession('trouble', 5);
  const session = liveSession(plan);

  assert.equal(plan.ok, true);
  // A3 field names pinned from the vendored session contract:
  // session.fallbackToSmart, session.mode, session.label, session.type.
  assert.equal(session.fallbackToSmart, true);
  assert.equal(session.mode, 'smart');
  assert.equal(session.label, 'Smart review');
  assert.equal(session.type, 'learning');
  assert.ok(Array.isArray(session.uniqueItemIds));
  assert.equal(session.uniqueItemIds.length, 5);
});

test('trouble after seeded wrongs selects those weak words', async () => {
  const world = createPlannerWorld();
  const wrongIds = await seedWrongAnswers(world, 3);

  const plan = world.startSession('trouble', 5);
  const session = liveSession(plan);

  assert.equal(plan.ok, true);
  assert.equal(session.fallbackToSmart, false);
  assert.equal(session.mode, 'trouble');
  assert.equal(session.label, 'Trouble drill');
  assert.equal(session.type, 'learning');
  assert.deepEqual(
    [...session.uniqueItemIds].sort(),
    [...wrongIds].sort(),
  );
});

test('test mode is single-attempt with no retry phase and a test summary', () => {
  const world = createPlannerWorld();
  const plan = world.startSession('test', 5);
  const session = liveSession(plan);

  assert.equal(plan.ok, true);
  assert.equal(session.mode, 'test');
  assert.equal(session.type, 'test');
  assert.equal(session.label, 'SATs 20 test');
  assert.equal(session.phase, 'question');
  // Engine owns the SATs length override (always 20), even when the product
  // startRound length is 5|10|20.
  assert.equal(session.uniqueItemIds.length, 20);
  assert.equal(session.progress.total, 20);

  const firstId = session.currentRuntimeItemId;
  world.apply({ type: 'submit-answer', payload: { typed: 'zzzzwrong' } });

  const afterWrong = world.snapshot.subjectState.ui;
  // Pin the actual phase sequence: test wrong stays on phase 'question'
  // (no 'retry' / 'correction') and advances via awaitingAdvance.
  assert.equal(afterWrong.phase, 'session');
  assert.equal(afterWrong.session.phase, 'question');
  assert.notEqual(afterWrong.session.phase, 'retry');
  assert.notEqual(afterWrong.session.phase, 'correction');
  assert.equal(afterWrong.awaitingAdvance, true);
  assert.equal(afterWrong.feedback?.kind, 'info');
  assert.equal(afterWrong.session.results.length, 1);
  assert.equal(afterWrong.session.results[0].correct, false);
  assert.equal(afterWrong.session.results[0].runtimeItemId, firstId);

  world.apply({ type: 'continue-session', payload: {} });

  let guard = 0;
  while (world.snapshot.subjectState.ui.phase === 'session') {
    guard += 1;
    assert.ok(guard < 60);
    if (world.snapshot.subjectState.ui.awaitingAdvance) {
      world.apply({ type: 'continue-session', payload: {} });
      continue;
    }
    const runtimeItemId =
      world.snapshot.subjectState.ui.session.currentRuntimeItemId;
    world.apply({
      type: 'submit-answer',
      payload: { typed: world.targetFor(runtimeItemId) },
    });
  }

  const summary = world.snapshot.subjectState.ui.summary;
  assert.equal(world.snapshot.subjectState.ui.phase, 'summary');
  assert.equal(summary.mode, 'test');
  assert.equal(summary.label, 'SATs 20 test');
  assert.equal(summary.totalWords, 20);
  assert.equal(summary.correct, 19);
  assert.equal(summary.accuracy, 95);
  assert.equal(summary.cards[1].sub, 'Single attempt per word');
  assert.equal(summary.mistakes.length, 1);
  assert.equal(summary.mistakes[0].runtimeItemId, firstId);
});
