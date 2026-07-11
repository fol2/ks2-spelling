import { validateCatalogueV1 } from '../index.js';
import {
  canonicalGuardianDay,
  validateSpellingCommandPlanV1,
  validateSpellingCommandSnapshotV1,
} from './command-contracts.js';

export const SPELLING_COMMAND_MAX_CONFLICT_ATTEMPTS = 3;

const REPOSITORY_KEYS = new Set(['runCommandTransaction']);
const CONFLICT_CODE = 'spelling_revision_conflict';
const CHECKPOINTS = Object.freeze([
  'after-subject-state',
  'after-practice-session',
  'after-events',
  'after-monster-state',
  'after-camp-state',
  'after-revision',
  'before-commit',
]);

function clone(value) {
  return structuredClone(value);
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function conflictError() {
  const error = new Error(CONFLICT_CODE);
  error.code = CONFLICT_CODE;
  return error;
}

function isConflict(error) {
  return error?.code === CONFLICT_CODE || error?.message === CONFLICT_CODE;
}

function cloneCatalogueRegistry(cataloguesById) {
  const registry = record(cataloguesById, 'cataloguesById');
  const catalogues = new Map();
  for (const [catalogueId, candidate] of Object.entries(registry)) {
    const catalogue = validateCatalogueV1(clone(candidate));
    if (catalogue.catalogueId !== catalogueId) {
      throw new TypeError(`Catalogue registry key ${catalogueId} does not match its catalogue identity.`);
    }
    catalogues.set(catalogueId, catalogue);
  }
  if (catalogues.size === 0) throw new TypeError('cataloguesById must not be empty.');
  return catalogues;
}

function catalogueForSnapshot(snapshot, catalogues) {
  const catalogue = catalogues.get(snapshot?.catalogueId);
  if (!catalogue) {
    throw new TypeError(`Unknown Spelling catalogue: ${String(snapshot?.catalogueId)}.`);
  }
  return catalogue;
}

function ownDataString(value, key, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
      || typeof descriptor.value !== 'string') {
    throw new TypeError(`${label}.${key} must be an enumerable own string data property.`);
  }
  return descriptor.value;
}

function cloneSnapshotRegistry(snapshots, catalogues) {
  if (!Array.isArray(snapshots)) throw new TypeError('snapshots must be an array.');
  const committed = new Map();
  for (const candidate of snapshots) {
    const catalogueId = ownDataString(candidate, 'catalogueId', 'Spelling command snapshot');
    const catalogue = catalogues.get(catalogueId);
    if (!catalogue) throw new TypeError(`Unknown Spelling catalogue: ${catalogueId}.`);
    const snapshot = validateSpellingCommandSnapshotV1(candidate, catalogue);
    if (committed.has(snapshot.learnerId)) {
      throw new TypeError(`Duplicate Spelling learner snapshot: ${snapshot.learnerId}.`);
    }
    committed.set(snapshot.learnerId, snapshot);
  }
  return committed;
}

function stageSnapshot(input, plan) {
  const draft = clone(input);
  const stages = [
    ['after-subject-state', () => { draft.subjectState = clone(plan.nextSubjectState); }],
    ['after-practice-session', () => { draft.practiceSession = clone(plan.nextPracticeSession); }],
    ['after-events', () => { draft.eventLog = clone(plan.nextEventLog); }],
    ['after-monster-state', () => {
      draft.monsterStateByRewardTrackId = clone(plan.nextMonsterStateByRewardTrackId);
    }],
    ['after-camp-state', () => { draft.campStateByPackId = clone(plan.nextCampStateByPackId); }],
    ['after-revision', () => { draft.revision = plan.nextRevision; }],
  ];
  return { draft, stages };
}

function expectedCommittedSnapshot(input, plan, catalogue) {
  const { draft, stages } = stageSnapshot(input, plan);
  for (const [, applyStage] of stages) applyStage();
  return validateSpellingCommandSnapshotV1(draft, catalogue);
}

