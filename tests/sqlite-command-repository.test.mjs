import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SPELLING_COMMAND_MAX_CONFLICT_ATTEMPTS,
  applySpellingCommand,
  canonicalGuardianDay,
  validateSpellingCommandRepository,
} from '../src/domain/spelling/index.js';
import { createDatabaseCommandGate } from '../src/platform/database/database-command-gate.js';
import { canonicalJson } from '../src/platform/database/canonical-json.js';
import { createSQLiteSpellingCommandRepository } from '../src/platform/database/sqlite-spelling-command-repository.js';

import {
  B2_NOW_MS,
  createB2DatabaseHarness,
  expectedB2Snapshot,
  persistPlanWithStore,
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

function repositoryOptions(harness, overrides = {}) {
  return {
    connection: harness.connection,
    gate: createDatabaseCommandGate(),
    store: harness.store,
    cataloguesById: harness.cataloguesById,
    now: () => B2_NOW_MS,
    ...overrides,
  };
}

function assertRollbackIncomplete(error, originalCode, expectedIssues = []) {
  assert.equal(error?.code, originalCode);
  assert.equal(error?.cause?.code, 'sqlite_transaction_rollback_incomplete');
  assert.equal(error.cause.cause instanceof AggregateError, true);
  for (const issue of expectedIssues) {
    assert.equal(error.cause.cause.errors.includes(issue), true);
  }
  return true;
}

test('factory validates the exact plain options surface without invoking accessors', async (t) => {
  const harness = await createB2DatabaseHarness();
  t.after(() => harness.close());
  const valid = repositoryOptions(harness);
  assert.deepEqual(Object.keys(valid).sort(), [
    'cataloguesById',
    'connection',
    'gate',
    'now',
    'store',
  ]);
  assert.deepEqual(Object.keys(createSQLiteSpellingCommandRepository(valid)), [
    'runCommandTransaction',
  ]);

  let getterCalls = 0;
  const hostile = { ...valid };
  Object.defineProperty(hostile, 'connection', {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error('options_getter_invoked');
    },
  });
  assert.throws(
    () => createSQLiteSpellingCommandRepository(hostile),
    /options|data propert|accessor/i,
  );
  assert.equal(getterCalls, 0);

  const hidden = { ...valid };
  Object.defineProperty(hidden, 'extra', { value: true });
  const symbol = { ...valid, [Symbol('extra')]: true };
  const extra = { ...valid, extra: true };
  const customPrototype = Object.assign(Object.create({ inherited: true }), valid);
  const missing = { ...valid };
  delete missing.now;
  for (const invalid of [hidden, symbol, extra, customPrototype, missing, null, []]) {
    assert.throws(
      () => createSQLiteSpellingCommandRepository(invalid),
      /options|unknown|required|plain|prototyp|object/i,
    );
  }
});

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

