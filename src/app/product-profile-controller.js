const PROFILE_DRAFT_KEYS = Object.freeze([
  'nickname',
  'yearGroup',
  'goal',
  'colour',
]);
const EDIT_DRAFT_KEYS = Object.freeze(['learnerId', ...PROFILE_DRAFT_KEYS]);

function requireMethod(value, method, label) {
  if (!value || typeof value !== 'object' || typeof value[method] !== 'function') {
    throw new TypeError(`${label}.${method} must be a function.`);
  }
}

function requireExactDraft(value, keys, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new TypeError(`${label} has an invalid shape.`);
  }
  return value;
}

function freezeProfiles(profiles) {
  if (!Array.isArray(profiles)) throw new TypeError('profiles must be an array.');
  return Object.freeze(
    profiles.map((profile) => Object.freeze(structuredClone(profile))),
  );
}

function freezeState({ status, profiles, selectedLearnerId, actionError }) {
  return Object.freeze({
    status,
    profiles: freezeProfiles(profiles),
    selectedLearnerId,
    actionError,
  });
}

export function createProductProfileController({
  profiles,
  selection,
  initialProfiles,
  initialSelectedLearnerId,
  createLearnerId,
} = {}) {
  for (const method of [
    'listProfiles',
    'readProfile',
    'writeProfile',
    'removeProfile',
  ]) {
    requireMethod(profiles, method, 'profiles');
  }
  for (const method of ['readSelectedLearnerId', 'selectLearner']) {
    requireMethod(selection, method, 'selection');
  }
  if (typeof createLearnerId !== 'function') {
    throw new TypeError('createLearnerId must be a function.');
  }
  let state = freezeState({
    status: 'ready',
    profiles: initialProfiles,
    selectedLearnerId: initialSelectedLearnerId,
    actionError: null,
  });
  let disposed = false;
  let queue = Promise.resolve();
  const listeners = new Set();

  function publish(next) {
    state = freezeState(next);
    for (const listener of listeners) listener(state);
  }

  async function refresh() {
    const [nextProfiles, selectedLearnerId] = await Promise.all([
      profiles.listProfiles(),
      selection.readSelectedLearnerId(),
    ]);
    publish({
      status: 'ready',
      profiles: nextProfiles,
      selectedLearnerId,
      actionError: null,
    });
  }

  function run(action) {
    if (disposed) return Promise.reject(new Error('product_profile_controller_disposed'));
    const operation = queue.then(async () => {
      publish({ ...state, status: 'saving', actionError: null });
      try {
        const value = await action();
        await refresh();
        return value;
      } catch (error) {
        publish({
          ...state,
          status: 'ready',
          actionError: 'profile_action_failed',
        });
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
        throw new TypeError('Profile listener must be a function.');
      }
      if (disposed) throw new Error('product_profile_controller_disposed');
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
    createProfile(draft) {
      requireExactDraft(draft, PROFILE_DRAFT_KEYS, 'Profile draft');
      return run(async () => {
        const learnerId = createLearnerId();
        if (await profiles.readProfile(learnerId)) {
          throw new Error('product_profile_id_collision');
        }
        return profiles.writeProfile({
          learnerId,
          nickname: draft.nickname,
          yearGroup: draft.yearGroup,
          goal: draft.goal,
          colour: draft.colour,
          createdAt: 0,
          updatedAt: 0,
        });
      });
    },
    editProfile(draft) {
      requireExactDraft(draft, EDIT_DRAFT_KEYS, 'Profile edit');
      return run(() => profiles.writeProfile({
        learnerId: draft.learnerId,
        nickname: draft.nickname,
        yearGroup: draft.yearGroup,
        goal: draft.goal,
        colour: draft.colour,
        createdAt: 0,
        updatedAt: 0,
      }));
    },
    selectProfile(learnerId) {
      return run(() => selection.selectLearner(learnerId));
    },
    removeProfile(learnerId) {
      return run(() => profiles.removeProfile(learnerId));
    },
    reload() {
      return run(async () => undefined);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await queue;
      listeners.clear();
    },
  });
}
