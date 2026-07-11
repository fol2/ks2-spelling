import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  applySpellingCommand,
  projectSpellingCampTransition,
} from '../shared/spelling/mobile/a3/index.js';

const fullCatalogue = JSON.parse(await readFile(
  new URL('../content/spelling.mobile-runtime-full.json', import.meta.url),
  'utf8',
));
const starterCatalogue = JSON.parse(await readFile(
  new URL('../content/spelling.mobile-runtime-starter.json', import.meta.url),
  'utf8',
));

const DAY_MS = 86_400_000;
const DAY = 20_500;

function mission({
  sessionId = 'sess-1', learnerId = 'learner-a', packId = 'ks2-core',
  kind = 'due', startedGuardianDay = DAY, campEligible = true,
} = {}) {
  return { sessionId, learnerId, packId, kind, startedGuardianDay, campEligible };
}

function completion({
  sessionId = 'sess-1', learnerId = 'learner-a', packId = 'ks2-core',
  mode = 'guardian', day = DAY, createdAt = day * DAY_MS,
} = {}) {
  return {
    id: `spelling.guardian.mission-completed:${learnerId}:${sessionId}`,
    type: 'spelling.guardian.mission-completed',
    subjectId: 'spelling',
    learnerId,
    sessionId,
    mode,
    createdAt,
    packId,
    totalWords: 3,
    renewalCount: 1,
    wobbledCount: 1,
    recoveredCount: 1,
  };
}

function camp({
  learnerId = 'learner-a', day = DAY - 1, highWater = 4,
  eventId = `spelling.guardian.mission-completed:${learnerId}:sess-old`,
} = {}) {
  return {
    packId: 'ks2-core',
    campHighWater: highWater,
    lastCreditedGuardianDay: day,
    lastCreditedEventId: eventId,
    acknowledgements: [],
  };
}

function project({
  learnerId = 'learner-a', packId = 'ks2-core', catalogue = fullCatalogue,
  grantedEntitlementIds = ['full-ks2'], currentState = undefined,
  completedEvent = completion({ learnerId, packId }),
  revisionMission = mission({ learnerId, packId }),
} = {}) {
  return projectSpellingCampTransition({
    learnerId, packId, catalogue, grantedEntitlementIds, currentState,
    completedEvent, revisionMission,
  });
}

