import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createInMemorySpellingCommandRepository } from '../shared/spelling/mobile/a3/index.js';

const catalogue = JSON.parse(await readFile(
  new URL('../content/spelling.mobile-runtime-starter.json', import.meta.url),
  'utf8',
));
const rewardTrack = catalogue.rewardTracks[0];
const NOW = 10;

function snapshot() {
  return {
    schemaVersion: 1,
    learnerId: 'learner-a',
    revision: 0,
    packId: catalogue.packId,
    catalogueId: catalogue.catalogueId,
    grantedEntitlementIds: [],
    subjectState: {
      ui: {},
      data: {
        prefs: { autoSpeak: false }, progress: {}, guardianMap: {},
        pattern: { wobblingByRuntimeItemId: {} }, postMega: null,
        achievements: {}, persistenceWarning: null,
      },
    },
    practiceSession: null,
    eventLog: [],
    monsterStateByRewardTrackId: {},
    campStateByPackId: {},
  };
}

function allTargetPlan(current) {
  const event = {
    id: 'spelling.session-completed:learner-a:sess-1',
    type: 'spelling.session-completed', subjectId: 'spelling', learnerId: 'learner-a',
    sessionId: 'sess-1', mode: 'smart', createdAt: NOW,
    sessionType: 'learning', totalWords: 1, mistakeCount: 0,
  };
  const nextSubjectState = structuredClone(current.subjectState);
  nextSubjectState.data.prefs.autoSpeak = true;
  return {
    schemaVersion: 1,
    learnerId: current.learnerId,
    expectedRevision: current.revision,
    nextRevision: current.revision + 1,
    changed: true,
    ok: true,
    nextSubjectState,
    nextPracticeSession: {
      id: 'sess-1', learnerId: current.learnerId, subjectId: 'spelling',
      status: 'abandoned', mode: 'smart', state: {}, summary: null,
      startedAt: NOW, updatedAt: NOW, completedAt: null,
    },
    nextEventLog: [...structuredClone(current.eventLog), event],
    appendedEvents: [event],
    nextMonsterStateByRewardTrackId: {
      [rewardTrack.rewardTrackId]: {
        rewardTrackId: rewardTrack.rewardTrackId,
        packId: catalogue.packId,
        monsterId: rewardTrack.monsterId,
        branch: 'b1', secureCount: 0, caught: false,
        derivedStage: 0, earnedStageHighWater: 0,
      },
    },
    nextCampStateByPackId: {},
    projections: {
      monsters: [{
        rewardTrackId: rewardTrack.rewardTrackId, packId: catalogue.packId,
        monsterId: rewardTrack.monsterId, branch: 'b1', secureCount: 0,
        caught: false, derivedStage: 0, earnedStageHighWater: 0,
      }],
      revisionMission: {
        missionState: 'locked', eligibleMissionKind: null,
        guardianDueCount: 0, wobblingDueCount: 0, nextGuardianDueDay: null,
        todayGuardianDay: 0,
        canStartRewardBearing: false, canContinueUnrewarded: false,
        campCreditState: 'unavailable',
      },
      camp: {
        packId: catalogue.packId, campHighWater: 0,
        lastCreditedGuardianDay: null, lastCreditedEventId: null,
        acknowledgements: [], creditApplied: 0,
        completedGuardianDay: null, canEarnToday: false,
      },
    },
    transientEffects: [{
      type: 'audio-cue',
      payload: { runtimeItemId: catalogue.items[0].runtimeItemId, sentence: null, slow: false },
    }],
    result: { ok: true, changed: true, state: structuredClone(nextSubjectState.ui), events: [event] },
  };
}

