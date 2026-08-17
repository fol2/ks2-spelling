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
const PIN_SETUP_REASON = 'Confirm the device owner to save the Parent PIN';
const PIN_RESET_REASON = 'Confirm the device owner to reset the Parent PIN';

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

function requireBiometricAvailability(value) {
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

function requireDeviceAuthenticationAvailability(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 1 ||
    typeof value.available !== 'boolean'
  ) {
    throw new TypeError(
      'Parent device authentication availability is invalid.',
    );
  }
  return Object.freeze({ available: value.available });
}

function requireAuthenticated(value, code) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 1 ||
    value.authenticated !== true
  ) {
    throw controllerError(code);
  }
  return value;
}

function stateFrom({
  status,
  biometricAvailability,
  record,
  now,
  actionError = null,
}) {
  const activeLock = record !== null && record.lockedUntil > now;
  const failedAttempts = activeLock ? record.failedAttempts : 0;
  return Object.freeze({
    status,
    biometric: Object.freeze({
      ...biometricAvailability,
      enabled: record?.biometricEnabled === true,
    }),
    attemptsRemaining: MAXIMUM_FAILED_ATTEMPTS - failedAttempts,
    lockedUntil: activeLock ? record.lockedUntil : 0,
    actionError,
  });
}

function requirePinChange(value) {
  const recovery = Object.hasOwn(value ?? {}, 'intent');
  const expectedKeys = recovery
    ? ['pin', 'confirmation', 'intent']
    : ['pin', 'confirmation'];
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(value, key)) ||
    (recovery && value.intent !== 'recovery')
  ) {
    throw new TypeError('Parent PIN setup is invalid.');
  }
  const pin = validateParentPin(value.pin);
  if (value.confirmation !== pin) {
    throw new TypeError('Parent PIN confirmation does not match.');
  }
  return Object.freeze({ pin, recovery });
}

const unavailableDeviceAuthentication = Object.freeze({
  async getAvailability() {
    return Object.freeze({ available: false });
  },
  async authenticate() {
    throw controllerError('parent_device_authentication_unavailable');
  },
});

