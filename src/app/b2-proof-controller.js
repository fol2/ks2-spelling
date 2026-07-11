import {
  applySpellingCommand,
  loadStarterSpellingCatalogue,
  validateCatalogueV1,
  validateSpellingCommandSnapshotV1,
} from '../domain/spelling/index.js';
import { canonicalJson } from '../platform/database/canonical-json.js';

export const B2_PROOF_METADATA_KEY = 'b2-proof';

export const B2_ATOMIC_FAILURE_CHECKPOINTS = Object.freeze([
  'after-subject-state',
  'after-practice-session',
  'after-events',
  'after-monster-state',
  'after-camp-state',
  'after-revision',
  'before-commit',
]);

const LEARNER_A = 'learner-a';
const LEARNER_B = 'learner-b';
const PROOF_SCHEMA_VERSION = 1;
const START_TIMESTAMP = 1_768_478_400_000;
const PHASES = new Set([
  'fresh',
  'background-test-ready',
  'ready-for-relaunch',
  'complete',
]);
const METADATA_KEYS = Object.freeze([
  'schemaVersion',
  'phase',
  'commandIndex',
  'activeLearnerId',
  'expectedSessionId',
  'learnerARevision',
  'learnerBDigest',
  'preRelaunchDigest',
  'migrationRollback',
  'atomicFailureCheckpoints',
  'lifecycleEvents',
  'updatedAt',
]);
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

function proofError(code, options) {
  const error = new Error(code, options);
  error.code = code;
  return error;
}

function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactPlainRecord(value, keys) {
  return (
    plainRecord(value) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        descriptor &&
        Object.hasOwn(descriptor, 'value') &&
        descriptor.enumerable
      );
    }) &&
    Reflect.ownKeys(value).every(
      (key) => typeof key === 'string' && keys.includes(key),
    )
  );
}

function exactStringArray(value, allowed) {
  return (
    Array.isArray(value) &&
    Object.getPrototypeOf(value) === Array.prototype &&
    value.every((entry, index) => entry === allowed[index])
  );
}

function validateMetadata(candidate) {
  if (!exactPlainRecord(candidate, METADATA_KEYS)) {
    throw proofError('b2_proof_metadata_corrupt');
  }
  if (
    candidate.schemaVersion !== PROOF_SCHEMA_VERSION ||
    !PHASES.has(candidate.phase) ||
    !Number.isSafeInteger(candidate.commandIndex) ||
    candidate.commandIndex < 0 ||
    candidate.commandIndex > COMMANDS.length ||
    candidate.activeLearnerId !== LEARNER_A ||
    (candidate.expectedSessionId !== null &&
      (typeof candidate.expectedSessionId !== 'string' ||
        candidate.expectedSessionId.length === 0)) ||
    candidate.learnerARevision !== candidate.commandIndex ||
    typeof candidate.learnerBDigest !== 'string' ||
    typeof candidate.preRelaunchDigest !== 'string' ||
    candidate.migrationRollback !== 'verified' ||
    !Number.isSafeInteger(candidate.updatedAt) ||
    candidate.updatedAt < 0
  ) {
    throw proofError('b2_proof_metadata_corrupt');
  }
  if (
    !Array.isArray(candidate.atomicFailureCheckpoints) ||
    !exactStringArray(
      candidate.atomicFailureCheckpoints,
      B2_ATOMIC_FAILURE_CHECKPOINTS,
    ) ||
    candidate.atomicFailureCheckpoints.length >
      B2_ATOMIC_FAILURE_CHECKPOINTS.length
  ) {
    throw proofError('b2_proof_metadata_corrupt');
  }
  if (
    !Array.isArray(candidate.lifecycleEvents) ||
    !exactStringArray(candidate.lifecycleEvents, ['pause', 'resume']) ||
    candidate.lifecycleEvents.length > 2
  ) {
    throw proofError('b2_proof_metadata_corrupt');
  }
  if (
    candidate.phase === 'fresh' &&
    (candidate.commandIndex > 4 || candidate.lifecycleEvents.length !== 0)
  ) {
    throw proofError('b2_proof_metadata_corrupt');
  }
  if (
    candidate.phase === 'background-test-ready' &&
    (candidate.commandIndex !== 4 || candidate.lifecycleEvents.length !== 0)
  ) {
    throw proofError('b2_proof_metadata_corrupt');
  }
  if (
    candidate.phase === 'ready-for-relaunch' &&
    (candidate.commandIndex < 4 ||
      candidate.commandIndex > 6 ||
      candidate.lifecycleEvents.length !== 2)
  ) {
    throw proofError('b2_proof_metadata_corrupt');
  }
  if (
    candidate.phase === 'complete' &&
    (candidate.commandIndex !== 6 ||
      candidate.atomicFailureCheckpoints.length !==
        B2_ATOMIC_FAILURE_CHECKPOINTS.length ||
      candidate.lifecycleEvents.length !== 2)
  ) {
    throw proofError('b2_proof_metadata_corrupt');
  }
  return structuredClone(candidate);
}

