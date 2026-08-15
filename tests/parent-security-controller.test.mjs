import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createParentSecurityController,
} from '../src/app/parent-security-controller.js';

function createLifecycle() {
  const pauseListeners = new Set();
  return Object.freeze({
    onPause(listener) {
      pauseListeners.add(listener);
      return Object.freeze({
        async remove() {
          pauseListeners.delete(listener);
        },
      });
    },
    pause() {
      for (const listener of pauseListeners) listener();
    },
  });
}

function createHarness({
  initialRecord = null,
  biometricAvailability = Object.freeze({
    available: true,
    type: 'face',
  }),
  deviceAuthenticationAvailable = true,
} = {}) {
  let record = initialRecord;
  let ownerAvailable = deviceAuthenticationAvailable;
  let ownerOutcome = 'success';
  const writes = [];
  const biometricCalls = [];
  const deviceAuthenticationCalls = [];
  const deviceAvailabilityCalls = [];
  const repository = Object.freeze({
    async read() {
      return record === null ? null : structuredClone(record);
    },
    async write(next) {
      record = structuredClone(next);
      writes.push(structuredClone(next));
      return structuredClone(next);
    },
  });
  const biometrics = Object.freeze({
    async getAvailability() {
      return biometricAvailability;
    },
    async authenticate(request) {
      biometricCalls.push(structuredClone(request));
      return Object.freeze({ authenticated: true });
    },
  });
  const deviceAuthentication = Object.freeze({
    async getAvailability() {
      deviceAvailabilityCalls.push({});
      return Object.freeze({ available: ownerAvailable });
    },
    async authenticate(request) {
      deviceAuthenticationCalls.push(structuredClone(request));
      if (ownerOutcome === 'reject') {
        const error = new Error('parent_device_authentication_rejected');
        error.code = 'parent_device_authentication_rejected';
        throw error;
      }
      if (ownerOutcome === 'malformed') {
        return Object.freeze({ authenticated: false });
      }
      return Object.freeze({ authenticated: true });
    },
  });
  const pinCrypto = Object.freeze({
    async create(pin) {
      return Object.freeze({
        algorithm: 'PBKDF2-SHA-256',
        iterations: 210_000,
        saltBase64: 'MTIzNDU2Nzg5MDEyMzQ1Ng==',
        verifierBase64: Buffer.from(pin.padEnd(32, '.')).toString('base64'),
      });
    },
    async verify(pin, candidate) {
      return candidate.verifierBase64 ===
        Buffer.from(pin.padEnd(32, '.')).toString('base64');
    },
  });
  const lifecycle = createLifecycle();
  let now = 1_000;

  return {
    repository,
    biometrics,
    deviceAuthentication,
    pinCrypto,
    lifecycle,
    writes,
    biometricCalls,
    deviceAuthenticationCalls,
    deviceAvailabilityCalls,
    getRecord: () => (record === null ? null : structuredClone(record)),
    now: () => now,
    advance(milliseconds) {
      now += milliseconds;
    },
    setDeviceAuthenticationAvailable(available) {
      ownerAvailable = available;
    },
    setDeviceAuthenticationOutcome(outcome) {
      ownerOutcome = outcome;
    },
  };
}

const expectedSetupState = Object.freeze({
  status: 'setup-required',
  biometric: Object.freeze({
    available: true,
    type: 'face',
    enabled: false,
  }),
  attemptsRemaining: 5,
  lockedUntil: 0,
  actionError: null,
});

test('Parent security requires an owner challenge before setup and locks on pause', async () => {
  const harness = createHarness();
  const controller = await createParentSecurityController(harness);

  assert.deepEqual(controller.getState(), expectedSetupState);
  assert.deepEqual(Object.keys(controller), [
    'getState',
    'subscribe',
    'setPin',
    'unlockWithPin',
    'unlockWithBiometrics',
    'setBiometricsEnabled',
    'lock',
    'dispose',
  ]);
  assert.equal(typeof controller.resetPin, 'function');

  await controller.setPin({ pin: '739251', confirmation: '739251' });
  assert.equal(controller.getState().status, 'unlocked');
  assert.equal(
    harness.getRecord().verifierBase64,
    Buffer.from('739251'.padEnd(32, '.')).toString('base64'),
  );
  assert.deepEqual(harness.deviceAuthenticationCalls, [{
    reason: 'Confirm the device owner to save the Parent PIN',
  }]);
  assert.equal(Reflect.ownKeys(harness.deviceAuthenticationCalls[0]).length, 1);

  harness.lifecycle.pause();
  assert.equal(controller.getState().status, 'locked');
  await controller.dispose();
});

