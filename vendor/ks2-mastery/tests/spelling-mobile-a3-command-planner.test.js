import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { applySpellingCommand } from '../shared/spelling/mobile/a3/index.js';

const fullCatalogue = JSON.parse(await readFile(
  new URL('../content/spelling.mobile-runtime-full.json', import.meta.url),
  'utf8',
));

const starterCatalogue = JSON.parse(await readFile(
  new URL('../content/spelling.mobile-runtime-starter.json', import.meta.url),
  'utf8',
));

const NOW = 1_768_478_400_000;

function randomFrom(seed = 42) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let result = Math.imul(value ^ (value >>> 15), 1 | value);
    result ^= result + Math.imul(result ^ (result >>> 7), 61 | result);
    return ((result ^ (result >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function snapshot(catalogue = fullCatalogue, { fullMega = false } = {}) {
  const progress = fullMega
    ? Object.fromEntries(catalogue.items.map((item) => [item.runtimeItemId, {
        legacySlug: item.legacySlug,
        stage: 4,
        attempts: 6,
        correct: 5,
        wrong: 1,
        dueDay: Math.floor(NOW / 86_400_000),
        lastDay: Math.floor(NOW / 86_400_000) - 7,
        lastResult: 'correct',
      }]))
    : {};
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
        progress,
        guardianMap: {},
        pattern: { wobblingByRuntimeItemId: {} },
        postMega: fullMega ? {
          unlockedAt: NOW - 86_400_000,
          unlockedContentReleaseId: 'spelling-r7',
          unlockedPublishedCoreCount: catalogue.items.length,
          unlockedBy: 'all-core-stage-4',
        } : null,
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

function apply(current, command, catalogue = fullCatalogue, { now = () => NOW, random = randomFrom() } = {}) {
  return applySpellingCommand({ snapshot: current, command, contentSnapshot: catalogue, now, random });
}

function advance(current, plan) {
  return {
    schemaVersion: 1,
    learnerId: plan.learnerId,
    revision: plan.nextRevision,
    packId: current.packId,
    catalogueId: current.catalogueId,
    grantedEntitlementIds: current.grantedEntitlementIds,
    subjectState: plan.nextSubjectState,
    practiceSession: plan.nextPracticeSession,
    eventLog: plan.nextEventLog,
    monsterStateByRewardTrackId: plan.nextMonsterStateByRewardTrackId,
    campStateByPackId: plan.nextCampStateByPackId,
  };
}

test('planner validates ports, samples time once and never mutates caller data', () => {
  const input = snapshot();
  const before = structuredClone(input);
  let calls = 0;
  const plan = apply(input, {
    type: 'start-session',
    payload: { mode: 'smart', yearFilter: 'core', length: 2, practiceOnly: false, words: [] },
  }, fullCatalogue, { now: () => { calls += 1; return NOW; } });
  assert.equal(calls, 1);
  assert.deepEqual(input, before);
  assert.equal(plan.changed, true);
  assert.equal(plan.nextRevision, 1);
  assert.equal(plan.nextPracticeSession.status, 'active');
  assert.match(plan.nextSubjectState.ui.session.currentRuntimeItemId, /^ks2-core:/);
  assert.equal('currentSlug' in plan.nextSubjectState.ui.session, false);
  assert.throws(() => applySpellingCommand({ snapshot: input, command: { type: 'end-session', payload: {} }, contentSnapshot: fullCatalogue, now: null, random: randomFrom() }), /now/i);
  assert.throws(() => applySpellingCommand({ snapshot: input, command: { type: 'end-session', payload: {} }, contentSnapshot: fullCatalogue, now: () => NaN, random: randomFrom() }), /finite/i);
  assert.throws(() => applySpellingCommand({ snapshot: input, command: { type: 'end-session', payload: {} }, contentSnapshot: fullCatalogue, now: () => NOW, random: null }), /random/i);
});

test('planner drives Smart retry/correction and keeps every durable identity composite', () => {
  let current = snapshot();
  let plan = apply(current, {
    type: 'start-session',
    payload: { mode: 'smart', yearFilter: 'core', length: 1, practiceOnly: false, words: ['ks2-core:answer'] },
  });
  current = advance(current, plan);
  plan = apply(current, { type: 'submit-answer', payload: { typed: 'wrong' } });
  assert.equal(plan.result.state.session.phase, 'retry');
  current = advance(current, plan);
  plan = apply(current, { type: 'submit-answer', payload: { typed: 'answer' } });
  current = advance(current, plan);
  plan = apply(current, { type: 'submit-answer', payload: { typed: 'answer' } });
  assert.ok(plan.appendedEvents.every((event) => !event.wordSlug));
  assert.ok(plan.appendedEvents.filter((event) => event.runtimeItemId).every((event) => event.runtimeItemId.startsWith('ks2-core:')));
});

test('planner preserves practice-only progress and supports save-prefs plus warning acknowledgement', () => {
  let current = snapshot();
  current.subjectState.data.persistenceWarning = { reason: 'storage-save-failed', occurredAt: 1, acknowledged: false };
  let plan = apply(current, {
    type: 'save-prefs',
    payload: { prefs: { mode: 'single', yearFilter: 'core', autoSpeak: false } },
  });
  assert.equal(plan.nextSubjectState.data.prefs.mode, 'single');
  current = advance(current, plan);
  plan = apply(current, { type: 'acknowledge-persistence-warning', payload: {} });
  assert.equal(plan.nextSubjectState.data.persistenceWarning.acknowledged, true);
  current = advance(current, plan);
  const beforeProgress = structuredClone(current.subjectState.data.progress);
  plan = apply(current, {
    type: 'start-session',
    payload: { mode: 'single', yearFilter: 'core', length: 1, practiceOnly: true, words: ['ks2-core:answer'] },
  });
  current = advance(current, plan);
  plan = apply(current, { type: 'submit-answer', payload: { typed: 'answer' } });
  assert.deepEqual(plan.nextSubjectState.data.progress, beforeProgress);
});

test('planner starts all seven A1 modes and preserves post-mastery progress invariants', () => {
  for (const mode of ['smart', 'trouble', 'test', 'single']) {
    const current = snapshot();
    const plan = apply(current, {
      type: 'start-session',
      payload: { mode, yearFilter: 'core', length: mode === 'test' ? 20 : 1, practiceOnly: mode === 'single', words: mode === 'test' ? [] : ['ks2-core:answer'] },
    });
    assert.equal(plan.ok, true, mode);
    assert.equal(plan.result.state.session.mode, mode, mode);
    if (mode === 'test') assert.equal(plan.result.state.session.uniqueItemIds.length, 20);
  }
  for (const [mode, payload] of [
    ['guardian', { mode: 'guardian', yearFilter: 'core', length: 5, practiceOnly: false, words: [] }],
    ['boss', { mode: 'boss', yearFilter: 'core', length: 8, practiceOnly: false, words: [] }],
    ['pattern-quest', { mode: 'pattern-quest', yearFilter: 'core', length: 5, practiceOnly: false, words: [], patternId: 'double-consonant' }],
  ]) {
    const current = snapshot(fullCatalogue, { fullMega: true });
    const before = structuredClone(current.subjectState.data.progress);
    const plan = apply(current, { type: 'start-session', payload });
    assert.equal(plan.ok, true, mode);
    assert.equal(plan.result.state.session.mode, mode, mode);
    assert.deepEqual(plan.nextSubjectState.data.progress, before, `${mode} start cannot alter progress`);
  }
  const starter = snapshot(starterCatalogue, { fullMega: true });
  const attempt = apply(starter, {
    type: 'start-session',
    payload: { mode: 'guardian', yearFilter: 'core', length: 5, practiceOnly: false, words: [] },
  }, starterCatalogue);
  assert.equal(typeof attempt.ok, 'boolean');
});

test('planner completes Guardian wrong, skip and recovery-safe paths without Mega regression', () => {
  let current = snapshot(fullCatalogue, { fullMega: true });
  const originalProgress = structuredClone(current.subjectState.data.progress);
  let plan = apply(current, {
    type: 'start-session',
    payload: { mode: 'guardian', yearFilter: 'core', length: 5, practiceOnly: false, words: [] },
  });
  current = advance(current, plan);
  plan = apply(current, { type: 'submit-answer', payload: { typed: 'definitely-wrong' } });
  assert.ok(Object.values(plan.nextSubjectState.data.progress).every(({ stage }) => stage === 4));
  current = advance(current, plan);
  plan = apply(current, { type: 'continue-session', payload: {} });
  current = advance(current, plan);
  plan = apply(current, { type: 'skip-word', payload: {} });
  current = advance(current, plan);
  plan = apply(current, { type: 'continue-session', payload: {} });
  current = advance(current, plan);
  let guard = 0;
  let completionInput = null;
  let completionCommand = null;
  let completionPlan = null;
  while (current.subjectState.ui.phase === 'session') {
    guard += 1;
    assert.ok(guard < 10);
    const runtimeItemId = current.subjectState.ui.session.currentRuntimeItemId;
    const answer = fullCatalogue.items.find((item) => item.runtimeItemId === runtimeItemId).target;
    const submitCommand = { type: 'submit-answer', payload: { typed: answer } };
    const submitInput = structuredClone(current);
    plan = apply(current, submitCommand);
    if (plan.appendedEvents.some(({ type }) => type === 'spelling.guardian.mission-completed')) {
      completionInput = submitInput;
      completionCommand = submitCommand;
      completionPlan = plan;
    }
    current = advance(current, plan);
    if (current.subjectState.ui.phase === 'session' && current.subjectState.ui.awaitingAdvance) {
      const continueCommand = { type: 'continue-session', payload: {} };
      const continueInput = structuredClone(current);
      plan = apply(current, continueCommand);
      if (plan.appendedEvents.some(({ type }) => type === 'spelling.guardian.mission-completed')) {
        completionInput = continueInput;
        completionCommand = continueCommand;
        completionPlan = plan;
      }
      current = advance(current, plan);
    }
  }
  assert.equal(current.practiceSession.status, 'completed');
  assert.ok(current.eventLog.some(({ type }) => type === 'spelling.guardian.mission-completed'));
  for (const [runtimeItemId, before] of Object.entries(originalProgress)) {
    assert.equal(current.subjectState.data.progress[runtimeItemId].stage, before.stage);
    assert.equal(current.subjectState.data.progress[runtimeItemId].dueDay, before.dueDay);
  }
  const completionEvent = completionPlan.appendedEvents.find(({ type }) => type === 'spelling.guardian.mission-completed');
  const replayInput = structuredClone(completionInput);
  replayInput.eventLog.push(completionEvent);
  const replay = apply(replayInput, completionCommand);
  assert.equal(replay.appendedEvents.some(({ id }) => id === completionEvent.id), false);
  const collisionInput = structuredClone(completionInput);
  collisionInput.eventLog.push({ ...completionEvent, createdAt: completionEvent.createdAt + 1 });
  assert.throws(() => apply(collisionInput, completionCommand), /spelling_event_id_collision/);
});

test('planner keeps Boss wrong answers Mega-safe and completes a five-card Pattern Quest', () => {
  let current = snapshot(fullCatalogue, { fullMega: true });
  const before = structuredClone(current.subjectState.data.progress);
  let plan = apply(current, {
    type: 'start-session',
    payload: { mode: 'boss', yearFilter: 'core', length: 8, practiceOnly: false, words: [] },
  });
  current = advance(current, plan);
  plan = apply(current, { type: 'submit-answer', payload: { typed: 'definitely-wrong' } });
  for (const [runtimeItemId, record] of Object.entries(plan.nextSubjectState.data.progress)) {
    assert.equal(record.stage, before[runtimeItemId].stage);
    assert.equal(record.dueDay, before[runtimeItemId].dueDay);
  }

  current = snapshot(fullCatalogue, { fullMega: true });
  plan = apply(current, {
    type: 'start-session',
    payload: { mode: 'pattern-quest', yearFilter: 'core', length: 5, practiceOnly: false, words: [], patternId: 'double-consonant' },
  });
  current = advance(current, plan);
  let cards = 0;
  while (current.subjectState.ui.phase === 'session') {
    const card = current.subjectState.ui.session.patternQuestCard;
    const item = fullCatalogue.items.find(({ runtimeItemId }) => runtimeItemId === card.runtimeItemId);
    const correctChoice = card.choices?.find(({ correct }) => correct)?.id;
    const typed = cards === 1 ? 'definitely-wrong' : (correctChoice || item.target);
    plan = apply(current, { type: 'submit-answer', payload: { typed } });
    current = advance(current, plan);
    cards += 1;
    if (current.subjectState.ui.phase === 'session' && current.subjectState.ui.awaitingAdvance) {
      plan = apply(current, { type: 'continue-session', payload: {} });
      current = advance(current, plan);
    }
  }
  assert.equal(cards, 5);
  assert.equal(current.practiceSession.status, 'completed');
  assert.ok(current.eventLog.some(({ type }) => type === 'spelling.pattern.quest-completed'));
  assert.ok(Object.values(current.subjectState.data.progress).every(({ stage }) => stage === 4));
});

test('planner rejects stale practice-session state and unknown commands before sampling randomness', () => {
  const current = snapshot();
  current.practiceSession = {
    id: 'stale-session', learnerId: 'learner-a', subjectId: 'spelling', status: 'active', mode: 'smart',
    state: {}, summary: null, startedAt: 0, updatedAt: 0, completedAt: null,
  };
  let draws = 0;
  assert.throws(() => apply(current, { type: 'continue-session', payload: {} }, fullCatalogue, { random: () => { draws += 1; return 0.5; } }));
  assert.equal(draws, 0);
  assert.throws(() => apply(snapshot(), { type: 'word-bank', payload: {} }), /unsupported/i);
});

test('completion preserves historical Guardian session metadata and no-op submissions draw no randomness', () => {
  let current = snapshot(fullCatalogue, { fullMega: true });
  let plan = apply(current, { type: 'start-session', payload: { mode: 'guardian', yearFilter: 'core', length: 5, practiceOnly: false, words: [] } });
  current = advance(current, plan);
  const historical = structuredClone(current.practiceSession.state.session);
  let guard = 0;
  while (current.subjectState.ui.phase === 'session') {
    guard += 1;
    assert.ok(guard < 20);
    const item = fullCatalogue.items.find(({ runtimeItemId }) => runtimeItemId === current.subjectState.ui.session.currentRuntimeItemId);
    plan = apply(current, { type: 'submit-answer', payload: { typed: item.target } });
    current = advance(current, plan);
    if (current.subjectState.ui.phase === 'session' && current.subjectState.ui.awaitingAdvance) {
      let draws = 0;
      const noOp = apply(current, { type: 'submit-answer', payload: { typed: item.target } }, fullCatalogue, { random: () => { draws += 1; return 0.5; } });
      assert.equal(noOp.changed, false);
      assert.equal(draws, 0);
      assert.deepEqual(noOp.nextSubjectState, current.subjectState);
      plan = apply(current, { type: 'continue-session', payload: {} });
      current = advance(current, plan);
    }
  }
  assert.equal(current.subjectState.ui.session, null);
  assert.deepEqual(current.practiceSession.state.session.revisionMission, historical.revisionMission);
  assert.equal(current.practiceSession.summary.sessionId, historical.id);
});
