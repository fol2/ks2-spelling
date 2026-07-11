import assert from 'node:assert/strict';
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
  createB2ProofController,
} from '../src/app/b2-proof-controller.js';
import { canonicalJson } from '../src/platform/database/canonical-json.js';

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

function createHarness({ metadata = null, snapshotA = initialSnapshot('learner-a') } = {}) {
  const catalogue = loadStarterSpellingCatalogue();
  let learnerA = structuredClone(snapshotA);
  const learnerB = initialSnapshot('learner-b');
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
        const error = new Error('sensitive typed answer: answer');
        error.code = 'injected_sqlite_failure';
        throw error;
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
    learnerBDigest: 'stale',
    preRelaunchDigest: 'stale',
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
