import {
  createParentPinCrypto,
  validateParentPin,
} from '../domain/security/parent-pin-contract.js';
import {
  validateParentSecurityRecord,
} from '../domain/security/parent-security-record.js';

const MAXIMUM_FAILED_ATTEMPTS = 5;
const LOCK_MILLISECONDS = 300_000;
const BIOMETRIC_REASON = 'Open the KS2 Spelling Parent area';

function controllerError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requireMethod(value, method, label) {
  if (!value || typeof value !== 'object' || typeof value[method] !== 'function') {
    throw new TypeError(`${label}.${method} must be a function.`);
  }
}

function sampleNow(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Parent security clock must return a safe timestamp.');
  }
  return value;
}

function requireAvailability(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 2 ||
    typeof value.available !== 'boolean' ||
    !['biometric', 'face', 'fingerprint', 'none'].includes(value.type) ||
    (value.available ? value.type === 'none' : value.type !== 'none')
  ) {
    throw new TypeError('Parent biometric availability is invalid.');
  }
  return Object.freeze({
    available: value.available,
    type: value.type,
  });
}

function stateFrom({
  status,
  availability,
  record,
  now,
  actionError = null,
}) {
  const activeLock = record !== null && record.lockedUntil > now;
  const failedAttempts = activeLock ? record.failedAttempts : 0;
  return Object.freeze({
    status,
    biometric: Object.freeze({
      ...availability,
      enabled: record?.biometricEnabled === true,
    }),
    attemptsRemaining: MAXIMUM_FAILED_ATTEMPTS - failedAttempts,
    lockedUntil: activeLock ? record.lockedUntil : 0,
    actionError,
  });
}

function requirePinSetup(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 2 ||
    !Object.hasOwn(value, 'pin') ||
    !Object.hasOwn(value, 'confirmation')
  ) {
    throw new TypeError('Parent PIN setup is invalid.');
  }
  const pin = validateParentPin(value.pin);
  if (value.confirmation !== pin) {
    throw new TypeError('Parent PIN confirmation does not match.');
  }
  return pin;
}

