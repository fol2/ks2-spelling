import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('the Parent card can start a purchased download and resume an interrupted one', async () => {
  const { downloadActionLabel } = await import('../src/app/parent-commerce-controller.js');
  // A purchase leaves the shard jobs queued; an interrupted install leaves
  // them downloading. Both were unreachable before E2.7's fix round, which
  // stranded a paying family with no way to obtain the content.
  assert.equal(downloadActionLabel({ entitlementState: 'active', packState: 'queued' }), 'Download pack');
  assert.equal(downloadActionLabel({ entitlementState: 'active', packState: 'downloading' }), 'Resume download');
  assert.equal(downloadActionLabel({ entitlementState: 'active', packState: 'missing' }), 'Download pack');
  assert.equal(downloadActionLabel({ entitlementState: 'active', packState: 'failed' }), 'Retry download');
  // Nothing to do, or no right to do it.
  assert.equal(downloadActionLabel({ entitlementState: 'active', packState: 'installed' }), null);
  assert.equal(downloadActionLabel({ entitlementState: 'revoked', packState: 'locked' }), null);
  assert.equal(downloadActionLabel({ entitlementState: 'none', packState: 'missing' }), null);
  assert.equal(downloadActionLabel(), null);
});

test('the download button is driven by that selector, not by an inline state list', async () => {
  const source = await readFile(new URL('../src/app/ProductApp.jsx', import.meta.url), 'utf8');
  assert.match(source, /downloadActionLabel\(state\)/u);
  assert.doesNotMatch(source, /\['missing', 'failed'\]\.includes\(state\.packState\)/u);
});
