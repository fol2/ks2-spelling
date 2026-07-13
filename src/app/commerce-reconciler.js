function validateDependencies(value) {
  const storeDescriptor = value && typeof value === 'object'
    ? Object.getOwnPropertyDescriptor(value, 'store')
    : null;
  const coordinatorDescriptor = value && typeof value === 'object'
    ? Object.getOwnPropertyDescriptor(value, 'coordinator')
    : null;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== 2 ||
    !Object.hasOwn(value, 'store') ||
    !Object.hasOwn(value, 'coordinator') ||
    !storeDescriptor?.enumerable ||
    !Object.hasOwn(storeDescriptor, 'value') ||
    !coordinatorDescriptor?.enumerable ||
    !Object.hasOwn(coordinatorDescriptor, 'value') ||
    typeof value.store?.subscribeTransactionUpdates !== 'function' ||
    typeof value.coordinator?.handleObservation !== 'function' ||
    typeof value.coordinator?.recover !== 'function'
  ) {
    throw new TypeError('Commerce reconciler dependencies are invalid.');
  }
  return value;
}

export function createCommerceReconciler(rawDependencies) {
  const { store, coordinator } = validateDependencies(rawDependencies);
  let queue = Promise.resolve();
  let listenerHandle = null;
  let subscriptionPromise = null;
  let startPromise = null;
  let recoveryPromise = null;
  let disposePromise = null;
  let disposed = false;

  function enqueue(operation, suppressFailure = false) {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    if (suppressFailure) result.catch(() => {});
    return result;
  }

  function listener(observation) {
    if (disposed) return;
    enqueue(() => coordinator.handleObservation(observation), true);
  }

  async function ensureSubscription() {
    if (listenerHandle) return listenerHandle;
    if (subscriptionPromise) return subscriptionPromise;
    if (disposed) throw new Error('Commerce reconciler is disposed.');
    subscriptionPromise = (async () => {
      const handle = await store.subscribeTransactionUpdates(listener);
      if (!handle || typeof handle.remove !== 'function') {
        throw new TypeError('Store subscription handle is invalid.');
      }
      if (disposed) {
        await handle.remove();
        return null;
      }
      listenerHandle = handle;
      return handle;
    })();
    try {
      return await subscriptionPromise;
    } finally {
      subscriptionPromise = null;
    }
  }

  function reconcile() {
    if (recoveryPromise) return recoveryPromise;
    recoveryPromise = enqueue(() => coordinator.recover());
    recoveryPromise.finally(() => {
      recoveryPromise = null;
    }).catch(() => {});
    return recoveryPromise;
  }

  async function start() {
    if (arguments.length !== 0) throw new TypeError('start does not accept input.');
    if (disposed) throw new Error('Commerce reconciler is disposed.');
    if (startPromise) return startPromise;
    startPromise = (async () => {
      await ensureSubscription();
      if (disposed) return;
      return reconcile();
    })();
    try {
      return await startPromise;
    } finally {
      startPromise = null;
    }
  }

  async function resume() {
    if (arguments.length !== 0) throw new TypeError('resume does not accept input.');
    if (disposed) throw new Error('Commerce reconciler is disposed.');
    await ensureSubscription();
    if (disposed) throw new Error('Commerce reconciler is disposed.');
    return reconcile();
  }

  async function dispose() {
    if (arguments.length !== 0) throw new TypeError('dispose does not accept input.');
    if (disposePromise) return disposePromise;
    disposed = true;
    disposePromise = (async () => {
      await subscriptionPromise?.catch(() => {});
      await startPromise?.catch(() => {});
      await queue;
      const handle = listenerHandle;
      listenerHandle = null;
      if (handle) await handle.remove();
    })();
    return disposePromise;
  }

  return Object.freeze({ start, resume, dispose });
}
