import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SPELLING_COMMAND_MAX_CONFLICT_ATTEMPTS,
  applySpellingCommand,
  canonicalGuardianDay,
  validateSpellingCommandRepository,
} from '../src/domain/spelling/index.js';
import { canonicalJson } from '../src/platform/database/canonical-json.js';

import {
  B2_NOW_MS,
  createB2DatabaseHarness,
  expectedB2Snapshot,
  snapshotAfterPlan,
} from './helpers/b2-database-harness.mjs';

const SMART_START = Object.freeze({
  type: 'start-session',
  payload: Object.freeze({
    mode: 'smart',
    yearFilter: 'core',
    length: 1,
    practiceOnly: false,
    words: Object.freeze(['ks2-core:answer']),
  }),
});

const SMART_ROUND_COMMANDS = Object.freeze([
  SMART_START,
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

const CHECKPOINTS = Object.freeze([
  'after-subject-state',
  'after-practice-session',
  'after-events',
  'after-monster-state',
  'after-camp-state',
  'after-revision',
  'before-commit',
]);

function applyAt(snapshot, command, catalogue, nowMs) {
  return applySpellingCommand({
    snapshot,
    command,
    contentSnapshot: catalogue,
    now: () => nowMs,
    random: () => 0.25,
  });
}

function unchangedPlan(current, context) {
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

function createRepository(harness, options = {}) {
  return harness.createCommandRepository(options);
}

function wrapStore(store, overrides) {
  return Object.freeze(
    Object.fromEntries(
      Object.keys(store).map((key) => [key, overrides[key] ?? store[key]]),
    ),
  );
}

function wrapConnection(connection, overrides) {
  return Object.freeze(
    Object.fromEntries(
      Object.keys(connection).map((key) => [key, overrides[key] ?? connection[key]]),
    ),
  );
}

test('repository exposes only the frozen A3 transaction and certifies one clock', async (t) => {
  const harness = await createB2DatabaseHarness();
  t.after(() => harness.close());
  let clockCalls = 0;
  const nowMs = B2_NOW_MS + 2 * 86_400_000;
  const repository = createRepository(harness, {
    now() {
      clockCalls += 1;
      return nowMs;
    },
  });

  assert.deepEqual(Object.keys(repository), ['runCommandTransaction']);
  assert.equal(Object.isFrozen(repository), true);
  assert.equal(validateSpellingCommandRepository(repository), repository);
  await assert.rejects(repository.runCommandTransaction('', () => {}), /learnerId/i);
  await assert.rejects(
    repository.runCommandTransaction('Learner A', () => {}),
    /learnerId|canonical/i,
  );
  await assert.rejects(
    repository.runCommandTransaction('learner-a', null),
    /planner/i,
  );

  const result = await repository.runCommandTransaction(
    'learner-a',
    (snapshot, context) => {
      assert.deepEqual(context, {
        nowMs,
        todayGuardianDay: canonicalGuardianDay(nowMs),
      });
      assert.equal(Object.isFrozen(context), true);
      const pristine = structuredClone(snapshot);
      snapshot.revision = 999;
      return unchangedPlan(pristine, context);
    },
  );

  assert.equal(result.changed, false);
  assert.equal(result.nextRevision, 0);
  assert.equal(clockCalls, 1);
  assert.deepEqual(await harness.store.read('learner-a'), expectedB2Snapshot('learner-a'));
  assert.equal(await harness.connection.isTransactionActive(), false);
});

test('changed transaction writes every durable target in checkpoint order', async (t) => {
  const harness = await createB2DatabaseHarness();
  t.after(() => harness.close());
  const checkpoints = [];
  const repository = createRepository(harness, {
    async failureInjector(checkpoint, stagedSnapshot) {
      assert.equal(await harness.connection.isTransactionActive(), true);
      checkpoints.push(checkpoint);
      stagedSnapshot.revision = 9_999;
    },
  });
  const beforeB = await harness.store.read('learner-b');
  let expected;

  const committed = await repository.runCommandTransaction(
    'learner-a',
    (fresh, { nowMs }) => {
      const plan = applyAt(fresh, SMART_START, harness.catalogue, nowMs);
      plan.transientEffects.push({
        type: 'audio-cue',
        payload: {
          runtimeItemId: 'ks2-core:answer',
          sentence: null,
          slow: false,
        },
      });
      expected = snapshotAfterPlan(fresh, plan);
      return plan;
    },
  );

  assert.deepEqual(checkpoints, CHECKPOINTS);
  assert.equal(committed.nextRevision, 1);
  assert.equal(committed.transientEffects.length, 1);
  committed.transientEffects[0].payload.slow = true;
  assert.equal(canonicalJson(await harness.store.read('learner-a')), canonicalJson(expected));
  assert.deepEqual(await harness.store.read('learner-b'), beforeB);
  assert.equal(await harness.connection.isTransactionActive(), false);

  const [aggregate] = await harness.connection.query(
    'SELECT snapshot_schema_version, pack_id, catalogue_id, granted_entitlement_ids_json FROM spelling_aggregates WHERE learner_id = ?',
    ['learner-a'],
  );
  assert.deepEqual(aggregate, {
    snapshot_schema_version: 1,
    pack_id: 'ks2-core',
    catalogue_id: 'ks2-core:starter',
    granted_entitlement_ids_json: '[]',
  });
});

test('event replay is idempotent and different bytes collide before mutation', async (t) => {
  const harness = await createB2DatabaseHarness();
  t.after(() => harness.close());
  let nowMs = B2_NOW_MS;
  const repository = createRepository(harness, { now: () => nowMs });

  for (const command of SMART_ROUND_COMMANDS.slice(0, 3)) {
    await repository.runCommandTransaction('learner-a', (fresh) =>
      applyAt(fresh, command, harness.catalogue, nowMs),
    );
    nowMs += 1;
  }
  const before = await harness.store.read('learner-a');
  assert.equal(before.eventLog.length, 1);
  const event = before.eventLog[0];

  const replay = await repository.runCommandTransaction(
    'learner-a',
    (fresh, context) => {
      const plan = unchangedPlan(fresh, context);
      plan.appendedEvents = [structuredClone(event)];
      return plan;
    },
  );
  assert.deepEqual(replay.appendedEvents, []);
  assert.deepEqual(await harness.store.read('learner-a'), before);

  await assert.rejects(
    repository.runCommandTransaction('learner-a', (fresh, context) => {
      const plan = unchangedPlan(fresh, context);
      plan.appendedEvents = [{ ...event, createdAt: context.nowMs }];
      return plan;
    }),
    (error) => error?.message.includes('spelling_event_id_collision'),
  );
  assert.deepEqual(await harness.store.read('learner-a'), before);
  assert.equal(await harness.connection.isTransactionActive(), false);
});

test('zero-row CAS retries a fresh read exactly three times', async (t) => {
  const harness = await createB2DatabaseHarness();
  t.after(() => harness.close());
  let casCalls = 0;
  let plannerCalls = 0;
  let clockCalls = 0;
  const store = wrapStore(harness.store, {
    async compareAndSetAggregate(...args) {
      casCalls += 1;
      if (casCalls < 3) return 0;
      return harness.store.compareAndSetAggregate(...args);
    },
  });
  const repository = createRepository(harness, {
    store,
    now() {
      clockCalls += 1;
      return B2_NOW_MS;
    },
  });

  const result = await repository.runCommandTransaction('learner-a', (fresh) => {
    plannerCalls += 1;
    assert.equal(fresh.revision, 0);
    return applyAt(fresh, SMART_START, harness.catalogue, B2_NOW_MS);
  });

  assert.equal(result.nextRevision, 1);
  assert.equal(casCalls, 3);
  assert.equal(plannerCalls, 3);
  assert.equal(clockCalls, 3);
  assert.equal((await harness.store.read('learner-a')).revision, 1);
  assert.equal(await harness.connection.isTransactionActive(), false);

  casCalls = 0;
  plannerCalls = 0;
  clockCalls = 0;
  const exhausted = createRepository(harness, {
    store: wrapStore(harness.store, {
      async compareAndSetAggregate() {
        casCalls += 1;
        return 0;
      },
    }),
    now() {
      clockCalls += 1;
      return B2_NOW_MS + 1;
    },
  });
  await assert.rejects(
    exhausted.runCommandTransaction('learner-b', (fresh) => {
      plannerCalls += 1;
      assert.equal(fresh.revision, 0);
      return applyAt(fresh, SMART_START, harness.catalogue, B2_NOW_MS + 1);
    }),
    (error) =>
      error?.code === 'spelling_revision_conflict' &&
      error.message === 'spelling_revision_conflict',
  );
  assert.equal(casCalls, SPELLING_COMMAND_MAX_CONFLICT_ATTEMPTS);
  assert.equal(plannerCalls, SPELLING_COMMAND_MAX_CONFLICT_ATTEMPTS);
  assert.equal(clockCalls, SPELLING_COMMAND_MAX_CONFLICT_ATTEMPTS);
  assert.deepEqual(await harness.store.read('learner-b'), expectedB2Snapshot('learner-b'));
  assert.equal(await harness.connection.isTransactionActive(), false);
});

test('non-CAS failures roll back once without retry or transient effects', async () => {
  for (const failedCheckpoint of CHECKPOINTS) {
    const harness = await createB2DatabaseHarness();
    try {
      const before = await harness.store.read('learner-a');
      let plannerCalls = 0;
      const repository = createRepository(harness, {
        async failureInjector(checkpoint) {
          if (checkpoint === failedCheckpoint) {
            const error = new Error(`injected_${checkpoint}`);
            error.code = 'spelling_revision_conflict';
            throw error;
          }
        },
      });

      await assert.rejects(
        repository.runCommandTransaction('learner-a', (fresh, { nowMs }) => {
          plannerCalls += 1;
          const plan = applyAt(fresh, SMART_START, harness.catalogue, nowMs);
          plan.transientEffects.push({
            type: 'audio-cue',
            payload: {
              runtimeItemId: 'ks2-core:answer',
              sentence: 'Proof only after commit.',
              slow: false,
            },
          });
          return plan;
        }),
        (error) =>
          error?.code === 'spelling_revision_conflict' &&
          error.message === `injected_${failedCheckpoint}`,
        failedCheckpoint,
      );
      assert.equal(plannerCalls, 1, failedCheckpoint);
      assert.deepEqual(await harness.store.read('learner-a'), before, failedCheckpoint);
      assert.equal(await harness.connection.isTransactionActive(), false);
    } finally {
      await harness.close();
    }
  }
});

test('rollback failure remains the cause without replacing the original code', async (t) => {
  const harness = await createB2DatabaseHarness();
  t.after(() => harness.close());
  const rollbackFailure = new Error('injected_rollback_failure');
  rollbackFailure.code = 'sqlite_rollback_failed';
  const connection = wrapConnection(harness.connection, {
    async rollback() {
      await harness.connection.rollback();
      throw rollbackFailure;
    },
  });
  const repository = createRepository(harness, {
    connection,
    async failureInjector(checkpoint) {
      if (checkpoint === 'after-subject-state') {
        const error = new Error('original_write_failure');
        error.code = 'original_write_failure';
        throw error;
      }
    },
  });

  await assert.rejects(
    repository.runCommandTransaction('learner-a', (fresh, { nowMs }) =>
      applyAt(fresh, SMART_START, harness.catalogue, nowMs),
    ),
    (error) => {
      assert.equal(error?.code, 'original_write_failure');
      assert.equal(error?.message, 'original_write_failure');
      assert.equal(error?.cause, rollbackFailure);
      return true;
    },
  );
  assert.equal(await harness.connection.isTransactionActive(), false);
  assert.deepEqual(await harness.store.read('learner-a'), expectedB2Snapshot('learner-a'));
});

test('staged canonical mismatch and invalid plans fail closed', async (t) => {
  const harness = await createB2DatabaseHarness();
  t.after(() => harness.close());
  const before = await harness.store.read('learner-a');
  const corruptingStore = wrapStore(harness.store, {
    async syncCamp(learnerId, states) {
      await harness.store.syncCamp(learnerId, states);
      const [row] = await harness.connection.query(
        'SELECT state_json FROM spelling_subject_states WHERE learner_id = ?',
        [learnerId],
      );
      const changed = JSON.parse(row.state_json);
      changed.data.prefs.autoSpeak = !changed.data.prefs.autoSpeak;
      await harness.store.writeSubjectState(learnerId, changed);
    },
  });
  const repository = createRepository(harness, { store: corruptingStore });

  await assert.rejects(
    repository.runCommandTransaction('learner-a', (fresh, { nowMs }) =>
      applyAt(fresh, SMART_START, harness.catalogue, nowMs),
    ),
    /staged|canonical|validated plan|match/i,
  );
  assert.deepEqual(await harness.store.read('learner-a'), before);
  assert.equal(await harness.connection.isTransactionActive(), false);

  const normal = createRepository(harness);
  await assert.rejects(
    normal.runCommandTransaction('learner-a', (fresh, context) => {
      const plan = unchangedPlan(fresh, context);
      plan.learnerId = 'learner-b';
      return plan;
    }),
    /learner|ownership/i,
  );
  assert.deepEqual(await harness.store.read('learner-a'), before);
});