function randomFrom(seed = 42) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let result = Math.imul(value ^ (value >>> 15), 1 | value);
    result ^= result + Math.imul(result ^ (result >>> 7), 61 | result);
    return ((result ^ (result >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function initialSnapshot(catalogue, learnerId) {
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

function snapshotAfterPlan(current, plan, catalogue) {
  return validateSpellingCommandSnapshotV1(
    {
      ...structuredClone(current),
      revision: plan.nextRevision,
      subjectState: structuredClone(plan.nextSubjectState),
      practiceSession: structuredClone(plan.nextPracticeSession),
      eventLog: structuredClone(plan.nextEventLog),
      monsterStateByRewardTrackId: structuredClone(
        plan.nextMonsterStateByRewardTrackId,
      ),
      campStateByPackId: structuredClone(plan.nextCampStateByPackId),
    },
    catalogue,
  );
}

function expectedSnapshots(catalogue) {
  const snapshots = [initialSnapshot(catalogue, LEARNER_A)];
  const random = randomFrom(42);
  for (let index = 0; index < COMMANDS.length; index += 1) {
    const nowMs = START_TIMESTAMP + index;
    const plan = applySpellingCommand({
      snapshot: snapshots[index],
      command: COMMANDS[index],
      contentSnapshot: catalogue,
      now: () => nowMs,
      random,
    });
    snapshots.push(snapshotAfterPlan(snapshots[index], plan, catalogue));
  }
  return Object.freeze(snapshots.map((snapshot) => Object.freeze(snapshot)));
}

async function canonicalDigest(value) {
  const cryptoPort = globalThis.crypto;
  if (!cryptoPort?.subtle) throw proofError('b2_proof_crypto_unavailable');
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await cryptoPort.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function requireMethod(owner, method, label) {
  if (!owner || typeof owner !== 'object' || typeof owner[method] !== 'function') {
    throw new TypeError(`${label}.${method} must be a function.`);
  }
}

function readOptions(options) {
  if (!plainRecord(options)) throw new TypeError('B2 proof options must be an object.');
  const catalogue = validateCatalogueV1(
    options.catalogue ?? loadStarterSpellingCatalogue(),
  );
  if (catalogue.items.length !== 20) {
    throw new TypeError('The B2 Starter catalogue must contain exactly 20 items.');
  }
  requireMethod(options.repository, 'runCommandTransaction', 'repository');
  requireMethod(options.snapshotStore, 'read', 'snapshotStore');
  requireMethod(options.proofStore, 'read', 'proofStore');
  requireMethod(options.proofStore, 'write', 'proofStore');
  requireMethod(options.lifecycleProof, 'waitForPauseResume', 'lifecycleProof');
  if (typeof options.createFailureRepository !== 'function') {
    throw new TypeError('createFailureRepository must be a function.');
  }
  if (options.migrationRollbackVerified !== true) {
    throw proofError('b2_migration_rollback_unverified');
  }
  if (!Number.isSafeInteger(options.updatedAt) || options.updatedAt < 0) {
    throw new TypeError('updatedAt must be a safe non-negative integer.');
  }
  return {
    catalogue,
    repository: options.repository,
    snapshotStore: options.snapshotStore,
    proofStore: options.proofStore,
    lifecycleProof: options.lifecycleProof,
    createFailureRepository: options.createFailureRepository,
    updatedAt: options.updatedAt,
  };
}

function exactSnapshot(actual, expected) {
  return canonicalJson(actual) === canonicalJson(expected);
}

function activeSessionId(snapshot) {
  const session = snapshot.practiceSession;
  return session && session.status === 'active' ? session.id : null;
}

function commandPlanner(index, catalogue) {
  return (fresh, context) => {
    const expectedNow = START_TIMESTAMP + index;
    if (context.nowMs !== expectedNow) {
      throw proofError('b2_proof_command_clock_invalid');
    }
    return applySpellingCommand({
      snapshot: fresh,
      command: COMMANDS[index],
      contentSnapshot: catalogue,
      now: () => context.nowMs,
      random: randomFrom(42),
    });
  };
}

export function createB2ProofController(options) {
  const ports = readOptions(options);
  const expected = expectedSnapshots(ports.catalogue);
  const listeners = new Set();
  let state = Object.freeze({ status: 'Preparing local proof' });
  let startPromise;

  function publish(status) {
    state = Object.freeze({ status });
    for (const listener of listeners) listener(state);
  }

  async function readSnapshots() {
    const [learnerA, learnerB] = await Promise.all([
      ports.snapshotStore.read(LEARNER_A),
      ports.snapshotStore.read(LEARNER_B),
    ]);
    return { learnerA, learnerB, learnerBDigest: await canonicalDigest(learnerB) };
  }

  async function persist(metadata) {
    const validated = validateMetadata(metadata);
    await ports.proofStore.write(B2_PROOF_METADATA_KEY, validated);
    return validated;
  }

  async function initialMetadata() {
    const snapshots = await readSnapshots();
    if (!exactSnapshot(snapshots.learnerB, initialSnapshot(ports.catalogue, LEARNER_B))) {
      throw proofError('b2_proof_learner_b_changed');
    }
    return persist({
      schemaVersion: PROOF_SCHEMA_VERSION,
      phase: 'fresh',
      commandIndex: 0,
      activeLearnerId: LEARNER_A,
      expectedSessionId: null,
      learnerARevision: 0,
      learnerBDigest: snapshots.learnerBDigest,
      preRelaunchDigest: '',
      migrationRollback: 'verified',
      atomicFailureCheckpoints: [],
      lifecycleEvents: [],
      updatedAt: ports.updatedAt,
    });
  }

  async function assertLearnerB(metadata) {
    const learnerB = await ports.snapshotStore.read(LEARNER_B);
    if ((await canonicalDigest(learnerB)) !== metadata.learnerBDigest) {
      throw proofError('b2_proof_learner_b_changed');
    }
  }

  async function advanceMetadata(metadata, index, snapshot) {
    return persist({
      ...metadata,
      commandIndex: index,
      learnerARevision: index,
      expectedSessionId: activeSessionId(snapshot),
      updatedAt: ports.updatedAt,
    });
  }

  async function reconcileAndRun(metadata, stopIndex, repository) {
    let current = metadata;
    while (current.commandIndex < stopIndex) {
      const index = current.commandIndex;
      const durable = await ports.snapshotStore.read(LEARNER_A);
      if (exactSnapshot(durable, expected[index + 1])) {
        current = await advanceMetadata(current, index + 1, durable);
        continue;
      }
      if (!exactSnapshot(durable, expected[index])) {
        throw proofError('b2_proof_metadata_stale');
      }
      await repository.runCommandTransaction(
        LEARNER_A,
        commandPlanner(index, ports.catalogue),
      );
      const committed = await ports.snapshotStore.read(LEARNER_A);
      if (!exactSnapshot(committed, expected[index + 1])) {
        throw proofError('b2_proof_command_postcondition_failed');
      }
      current = await advanceMetadata(current, index + 1, committed);
      await assertLearnerB(current);
    }
    return current;
  }

  async function runFirstLaunch(metadata) {
    let current = await reconcileAndRun(metadata, 4, ports.repository);
    const revisionFour = await ports.snapshotStore.read(LEARNER_A);
    current = await persist({
      ...current,
      phase: 'background-test-ready',
      preRelaunchDigest: await canonicalDigest(revisionFour),
      updatedAt: ports.updatedAt,
    });
    publish('Background test ready');
    const lifecycleEvents = await ports.lifecycleProof.waitForPauseResume();
    if (canonicalJson(lifecycleEvents) !== canonicalJson(['pause', 'resume'])) {
      throw proofError('b2_proof_lifecycle_invalid');
    }
    const resumed = await ports.snapshotStore.read(LEARNER_A);
    if (!exactSnapshot(resumed, expected[4])) {
      throw proofError('b2_proof_resume_state_invalid');
    }
    await assertLearnerB(current);
    await persist({
      ...current,
      phase: 'ready-for-relaunch',
      lifecycleEvents: ['pause', 'resume'],
      updatedAt: ports.updatedAt,
    });
    publish('Ready for relaunch');
  }

  async function proveAtomicFailures(metadata) {
    let current = metadata;
    const before = await ports.snapshotStore.read(LEARNER_A);
    const beforeDigest = await canonicalDigest(before);
    if (!exactSnapshot(before, expected[4]) || beforeDigest !== current.preRelaunchDigest) {
      throw proofError('b2_proof_metadata_stale');
    }
    for (
      let index = current.atomicFailureCheckpoints.length;
      index < B2_ATOMIC_FAILURE_CHECKPOINTS.length;
      index += 1
    ) {
      const checkpoint = B2_ATOMIC_FAILURE_CHECKPOINTS[index];
      const repository = ports.createFailureRepository(checkpoint);
      requireMethod(repository, 'runCommandTransaction', 'failureRepository');
      let rejected = false;
      try {
        await repository.runCommandTransaction(
          LEARNER_A,
          commandPlanner(4, ports.catalogue),
        );
      } catch {
        rejected = true;
      }
      if (!rejected) throw proofError('b2_proof_failure_injection_did_not_fail');
      const after = await ports.snapshotStore.read(LEARNER_A);
      if (
        !exactSnapshot(after, expected[4]) ||
        (await canonicalDigest(after)) !== beforeDigest
      ) {
        throw proofError('b2_proof_atomic_rollback_changed_state');
      }
      await assertLearnerB(current);
      current = await persist({
        ...current,
        atomicFailureCheckpoints: B2_ATOMIC_FAILURE_CHECKPOINTS.slice(
          0,
          index + 1,
        ),
        updatedAt: ports.updatedAt,
      });
    }
    return current;
  }

  async function runRelaunch(metadata) {
    const durable = await ports.snapshotStore.read(LEARNER_A);
    const matchesPrecondition = exactSnapshot(
      durable,
      expected[metadata.commandIndex],
    );
    const matchesCommittedPostcondition =
      metadata.commandIndex < COMMANDS.length &&
      exactSnapshot(durable, expected[metadata.commandIndex + 1]);
    if (
      metadata.expectedSessionId !== activeSessionId(expected[metadata.commandIndex]) ||
      (!matchesPrecondition && !matchesCommittedPostcondition) ||
      (matchesCommittedPostcondition &&
        metadata.commandIndex === 4 &&
        metadata.atomicFailureCheckpoints.length !==
          B2_ATOMIC_FAILURE_CHECKPOINTS.length) ||
      (matchesPrecondition && metadata.commandIndex === 4 &&
        (await canonicalDigest(durable)) !== metadata.preRelaunchDigest)
    ) {
      throw proofError('b2_proof_metadata_stale');
    }
    await assertLearnerB(metadata);
    publish('Resumed safely');
    let current = metadata;
    if (matchesCommittedPostcondition) {
      current = await advanceMetadata(
        current,
        current.commandIndex + 1,
        durable,
      );
    }
    if (current.commandIndex === 4) current = await proveAtomicFailures(current);
    current = await reconcileAndRun(current, 6, ports.repository);
    const complete = await ports.snapshotStore.read(LEARNER_A);
    if (!exactSnapshot(complete, expected[6])) {
      throw proofError('b2_proof_final_state_invalid');
    }
    await assertLearnerB(current);
    await persist({
      ...current,
      phase: 'complete',
      updatedAt: ports.updatedAt,
    });
    publish('B2 proof complete');
  }

  async function run() {
    try {
      const stored = await ports.proofStore.read(B2_PROOF_METADATA_KEY);
      const metadata = stored === null ? await initialMetadata() : validateMetadata(stored);
      if (
        metadata.expectedSessionId !==
        activeSessionId(expected[metadata.commandIndex])
      ) {
        throw proofError('b2_proof_metadata_stale');
      }
      if (metadata.phase === 'complete') {
        const durable = await ports.snapshotStore.read(LEARNER_A);
        if (!exactSnapshot(durable, expected[6])) {
          throw proofError('b2_proof_metadata_stale');
        }
        await assertLearnerB(metadata);
        publish('B2 proof complete');
        return;
      }
      if (metadata.phase === 'ready-for-relaunch') {
        await runRelaunch(metadata);
        return;
      }
      if (metadata.phase === 'background-test-ready') {
        await runFirstLaunch({ ...metadata, phase: 'fresh' });
        return;
      }
      await runFirstLaunch(metadata);
    } catch (cause) {
      publish('B2 proof needs attention');
      if (cause?.code === 'b2_proof_metadata_stale') throw cause;
      throw proofError(cause?.code ?? 'b2_proof_failed', { cause });
    }
  }

  return Object.freeze({
    start() {
      if (!startPromise) startPromise = run();
      return startPromise;
    },
    getState() {
      return state;
    },
    subscribe(listener) {
      if (typeof listener !== 'function') {
        throw new TypeError('B2 proof listener must be a function.');
      }
      listeners.add(listener);
      listener(state);
      let removed = false;
      return Object.freeze({
        remove() {
          if (removed) return;
          removed = true;
          listeners.delete(listener);
        },
      });
    },
  });
}
