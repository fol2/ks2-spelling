const PAUSED_CODE = 'sqlite_commands_paused';
const NOT_IDLE_CODE = 'sqlite_commands_not_idle';

function commandGateError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function createDatabaseCommandGate() {
  let accepting = true;
  let active = null;
  const queue = [];
  const idleWaiters = new Set();

  function resolveIdleWaiters() {
    if (active !== null || queue.length !== 0) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  }

  function startNext() {
    if (active !== null) return;
    const next = queue.shift();
    if (!next) {
      resolveIdleWaiters();
      return;
    }

    active = next;
    let result;
    try {
      result = next.executor();
    } catch (error) {
      next.reject(error);
      if (active === next) active = null;
      startNext();
      return;
    }
    Promise.resolve(result).then(
      (value) => {
        next.resolve(value);
        if (active === next) active = null;
        startNext();
      },
      (error) => {
        next.reject(error);
        if (active === next) active = null;
        startNext();
      },
    );
  }

  function run(executor) {
    if (typeof executor !== 'function') {
      return Promise.reject(new TypeError('Database command executor must be a function.'));
    }
    if (!accepting) return Promise.reject(commandGateError(PAUSED_CODE));

    return new Promise((resolve, reject) => {
      queue.push({ executor, reject, resolve });
      startNext();
    });
  }

  function waitForIdle() {
    if (active === null && queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      idleWaiters.add(resolve);
    });
  }

  function pauseAndDrain() {
    accepting = false;
    const paused = queue.splice(0);
    for (const pending of paused) pending.reject(commandGateError(PAUSED_CODE));
    resolveIdleWaiters();
    return waitForIdle();
  }

  function resume() {
    if (active !== null || queue.length !== 0) {
      throw commandGateError(NOT_IDLE_CODE);
    }
    accepting = true;
  }

  function isAccepting() {
    return accepting;
  }

  return Object.freeze({ run, pauseAndDrain, resume, isAccepting, waitForIdle });
}
