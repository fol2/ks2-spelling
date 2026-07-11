import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  createSpellingBossCompletedEvent,
  createSpellingGuardianMissionCompletedEvent,
  createSpellingGuardianRecoveredEvent,
  createSpellingGuardianRenewedEvent,
  createSpellingGuardianWobbledEvent,
  createSpellingMasteryMilestoneEvent,
  createSpellingPatternQuestCompletedEvent,
  createSpellingPostMegaUnlockedEvent,
  createSpellingRetryClearedEvent,
  createSpellingSessionCompletedEvent,
  createSpellingWordSecuredEvent,
} from '../shared/spelling/core/index.js';

import {
  SPELLING_COMMAND_PLAN_SCHEMA_VERSION,
  SPELLING_COMMAND_SNAPSHOT_SCHEMA_VERSION,
  SPELLING_MOBILE_COMMAND_TYPES,
  canonicalGuardianDay,
  validateSpellingCommandPlanV1,
  validateSpellingCommandSnapshotV1,
  validateSpellingCommandV1,
} from '../shared/spelling/mobile/a3/index.js';

const fullCatalogue = JSON.parse(await readFile(
  new URL('../content/spelling.mobile-runtime-full.json', import.meta.url),
  'utf8',
));

function clone(value) {
  return structuredClone(value);
}

function subjectState(session = undefined) {
  return {
    ui: session === undefined ? {} : {
      phase: session ? 'session' : 'dashboard',
      session,
      summary: null,
    },
    data: {
      prefs: {},
      progress: {
        'ks2-core:answer': { legacySlug: 'answer', attempts: 1, correct: 1, wrong: 0, stage: 1 },
      },
      guardianMap: {},
      pattern: { wobblingByRuntimeItemId: {} },
      postMega: null,
      achievements: {},
      persistenceWarning: null,
    },
  };
}

function snapshot() {
  return {
    schemaVersion: 1,
    learnerId: 'learner-a',
    revision: 7,
    packId: 'ks2-core',
    catalogueId: 'ks2-core:full',
    grantedEntitlementIds: ['full-ks2'],
    subjectState: subjectState(),
    practiceSession: null,
    eventLog: [],
    monsterStateByRewardTrackId: {},
    campStateByPackId: {},
  };
}

function activeSessionSnapshot() {
  const session = {
    id: 'sess-1',
    profileId: 'learner-a',
    mode: 'guardian',
    uniqueItemIds: ['ks2-core:answer'],
    queueItemIds: ['ks2-core:answer'],
    statusByRuntimeItemId: {},
    sentenceHistoryByRuntimeItemId: {},
    results: [],
    guardianResultsByRuntimeItemId: {},
    patternQuestCards: [],
    patternQuestResults: [],
    patternQuestWobbledRuntimeItemIds: [],
    patternQuestSeedRuntimeItemIds: [],
    currentRuntimeItemId: 'ks2-core:answer',
    currentPrompt: null,
    currentCard: null,
    patternQuestCard: null,
    revisionMission: {
      sessionId: 'sess-1',
      learnerId: 'learner-a',
      packId: 'ks2-core',
      kind: 'due',
      startedGuardianDay: 0,
      campEligible: true,
    },
  };
  const value = snapshot();
  value.subjectState = subjectState(session);
  value.practiceSession = {
    id: 'sess-1',
    learnerId: 'learner-a',
    subjectId: 'spelling',
    status: 'active',
    mode: 'guardian',
    state: clone(value.subjectState.ui),
    summary: null,
    startedAt: 0,
    updatedAt: 1,
    completedAt: null,
  };
  return value;
}

function event(id = 'spelling.session-completed:learner-a:sess-old') {
  return {
    id,
    type: 'spelling.session-completed',
    subjectId: 'spelling',
    learnerId: 'learner-a',
    sessionId: 'sess-old',
    mode: 'smart',
    createdAt: 10,
    sessionType: 'learning',
    totalWords: 1,
    mistakeCount: 0,
  };
}

