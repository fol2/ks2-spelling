import assert from 'node:assert/strict';
import test from 'node:test';

import { createB3ProofController } from '../src/app/b3-proof-controller.js';

const DIGESTS = Object.freeze({
  manifest: '39b6a788a3686d7cbf1fd4791bce45623af21ef53c60eabc03d955395856218a',
  archive: '4c2ca2eb4d4bb7ac3347b66e3483dcb6aa71b41958704733bfc471c970ce7664',
  install: null,
});

test('Parent can cancel a B3 purchase calmly without gaining pack access', async () => {
  const transitions = [];
  const workflow = Object.freeze({
    async start() {
      return Object.freeze({
        displayPrice: '£4.99',
        packReady: false,
        entitlementState: 'none',
        digests: DIGESTS,
      });
    },
    async purchase() {
      return Object.freeze({ state: 'cancelled' });
    },
    async restore() {
      throw new Error('not used');
    },
    async redownload() {
      throw new Error('not used');
    },
  });
  const controller = createB3ProofController({ workflow });
  const subscription = controller.subscribe((state) => transitions.push(state.status));

  await controller.start();
  const result = await controller.buy();

  assert.equal(result.status, 'cancelled');
  assert.deepEqual(transitions, ['ready', 'purchasing', 'cancelled']);
  assert.deepEqual(controller.getState(), {
    status: 'cancelled',
    message: 'Purchase cancelled. Nothing has changed.',
    displayPrice: '£4.99',
    packReady: false,
    digests: DIGESTS,
  });
  subscription.remove();
});

test('a pending store purchase stays locked and uses calm Parent copy', async () => {
  const workflow = Object.freeze({
    async start() {
      return Object.freeze({
        displayPrice: '£4.99',
        packReady: false,
        entitlementState: 'none',
        digests: DIGESTS,
      });
    },
    async purchase() {
      return Object.freeze({ state: 'pending' });
    },
    async restore() {
      throw new Error('not used');
    },
    async redownload() {
      throw new Error('not used');
    },
  });
  const controller = createB3ProofController({ workflow });

  await controller.start();
  const result = await controller.buy();

  assert.equal(result.status, 'pending');
  assert.equal(result.packReady, false);
  assert.equal(result.message, 'The store says this purchase is pending. Try again later.');
});

test('an entitled purchase downloads and installs before pack access becomes ready', async () => {
  const transitions = [];
  const installDigest = 'd'.repeat(64);
  const workflow = Object.freeze({
    async start() {
      return Object.freeze({
        displayPrice: '£4.99',
        packReady: false,
        entitlementState: 'none',
        digests: DIGESTS,
      });
    },
    async purchase() {
      return Object.freeze({ state: 'complete' });
    },
    async install() {
      return Object.freeze({
        state: 'installed',
        packReady: true,
        installDigest,
      });
    },
    async restore() {
      throw new Error('not used');
    },
    async redownload() {
      throw new Error('not used');
    },
  });
  const controller = createB3ProofController({ workflow });
  controller.subscribe((state) => transitions.push(state.status));

  await controller.start();
  const result = await controller.buy();

  assert.deepEqual(transitions, [
    'ready',
    'purchasing',
    'entitled',
    'downloading',
    'installed',
  ]);
  assert.equal(result.status, 'installed');
  assert.equal(result.packReady, true);
  assert.equal(result.digests.install, installDigest);
});

test('Parent can restore an existing entitlement without entering purchase state', async () => {
  const transitions = [];
  const workflow = Object.freeze({
    async start() {
      return Object.freeze({
        displayPrice: '£4.99', packReady: true, entitlementState: 'active',
        digests: Object.freeze({ ...DIGESTS, install: 'e'.repeat(64) }),
      });
    },
    async purchase() { throw new Error('not used'); },
    async restore() { return Object.freeze({ state: 'restored', packReady: true }); },
    async redownload() { throw new Error('not used'); },
  });
  const controller = createB3ProofController({ workflow });
  controller.subscribe((state) => transitions.push(state.status));

  await controller.start();
  const result = await controller.restore();

  assert.equal(result.status, 'restored');
  assert.equal(result.packReady, true);
  assert.deepEqual(transitions, ['ready', 'restored']);
});

