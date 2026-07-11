import assert from 'node:assert/strict';
import test from 'node:test';

function createNativeAppProbe({ native = true } = {}) {
  const callbacks = new Map();
  const removals = [];
  const App = {
    addListener(eventName, callback) {
      callbacks.set(eventName, callback);
      return Promise.resolve({
        async remove() {
          removals.push(eventName);
        },
      });
    },
  };
  return {
    App,
    Capacitor: { isNativePlatform: () => native },
    callbacks,
    removals,
  };
}

test('lifecycle contract accepts only the exact frozen surface', async () => {
  const { assertAppLifecycle } = await import(
    '../src/platform/lifecycle/app-lifecycle-contract.js'
  );
  const probe = createNativeAppProbe();
  const { createCapacitorAppLifecycle } = await import(
    '../src/platform/lifecycle/capacitor-app-lifecycle.js'
  );
  const lifecycle = createCapacitorAppLifecycle(probe);

  assert.equal(assertAppLifecycle(lifecycle), lifecycle);
  assert.deepEqual(Object.keys(lifecycle), [
    'onPause',
    'onResume',
    'onStateChange',
    'getState',
    'dispose',
  ]);
  assert.equal(Object.isFrozen(lifecycle), true);
  await lifecycle.dispose();
});

test('Capacitor lifecycle fails closed outside a native platform', async () => {
  const probe = createNativeAppProbe({ native: false });
  const { createCapacitorAppLifecycle } = await import(
    '../src/platform/lifecycle/capacitor-app-lifecycle.js'
  );

  assert.throws(
    () => createCapacitorAppLifecycle(probe),
    (error) => error?.code === 'native_lifecycle_required',
  );
  assert.equal(probe.callbacks.size, 0);
});

test('pause and resume are canonical while appStateChange is diagnostic only', async () => {
  const probe = createNativeAppProbe();
  const { createCapacitorAppLifecycle } = await import(
    '../src/platform/lifecycle/capacitor-app-lifecycle.js'
  );
  const lifecycle = createCapacitorAppLifecycle(probe);
  const events = [];
  lifecycle.onPause(() => events.push('pause'));
  lifecycle.onResume(() => events.push('resume'));
  lifecycle.onStateChange((state) => events.push(['state', state]));
  await Promise.resolve();

  probe.callbacks.get('pause')();
  probe.callbacks.get('pause')();
  probe.callbacks.get('appStateChange')({ isActive: false });
  probe.callbacks.get('resume')();
  probe.callbacks.get('appStateChange')({ isActive: true });

  assert.deepEqual(events, [
    'pause',
    'pause',
    ['state', { isActive: false }],
    'resume',
    ['state', { isActive: true }],
  ]);
  assert.deepEqual(lifecycle.getState(), {
    canonicalState: 'active',
    diagnosticStateChanges: [false, true],
  });
  await lifecycle.dispose();
});

test('dispose removes every native listener exactly once and makes callbacks inert', async () => {
  const probe = createNativeAppProbe();
  const { createCapacitorAppLifecycle } = await import(
    '../src/platform/lifecycle/capacitor-app-lifecycle.js'
  );
  const lifecycle = createCapacitorAppLifecycle(probe);
  let calls = 0;
  lifecycle.onPause(() => {
    calls += 1;
  });
  lifecycle.onResume(() => {
    calls += 1;
  });
  lifecycle.onStateChange(() => {
    calls += 1;
  });
  await Promise.resolve();

  const captured = [...probe.callbacks.values()];
  await Promise.all([lifecycle.dispose(), lifecycle.dispose()]);
  for (const callback of captured) callback({ isActive: true });

  assert.equal(calls, 0);
  assert.throws(() => lifecycle.onPause(null), /must be a function/);
  assert.throws(() => lifecycle.onResume('listener'), /must be a function/);
  assert.throws(() => lifecycle.onStateChange({}), /must be a function/);
  assert.deepEqual(probe.removals.toSorted(), [
    'appStateChange',
    'pause',
    'resume',
  ]);
});