function plan({ changed = true } = {}) {
  const base = snapshot();
  const appended = event();
  const revisionMission = {
    missionState: 'locked',
    eligibleMissionKind: null,
    guardianDueCount: 0,
    wobblingDueCount: 0,
    nextGuardianDueDay: null,
    todayGuardianDay: 0,
    canStartRewardBearing: false,
    canContinueUnrewarded: false,
    campCreditState: 'available',
  };
  const camp = {
    packId: base.packId,
    campHighWater: 0,
    lastCreditedGuardianDay: null,
    lastCreditedEventId: null,
    acknowledgements: [],
    creditApplied: 0,
    completedGuardianDay: null,
    canEarnToday: false,
  };
  return {
    schemaVersion: 1,
    learnerId: base.learnerId,
    expectedRevision: base.revision,
    nextRevision: base.revision + (changed ? 1 : 0),
    changed,
    ok: true,
    nextSubjectState: clone(base.subjectState),
    nextPracticeSession: null,
    nextEventLog: changed ? [appended] : [],
    appendedEvents: changed ? [appended] : [],
    nextMonsterStateByRewardTrackId: {},
    nextCampStateByPackId: {},
    projections: { monsters: [], revisionMission, camp },
    transientEffects: changed ? [{
      type: 'audio-cue',
      payload: { runtimeItemId: 'ks2-core:answer', sentence: null, slow: false },
    }] : [],
    result: {
      ok: true,
      changed,
      state: clone(base.subjectState.ui),
      events: changed ? [appended] : [],
    },
  };
}

function validatePlan(candidate, input = snapshot()) {
  return validateSpellingCommandPlanV1(candidate, fullCatalogue, input, { expectedNowMs: 10 });
}

test('A3 publishes versioned command contracts from its nested entry', () => {
  assert.equal(SPELLING_COMMAND_SNAPSHOT_SCHEMA_VERSION, 1);
  assert.equal(SPELLING_COMMAND_PLAN_SCHEMA_VERSION, 1);
  assert.deepEqual(SPELLING_MOBILE_COMMAND_TYPES, [
    'start-session', 'submit-answer', 'continue-session', 'skip-word',
    'end-session', 'save-prefs', 'acknowledge-persistence-warning',
  ]);
  assert.equal(Object.isFrozen(SPELLING_MOBILE_COMMAND_TYPES), true);
});

test('A3 validates and defensively clones one composite-identity command snapshot', () => {
  const input = snapshot();
  const output = validateSpellingCommandSnapshotV1(input, fullCatalogue);
  assert.notEqual(output, input);
  assert.notEqual(output.subjectState, input.subjectState);
  assert.equal(output.learnerId, 'learner-a');
  assert.equal(output.subjectState.data.progress['ks2-core:answer'].legacySlug, 'answer');
  output.subjectState.data.progress['ks2-core:answer'].attempts = 99;
  assert.equal(input.subjectState.data.progress['ks2-core:answer'].attempts, 1);
});

test('A3 validates all seven commands and rejects reset-learner and unknown payload keys', () => {
  const commands = [
    { type: 'start-session', payload: { mode: 'smart', yearFilter: 'core', length: 10, practiceOnly: false, words: [] } },
    { type: 'submit-answer', payload: { typed: 'answer' } },
    { type: 'continue-session', payload: {} },
    { type: 'skip-word', payload: {} },
    { type: 'end-session', payload: {} },
    { type: 'save-prefs', payload: { prefs: { mode: 'smart', autoSpeak: false } } },
    { type: 'acknowledge-persistence-warning', payload: {} },
  ];
  for (const command of commands) assert.deepEqual(validateSpellingCommandV1(command), command);
  assert.throws(() => validateSpellingCommandV1({ type: 'reset-learner', payload: {} }), /unsupported.*command/i);
  assert.throws(() => validateSpellingCommandV1({ type: 'submit-answer', payload: { typed: 'x', learnerId: 'learner-b' } }), /unknown.*payload/i);
  assert.throws(() => validateSpellingCommandV1({ type: 'continue-session', payload: { typed: 'x' } }), /unknown.*payload/i);
  assert.throws(() => validateSpellingCommandV1({ type: 'start-session', payload: { mode: 'guardian', revisionIntent: 'wrong' } }), /revisionIntent/i);
  assert.throws(() => validateSpellingCommandV1({ type: 'start-session', payload: { mode: 'smart', revisionIntent: 'reward-bearing' } }), /guardian/i);
});

