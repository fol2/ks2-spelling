import { App as DefaultApp } from '@capacitor/app';
import { Capacitor as DefaultCapacitor } from '@capacitor/core';

import { assertAppLifecycle } from './app-lifecycle-contract.js';

function lifecycleError(code, options) {
  const error = new Error(code, options);
  error.code = code;
  return error;
}

function requireListener(listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('Lifecycle listener must be a function.');
  }
  return listener;
}

function subscriberHandle(listeners, listener, isDisposed) {
  requireListener(listener);
  if (isDisposed()) return Object.freeze({ async remove() {} });
  listeners.add(listener);
  let removed = false;
  return Object.freeze({
    async remove() {
      if (removed) return;
      removed = true;
      listeners.delete(listener);
    },
  });
}

export function createCapacitorAppLifecycle(options = {}) {
  const { App = DefaultApp, Capacitor = DefaultCapacitor } = options;
  if (Capacitor.isNativePlatform() !== true) {
    throw lifecycleError('native_lifecycle_required');
  }

  const pauseListeners = new Set();
  const resumeListeners = new Set();
  const stateChangeListeners = new Set();
  const diagnosticStateChanges = [];
  let canonicalState = 'unknown';
  let disposed = false;
  let disposePromise;

  const nativeHandles = [
    App.addListener('pause', () => {
      if (disposed) return;
      canonicalState = 'paused';
      for (const listener of Array.from(pauseListeners)) listener();
    }),
    App.addListener('resume', () => {
      if (disposed) return;
      canonicalState = 'active';
      for (const listener of Array.from(resumeListeners)) listener();
    }),
    App.addListener('appStateChange', (event) => {
      if (disposed) return;
      const isActive = event?.isActive;
      if (typeof isActive !== 'boolean') return;
      diagnosticStateChanges.push(isActive);
      const diagnostic = Object.freeze({ isActive });
      for (const listener of Array.from(stateChangeListeners)) listener(diagnostic);
    }),
  ];

  return assertAppLifecycle(
    Object.freeze({
      onPause(listener) {
        return subscriberHandle(pauseListeners, listener, () => disposed);
      },
      onResume(listener) {
        return subscriberHandle(resumeListeners, listener, () => disposed);
      },
      onStateChange(listener) {
        return subscriberHandle(stateChangeListeners, listener, () => disposed);
      },
      getState() {
        return Object.freeze({
          canonicalState,
          diagnosticStateChanges: Object.freeze([...diagnosticStateChanges]),
        });
      },
      async dispose() {
        if (disposePromise) return disposePromise;
        disposed = true;
        pauseListeners.clear();
        resumeListeners.clear();
        stateChangeListeners.clear();
        disposePromise = Promise.all(
          nativeHandles.map(async (handlePromise) => {
            const handle = await handlePromise;
            if (!handle || typeof handle.remove !== 'function') {
              throw lifecycleError('native_lifecycle_handle_invalid');
            }
            await handle.remove();
          }),
        ).then(() => undefined);
        return disposePromise;
      },
    }),
  );
}
