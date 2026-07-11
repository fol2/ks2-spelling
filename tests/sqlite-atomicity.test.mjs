import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SPELLING_COMMAND_MAX_CONFLICT_ATTEMPTS,
} from '../src/domain/spelling/index.js';

import {
  applyB2Command,
  B2_ATOMIC_COMMAND_INDEX,
  B2_COMMANDS,
  B2_COMMAND_TIMESTAMPS,
  B2_FAILURE_CHECKPOINTS,
  createB2ScenarioClock,
  randomFrom,
  unchangedB2Plan,
} from './fixtures/b2-command-scenarios.mjs';
import {
  createB2DatabaseHarness,
  databaseLogicalDigest,
  persistPlanWithStore,
} from './helpers/b2-database-harness.mjs';

function wrapExactMethods(target, overrides) {
  return Object.freeze(
    Object.fromEntries(
      Object.keys(target).map((key) => [key, overrides[key] ?? target[key]]),
    ),
  );
}

async function commitPrefix(harness, count) {
  const clock = createB2ScenarioClock();
  const random = randomFrom(42);
  const repository = harness.createCommandRepository({
    now: clock.now,
  });
  while (clock.currentIndex() < count) {
    const commandIndex = clock.currentIndex();
    await repository.runCommandTransaction('learner-a', (fresh, context) => {
      assert.equal(context.nowMs, B2_COMMAND_TIMESTAMPS[commandIndex]);
      return applyB2Command(
        fresh,
        B2_COMMANDS[commandIndex],
        harness.catalogue,
        context.nowMs,
        random,
      );
    });
    clock.markSuccessful();
  }
  return Object.freeze({ clock, random });
}

test('no-change, planner throw and invalid plans preserve the complete logical database', async (t) => {
  const harness = await createB2DatabaseHarness();
  t.after(() => harness.close());
  const repository = harness.createCommandRepository();
  const before = await databaseLogicalDigest(harness.connection);

  const unchanged = await repository.runCommandTransaction(
    'learner-a',
    unchangedB2Plan,
  );
  assert.equal(unchanged.changed, false);
  assert.equal(await databaseLogicalDigest(harness.connection), before);

  await assert.rejects(
    repository.runCommandTransaction('learner-a', () => {
      throw new Error('b2_planner_throw');
    }),
    /b2_planner_throw/,
  );
  assert.equal(await databaseLogicalDigest(harness.connection), before);

  await assert.rejects(
    repository.runCommandTransaction('learner-a', () => ({ changed: true })),
    /plan|schema|learner|revision/i,
  );
  assert.equal(await databaseLogicalDigest(harness.connection), before);
});

test('the progress-changing command commits every durable target in one transaction', async (t) => {
  const harness = await createB2DatabaseHarness();
  t.after(() => harness.close());
  const { clock, random } = await commitPrefix(
    harness,
    B2_ATOMIC_COMMAND_INDEX,
  );
  assert.equal(clock.currentIndex(), B2_ATOMIC_COMMAND_INDEX);
  const before = await harness.store.read('learner-a');
  const beforeDigest = await databaseLogicalDigest(harness.connection);
  const checkpoints = [];
  let monsterSyncCalls = 0;
  const store = wrapExactMethods(harness.store, {
    async syncMonsters(learnerId, states) {
      monsterSyncCalls += 1;
      assert.equal(learnerId, 'learner-a');
      assert.deepEqual(states, before.monsterStateByRewardTrackId);
      return harness.store.syncMonsters(learnerId, states);
    },
  });
  const repository = harness.createCommandRepository({
    now: clock.now,
    store,
    async failureInjector(checkpoint) {
      checkpoints.push(checkpoint);
    },
  });

  const plan = await repository.runCommandTransaction(
    'learner-a',
    (fresh, context) => {
      assert.equal(context.nowMs, B2_COMMAND_TIMESTAMPS[B2_ATOMIC_COMMAND_INDEX]);
      return applyB2Command(
        fresh,
        B2_COMMANDS[B2_ATOMIC_COMMAND_INDEX],
        harness.catalogue,
        context.nowMs,
        random,
      );
    },
  );
  const after = await harness.store.read('learner-a');

  assert.deepEqual(checkpoints, B2_FAILURE_CHECKPOINTS);
  assert.equal(monsterSyncCalls, 1);
  assert.equal(clock.currentIndex(), B2_ATOMIC_COMMAND_INDEX);
  clock.markSuccessful();
  assert.equal(clock.currentIndex(), B2_ATOMIC_COMMAND_INDEX + 1);
  assert.equal(plan.nextRevision, 5);
  assert.equal(after.revision, 5);
  assert.notDeepEqual(after.subjectState, before.subjectState);
  assert.notDeepEqual(after.practiceSession, before.practiceSession);
  // Frozen A3 creates this projection at command 0; command 4 still validates
  // and writes the Monster target, but its canonical bytes correctly stay stable.
  assert.deepEqual(
    after.monsterStateByRewardTrackId,
    before.monsterStateByRewardTrackId,
  );
  assert.deepEqual(
    after.monsterStateByRewardTrackId,
    plan.nextMonsterStateByRewardTrackId,
  );
  assert.equal(
    after.monsterStateByRewardTrackId['spelling-core-inklet'].packId,
    'ks2-core',
  );
  assert.deepEqual(after.campStateByPackId, {});
  assert.notEqual(await databaseLogicalDigest(harness.connection), beforeDigest);
});

