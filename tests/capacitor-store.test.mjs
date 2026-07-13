import assert from 'node:assert/strict';
import test from 'node:test';

import { registerPlugin } from '@capacitor/core';

const APPLE_PRODUCT_ID = 'uk.eugnel.ks2spelling.fullks2';

function product() {
  return {
    productId: APPLE_PRODUCT_ID,
    displayName: 'Full KS2',
    description: 'The complete statutory spelling catalogue.',
    displayPrice: '£4.99',
    currencyCode: 'GBP',
  };
}

function observation(outcome, extra = {}) {
  return {
    store: 'apple',
    environment: 'sandbox',
    productId: APPLE_PRODUCT_ID,
    outcome,
    transactionRef: `native-${outcome}`,
    ...extra,
  };
}

function createCommerce(overrides = {}) {
  return {
    queryProducts: async () => ({ products: [product()] }),
    purchase: async () => observation('cancelled'),
    queryTransactions: async () => ({ transactions: [] }),
    restore: async () => ({ transactions: [] }),
    finishTransaction: async () => ({ completion: 'finished' }),
    addListener: async (_eventName, _listener) => ({ remove: async () => {} }),
    ...overrides,
  };
}

test('Capacitor store maps exact requests and closed product results', async () => {
  const { createCapacitorStore } = await import(
    '../src/platform/commerce/capacitor-store.js'
  );
  const calls = [];
  const store = createCapacitorStore({
    Commerce: createCommerce({
      queryProducts: async (request) => {
        calls.push(request);
        return { products: [product()] };
      },
    }),
  });
  const result = await store.queryProducts({ productIds: [APPLE_PRODUCT_ID] });

  assert.deepEqual(calls, [{ productIds: [APPLE_PRODUCT_ID] }]);
  assert.deepEqual(result, [product()]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result[0]), true);
});

test('Capacitor store accepts the genuine Capacitor 8 zero-own-key plugin proxy', async () => {
  const { createCapacitorStore } = await import(
    '../src/platform/commerce/capacitor-store.js'
  );
  const Commerce = registerPlugin('Task7ReviewCommerceProxy');
  assert.deepEqual(Reflect.ownKeys(Commerce), []);

  const store = createCapacitorStore({ Commerce });
  assert.deepEqual(Reflect.ownKeys(store), [
    'queryProducts',
    'purchase',
    'queryTransactions',
    'restore',
    'finishTransaction',
    'subscribeTransactionUpdates',
  ]);
  assert.equal(Object.isFrozen(store), true);
});

test('Capacitor store preserves cancel, pending, purchase, revoke and unverified parity', async () => {
  const { createCapacitorStore } = await import(
    '../src/platform/commerce/capacitor-store.js'
  );
  for (const [outcome, extra] of [
    ['cancelled', {}],
    ['pending', {}],
    ['purchased', { opaqueProof: 'verified-jws' }],
    ['revoked', { opaqueProof: 'verified-revocation-jws' }],
    ['unverified', {}],
  ]) {
    const store = createCapacitorStore({
      Commerce: createCommerce({ purchase: async () => observation(outcome, extra) }),
    });
    assert.deepEqual(
      await store.purchase({ productId: APPLE_PRODUCT_ID }),
      observation(outcome, extra),
    );
  }
});

test('Capacitor store permits ordered duplicate callbacks for one requested product', async () => {
  const { createCapacitorStore } = await import(
    '../src/platform/commerce/capacitor-store.js'
  );
  const transactions = [
    observation('purchased', { opaqueProof: 'first-jws' }),
    observation('revoked', { opaqueProof: 'revocation-jws' }),
  ];
  const store = createCapacitorStore({
    Commerce: createCommerce({ queryTransactions: async () => ({ transactions }) }),
  });
  assert.deepEqual(
    await store.queryTransactions({ productIds: [APPLE_PRODUCT_ID] }),
    transactions,
  );
});

test('Capacitor store validates transaction updates and provides an owned disposer', async () => {
  const { createCapacitorStore } = await import(
    '../src/platform/commerce/capacitor-store.js'
  );
  let nativeListener;
  let removed = 0;
  const store = createCapacitorStore({
    Commerce: createCommerce({
      addListener: async (name, listener) => {
        assert.equal(name, 'transactionUpdated');
        nativeListener = listener;
        return { remove: async () => { removed += 1; } };
      },
    }),
  });
  const seen = [];
  const subscription = await store.subscribeTransactionUpdates((value) => seen.push(value));
  await nativeListener(observation('purchased', { opaqueProof: 'update-jws' }));
  await subscription.remove();

  assert.deepEqual(seen, [observation('purchased', { opaqueProof: 'update-jws' })]);
  assert.deepEqual(Reflect.ownKeys(subscription), ['remove']);
  assert.equal(removed, 1);
});

test('Capacitor store rejects non-Promises and native authority leakage', async () => {
  const { createCapacitorStore } = await import(
    '../src/platform/commerce/capacitor-store.js'
  );
  const cases = [
    createCommerce({ queryProducts: () => ({ products: [product()] }) }),
    createCommerce({ purchase: async () => ({
      ...observation('purchased', { opaqueProof: 'verified-jws' }),
      entitlementId: 'full-ks2',
    }) }),
    createCommerce({ purchase: async () => ({
      ...observation('purchased', { opaqueProof: 'verified-jws' }),
      storeTransactionId: '12345',
    }) }),
    createCommerce({ purchase: async () => ({
      ...observation('pending'),
      opaqueProof: 'must-not-exist',
    }) }),
    createCommerce({ queryProducts: async () => ({ products: [{ ...product(), price: 4.99 }] }) }),
  ];

  await assert.rejects(
    createCapacitorStore({ Commerce: cases[0] }).queryProducts({ productIds: [APPLE_PRODUCT_ID] }),
    /Promise/i,
  );
  for (const Commerce of cases.slice(1, 4)) {
    await assert.rejects(
      createCapacitorStore({ Commerce }).purchase({ productId: APPLE_PRODUCT_ID }),
      /closed|fields|proof/i,
    );
  }
  await assert.rejects(
    createCapacitorStore({ Commerce: cases[4] }).queryProducts({ productIds: [APPLE_PRODUCT_ID] }),
    /closed|fields/i,
  );
});

