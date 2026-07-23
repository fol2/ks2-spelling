import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCapacitorParentBiometrics,
} from '../src/platform/security/capacitor-parent-biometrics.js';

test('Parent biometric port exposes bounded availability and authentication', async () => {
  const calls = [];
  const biometrics = createCapacitorParentBiometrics({
    ParentAccess: {
      async getBiometricAvailability(request) {
        calls.push(['availability', structuredClone(request)]);
        return { available: true, type: 'face' };
      },
      async authenticateBiometric(request) {
        calls.push(['authenticate', structuredClone(request)]);
        return { authenticated: true };
      },
    },
  });

  assert.deepEqual(Object.keys(biometrics), [
    'getAvailability',
    'authenticate',
  ]);
  assert.deepEqual(await biometrics.getAvailability(), {
    available: true,
    type: 'face',
  });
  assert.deepEqual(
    await biometrics.authenticate({
      reason: 'Open the KS2 Spelling Parent area',
    }),
    { authenticated: true },
  );
  assert.deepEqual(calls, [
    ['availability', {}],
    ['authenticate', { reason: 'Open the KS2 Spelling Parent area' }],
  ]);
});

test('Parent biometric port rejects malformed native data and arbitrary requests', async () => {
  let calls = 0;
  const biometrics = createCapacitorParentBiometrics({
    ParentAccess: {
      async getBiometricAvailability() {
        return { available: true, type: 'unknown' };
      },
      async authenticateBiometric() {
        calls += 1;
        return { authenticated: false };
      },
    },
  });

  await assert.rejects(biometrics.getAvailability(), /biometric/i);
  for (const request of [
    {},
    { reason: '' },
    { reason: 'Open Parent area', learnerId: 'learner-a' },
  ]) {
    assert.throws(() => biometrics.authenticate(request), /biometric/i);
  }
  await assert.rejects(
    biometrics.authenticate({ reason: 'Open Parent area' }),
    /biometric/i,
  );
  assert.equal(calls, 1);
});
