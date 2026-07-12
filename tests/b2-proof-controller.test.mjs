import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  applySpellingCommand,
  canonicalGuardianDay,
  loadStarterSpellingCatalogue,
  validateSpellingCommandSnapshotV1,
} from '../src/domain/spelling/index.js';
import {
  B2_ATOMIC_FAILURE_CHECKPOINTS,
  B2_PROOF_METADATA_KEY,
  createB2AtomicFailureError,
  createB2ProofController,
} from '../src/app/b2-proof-controller.js';
import { createB2AppServices } from '../src/app/create-b2-app-services.js';
import { seedB2Learners } from '../src/platform/database/b2-seed.js';
import { canonicalJson } from '../src/platform/database/canonical-json.js';
import { configureAndMigrateDatabase } from '../src/platform/database/migrate-database.js';

import { createNodeSqliteConnection } from './helpers/node-sqlite-connection.mjs';

const START = 1_768_478_400_000;
const COMMANDS = Object.freeze([
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
  Object.freeze({ type: 'submit-answer', payload: Object.freeze({ typed: 'wrong' }) }),
  Object.freeze({ type: 'submit-answer', payload: Object.freeze({ typed: 'answer' }) }),
  Object.freeze({ type: 'continue-session', payload: Object.freeze({}) }),
  Object.freeze({ type: 'submit-answer', payload: Object.freeze({ typed: 'answer' }) }),
  Object.freeze({ type: 'continue-session', payload: Object.freeze({}) }),
]);