function commandSnapshot({ learnerId = 'learner-a' } = {}) {
  return {
    schemaVersion: 1,
    learnerId,
    revision: 0,
    packId: fullCatalogue.packId,
    catalogueId: fullCatalogue.catalogueId,
    grantedEntitlementIds: ['full-ks2'],
    subjectState: {
      ui: {},
      data: {
        prefs: { autoSpeak: false },
        progress: Object.fromEntries(fullCatalogue.items.map((item) => [item.runtimeItemId, {
          legacySlug: item.legacySlug,
          stage: 4,
          attempts: 4,
          correct: 4,
          wrong: 0,
          dueDay: DAY,
          lastDay: DAY - 7,
          lastResult: 'correct',
        }])),
        guardianMap: {},
        pattern: { wobblingByRuntimeItemId: {} },
        postMega: {
          unlockedAt: (DAY - 1) * DAY_MS,
          unlockedContentReleaseId: 'spelling-r7',
          unlockedPublishedCoreCount: fullCatalogue.items.length,
          unlockedBy: 'all-core-stage-4',
        },
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

function applyCommand(current, command, { nowMs = DAY * DAY_MS, random = () => 0.25 } = {}) {
  return applySpellingCommand({
    snapshot: current,
    command,
    contentSnapshot: fullCatalogue,
    now: () => nowMs,
    random,
  });
}

function advance(current, plan) {
  return {
    ...current,
    revision: plan.nextRevision,
    subjectState: plan.nextSubjectState,
    practiceSession: plan.nextPracticeSession,
    eventLog: plan.nextEventLog,
    monsterStateByRewardTrackId: plan.nextMonsterStateByRewardTrackId,
    campStateByPackId: plan.nextCampStateByPackId,
  };
}

function completeGuardian(current, { nowMs = DAY * DAY_MS } = {}) {
  let completionPlan = null;
  let guard = 0;
  while (current.subjectState.ui.phase === 'session') {
    guard += 1;
    assert.ok(guard < 30, 'Guardian fixture should complete within a bounded number of commands');
    const runtimeItemId = current.subjectState.ui.session.currentRuntimeItemId;
    const item = fullCatalogue.items.find((candidate) => candidate.runtimeItemId === runtimeItemId);
    let plan = applyCommand(current, {
      type: 'submit-answer', payload: { typed: item.target },
    }, { nowMs });
    if (plan.appendedEvents.some(({ type }) => type === 'spelling.guardian.mission-completed')) completionPlan = plan;
    current = advance(current, plan);
    if (current.subjectState.ui.phase === 'session' && current.subjectState.ui.awaitingAdvance === true) {
      plan = applyCommand(current, { type: 'continue-session', payload: {} }, { nowMs });
      if (plan.appendedEvents.some(({ type }) => type === 'spelling.guardian.mission-completed')) completionPlan = plan;
      current = advance(current, plan);
    }
  }
  assert.ok(completionPlan, 'Guardian fixture must emit a completion event');
  return { current, completionPlan };
}

test('first eligible first-patrol, due and wobbling completion credits exactly one', () => {
  for (const kind of ['first-patrol', 'due', 'wobbling']) {
    const result = project({ revisionMission: mission({ kind }) });
    assert.equal(result.creditApplied, 1);
    assert.equal(result.campHighWater, 1);
    assert.equal(result.lastCreditedGuardianDay, DAY);
    assert.equal(result.lastCreditedEventId, completion().id);
    assert.equal(result.canEarnToday, false);
  }
});

test('same-day distinct completion, exact replay and clock rollback credit zero and preserve audit evidence', () => {
  const currentState = camp({ day: DAY, eventId: 'spelling.guardian.mission-completed:learner-a:sess-first' });
  for (const completedEvent of [
    completion({ sessionId: 'sess-2' }),
    completion({ sessionId: 'sess-first' }),
    completion({ sessionId: 'sess-older', day: DAY - 1 }),
  ]) {
    const result = project({
      currentState,
      completedEvent,
      revisionMission: mission({ sessionId: completedEvent.sessionId }),
    });
    assert.equal(result.creditApplied, 0);
    assert.equal(result.campHighWater, 4);
    assert.equal(result.lastCreditedGuardianDay, DAY);
    assert.equal(result.lastCreditedEventId, currentState.lastCreditedEventId);
  }
});

test('following-day completion credits once and a fresh day-zero mission remains creditable', () => {
  const following = project({
    currentState: camp({ day: DAY }),
    completedEvent: completion({ sessionId: 'sess-next', day: DAY + 1 }),
    revisionMission: mission({ sessionId: 'sess-next' }),
  });
  assert.equal(following.creditApplied, 1);
  assert.equal(following.campHighWater, 5);
  assert.equal(following.lastCreditedGuardianDay, DAY + 1);

  const dayZero = project({
    completedEvent: completion({ day: 0 }),
    revisionMission: mission({ startedGuardianDay: 0 }),
  });
  assert.equal(dayZero.creditApplied, 1);
  assert.equal(dayZero.lastCreditedGuardianDay, 0);
});

test('completion day owns the tuple while immutable origin kind and camp eligibility survive midnight', () => {
  const afterMidnight = project({
    completedEvent: completion({ day: DAY + 1 }),
    revisionMission: mission({ kind: 'first-patrol', startedGuardianDay: DAY }),
  });
  assert.equal(afterMidnight.creditApplied, 1);
  assert.equal(afterMidnight.completedGuardianDay, DAY + 1);

  const unrewarded = project({
    completedEvent: completion({ day: DAY + 1 }),
    revisionMission: mission({ kind: 'due', startedGuardianDay: DAY, campEligible: false }),
  });
  assert.equal(unrewarded.creditApplied, 0);
  assert.equal(unrewarded.campHighWater, 0);
});

test('locked, rested, optional and non-Guardian completions are valid zero-credit evidence', () => {
  for (const [kind, mode] of [
    ['locked', 'guardian'], ['rested', 'guardian'], ['optional-patrol', 'guardian'], ['due', 'smart'],
  ]) {
    const result = project({
      completedEvent: completion({ mode }),
      revisionMission: mission({ kind }),
    });
    assert.equal(result.creditApplied, 0);
    assert.equal(result.campHighWater, 0);
  }
});

test('Starter, missing Full entitlement and incomplete entitlement grants credit zero', () => {
  assert.equal(project({ catalogue: starterCatalogue, grantedEntitlementIds: [] }).creditApplied, 0);
  assert.equal(project({ grantedEntitlementIds: [] }).creditApplied, 0);

  const extended = structuredClone(fullCatalogue);
  extended.entitlementIds.push('future-entitlement');
  assert.equal(project({ catalogue: extended, grantedEntitlementIds: ['full-ks2'] }).creditApplied, 0);
});

test('learner, pack, catalogue, session and deterministic completion ownership tampering fails closed', () => {
  const mutations = [
    () => project({ completedEvent: completion({ learnerId: 'learner-b' }) }),
    () => project({ completedEvent: completion({ packId: 'another-pack' }) }),
    () => project({ revisionMission: mission({ sessionId: 'sess-other' }) }),
    () => project({ revisionMission: mission({ learnerId: 'learner-b' }) }),
    () => project({ revisionMission: mission({ packId: 'another-pack' }) }),
    () => project({ packId: 'another-pack' }),
    () => project({ completedEvent: { ...completion(), id: 'forged' } }),
    () => project({ completedEvent: { ...completion(), createdAt: -1 } }),
  ];
  for (const mutate of mutations) assert.throws(mutate, /learner|pack|catalogue|session|deterministic|timestamp|ownership/i);
});

test('two learners and two entitled Full pack identities have independent Camp records', () => {
  const learnerA = project();
  const learnerB = project({ learnerId: 'learner-b' });
  assert.equal(learnerA.creditApplied, 1);
  assert.equal(learnerB.creditApplied, 1);
  assert.match(learnerB.lastCreditedEventId, /learner-b/);

  const future = structuredClone(fullCatalogue);
  future.packId = 'future-pack';
  future.catalogueId = 'future-pack:full';
  future.entitlementIds = ['future-pack-full'];
  for (const item of future.items) {
    item.packId = 'future-pack';
    item.runtimeItemId = `future-pack:${item.itemId}`;
  }
  for (const track of future.rewardTracks) {
    track.packId = 'future-pack';
  }
  const futureResult = project({
    packId: 'future-pack', catalogue: future, grantedEntitlementIds: ['future-pack-full'],
    completedEvent: completion({ packId: 'future-pack' }),
    revisionMission: mission({ packId: 'future-pack' }),
  });
  assert.equal(futureResult.creditApplied, 1);
  assert.equal(futureResult.packId, 'future-pack');
  assert.equal(learnerA.packId, 'ks2-core');
});

test('Starter and Full catalogue variants resolve to the same ks2-core Camp record', () => {
  const existing = camp({ day: DAY - 1 });
  const starter = project({
    catalogue: starterCatalogue,
    grantedEntitlementIds: [],
    currentState: existing,
  });
  assert.equal(starter.creditApplied, 0);
  assert.equal(starter.packId, 'ks2-core');
  assert.equal(starter.campHighWater, 4);

  const full = project({ currentState: existing });
  assert.equal(full.creditApplied, 1);
  assert.equal(full.packId, 'ks2-core');
  assert.equal(full.campHighWater, 5);
});

test('malformed and negative Camp state fails closed', () => {
  const invalidStates = [
    { ...camp(), campHighWater: -1 },
    { ...camp(), campHighWater: 1.5 },
    { ...camp(), lastCreditedGuardianDay: -1 },
    { ...camp(), lastCreditedEventId: null },
    { ...camp(), unknown: true },
  ];
  for (const currentState of invalidStates) {
    assert.throws(() => project({ currentState }), /Camp|high.?water|day|event|field|evidence/i);
  }
});

test('planner enriches the deterministic A1 completion and ratchets Camp atomically without touching Monster or Mega progress', () => {
  const initial = commandSnapshot();
  const start = applyCommand(initial, {
    type: 'start-session',
    payload: { mode: 'guardian', yearFilter: 'core', length: 5, practiceOnly: false, words: [] },
  });
  const active = advance(initial, start);
  const beforeProgress = structuredClone(active.subjectState.data.progress);
  const beforeMonsters = structuredClone(active.monsterStateByRewardTrackId);
  const originMission = structuredClone(active.practiceSession.state.session.revisionMission);
  const originIntegrity = active.practiceSession.state.session.revisionMissionIntegrity;
  const { current, completionPlan } = completeGuardian(active);
  const event = completionPlan.appendedEvents.find(({ type }) => type === 'spelling.guardian.mission-completed');

  assert.equal(event.packId, 'ks2-core');
  assert.equal(event.id, `spelling.guardian.mission-completed:learner-a:${originMission.sessionId}`);
  assert.equal(current.campStateByPackId['ks2-core'].campHighWater, 1);
  assert.equal(current.campStateByPackId['ks2-core'].lastCreditedGuardianDay, DAY);
  assert.equal(current.campStateByPackId['ks2-core'].lastCreditedEventId, event.id);
  assert.equal(completionPlan.projections.camp.creditApplied, 1);
  assert.equal(completionPlan.projections.camp.canEarnToday, false);
  assert.equal(completionPlan.projections.revisionMission.missionState, 'rested');
  assert.equal(completionPlan.projections.revisionMission.campCreditState, 'complete-for-today');
  assert.deepEqual(current.practiceSession.state.session.revisionMission, originMission);
  assert.equal(current.practiceSession.state.session.revisionMissionIntegrity, originIntegrity);
  for (const [runtimeItemId, previous] of Object.entries(beforeProgress)) {
    assert.equal(current.subjectState.data.progress[runtimeItemId].stage, previous.stage);
    assert.equal(current.subjectState.data.progress[runtimeItemId].dueDay, previous.dueDay);
  }
  assert.deepEqual(current.monsterStateByRewardTrackId, beforeMonsters);
});

test('planner credits the completion day across midnight but never upgrades an unrewarded origin', () => {
  const initial = commandSnapshot();
  const started = applyCommand(initial, {
    type: 'start-session',
    payload: { mode: 'guardian', yearFilter: 'core', length: 5, practiceOnly: false, words: [] },
  });
  const rewardBearing = advance(initial, started);
  const rewardMission = structuredClone(rewardBearing.practiceSession.state.session.revisionMission);
  const rewardCompletion = completeGuardian(rewardBearing, { nowMs: (DAY + 1) * DAY_MS });
  assert.equal(rewardMission.startedGuardianDay, DAY);
  assert.equal(rewardCompletion.completionPlan.projections.camp.completedGuardianDay, DAY + 1);
  assert.equal(rewardCompletion.current.campStateByPackId['ks2-core'].lastCreditedGuardianDay, DAY + 1);

  const unrewardedInitial = commandSnapshot();
  unrewardedInitial.subjectState.data.guardianMap['ks2-core:answer'] = {
    legacySlug: 'answer',
    reviewLevel: 1,
    nextDueDay: DAY,
    lastReviewedDay: DAY - 3,
    streak: 1,
    lapses: 0,
    renewals: 1,
    wobbling: false,
  };
  unrewardedInitial.campStateByPackId['ks2-core'] = camp({ day: DAY });
  const unrewardedStart = applyCommand(unrewardedInitial, {
    type: 'start-session',
    payload: {
      mode: 'guardian', yearFilter: 'core', length: 5, practiceOnly: false,
      words: [], revisionIntent: 'unrewarded',
    },
  });
  const unrewardedActive = advance(unrewardedInitial, unrewardedStart);
  assert.equal(unrewardedActive.practiceSession.state.session.revisionMission.campEligible, false);
  const unrewardedCompletion = completeGuardian(unrewardedActive, { nowMs: (DAY + 1) * DAY_MS });
  assert.equal(unrewardedCompletion.completionPlan.projections.camp.creditApplied, 0);
  assert.deepEqual(unrewardedCompletion.current.campStateByPackId, unrewardedInitial.campStateByPackId);
});
