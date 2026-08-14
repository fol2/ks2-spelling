const ENTITLEMENT_STATES = Object.freeze(['none', 'active', 'revoked']);
const PACK_STATES = Object.freeze([
  'missing',
  'queued',
  'downloading',
  'installed',
  'failed',
  'locked',
]);
const ACTIONS = Object.freeze([
  'purchase',
  'restore',
  'download',
  'recover',
]);

// What, if anything, the Parent card's download button does in this state —
// and the label that says so. A purchase leaves every shard job queued and an
// interrupted install leaves them downloading; nothing else in the app can
// start or resume a download, so both states must stay actionable or a paying
// family is stranded with no way to get the content they bought.
export function downloadActionLabel(state) {
  if (state?.entitlementState !== 'active') return null;
  if (state.packState === 'failed') return 'Retry download';
  if (state.packState === 'downloading') return 'Resume download';
  if (state.packState === 'missing' || state.packState === 'queued') {
    return 'Download pack';
  }
  return null;
}

function requireMethod(value, method, label) {
  if (!value || typeof value !== 'object' || typeof value[method] !== 'function') {
    throw new TypeError(`${label}.${method} must be a function.`);
  }
}

function validateSnapshot(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.displayPrice !== 'string' ||
    !ENTITLEMENT_STATES.includes(value.entitlementState) ||
    !PACK_STATES.includes(value.packState) ||
    typeof value.syncFailed !== 'boolean'
  ) {
    throw new TypeError('Parent commerce snapshot is invalid.');
  }
  return value;
}

function freezeState({
  status,
  displayPrice,
  entitlementState,
  packState,
  action = null,
  actionError = null,
  downloadProgress = null,
}) {
  return Object.freeze({
    status,
    displayPrice,
    entitlementState,
    packState,
    action,
    actionError,
    downloadProgress,
  });
}

export function createParentCommerceController({ workflow } = {}) {
  for (const method of [
    'start',
    'refresh',
    'purchase',
    'restore',
    'download',
    'recover',
    'dispose',
  ]) {
    requireMethod(workflow, method, 'workflow');
  }

  let state = freezeState({
    status: 'checking',
    displayPrice: '',
    entitlementState: 'none',
    packState: 'missing',
  });
  let queue = Promise.resolve();
  let disposed = false;
  const listeners = new Set();

  function publish(next) {
    state = next;
    for (const listener of listeners) listener(state);
  }

  function publishSnapshot(snapshot) {
    const value = validateSnapshot(snapshot);
    publish(freezeState({
      status: value.syncFailed ? 'offline' : 'ready',
      displayPrice: value.displayPrice,
      entitlementState: value.entitlementState,
      packState: value.packState,
    }));
    return state;
  }

  // Live per-shard progress, published between the 'working' state and the
  // snapshot the action resolves into. It is deliberately not part of the
  // workflow snapshot: nothing durable records it, so every settled state
  // clears it back to null.
  function publishDownloadProgress(progress) {
    publish(freezeState({
      ...state,
      downloadProgress: Object.freeze({
        completedShards: progress.completedShards,
        totalShards: progress.totalShards,
      }),
    }));
  }

  function run(method, action = null, onProgress = undefined) {
    if (disposed) {
      return Promise.reject(new Error('parent_commerce_controller_disposed'));
    }
    if (action !== null && !ACTIONS.includes(action)) {
      return Promise.reject(new TypeError('Parent commerce action is invalid.'));
    }
    const operation = queue.then(async () => {
      publish(freezeState({
        ...state,
        status: action === null ? 'checking' : 'working',
        action,
        actionError: null,
      }));
      try {
        return publishSnapshot(await workflow[method](onProgress));
      } catch (error) {
        publish(freezeState({
          ...state,
          status: 'failed',
          action: null,
          actionError: 'parent_commerce_action_failed',
          downloadProgress: null,
        }));
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
        throw new TypeError('Parent commerce listener must be a function.');
      }
      if (disposed) throw new Error('parent_commerce_controller_disposed');
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
    start: () => run('start'),
    refresh: () => run('refresh'),
    purchase: () => run('purchase', 'purchase'),
    restore: () => run('restore', 'restore'),
    download: () => run('download', 'download', publishDownloadProgress),
    recover: () => run('recover', 'recover'),
    async dispose() {
      if (disposed) return;
      disposed = true;
      await queue;
      listeners.clear();
      await workflow.dispose();
    },
  });
}