function randomFrom(seed = 42) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let result = Math.imul(value ^ (value >>> 15), 1 | value);
    result ^= result + Math.imul(result ^ (result >>> 7), 61 | result);
    return ((result ^ (result >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function initialSnapshot(learnerId) {
  const catalogue = loadStarterSpellingCatalogue();
  return validateSpellingCommandSnapshotV1(
    {
      schemaVersion: 1,
      learnerId,
      revision: 0,
      packId: 'ks2-core',
      catalogueId: 'ks2-core:starter',
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
    },
    catalogue,
  );
}

function snapshotAfterPlan(current, plan) {
  return {
    ...structuredClone(current),
    revision: plan.nextRevision,
    subjectState: structuredClone(plan.nextSubjectState),
    practiceSession: structuredClone(plan.nextPracticeSession),
    eventLog: structuredClone(plan.nextEventLog),
    monsterStateByRewardTrackId: structuredClone(
      plan.nextMonsterStateByRewardTrackId,
    ),
    campStateByPackId: structuredClone(plan.nextCampStateByPackId),
  };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function waitForStatus(controller, status) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.getState().status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(controller.getState().status, status);
}

function createTrackedConnectionFactory(databasePath, events, metadataWrites) {
  return async () => {
    events.push('connection:create');
    const inner = createNodeSqliteConnection(databasePath);
    return Object.freeze({
      async open() {
        events.push('connection:open');
        await inner.open();
      },
      async close() {
        events.push('connection:close');
        await inner.close();
      },
      async execute(sql, values) {
        if (
          sql.startsWith('INSERT INTO app_metadata') &&
          values?.[0] === B2_PROOF_METADATA_KEY
        ) {
          metadataWrites.push(await inner.isTransactionActive());
        }
        return inner.execute(sql, values);
      },
      async query(sql, values) {
        return inner.query(sql, values);
      },
      async begin() {
        return inner.begin();
      },
      async commit() {
        return inner.commit();
      },
      async rollback() {
        return inner.rollback();
      },
      async isTransactionActive() {
        return inner.isTransactionActive();
      },
    });
  };
}

function createFakeLifecycle(events, { disposeError } = {}) {
  const listeners = {
    pause: new Set(),
    resume: new Set(),
    state: new Set(),
  };
  let disposeCount = 0;

  function subscribe(kind, listener) {
    events.push(`lifecycle:on-${kind}`);
    listeners[kind].add(listener);
    let removed = false;
    return Object.freeze({
      async remove() {
        if (removed) return;
        removed = true;
        listeners[kind].delete(listener);
      },
    });
  }

  const port = Object.freeze({
    onPause(listener) {
      return subscribe('pause', listener);
    },
    onResume(listener) {
      return subscribe('resume', listener);
    },
    onStateChange(listener) {
      return subscribe('state', listener);
    },
    getState() {
      return Object.freeze({ canonicalState: 'test', diagnosticStateChanges: [] });
    },
    async dispose() {
      disposeCount += 1;
      events.push('lifecycle:dispose');
      for (const values of Object.values(listeners)) values.clear();
      if (disposeError) throw disposeError;
    },
  });

  return {
    port,
    emitPause() {
      for (const listener of listeners.pause) listener();
    },
    emitResume() {
      for (const listener of listeners.resume) listener();
    },
    get disposeCount() {
      return disposeCount;
    },
  };
}

function createHarness({
  metadata = null,
  snapshotA = initialSnapshot('learner-a'),
  snapshotB = initialSnapshot('learner-b'),
  failureErrorFactory = createB2AtomicFailureError,
} = {}) {
  const catalogue = loadStarterSpellingCatalogue();
  let learnerA = structuredClone(snapshotA);
  const learnerB = structuredClone(snapshotB);
  let storedMetadata = metadata === null ? null : structuredClone(metadata);
  const writes = [];
  const successfulRevisions = [];
  const failedCheckpoints = [];
  const lifecycle = createDeferred();
  let activeFailure = null;

  const repository = Object.freeze({
    async runCommandTransaction(learnerId, planner) {
      assert.equal(learnerId, 'learner-a');
      const nowMs = START + learnerA.revision;
      const plan = await planner(structuredClone(learnerA), {
        nowMs,
        todayGuardianDay: canonicalGuardianDay(nowMs),
      });
      if (activeFailure !== null) {
        failedCheckpoints.push(activeFailure);
        throw failureErrorFactory(activeFailure);
      }
      learnerA = snapshotAfterPlan(learnerA, plan);
      successfulRevisions.push(learnerA.revision);
      return structuredClone(plan);
    },
  });

  return {
    catalogue,
    lifecycle,
    writes,
    failedCheckpoints,
    successfulRevisions,
    get learnerA() {
      return structuredClone(learnerA);
    },
    get learnerB() {
      return structuredClone(learnerB);
    },
    get metadata() {
      return storedMetadata === null ? null : structuredClone(storedMetadata);
    },
    ports: {
      catalogue,
      migrationRollbackVerified: true,
      repository,
      createFailureRepository(checkpoint) {
        assert.ok(B2_ATOMIC_FAILURE_CHECKPOINTS.includes(checkpoint));
        return Object.freeze({
          async runCommandTransaction(learnerId, planner) {
            activeFailure = checkpoint;
            try {
              return await repository.runCommandTransaction(learnerId, planner);
            } finally {
              activeFailure = null;
            }
          },
        });
      },
      snapshotStore: Object.freeze({
        async read(learnerId) {
          if (learnerId === 'learner-a') return structuredClone(learnerA);
          if (learnerId === 'learner-b') return structuredClone(learnerB);
          throw new Error('unknown learner');
        },
      }),
      proofStore: Object.freeze({
        async read(key) {
          assert.equal(key, B2_PROOF_METADATA_KEY);
          return storedMetadata === null ? null : structuredClone(storedMetadata);
        },
        async write(key, value) {
          assert.equal(key, B2_PROOF_METADATA_KEY);
          storedMetadata = structuredClone(value);
          writes.push(structuredClone(value));
        },
      }),
      lifecycleProof: Object.freeze({
        async waitForPauseResume() {
          await lifecycle.promise;
          return Object.freeze(['pause', 'resume']);
        },
      }),
      updatedAt: START,
    },
  };
}

function snapshotDigest(snapshot) {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}

async function advanceToRevision(snapshot, revision) {
  const catalogue = loadStarterSpellingCatalogue();
  const random = randomFrom(42);
  let current = structuredClone(snapshot);
  for (let index = 0; index < revision; index += 1) {
    const nowMs = START + index;
    const plan = applySpellingCommand({
      snapshot: current,
      command: COMMANDS[index],
      contentSnapshot: catalogue,
      now: () => nowMs,
      random,
    });
    current = snapshotAfterPlan(current, plan);
  }
  return current;
}

test('first launch reaches revision 4, proves lifecycle and stops for relaunch', async () => {
  const harness = createHarness();
  const controller = createB2ProofController(harness.ports);
  const states = [];
  controller.subscribe((state) => states.push(state.status));

  const firstStart = controller.start();
  assert.equal(controller.start(), firstStart, 'duplicate start must join one run');
  await waitForStatus(controller, 'Background test ready');
  assert.equal(controller.getState().status, 'Background test ready');
  assert.deepEqual(harness.successfulRevisions, [1, 2, 3, 4]);
  assert.equal(harness.metadata.phase, 'background-test-ready');
  assert.equal(harness.metadata.commandIndex, 4);

  harness.lifecycle.resolve();
  await firstStart;
  assert.equal(controller.getState().status, 'Ready for relaunch');
  assert.equal(controller.getState().learnerIsolation, 'pending');
  assert.equal(harness.metadata.phase, 'ready-for-relaunch');
  assert.deepEqual(harness.metadata.lifecycleEvents, ['pause', 'resume']);
  assert.ok(harness.metadata.expectedSessionId);
  assert.equal(harness.metadata.learnerARevision, 4);
  assert.ok(harness.metadata.learnerBDigest);
  assert.ok(harness.metadata.preRelaunchDigest);
  assert.deepEqual(states, [
    'Preparing local proof',
    'Background test ready',
    'Ready for relaunch',
  ]);
});

test('relaunch proves every rollback, commits revisions 5 and 6, and never changes learner B', async () => {
  const first = createHarness();
  const firstController = createB2ProofController(first.ports);
  const firstStart = firstController.start();
  await waitForStatus(firstController, 'Background test ready');
  first.lifecycle.resolve();
  await firstStart;

  const second = createHarness({
    metadata: first.metadata,
    snapshotA: first.learnerA,
  });
  const learnerBBefore = canonicalJson(second.learnerB);
  const controller = createB2ProofController(second.ports);
  const states = [];
  controller.subscribe((state) => states.push(state.status));
  await controller.start();

  assert.deepEqual(second.failedCheckpoints, B2_ATOMIC_FAILURE_CHECKPOINTS);
  assert.deepEqual(second.successfulRevisions, [5, 6]);
  assert.equal(second.metadata.phase, 'complete');
  assert.equal(second.metadata.commandIndex, 6);
  assert.equal(second.metadata.learnerARevision, 6);
  assert.equal(controller.getState().learnerIsolation, 'verified');
  assert.deepEqual(
    second.metadata.atomicFailureCheckpoints,
    B2_ATOMIC_FAILURE_CHECKPOINTS,
  );
  assert.equal(canonicalJson(second.learnerB), learnerBBefore);
  assert.deepEqual(states, ['Preparing local proof', 'Resumed safely', 'B2 proof complete']);
  assert.equal(controller.start(), controller.start(), 'completed starts remain joined');
});

test('reconciliation advances metadata after a committed command without replaying it', async () => {
  const source = createHarness();
  const sourceController = createB2ProofController(source.ports);
  const sourceRun = sourceController.start();
  await waitForStatus(sourceController, 'Background test ready');
  source.lifecycle.resolve();
  await sourceRun;
  const snapshotA = await advanceToRevision(initialSnapshot('learner-a'), 4);
  const metadata = {
    ...source.metadata,
    phase: 'fresh',
    commandIndex: 3,
    learnerARevision: 3,
    lifecycleEvents: [],
    preRelaunchDigest: '',
  };
  const prior = createHarness({ metadata, snapshotA });
  const controller = createB2ProofController(prior.ports);
  const run = controller.start();
  await waitForStatus(controller, 'Background test ready');
  assert.deepEqual(prior.successfulRevisions, []);
  assert.equal(prior.metadata.commandIndex, 4);
  prior.lifecycle.resolve();
  await run;
});

test('relaunch never replays a committed second answer when metadata lags revision 5', async () => {
  const source = createHarness();
  const sourceController = createB2ProofController(source.ports);
  const sourceRun = sourceController.start();
  await waitForStatus(sourceController, 'Background test ready');
  source.lifecycle.resolve();
  await sourceRun;

  const snapshotA = await advanceToRevision(initialSnapshot('learner-a'), 5);
  const metadata = {
    ...source.metadata,
    atomicFailureCheckpoints: [...B2_ATOMIC_FAILURE_CHECKPOINTS],
  };
  const relaunched = createHarness({ metadata, snapshotA });
  const controller = createB2ProofController(relaunched.ports);
  await controller.start();

  assert.deepEqual(relaunched.failedCheckpoints, []);
  assert.deepEqual(
    relaunched.successfulRevisions,
    [6],
    'only the uncommitted continue command may execute',
  );
  assert.equal(relaunched.metadata.phase, 'complete');
});

test('stale or corrupt proof metadata fails closed without exposing learner data', async () => {
  const corrupt = {
    schemaVersion: 1,
    phase: 'ready-for-relaunch',
    commandIndex: 4,
    activeLearnerId: 'learner-a',
    expectedSessionId: 'stale-session',
    learnerARevision: 4,
    learnerBDigest: snapshotDigest(initialSnapshot('learner-b')),
    preRelaunchDigest: '0'.repeat(64),
    migrationRollback: 'verified',
    atomicFailureCheckpoints: [],
    lifecycleEvents: ['pause', 'resume'],
    updatedAt: START,
  };
  const harness = createHarness({ metadata: corrupt });
  const controller = createB2ProofController(harness.ports);

  await assert.rejects(controller.start(), { code: 'b2_proof_metadata_stale' });
  const diagnostic = canonicalJson(controller.getState());
  assert.match(diagnostic, /B2 proof needs attention/);
  assert.equal(controller.getState().learnerIsolation, 'not verified');
  assert.doesNotMatch(diagnostic, /wrong|answer|subjectState|practiceSession/);
  assert.deepEqual(harness.successfulRevisions, []);
});

test('unknown proof metadata fields are corrupt and cannot execute a command', async () => {
  const validSource = createHarness();
  const sourceController = createB2ProofController(validSource.ports);
  const sourceRun = sourceController.start();
  await waitForStatus(sourceController, 'Background test ready');
  validSource.lifecycle.resolve();
  await sourceRun;
  const harness = createHarness({
    metadata: { ...validSource.metadata, unexpected: true },
    snapshotA: validSource.learnerA,
  });
  const controller = createB2ProofController(harness.ports);

  await assert.rejects(controller.start(), { code: 'b2_proof_metadata_corrupt' });
  assert.equal(controller.getState().status, 'B2 proof needs attention');
  assert.deepEqual(harness.successfulRevisions, []);
  assert.deepEqual(harness.failedCheckpoints, []);
});

async function readyFixture() {
  const first = createHarness();
  const controller = createB2ProofController(first.ports);
  const run = controller.start();
  await waitForStatus(controller, 'Background test ready');
  first.lifecycle.resolve();
  await run;
  return first;
}

for (const [name, failureErrorFactory, expectedCode] of [
  [
    'database closed',
    () => Object.assign(new Error('database closed'), { code: 'b2_database_connection_closed' }),
    'b2_database_connection_closed',
  ],
  [
    'forged injection code',
    (checkpoint) =>
      Object.assign(new Error('forged'), {
        checkpoint,
        code: 'b2_injected_atomic_failure',
        name: 'B2AtomicFailureError',
      }),
    'b2_injected_atomic_failure',
  ],
  [
    'rollback cause',
    (checkpoint) => {
      const error = createB2AtomicFailureError(checkpoint);
      error.cause = Object.assign(new Error('rollback incomplete'), {
        code: 'sqlite_transaction_rollback_incomplete',
      });
      return error;
    },
    'b2_injected_atomic_failure',
  ],
]) {
  test(`atomic proof rethrows ${name} instead of certifying it`, async () => {
    const first = await readyFixture();
    const second = createHarness({
      failureErrorFactory,
      metadata: first.metadata,
      snapshotA: first.learnerA,
    });
    const controller = createB2ProofController(second.ports);

    await assert.rejects(controller.start(), { code: expectedCode });
    assert.equal(controller.getState().status, 'B2 proof needs attention');
    assert.equal(controller.getState().learnerIsolation, 'not verified');
    assert.deepEqual(second.successfulRevisions, []);
    assert.deepEqual(second.metadata.atomicFailureCheckpoints, []);
  });
}

test('metadata rejects malformed digests, timestamps and impossible complete phases', async () => {
  const first = await readyFixture();
  const corruptions = [
    { learnerBDigest: 'ABC' },
    { updatedAt: START + 1 },
    { phase: 'complete', commandIndex: 6, learnerARevision: 6 },
    {
      atomicFailureCheckpoints: [],
      commandIndex: 5,
      learnerARevision: 5,
    },
  ];
  for (const corruption of corruptions) {
    const harness = createHarness({
      metadata: { ...first.metadata, ...corruption },
      snapshotA: first.learnerA,
    });
    const controller = createB2ProofController(harness.ports);
    await assert.rejects(controller.start(), {
      code: 'b2_proof_metadata_corrupt',
    });
    assert.deepEqual(harness.successfulRevisions, []);
  }
});

test('complete metadata with a forged revision-4 digest fails closed', async () => {
  const first = await readyFixture();
  const completed = createHarness({
    metadata: first.metadata,
    snapshotA: first.learnerA,
  });
  await createB2ProofController(completed.ports).start();
  const corrupt = createHarness({
    metadata: { ...completed.metadata, preRelaunchDigest: '0'.repeat(64) },
    snapshotA: completed.learnerA,
  });
  const controller = createB2ProofController(corrupt.ports);

  await assert.rejects(controller.start(), { code: 'b2_proof_metadata_stale' });
  assert.equal(controller.getState().learnerIsolation, 'not verified');
  assert.deepEqual(corrupt.successfulRevisions, []);
});

test('paired learner-B and metadata corruption cannot impersonate the certified seed', async () => {
  const first = await readyFixture();
  const corruptLearnerB = initialSnapshot('learner-b');
  corruptLearnerB.subjectState.data.prefs.autoSpeak = true;
  const pairedDigest = snapshotDigest(corruptLearnerB);
  const paired = createHarness({
    metadata: { ...first.metadata, learnerBDigest: pairedDigest },
    snapshotA: first.learnerA,
    snapshotB: corruptLearnerB,
  });
  const controller = createB2ProofController(paired.ports);

  await assert.rejects(controller.start(), {
    code: 'b2_proof_learner_b_changed',
  });
  assert.deepEqual(paired.successfulRevisions, []);
  assert.deepEqual(paired.failedCheckpoints, []);
  assert.equal(controller.getState().status, 'B2 proof needs attention');
  assert.equal(controller.getState().learnerIsolation, 'not verified');
});

test('real B2 composition proves V0 rollback, V1 relaunch and exact durable completion', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-b2-composition-'));
  const databasePath = join(directory, 'proof.sqlite');
  t.after(() => rm(directory, { force: true, recursive: true }));
  const metadataWrites = [];
  const firstEvents = [];
  const firstLifecycle = createFakeLifecycle(firstEvents);
  const firstServices = await createB2AppServices({
    connectionFactory: createTrackedConnectionFactory(
      databasePath,
      firstEvents,
      metadataWrites,
    ),
    lifecycle: firstLifecycle.port,
    async migrate(connection, options) {
      firstEvents.push(
        options?.afterMigrationStep ? 'migrate:injected' : 'migrate:normal',
      );
      await configureAndMigrateDatabase(connection, options);
    },
    async seed(connection) {
      firstEvents.push('seed');
      await seedB2Learners(connection);
    },
  });

  const firstOrder = [
    'connection:open',
    'migrate:injected',
    'migrate:normal',
    'seed',
    'connection:close',
    'lifecycle:on-pause',
  ].map((entry) => firstEvents.indexOf(entry));
  assert.ok(firstOrder.every((index) => index >= 0));
  assert.deepEqual(firstOrder, firstOrder.toSorted((left, right) => left - right));
  assert.equal(firstServices.controller.getState().learnerIsolation, 'pending');

  const firstRun = firstServices.controller.start();
  await waitForStatus(firstServices.controller, 'Background test ready');
  firstLifecycle.emitPause();
  firstLifecycle.emitResume();
  await firstRun;
  assert.equal(firstServices.controller.getState().status, 'Ready for relaunch');
  assert.ok(metadataWrites.length > 0);
  assert.ok(
    metadataWrites.every((transactionActive) => transactionActive === false),
    'proof metadata must always be written outside the A3 transaction',
  );
  await firstServices.dispose();
  await firstServices.dispose();
  assert.equal(firstLifecycle.disposeCount, 1);

  const secondEvents = [];
  const secondLifecycle = createFakeLifecycle(secondEvents);
  const secondServices = await createB2AppServices({
    connectionFactory: createTrackedConnectionFactory(
      databasePath,
      secondEvents,
      metadataWrites,
    ),
    lifecycle: secondLifecycle.port,
    async migrate(connection, options) {
      secondEvents.push(
        options?.afterMigrationStep ? 'migrate:injected' : 'migrate:normal',
      );
      await configureAndMigrateDatabase(connection, options);
    },
    async seed(connection) {
      secondEvents.push('seed');
      await seedB2Learners(connection);
    },
  });
  assert.equal(secondEvents.includes('migrate:injected'), false);
  assert.ok(secondEvents.indexOf('migrate:normal') < secondEvents.indexOf('seed'));
  await secondServices.controller.start();
  assert.equal(secondServices.controller.getState().status, 'B2 proof complete');
  assert.equal(secondServices.controller.getState().learnerIsolation, 'verified');
  await secondServices.dispose();
  assert.equal(secondLifecycle.disposeCount, 1);
  assert.ok(metadataWrites.every((active) => active === false));

  const inspection = createNodeSqliteConnection(databasePath);
  await inspection.open();
  const [aggregate] = await inspection.query(
    'SELECT revision FROM spelling_aggregates WHERE learner_id = ?',
    ['learner-a'],
  );
  const [session] = await inspection.query(
    'SELECT status, state_json FROM spelling_practice_sessions WHERE learner_id = ?',
    ['learner-a'],
  );
  const eventRows = await inspection.query(
    'SELECT event_json FROM spelling_events WHERE learner_id = ? ORDER BY sequence_no',
    ['learner-a'],
  );
  await inspection.close();

  assert.equal(aggregate.revision, 6);
  assert.equal(session.status, 'completed');
  assert.equal(JSON.parse(session.state_json).status, 'completed');
  assert.deepEqual(
    eventRows.map(({ event_json }) => JSON.parse(event_json).type),
    ['spelling.retry-cleared', 'spelling.session-completed'],
  );
});

test('B2 startup failures clean every acquired resource and preserve the primary error', async (t) => {
  const stages = [
    {
      name: 'normal migration',
      configure(events, primary) {
        return {
          async migrate(connection, options) {
            events.push(options?.afterMigrationStep ? 'migrate:injected' : 'migrate:normal');
            if (!options?.afterMigrationStep) throw primary;
            await configureAndMigrateDatabase(connection, options);
          },
        };
      },
    },
    {
      name: 'seed',
      configure(_events, primary) {
        return {
          migrate: configureAndMigrateDatabase,
          async seed() {
            throw primary;
          },
        };
      },
    },
    {
      name: 'lifecycle construction',
      configure(_events, primary) {
        return {
          migrate: configureAndMigrateDatabase,
          seed: seedB2Learners,
          lifecycleFactory() {
            throw primary;
          },
        };
      },
    },
  ];

  for (const stage of stages) {
    await t.test(stage.name, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'ks2-b2-startup-failure-'));
      const databasePath = join(directory, 'proof.sqlite');
      const events = [];
      const primary = Object.assign(new Error(`${stage.name} failed`), {
        code: `test_${stage.name.replaceAll(' ', '_')}_failed`,
      });
      let caught;
      try {
        await createB2AppServices({
          connectionFactory: createTrackedConnectionFactory(
            databasePath,
            events,
            [],
          ),
          ...stage.configure(events, primary),
        });
      } catch (error) {
        caught = error;
      }
      assert.equal(caught, primary, 'startup must preserve the primary error object');
      assert.equal(events.at(-1), 'connection:close');
      await rm(directory, { force: true, recursive: true });
    });
  }
});

