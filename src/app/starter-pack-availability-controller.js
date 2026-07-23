function requireMethod(value, method, label) {
  if (!value || typeof value !== 'object' || typeof value[method] !== 'function') {
    throw new TypeError(`${label}.${method} must be a function.`);
  }
}

const SAFE_VERSION = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

function freezeState(status, activeVersion, actionError) {
  return Object.freeze({ status, activeVersion, actionError });
}

export function createStarterPackAvailabilityController({
  audioSource,
} = {}) {
  requireMethod(audioSource, 'checkAvailability', 'audioSource');

  let state = freezeState('checking', null, null);
  let disposed = false;
  let queue = Promise.resolve();
  const listeners = new Set();

  function publish(status, activeVersion = null, actionError = null) {
    state = freezeState(status, activeVersion, actionError);
    for (const listener of listeners) listener(state);
  }

  function refresh() {
    if (disposed) {
      return Promise.reject(new Error('starter_pack_availability_controller_disposed'));
    }
    const operation = queue.then(async () => {
      publish('checking', state.activeVersion);
      try {
        const result = await audioSource.checkAvailability();
        if (
          !result ||
          typeof result !== 'object' ||
          Array.isArray(result) ||
          Reflect.ownKeys(result).length !== 1 ||
          !SAFE_VERSION.test(result.version)
        ) {
          throw new TypeError('Starter audio availability result is invalid.');
        }
        publish('ready', result.version);
        return state;
      } catch (error) {
        publish(
          'unavailable',
          state.activeVersion,
          'starter_audio_check_failed',
        );
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
        throw new TypeError('Starter pack availability listener must be a function.');
      }
      if (disposed) throw new Error('starter_pack_availability_controller_disposed');
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
    recover: refresh,
    reportPlaybackFailure() {
      if (disposed) throw new Error('starter_pack_availability_controller_disposed');
      publish(
        'corrupt',
        state.activeVersion,
        'starter_audio_playback_failed',
      );
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await queue;
      listeners.clear();
    },
  });
}