test('Rejected or unavailable owner authentication writes no first PIN', async () => {
  for (const mode of ['reject', 'unavailable', 'malformed']) {
    const harness = createHarness({
      deviceAuthenticationAvailable: mode !== 'unavailable',
    });
    harness.setDeviceAuthenticationOutcome(mode);
    const controller = await createParentSecurityController(harness);

    await assert.rejects(
      controller.setPin({ pin: '739251', confirmation: '739251' }),
      (error) => error?.code === (
        mode === 'unavailable'
          ? 'parent_device_authentication_unavailable'
          : 'parent_device_authentication_rejected'
      ),
    );
    assert.equal(controller.getState().status, 'setup-required');
    assert.equal(
      controller.getState().actionError,
      mode === 'unavailable'
        ? 'parent_device_authentication_unavailable'
        : 'parent_device_authentication_rejected',
    );
    assert.equal(harness.getRecord(), null);
    assert.deepEqual(harness.writes, []);
    await controller.dispose();
  }
});

test('Parent setup rechecks owner availability after device settings change', async () => {
  const harness = createHarness({ deviceAuthenticationAvailable: false });
  const controller = await createParentSecurityController(harness);

  await assert.rejects(
    controller.setPin({ pin: '739251', confirmation: '739251' }),
    (error) => error?.code === 'parent_device_authentication_unavailable',
  );
  assert.equal(harness.deviceAvailabilityCalls.length, 1);
  assert.equal(harness.getRecord(), null);

  harness.setDeviceAuthenticationAvailable(true);
  await controller.setPin({ pin: '739251', confirmation: '739251' });
  assert.equal(controller.getState().status, 'unlocked');
  assert.equal(harness.deviceAvailabilityCalls.length, 2);
  await controller.dispose();
});

test('Parent security does not unlock when guarded PIN setup finishes after app pause', async () => {
  const harness = createHarness();
  let finishCreate;
  harness.pinCrypto = Object.freeze({
    ...harness.pinCrypto,
    create() {
      return new Promise((resolve) => {
        finishCreate = resolve;
      });
    },
  });
  const controller = await createParentSecurityController(harness);
  const settingPin = controller.setPin({
    pin: '739251',
    confirmation: '739251',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof finishCreate, 'function');

  harness.lifecycle.pause();
  finishCreate({
    algorithm: 'PBKDF2-SHA-256',
    iterations: 210_000,
    saltBase64: 'MTIzNDU2Nzg5MDEyMzQ1Ng==',
    verifierBase64: Buffer.from('739251'.padEnd(32, '.')).toString('base64'),
  });
  await settingPin;

  assert.equal(controller.getState().status, 'locked');
  assert.notEqual(harness.getRecord(), null);
  await controller.dispose();
});

test('Parent security persists bounded failures and accepts the PIN after lock expiry', async () => {
  const harness = createHarness();
  const controller = await createParentSecurityController(harness);
  await controller.setPin({ pin: '739251', confirmation: '739251' });
  controller.lock();

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await assert.rejects(
      controller.unlockWithPin('852963'),
      (error) => error?.code === (
        attempt === 5 ? 'parent_pin_temporarily_locked' : 'parent_pin_incorrect'
      ),
    );
  }
  assert.equal(controller.getState().status, 'locked');
  assert.equal(controller.getState().attemptsRemaining, 0);
  assert.equal(controller.getState().lockedUntil, 301_000);
  await assert.rejects(
    controller.unlockWithPin('739251'),
    (error) => error?.code === 'parent_pin_temporarily_locked',
  );

  harness.advance(300_000);
  await controller.unlockWithPin('739251');
  assert.equal(controller.getState().status, 'unlocked');
  assert.equal(controller.getState().attemptsRemaining, 5);
  assert.equal(harness.getRecord().failedAttempts, 0);
  assert.equal(harness.getRecord().lockedUntil, 0);
  await controller.dispose();
});

test('Owner-authenticated recovery replaces only the PIN credential and lock counters', async () => {
  const harness = createHarness({
    biometricAvailability: Object.freeze({
      available: true,
      type: 'biometric',
    }),
  });
  const controller = await createParentSecurityController(harness);
  await controller.setPin({ pin: '739251', confirmation: '739251' });
  await controller.setBiometricsEnabled(true);
  controller.lock();
  await assert.rejects(
    controller.unlockWithPin('852963'),
    (error) => error?.code === 'parent_pin_incorrect',
  );
  const oldVerifier = harness.getRecord().verifierBase64;

  await controller.resetPin({ pin: '274913', confirmation: '274913' });
  const recovered = harness.getRecord();
  assert.notEqual(recovered.verifierBase64, oldVerifier);
  assert.equal(recovered.failedAttempts, 0);
  assert.equal(recovered.lockedUntil, 0);
  assert.equal(recovered.biometricEnabled, true);
  assert.equal(controller.getState().status, 'unlocked');
  assert.deepEqual(harness.deviceAuthenticationCalls.at(-1), {
    reason: 'Confirm the device owner to reset the Parent PIN',
  });

  controller.lock();
  await assert.rejects(
    controller.unlockWithPin('739251'),
    (error) => error?.code === 'parent_pin_incorrect',
  );
  await controller.unlockWithPin('274913');
  assert.equal(controller.getState().status, 'unlocked');
  await controller.dispose();
});

