import {
  applySpellingCommand,
  canonicalGuardianDay,
} from '../../src/domain/spelling/index.js';

export const B2_COMMAND_TIMESTAMPS = Object.freeze([
  1_768_478_400_000,
  1_768_478_400_001,
  1_768_478_400_002,
  1_768_478_400_003,
  1_768_478_400_004,
  1_768_478_400_005,
]);

export const B2_ATOMIC_COMMAND_INDEX = 4;

export const B2_FAILURE_CHECKPOINTS = Object.freeze([
  'after-subject-state',
  'after-practice-session',
  'after-events',
  'after-monster-state',
  'after-camp-state',
  'after-revision',
  'before-commit',
]);

export const B2_COMMANDS = Object.freeze([
  Object.freeze({
    type: 'start-session',
    payload: Object.freeze({
      mode: 'smart',
      yearFilter: 'core',
      length: 1,
      practiceOnly: false,
      words: Object.freeze(['ks2-core:answer']),
    }),
  }),
  Object.freeze({
    type: 'submit-answer',
    payload: Object.freeze({ typed: 'wrong' }),
  }),
  Object.freeze({
    type: 'submit-answer',
    payload: Object.freeze({ typed: 'answer' }),
  }),
  Object.freeze({ type: 'continue-session', payload: Object.freeze({}) }),
  Object.freeze({
    type: 'submit-answer',
    payload: Object.freeze({ typed: 'answer' }),
  }),
  Object.freeze({ type: 'continue-session', payload: Object.freeze({}) }),
]);

export function randomFrom(seed = 42) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let result = Math.imul(value ^ (value >>> 15), 1 | value);
    result ^= result + Math.imul(result ^ (result >>> 7), 61 | result);
    return ((result ^ (result >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function createB2ScenarioClock() {
  let successfulCommandIndex = 0;
  return Object.freeze({
    now() {
      return B2_COMMAND_TIMESTAMPS[
        Math.min(successfulCommandIndex, B2_COMMAND_TIMESTAMPS.length - 1)
      ];
    },
    markSuccessful() {
      if (successfulCommandIndex >= B2_COMMANDS.length) {
        throw new Error('b2_scenario_clock_exhausted');
      }
      successfulCommandIndex += 1;
    },
    currentIndex() {
      return successfulCommandIndex;
    },
  });
}

export function applyB2Command(snapshot, command, catalogue, nowMs, random) {
  return applySpellingCommand({
    snapshot,
    command,
    contentSnapshot: catalogue,
    now: () => nowMs,
    random,
  });
}

export async function runB2Scenario({
  repository,
  catalogue,
  learnerId = 'learner-a',
  clock,
}) {
  const random = randomFrom(42);
  const plans = [];
  for (const command of B2_COMMANDS) {
    const expectedNowMs = B2_COMMAND_TIMESTAMPS[plans.length];
    const plan = await repository.runCommandTransaction(
      learnerId,
      (fresh, context) => {
        if (
          context.nowMs !== expectedNowMs ||
          context.todayGuardianDay !== canonicalGuardianDay(expectedNowMs)
        ) {
          throw new Error('b2_scenario_context_mismatch');
        }
        return applyB2Command(
          fresh,
          command,
          catalogue,
          context.nowMs,
          random,
        );
      },
    );
    plans.push(plan);
    clock.markSuccessful();
  }
  return Object.freeze(plans);
}

export function unchangedB2Plan(current, context) {
  const activeCamp = current.campStateByPackId[current.packId] ?? {
    packId: current.packId,
    campHighWater: 0,
    lastCreditedGuardianDay: null,
    lastCreditedEventId: null,
    acknowledgements: [],
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
    nextMonsterStateByRewardTrackId: structuredClone(
      current.monsterStateByRewardTrackId,
    ),
    nextCampStateByPackId: structuredClone(current.campStateByPackId),
    projections: {
      monsters: Object.values(structuredClone(current.monsterStateByRewardTrackId)),
      revisionMission: {
        missionState: 'locked',
        eligibleMissionKind: null,
        guardianDueCount: 0,
        wobblingDueCount: 0,
        nextGuardianDueDay: null,
        todayGuardianDay: context.todayGuardianDay,
        canStartRewardBearing: false,
        canContinueUnrewarded: false,
        campCreditState: 'unavailable',
      },
      camp: {
        ...structuredClone(activeCamp),
        creditApplied: 0,
        completedGuardianDay: null,
        canEarnToday: false,
      },
    },
    transientEffects: [],
    result: {
      ok: true,
      changed: false,
      state: structuredClone(current.subjectState.ui),
      events: [],
    },
  };
}

export async function observeRepositorySnapshot(repository, learnerId) {
  let observed;
  await repository.runCommandTransaction(learnerId, (fresh, context) => {
    observed = structuredClone(fresh);
    return unchangedB2Plan(fresh, context);
  });
  return observed;
}