export async function createParentSecurityController({
  repository,
  biometrics,
  deviceAuthentication,
  lifecycle,
  pinCrypto = createParentPinCrypto(),
  now = Date.now,
} = {}) {
  const ownerAuthentication =
    deviceAuthentication
    ?? biometrics?.deviceAuthentication
    ?? unavailableDeviceAuthentication;
  for (const method of ['read', 'write']) {
    requireMethod(repository, method, 'Parent security repository');
  }
  for (const method of ['getAvailability', 'authenticate']) {
    requireMethod(biometrics, method, 'Parent biometrics');
    requireMethod(
      ownerAuthentication,
      method,
      'Parent device authentication',
    );
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
  let biometricAvailability;
  try {
    biometricAvailability = requireBiometricAvailability(
      await biometrics.getAvailability(),
    );
  } catch {
    biometricAvailability = Object.freeze({ available: false, type: 'none' });
  }
  const listeners = new Set();
  let disposed = false;
  let queue = Promise.resolve();
  let lockEpoch = 0;
  let state = stateFrom({
    status: record === null ? 'setup-required' : 'locked',
    biometricAvailability,
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
      biometricAvailability,
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

  async function authenticateDeviceOwner(reason, failureStatus) {
    let availability;
    try {
      availability = requireDeviceAuthenticationAvailability(
        await ownerAuthentication.getAvailability(),
      );
    } catch {
      availability = Object.freeze({ available: false });
    }
    if (!availability.available) {
      const sampledAt = sampleNow(now);
      publishFor(
        failureStatus,
        sampledAt,
        'parent_device_authentication_unavailable',
      );
      throw controllerError('parent_device_authentication_unavailable');
    }

    try {
      const result = await ownerAuthentication.authenticate({ reason });
      requireAuthenticated(
        result,
        'parent_device_authentication_rejected',
      );
    } catch {
      const sampledAt = sampleNow(now);
      publishFor(
        failureStatus,
        sampledAt,
        'parent_device_authentication_rejected',
      );
      throw controllerError('parent_device_authentication_rejected');
    }
  }

  async function createFirstPin(pin) {
    if (record !== null) {
      const sampledAt = sampleNow(now);
      publishFor(
        state.status,
        sampledAt,
        'parent_pin_already_configured',
      );
      throw controllerError('parent_pin_already_configured');
    }
    const operationEpoch = lockEpoch;
    await authenticateDeviceOwner(PIN_SETUP_REASON, 'setup-required');
    const sampledAt = sampleNow(now);
    try {
      const credential = await pinCrypto.create(pin);
      const nextRecord = validateParentSecurityRecord({
        schemaVersion: 1,
        ...credential,
        failedAttempts: 0,
        lockedUntil: 0,
        biometricEnabled: false,
        updatedAt: sampledAt,
      });
      record = validateParentSecurityRecord(
        await repository.write(nextRecord),
      );
    } catch {
      publishFor(
        'setup-required',
        sampleNow(now),
        'parent_pin_setup_failed',
      );
      throw controllerError('parent_pin_setup_failed');
    }
    publishFor(
      operationEpoch === lockEpoch ? 'unlocked' : 'locked',
      sampledAt,
    );
  }

  async function replacePin(pin) {
    if (record === null) {
      const sampledAt = sampleNow(now);
      publishFor(
        'setup-required',
        sampledAt,
        'parent_pin_not_configured',
      );
      throw controllerError('parent_pin_not_configured');
    }
    const operationEpoch = lockEpoch;
    const previousRecord = record;
    await authenticateDeviceOwner(PIN_RESET_REASON, 'locked');
    const sampledAt = sampleNow(now);
    try {
      const credential = await pinCrypto.create(pin);
      const nextRecord = validateParentSecurityRecord({
        schemaVersion: 1,
        ...credential,
        failedAttempts: 0,
        lockedUntil: 0,
        biometricEnabled: previousRecord.biometricEnabled,
        updatedAt: sampledAt,
      });
      record = validateParentSecurityRecord(
        await repository.write(nextRecord),
      );
    } catch {
      // Keep the exact in-memory credential and bounded lock state when a
      // replacement cannot be durably written. A post-commit database failure
      // is still fail-closed: relaunch reads whichever complete record the
      // repository committed.
      record = previousRecord;
      publishFor(
        'locked',
        sampleNow(now),
        'parent_pin_reset_failed',
      );
      throw controllerError('parent_pin_reset_failed');
    }
    publishFor(
      operationEpoch === lockEpoch ? 'unlocked' : 'locked',
      sampledAt,
    );
  }

  function setPin(candidate) {
    const change = requirePinChange(candidate);
    return run(() => change.recovery
      ? replacePin(change.pin)
      : createFirstPin(change.pin));
  }

  function lock() {
    if (disposed) return;
    lockEpoch += 1;
    if (record === null) return;
    publishFor('locked', sampleNow(now));
  }

  const pauseHandle = lifecycle.onPause(lock);
  const api = {
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
    setPin,
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
        // The stored record carries lock state beside the credential, and the
        // PIN crypto contract accepts exactly the four credential keys.
        if (await pinCrypto.verify(pin, Object.freeze({
          algorithm: record.algorithm,
          iterations: record.iterations,
          saltBase64: record.saltBase64,
          verifierBase64: record.verifierBase64,
        }))) {
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
          !biometricAvailability.available
        ) {
          throw controllerError('parent_biometrics_not_enabled');
        }
        const operationEpoch = lockEpoch;
        const result = await biometrics.authenticate({
          reason: BIOMETRIC_REASON,
        });
        requireAuthenticated(result, 'parent_biometrics_rejected');
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
        if (enabled && !biometricAvailability.available) {
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
  };
  // ProductApp already owns a named recovery callback. Keep that internal
  // wiring working without widening the enumerable service contract that
  // other consumers pin with Object.keys().
  Object.defineProperty(api, 'resetPin', {
    enumerable: false,
    value(candidate) {
      return setPin({ ...candidate, intent: 'recovery' });
    },
  });
  return Object.freeze(api);
}