test('A3 samples canonical Guardian days without ambient time', () => {
  assert.equal(canonicalGuardianDay(0), 0);
  assert.equal(canonicalGuardianDay(86_400_000 - 1), 0);
  assert.equal(canonicalGuardianDay(86_400_000), 1);
  assert.throws(() => canonicalGuardianDay(NaN), /finite non-negative/i);
  assert.throws(() => canonicalGuardianDay(-1), /finite non-negative/i);
});

test('A3 rejects snapshot authority, ownership and identity mismatches', () => {
  for (const mutate of [
    (value) => { value.extra = true; },
    (value) => { value.revision = -1; },
    (value) => { value.revision = Number.MAX_SAFE_INTEGER + 1; },
    (value) => { value.packId = 'another-pack'; },
    (value) => { value.catalogueId = 'ks2-core:starter'; },
    (value) => { value.grantedEntitlementIds.push('full-ks2'); },
    (value) => { value.subjectState.data.progress['bad-id'] = {}; },
    (value) => { value.eventLog = [{ ...event(), learnerId: 'learner-b' }]; },
    (value) => { value.monsterStateByRewardTrackId.unknown = {}; },
    (value) => { value.campStateByPackId['another-pack'] = { packId: 'wrong-pack' }; },
  ]) {
    const value = snapshot();
    mutate(value);
    assert.throws(() => validateSpellingCommandSnapshotV1(value, fullCatalogue));
  }
});

test('A3 validates strict catalogue-owned Monster and Camp records', () => {
  const value = snapshot();
  value.monsterStateByRewardTrackId['spelling-core-inklet'] = {
    rewardTrackId: 'spelling-core-inklet',
    packId: 'ks2-core',
    monsterId: 'inklet',
    branch: 'b1',
    secureCount: 1,
    caught: true,
    derivedStage: 0,
    earnedStageHighWater: 2,
  };
  value.campStateByPackId['ks2-core'] = {
    packId: 'ks2-core',
    campHighWater: 4,
    lastCreditedGuardianDay: 20,
    lastCreditedEventId: 'spelling.guardian.mission-completed:learner-a:sess-old',
    acknowledgements: [],
  };
  const output = validateSpellingCommandSnapshotV1(value, fullCatalogue);
  assert.equal(output.monsterStateByRewardTrackId['spelling-core-inklet'].earnedStageHighWater, 2);
  assert.equal(output.campStateByPackId['ks2-core'].campHighWater, 4);

  for (const mutate of [
    (candidate) => { candidate.monsterStateByRewardTrackId['spelling-core-inklet'].branch = 'b3'; },
    (candidate) => { candidate.monsterStateByRewardTrackId['spelling-core-inklet'].earnedStageHighWater = -1; },
    (candidate) => { candidate.monsterStateByRewardTrackId['spelling-core-inklet'].monsterId = 'other'; },
    (candidate) => { candidate.campStateByPackId['ks2-core'].campHighWater = -1; },
    (candidate) => { candidate.campStateByPackId['ks2-core'].lastCreditedGuardianDay = 1.5; },
    (candidate) => { candidate.campStateByPackId['ks2-core'].unknown = true; },
  ]) {
    const candidate = clone(value);
    mutate(candidate);
    assert.throws(() => validateSpellingCommandSnapshotV1(candidate, fullCatalogue));
  }
});

test('A3 rejects foreign or malformed Camp credit event ownership', () => {
  const value = snapshot();
  value.campStateByPackId['ks2-core'] = {
    packId: 'ks2-core',
    campHighWater: 1,
    lastCreditedGuardianDay: 20,
    lastCreditedEventId: 'spelling.guardian.mission-completed:learner-a:sess-credit',
    acknowledgements: [],
  };
  assert.equal(validateSpellingCommandSnapshotV1(value, fullCatalogue)
    .campStateByPackId['ks2-core'].lastCreditedEventId, value.campStateByPackId['ks2-core'].lastCreditedEventId);
  for (const lastCreditedEventId of [
    'spelling.guardian.mission-completed:learner-b:sess-credit',
    'spelling.guardian.mission-completed:learner-a:not:canonical',
    'spelling.guardian.mission-completed:learner-a:',
    'arbitrary',
  ]) {
    const candidate = clone(value);
    candidate.campStateByPackId['ks2-core'].lastCreditedEventId = lastCreditedEventId;
    assert.throws(() => validateSpellingCommandSnapshotV1(candidate, fullCatalogue), /Camp.*event|ownership|canonical/i);
  }
});