export async function createParentSecurityController({
  repository,
  biometrics,
  lifecycle,
  pinCrypto = createParentPinCrypto(),
  now = Date.now,
} = {}) {
  for (const method of ['read', 'write']) {
    requireMethod(repository, method, 'Parent security repository');
  }
  for (const method of ['getAvailability', 'authenticate']) {
    requireMethod(biometrics, method, 'Parent biometrics');
  }
  requireMethod(lifecycle, 'onPause', 'App lifecycle');
  for (const method of ['create', 'verify']) {
    requireMethod(pinCrypto, method, 'Parent PIN crypto');
  }
  if (typeof now !== 'function') {
    throw new TypeError('Parent security now must be a function.');
  }

  let record = await repository.read();
  if (record !== null) record = validateParentSecurityRecord(record);
  let availability;
  try {
    availability = requireAvailability(await biometrics.getAvailability());
  } catch {
    availability = Object.freeze({ available: false, type: 'none' });
  }
  const listeners = new Set();
  let disposed = false;
  let queue = Promise.resolve();
  let lockEpoch = 0;
  let state = stateFrom({
    status: record === null ? 'setup-required' : 'locked',
    availability,
    record,
    now: sampleNow(now),
  });

  function publish(next) {
    state = next;
    for (const listener of listeners) listener(state);
  }

  function publishFor(status, sampledAt, actionError = null) {
    publish(stateFrom({
      status,
      availability,
      record,
      now: sampledAt,
      actionError,
    }));
  }

  function run(action) {
    if (disposed) {
      return Promise.reject(controllerError('parent_security_controller_disposed'));
    }
    const operation = queue.then(action);
    queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  function lock() {
    if (disposed) return;
    lockEpoch += 1;
    if (record === null) return;
    publishFor('locked', sampleNow(now));
  }

  const pauseHandle = lifecycle.onPause(lock);

  return Object.freeze({
    getState() {
      return state;
    },
    subscribe(listener) {
      if (typeof listener !== 'function') {
        throw new TypeError('Parent security listener must be a function.');
      }
      if (disposed) {
        throw controllerError('parent_security_controller_disposed');
      }
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
    setPin(candidate) {
      const pin = requirePinSetup(candidate);
      return run(async () => {
        const operationEpoch = lockEpoch;
        const sampledAt = sampleNow(now);
        const credential = await pinCrypto.create(pin);
        record = validateParentSecurityRecord({
          schemaVersion: 1,
          ...credential,
          failedAttempts: 0,
          lockedUntil: 0,
          biometricEnabled: false,
          updatedAt: sampledAt,
        });
        record = validateParentSecurityRecord(await repository.write(record));
        publishFor(
          operationEpoch === lockEpoch ? 'unlocked' : 'locked',
          sampledAt,
        );
      });
    },
    unlockWithPin(candidate) {
      const pin = validateParentPin(candidate);
      return run(async () => {
        if (record === null) throw controllerError('parent_pin_not_configured');
        const operationEpoch = lockEpoch;
        const sampledAt = sampleNow(now);
        record = validateParentSecurityRecord(await repository.read());
        if (record.lockedUntil > sampledAt) {
          publishFor(
            'locked',
            sampledAt,
            'parent_pin_temporarily_locked',
          );
          throw controllerError('parent_pin_temporarily_locked');
        }
        if (await pinCrypto.verify(pin, record)) {
          if (record.failedAttempts !== 0 || record.lockedUntil !== 0) {
            record = validateParentSecurityRecord(await repository.write({
              ...record,
              failedAttempts: 0,
              lockedUntil: 0,
              updatedAt: sampledAt,
            }));
          }
          publishFor(
            operationEpoch === lockEpoch ? 'unlocked' : 'locked',
            sampledAt,
          );
          return;
        }
        const failedAttempts =
          record.lockedUntil === 0 ? record.failedAttempts + 1 : 1;
        const reachedLimit = failedAttempts >= MAXIMUM_FAILED_ATTEMPTS;
        record = validateParentSecurityRecord(await repository.write({
          ...record,
          failedAttempts: reachedLimit
            ? MAXIMUM_FAILED_ATTEMPTS
            : failedAttempts,
          lockedUntil: reachedLimit ? sampledAt + LOCK_MILLISECONDS : 0,
          updatedAt: sampledAt,
        }));
        const code = reachedLimit
          ? 'parent_pin_temporarily_locked'
          : 'parent_pin_incorrect';
        publishFor('locked', sampledAt, code);
        throw controllerError(code);
      });
    },
    unlockWithBiometrics() {
      return run(async () => {
        if (
          record === null ||
          !record.biometricEnabled ||
          !availability.available
        ) {
          throw controllerError('parent_biometrics_not_enabled');
        }
        const operationEpoch = lockEpoch;
        const result = await biometrics.authenticate({
          reason: BIOMETRIC_REASON,
        });
        if (
          !result ||
          typeof result !== 'object' ||
          Array.isArray(result) ||
          Reflect.ownKeys(result).length !== 1 ||
          result.authenticated !== true
        ) {
          throw controllerError('parent_biometrics_rejected');
        }
        publishFor(
          operationEpoch === lockEpoch ? 'unlocked' : 'locked',
          sampleNow(now),
        );
      });
    },
    setBiometricsEnabled(enabled) {
      if (typeof enabled !== 'boolean') {
        throw new TypeError('Parent biometric setting must be a boolean.');
      }
      return run(async () => {
        if (state.status !== 'unlocked' || record === null) {
          throw controllerError('parent_session_locked');
        }
        if (enabled && !availability.available) {
          throw controllerError('parent_biometrics_unavailable');
        }
        const sampledAt = sampleNow(now);
        record = validateParentSecurityRecord(await repository.write({
          ...record,
          biometricEnabled: enabled,
          updatedAt: sampledAt,
        }));
        publishFor('unlocked', sampledAt);
      });
    },
    lock,
    async dispose() {
      if (disposed) return;
      disposed = true;
      lockEpoch += 1;
      await queue;
      await pauseHandle.remove();
      listeners.clear();
    },
  });
}
