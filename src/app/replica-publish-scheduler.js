import { markB4 } from './b4-performance-marks.js';

export function createReplicaPublishScheduler({ publishLearner, lifecycle } = {}) {
  if (typeof publishLearner !== 'function') {
    throw new TypeError('Replica publish scheduler requires publishLearner().');
  }
  if (
    lifecycle !== undefined &&
    (typeof lifecycle?.onPause !== 'function' || typeof lifecycle?.onResume !== 'function')
  ) {
    throw new TypeError('Replica publish scheduler lifecycle requires pause and resume.');
  }
  const entries = new Map();
  let lastError = null;
  let paused = lifecycle?.getState?.().canonicalState === 'paused';
  let disposed = false;
  let disposePromise = null;

  function start(learnerId, entry) {
    entry.pending = false;
    entry.inFlight = true;
    entry.promise = Promise.resolve()
      .then(() => publishLearner(learnerId))
      .then(() => markB4('product:replica-publish-complete'))
      .catch((error) => {
        lastError = Object.freeze({
          message: typeof error?.message === 'string' ? error.message : String(error),
          code: typeof error?.code === 'string' ? error.code : null,
        });
      })
      .finally(() => {
        entry.inFlight = false;
        if (entry.pending && !paused) {
          start(learnerId, entry);
        } else if (!entry.pending) {
          entries.delete(learnerId);
        }
      });
  }

  function schedule(learnerId) {
    if (disposed) return;
    const existing = entries.get(learnerId);
    if (existing) {
      existing.pending = true;
      return;
    }
    const entry = { inFlight: false, pending: paused, promise: null };
    entries.set(learnerId, entry);
    if (!paused) start(learnerId, entry);
  }

  const lifecycleHandles = lifecycle ? [
    lifecycle.onPause(() => {
      if (disposed) return;
      paused = true;
    }),
    lifecycle.onResume(() => {
      if (disposed) return;
      paused = false;
      for (const [learnerId, entry] of entries) {
        if (!entry.inFlight && entry.pending) start(learnerId, entry);
      }
    }),
  ] : [];

  return Object.freeze({
    schedule,
    getDiagnosticState() {
      return Object.freeze({
        lastError,
        pendingLearnerIds: Object.freeze(
          [...entries].filter(([, entry]) => entry.pending).map(([learnerId]) => learnerId),
        ),
        inFlightLearnerIds: Object.freeze(
          [...entries].filter(([, entry]) => entry.inFlight).map(([learnerId]) => learnerId),
        ),
      });
    },
    dispose() {
      disposePromise ??= (async () => {
        disposed = true;
        await Promise.all(lifecycleHandles.map((handle) => handle.remove()));
        paused = false;
        for (const [learnerId, entry] of entries) {
          if (!entry.inFlight && entry.pending) start(learnerId, entry);
        }
        while (entries.size > 0) {
          await Promise.all(
            [...entries.values()].map((entry) => entry.promise).filter(Boolean),
          );
        }
      })();
      return disposePromise;
    },
  });
}
