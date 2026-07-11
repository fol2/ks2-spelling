import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  applySpellingCommand,
  assertParentProjectionRedacted,
  projectParentSpellingProgress,
} from '../shared/spelling/mobile/a3/index.js';

const fullCatalogue = JSON.parse(await readFile(
  new URL('../content/spelling.mobile-runtime-full.json', import.meta.url),
  'utf8',
));
const NOW = 1_768_478_400_000;
const TODAY = Math.floor(NOW / 86_400_000);

function profile(learnerId, nickname, yearGroup, colour) {
  return { learnerId, nickname, yearGroup, goal: 10, colour, createdAt: 1, updatedAt: 1 };
}

function progress(item, { stage = 1, attempts = 2, correct = 1, wrong = 1, dueDay = TODAY } = {}) {
  return {
    legacySlug: item.legacySlug, stage, attempts, correct, wrong, dueDay,
    lastDay: TODAY - 1, lastResult: wrong ? 'wrong' : 'correct',
  };
}

function snapshot(learnerId, { progressById = {}, guardianMap = {} } = {}) {
  return {
    schemaVersion: 1,
    learnerId,
    revision: 4,
    packId: fullCatalogue.packId,
    catalogueId: fullCatalogue.catalogueId,
    grantedEntitlementIds: ['full-ks2'],
    subjectState: {
      ui: {},
      data: {
        prefs: { autoSpeak: false }, progress: progressById, guardianMap,
        pattern: { wobblingByRuntimeItemId: {} }, postMega: null,
        achievements: {}, persistenceWarning: null,
      },
    },
    practiceSession: null,
    eventLog: [],
    monsterStateByRewardTrackId: {
      'spelling-core-inklet': {
        rewardTrackId: 'spelling-core-inklet', packId: 'ks2-core', monsterId: 'inklet',
        branch: 'b1', secureCount: 1, caught: true, derivedStage: 0, earnedStageHighWater: 4,
      },
    },
    campStateByPackId: {
      'ks2-core': {
        packId: 'ks2-core', campHighWater: 999, lastCreditedGuardianDay: TODAY,
        lastCreditedEventId: `spelling.guardian.mission-completed:${learnerId}:sentinel-session`,
        acknowledgements: ['monster-secret-sentinel', 'camp-secret-sentinel', 'branch-secret-sentinel'],
      },
    },
  };
}