test('all seven rollback attempts hold command index 4 before one successful advance', async (t) => {
  const harness = await createB2DatabaseHarness();
  t.after(() => harness.close());
  const { clock, random } = await commitPrefix(
    harness,
    B2_ATOMIC_COMMAND_INDEX,
  );
  const before = await databaseLogicalDigest(harness.connection);
  for (const failedCheckpoint of B2_FAILURE_CHECKPOINTS) {
    let clockCalls = 0;
    const repository = harness.createCommandRepository({
      now() {
        clockCalls += 1;
        return clock.now();
      },
      async failureInjector(checkpoint) {
        if (checkpoint === failedCheckpoint) {
          throw new Error(`b2_injected_${checkpoint}`);
        }
      },
    });

    await assert.rejects(
      repository.runCommandTransaction('learner-a', (fresh, context) => {
        assert.equal(
          context.nowMs,
          B2_COMMAND_TIMESTAMPS[B2_ATOMIC_COMMAND_INDEX],
        );
        return applyB2Command(
          fresh,
          B2_COMMANDS[B2_ATOMIC_COMMAND_INDEX],
          harness.catalogue,
          context.nowMs,
          random,
        );
      }),
      new RegExp(`b2_injected_${failedCheckpoint}`),
    );
    assert.equal(clockCalls, 1, failedCheckpoint);
    assert.equal(clock.currentIndex(), B2_ATOMIC_COMMAND_INDEX, failedCheckpoint);
    assert.equal(
      await databaseLogicalDigest(harness.connection),
      before,
      failedCheckpoint,
    );
    assert.equal(await harness.connection.isTransactionActive(), false);
  }

  let committedNowMs;
  const successful = harness.createCommandRepository({ now: clock.now });
  const plan = await successful.runCommandTransaction(
    'learner-a',
    (fresh, context) => {
      committedNowMs = context.nowMs;
      return applyB2Command(
        fresh,
        B2_COMMANDS[B2_ATOMIC_COMMAND_INDEX],
        harness.catalogue,
        context.nowMs,
        random,
      );
    },
  );
  assert.equal(committedNowMs, B2_COMMAND_TIMESTAMPS[B2_ATOMIC_COMMAND_INDEX]);
  assert.equal(plan.nextRevision, B2_ATOMIC_COMMAND_INDEX + 1);
  assert.equal(clock.currentIndex(), B2_ATOMIC_COMMAND_INDEX);
  clock.markSuccessful();
  assert.equal(clock.currentIndex(), B2_ATOMIC_COMMAND_INDEX + 1);
});