test('Parent can redownload an entitled pack and access changes only after install', async () => {
  const transitions = [];
  const installDigest = 'f'.repeat(64);
  const workflow = Object.freeze({
    async start() {
      return Object.freeze({
        displayPrice: '£4.99', packReady: false, entitlementState: 'active',
        digests: DIGESTS,
      });
    },
    async purchase() { throw new Error('not used'); },
    async restore() { throw new Error('not used'); },
    async redownload() {
      return Object.freeze({ state: 'installed', packReady: true, installDigest });
    },
  });
  const controller = createB3ProofController({ workflow });
  controller.subscribe((state) => transitions.push(state.status));

  await controller.start();
  const result = await controller.redownload();

  assert.deepEqual(transitions, ['ready', 'downloading', 'installed']);
  assert.equal(result.packReady, true);
  assert.equal(result.digests.install, installDigest);
});

test('startup reports a verified revocation without deleting pack evidence', async () => {
  const installDigest = '1'.repeat(64);
  const workflow = Object.freeze({
    async start() {
      return Object.freeze({
        displayPrice: '£4.99',
        packReady: false,
        entitlementState: 'revoked',
        digests: Object.freeze({ ...DIGESTS, install: installDigest }),
      });
    },
    async purchase() { throw new Error('not used'); },
    async restore() { throw new Error('not used'); },
    async redownload() { throw new Error('not used'); },
  });
  const controller = createB3ProofController({ workflow });

  const result = await controller.start();

  assert.equal(result.status, 'revoked');
  assert.equal(result.packReady, false);
  assert.equal(result.digests.install, installDigest);
  assert.equal(result.message, 'Store access was revoked. Local learning history is preserved.');
});

test('offline commerce failure keeps the last verified pack ready with calm retry copy', async () => {
  const offline = Object.assign(new Error('private diagnostic must not render'), {
    code: 'GATEWAY_OFFLINE',
  });
  const workflow = Object.freeze({
    async start() {
      return Object.freeze({
        displayPrice: '£4.99', packReady: true, entitlementState: 'active',
        digests: Object.freeze({ ...DIGESTS, install: '2'.repeat(64) }),
      });
    },
    async purchase() { throw offline; },
    async restore() { throw new Error('not used'); },
    async redownload() { throw new Error('not used'); },
  });
  const controller = createB3ProofController({ workflow });

  await controller.start();
  const result = await controller.buy();

  assert.equal(result.status, 'failed');
  assert.equal(result.packReady, true);
  assert.equal(result.message, 'The store is unavailable. Your installed pack is safe; try again later.');
  assert.doesNotMatch(JSON.stringify(result), /private diagnostic|GATEWAY_OFFLINE/);
});

test('Parent actions are serialised so a late purchase cannot overwrite restore state', async () => {
  const calls = [];
  let releasePurchase;
  const purchaseReady = new Promise((resolve) => { releasePurchase = resolve; });
  let markPurchaseStarted;
  const purchaseStarted = new Promise((resolve) => { markPurchaseStarted = resolve; });
  const workflow = Object.freeze({
    async start() {
      return Object.freeze({
        displayPrice: '£4.99', packReady: false, entitlementState: 'none',
        digests: DIGESTS,
      });
    },
    async purchase() {
      calls.push('purchase:start');
      markPurchaseStarted();
      await purchaseReady;
      calls.push('purchase:end');
      return Object.freeze({ state: 'cancelled' });
    },
    async restore() {
      calls.push('restore');
      return Object.freeze({ state: 'restored', packReady: false });
    },
    async redownload() { throw new Error('not used'); },
  });
  const controller = createB3ProofController({ workflow });
  await controller.start();

  const purchase = controller.buy();
  const restore = controller.restore();
  await purchaseStarted;
  assert.deepEqual(calls, ['purchase:start']);
  releasePurchase();
  await Promise.all([purchase, restore]);

  assert.deepEqual(calls, ['purchase:start', 'purchase:end', 'restore']);
  assert.equal(controller.getState().status, 'restored');
});

test('published evidence is exact closed frozen data and disposal is idempotent', async () => {
  const mutableDigests = { ...DIGESTS };
  let disposals = 0;
  const workflow = Object.freeze({
    async start() {
      return {
        displayPrice: '£4.99', packReady: false, entitlementState: 'none',
        digests: mutableDigests,
      };
    },
    async purchase() { throw new Error('not used'); },
    async restore() { throw new Error('not used'); },
    async redownload() { throw new Error('not used'); },
    async dispose() { disposals += 1; },
  });
  const controller = createB3ProofController({ workflow });
  await controller.start();
  mutableDigests.manifest = '9'.repeat(64);

  const state = controller.getState();
  assert.deepEqual(Reflect.ownKeys(state), [
    'status', 'message', 'displayPrice', 'packReady', 'digests',
  ]);
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.digests), true);
  assert.equal(state.digests.manifest, DIGESTS.manifest);
  await controller.dispose();
  await controller.dispose();
  assert.equal(disposals, 1);
  await assert.rejects(controller.buy(), /disposed/i);
});