test('zero-row CAS retries from a real post-rollback state change', async (t) => {
  const harness = await createB2DatabaseHarness();
  t.after(() => harness.close());
  let casCalls = 0;
  let plannerCalls = 0;
  let clockCalls = 0;
  let rollbackCalls = 0;
  const store = wrapStore(harness.store, {
    async compareAndSetAggregate(...args) {
      casCalls += 1;
      if (casCalls === 1) return 0;
      return harness.store.compareAndSetAggregate(...args);
    },
  });
  const connection = wrapConnection(harness.connection, {
    async rollback() {
      rollbackCalls += 1;
      await harness.connection.rollback();
      if (rollbackCalls === 1) {
        const current = await harness.store.read('learner-a');
        const externalPlan = applyAt(
          current,
          SMART_START,
          harness.catalogue,
          B2_NOW_MS,
        );
        await persistPlanWithStore({
          ...harness,
          current,
          plan: externalPlan,
          nowMs: B2_NOW_MS,
        });
      }
    },
  });
  const repository = createRepository(harness, {
    connection,
    store,
    now() {
      clockCalls += 1;
      return B2_NOW_MS + clockCalls - 1;
    },
  });

  const seen = [];
  const result = await repository.runCommandTransaction('learner-a', (fresh, context) => {
    plannerCalls += 1;
    seen.push({
      revision: fresh.revision,
      phase: fresh.practiceSession?.state?.session?.phase ?? null,
      autoSpeak: fresh.subjectState.data.prefs.autoSpeak,
    });
    const command = fresh.revision === 0
      ? SMART_START
      : SMART_ROUND_COMMANDS[1];
    return applyAt(fresh, command, harness.catalogue, context.nowMs);
  });

  assert.equal(result.nextRevision, 2);
  assert.equal(casCalls, 2);
  assert.equal(plannerCalls, 2);
  assert.equal(clockCalls, 2);
  assert.equal(rollbackCalls, 1);
  assert.deepEqual(seen, [
    { revision: 0, phase: null, autoSpeak: false },
    { revision: 1, phase: 'question', autoSpeak: false },
  ]);
  const committed = await harness.store.read('learner-a');
  assert.equal(committed.revision, 2);
  assert.equal(committed.practiceSession.state.session.phase, 'retry');
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

test('rollback that does not clear the transaction is reported as incomplete', async (t) => {
  const harness = await createB2DatabaseHarness();
  t.after(async () => {
    if (await harness.connection.isTransactionActive()) {
      await harness.connection.rollback();
    }
    await harness.close();
  });
  const originalCause = new Error('original_nested_cause');
  const rollbackFailure = new Error('rollback_did_not_clear');
  const connection = wrapConnection(harness.connection, {
    async rollback() {
      throw rollbackFailure;
    },
  });
  const repository = createRepository(harness, {
    connection,
    async failureInjector(checkpoint) {
      if (checkpoint === 'after-subject-state') {
        const error = new Error('poisoned_transaction', { cause: originalCause });
        error.code = 'poisoned_transaction';
        throw error;
      }
    },
  });

  await assert.rejects(
    repository.runCommandTransaction('learner-a', (fresh, { nowMs }) =>
      applyAt(fresh, SMART_START, harness.catalogue, nowMs),
    ),
    (error) => {
      assert.equal(error?.code, 'poisoned_transaction');
      assert.equal(error?.message, 'poisoned_transaction');
      assert.equal(error?.cause instanceof AggregateError, true);
      assert.equal(error.cause.errors.includes(originalCause), true);
      const incomplete = error.cause.errors.find(
        (candidate) => candidate?.code === 'sqlite_transaction_rollback_incomplete',
      );
      assert.ok(incomplete);
      assert.equal(incomplete.cause instanceof AggregateError, true);
      assert.equal(incomplete.cause.errors.includes(rollbackFailure), true);
      return true;
    },
  );
  assert.equal(await harness.connection.isTransactionActive(), true);
});

test('failed transaction-state probes cannot silently claim rollback safety', async () => {
  const cases = [
    {
      label: 'initial probe fails but rollback clears the transaction',
      initialIssue: new Error('initial_state_unobservable'),
      throwInitial: true,
      finalIssue: null,
      expectIncomplete: false,
    },
    {
      label: 'initial probe throws a primitive but rollback clears the transaction',
      initialIssue: undefined,
      throwInitial: true,
      finalIssue: null,
      expectIncomplete: false,
    },
    {
      label: 'final probe throws after rollback',
      initialIssue: null,
      finalIssue: new Error('final_state_unobservable'),
      expectIncomplete: true,
    },
    {
      label: 'final probe returns a non-boolean state',
      initialIssue: null,
      finalIssue: 'unknown',
      expectIncomplete: true,
    },
  ];

  for (const testCase of cases) {
    const harness = await createB2DatabaseHarness();
    try {
      let stateCalls = 0;
      const connection = wrapConnection(harness.connection, {
        async isTransactionActive() {
          stateCalls += 1;
          if (stateCalls === 1 && testCase.throwInitial) {
            throw testCase.initialIssue;
          }
          if (stateCalls === 2 && testCase.finalIssue instanceof Error) {
            throw testCase.finalIssue;
          }
          if (stateCalls === 2 && testCase.finalIssue !== null) {
            return testCase.finalIssue;
          }
          return harness.connection.isTransactionActive();
        },
      });
      const repository = createRepository(harness, {
        connection,
        async failureInjector(checkpoint) {
          if (checkpoint === 'after-subject-state') {
            const error = new Error('state_probe_case');
            error.code = 'state_probe_case';
            throw error;
          }
        },
      });

      await assert.rejects(
        repository.runCommandTransaction('learner-a', (fresh, { nowMs }) =>
          applyAt(fresh, SMART_START, harness.catalogue, nowMs),
        ),
        (error) => {
          assert.equal(error?.code, 'state_probe_case', testCase.label);
          if (testCase.expectIncomplete) {
            assertRollbackIncomplete(
              error,
              'state_probe_case',
              testCase.finalIssue instanceof Error ? [testCase.finalIssue] : [],
            );
          } else {
            if (testCase.initialIssue instanceof Error) {
              assert.equal(error?.cause, testCase.initialIssue, testCase.label);
            } else {
              assert.equal(
                error?.cause?.code,
                'sqlite_transaction_state_check_failed',
                testCase.label,
              );
            }
          }
          return true;
        },
      );
      assert.equal(
        await harness.connection.isTransactionActive(),
        false,
        testCase.label,
      );
    } finally {
      await harness.close();
    }
  }
});

test('commit failures distinguish recovered, poisoned and already-committed states', async () => {
  const cases = [
    { label: 'active commit failure is rolled back', commitFirst: false, poison: false },
    { label: 'active commit failure remains poisoned', commitFirst: false, poison: true },
    { label: 'commit failure after commit reports an inactive connection', commitFirst: true, poison: false },
  ];

  for (const testCase of cases) {
    const harness = await createB2DatabaseHarness();
    try {
      const commitFailure = new Error(`commit_failure_${testCase.label}`);
      commitFailure.code = 'sqlite_commit_failed';
      const rollbackFailure = new Error('commit_recovery_failed');
      const connection = wrapConnection(harness.connection, {
        async commit() {
          if (testCase.commitFirst) await harness.connection.commit();
          throw commitFailure;
        },
        async rollback() {
          if (testCase.poison) throw rollbackFailure;
          await harness.connection.rollback();
        },
      });
      const repository = createRepository(harness, { connection });

      await assert.rejects(
        repository.runCommandTransaction('learner-a', (fresh, { nowMs }) =>
          applyAt(fresh, SMART_START, harness.catalogue, nowMs),
        ),
        (error) => {
          assert.equal(error?.code, 'sqlite_commit_failed', testCase.label);
          assert.equal(error?.message, commitFailure.message, testCase.label);
          if (testCase.poison) {
            assertRollbackIncomplete(error, 'sqlite_commit_failed', [rollbackFailure]);
          } else {
            assert.equal(error?.cause, undefined, testCase.label);
          }
          return true;
        },
      );
      assert.equal(
        await harness.connection.isTransactionActive(),
        testCase.poison,
        testCase.label,
      );
      if (testCase.poison) await harness.connection.rollback();
      const after = await harness.store.read('learner-a');
      assert.equal(after.revision, testCase.commitFirst ? 1 : 0, testCase.label);
    } finally {
      await harness.close();
    }
  }
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
