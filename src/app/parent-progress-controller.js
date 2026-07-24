import {
  projectParentSpellingProgress,
  validateCatalogueV1,
} from '../domain/spelling/index.js';

function requireMethod(value, method, label) {
  if (!value || typeof value !== 'object' || typeof value[method] !== 'function') {
    throw new TypeError(`${label}.${method} must be a function.`);
  }
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function freezeState(status, learners, actionError) {
  return Object.freeze({
    status,
    learners: freezeDeep(structuredClone(learners)),
    actionError,
  });
}

export function createParentProgressController({
  profileRepository,
  snapshotStore,
  catalogue: candidateCatalogue,
  now,
} = {}) {
  requireMethod(profileRepository, 'listProfiles', 'profileRepository');
  requireMethod(snapshotStore, 'read', 'snapshotStore');
  const catalogue = validateCatalogueV1(candidateCatalogue);
  if (typeof now !== 'function') {
    throw new TypeError('Parent progress requires an injected now() clock.');
  }

  let state = freezeState('checking', [], null);
  let queue = Promise.resolve();
  let disposed = false;
  const listeners = new Set();

  function publish(next) {
    state = next;
    for (const listener of listeners) listener(state);
  }

  function refresh() {
    if (disposed) {
      return Promise.reject(new Error('parent_progress_controller_disposed'));
    }
    const operation = queue.then(async () => {
      publish(freezeState('checking', state.learners, null));
      try {
        const profiles = await profileRepository.listProfiles();
        if (!Array.isArray(profiles)) {
          throw new TypeError('Parent progress profiles are invalid.');
        }
        const learnerSnapshots = [];
        for (const profile of profiles) {
          if (typeof profile?.learnerId !== 'string') {
            throw new TypeError('Parent progress learner identity is invalid.');
          }
          learnerSnapshots.push(await snapshotStore.read(profile.learnerId));
        }
        const completedSessions = learnerSnapshots
          .map(({ practiceSession }) => practiceSession)
          .filter((session) => session?.status === 'completed');
        const learners = projectParentSpellingProgress({
          profiles,
          learnerSnapshots,
          completedSessions,
          contentSnapshots: [catalogue],
          now,
        });
        publish(freezeState('ready', learners, null));
        return state;
      } catch (error) {
        publish(freezeState(
          'unavailable',
          state.learners,
          'parent_progress_unavailable',
        ));
        throw error;
      }
    });
    queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  return Object.freeze({
    getState() {
      return state;
    },
    subscribe(listener) {
      if (typeof listener !== 'function') {
        throw new TypeError('Parent progress listener must be a function.');
      }
      if (disposed) throw new Error('parent_progress_controller_disposed');
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
    refresh,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await queue;
      listeners.clear();
    },
  });
}
