const STARTER_PACK_ID = 'ks2-core';

function requireMethod(value, method, label) {
  if (!value || typeof value !== 'object' || typeof value[method] !== 'function') {
    throw new TypeError(`${label}.${method} must be a function.`);
  }
}

function freezeState(status, activeVersion, actionError) {
  return Object.freeze({ status, activeVersion, actionError });
}

function sameInstalledAuthority(active, installed, native) {
  return (
    active.packId === STARTER_PACK_ID &&
    installed.packId === active.packId &&
    installed.version === active.version &&
    installed.state === 'ready' &&
    installed.manifestSha256 === active.manifestSha256 &&
    installed.pathToken === active.pathToken &&
    native.packId === active.packId &&
    native.version === active.version &&
    native.manifestSha256 === active.manifestSha256 &&
    native.installedPathToken === active.pathToken &&
    native.activationMarkerSha256 === installed.activationMarkerSha256
  );
}

export function createStarterPackAvailabilityController({
  packRepository,
  packTransfer,
} = {}) {
  for (const method of ['getActiveVersion', 'listInstalledVersions']) {
    requireMethod(packRepository, method, 'packRepository');
  }
  requireMethod(packTransfer, 'inventoryInstalledVersions', 'packTransfer');

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
        const [active, installedRows, inventory] = await Promise.all([
          packRepository.getActiveVersion({ packId: STARTER_PACK_ID }),
          packRepository.listInstalledVersions({ packId: STARTER_PACK_ID }),
          packTransfer.inventoryInstalledVersions(),
        ]);
        if (active === null) {
          publish('missing');
          return state;
        }
        const activeVersion = active.version;
        const installedMatches = installedRows.filter(
          (record) => record.version === activeVersion,
        );
        const nativeMatches = inventory.filter(
          (record) =>
            record.packId === STARTER_PACK_ID &&
            record.version === activeVersion,
        );
        const ready =
          installedMatches.length === 1 &&
          nativeMatches.length === 1 &&
          sameInstalledAuthority(active, installedMatches[0], nativeMatches[0]);
        publish(ready ? 'ready' : 'corrupt', activeVersion);
        return state;
      } catch (error) {
        publish('unavailable', null, 'starter_audio_check_failed');
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
      publish('corrupt', state.activeVersion);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await queue;
      listeners.clear();
    },
  });
}