function completedSession(learnerId, id, completedAt, {
  mode = 'guardian', correct = 4, total = 5, kind = 'due',
} = {}) {
  const startedAt = completedAt - 100;
  const mission = mode === 'guardian' ? {
    sessionId: id, learnerId, packId: fullCatalogue.packId, kind,
    startedGuardianDay: Math.floor(startedAt / 86_400_000), campEligible: true,
  } : undefined;
  const historical = {
    id, profileId: learnerId, mode, startedAt,
    ...(mission ? { revisionMission: mission,
    revisionMissionIntegrity: [
      'revision-mission-v1', id, learnerId, mode, startedAt, id, learnerId,
      fullCatalogue.packId, kind, mission.startedGuardianDay, 'reward-bearing',
    ].join('|'),
    } : {}),
  };
  const summary = { sessionId: id, mode, totalWords: total, correct };
  return {
    id, learnerId, subjectId: 'spelling', status: 'completed', mode,
    state: {
      phase: 'summary', session: historical, summary: structuredClone(summary),
    },
    summary, startedAt, updatedAt: completedAt, completedAt,
  };
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

function guardian(item, { nextDueDay = TODAY, wobbling = false } = {}) {
  return {
    legacySlug: item.legacySlug, reviewLevel: 2, nextDueDay, lastReviewedDay: TODAY - 1,
    streak: 1, lapses: wobbling ? 1 : 0, renewals: 1, wobbling,
  };
}

function project({ profiles, learnerSnapshots, completedSessions = [], now = () => NOW } = {}) {
  return projectParentSpellingProgress({
    profiles, learnerSnapshots, completedSessions,
    contentSnapshots: [fullCatalogue], now,
  });
}

test('two-child Parent projection preserves exact independent spelling and Guardian aggregates', () => {
  const [a1, a2, a3, b1] = fullCatalogue.items;
  const profiles = [
    profile('learner-b', 'Ben', 'Y5', '#AA6633'),
    profile('learner-a', 'Ada', 'Y3', '#3366AA'),
  ];
  const learnerSnapshots = [
    snapshot('learner-a', {
      progressById: {
        [a1.runtimeItemId]: progress(a1, { stage: 4, attempts: 5, correct: 4, wrong: 1, dueDay: TODAY - 2 }),
        [a2.runtimeItemId]: progress(a2, { stage: 4, attempts: 4, correct: 1, wrong: 3, dueDay: TODAY }),
        [a3.runtimeItemId]: progress(a3, { stage: 1, attempts: 2, correct: 2, wrong: 0, dueDay: TODAY }),
      },
      guardianMap: {
        [a1.runtimeItemId]: guardian(a1, { nextDueDay: TODAY + 3 }),
        [a2.runtimeItemId]: guardian(a2, { wobbling: true }),
      },
    }),
    snapshot('learner-b', {
      progressById: {
        [b1.runtimeItemId]: progress(b1, { stage: 4, attempts: 3, correct: 3, wrong: 0, dueDay: TODAY }),
      },
      guardianMap: { [b1.runtimeItemId]: guardian(b1) },
    }),
  ];

  let clockSamples = 0;
  const output = project({ profiles, learnerSnapshots, now() { clockSamples += 1; return NOW; } });
  assert.equal(clockSamples, 1);
  assert.deepEqual(output.map(({ learnerId }) => learnerId), ['learner-a', 'learner-b']);
  assert.deepEqual(output[0], {
    learnerId: 'learner-a', nickname: 'Ada', yearGroup: 'Y3', colour: '#3366AA',
    publishedItemCount: 213, secureItemCount: 2, dueItemCount: 1, troubleItemCount: 2,
    correctCount: 7, wrongCount: 4, accuracyPercent: 64,
    guardianDueCount: 1, wobblingDueCount: 1, nextGuardianReviewDay: TODAY,
    recentRevisionSessions: [],
  });
  assert.deepEqual(output[1], {
    learnerId: 'learner-b', nickname: 'Ben', yearGroup: 'Y5', colour: '#AA6633',
    publishedItemCount: 213, secureItemCount: 1, dueItemCount: 0, troubleItemCount: 0,
    correctCount: 3, wrongCount: 0, accuracyPercent: 100,
    guardianDueCount: 1, wobblingDueCount: 0, nextGuardianReviewDay: TODAY,
    recentRevisionSessions: [],
  });
});

test('recent revision sessions are bounded to ten and frozen by completion then session ID', () => {
  const sessions = Array.from({ length: 13 }, (_, index) => completedSession(
    'learner-a', `sess-${String(index).padStart(2, '0')}`, NOW + (index < 2 ? 100 : index),
    { correct: index % 6, total: 5, kind: index % 2 ? 'wobbling' : 'due' },
  ));
  const output = project({
    profiles: [profile('learner-a', 'Ada', 'Y3', '#3366AA')],
    learnerSnapshots: [snapshot('learner-a')],
    completedSessions: sessions,
  });

  assert.equal(output[0].recentRevisionSessions.length, 10);
  assert.deepEqual(output[0].recentRevisionSessions.map(({ completedAt }) => completedAt),
    [NOW + 100, NOW + 100, NOW + 12, NOW + 11, NOW + 10, NOW + 9, NOW + 8, NOW + 7, NOW + 6, NOW + 5]);
  assert.deepEqual(output[0].recentRevisionSessions.slice(0, 2).map(({ correct }) => correct), [0, 1]);
  assert.deepEqual(Object.keys(output[0].recentRevisionSessions[0]), [
    'mode', 'completedAt', 'correct', 'wrong', 'total', 'eligibleMissionKind',
  ]);
  assert.deepEqual(output[0].recentRevisionSessions[0], {
    mode: 'guardian', completedAt: NOW + 100,
    correct: 0, wrong: 5, total: 5, eligibleMissionKind: 'due',
  });
});

test('foreign completed sessions fail closed and are never reassigned', () => {
  const output = project({
    profiles: [
      profile('learner-a', 'Ada', 'Y3', '#3366AA'),
      profile('learner-b', 'Ben', 'Y5', '#AA6633'),
    ],
    learnerSnapshots: [snapshot('learner-a'), snapshot('learner-b')],
    completedSessions: [
      completedSession('learner-a', 'sess-valid', NOW),
      completedSession('learner-c', 'sess-foreign', NOW + 1),
    ],
  });
  assert.equal(output[0].recentRevisionSessions.length, 1);
  assert.equal(output[0].recentRevisionSessions[0].completedAt, NOW);
  assert.deepEqual(output[1].recentRevisionSessions, []);
});

test('catalogue authority comes from the validated child snapshot rather than session-only metadata', () => {
  const unknown = snapshot('learner-a');
  unknown.catalogueId = 'ks2-core:unknown';
  const output = project({
    profiles: [profile('learner-a', 'Ada', 'Y3', '#3366AA')],
    learnerSnapshots: [unknown],
    completedSessions: [completedSession('learner-a', 'sess-valid-shape', NOW)],
  });
  assert.equal(output[0].publishedItemCount, 0);
  assert.deepEqual(output[0].recentRevisionSessions, []);
});

test('Boss and Pattern Quest facts require exact historical row and learner ownership', () => {
  const boss = completedSession('learner-a', 'sess-boss', NOW + 1, { mode: 'boss' });
  const pattern = completedSession('learner-a', 'sess-pattern', NOW + 2, { mode: 'pattern-quest' });
  const wrongProfile = completedSession('learner-a', 'sess-wrong-profile', NOW + 3, { mode: 'boss' });
  wrongProfile.state.session.profileId = 'learner-b';
  const wrongMode = completedSession('learner-a', 'sess-wrong-history-mode', NOW + 4, { mode: 'pattern-quest' });
  wrongMode.state.session.mode = 'boss';
  const output = project({
    profiles: [profile('learner-a', 'Ada', 'Y3', '#3366AA')],
    learnerSnapshots: [snapshot('learner-a')],
    completedSessions: [boss, pattern, wrongProfile, wrongMode],
  });
  assert.deepEqual(output[0].recentRevisionSessions.map(({ mode, eligibleMissionKind }) => ({
    mode, eligibleMissionKind,
  })), [
    { mode: 'pattern-quest', eligibleMissionKind: null },
    { mode: 'boss', eligibleMissionKind: null },
  ]);
});

test('a real planner-completed Guardian practice row projects into Parent revision history', () => {
  let current = snapshot('learner-a', {
    progressById: Object.fromEntries(fullCatalogue.items.map((item) => [item.runtimeItemId, progress(item, {
      stage: 4, attempts: 4, correct: 4, wrong: 0, dueDay: TODAY,
    })])),
  });
  current.subjectState.data.postMega = {
    unlockedAt: NOW - 1,
    unlockedContentReleaseId: 'spelling-r7',
    unlockedPublishedCoreCount: fullCatalogue.items.length,
    unlockedBy: 'all-core-stage-4',
  };
  current.monsterStateByRewardTrackId = {};
  current.campStateByPackId = {};
  const apply = (command) => applySpellingCommand({
    snapshot: current, command, contentSnapshot: fullCatalogue,
    now: () => NOW, random: () => 0.25,
  });
  current = advance(current, apply({
    type: 'start-session',
    payload: {
      mode: 'guardian', yearFilter: 'core', length: 5, practiceOnly: false, words: [],
    },
  }));
  let guard = 0;
  while (current.subjectState.ui.phase === 'session') {
    guard += 1;
    assert.ok(guard < 20);
    const item = fullCatalogue.items.find(({ runtimeItemId }) => (
      runtimeItemId === current.subjectState.ui.session.currentRuntimeItemId
    ));
    current = advance(current, apply({ type: 'submit-answer', payload: { typed: item.target } }));
    if (current.subjectState.ui.phase === 'session' && current.subjectState.ui.awaitingAdvance) {
      current = advance(current, apply({ type: 'continue-session', payload: {} }));
    }
  }
  assert.deepEqual(Object.keys(current.practiceSession), [
    'id', 'learnerId', 'subjectId', 'status', 'mode', 'state', 'summary',
    'startedAt', 'updatedAt', 'completedAt',
  ]);

  const output = project({
    profiles: [profile('learner-a', 'Ada', 'Y3', '#3366AA')],
    learnerSnapshots: [current],
    completedSessions: [current.practiceSession],
  });
  assert.equal(output[0].recentRevisionSessions.length, 1);
  assert.equal(output[0].recentRevisionSessions[0].mode, 'guardian');
  assert.equal(output[0].recentRevisionSessions[0].eligibleMissionKind, 'first-patrol');
  assert.equal(output[0].recentRevisionSessions[0].completedAt, NOW);
});

test('completed session facts require coherent durable timestamps and summary identity', () => {
  const beforeStart = completedSession('learner-a', 'sess-before-start', NOW);
  beforeStart.completedAt = beforeStart.startedAt - 1;
  const afterUpdate = completedSession('learner-a', 'sess-after-update', NOW + 1);
  afterUpdate.updatedAt = afterUpdate.completedAt - 1;
  const wrongSummary = completedSession('learner-a', 'sess-wrong-summary', NOW + 2);
  wrongSummary.summary.sessionId = 'another-session';
  wrongSummary.summary.mode = 'guardian';
  const wrongMode = completedSession('learner-a', 'sess-wrong-mode', NOW + 3);
  wrongMode.summary.sessionId = wrongMode.id;
  wrongMode.summary.mode = 'boss';

  const output = project({
    profiles: [profile('learner-a', 'Ada', 'Y3', '#3366AA')],
    learnerSnapshots: [snapshot('learner-a')],
    completedSessions: [beforeStart, afterUpdate, wrongSummary, wrongMode],
  });
  assert.deepEqual(output[0].recentRevisionSessions, []);
});

test('Guardian revision facts require the complete immutable A3 mission stamp and integrity contract', () => {
  const mutations = [
    (row) => { delete row.state.session.revisionMission; },
    (row) => { delete row.state.session.revisionMissionIntegrity; },
    (row) => { row.state.session.revisionMission.extra = true; },
    (row) => { row.state.session.revisionMission.startedGuardianDay = -1; },
    (row) => { row.state.session.revisionMission.startedGuardianDay = String(TODAY); },
    (row) => { row.state.session.revisionMission.campEligible = 'yes'; },
    (row) => { row.state.session.revisionMissionIntegrity = 'forged'; },
    (row) => { row.state.session.startedAt += 1; },
    (row) => { row.state.summary.sessionId = 'another-session'; },
    (row) => { row.state.summary.mode = 'boss'; },
    (row) => { row.state.summary.correct -= 1; },
    (row) => { row.state.summary.extra = 'drift'; },
    (row) => { row.id = 'Invalid Session'; row.state.session.id = row.id; row.summary.sessionId = row.id; row.state.summary.sessionId = row.id; },
  ];
  const completedSessions = mutations.map((mutate, index) => {
    const row = completedSession('learner-a', `sess-tampered-${index}`, NOW + index);
    mutate(row);
    return row;
  });
  const output = project({
    profiles: [profile('learner-a', 'Ada', 'Y3', '#3366AA')],
    learnerSnapshots: [snapshot('learner-a')],
    completedSessions,
  });
  assert.deepEqual(output[0].recentRevisionSessions, []);
});

test('completed session input objects reject accessors, hidden fields and symbols without getter calls', () => {
  let getterCalls = 0;
  const cases = [];
  const accessorTargets = [
    (row) => [row, 'learnerId'],
    (row) => [row.summary, 'correct'],
    (row) => [row.state, 'summary'],
    (row) => [row.state.session, 'revisionMission'],
  ];
  for (const [index, target] of accessorTargets.entries()) {
    const row = completedSession('learner-a', `sess-accessor-${index}`, NOW + index);
    const [object, key] = target(row);
    const value = object[key];
    Object.defineProperty(object, key, {
      enumerable: true,
      get() { getterCalls += 1; return value; },
    });
    cases.push(row);
  }
  const hiddenTargets = [
    (row) => [row, 'mode'],
    (row) => [row.summary, 'totalWords'],
    (row) => [row.state, 'phase'],
    (row) => [row.state.session, 'revisionMissionIntegrity'],
  ];
  for (const [index, target] of hiddenTargets.entries()) {
    const row = completedSession('learner-a', `sess-hidden-${index}`, NOW + 10 + index);
    const [object, key] = target(row);
    Object.defineProperty(object, key, { value: object[key], enumerable: false });
    cases.push(row);
  }
  const symbolTargets = [
    (row) => row,
    (row) => row.summary,
    (row) => row.state,
    (row) => row.state.session,
  ];
  for (const [index, target] of symbolTargets.entries()) {
    const row = completedSession('learner-a', `sess-symbol-${index}`, NOW + 20 + index);
    target(row)[Symbol('hidden')] = true;
    cases.push(row);
  }

  const output = project({
    profiles: [profile('learner-a', 'Ada', 'Y3', '#3366AA')],
    learnerSnapshots: [snapshot('learner-a')],
    completedSessions: cases,
  });
  assert.deepEqual(output[0].recentRevisionSessions, []);
  assert.equal(getterCalls, 0);
});

test('duplicate completed session IDs are ambiguous and every row with that ID fails closed', () => {
  const identical = completedSession('learner-a', 'sess-identical', NOW + 1);
  const conflictingA = completedSession('learner-a', 'sess-conflicting', NOW + 2, { correct: 4 });
  const conflictingB = completedSession('learner-a', 'sess-conflicting', NOW + 3, { correct: 3 });
  const unique = completedSession('learner-a', 'sess-unique', NOW + 4, { correct: 5 });
  const output = project({
    profiles: [profile('learner-a', 'Ada', 'Y3', '#3366AA')],
    learnerSnapshots: [snapshot('learner-a')],
    completedSessions: [identical, structuredClone(identical), conflictingA, conflictingB, unique],
  });
  assert.deepEqual(output[0].recentRevisionSessions, [{
    mode: 'guardian', completedAt: NOW + 4, correct: 5, wrong: 0, total: 5,
    eligibleMissionKind: 'due',
  }]);
});

test('changing child A leaves child B byte-identical', () => {
  const profiles = [
    profile('learner-a', 'Ada', 'Y3', '#3366AA'),
    profile('learner-b', 'Ben', 'Y5', '#AA6633'),
  ];
  const before = project({ profiles, learnerSnapshots: [snapshot('learner-a'), snapshot('learner-b')] });
  const item = fullCatalogue.items[0];
  const after = project({ profiles, learnerSnapshots: [
    snapshot('learner-a', { progressById: { [item.runtimeItemId]: progress(item) } }),
    snapshot('learner-b'),
  ] });
  assert.equal(JSON.stringify(after[1]), JSON.stringify(before[1]));
});

test('missing or corrupt child state safely empties only that child without borrowing another', () => {
  const profiles = [
    profile('learner-a', 'Ada', 'Y3', '#3366AA'),
    profile('learner-b', 'Ben', 'Y5', '#AA6633'),
    profile('learner-c', 'Cleo', 'Y4', '#123ABC'),
  ];
  const corrupt = snapshot('learner-b');
  corrupt.subjectState.data.progress['ks2-core:forged'] = { stage: 4 };
  const item = fullCatalogue.items[0];
  const output = project({ profiles, learnerSnapshots: [
    snapshot('learner-a', { progressById: { [item.runtimeItemId]: progress(item, { stage: 4 }) } }),
    corrupt,
  ] });
  assert.equal(output[0].secureItemCount, 1);
  for (const child of output.slice(1)) {
    assert.deepEqual({
      published: child.publishedItemCount, secure: child.secureItemCount, due: child.dueItemCount,
      trouble: child.troubleItemCount, correct: child.correctCount, wrong: child.wrongCount,
      accuracy: child.accuracyPercent, guardian: child.guardianDueCount,
      wobbling: child.wobblingDueCount, next: child.nextGuardianReviewDay,
      sessions: child.recentRevisionSessions,
    }, {
      published: 0, secure: 0, due: 0, trouble: 0, correct: 0, wrong: 0,
      accuracy: null, guardian: 0, wobbling: 0, next: null, sessions: [],
    });
  }
});

test('Parent output contains no raw progress or Monster/Camp domain data at any depth', () => {
  const output = project({
    profiles: [profile('learner-a', 'Ada', 'Y3', '#3366AA')],
    learnerSnapshots: [snapshot('learner-a')],
    completedSessions: [completedSession('learner-a', 'sess-safe', NOW)],
  });
  assert.equal(JSON.stringify(output).includes('progress'), false);
  assert.doesNotThrow(() => assertParentProjectionRedacted(output));
  for (const value of [
    { child: { monsterId: 'safe-looking' } },
    { child: { campHighWater: 1 } },
    { child: { reward_track: 'safe-looking' } },
    { child: { neutral: { branch: 'b1' } } },
    { child: { neutral: 'monster-secret-sentinel' } },
    { child: { neutral: ['camp-secret-sentinel'] } },
    Object.assign(Object.create({}), { safe: true }),
  ]) {
    assert.throws(() => assertParentProjectionRedacted(value), /parent|redact|forbidden|plain|monster|camp|branch|water/i);
  }

  const nullPrototype = Object.create(null);
  nullPrototype.safe = [{ spelling: 'only' }];
  assert.equal(assertParentProjectionRedacted(nullPrototype), nullPrototype);
  assert.doesNotThrow(() => assertParentProjectionRedacted({ nickname: 'Campbell' }));
});

test('recursive redaction rejects forbidden or non-serialisable own keys attached to arrays', () => {
  const forbidden = [];
  forbidden.monsterSecret = 'hidden outside JSON indexes';
  const symbolKeyed = [];
  symbolKeyed[Symbol('camp')] = 'hidden outside JSON indexes';
  assert.throws(() => assertParentProjectionRedacted(forbidden), /forbidden|monster|redact/i);
  assert.throws(() => assertParentProjectionRedacted(symbolKeyed), /plain|serialisable|key|redact/i);
});

test('recursive redaction rejects every custom array prototype without invoking inherited getters', () => {
  let getterCalls = 0;
  const getterPrototype = Object.create(Array.prototype, {
    monsterSecret: {
      get() { getterCalls += 1; return 'hidden'; },
    },
  });
  const inheritedGetter = [];
  Object.setPrototypeOf(inheritedGetter, getterPrototype);
  const dataPrototype = Object.create(Array.prototype, {
    safe: { value: 'inherited', enumerable: true },
  });
  const inheritedData = [];
  Object.setPrototypeOf(inheritedData, dataPrototype);

  assert.throws(() => assertParentProjectionRedacted(inheritedGetter), /array|prototype|plain|redact/i);
  assert.throws(() => assertParentProjectionRedacted(inheritedData), /array|prototype|plain|redact/i);
  assert.equal(getterCalls, 0);
});

test('recursive redaction inspects every object own key and rejects accessors without invoking them', () => {
  const hidden = {};
  Object.defineProperty(hidden, 'campSecret', { value: 1, enumerable: false });
  const symbolKeyed = { safe: true };
  symbolKeyed[Symbol('monster')] = 'hidden';
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'safe', {
    enumerable: true,
    get() { getterCalls += 1; return 'monster-secret-sentinel'; },
  });

  assert.throws(() => assertParentProjectionRedacted(hidden), /forbidden|camp|redact/i);
  assert.throws(() => assertParentProjectionRedacted(symbolKeyed), /plain|serialisable|key|redact/i);
  assert.throws(() => assertParentProjectionRedacted(accessor), /accessor|plain|serialisable|redact/i);
  assert.equal(getterCalls, 0);
});