test('Rejected PIN recovery preserves the exact credential and lock state', async () => {
  const harness = createHarness();
  const controller = await createParentSecurityController(harness);
  await controller.setPin({ pin: '739251', confirmation: '739251' });
  controller.lock();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(controller.unlockWithPin('852963'));
  }
  const before = harness.getRecord();
  const writesBefore = harness.writes.length;
  harness.setDeviceAuthenticationOutcome('reject');

  await assert.rejects(
    controller.resetPin({ pin: '274913', confirmation: '274913' }),
    (error) => error?.code === 'parent_device_authentication_rejected',
  );
  assert.deepEqual(harness.getRecord(), before);
  assert.equal(harness.writes.length, writesBefore);
  assert.equal(controller.getState().status, 'locked');
  assert.equal(
    controller.getState().actionError,
    'parent_device_authentication_rejected',
  );
  await controller.dispose();
});

test('The setup method cannot overwrite an existing Parent credential', async () => {
  const harness = createHarness();
  const controller = await createParentSecurityController(harness);
  await controller.setPin({ pin: '739251', confirmation: '739251' });
  const before = harness.getRecord();

  await assert.rejects(
    controller.setPin({ pin: '274913', confirmation: '274913' }),
    (error) => error?.code === 'parent_pin_already_configured',
  );
  assert.deepEqual(harness.getRecord(), before);
  assert.equal(harness.deviceAuthenticationCalls.length, 1);
  await controller.dispose();
});

test('Biometrics are opt-in from an unlocked Parent session and never bypass setup', async () => {
  const harness = createHarness({
    biometricAvailability: Object.freeze({
      available: true,
      type: 'biometric',
    }),
  });
  const controller = await createParentSecurityController(harness);

  await assert.rejects(
    controller.unlockWithBiometrics(),
    (error) => error?.code === 'parent_biometrics_not_enabled',
  );
  assert.deepEqual(harness.biometricCalls, []);

  await controller.setPin({ pin: '739251', confirmation: '739251' });
  await controller.setBiometricsEnabled(true);
  controller.lock();
  await controller.unlockWithBiometrics();

  assert.equal(controller.getState().status, 'unlocked');
  assert.deepEqual(harness.biometricCalls, [{
    reason: 'Open the KS2 Spelling Parent area',
  }]);
  assert.equal(harness.getRecord().biometricEnabled, true);
  await controller.dispose();
});

test('Parent PIN validation rejects weak or mismatched values before native authentication', async () => {
  const harness = createHarness();
  const controller = await createParentSecurityController(harness);

  for (const candidate of [
    { pin: '123456', confirmation: '123456' },
    { pin: '111111', confirmation: '111111' },
    { pin: '73925', confirmation: '73925' },
    { pin: '739251', confirmation: '739252' },
    { pin: '739251', confirmation: '739251', intent: 'setup' },
    {
      pin: '739251',
      confirmation: '739251',
      intent: 'recovery',
      learnerId: 'learner-a',
    },
  ]) {
    assert.throws(() => controller.setPin(candidate), /PIN|pin|confirmation/u);
  }
  assert.deepEqual(harness.deviceAuthenticationCalls, []);
  assert.deepEqual(harness.writes, []);
  await controller.dispose();
});

test('Parent security unlocks through the real PIN crypto against its own stored record', async () => {
  // The fake crypto above accepts any candidate shape, so it cannot catch a
  // controller that hands the whole security record to verify() when the
  // contract validates exactly the four credential keys. This round trip runs
  // the real PBKDF2 contract end to end.
  const { createParentPinCrypto } = await import(
    '../src/domain/security/parent-pin-contract.js'
  );
  const harness = createHarness();
  const controller = await createParentSecurityController({
    ...harness,
    pinCrypto: createParentPinCrypto({ crypto: globalThis.crypto }),
  });
  await controller.setPin({ pin: '274913', confirmation: '274913' });
  controller.lock();
  await controller.unlockWithPin('274913');
  assert.equal(controller.getState().status, 'unlocked');
  await assert.rejects(
    controller.unlockWithPin('274914'),
    (error) => error?.code === 'parent_pin_incorrect',
  );
  await controller.dispose();
});
