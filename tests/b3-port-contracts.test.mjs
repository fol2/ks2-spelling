import assert from 'node:assert/strict';
import test from 'node:test';

const STORE_METHODS = [
  'queryProducts',
  'purchase',
  'queryTransactions',
  'restore',
  'finishTransaction',
  'subscribeTransactionUpdates',
];
const GATEWAY_METHODS = [
  'verifyTransaction',
  'completeTransaction',
  'refreshEntitlement',
  'authorisePackDownload',
];
const PACK_METHODS = [
  'getFreeBytes',
  'downloadRange',
  'inspectAndExtract',
  'sealAndInstall',
  'inventoryInstalledVersions',
  'removeOwnedTemporaryState',
];

function assertFrozenMethods(value, methods) {
  assert.equal(Object.isFrozen(value), true);
  assert.deepEqual(Reflect.ownKeys(value), methods);
  for (const method of methods) {
    const descriptor = Object.getOwnPropertyDescriptor(value, method);
    assert.equal(descriptor?.enumerable, true);
    assert.equal(descriptor?.writable, false);
    assert.equal(descriptor?.configurable, false);
    assert.equal(typeof descriptor?.value, 'function');
  }
}

function inherited(record) {
  return Object.assign(Object.create({ learnerId: 'learner-a' }), record);
}

test('B3 fakes expose only the exact frozen async port surfaces', async () => {
  const { createB3FakeStore } = await import(
    '../src/platform/fakes/create-b3-fake-store.js'
  );
  const { createB3FakeGateway } = await import(
    '../src/platform/fakes/create-b3-fake-gateway.js'
  );
  const { createB3FakePackTransfer } = await import(
    '../src/platform/fakes/create-b3-fake-pack-transfer.js'
  );

  const store = createB3FakeStore();
  const gateway = createB3FakeGateway();
  const transfer = createB3FakePackTransfer();
  assertFrozenMethods(store, STORE_METHODS);
  assertFrozenMethods(gateway, GATEWAY_METHODS);
  assertFrozenMethods(transfer, PACK_METHODS);

  for (const [port, method, input] of [
    [store, 'queryProducts', { productIds: ['full_ks2'] }],
    [gateway, 'verifyTransaction', {
      store: 'google',
      environment: 'sandbox',
      productId: 'full_ks2',
      opaqueProof: 'test-purchase-token',
    }],
    [transfer, 'getFreeBytes'],
  ]) {
    const result = input === undefined ? port[method]() : port[method](input);
    assert.equal(result instanceof Promise, true);
    await result;
  }
});

test('port inputs reject prototypes, accessors, symbols, unknown and learner fields', async () => {
  const { createB3FakeStore } = await import(
    '../src/platform/fakes/create-b3-fake-store.js'
  );
  const { createB3FakeGateway } = await import(
    '../src/platform/fakes/create-b3-fake-gateway.js'
  );
  const { createB3FakePackTransfer } = await import(
    '../src/platform/fakes/create-b3-fake-pack-transfer.js'
  );
  const store = createB3FakeStore();
  const gateway = createB3FakeGateway();
  const transfer = createB3FakePackTransfer();
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'productIds', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return ['full_ks2'];
    },
  });
  const symbolInput = { productIds: ['full_ks2'] };
  symbolInput[Symbol('secret')] = true;

  for (const value of [
    inherited({ productIds: ['full_ks2'] }),
    accessor,
    symbolInput,
    { productIds: ['full_ks2'], learnerId: 'learner-a' },
  ]) {
    await assert.rejects(store.queryProducts(value), /closed|fields|record/i);
  }
  await assert.rejects(
    gateway.verifyTransaction({
      store: 'google',
      environment: 'sandbox',
      productId: 'full_ks2',
      opaqueProof: 'proof',
      progress: {},
    }),
    /closed|fields|record/i,
  );
  await assert.rejects(
    transfer.removeOwnedTemporaryState({
      packId: 'b3-sandbox-proof',
      version: '1.0.0-b3.1',
      destinationPath: '/tmp/escape',
    }),
    /closed|fields|record/i,
  );
  assert.equal(getterCalls, 0);
});

test('B3 gateway fake scripts deterministic outcomes but creates fresh trace IDs', async () => {
  const { createB3FakeGateway } = await import(
    '../src/platform/fakes/create-b3-fake-gateway.js'
  );
  const request = {
    store: 'google',
    environment: 'sandbox',
    productId: 'full_ks2',
    opaqueProof: 'test-purchase-token',
  };
  const first = await createB3FakeGateway().verifyTransaction(request);
  const second = await createB3FakeGateway().verifyTransaction(request);

  assert.notEqual(first.traceId, second.traceId);
  assert.match(first.traceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const { traceId: ignoredFirst, ...firstStable } = first;
  const { traceId: ignoredSecond, ...secondStable } = second;
  assert.deepEqual(firstStable, secondStable);
  assert.equal(typeof ignoredFirst, 'string');
  assert.equal(typeof ignoredSecond, 'string');
});

test('B3 fake scripts are finite FIFO queues and returned records cannot mutate scripts', async () => {
  const { createB3FakeStore } = await import(
    '../src/platform/fakes/create-b3-fake-store.js'
  );
  const store = createB3FakeStore();
  const first = await store.queryProducts({ productIds: ['full_ks2'] });
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first[0]), true);
  assert.throws(() => { first[0].displayName = 'mutated'; }, TypeError);
  await assert.rejects(
    store.queryProducts({ productIds: ['full_ks2'] }),
    ({ code }) => code === 'B3_FAKE_SCRIPT_EXHAUSTED',
  );
});

test('pack-transfer results reject path-like logical tokens', async () => {
  const { createB3FakePackTransfer } = await import(
    '../src/platform/fakes/create-b3-fake-pack-transfer.js'
  );
  for (const installedPathToken of [
    'installed/../escape',
    'installed//escape',
    'installed/./escape',
  ]) {
    const transfer = createB3FakePackTransfer({
      sealOutcomes: [{
        installedPathToken,
        activationMarkerSha256: 'b'.repeat(64),
      }],
    });
    await assert.rejects(
      transfer.sealAndInstall({
        packId: 'b3-sandbox-proof',
        version: '1.0.0-b3.1',
        manifestSha256: 'a'.repeat(64),
      }),
      /logical path segments/i,
    );
  }
});

test('no-input pack operations reject accidental caller data', async () => {
  const { createB3FakePackTransfer } = await import(
    '../src/platform/fakes/create-b3-fake-pack-transfer.js'
  );
  const transfer = createB3FakePackTransfer();
  await assert.rejects(transfer.getFreeBytes({ learnerId: 'learner-a' }), /does not accept/i);
  await assert.rejects(
    transfer.inventoryInstalledVersions({ path: '/tmp' }),
    /does not accept/i,
  );
});

test('the frozen B1 native boundary remains unchanged', async () => {
  const { createB1FakeNativePorts } = await import(
    '../src/platform/fakes/create-b1-fake-native-ports.js'
  );
  const native = createB1FakeNativePorts();
  assert.equal(native.capabilities.mode, 'prototype-only');
  assert.equal(native.capabilities.commerce, false);
  await assert.rejects(
    native.commerce.purchase({ productId: 'full_ks2' }),
    ({ code }) => code === 'B1_CAPABILITY_NOT_ENABLED',
  );
});
