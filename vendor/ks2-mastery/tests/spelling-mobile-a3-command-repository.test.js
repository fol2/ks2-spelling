import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  SPELLING_COMMAND_MAX_CONFLICT_ATTEMPTS,
  applySpellingCommand,
  createInMemorySpellingCommandRepository,
  validateSpellingCommandRepository,
} from '../shared/spelling/mobile/a3/index.js';

const catalogue = JSON.parse(await readFile(
  new URL('../content/spelling.mobile-runtime-starter.json', import.meta.url),
  'utf8',
));
const fullCatalogue = JSON.parse(await readFile(
  new URL('../content/spelling.mobile-runtime-full.json', import.meta.url),
  'utf8',
));
const NOW = 1_768_478_400_000;
const TODAY = Math.floor(NOW / 86_400_000);

function snapshot(learnerId = 'learner-a', revision = 0) {
  return {
    schemaVersion: 1,
    learnerId,
    revision,
    packId: catalogue.packId,
    catalogueId: catalogue.catalogueId,
    grantedEntitlementIds: [],
    subjectState: {
      ui: {},
      data: {
        prefs: { autoSpeak: false },
        progress: {},
        guardianMap: {},
        pattern: { wobblingByRuntimeItemId: {} },
        postMega: null,
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

function fullSnapshot({ fullMega = false } = {}) {
  const value = snapshot();
  value.catalogueId = fullCatalogue.catalogueId;
  value.grantedEntitlementIds = ['full-ks2'];
  if (fullMega) {
    value.subjectState.data.progress = Object.fromEntries(fullCatalogue.items.map((item) => [item.runtimeItemId, {
      legacySlug: item.legacySlug, stage: 4, attempts: 4, correct: 4, wrong: 0,
      dueDay: TODAY, lastDay: TODAY - 7, lastResult: 'correct',
    }]));
  }
  return value;
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

function applyStarterAt(current, command, nowMs) {
  return applySpellingCommand({
    snapshot: current,
    command,
    contentSnapshot: catalogue,
    now: () => nowMs,
    random: () => 0.25,
  });
}

function singleCommand(type, payload = {}) {
  if (type !== 'start-session') return { type, payload };
  return {
    type,
    payload: {
      mode: 'single', yearFilter: 'core', length: 1,
      practiceOnly: true, words: ['ks2-core:answer'],
    },
  };
}

function unchangedPlan(current, nowOrContext = 0) {
  const nowMs = typeof nowOrContext === 'number' ? nowOrContext : nowOrContext.nowMs;
  const todayGuardianDay = Math.floor(nowMs / 86_400_000);
  const revisionMission = {
    missionState: 'locked', eligibleMissionKind: null,
    guardianDueCount: 0, wobblingDueCount: 0, nextGuardianDueDay: null,
    todayGuardianDay,
    canStartRewardBearing: false, canContinueUnrewarded: false,
    campCreditState: 'unavailable',
  };
  const activeCamp = current.campStateByPackId[catalogue.packId] || {
    packId: catalogue.packId, campHighWater: 0,
    lastCreditedGuardianDay: null, lastCreditedEventId: null, acknowledgements: [],
  };
  return {
    schemaVersion: 1,
    learnerId: current.learnerId,
    expectedRevision: current.revision,
    nextRevision: current.revision,
    changed: false,
    ok: true,
    nextSubjectState: structuredClone(current.subjectState),
    nextPracticeSession: structuredClone(current.practiceSession),
    nextEventLog: structuredClone(current.eventLog),
    appendedEvents: [],
    nextMonsterStateByRewardTrackId: structuredClone(current.monsterStateByRewardTrackId),
    nextCampStateByPackId: structuredClone(current.campStateByPackId),
    projections: {
      monsters: Object.values(structuredClone(current.monsterStateByRewardTrackId)),
      revisionMission,
      camp: {
        ...structuredClone(activeCamp), creditApplied: 0,
        completedGuardianDay: null, canEarnToday: false,
      },
    },
    transientEffects: [],
    result: { ok: true, changed: false, state: structuredClone(current.subjectState.ui), events: [] },
  };
}

function changedPlan(current, autoSpeak = !current.subjectState.data.prefs.autoSpeak) {
  const plan = unchangedPlan(current);
  plan.changed = true;
  plan.nextRevision += 1;
  plan.nextSubjectState.data.prefs.autoSpeak = autoSpeak;
  plan.result = { ok: true, changed: true, state: structuredClone(plan.nextSubjectState.ui), events: [] };
  return plan;
}

function repository(options = {}) {
  return createInMemorySpellingCommandRepository({
    snapshots: [snapshot()],
    cataloguesById: { [catalogue.catalogueId]: catalogue },
    now: () => 0,
    ...options,
  });
}

test('repository contract is deliberately narrow and fixes conflict attempts at three', () => {
  const candidate = repository();
  assert.equal(SPELLING_COMMAND_MAX_CONFLICT_ATTEMPTS, 3);
  assert.deepEqual(Object.keys(candidate), ['runCommandTransaction']);
  assert.equal(validateSpellingCommandRepository(candidate), candidate);
  for (const invalid of [null, {}, { runCommandTransaction: true }, {
    runCommandTransaction() {}, readSnapshot() {},
  }, {
    runCommandTransaction() {}, [Symbol('internal')]() {},
  }]) {
    assert.throws(() => validateSpellingCommandRepository(invalid), /repository|runCommandTransaction|unknown/i);
  }
  assert.throws(() => createInMemorySpellingCommandRepository({
    snapshots: [snapshot()], cataloguesById: { [catalogue.catalogueId]: catalogue },
  }), /injected now/i);
});

test('repository certifies one injected command clock and passes it to the planner', async () => {
  let clockCalls = 0;
  const repo = repository({ now: () => { clockCalls += 1; return 2 * 86_400_000; } });
  const plan = await repo.runCommandTransaction('learner-a', (fresh, context) => {
    assert.deepEqual(context, { nowMs: 2 * 86_400_000, todayGuardianDay: 2 });
    assert.equal(Object.isFrozen(context), true);
    return unchangedPlan(fresh, context);
  });
  assert.equal(plan.projections.revisionMission.todayGuardianDay, 2);
  assert.equal(clockCalls, 1);
});

test('repository accepts planner output produced from the exact injected command clock', async () => {
  const repo = repository({ now: () => 1_000 });
  const plan = await repo.runCommandTransaction('learner-a', (fresh, { nowMs }) => applyStarterAt(
    fresh, singleCommand('start-session'), nowMs,
  ));
  assert.equal(plan.nextPracticeSession.startedAt, 1_000);
  assert.equal(plan.nextPracticeSession.updatedAt, 1_000);
  assert.equal(plan.projections.revisionMission.todayGuardianDay, 0);
  assert.ok(plan.appendedEvents.every(({ createdAt }) => createdAt === 1_000));
});

test('repository rejects same-day planner clock drift for every practice timestamp transition', async () => {
  const initial = snapshot();
  const started = advance(initial, applyStarterAt(initial, singleCommand('start-session'), 0));
  const awaitingFirst = advance(started, applyStarterAt(
    started, singleCommand('submit-answer', { typed: 'answer' }), 0,
  ));
  const secondQuestion = advance(
    awaitingFirst, applyStarterAt(awaitingFirst, singleCommand('continue-session'), 0),
  );
  const awaitingSecond = advance(
    secondQuestion,
    applyStarterAt(secondQuestion, singleCommand('submit-answer', { typed: 'answer' }), 0),
  );
  const cases = [
    { label: 'new session', input: initial, command: singleCommand('start-session') },
    { label: 'continued active session', input: awaitingFirst, command: singleCommand('continue-session') },
    { label: 'completed session', input: awaitingSecond, command: singleCommand('continue-session') },
    { label: 'abandoned session', input: started, command: singleCommand('end-session') },
  ];

  for (const { label, input, command } of cases) {
    const checkpoints = [];
    const repo = createInMemorySpellingCommandRepository({
      snapshots: [input],
      cataloguesById: { [catalogue.catalogueId]: catalogue },
      now: () => 0,
      failureInjector(checkpoint) { checkpoints.push(checkpoint); },
    });
    await assert.rejects(
      repo.runCommandTransaction('learner-a', (fresh) => applyStarterAt(fresh, command, 1_000)),
      /practice.*timestamp|command clock|expected now/i,
      label,
    );
    assert.deepEqual(checkpoints, [], label);
  }
});

test('repository preserves an unchanged historical practice row without applying the command clock', async () => {
  let current = snapshot();
  for (const command of [
    singleCommand('start-session'),
    singleCommand('submit-answer', { typed: 'answer' }),
    singleCommand('continue-session'),
    singleCommand('submit-answer', { typed: 'answer' }),
    singleCommand('continue-session'),
  ]) {
    current = advance(current, applyStarterAt(current, command, 0));
  }
  assert.equal(current.practiceSession.status, 'completed');
  const historical = structuredClone(current.practiceSession);
  const repo = createInMemorySpellingCommandRepository({
    snapshots: [current],
    cataloguesById: { [catalogue.catalogueId]: catalogue },
    now: () => 1_000,
  });
  const plan = await repo.runCommandTransaction('learner-a', (fresh, { nowMs }) => applyStarterAt(
    fresh,
    { type: 'save-prefs', payload: { prefs: { autoSpeak: true } } },
    nowMs,
  ));
  assert.deepEqual(plan.nextPracticeSession, historical);
});

test('conflict retry commits only the second attempt exact timestamp and Guardian day', async () => {
  const sampledTimes = [1_000, 86_400_000 + 2_000];
  const plannerTimes = [];
  let clockCalls = 0;
  let conflictPending = true;
  const repo = repository({
    now() {
      const sampled = sampledTimes[clockCalls];
      clockCalls += 1;
      return sampled;
    },
    failureInjector(checkpoint) {
      if (checkpoint === 'before-commit' && conflictPending) {
        conflictPending = false;
        const error = new Error('spelling_revision_conflict');
        error.code = 'spelling_revision_conflict';
        throw error;
      }
    },
  });
  const committed = await repo.runCommandTransaction('learner-a', (fresh, { nowMs }) => {
    plannerTimes.push(nowMs);
    return applyStarterAt(fresh, singleCommand('start-session'), nowMs);
  });
  assert.equal(clockCalls, 2);
  assert.deepEqual(plannerTimes, sampledTimes);
  assert.equal(committed.nextPracticeSession.startedAt, sampledTimes[1]);
  assert.equal(committed.nextPracticeSession.updatedAt, sampledTimes[1]);
  assert.equal(committed.projections.revisionMission.todayGuardianDay, 1);
  assert.ok(committed.appendedEvents.every(({ createdAt }) => createdAt === sampledTimes[1]));
});

test('repository rejects an invalid command clock before planning or staging', async () => {
  let plannerCalls = 0;
  const checkpoints = [];
  const repo = repository({
    now: () => NaN,
    failureInjector(checkpoint) { checkpoints.push(checkpoint); },
  });
  await assert.rejects(repo.runCommandTransaction('learner-a', () => {
    plannerCalls += 1;
    return null;
  }), /Guardian clock|finite non-negative/i);
  assert.equal(plannerCalls, 0);
  assert.deepEqual(checkpoints, []);
});

test('repository contract rejects inherited methods and getters on custom prototypes', () => {
  const inheritedMethod = Object.create({ readSnapshot() {} });
  inheritedMethod.runCommandTransaction = async () => {};
  const inheritedGetter = Object.create(Object.defineProperty({}, 'internalState', {
    get() { return 'hidden'; },
  }));
  inheritedGetter.runCommandTransaction = async () => {};

  for (const candidate of [inheritedMethod, inheritedGetter]) {
    assert.throws(
      () => validateSpellingCommandRepository(candidate),
      /plain|prototype|repository/i,
    );
  }

  const nullPrototype = Object.create(null);
  nullPrototype.runCommandTransaction = async () => {};
  assert.equal(validateSpellingCommandRepository(nullPrototype), nullPrototype);
});

test('transaction reads and catalogue registry are defensive clones', async () => {
  const seed = snapshot();
  const registry = { [catalogue.catalogueId]: structuredClone(catalogue) };
  const repo = createInMemorySpellingCommandRepository({
    snapshots: [seed], cataloguesById: registry, now: () => 0,
  });
  seed.subjectState.data.prefs.autoSpeak = true;
  registry[catalogue.catalogueId].items[0].target = 'tampered';

  await assert.rejects(repo.runCommandTransaction('learner-a', (fresh) => {
    assert.equal(fresh.subjectState.data.prefs.autoSpeak, false);
    fresh.subjectState.data.prefs.autoSpeak = true;
    throw new Error('planner-failed');
  }), /planner-failed/);

  let observed;
  await repo.runCommandTransaction('learner-a', (fresh) => {
    observed = structuredClone(fresh);
    return unchangedPlan(fresh);
  });
  assert.equal(observed.subjectState.data.prefs.autoSpeak, false);
  assert.equal(observed.catalogueId, catalogue.catalogueId);
});

test('unknown catalogues and tampered item or reward-track identities fail before planning', async () => {
  const missing = snapshot();
  missing.catalogueId = 'ks2-core:missing';
  assert.throws(() => createInMemorySpellingCommandRepository({
    snapshots: [missing], cataloguesById: { [catalogue.catalogueId]: catalogue }, now: () => 0,
  }), /catalogue/i);

  const badItemCatalogue = structuredClone(catalogue);
  badItemCatalogue.items[0].packId = 'another-pack';
  assert.throws(() => createInMemorySpellingCommandRepository({
    snapshots: [snapshot()],
    cataloguesById: { [catalogue.catalogueId]: badItemCatalogue },
    now: () => 0,
  }), /item|pack/i);

  const badTrack = snapshot();
  badTrack.monsterStateByRewardTrackId[catalogue.rewardTracks[0].rewardTrackId] = {
    rewardTrackId: catalogue.rewardTracks[0].rewardTrackId,
    packId: catalogue.packId,
    monsterId: 'forged-monster',
    branch: 'b1',
    secureCount: 0,
    caught: false,
    derivedStage: 0,
    earnedStageHighWater: 0,
  };
  assert.throws(() => createInMemorySpellingCommandRepository({
    snapshots: [badTrack], cataloguesById: { [catalogue.catalogueId]: catalogue }, now: () => 0,
  }), /monster|identity|reward/i);
});

test('returned plans are catalogue-validated before any staging checkpoint', async () => {
  for (const mutate of [
    (plan) => {
      plan.nextSubjectState.data.progress['ks2-core:forged'] = {
        legacySlug: 'forged', stage: 0, attempts: 0, correct: 0, wrong: 0,
        dueDay: 0, lastDay: null, lastResult: null,
      };
    },
    (plan) => {
      const rewardTrackId = catalogue.rewardTracks[0].rewardTrackId;
      plan.nextMonsterStateByRewardTrackId[rewardTrackId] = {
        rewardTrackId, packId: catalogue.packId,
        monsterId: 'forged-monster', branch: 'b1', secureCount: 0,
        caught: false, derivedStage: 0, earnedStageHighWater: 0,
      };
    },
  ]) {
    const checkpoints = [];
    const repo = repository({ failureInjector(checkpoint) { checkpoints.push(checkpoint); } });
    await assert.rejects(repo.runCommandTransaction('learner-a', (fresh) => {
      const plan = changedPlan(fresh, true);
      mutate(plan);
      return plan;
    }), /runtime item|unknown|monster|identity|catalogue/i);
    assert.deepEqual(checkpoints, []);
  }
});

test('repository rejects forged non-durable plan outputs before the first staging checkpoint', async () => {
  const mutations = [
    (plan) => { plan.projections.monsters = [{ rewardTrackId: 'forged-track' }]; },
    (plan) => { plan.projections.revisionMission.canStartRewardBearing = true; },
    (plan) => { plan.projections.camp.creditApplied = 2; },
    (plan) => { plan.transientEffects = [{ type: 'execute', payload: { source: 'javascript:alert(1)' } }]; },
    (plan) => { plan.result = { ...plan.result, changed: false }; },
  ];
  for (const mutate of mutations) {
    const checkpoints = [];
    const repo = repository({ failureInjector(checkpoint) { checkpoints.push(checkpoint); } });
    await assert.rejects(repo.runCommandTransaction('learner-a', (fresh) => {
      const plan = changedPlan(fresh, true);
      mutate(plan);
      return plan;
    }), /projection|Monster|revision|Camp|effect|audio|result|changed/i);
    assert.deepEqual(checkpoints, []);
  }
});

test('repository rejects custom Array prototypes without invoking an inherited malicious map', async () => {
  let maliciousMapCalls = 0;
  const checkpoints = [];
  const repo = repository({ failureInjector(checkpoint) { checkpoints.push(checkpoint); } });
  const maliciousEffects = [];
  Object.setPrototypeOf(maliciousEffects, {
    map() {
      maliciousMapCalls += 1;
      return [{ type: 'wipe-device', payload: { execute: true } }];
    },
  });
  await assert.rejects(repo.runCommandTransaction('learner-a', (fresh) => {
    const plan = changedPlan(fresh, true);
    plan.transientEffects = maliciousEffects;
    return plan;
  }), /array|prototype|serialisable|plain/i);
  assert.equal(maliciousMapCalls, 0);
  assert.deepEqual(checkpoints, []);

  const unchanged = await repo.runCommandTransaction('learner-a', unchangedPlan);
  assert.equal(unchanged.nextRevision, 0);
});

test('repository rejects hostile seed snapshot accessors without invoking getters', () => {
  let getterCalls = 0;
  const hostile = snapshot();
  Object.defineProperty(hostile.subjectState.data.achievements, 'secret', {
    enumerable: true,
    get() { getterCalls += 1; return 'leaked'; },
  });
  assert.throws(() => createInMemorySpellingCommandRepository({
    snapshots: [hostile],
    cataloguesById: { [catalogue.catalogueId]: catalogue },
    now: () => 0,
  }), /data property|serialisable|accessor/i);
  assert.equal(getterCalls, 0);
});

test('repository binds result prefs byte-for-byte to durable subject prefs', async () => {
  const checkpoints = [];
  const repo = repository({ failureInjector(checkpoint) { checkpoints.push(checkpoint); } });
  await assert.rejects(repo.runCommandTransaction('learner-a', (fresh) => {
    const plan = changedPlan(fresh, true);
    plan.result.prefs = { autoSpeak: false };
    return plan;
  }), /result.*prefs|durable.*prefs|byte-for-byte/i);
  assert.deepEqual(checkpoints, []);
});

test('repository rejects semantically forged revision projections before staging', async () => {
  const noMasteryMutations = [
    (projection) => { projection.todayGuardianDay = TODAY + 1; },
    (projection) => Object.assign(projection, {
      missionState: 'first-patrol', eligibleMissionKind: 'first-patrol',
      guardianDueCount: 0, wobblingDueCount: 0, nextGuardianDueDay: null,
      canStartRewardBearing: true, canContinueUnrewarded: false, campCreditState: 'available',
    }),
    (projection) => Object.assign(projection, {
      missionState: 'due', eligibleMissionKind: 'due',
      guardianDueCount: 1, wobblingDueCount: 0, nextGuardianDueDay: TODAY,
      canStartRewardBearing: true, canContinueUnrewarded: false, campCreditState: 'available',
    }),
    (projection) => Object.assign(projection, {
      missionState: 'wobbling', eligibleMissionKind: 'wobbling',
      guardianDueCount: 1, wobblingDueCount: 1, nextGuardianDueDay: TODAY,
      canStartRewardBearing: true, canContinueUnrewarded: false, campCreditState: 'available',
    }),
  ];
  for (const mutate of noMasteryMutations) {
    const checkpoints = [];
    const initial = fullSnapshot();
    const repo = createInMemorySpellingCommandRepository({
      snapshots: [initial], cataloguesById: { [fullCatalogue.catalogueId]: fullCatalogue },
      now: () => NOW,
      failureInjector(checkpoint) { checkpoints.push(checkpoint); },
    });
    await assert.rejects(repo.runCommandTransaction('learner-a', (fresh) => {
      const plan = applySpellingCommand({
        snapshot: fresh,
        command: { type: 'save-prefs', payload: { prefs: { autoSpeak: true } } },
        contentSnapshot: fullCatalogue, now: () => NOW, random: () => 0.25,
      });
      mutate(plan.projections.revisionMission);
      plan.projections.camp.canEarnToday = plan.projections.revisionMission.canStartRewardBearing;
      return plan;
    }), /revision|projection|mastery|authority|durable/i);
    assert.deepEqual(checkpoints, []);
  }

  const checkpoints = [];
  const initial = fullSnapshot({ fullMega: true });
  const repo = createInMemorySpellingCommandRepository({
    snapshots: [initial], cataloguesById: { [fullCatalogue.catalogueId]: fullCatalogue },
    now: () => NOW,
    failureInjector(checkpoint) { checkpoints.push(checkpoint); },
  });
  await assert.rejects(repo.runCommandTransaction('learner-a', (fresh) => {
    const plan = applySpellingCommand({
      snapshot: fresh,
      command: { type: 'save-prefs', payload: { prefs: { autoSpeak: true } } },
      contentSnapshot: fullCatalogue, now: () => NOW, random: () => 0.25,
    });
    Object.assign(plan.projections.revisionMission, {
      missionState: 'locked', eligibleMissionKind: null,
      guardianDueCount: 0, wobblingDueCount: 0, nextGuardianDueDay: null,
      canStartRewardBearing: false, canContinueUnrewarded: false, campCreditState: 'available',
    });
    plan.projections.camp.canEarnToday = false;
    return plan;
  }), /revision|projection|mastery|authority|durable/i);
  assert.deepEqual(checkpoints, []);
});

test('repository requires a real completed Guardian transition before applying Camp credit', async () => {
  const initial = fullSnapshot({ fullMega: true });
  const started = applySpellingCommand({
    snapshot: initial,
    command: {
      type: 'start-session',
      payload: { mode: 'guardian', yearFilter: 'core', length: 5, practiceOnly: false, words: [] },
    },
    contentSnapshot: fullCatalogue, now: () => NOW, random: () => 0.25,
  });
  const active = advance(initial, started);
  const sessionId = active.practiceSession.id;
  const checkpoints = [];
  const repo = createInMemorySpellingCommandRepository({
    snapshots: [active], cataloguesById: { [fullCatalogue.catalogueId]: fullCatalogue },
    now: () => NOW,
    failureInjector(checkpoint) { checkpoints.push(checkpoint); },
  });
  await assert.rejects(repo.runCommandTransaction('learner-a', (fresh) => {
    const plan = applySpellingCommand({
      snapshot: fresh,
      command: { type: 'save-prefs', payload: { prefs: { autoSpeak: true } } },
      contentSnapshot: fullCatalogue, now: () => NOW, random: () => 0.25,
    });
    const event = {
      id: `spelling.guardian.mission-completed:learner-a:${sessionId}`,
      type: 'spelling.guardian.mission-completed', subjectId: 'spelling', learnerId: 'learner-a',
      sessionId, mode: 'guardian', createdAt: NOW, packId: fullCatalogue.packId,
      totalWords: 1, renewalCount: 1, wobbledCount: 0, recoveredCount: 0,
    };
    const campState = {
      packId: fullCatalogue.packId, campHighWater: 1, lastCreditedGuardianDay: TODAY,
      lastCreditedEventId: event.id, acknowledgements: [],
    };
    plan.nextEventLog.push(event);
    plan.appendedEvents.push(event);
    plan.result.events.push(event);
    plan.nextCampStateByPackId[fullCatalogue.packId] = campState;
    Object.assign(plan.projections.revisionMission, {
      campCreditState: 'complete-for-today',
      canStartRewardBearing: false,
      canContinueUnrewarded: plan.projections.revisionMission.eligibleMissionKind !== null,
    });
    plan.projections.camp = {
      ...campState, creditApplied: 1, completedGuardianDay: TODAY, canEarnToday: false,
    };
    return plan;
  }), /completed|practice session|summary|Guardian transition|historical/i);
  assert.deepEqual(checkpoints, []);
});

test('repository rejects a forged Camp credit without Full access or a stamped Guardian origin', async () => {
  const checkpoints = [];
  const repo = repository({ failureInjector(checkpoint) { checkpoints.push(checkpoint); } });
  await assert.rejects(repo.runCommandTransaction('learner-a', (fresh) => {
    const plan = changedPlan(fresh, true);
    const event = {
      id: 'spelling.guardian.mission-completed:learner-a:sess-forged',
      type: 'spelling.guardian.mission-completed', subjectId: 'spelling', learnerId: 'learner-a',
      sessionId: 'sess-forged', mode: 'guardian', createdAt: 10, packId: catalogue.packId,
      totalWords: 1, renewalCount: 1, wobbledCount: 0, recoveredCount: 0,
    };
    const campState = {
      packId: catalogue.packId, campHighWater: 1, lastCreditedGuardianDay: 0,
      lastCreditedEventId: event.id, acknowledgements: [],
    };
    plan.nextEventLog = [event];
    plan.appendedEvents = [event];
    plan.nextCampStateByPackId = { [catalogue.packId]: campState };
    plan.projections.camp = {
      ...campState, creditApplied: 1, completedGuardianDay: 0, canEarnToday: false,
    };
    plan.result.events = [event];
    return plan;
  }), /Camp|Full|access|mission|origin|stamp/i);
  assert.deepEqual(checkpoints, []);
});

test('active commands preserve inactive Camp pack history through repository roundtrips', async () => {
  const initial = snapshot();
  initial.campStateByPackId = {
    [catalogue.packId]: {
      packId: catalogue.packId, campHighWater: 1, lastCreditedGuardianDay: 5,
      lastCreditedEventId: 'spelling.guardian.mission-completed:learner-a:sess-core', acknowledgements: [],
    },
    'future-pack': {
      packId: 'future-pack', campHighWater: 4, lastCreditedGuardianDay: 8,
      lastCreditedEventId: 'spelling.guardian.mission-completed:learner-a:sess-future',
      acknowledgements: [{ stage: 4 }],
    },
  };
  const inactiveBefore = structuredClone(initial.campStateByPackId['future-pack']);
  const repo = createInMemorySpellingCommandRepository({
    snapshots: [initial], cataloguesById: { [catalogue.catalogueId]: catalogue },
    now: () => 9 * 86_400_000,
  });
  const result = await repo.runCommandTransaction('learner-a', (fresh) => applySpellingCommand({
    snapshot: fresh,
    command: { type: 'save-prefs', payload: { prefs: { autoSpeak: true } } },
    contentSnapshot: catalogue,
    now: () => 9 * 86_400_000,
    random: () => 0.25,
  }));
  assert.deepEqual(result.nextCampStateByPackId['future-pack'], inactiveBefore);
  assert.equal(result.projections.camp.packId, catalogue.packId);

  let roundtripped;
  await repo.runCommandTransaction('learner-a', (fresh, context) => {
    roundtripped = structuredClone(fresh);
    return unchangedPlan(fresh, context);
  });
  assert.deepEqual(roundtripped.campStateByPackId['future-pack'], inactiveBefore);
  assert.equal(roundtripped.campStateByPackId[catalogue.packId].packId, catalogue.packId);
});

test('same-learner calls serialise while a different learner proceeds independently', async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const seen = [];
  const repo = createInMemorySpellingCommandRepository({
    snapshots: [snapshot('learner-a'), snapshot('learner-b')],
    cataloguesById: { [catalogue.catalogueId]: catalogue },
    now: () => 0,
  });

  const first = repo.runCommandTransaction('learner-a', async (fresh) => {
    seen.push(['a-first', fresh.revision]);
    await firstGate;
    return changedPlan(fresh, true);
  });
  const second = repo.runCommandTransaction('learner-a', (fresh) => {
    seen.push(['a-second', fresh.revision]);
    return changedPlan(fresh, false);
  });
  const other = repo.runCommandTransaction('learner-b', (fresh) => {
    seen.push(['b', fresh.revision]);
    return changedPlan(fresh, true);
  });

  const otherResult = await other;
  assert.equal(otherResult.nextRevision, 1);
  assert.deepEqual(seen, [['a-first', 0], ['b', 0]]);
  releaseFirst();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.nextRevision, 1);
  assert.equal(secondResult.nextRevision, 2);
  assert.deepEqual(seen, [['a-first', 0], ['b', 0], ['a-second', 1]]);
});

test('plan learner and revision mismatch plus false-labelled durable or transient changes fail closed', async () => {
  const mutations = [
    (plan) => { plan.learnerId = 'learner-b'; },
    (plan) => { plan.expectedRevision += 1; plan.nextRevision += 1; },
    (plan) => { plan.nextSubjectState.data.prefs.autoSpeak = true; },
    (plan) => { plan.transientEffects.push({ type: 'audio-cue', payload: {} }); },
  ];
  for (const mutate of mutations) {
    const repo = repository();
    await assert.rejects(repo.runCommandTransaction('learner-a', (fresh) => {
      const plan = unchangedPlan(fresh);
      mutate(plan);
      return plan;
    }), /learner|revision|changed false|durable|transient/i);
  }

  const repo = repository();
  const result = await repo.runCommandTransaction('learner-a', unchangedPlan);
  assert.equal(result.nextRevision, 0);
  let revision;
  await repo.runCommandTransaction('learner-a', (fresh) => {
    revision = fresh.revision;
    return unchangedPlan(fresh);
  });
  assert.equal(revision, 0);
});

test('exact event replay is ignored while same-ID different-payload reuse collides', async () => {
  const event = {
    id: 'spelling.session-completed:learner-a:sess-1',
    type: 'spelling.session-completed',
    subjectId: 'spelling',
    learnerId: 'learner-a',
    sessionId: 'sess-1',
    mode: 'smart',
    createdAt: 10,
    sessionType: 'learning',
    totalWords: 1,
    mistakeCount: 0,
  };
  const initial = snapshot();
  initial.eventLog.push(event);
  const repo = createInMemorySpellingCommandRepository({
    snapshots: [initial], cataloguesById: { [catalogue.catalogueId]: catalogue }, now: () => 0,
  });

  const replay = await repo.runCommandTransaction('learner-a', (fresh) => {
    const plan = unchangedPlan(fresh);
    plan.appendedEvents = [structuredClone(event)];
    return plan;
  });
  assert.deepEqual(replay.appendedEvents, []);
  assert.equal(replay.nextRevision, 0);

  await assert.rejects(repo.runCommandTransaction('learner-a', (fresh) => {
    const plan = unchangedPlan(fresh);
    plan.appendedEvents = [{ ...event, mistakeCount: 1 }];
    return plan;
  }), /spelling_event_id_collision/);
});

test('conflicts re-read and replan, then stop at the fixed third attempt without mutation', async () => {
  let conflictsRemaining = 1;
  let attempts = 0;
  let clockCalls = 0;
  const conflict = new Error('spelling_revision_conflict');
  conflict.code = 'spelling_revision_conflict';
  const repo = repository({
    now() { clockCalls += 1; return 0; },
    failureInjector(checkpoint) {
      if (checkpoint === 'before-commit' && conflictsRemaining > 0) {
        conflictsRemaining -= 1;
        throw conflict;
      }
    },
  });
  const committed = await repo.runCommandTransaction('learner-a', (fresh) => {
    attempts += 1;
    assert.equal(fresh.revision, 0);
    return changedPlan(fresh, true);
  });
  assert.equal(attempts, 2);
  assert.equal(clockCalls, 2);
  assert.equal(committed.nextRevision, 1);

  attempts = 0;
  clockCalls = 0;
  const exhausted = repository({
    now() { clockCalls += 1; return 0; },
    failureInjector(checkpoint) {
      if (checkpoint === 'before-commit') {
        const error = new Error('spelling_revision_conflict');
        error.code = 'spelling_revision_conflict';
        throw error;
      }
    },
  });
  await assert.rejects(exhausted.runCommandTransaction('learner-a', (fresh) => {
    attempts += 1;
    return changedPlan(fresh, true);
  }), (error) => error?.code === 'spelling_revision_conflict' && error.message === 'spelling_revision_conflict');
  assert.equal(attempts, 3);
  assert.equal(clockCalls, 3);
  let after;
  await exhausted.runCommandTransaction('learner-a', (fresh) => {
    after = structuredClone(fresh);
    return unchangedPlan(fresh);
  });
  assert.equal(clockCalls, 4);
  assert.deepEqual(after, snapshot());
});