test('A3 accepts canonical Camp history for more than one pack and rejects malformed inactive records', () => {
  const value = snapshot();
  value.campStateByPackId['ks2-core'] = {
    packId: 'ks2-core', campHighWater: 1, lastCreditedGuardianDay: 20,
    lastCreditedEventId: 'spelling.guardian.mission-completed:learner-a:sess-core',
    acknowledgements: [],
  };
  value.campStateByPackId['future-pack'] = {
    packId: 'future-pack', campHighWater: 3, lastCreditedGuardianDay: 18,
    lastCreditedEventId: 'spelling.guardian.mission-completed:learner-a:sess-future',
    acknowledgements: [{ milestone: 2 }],
  };
  const output = validateSpellingCommandSnapshotV1(value, fullCatalogue);
  assert.deepEqual(output.campStateByPackId['future-pack'], value.campStateByPackId['future-pack']);

  for (const mutate of [
    (candidate) => { candidate.campStateByPackId['future-pack'].packId = 'other-pack'; },
    (candidate) => { candidate.campStateByPackId['future-pack'].campHighWater = -1; },
    (candidate) => { candidate.campStateByPackId['future-pack'].lastCreditedEventId = 'spelling.guardian.mission-completed:learner-b:sess-future'; },
    (candidate) => { candidate.campStateByPackId['future-pack'].unknown = true; },
  ]) {
    const candidate = clone(value);
    mutate(candidate);
    assert.throws(() => validateSpellingCommandSnapshotV1(candidate, fullCatalogue), /Camp|pack|ownership|unknown/i);
  }
});

test('A3 enforces active practice-session ownership and UI agreement', () => {
  assert.equal(validateSpellingCommandSnapshotV1(activeSessionSnapshot(), fullCatalogue).practiceSession.id, 'sess-1');
  const wrongLearner = activeSessionSnapshot();
  wrongLearner.practiceSession.learnerId = 'learner-b';
  assert.throws(() => validateSpellingCommandSnapshotV1(wrongLearner, fullCatalogue), /learner/i);
  const wrongSession = activeSessionSnapshot();
  wrongSession.practiceSession.id = 'sess-2';
  assert.throws(() => validateSpellingCommandSnapshotV1(wrongSession, fullCatalogue), /session/i);
  const completed = activeSessionSnapshot();
  completed.practiceSession.status = 'completed';
  completed.practiceSession.summary = { sessionId: 'sess-1' };
  completed.practiceSession.completedAt = 2;
  assert.throws(() => validateSpellingCommandSnapshotV1(completed, fullCatalogue), /active UI session/i);
});

test('A3 rejects foreign nested session, summary and revision-mission ownership', () => {
  for (const mutate of [
    (value) => { value.subjectState.ui.session.profileId = 'learner-b'; value.practiceSession.state.session.profileId = 'learner-b'; },
    (value) => { value.subjectState.ui.session.revisionMission.learnerId = 'learner-b'; value.practiceSession.state.session.revisionMission.learnerId = 'learner-b'; },
    (value) => { value.subjectState.ui.session.revisionMission.sessionId = 'sess-2'; value.practiceSession.state.session.revisionMission.sessionId = 'sess-2'; },
    (value) => { value.subjectState.ui.session.revisionMission.packId = 'another-pack'; value.practiceSession.state.session.revisionMission.packId = 'another-pack'; },
    (value) => { value.subjectState.ui.session.revisionMission.kind = 'optional-patrol'; value.practiceSession.state.session.revisionMission.kind = 'optional-patrol'; },
    (value) => { value.subjectState.ui.session.revisionMission.campEligible = 'yes'; value.practiceSession.state.session.revisionMission.campEligible = 'yes'; },
  ]) {
    const value = activeSessionSnapshot();
    mutate(value);
    assert.throws(() => validateSpellingCommandSnapshotV1(value, fullCatalogue));
  }

  const completed = snapshot();
  completed.practiceSession = {
    id: 'sess-1', learnerId: 'learner-a', subjectId: 'spelling', status: 'completed', mode: 'guardian',
    state: { phase: 'summary', session: null, summary: { sessionId: 'sess-1' } },
    summary: { sessionId: 'sess-2' }, startedAt: 0, updatedAt: 2, completedAt: 2,
  };
  assert.throws(() => validateSpellingCommandSnapshotV1(completed, fullCatalogue), /summary.*session/i);
});

