const MESSAGES = Object.freeze({
  ready: 'Ready for a Parent to test the sandbox purchase.',
  purchasing: 'Waiting for the store. You can safely cancel.',
  cancelled: 'Purchase cancelled. Nothing has changed.',
  pending: 'The store says this purchase is pending. Try again later.',
  entitled: 'Purchase verified. The spelling pack is ready to download.',
  downloading: 'Downloading the spelling pack. Installed content stays available.',
  installed: 'The spelling pack is verified and installed.',
  restored: 'Purchase restored. Existing spelling progress is unchanged.',
  revoked: 'Store access was revoked. Local learning history is preserved.',
  failed: 'The store is unavailable. Your installed pack is safe; try again later.',
});

function requireWorkflow(value) {
  const methods = ['start', 'purchase', 'restore', 'redownload'];
  if (
    !value ||
    typeof value !== 'object' ||
    methods.some((method) => typeof value[method] !== 'function')
  ) {
    throw new TypeError('B3 proof workflow is invalid.');
  }
  return value;
}

function freezeState(value) {
  const digests = value.digests;
  if (
    !digests ||
    typeof digests !== 'object' ||
    !/^[a-f0-9]{64}$/.test(digests.manifest) ||
    !/^[a-f0-9]{64}$/.test(digests.archive) ||
    (digests.install !== null && !/^[a-f0-9]{64}$/.test(digests.install))
  ) {
    throw new TypeError('B3 proof digests are invalid.');
  }
  return Object.freeze({
    status: value.status,
    message: MESSAGES[value.status],
    displayPrice: value.displayPrice,
    packReady: value.packReady,
    digests: Object.freeze({
      manifest: digests.manifest,
      archive: digests.archive,
      install: digests.install,
    }),
  });
}

export function createB3ProofController({ workflow }) {
  const proofWorkflow = requireWorkflow(workflow);
  const listeners = new Set();
  let tail = Promise.resolve();
  let disposed = false;
  let disposePromise = null;
  let startPromise = null;
  let state = Object.freeze({
    status: 'ready',
    message: MESSAGES.ready,
    displayPrice: '',
    packReady: false,
    digests: Object.freeze({ manifest: '', archive: '', install: null }),
  });

  function publish(status, values = state) {
    state = freezeState({ ...values, status });
    for (const listener of listeners) listener(state);
    return state;
  }

  function serialise(operation) {
    if (disposed) {
      return Promise.reject(new Error('B3 proof controller is disposed.'));
    }
    const result = tail.then(operation, operation);
    tail = result.catch(() => undefined);
    return result;
  }

  async function start() {
    if (disposed) throw new Error('B3 proof controller is disposed.');
    const snapshot = await proofWorkflow.start();
    return publish(
      snapshot.entitlementState === 'revoked'
        ? 'revoked'
        : snapshot.startupFailed === true
          ? 'failed'
          : 'ready',
      snapshot,
    );
  }

  async function sync() {
    try {
      if (typeof proofWorkflow.sync !== 'function') return state;
      const snapshot = await proofWorkflow.sync();
      const status = snapshot.entitlementState === 'revoked'
        ? 'revoked'
        : snapshot.startupFailed === true
          ? 'failed'
          : snapshot.transactionState === 'pending'
            ? 'pending'
            : snapshot.transactionState === 'complete'
              ? 'entitled'
              : 'ready';
      return publish(status, snapshot);
    } catch {
      return publish('failed');
    }
  }

  async function buy() {
    publish('purchasing');
    try {
      const result = await proofWorkflow.purchase();
      if (result.state === 'revoked') {
        return publish('revoked', { ...state, packReady: false });
      }
      if (result.state === 'cancelled') return publish('cancelled');
      if (result.state === 'pending') return publish('pending');
      if (result.state === 'complete') {
        publish('entitled');
        publish('downloading');
        const installed = await proofWorkflow.install();
        if (installed.state !== 'installed' || installed.packReady !== true) {
          throw new TypeError('B3 install outcome is invalid.');
        }
        return publish('installed', {
          ...state,
          packReady: true,
          digests: Object.freeze({
            ...state.digests,
            install: installed.installDigest,
          }),
        });
      }
      throw new TypeError('B3 purchase outcome is invalid.');
    } catch {
      return publish('failed');
    }
  }

  async function restore() {
    try {
      const result = await proofWorkflow.restore();
      if (result.state === 'revoked') {
        return publish('revoked', { ...state, packReady: false });
      }
      if (result.state === 'pending' || result.state === 'cancelled') {
        return publish(result.state);
      }
      if (result.state !== 'restored') throw new TypeError('B3 restore outcome is invalid.');
      return publish('restored', {
        ...state,
        packReady: result.packReady === true || state.packReady,
      });
    } catch {
      return publish('failed');
    }
  }

  async function redownload() {
    publish('downloading');
    try {
      const result = await proofWorkflow.redownload();
      if (result.state !== 'installed' || result.packReady !== true) {
        throw new TypeError('B3 redownload outcome is invalid.');
      }
      return publish('installed', {
        ...state,
        packReady: true,
        digests: Object.freeze({
          ...state.digests,
          install: result.installDigest,
        }),
      });
    } catch {
      return publish('failed');
    }
  }

  function ensureStarted() {
    if (!startPromise) startPromise = serialise(start);
    return startPromise;
  }

  function afterStart(operation) {
    return ensureStarted().then(() => serialise(operation));
  }

  return Object.freeze({
    start: ensureStarted,
    buy: () => afterStart(buy),
    restore: () => afterStart(restore),
    redownload: () => afterStart(redownload),
    sync: () => afterStart(sync),
    getState() {
      return state;
    },
    subscribe(listener) {
      if (typeof listener !== 'function') {
        throw new TypeError('B3 proof listener must be a function.');
      }
      if (disposed) throw new Error('B3 proof controller is disposed.');
      listeners.add(listener);
      let removed = false;
      return Object.freeze({
        remove() {
          if (removed) return;
          removed = true;
          listeners.delete(listener);
        },
      });
    },
    dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      listeners.clear();
      disposePromise = (async () => {
        await tail;
        if (typeof proofWorkflow.dispose === 'function') {
          await proofWorkflow.dispose();
        }
      })();
      return disposePromise;
    },
  });
}