test('an immediate Parent action waits for readiness and offline restore/redownload stay calm', async () => {
  const calls = [];
  const workflow = Object.freeze({
    async start() {
      calls.push('start');
      return Object.freeze({
        displayPrice: '£4.99', packReady: true, entitlementState: 'active',
        digests: Object.freeze({ ...DIGESTS, install: '3'.repeat(64) }),
      });
    },
    async purchase() {
      calls.push('purchase');
      return Object.freeze({ state: 'cancelled' });
    },
    async restore() { throw Object.assign(new Error('offline'), { code: 'GATEWAY_OFFLINE' }); },
    async redownload() { throw Object.assign(new Error('offline'), { code: 'GATEWAY_OFFLINE' }); },
  });
  const controller = createB3ProofController({ workflow });

  assert.equal((await controller.buy()).status, 'cancelled');
  assert.deepEqual(calls, ['start', 'purchase']);
  assert.equal((await controller.restore()).status, 'failed');
  const redownload = await controller.redownload();
  assert.equal(redownload.status, 'failed');
  assert.equal(redownload.packReady, true);
});

test('delayed transaction reconciliation republishes pending and revoked states', async () => {
  let transactionState = 'pending';
  const base = {
    displayPrice: '£4.99', packReady: false,
    digests: Object.freeze({ ...DIGESTS, install: '4'.repeat(64) }),
  };
  const workflow = Object.freeze({
    async start() { return { ...base, entitlementState: 'none' }; },
    async sync() {
      return {
        ...base,
        entitlementState: transactionState === 'revoked' ? 'revoked' : 'none',
        transactionState,
      };
    },
    async purchase() { throw new Error('not used'); },
    async restore() { throw new Error('not used'); },
    async redownload() { throw new Error('not used'); },
  });
  const controller = createB3ProofController({ workflow });
  await controller.start();

  assert.equal((await controller.sync()).status, 'pending');
  transactionState = 'revoked';
  assert.equal((await controller.sync()).status, 'revoked');
});

test('verified revocation overrides a stale completed transaction state', async () => {
  const workflow = Object.freeze({
    async start() {
      return Object.freeze({
        displayPrice: '£4.99', packReady: false, entitlementState: 'active',
        digests: DIGESTS,
      });
    },
    async sync() {
      return Object.freeze({
        displayPrice: '£4.99', packReady: false,
        entitlementState: 'revoked', transactionState: 'complete',
        digests: DIGESTS,
      });
    },
    async purchase() { throw new Error('not used'); },
    async restore() { throw new Error('not used'); },
    async redownload() { throw new Error('not used'); },
  });
  const controller = createB3ProofController({ workflow });
  await controller.start();

  const revoked = await controller.sync();

  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.message, 'Store access was revoked. Local learning history is preserved.');
});

test('verified revocation overrides a simultaneous recoverable sync failure', async () => {
  const workflow = Object.freeze({
    async start() {
      return Object.freeze({
        displayPrice: '£4.99', packReady: false,
        entitlementState: 'revoked', startupFailed: true,
        digests: DIGESTS,
      });
    },
    async sync() {
      return Object.freeze({
        displayPrice: '£4.99', packReady: false,
        entitlementState: 'revoked', startupFailed: true,
        transactionState: 'complete', digests: DIGESTS,
      });
    },
    async purchase() { throw new Error('not used'); },
    async restore() { throw new Error('not used'); },
    async redownload() { throw new Error('not used'); },
  });
  const controller = createB3ProofController({ workflow });

  assert.equal((await controller.start()).status, 'revoked');
  assert.equal((await controller.sync()).status, 'revoked');
});

test('Buy and Restore publish exact revoked, pending and cancelled outcomes', async (t) => {
  for (const action of ['buy', 'restore']) {
    for (const outcome of ['revoked', 'pending', 'cancelled']) {
      await t.test(`${action} ${outcome}`, async () => {
        const workflow = Object.freeze({
          async start() {
            return Object.freeze({
              displayPrice: '£4.99', packReady: true,
              entitlementState: 'active',
              digests: Object.freeze({ ...DIGESTS, install: '5'.repeat(64) }),
            });
          },
          async purchase() { return Object.freeze({ state: outcome }); },
          async restore() { return Object.freeze({ state: outcome, packReady: true }); },
          async redownload() { throw new Error('not used'); },
        });
        const controller = createB3ProofController({ workflow });
        await controller.start();

        const result = await controller[action]();

        assert.equal(result.status, outcome);
        assert.equal(result.packReady, outcome === 'revoked' ? false : true);
      });
    }
  }
});