test('A3 preserves a completed Guardian historical session and immutable origin stamp', () => {
  const completed = activeSessionSnapshot();
  completed.subjectState.ui = {
    phase: 'summary',
    session: null,
    summary: { sessionId: 'sess-1' },
  };
  completed.practiceSession.status = 'completed';
  completed.practiceSession.state.phase = 'summary';
  completed.practiceSession.state.summary = { sessionId: 'sess-1' };
  completed.practiceSession.summary = { sessionId: 'sess-1' };
  completed.practiceSession.updatedAt = 2;
  completed.practiceSession.completedAt = 2;
  const output = validateSpellingCommandSnapshotV1(completed, fullCatalogue);
  assert.deepEqual(output.practiceSession.state.session.revisionMission, {
    sessionId: 'sess-1', learnerId: 'learner-a', packId: 'ks2-core',
    kind: 'due', startedGuardianDay: 0, campEligible: true,
  });

  for (const mutate of [
    (value) => { value.practiceSession.state.session.id = 'sess-2'; },
    (value) => { value.practiceSession.state.session.profileId = 'learner-b'; },
    (value) => { value.practiceSession.state.session.revisionMission.sessionId = 'sess-2'; },
    (value) => { value.practiceSession.state.session.revisionMission.learnerId = 'learner-b'; },
    (value) => { value.practiceSession.state.session.revisionMission.packId = 'another-pack'; },
  ]) {
    const candidate = clone(completed);
    mutate(candidate);
    assert.throws(() => validateSpellingCommandSnapshotV1(candidate, fullCatalogue));
  }
});

test('A3 accepts only deterministic frozen A1 events', () => {
  const value = snapshot();
  value.eventLog = [event()];
  assert.equal(validateSpellingCommandSnapshotV1(value, fullCatalogue).eventLog[0].id, event().id);

  for (const mutate of [
    (candidate) => { candidate.type = 'spelling.evil'; },
    (candidate) => { candidate.id = 'arbitrary'; },
    (candidate) => { candidate.totalWords = -1; },
    (candidate) => { candidate.runtimeItemId = 'ks2-core:answer'; },
  ]) {
    const bad = event();
    mutate(bad);
    const candidate = snapshot();
    candidate.eventLog = [bad];
    assert.throws(() => validateSpellingCommandSnapshotV1(candidate, fullCatalogue));
  }
});

