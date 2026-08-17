import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCapacitorParentDeviceAuthentication,
} from '../src/platform/security/capacitor-parent-device-authentication.js';

test('Parent device authentication port exposes one bounded owner challenge', async () => {
  const calls = [];
  const authentication = createCapacitorParentDeviceAuthentication({
    ParentAccess: {
      async getDeviceOwnerAuthenticationAvailability(request) {
        calls.push(['availability', structuredClone(request)]);
        return { available: true };
      },
      async authenticateDeviceOwner(request) {
        calls.push(['authenticate', structuredClone(request)]);
        return { authenticated: true };
      },
    },
  });

  assert.deepEqual(Object.keys(authentication), [
    'getAvailability',
    'authenticate',
  ]);
  assert.deepEqual(await authentication.getAvailability(), {
    available: true,
  });
  assert.deepEqual(
    await authentication.authenticate({
      reason: 'Confirm the device owner to save the Parent PIN',
    }),
    { authenticated: true },
  );
  assert.deepEqual(calls, [
    ['availability', {}],
    ['authenticate', {
      reason: 'Confirm the device owner to save the Parent PIN',
    }],
  ]);
});

test('Parent device authentication port rejects malformed native data and requests', async () => {
  let calls = 0;
  const authentication = createCapacitorParentDeviceAuthentication({
    ParentAccess: {
      async getDeviceOwnerAuthenticationAvailability() {
        return { available: 'yes' };
      },
      async authenticateDeviceOwner() {
        calls += 1;
        return { authenticated: false };
      },
    },
  });

  await assert.rejects(
    authentication.getAvailability(),
    /device authentication/i,
  );
  for (const request of [
    {},
    { reason: '' },
    { reason: 'Confirm owner', pin: '739251' },
    { reason: 'x'.repeat(121) },
  ]) {
    assert.throws(
      () => authentication.authenticate(request),
      /device authentication/i,
    );
  }
  await assert.rejects(
    authentication.authenticate({ reason: 'Confirm owner' }),
    (error) => error?.code === 'parent_device_authentication_rejected',
  );
  assert.equal(calls, 1);
});

test('Parent device authentication port rejects native promise violations', async () => {
  const availability = createCapacitorParentDeviceAuthentication({
    ParentAccess: {
      getDeviceOwnerAuthenticationAvailability() {
        return { available: true };
      },
      async authenticateDeviceOwner() {
        return { authenticated: true };
      },
    },
  });
  await assert.rejects(
    availability.getAvailability(),
    (error) => error?.code === 'parent_device_authentication_unavailable',
  );

  const authenticate = createCapacitorParentDeviceAuthentication({
    ParentAccess: {
      async getDeviceOwnerAuthenticationAvailability() {
        return { available: true };
      },
      authenticateDeviceOwner() {
        return { authenticated: true };
      },
    },
  });
  await assert.rejects(
    authenticate.authenticate({ reason: 'Confirm owner' }),
    (error) => error?.code === 'parent_device_authentication_rejected',
  );
});
