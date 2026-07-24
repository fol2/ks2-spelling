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
} = {}) {
  let record = initialRecord;
  const writes = [];
  const biometricCalls = [];
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
    pinCrypto,
    lifecycle,
    writes,
    biometricCalls,
    getRecord: () => structuredClone(record),
    now: () => now,
    advance(milliseconds) {
      now += milliseconds;
    },
  };
}

test('Parent security requires PIN setup and locks immediately on app pause', async () => {
  const harness = createHarness();
  const controller = await createParentSecurityController(harness);

  assert.deepEqual(controller.getState(), {
    status: 'setup-required',
    biometric: {
      available: true,
      type: 'face',
      enabled: false,
    },
    attemptsRemaining: 5,
    lockedUntil: 0,
    actionError: null,
  });

  await controller.setPin({ pin: '739251', confirmation: '739251' });
  assert.equal(controller.getState().status, 'unlocked');
  assert.equal(
    harness.getRecord().verifierBase64,
    Buffer.from('739251'.padEnd(32, '.')).toString('base64'),
  );

  harness.lifecycle.pause();
  assert.equal(controller.getState().status, 'locked');
  await controller.dispose();
});

test('Parent security does not unlock when initial PIN setup finishes after app pause', async () => {
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
  await Promise.resolve();
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

test('Parent PIN validation rejects weak or mismatched values before persistence', async () => {
  const harness = createHarness();
  const controller = await createParentSecurityController(harness);

  for (const candidate of [
    { pin: '123456', confirmation: '123456' },
    { pin: '111111', confirmation: '111111' },
    { pin: '73925', confirmation: '73925' },
    { pin: '739251', confirmation: '739252' },
  ]) {
    assert.throws(() => controller.setPin(candidate), /PIN|pin|confirmation/u);
  }
  assert.deepEqual(harness.writes, []);
  await controller.dispose();
});