test('A3 accepts every frozen A1 event factory after composite identity bridging', () => {
  const answer = fullCatalogue.items.find(({ runtimeItemId }) => runtimeItemId === 'ks2-core:answer');
  const wordMeta = {
    answer: {
      slug: answer.legacySlug,
      word: answer.target,
      family: answer.family,
      year: answer.yearBand,
      spellingPool: 'core',
    },
  };
  const smart = { id: 'sess-smart', type: 'learning', mode: 'smart', uniqueWords: ['answer'] };
  const guardian = { id: 'sess-guardian', type: 'learning', mode: 'guardian', uniqueWords: ['answer'] };
  const boss = { id: 'sess-boss', type: 'test', mode: 'boss', uniqueWords: ['answer'] };
  const pattern = { id: 'sess-pattern', type: 'learning', mode: 'pattern-quest', uniqueWords: ['answer'] };
  const events = [
    createSpellingRetryClearedEvent({ learnerId: 'learner-a', session: smart, slug: 'answer', fromPhase: 'retry', attemptCount: 2, createdAt: 10, wordMeta }),
    createSpellingWordSecuredEvent({ learnerId: 'learner-a', session: smart, slug: 'answer', stage: 4, createdAt: 10, wordMeta }),
    createSpellingMasteryMilestoneEvent({ learnerId: 'learner-a', session: smart, milestone: 1, secureCount: 1, createdAt: 10 }),
    createSpellingSessionCompletedEvent({ learnerId: 'learner-a', session: smart, summary: { mistakes: [] }, createdAt: 10 }),
    createSpellingGuardianRenewedEvent({ learnerId: 'learner-a', session: guardian, slug: 'answer', reviewLevel: 1, nextDueDay: 3, createdAt: 10, wordMeta }),
    createSpellingGuardianWobbledEvent({ learnerId: 'learner-a', session: guardian, slug: 'answer', lapses: 1, createdAt: 10, wordMeta }),
    createSpellingGuardianRecoveredEvent({ learnerId: 'learner-a', session: guardian, slug: 'answer', renewals: 1, reviewLevel: 1, createdAt: 10, wordMeta }),
    createSpellingGuardianMissionCompletedEvent({ learnerId: 'learner-a', session: guardian, renewalCount: 1, createdAt: 10 }),
    createSpellingBossCompletedEvent({ learnerId: 'learner-a', session: boss, summary: { correct: 1, wrong: 0 }, seedSlugs: ['answer'], createdAt: 10 }),
    createSpellingPostMegaUnlockedEvent({ learnerId: 'learner-a', unlockedAt: 10, contentReleaseId: 'spelling-r7', publishedCoreCount: 213 }),
    createSpellingPatternQuestCompletedEvent({ learnerId: 'learner-a', session: pattern, patternId: 'double-consonant', patternTitle: 'Double consonants', slugs: ['answer'], correctCount: 1, wobbledSlugs: [], createdAt: 10 }),
  ];
  const value = snapshot();
  value.eventLog = events;
  assert.equal(validateSpellingCommandSnapshotV1(value, fullCatalogue).eventLog.length, events.length);

  const invalidMilestone = clone(events[2]);
  invalidMilestone.milestone = 2;
  invalidMilestone.secureCount = 2;
  invalidMilestone.id = 'spelling.mastery-milestone:learner-a:2';
  value.eventLog = [invalidMilestone];
  assert.throws(() => validateSpellingCommandSnapshotV1(value, fullCatalogue), /milestone evidence/i);

  const invalidGuardianLevel = clone(events[4]);
  invalidGuardianLevel.reviewLevel = 6;
  invalidGuardianLevel.id = 'spelling.guardian.renewed:learner-a:sess-guardian:answer:6';
  value.eventLog = [invalidGuardianLevel];
  assert.throws(() => validateSpellingCommandSnapshotV1(value, fullCatalogue), /renewal evidence/i);

  const invalidPatternScore = clone(events[10]);
  invalidPatternScore.correctCount = 6;
  value.eventLog = [invalidPatternScore];
  assert.throws(() => validateSpellingCommandSnapshotV1(value, fullCatalogue), /Pattern Quest evidence/i);
});

test('A3 rejects cyclic and non-serialisable values before cloning', () => {
  const cyclic = snapshot();
  cyclic.subjectState.data.achievements.self = cyclic.subjectState.data.achievements;
  assert.throws(() => validateSpellingCommandSnapshotV1(cyclic, fullCatalogue), /cyclic|serialisable/i);
  const executable = snapshot();
  executable.subjectState.data.achievements.callback = () => {};
  assert.throws(() => validateSpellingCommandSnapshotV1(executable, fullCatalogue), /serialisable/i);
  const nonFinite = snapshot();
  nonFinite.subjectState.data.achievements.score = Infinity;
  assert.throws(() => validateSpellingCommandSnapshotV1(nonFinite, fullCatalogue), /finite|serialisable/i);
});

test('A3 rejects hostile descriptors and Array shapes without invoking getters', () => {
  let getterCalls = 0;
  const accessor = snapshot();
  Object.defineProperty(accessor.subjectState.data.achievements, 'secret', {
    enumerable: true,
    get() { getterCalls += 1; return 'leaked'; },
  });
  assert.throws(() => validateSpellingCommandSnapshotV1(accessor, fullCatalogue), /data property|serialisable/i);
  assert.equal(getterCalls, 0);

  const hidden = snapshot();
  Object.defineProperty(hidden.subjectState.data.achievements, 'hidden', {
    enumerable: false, value: true,
  });
  assert.throws(() => validateSpellingCommandSnapshotV1(hidden, fullCatalogue), /enumerable|serialisable/i);

  const symbol = snapshot();
  symbol.subjectState.data.achievements[Symbol('hidden')] = true;
  assert.throws(() => validateSpellingCommandSnapshotV1(symbol, fullCatalogue), /symbol|serialisable/i);

  const sparse = snapshot();
  sparse.eventLog = new Array(1);
  assert.throws(() => validateSpellingCommandSnapshotV1(sparse, fullCatalogue), /sparse|array/i);

  const customArray = snapshot();
  Object.setPrototypeOf(customArray.eventLog, Object.create(Array.prototype));
  assert.throws(() => validateSpellingCommandSnapshotV1(customArray, fullCatalogue), /prototype|serialisable|plain/i);
});

