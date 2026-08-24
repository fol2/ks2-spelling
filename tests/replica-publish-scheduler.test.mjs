import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createReplicaPublishScheduler,
} from '../src/app/replica-publish-scheduler.js';

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('condition did not settle');
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function createLifecycleProbe() {
  const listeners = { pause: new Set(), resume: new Set() };
  const subscribe = (kind, listener) => {
    listeners[kind].add(listener);
    return Object.freeze({
      async remove() {
        listeners[kind].delete(listener);
      },
    });
  };
  return Object.freeze({
    lifecycle: Object.freeze({
      onPause: (listener) => subscribe('pause', listener),
      onResume: (listener) => subscribe('resume', listener),
    }),
    emit(kind) {
      for (const listener of listeners[kind]) {
        assert.equal(listener(), undefined);
      }
    },
  });
}

test('replica scheduling returns while publication is still pending', async () => {
  let started = false;
  const scheduler = createReplicaPublishScheduler({
    publishLearner() {
      started = true;
      return new Promise(() => {});
    },
  });

  await scheduler.schedule('learner-a');

  assert.equal(started, true);
  assert.deepEqual(scheduler.getDiagnosticState().inFlightLearnerIds, ['learner-a']);
});

test('replica failures are diagnostic-only and do not stop a later schedule', async () => {
  const calls = [];
  const scheduler = createReplicaPublishScheduler({
    publishLearner(learnerId) {
      calls.push(learnerId);
      if (calls.length === 1) {
        throw Object.assign(new Error('replica unavailable'), { code: 'offline' });
      }
    },
  });

  assert.equal(scheduler.schedule('learner-a'), undefined);
  await waitFor(() => scheduler.getDiagnosticState().lastError !== null);
  assert.deepEqual(scheduler.getDiagnosticState().lastError, {
    message: 'replica unavailable',
    code: 'offline',
  });

  assert.equal(scheduler.schedule('learner-a'), undefined);
  await waitFor(() => calls.length === 2);
  assert.deepEqual(calls, ['learner-a', 'learner-a']);
  await scheduler.dispose();
});

test('replica scheduling coalesces repeated learner updates to one latest follow-up', async () => {
  const first = deferred();
  const calls = [];
  const scheduler = createReplicaPublishScheduler({
    publishLearner(learnerId) {
      calls.push(learnerId);
      return calls.length === 1 ? first.promise : undefined;
    },
  });

  scheduler.schedule('learner-a');
  await waitFor(() => calls.length === 1);
  scheduler.schedule('learner-a');
  scheduler.schedule('learner-a');
  scheduler.schedule('learner-a');
  assert.deepEqual(scheduler.getDiagnosticState().pendingLearnerIds, ['learner-a']);

  first.resolve();
  await waitFor(() => calls.length === 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['learner-a', 'learner-a']);
  await scheduler.dispose();
});

test('replica scheduling keeps distinct learners independent', async () => {
  const releases = new Map([
    ['learner-a', deferred()],
    ['learner-b', deferred()],
  ]);
  const calls = [];
  const scheduler = createReplicaPublishScheduler({
    publishLearner(learnerId) {
      calls.push(learnerId);
      return releases.get(learnerId).promise;
    },
  });

  scheduler.schedule('learner-a');
  scheduler.schedule('learner-b');
  await waitFor(() => calls.length === 2);

  assert.deepEqual(calls, ['learner-a', 'learner-b']);
  assert.deepEqual(
    scheduler.getDiagnosticState().inFlightLearnerIds,
    ['learner-a', 'learner-b'],
  );
  releases.get('learner-a').resolve();
  releases.get('learner-b').resolve();
  await waitFor(() => scheduler.getDiagnosticState().inFlightLearnerIds.length === 0);
  await scheduler.dispose();
});

test('replica scheduling preserves the latest pending learner across pause and resume', async () => {
  const first = deferred();
  const second = deferred();
  const calls = [];
  const lifecycleProbe = createLifecycleProbe();
  const scheduler = createReplicaPublishScheduler({
    lifecycle: lifecycleProbe.lifecycle,
    publishLearner(learnerId) {
      calls.push(learnerId);
      return calls.length === 1 ? first.promise : second.promise;
    },
  });

  scheduler.schedule('learner-a');
  await waitFor(() => calls.length === 1);
  scheduler.schedule('learner-a');
  lifecycleProbe.emit('pause');
  first.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, ['learner-a']);
  assert.deepEqual(scheduler.getDiagnosticState().pendingLearnerIds, ['learner-a']);
  lifecycleProbe.emit('resume');
  await waitFor(() => calls.length === 2);
  second.resolve();
  await scheduler.dispose();
});

test('replica scheduler disposal flushes the latest pending publish', async () => {
  const first = deferred();
  const second = deferred();
  const calls = [];
  const scheduler = createReplicaPublishScheduler({
    publishLearner(learnerId) {
      calls.push(learnerId);
      return calls.length === 1 ? first.promise : second.promise;
    },
  });

  scheduler.schedule('learner-a');
  await waitFor(() => calls.length === 1);
  scheduler.schedule('learner-a');
  let disposed = false;
  const disposing = scheduler.dispose().then(() => { disposed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposed, false);

  first.resolve();
  await waitFor(() => calls.length === 2);
  assert.equal(disposed, false);
  second.resolve();
  await disposing;

  assert.deepEqual(calls, ['learner-a', 'learner-a']);
  assert.deepEqual(scheduler.getDiagnosticState().pendingLearnerIds, []);
  assert.deepEqual(scheduler.getDiagnosticState().inFlightLearnerIds, []);
});

test('replica scheduler marks publication completion without learner content', async (t) => {
  performance.clearMarks('product:replica-publish-complete');
  t.after(() => performance.clearMarks('product:replica-publish-complete'));
  const publication = deferred();
  const scheduler = createReplicaPublishScheduler({
    publishLearner() { return publication.promise; },
  });

  scheduler.schedule('learner-a');
  await waitFor(() => scheduler.getDiagnosticState().inFlightLearnerIds.length === 1);
  assert.equal(
    performance.getEntriesByName('product:replica-publish-complete').length,
    0,
  );

  publication.resolve();
  await waitFor(() => scheduler.getDiagnosticState().inFlightLearnerIds.length === 0);
  assert.deepEqual(
    performance.getEntriesByType('mark')
      .filter(({ name }) => name === 'product:replica-publish-complete')
      .map(({ name }) => name),
    ['product:replica-publish-complete'],
  );
  await scheduler.dispose();
});