test('coordinator startup failure aggregates cleanup failure without replacing its code', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-b2-reopen-failure-'));
  const databasePath = join(directory, 'proof.sqlite');
  t.after(() => rm(directory, { force: true, recursive: true }));
  const events = [];
  const primary = Object.assign(new Error('reopen failed'), {
    code: 'test_reopen_failed',
  });
  const cleanup = Object.assign(new Error('lifecycle cleanup failed'), {
    code: 'test_cleanup_failed',
  });
  const lifecycle = createFakeLifecycle(events, { disposeError: cleanup });
  const realFactory = createTrackedConnectionFactory(databasePath, events, []);
  let factoryCount = 0;
  const connectionFactory = async () => {
    factoryCount += 1;
    if (factoryCount === 1) return realFactory();
    return Object.freeze({
      async open() {
        throw primary;
      },
      async close() {},
      async execute() {
        throw new Error('unexpected execute');
      },
      async query() {
        throw new Error('unexpected query');
      },
      async begin() {
        throw new Error('unexpected begin');
      },
      async commit() {
        throw new Error('unexpected commit');
      },
      async rollback() {
        throw new Error('unexpected rollback');
      },
      async isTransactionActive() {
        return false;
      },
    });
  };

  let caught;
  try {
    await createB2AppServices({ connectionFactory, lifecycle: lifecycle.port });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught, primary);
  assert.equal(caught.code, 'test_reopen_failed');
  assert.ok(caught.cause instanceof AggregateError);
  assert.ok(caught.cause.errors.includes(cleanup));
  assert.equal(lifecycle.disposeCount, 1);
});

test('V1 without durable proof metadata fails closed and disposes lifecycle and connection', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-b2-missing-proof-'));
  const databasePath = join(directory, 'proof.sqlite');
  t.after(() => rm(directory, { force: true, recursive: true }));
  const preparation = createNodeSqliteConnection(databasePath);
  await preparation.open();
  await configureAndMigrateDatabase(preparation);
  await seedB2Learners(preparation);
  await preparation.close();

  const events = [];
  const lifecycle = createFakeLifecycle(events);
  await assert.rejects(
    () =>
      createB2AppServices({
        connectionFactory: createTrackedConnectionFactory(databasePath, events, []),
        lifecycle: lifecycle.port,
      }),
    { code: 'b2_proof_metadata_missing' },
  );
  assert.equal(lifecycle.disposeCount, 1);
  assert.ok(events.includes('connection:close'));
  assert.ok(
    events.lastIndexOf('connection:close') < events.lastIndexOf('lifecycle:dispose'),
  );
});