test('a stale revision retries from a fresh snapshot and a cleared conflict succeeds', async (t) => {
  const harness = await createB2DatabaseHarness();
  t.after(() => harness.close());
  const { clock, random } = await commitPrefix(
    harness,
    B2_ATOMIC_COMMAND_INDEX,
  );
  let casCalls = 0;
  let rollbackCalls = 0;
  let plannerCalls = 0;
  let clockCalls = 0;
  const seenRevisions = [];
  const store = wrapExactMethods(harness.store, {
    async compareAndSetAggregate(...args) {
      casCalls += 1;
      if (casCalls === 1) return 0;
      return harness.store.compareAndSetAggregate(...args);
    },
  });
  const connection = wrapExactMethods(harness.connection, {
    async rollback() {
      rollbackCalls += 1;
      await harness.connection.rollback();
      if (rollbackCalls === 1) {
        const current = await harness.store.read('learner-a');
        const externalPlan = applyB2Command(
          current,
          B2_COMMANDS[B2_ATOMIC_COMMAND_INDEX],
          harness.catalogue,
          clock.now(),
          random,
        );
        await persistPlanWithStore({
          connection: harness.connection,
          store: harness.store,
          current,
          plan: externalPlan,
          nowMs: clock.now(),
        });
      }
    },
  });
  const repository = harness.createCommandRepository({
    connection,
    store,
    now() {
      clockCalls += 1;
      return clock.now();
    },
  });

  const result = await repository.runCommandTransaction(
    'learner-a',
    (fresh, context) => {
      plannerCalls += 1;
      seenRevisions.push(fresh.revision);
      const command = fresh.revision === B2_ATOMIC_COMMAND_INDEX
        ? B2_COMMANDS[B2_ATOMIC_COMMAND_INDEX]
        : B2_COMMANDS[B2_ATOMIC_COMMAND_INDEX + 1];
      return applyB2Command(
        fresh,
        command,
        harness.catalogue,
        context.nowMs,
        random,
      );
    },
  );

  assert.deepEqual(seenRevisions, [4, 5]);
  assert.equal(result.nextRevision, 6);
  assert.equal(casCalls, 2);
  assert.equal(rollbackCalls, 1);
  assert.equal(plannerCalls, 2);
  assert.equal(clockCalls, 2);
  assert.equal(clock.currentIndex(), B2_ATOMIC_COMMAND_INDEX);
  clock.markSuccessful();
  assert.equal(clock.currentIndex(), B2_ATOMIC_COMMAND_INDEX + 1);
});

test('three conflicts use the same command timestamp and exhaust without mutation', async (t) => {
  const harness = await createB2DatabaseHarness();
  t.after(() => harness.close());
  const { clock, random } = await commitPrefix(
    harness,
    B2_ATOMIC_COMMAND_INDEX,
  );
  const before = await databaseLogicalDigest(harness.connection);
  let plannerCalls = 0;
  let clockCalls = 0;
  const store = wrapExactMethods(harness.store, {
    async compareAndSetAggregate() {
      return 0;
    },
  });
  const repository = harness.createCommandRepository({
    store,
    now() {
      clockCalls += 1;
      return clock.now();
    },
  });

  await assert.rejects(
    repository.runCommandTransaction('learner-a', (fresh, context) => {
      plannerCalls += 1;
      assert.equal(context.nowMs, B2_COMMAND_TIMESTAMPS[B2_ATOMIC_COMMAND_INDEX]);
      return applyB2Command(
        fresh,
        B2_COMMANDS[B2_ATOMIC_COMMAND_INDEX],
        harness.catalogue,
        context.nowMs,
        random,
      );
    }),
    (error) =>
      error?.code === 'spelling_revision_conflict' &&
      error.message === 'spelling_revision_conflict',
  );
  assert.equal(plannerCalls, SPELLING_COMMAND_MAX_CONFLICT_ATTEMPTS);
  assert.equal(clockCalls, SPELLING_COMMAND_MAX_CONFLICT_ATTEMPTS);
  assert.equal(clock.currentIndex(), B2_ATOMIC_COMMAND_INDEX);
  assert.equal(await databaseLogicalDigest(harness.connection), before);
});
