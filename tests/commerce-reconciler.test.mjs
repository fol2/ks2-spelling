import assert from 'node:assert/strict';
import test from 'node:test';

async function load() {
  return import('../src/app/commerce-reconciler.js');
}

test('commerce reconciler subscribes before recovery, serialises updates and owns one removable listener', async () => {
  const events = [];
  let listener;
  let removeCount = 0;
  const store = {
    async subscribeTransactionUpdates(value) {
      events.push('subscribe');
      listener = value;
      return { async remove() { events.push('remove'); removeCount += 1; } };
    },
  };
  let active = 0;
  let maximumActive = 0;
  const coordinator = {
    async handleObservation(value) {
      active += 1; maximumActive = Math.max(maximumActive, active);
      events.push(`event:${value.outcome}`);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
    },
    async recover() {
      active += 1; maximumActive = Math.max(maximumActive, active);
      events.push('recover');
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
    },
  };
  const { createCommerceReconciler } = await load();
  const reconciler = createCommerceReconciler({ store, coordinator });
  assert.deepEqual(Reflect.ownKeys(reconciler), ['start', 'resume', 'dispose']);
  assert.equal(Object.isFrozen(reconciler), true);
  await assert.rejects(reconciler.start('extra'), TypeError);
  await assert.rejects(reconciler.resume('extra'), TypeError);
  await assert.rejects(reconciler.dispose('extra'), TypeError);
  await Promise.all([reconciler.start(), reconciler.start()]);
  assert.deepEqual(events.slice(0, 2), ['subscribe', 'recover']);
  listener({ outcome: 'pending' });
  listener({ outcome: 'purchased' });
  await reconciler.resume();
  assert.equal(maximumActive, 1);
  await Promise.all([reconciler.dispose(), reconciler.dispose()]);
  assert.equal(removeCount, 1);
  listener({ outcome: 'revoked' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.includes('event:revoked'), false);
});

test('listener and transient recovery failures are contained without unhandled rejections', async () => {
  let listener;
  const store = {
    async subscribeTransactionUpdates(value) { listener = value; return { async remove() {} }; },
  };
  let attempts = 0;
  const coordinator = {
    async handleObservation() { throw new Error('transient observation failure'); },
    async recover() { attempts += 1; if (attempts === 1) throw new Error('offline'); },
  };
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    const { createCommerceReconciler } = await load();
    const reconciler = createCommerceReconciler({ store, coordinator });
    await assert.rejects(reconciler.start(), /offline/);
    await reconciler.resume();
    listener({ outcome: 'purchased' });
    await new Promise((resolve) => setImmediate(resolve));
    await reconciler.dispose();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('resume waits for the first subscription and dispose removes a late handle before returning', async () => {
  let resolveSubscription;
  let recoveries = 0;
  let removals = 0;
  const store = {
    async subscribeTransactionUpdates() {
      return new Promise((resolve) => { resolveSubscription = resolve; });
    },
  };
  const coordinator = {
    async handleObservation() {},
    async recover() { recoveries += 1; },
  };
  const { createCommerceReconciler } = await load();
  const reconciler = createCommerceReconciler({ store, coordinator });
  const resume = reconciler.resume();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recoveries, 0);
  let disposeReturned = false;
  const dispose = reconciler.dispose().then(() => { disposeReturned = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposeReturned, false);
  resolveSubscription({ async remove() { removals += 1; } });
  await assert.rejects(resume, /disposed/i);
  await dispose;
  assert.equal(removals, 1);
  assert.equal(recoveries, 0);
});

test('concurrent start and resume share one subscription and one recovery', async () => {
  let subscriptions = 0;
  let recoveries = 0;
  const store = {
    async subscribeTransactionUpdates() {
      subscriptions += 1;
      return { async remove() {} };
    },
  };
  const coordinator = {
    async handleObservation() {},
    async recover() {
      recoveries += 1;
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
  const { createCommerceReconciler } = await load();
  const reconciler = createCommerceReconciler({ store, coordinator });
  await Promise.all([reconciler.start(), reconciler.resume(), reconciler.resume()]);
  assert.equal(subscriptions, 1);
  assert.equal(recoveries, 1);
  await reconciler.dispose();
});