export function validateSpellingCommandRepository(candidate) {
  const repository = record(candidate, 'Spelling command repository');
  const prototype = Object.getPrototypeOf(repository);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Spelling command repository must be a plain object without a custom prototype.');
  }
  const keys = Reflect.ownKeys(repository);
  for (const key of keys) {
    if (!REPOSITORY_KEYS.has(key)) throw new TypeError(`Unknown Spelling command repository key: ${String(key)}.`);
  }
  if (keys.length !== 1 || typeof repository.runCommandTransaction !== 'function') {
    throw new TypeError('Spelling command repository must expose only runCommandTransaction().');
  }
  return repository;
}

export function createInMemorySpellingCommandRepository({
  snapshots,
  cataloguesById,
  failureInjector,
  now,
} = {}) {
  if (failureInjector !== undefined && typeof failureInjector !== 'function') {
    throw new TypeError('failureInjector must be a function when supplied.');
  }
  if (typeof now !== 'function') throw new TypeError('Command repository requires an injected now() port.');
  const catalogues = cloneCatalogueRegistry(cataloguesById);
  const committedByLearnerId = cloneSnapshotRegistry(snapshots, catalogues);
  const queues = new Map();

  async function inject(checkpoint, draft) {
    if (!CHECKPOINTS.includes(checkpoint)) throw new TypeError(`Unknown transaction checkpoint: ${checkpoint}.`);
    if (failureInjector) await failureInjector(checkpoint, draft);
  }

  async function attemptTransaction(learnerId, planner) {
    for (let attempt = 1; attempt <= SPELLING_COMMAND_MAX_CONFLICT_ATTEMPTS; attempt += 1) {
      try {
        const stored = committedByLearnerId.get(learnerId);
        if (!stored) throw new TypeError(`Unknown Spelling learner: ${learnerId}.`);
        const catalogue = catalogueForSnapshot(stored, catalogues);
        const fresh = validateSpellingCommandSnapshotV1(clone(stored), catalogue);
        const nowMs = now();
        const todayGuardianDay = canonicalGuardianDay(nowMs);
        const candidatePlan = await planner(clone(fresh), Object.freeze({ nowMs, todayGuardianDay }));
        const plan = validateSpellingCommandPlanV1(candidatePlan, catalogue, fresh, {
          expectedNowMs: nowMs,
        });

        if (!plan.changed) return clone(plan);

        const expectedDraft = expectedCommittedSnapshot(fresh, plan, catalogue);
        const { draft, stages } = stageSnapshot(fresh, plan);
        for (const [checkpoint, applyStage] of stages) {
          applyStage();
          await inject(checkpoint, draft);
        }
        await inject('before-commit', draft);

        const validatedDraft = validateSpellingCommandSnapshotV1(clone(draft), catalogue);
        if (JSON.stringify(validatedDraft) !== JSON.stringify(expectedDraft)) {
          throw new TypeError('The staged Spelling command draft does not match its validated plan.');
        }
        const current = committedByLearnerId.get(learnerId);
        if (!current || current.revision !== plan.expectedRevision) throw conflictError();

        committedByLearnerId.set(learnerId, validatedDraft);
        return clone(plan);
      } catch (error) {
        if (!isConflict(error)) throw error;
        if (attempt === SPELLING_COMMAND_MAX_CONFLICT_ATTEMPTS) throw conflictError();
      }
    }
    throw conflictError();
  }

  function runCommandTransaction(learnerId, planner) {
    if (typeof learnerId !== 'string' || !learnerId) {
      return Promise.reject(new TypeError('runCommandTransaction learnerId must be non-empty.'));
    }
    if (typeof planner !== 'function') {
      return Promise.reject(new TypeError('runCommandTransaction planner must be a function.'));
    }
    const previous = queues.get(learnerId) || Promise.resolve();
    const transaction = previous.catch(() => undefined).then(() => attemptTransaction(learnerId, planner));
    const settled = transaction.then(() => undefined, () => undefined);
    queues.set(learnerId, settled);
    settled.finally(() => {
      if (queues.get(learnerId) === settled) queues.delete(learnerId);
    });
    return transaction;
  }

  return validateSpellingCommandRepository({ runCommandTransaction });
}
