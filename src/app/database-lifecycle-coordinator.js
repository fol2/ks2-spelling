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
  const hasStaticSelection = Object.hasOwn(options, 'selectedLearnerId');
  const hasSelectionResolver = Object.hasOwn(options, 'resolveSelectedLearnerId');
  if (hasStaticSelection === hasSelectionResolver) {
    throw new TypeError(
      'Provide exactly one selectedLearnerId or resolveSelectedLearnerId.',
    );
  }
  let resolveSelectedLearnerId;
  if (hasStaticSelection) {
    if (
      typeof options.selectedLearnerId !== 'string' ||
      options.selectedLearnerId.length === 0
    ) {
      throw new TypeError('selectedLearnerId must be a non-empty string.');
    }
    const selectedLearnerId = options.selectedLearnerId;
    resolveSelectedLearnerId = async () => selectedLearnerId;
  } else {
    resolveSelectedLearnerId = requireFunction(
      options.resolveSelectedLearnerId,
      'resolveSelectedLearnerId',
    );
  }

  let state = 'starting';
  let connection = null;
  let connectionOpened = false;
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
    if (checkpoint && connectionOpened) {
      await closing.query('PRAGMA wal_checkpoint(PASSIVE)');
    }
    await closing.close();
    if (connection === closing) {
      connection = null;
      connectionOpened = false;
    }
  }

  async function transitionToPaused() {
    if (state === 'failed') {
      await commandGate.pauseAndDrain();
      return;
    }
    if (state === 'paused' || connection === null) {
      await commandGate.pauseAndDrain();
      if (disposedRequested) return;
      setState('paused');
      return;
    }
    setState('pausing');
    await commandGate.pauseAndDrain();
    if (disposedRequested) return;
    await closeCurrentConnection({ checkpoint: true });
    if (disposedRequested) return;
    setState('paused');
  }

  async function discardIncompleteConnection(candidate, primaryError) {
    if (candidate === null) return;
    try {
      await candidate.close();
    } catch (closeError) {
      if (primaryError.cause === undefined) primaryError.cause = closeError;
      return;
    }
    if (connection === candidate) {
      connection = null;
      connectionOpened = false;
    }
  }

  async function transitionToActive() {
    if (state === 'active' && connection !== null) return;
    setState(state === 'starting' ? 'starting' : 'resuming');
    await commandGate.pauseAndDrain();
    if (disposedRequested) return;

    if (connection !== null) {
      await closeCurrentConnection({ checkpoint: false });
      if (disposedRequested) return;
    }

    let candidate = null;
    try {
      candidate = assertSqlConnection(await createConnection());
      connection = candidate;
      connectionOpened = false;
      if (disposedRequested) return;
      await candidate.open();
      connectionOpened = true;
      if (disposedRequested) return;
      await migrate(candidate);
      if (disposedRequested) return;
      const selectedLearnerId = await resolveSelectedLearnerId(candidate);
      if (
        selectedLearnerId !== null &&
        (
          typeof selectedLearnerId !== 'string' ||
          selectedLearnerId.length === 0
        )
      ) {
        throw new TypeError(
          'resolveSelectedLearnerId must return null or a non-empty string.',
        );
      }
      if (selectedLearnerId !== null) {
        await rehydrateSelectedLearner(candidate, selectedLearnerId);
      }
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
    if (mode === 'paused' && state === 'failed') {
      return processingPromise ?? Promise.resolve();
    }
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
        if (disposedRequested) return;
        installListeners();
        if (disposedRequested) return;
        await requestMode('active');
      })();
      return startPromise;
    },
    async dispose() {
      if (state === 'disposed') return;
      if (disposePromise) return disposePromise;
      disposedRequested = true;
      desiredMode = null;
      const running = (async () => {
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
            if (connectionOpened) {
              await closing.query('PRAGMA wal_checkpoint(PASSIVE)');
            }
          } catch (error) {
            failures.push(failureDiagnostic(error));
          }
          try {
            await closing.close();
          } catch (error) {
            recordFailure(error);
            throw error;
          }
          if (connection === closing) {
            connection = null;
            connectionOpened = false;
          }
        }
        setState('disposed');
      })();
      disposePromise = running;
      void running.catch(() => {
        if (disposePromise === running) disposePromise = null;
      });
      return running;
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
