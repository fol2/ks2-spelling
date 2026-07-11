import assert from 'node:assert/strict';
import test from 'node:test';

import { createDatabaseCommandGate } from '../src/platform/database/database-command-gate.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function assertPaused(error) {
  assert.equal(error?.code, 'sqlite_commands_paused');
  assert.equal(error?.message, 'sqlite_commands_paused');
  return true;
}

test('command gate exposes only the exact internal FIFO lifecycle surface', () => {
  const gate = createDatabaseCommandGate();

  assert.deepEqual(Object.keys(gate), [
    'run',
    'pauseAndDrain',
    'resume',
    'isAccepting',
    'waitForIdle',
  ]);
  assert.equal(Object.isFrozen(gate), true);
  assert.equal(gate.isAccepting(), true);
});

test('pause rejects accepted queued work and drains only the active owner', async () => {
  const gate = createDatabaseCommandGate();
  const activeStarted = deferred();
  const releaseActive = deferred();
  const order = [];

  const active = gate.run(async () => {
    order.push('active-start');
    activeStarted.resolve();
    await releaseActive.promise;
    order.push('active-end');
    return 'active-result';
  });
  await activeStarted.promise;

  const queued = gate.run(async () => {
    order.push('queued-ran');
    return 'queued-result';
  });
  const queuedRejected = assert.rejects(queued, assertPaused);
  const drained = gate.pauseAndDrain();

  assert.equal(gate.isAccepting(), false);
  await queuedRejected;
  assert.deepEqual(order, ['active-start']);

  let drainSettled = false;
  void drained.then(() => {
    drainSettled = true;
  });
  await Promise.resolve();
  assert.equal(drainSettled, false);

  releaseActive.resolve();
  assert.equal(await active, 'active-result');
  await drained;
  assert.deepEqual(order, ['active-start', 'active-end']);
  await gate.waitForIdle();
});

test('new active executor is invoked before run returns and cannot cross a same-turn pause', async () => {
  const gate = createDatabaseCommandGate();
  const releaseActive = deferred();
  let starts = 0;

  const active = gate.run(() => {
    starts += 1;
    return releaseActive.promise;
  });
  assert.equal(starts, 1, 'connection ownership must be linearised before run returns');

  const draining = gate.pauseAndDrain();
  assert.equal(starts, 1, 'pause must not allow a not-yet-invoked active executor to start');
  releaseActive.resolve('done');
  assert.equal(await active, 'done');
  await draining;
  assert.equal(starts, 1);
});

test('concurrent pauses reject every queued item once and share the active drain boundary', async () => {
  const gate = createDatabaseCommandGate();
  const releaseActive = deferred();
  const order = [];
  const active = gate.run(async () => {
    order.push('active');
    await releaseActive.promise;
  });
  const queued = Array.from({ length: 3 }, (_, index) =>
    gate.run(async () => {
      order.push(`queued-${index}`);
    }),
  );
  const queuedRejections = queued.map((promise) => assert.rejects(promise, assertPaused));

  const firstPause = gate.pauseAndDrain();
  const secondPause = gate.pauseAndDrain();
  await Promise.all(queuedRejections);
  assert.deepEqual(order, ['active']);
  assert.throws(() => gate.resume(), /sqlite_commands_not_idle/);

  let firstSettled = false;
  let secondSettled = false;
  void firstPause.then(() => {
    firstSettled = true;
  });
  void secondPause.then(() => {
    secondSettled = true;
  });
  await Promise.resolve();
  assert.deepEqual([firstSettled, secondSettled], [false, false]);

  releaseActive.resolve();
  await active;
  await Promise.all([firstPause, secondPause]);
  assert.deepEqual([firstSettled, secondSettled], [true, true]);
  assert.deepEqual(order, ['active']);
});

test('a rejected active executor releases ownership and resume requires idle state', async () => {
  const gate = createDatabaseCommandGate();
  const activeStarted = deferred();
  const releaseActive = deferred();
  const active = gate.run(async () => {
    activeStarted.resolve();
    await releaseActive.promise;
    throw new Error('active_failed');
  });
  await activeStarted.promise;

  const draining = gate.pauseAndDrain();
  assert.throws(() => gate.resume(), /sqlite_commands_not_idle/);
  await assert.rejects(gate.run(async () => undefined), assertPaused);

  releaseActive.resolve();
  await assert.rejects(active, /active_failed/);
  await draining;
  await gate.waitForIdle();

  gate.resume();
  assert.equal(gate.isAccepting(), true);
  assert.equal(await gate.run(async () => 'resumed'), 'resumed');
});

test('FIFO execution survives an earlier executor rejection', async () => {
  const gate = createDatabaseCommandGate();
  const order = [];

  const first = gate.run(async () => {
    order.push('first');
    throw new Error('first_failed');
  });
  const second = gate.run(async () => {
    order.push('second');
    return 2;
  });
  const third = gate.run(async () => {
    order.push('third');
    return 3;
  });

  await assert.rejects(first, /first_failed/);
  assert.equal(await second, 2);
  assert.equal(await third, 3);
  await gate.waitForIdle();
  assert.deepEqual(order, ['first', 'second', 'third']);
});

test('synchronous executor throw releases ownership for waitForIdle and later resume', async () => {
  const gate = createDatabaseCommandGate();
  const failed = gate.run(() => {
    throw new Error('synchronous_failure');
  });
  const idle = gate.waitForIdle();

  await assert.rejects(failed, /synchronous_failure/);
  await idle;
  await gate.pauseAndDrain();
  gate.resume();
  assert.equal(await gate.run(() => 'recovered'), 'recovered');
  await gate.waitForIdle();
});

test('waitForIdle covers the active owner and the complete accepted FIFO queue', async () => {
  const gate = createDatabaseCommandGate();
  const releaseFirst = deferred();
  const order = [];
  const first = gate.run(async () => {
    order.push('first-start');
    await releaseFirst.promise;
    order.push('first-end');
  });
  const second = gate.run(async () => {
    order.push('second');
  });
  const idle = gate.waitForIdle();
  let settled = false;
  void idle.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);

  releaseFirst.resolve();
  await Promise.all([first, second, idle]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
  assert.equal(settled, true);
});