test('Parent projection validates the clock and keeps stable profile ordering', () => {
  const profiles = [
    profile('learner-b', 'Ben', 'Y5', '#AA6633'),
    profile('learner-a', 'Ada', 'Y3', '#3366AA'),
  ];
  assert.throws(() => projectParentSpellingProgress({
    profiles, learnerSnapshots: [], completedSessions: [], contentSnapshots: [fullCatalogue],
  }), /now|clock/i);
  for (const value of [NaN, Infinity, -1]) {
    assert.throws(() => project({ profiles, learnerSnapshots: [], now: () => value }), /finite|non-negative|timestamp/i);
  }
  assert.deepEqual(project({ profiles, learnerSnapshots: [] }).map(({ learnerId }) => learnerId), ['learner-a', 'learner-b']);
});

test('duplicate snapshots for one learner empty only that ambiguous child', () => {
  const item = fullCatalogue.items[0];
  const output = project({
    profiles: [
      profile('learner-a', 'Ada', 'Y3', '#3366AA'),
      profile('learner-b', 'Ben', 'Y5', '#AA6633'),
    ],
    learnerSnapshots: [
      snapshot('learner-a'),
      snapshot('learner-a'),
      snapshot('learner-b', { progressById: { [item.runtimeItemId]: progress(item, { stage: 4 }) } }),
    ],
  });
  assert.equal(output[0].publishedItemCount, 0);
  assert.equal(output[1].secureItemCount, 1);
});