test('Capacitor store never invokes hostile native accessors', async () => {
  const { createCapacitorStore } = await import(
    '../src/platform/commerce/capacitor-store.js'
  );
  let getterCalls = 0;
  const hostile = observation('pending');
  Object.defineProperty(hostile, 'outcome', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'pending';
    },
  });
  const store = createCapacitorStore({
    Commerce: createCommerce({ purchase: async () => hostile }),
  });
  await assert.rejects(store.purchase({ productId: APPLE_PRODUCT_ID }), /data fields/i);
  assert.equal(getterCalls, 0);
});

test('Capacitor store rejects native product substitution before returning authority', async () => {
  const { createCapacitorStore } = await import(
    '../src/platform/commerce/capacitor-store.js'
  );
  const substituted = createCapacitorStore({
    Commerce: createCommerce({
      purchase: async () => ({
        ...observation('purchased', { opaqueProof: 'verified-jws' }),
        productId: 'uk.eugnel.ks2spelling.anotherproduct',
      }),
    }),
  });
  await assert.rejects(
    substituted.purchase({ productId: APPLE_PRODUCT_ID }),
    /product identity|requested product/i,
  );

  const unrequested = createCapacitorStore({
    Commerce: createCommerce({
      queryProducts: async () => ({ products: [{ ...product(), productId: 'full_ks2' }] }),
    }),
  });
  await assert.rejects(
    unrequested.queryProducts({ productIds: [APPLE_PRODUCT_ID] }),
    /unrequested.*product/i,
  );
});

test('Capacitor store removal is idempotent and blocks all later native events', async () => {
  const { createCapacitorStore } = await import(
    '../src/platform/commerce/capacitor-store.js'
  );
  let nativeListener;
  let removals = 0;
  const store = createCapacitorStore({
    Commerce: createCommerce({
      addListener: async (_name, listener) => {
        nativeListener = listener;
        return { remove: async () => { removals += 1; } };
      },
    }),
  });
  const seen = [];
  const subscription = await store.subscribeTransactionUpdates((event) => seen.push(event));
  await subscription.remove();
  await subscription.remove();
  await nativeListener({ learnerId: 'must never be validated after disposal' });
  assert.equal(removals, 1);
  assert.deepEqual(seen, []);
});

test('concurrent disposal shares one native removal operation', async () => {
  const { createCapacitorStore } = await import(
    '../src/platform/commerce/capacitor-store.js'
  );
  let nativeListener;
  let removals = 0;
  let release;
  const pendingRemoval = new Promise((resolve) => { release = resolve; });
  const store = createCapacitorStore({
    Commerce: createCommerce({
      addListener: async (_name, listener) => {
        nativeListener = listener;
        return {
          remove() {
            removals += 1;
            return pendingRemoval;
          },
        };
      },
    }),
  });
  const seen = [];
  const subscription = await store.subscribeTransactionUpdates((event) => seen.push(event));
  const first = subscription.remove();
  const second = subscription.remove();
  assert.equal(first, second);
  assert.equal(removals, 1);
  await nativeListener(observation('purchased', { opaqueProof: 'must-not-deliver' }));
  release();
  await Promise.all([first, second]);
  assert.deepEqual(seen, []);
});

test('failed native removal remains disposed but permits a real retry', async () => {
  const { createCapacitorStore } = await import(
    '../src/platform/commerce/capacitor-store.js'
  );
  let nativeListener;
  let removals = 0;
  const store = createCapacitorStore({
    Commerce: createCommerce({
      addListener: async (_name, listener) => {
        nativeListener = listener;
        return {
          remove() {
            removals += 1;
            return removals === 1
              ? Promise.reject(new Error('native secret'))
              : Promise.resolve();
          },
        };
      },
    }),
  });
  const seen = [];
  const subscription = await store.subscribeTransactionUpdates((event) => seen.push(event));
  await assert.rejects(subscription.remove(), ({ code }) => code === 'STORE_NATIVE_FAILURE');
  await nativeListener(observation('purchased', { opaqueProof: 'must-not-deliver' }));
  await subscription.remove();
  assert.equal(removals, 2);
  assert.deepEqual(seen, []);
});

test('Capacitor store rejects malformed plugin and request records before native work', async () => {
  const { createCapacitorStore } = await import(
    '../src/platform/commerce/capacitor-store.js'
  );
  let calls = 0;
  const Commerce = createCommerce({
    purchase: async () => {
      calls += 1;
      return observation('cancelled');
    },
  });
  const store = createCapacitorStore({ Commerce });
  for (const request of [
    { productId: APPLE_PRODUCT_ID, learnerId: 'learner-a' },
    Object.assign(Object.create({ productId: APPLE_PRODUCT_ID }), {}),
    { productId: 'not approved' },
  ]) {
    await assert.rejects(store.purchase(request), /closed|record|product|fields/i);
  }
  assert.equal(calls, 0);
  assert.throws(
    () => createCapacitorStore({ Commerce: { ...Commerce, unknownMethod() {} } }),
    /Commerce|methods|closed/i,
  );
  assert.throws(
    () => createCapacitorStore({ Commerce: Object.create(Commerce) }),
    /Commerce|prototype|closed/i,
  );
});
