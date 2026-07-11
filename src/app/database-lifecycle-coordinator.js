import { assertSqlConnection } from '../platform/database/sql-connection-contract.js';
import { assertAppLifecycle } from '../platform/lifecycle/app-lifecycle-contract.js';

const COORDINATOR_STATES = new Set([
  'starting',
  'active',
  'pausing',
  'paused',
  'resuming',
  'failed',
  'disposed',
]);

function requireFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function.`);
  return value;
}

function requireCommandGate(value) {
  const methods = ['run', 'pauseAndDrain', 'resume', 'isAccepting', 'waitForIdle'];
  if (!value || typeof value !== 'object') {
    throw new TypeError('commandGate must be an object.');
  }
  for (const method of methods) requireFunction(value[method], `commandGate.${method}`);
  return value;
}

function failureDiagnostic(error) {
  return Object.freeze({
    code: typeof error?.code === 'string' ? error.code : null,
    message:
      typeof error?.message === 'string' ? error.message : 'unknown_lifecycle_failure',
  });
}

async function removeSubscription(handle) {
  const resolved = await handle;
  if (!resolved || typeof resolved.remove !== 'function') {
    throw new TypeError('Lifecycle subscription must expose remove().');
  }
  await resolved.remove();
}

export function createDatabaseLifecycleCoordinator(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Database lifecycle options must be an object.');
  }
  const lifecycle = assertAppLifecycle(options.lifecycle);
  const commandGate = requireCommandGate(options.commandGate);
  const createConnection = requireFunction(
    options.createConnection,
    'createConnection',
  );
  const migrate = requireFunction(options.migrate, 'migrate');
  const rehydrateSelectedLearner = requireFunction(
    options.rehydrateSelectedLearner,
    'rehydrateSelectedLearner',
  );
  if (
    typeof options.selectedLearnerId !== 'string' ||
    options.selectedLearnerId.length === 0
  ) {
    throw new TypeError('selectedLearnerId must be a non-empty string.');
  }
  const selectedLearnerId = options.selectedLearnerId;

  let state = 'starting';
  let connection = null;
  let desiredMode = null;
  let processingPromise = null;
  let startPromise = null;
  let disposePromise = null;
  let disposedRequested = false;
  let subscriptions = [];
  const failures = [];
  const diagnosticStateChanges = [];

  function setState(nextState) {
    if (!COORDINATOR_STATES.has(nextState)) {
      throw new Error('invalid_database_lifecycle_state');
    }
    state = nextState;
  }

  function recordFailure(error) {
    failures.push(failureDiagnostic(error));
    setState('failed');
  }

  async function closeCurrentConnection({ checkpoint }) {
    if (connection === null) return;
    const closing = connection;
    if (checkpoint) {
      await closing.query('PRAGMA wal_checkpoint(PASSIVE)');
    }
    try {
      await closing.close();
    } finally {
      connection = null;
    }
  }

  async function transitionToPaused() {
    if (state === 'paused' || connection === null) {
      await commandGate.pauseAndDrain();
      setState('paused');
      return;
    }
    setState('pausing');
    await commandGate.pauseAndDrain();
    await closeCurrentConnection({ checkpoint: true });
    setState('paused');
  }

  async function discardIncompleteConnection(candidate, primaryError) {
    if (candidate === null) return;
    try {
      await candidate.close();
    } catch (closeError) {
      if (primaryError.cause === undefined) primaryError.cause = closeError;
    } finally {
      if (connection === candidate) connection = null;
    }
  }

  async function transitionToActive() {
    if (state === 'active' && connection !== null) return;
    setState(state === 'starting' ? 'starting' : 'resuming');
    await commandGate.pauseAndDrain();

    if (connection !== null) {
      await closeCurrentConnection({ checkpoint: false });
    }

    let candidate = null;
    try {
      candidate = assertSqlConnection(await createConnection());
      connection = candidate;
      await candidate.open();
      await migrate(candidate);
      await rehydrateSelectedLearner(candidate, selectedLearnerId);
      if (disposedRequested) return;
      commandGate.resume();
      setState('active');
    } catch (error) {
      await discardIncompleteConnection(candidate, error);
      throw error;
    }
  }

  async function processDesiredModes() {
    while (desiredMode !== null && !disposedRequested) {
      const target = desiredMode;
      desiredMode = null;
      try {
        if (target === 'paused') await transitionToPaused();
        else await transitionToActive();
      } catch (error) {
        desiredMode = null;
        await commandGate.pauseAndDrain();
        recordFailure(error);
        throw error;
      }
    }
  }

  function beginProcessing() {
    const running = processDesiredModes();
    processingPromise = running;
    void running.then(
      () => {
        if (processingPromise === running) processingPromise = null;
        if (desiredMode !== null && !disposedRequested) beginProcessing();
      },
      () => {
        if (processingPromise === running) processingPromise = null;
        if (desiredMode !== null && !disposedRequested) beginProcessing();
      },
    );
    return running;
  }

  function requestMode(mode) {
    if (disposedRequested || state === 'disposed') return Promise.resolve();
    if (
      (mode === 'active' && state === 'active' && connection !== null) ||
      (mode === 'paused' && state === 'paused')
    ) {
      return processingPromise ?? Promise.resolve();
    }
    desiredMode = mode;
    return processingPromise ?? beginProcessing();
  }

  function installListeners() {
    subscriptions = [
      lifecycle.onPause(() => {
        void requestMode('paused').catch(() => undefined);
      }),
      lifecycle.onResume(() => {
        void requestMode('active').catch(() => undefined);
      }),
      lifecycle.onStateChange((event) => {
        if (disposedRequested) return;
        if (typeof event?.isActive === 'boolean') {
          diagnosticStateChanges.push(event.isActive);
        }
      }),
    ];
  }

  return Object.freeze({
    async start() {
      if (state === 'disposed' || disposedRequested) {
        throw new Error('database_lifecycle_disposed');
      }
      if (startPromise) return startPromise;
      startPromise = (async () => {
        await commandGate.pauseAndDrain();
        installListeners();
        await requestMode('active');
      })();
      return startPromise;
    },
    async dispose() {
      if (disposePromise) return disposePromise;
      disposedRequested = true;
      desiredMode = null;
      disposePromise = (async () => {
        const handles = subscriptions;
        subscriptions = [];
        await Promise.all(handles.map(removeSubscription));
        if (processingPromise) {
          try {
            await processingPromise;
          } catch {
            // The failure is retained in diagnostics; disposal still owns cleanup.
          }
        }
        await commandGate.pauseAndDrain();
        if (connection !== null) {
          const closing = connection;
          try {
            try {
              await closing.query('PRAGMA wal_checkpoint(PASSIVE)');
            } catch (error) {
              failures.push(failureDiagnostic(error));
            }
            await closing.close();
          } catch (error) {
            failures.push(failureDiagnostic(error));
          } finally {
            connection = null;
          }
        }
        setState('disposed');
      })();
      return disposePromise;
    },
    getDiagnosticState() {
      return Object.freeze({
        state,
        failures: Object.freeze(
          failures.map((failure) => Object.freeze({ ...failure })),
        ),
        lifecycleStateChanges: Object.freeze([...diagnosticStateChanges]),
      });
    },
  });
}
