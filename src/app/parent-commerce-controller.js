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
}) {
  return Object.freeze({
    status,
    displayPrice,
    entitlementState,
    packState,
    action,
    actionError,
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

  function run(method, action = null) {
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
        return publishSnapshot(await workflow[method]());
      } catch (error) {
        publish(freezeState({
          ...state,
          status: 'failed',
          action: null,
          actionError: 'parent_commerce_action_failed',
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
    download: () => run('download', 'download'),
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
