import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createParentCommerceController,
} from '../src/app/parent-commerce-controller.js';

function snapshot(overrides = {}) {
  return Object.freeze({
    displayPrice: '£4.99',
    entitlementState: 'active',
    packState: 'installed',
    syncFailed: false,
    ...overrides,
  });
}

test('Parent commerce preserves verified access and installed data through external failure', async () => {
  const results = [
    snapshot(),
    snapshot({ displayPrice: '', syncFailed: true }),
    snapshot({
      displayPrice: '',
      entitlementState: 'revoked',
      packState: 'locked',
    }),
  ];
  const workflow = {
    async start() { return results.shift(); },
    async refresh() { return results.shift(); },
    async purchase() { throw new Error('not used'); },
    async restore() { throw new Error('not used'); },
    async download() { throw new Error('not used'); },
    async recover() { throw new Error('not used'); },
    async dispose() {},
  };
  const controller = createParentCommerceController({ workflow });

  await controller.start();
  assert.deepEqual(controller.getState(), {
    status: 'ready',
    displayPrice: '£4.99',
    entitlementState: 'active',
    packState: 'installed',
    action: null,
    actionError: null,
  });

  await controller.refresh();
  assert.deepEqual(controller.getState(), {
    status: 'offline',
    displayPrice: '',
    entitlementState: 'active',
    packState: 'installed',
    action: null,
    actionError: null,
  });

  await controller.refresh();
  assert.deepEqual(controller.getState(), {
    status: 'ready',
    displayPrice: '',
    entitlementState: 'revoked',
    packState: 'locked',
    action: null,
    actionError: null,
  });
  await controller.dispose();
});

test('Parent commerce serialises explicit purchase, restore, download and recovery actions', async () => {
  const calls = [];
  const workflow = {
    async start() {
      calls.push('start');
      return snapshot({ entitlementState: 'none', packState: 'missing' });
    },
    async refresh() {
      calls.push('refresh');
      return snapshot();
    },
    async purchase() {
      calls.push('purchase');
      return snapshot({ packState: 'missing' });
    },
    async restore() {
      calls.push('restore');
      return snapshot({ packState: 'missing' });
    },
    async download() {
      calls.push('download');
      return snapshot();
    },
    async recover() {
      calls.push('recover');
      return snapshot();
    },
    async dispose() {
      calls.push('dispose');
    },
  };
  const controller = createParentCommerceController({ workflow });

  await controller.start();
  await controller.purchase();
  await controller.restore();
  await controller.download();
  await controller.recover();

  assert.deepEqual(calls, [
    'start',
    'purchase',
    'restore',
    'download',
    'recover',
  ]);
  assert.equal(controller.getState().status, 'ready');
  assert.equal(controller.getState().packState, 'installed');
  await controller.dispose();
  assert.equal(calls.at(-1), 'dispose');
});
