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