test('A3 validates plans, event-log suffixes and defensive plan cloning', () => {
  const input = plan();
  const base = snapshot();
  const output = validatePlan(input, base);
  assert.notEqual(output, input);
  assert.equal(output.nextRevision, 8);
  output.result.changed = false;
  assert.equal(input.result.changed, true);

  const falseLabel = plan({ changed: false });
  falseLabel.appendedEvents.push(event());
  falseLabel.nextEventLog.push(event());
  assert.throws(() => validatePlan(falseLabel, base), /changed.*false|result events/i);

  const duplicate = plan();
  duplicate.nextEventLog.push(clone(duplicate.nextEventLog[0]));
  assert.throws(() => validatePlan(duplicate, base), /duplicate.*event/i);

  const notSuffix = plan();
  notSuffix.nextEventLog = [event('spelling.session-completed:learner-a:other')];
  assert.throws(() => validatePlan(notSuffix, base), /event log|history|appended|deterministic/i);
});

test('A3 rejects a genuinely appended event outside the exact certified command clock', () => {
  assert.throws(
    () => validateSpellingCommandPlanV1(plan(), fullCatalogue, snapshot(), {
      expectedNowMs: 11,
    }),
    /event.*timestamp|command clock|expected now/i,
  );
});

test('A3 rejects forged projections, effects and results at the plan boundary', () => {
  const base = snapshot();
  const mutations = [
    ['undefined Monster', (candidate) => { candidate.projections.monsters.push({ ...candidate.nextMonsterStateByRewardTrackId.unknown }); }],
    ['forged Monster', (candidate) => { candidate.projections.monsters.push({ rewardTrackId: 'forged-track' }); }],
    ['revision access', (candidate) => { candidate.projections.revisionMission.canStartRewardBearing = true; }],
    ['revision count', (candidate) => { candidate.projections.revisionMission.guardianDueCount = -1; }],
    ['Camp pack', (candidate) => { candidate.projections.camp.packId = 'forged-pack'; }],
    ['Camp credit', (candidate) => { candidate.projections.camp.creditApplied = 2; }],
    ['effect type', (candidate) => { candidate.transientEffects[0].type = 'run-script'; }],
    ['effect executable payload', (candidate) => { candidate.transientEffects[0].payload.execute = 'javascript:alert(1)'; }],
    ['effect runtime item', (candidate) => { candidate.transientEffects[0].payload.runtimeItemId = 'ks2-core:forged'; }],
    ['result ok', (candidate) => { candidate.result.ok = false; }],
    ['result state', (candidate) => { candidate.result.state = { error: 'forged' }; }],
    ['result events', (candidate) => { candidate.result.events = []; }],
    ['result extra', (candidate) => { candidate.result.extra = true; }],
  ];
  for (const [label, mutate] of mutations) {
    const candidate = plan();
    mutate(candidate);
    assert.throws(
      () => validatePlan(candidate, base),
      /projection|Monster|revision|Camp|effect|audio|runtime item|result|event|state|unknown/i,
      label,
    );
  }
});

test('A3 plans preserve every inactive Camp record byte-for-byte', () => {
  const base = snapshot();
  base.campStateByPackId['future-pack'] = {
    packId: 'future-pack', campHighWater: 2, lastCreditedGuardianDay: 7,
    lastCreditedEventId: 'spelling.guardian.mission-completed:learner-a:sess-future',
    acknowledgements: [{ first: 1, second: 2 }],
  };
  const candidate = plan();
  candidate.nextCampStateByPackId = clone(base.campStateByPackId);
  candidate.nextCampStateByPackId['future-pack'] = {
    acknowledgements: [{ second: 2, first: 1 }],
    lastCreditedEventId: 'spelling.guardian.mission-completed:learner-a:sess-future',
    lastCreditedGuardianDay: 7,
    campHighWater: 2,
    packId: 'future-pack',
  };
  assert.throws(
    () => validatePlan(candidate, base),
    /inactive|byte-for-byte|Camp history/i,
  );
});