function unchangedPlan(current) {
  return {
    schemaVersion: 1, learnerId: current.learnerId,
    expectedRevision: current.revision, nextRevision: current.revision,
    changed: false, ok: true,
    nextSubjectState: structuredClone(current.subjectState),
    nextPracticeSession: structuredClone(current.practiceSession),
    nextEventLog: structuredClone(current.eventLog), appendedEvents: [],
    nextMonsterStateByRewardTrackId: structuredClone(current.monsterStateByRewardTrackId),
    nextCampStateByPackId: structuredClone(current.campStateByPackId),
    projections: {
      monsters: Object.values(structuredClone(current.monsterStateByRewardTrackId)),
      revisionMission: {
        missionState: 'locked', eligibleMissionKind: null,
        guardianDueCount: 0, wobblingDueCount: 0, nextGuardianDueDay: null,
        todayGuardianDay: 0,
        canStartRewardBearing: false, canContinueUnrewarded: false,
        campCreditState: 'unavailable',
      },
      camp: {
        packId: catalogue.packId, campHighWater: 0,
        lastCreditedGuardianDay: null, lastCreditedEventId: null,
        acknowledgements: [], creditApplied: 0,
        completedGuardianDay: null, canEarnToday: false,
      },
    },
    transientEffects: [],
    result: { ok: true, changed: false, state: structuredClone(current.subjectState.ui), events: [] },
  };
}

async function readSnapshot(repository) {
  let value;
  await repository.runCommandTransaction('learner-a', (fresh) => {
    value = structuredClone(fresh);
    return unchangedPlan(fresh);
  });
  return value;
}

test('every staged-target failure rolls the whole durable aggregate back byte-for-byte', async () => {
  for (const checkpoint of [
    'after-subject-state',
    'after-practice-session',
    'after-events',
    'after-monster-state',
    'after-camp-state',
    'after-revision',
    'before-commit',
  ]) {
    const initial = snapshot();
    let injectedDraft;
    const repository = createInMemorySpellingCommandRepository({
      snapshots: [initial],
      cataloguesById: { [catalogue.catalogueId]: catalogue },
      now: () => NOW,
      failureInjector(actualCheckpoint, draft) {
        if (actualCheckpoint === checkpoint) {
          injectedDraft = structuredClone(draft);
          throw new Error(`injected:${checkpoint}`);
        }
      },
    });

    let escapedEffects = null;
    await assert.rejects(
      repository.runCommandTransaction('learner-a', (fresh) => allTargetPlan(fresh))
        .then((value) => { escapedEffects = value.transientEffects; }),
      new RegExp(`injected:${checkpoint}`),
    );
    assert.equal(escapedEffects, null, `${checkpoint} must not release effects`);
    assert.ok(injectedDraft, `${checkpoint} must receive only the staged draft`);
    assert.deepEqual(await readSnapshot(repository), initial, `${checkpoint} must roll back all targets`);
  }
});

test('successful clone-stage-swap lands every durable target once before effects are returned', async () => {
  const checkpoints = [];
  const repository = createInMemorySpellingCommandRepository({
    snapshots: [snapshot()],
    cataloguesById: { [catalogue.catalogueId]: catalogue },
    now: () => NOW,
    failureInjector(checkpoint) { checkpoints.push(checkpoint); },
  });
  const result = await repository.runCommandTransaction('learner-a', allTargetPlan);
  assert.deepEqual(checkpoints, [
    'after-subject-state', 'after-practice-session', 'after-events',
    'after-monster-state', 'after-camp-state', 'after-revision', 'before-commit',
  ]);
  assert.deepEqual(result.transientEffects, [{
    type: 'audio-cue',
    payload: { runtimeItemId: catalogue.items[0].runtimeItemId, sentence: null, slow: false },
  }]);

  const committed = await readSnapshot(repository);
  assert.equal(committed.revision, 1);
  assert.equal(committed.subjectState.data.prefs.autoSpeak, true);
  assert.equal(committed.practiceSession.id, 'sess-1');
  assert.equal(committed.eventLog.length, 1);
  assert.equal(Object.keys(committed.monsterStateByRewardTrackId).length, 1);
  assert.deepEqual(committed.campStateByPackId, {});
});

test('failure injector can inspect and mutate only the draft, which is revalidated before swap', async () => {
  const initial = snapshot();
  const repository = createInMemorySpellingCommandRepository({
    snapshots: [initial],
    cataloguesById: { [catalogue.catalogueId]: catalogue },
    now: () => NOW,
    failureInjector(checkpoint, draft) {
      if (checkpoint === 'before-commit') draft.learnerId = 'learner-b';
    },
  });
  await assert.rejects(
    repository.runCommandTransaction('learner-a', allTargetPlan),
    /learner|ownership/i,
  );
  assert.deepEqual(await readSnapshot(repository), initial);
});
