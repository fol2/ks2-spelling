import {
  SPELLING_COMMAND_MAX_CONFLICT_ATTEMPTS,
  canonicalGuardianDay,
  validateCatalogueV1,
  validateSpellingCommandPlanV1,
  validateSpellingCommandRepository,
  validateSpellingCommandSnapshotV1,
} from '../../domain/spelling/index.js';

import { canonicalJson } from './canonical-json.js';
import { assertSqlConnection } from './sql-connection-contract.js';

const LEARNER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STORE_METHODS = Object.freeze([
  'read',
  'writeSubjectState',
  'writePracticeSession',
  'appendEvents',
  'syncMonsters',
  'syncCamp',
  'compareAndSetAggregate',
]);
const GATE_METHODS = Object.freeze([
  'run',
  'pauseAndDrain',
  'resume',
  'isAccepting',
  'waitForIdle',
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
const CAS_CONFLICT = Symbol('sqlite-spelling-cas-conflict');

function repositoryError(code, message = code, options) {
  const error = new Error(message, options);
  error.code = code;
  return error;
}

function requireLearnerId(learnerId) {
  if (typeof learnerId !== 'string' || !LEARNER_ID.test(learnerId)) {
    throw new TypeError(
      'runCommandTransaction learnerId must be a canonical identifier.',
    );
  }
  return learnerId;
}

function requireExactMethods(value, methods, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must have a plain object prototype.`);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== methods.length ||
    keys.some((key) => typeof key !== 'string' || !methods.includes(key))
  ) {
    throw new TypeError(`${label} must expose exactly its required methods.`);
  }
  for (const method of methods) {
    const descriptor = Object.getOwnPropertyDescriptor(value, method);
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, 'value') ||
      !descriptor.enumerable ||
      typeof descriptor.value !== 'function'
    ) {
      throw new TypeError(`${label}.${method} must be an enumerable own method.`);
    }
  }
  return value;
}

function createCatalogueRegistry(cataloguesById) {
  let canonical;
  try {
    canonical = JSON.parse(canonicalJson(cataloguesById));
  } catch (cause) {
    throw new TypeError(
      'cataloguesById must contain canonical serialisable data.',
      { cause },
    );
  }
  if (!canonical || typeof canonical !== 'object' || Array.isArray(canonical)) {
    throw new TypeError('cataloguesById must be a plain object.');
  }
  const catalogues = new Map();
  for (const [catalogueId, candidate] of Object.entries(canonical)) {
    const catalogue = validateCatalogueV1(candidate);
    if (catalogue.catalogueId !== catalogueId) {
      throw new TypeError(
        'Catalogue registry key does not match catalogue identity.',
      );
    }
    catalogues.set(catalogueId, catalogue);
  }
  if (catalogues.size === 0) {
    throw new TypeError('cataloguesById must not be empty.');
  }
  return catalogues;
}

function catalogueForSnapshot(snapshot, catalogues) {
  const catalogue = catalogues.get(snapshot.catalogueId);
  if (!catalogue) {
    throw new TypeError(
      `Unknown Spelling catalogue: ${String(snapshot.catalogueId)}.`,
    );
  }
  return catalogue;
}

function clone(value) {
  return structuredClone(value);
}

function expectedCommittedSnapshot(input, plan, catalogue) {
  return validateSpellingCommandSnapshotV1(
    {
      ...clone(input),
      revision: plan.nextRevision,
      subjectState: clone(plan.nextSubjectState),
      practiceSession: clone(plan.nextPracticeSession),
      eventLog: clone(plan.nextEventLog),
      monsterStateByRewardTrackId: clone(
        plan.nextMonsterStateByRewardTrackId,
      ),
      campStateByPackId: clone(plan.nextCampStateByPackId),
    },
    catalogue,
  );
}

function casConflictError() {
  const error = repositoryError('spelling_revision_conflict');
  Object.defineProperty(error, CAS_CONFLICT, { value: true });
  return error;
}

function isCasConflict(error) {
  return Boolean(error?.[CAS_CONFLICT]);
}

function rollbackIncompleteError() {
  return repositoryError(
    'sqlite_transaction_rollback_incomplete',
    'SQLite transaction remained active after rollback.',
  );
}

function attachRollbackCause(original, rollbackCause) {
  if (!rollbackCause) return original;
  const error = original instanceof Error ? original : new Error(String(original));
  try {
    if (!Object.hasOwn(error, 'cause')) {
      Object.defineProperty(error, 'cause', {
        configurable: true,
        value: rollbackCause,
      });
      return error;
    }
  } catch {
    // Fall through to a stable-code wrapper when the original error is frozen.
  }
  const wrapped = new Error(error.message, { cause: rollbackCause });
  wrapped.name = error.name;
  if (error.code !== undefined) wrapped.code = error.code;
  return wrapped;
}

async function rollbackIfActive(connection) {
  let rollbackCause = null;
  let active;
  try {
    active = await connection.isTransactionActive();
  } catch (error) {
    return error;
  }
  if (active === true) {
    try {
      await connection.rollback();
    } catch (error) {
      rollbackCause = error;
    }
  }
  try {
    if ((await connection.isTransactionActive()) === true) {
      rollbackCause ??= rollbackIncompleteError();
    }
  } catch (error) {
    rollbackCause ??= error;
  }
  return rollbackCause;
}

export function createSQLiteSpellingCommandRepository({
  connection,
  gate,
  store,
  cataloguesById,
  now,
  failureInjector,
} = {}) {
  assertSqlConnection(connection);
  requireExactMethods(gate, GATE_METHODS, 'Database command gate');
  requireExactMethods(store, STORE_METHODS, 'SQLite Spelling snapshot store');
  if (typeof now !== 'function') {
    throw new TypeError('Command repository requires an injected now() port.');
  }
  if (failureInjector !== undefined && typeof failureInjector !== 'function') {
    throw new TypeError('failureInjector must be a function when supplied.');
  }
  const catalogues = createCatalogueRegistry(cataloguesById);

  async function inject(checkpoint, stagedSnapshot) {
    if (!CHECKPOINTS.includes(checkpoint)) {
      throw new TypeError(`Unknown transaction checkpoint: ${checkpoint}.`);
    }
    if (failureInjector) {
      await failureInjector(checkpoint, clone(stagedSnapshot));
    }
  }

  async function attemptTransaction(learnerId, planner) {
    for (
      let attempt = 1;
      attempt <= SPELLING_COMMAND_MAX_CONFLICT_ATTEMPTS;
      attempt += 1
    ) {
      try {
        await connection.begin();
        const stored = await store.read(learnerId);
        const catalogue = catalogueForSnapshot(stored, catalogues);
        const fresh = validateSpellingCommandSnapshotV1(
          clone(stored),
          catalogue,
        );
        const nowMs = now();
        const todayGuardianDay = canonicalGuardianDay(nowMs);
        const context = Object.freeze({ nowMs, todayGuardianDay });
        const candidatePlan = await planner(clone(fresh), context);
        const plan = validateSpellingCommandPlanV1(
          candidatePlan,
          catalogue,
          fresh,
          { expectedNowMs: nowMs },
        );

        if (!plan.changed) {
          await connection.commit();
          return clone(plan);
        }

        const expected = expectedCommittedSnapshot(fresh, plan, catalogue);
        const staged = clone(fresh);

        await store.writeSubjectState(learnerId, plan.nextSubjectState);
        staged.subjectState = clone(plan.nextSubjectState);
        await inject('after-subject-state', staged);

        await store.writePracticeSession(learnerId, plan.nextPracticeSession);
        staged.practiceSession = clone(plan.nextPracticeSession);
        await inject('after-practice-session', staged);

        await store.appendEvents(
          learnerId,
          fresh.eventLog,
          plan.appendedEvents,
        );
        staged.eventLog = clone(plan.nextEventLog);
        await inject('after-events', staged);

        await store.syncMonsters(
          learnerId,
          plan.nextMonsterStateByRewardTrackId,
        );
        staged.monsterStateByRewardTrackId = clone(
          plan.nextMonsterStateByRewardTrackId,
        );
        await inject('after-monster-state', staged);

        await store.syncCamp(learnerId, plan.nextCampStateByPackId);
        staged.campStateByPackId = clone(plan.nextCampStateByPackId);
        await inject('after-camp-state', staged);

        const changedRows = await store.compareAndSetAggregate(
          learnerId,
          fresh.revision,
          plan,
          nowMs,
        );
        if (changedRows === 0) throw casConflictError();
        staged.revision = plan.nextRevision;
        await inject('after-revision', staged);

        const rehydrated = await store.read(learnerId);
        if (canonicalJson(rehydrated) !== canonicalJson(expected)) {
          throw repositoryError(
            'sqlite_staged_snapshot_mismatch',
            'The staged SQLite snapshot does not match its validated plan.',
          );
        }
        await inject('before-commit', staged);

        await connection.commit();
        return clone(plan);
      } catch (error) {
        const rollbackCause = await rollbackIfActive(connection);
        if (isCasConflict(error)) {
          if (rollbackCause) {
            throw attachRollbackCause(casConflictError(), rollbackCause);
          }
          if (attempt < SPELLING_COMMAND_MAX_CONFLICT_ATTEMPTS) continue;
          throw casConflictError();
        }
        throw attachRollbackCause(error, rollbackCause);
      }
    }
    throw casConflictError();
  }

  function runCommandTransaction(learnerId, planner) {
    try {
      requireLearnerId(learnerId);
    } catch (error) {
      return Promise.reject(error);
    }
    if (typeof planner !== 'function') {
      return Promise.reject(
        new TypeError('runCommandTransaction planner must be a function.'),
      );
    }
    return gate.run(() => attemptTransaction(learnerId, planner));
  }

  return Object.freeze(
    validateSpellingCommandRepository({ runCommandTransaction }),
  );
}