test('A3 requires input history, preserves its order and resolves replay/collision semantics', () => {
  const input = snapshot();
  input.eventLog = [event('spelling.session-completed:learner-a:sess-old')];
  assert.throws(() => validateSpellingCommandPlanV1(plan(), fullCatalogue), /input snapshot/i);

  const replay = plan();
  replay.nextEventLog = clone(input.eventLog);
  replay.appendedEvents = [clone(input.eventLog[0])];
  const replayOutput = validatePlan(replay, input);
  assert.deepEqual(replayOutput.nextEventLog, input.eventLog);
  assert.deepEqual(replayOutput.appendedEvents, []);

  const dropped = plan();
  dropped.nextEventLog = [];
  dropped.appendedEvents = [];
  assert.throws(() => validatePlan(dropped, input), /history|event log/i);

  const collision = plan();
  collision.nextEventLog = clone(input.eventLog);
  collision.appendedEvents = [{ ...clone(input.eventLog[0]), totalWords: 2 }];
  assert.throws(
    () => validatePlan(collision, input),
    /spelling_event_id_collision/,
  );
});

test('A3 compares changed-false durable values when the validated input is supplied', () => {
  const input = snapshot();
  const unchanged = plan({ changed: false });
  assert.equal(validatePlan(unchanged, input).changed, false);

  const changedSubject = plan({ changed: false });
  changedSubject.nextSubjectState.data.progress['ks2-core:answer'].attempts = 2;
  assert.throws(
    () => validatePlan(changedSubject, input),
    /changed false.*durable/i,
  );

  const wrongOwner = plan();
  assert.throws(
    () => validatePlan(wrongOwner, { ...input, learnerId: 'learner-b' }),
    /learner|ownership/i,
  );

  const orderedInput = snapshot();
  orderedInput.subjectState.data.achievements = { nested: { first: 1, second: 2 } };
  const reordered = plan({ changed: false });
  reordered.nextSubjectState = clone(orderedInput.subjectState);
  reordered.nextSubjectState.data.achievements = { nested: { second: 2, first: 1 } };
  assert.throws(
    () => validatePlan(reordered, orderedInput),
    /changed false.*byte-for-byte/i,
  );
});

test('A3 derives Monster stage exactly and preserves caught across content contraction', () => {
  const value = snapshot();
  value.monsterStateByRewardTrackId['spelling-core-inklet'] = {
    rewardTrackId: 'spelling-core-inklet', packId: 'ks2-core', monsterId: 'inklet', branch: 'b1',
    secureCount: 10, caught: true, derivedStage: 1, earnedStageHighWater: 1,
  };
  assert.equal(validateSpellingCommandSnapshotV1(value, fullCatalogue)
    .monsterStateByRewardTrackId['spelling-core-inklet'].derivedStage, 1);

  value.monsterStateByRewardTrackId['spelling-core-inklet'] = {
    rewardTrackId: 'spelling-core-inklet', packId: 'ks2-core', monsterId: 'inklet', branch: 'b1',
    secureCount: 0, caught: true, derivedStage: 0, earnedStageHighWater: 4,
  };
  assert.equal(validateSpellingCommandSnapshotV1(value, fullCatalogue)
    .monsterStateByRewardTrackId['spelling-core-inklet'].caught, true);

  value.monsterStateByRewardTrackId['spelling-core-inklet'].secureCount = 10;
  value.monsterStateByRewardTrackId['spelling-core-inklet'].derivedStage = 0;
  assert.throws(() => validateSpellingCommandSnapshotV1(value, fullCatalogue), /derivedStage/i);

  value.monsterStateByRewardTrackId['spelling-core-inklet'].secureCount = 1;
  value.monsterStateByRewardTrackId['spelling-core-inklet'].caught = false;
  assert.throws(() => validateSpellingCommandSnapshotV1(value, fullCatalogue), /caught/i);

  value.monsterStateByRewardTrackId['spelling-core-inklet'] = {
    rewardTrackId: 'spelling-core-inklet', packId: 'ks2-core', monsterId: 'inklet', branch: 'b1',
    secureCount: 0, caught: false, derivedStage: 0, earnedStageHighWater: 1,
  };
  assert.throws(() => validateSpellingCommandSnapshotV1(value, fullCatalogue), /caught/i);
});
