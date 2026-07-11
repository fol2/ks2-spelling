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

function createLifecycleProbe() {
  const listeners = { pause: new Set(), resume: new Set(), state: new Set() };
  const subscribe = (kind, listener) => {
    listeners[kind].add(listener);
    let removed = false;
    return Object.freeze({
      async remove() {
        if (removed) return;
        removed = true;
        listeners[kind].delete(listener);
      },
    });
  };
  const lifecycle = Object.freeze({
    onPause: (listener) => subscribe('pause', listener),
    onResume: (listener) => subscribe('resume', listener),
    onStateChange: (listener) => subscribe('state', listener),
    getState: () => ({ canonicalState: 'unknown', diagnosticStateChanges: [] }),
    async dispose() {},
  });
  return Object.freeze({
    lifecycle,
    emit(kind, value) {
      for (const listener of Array.from(listeners[kind])) listener(value);
    },
  });
}

function createConnectionProbe(name, failures = {}) {
  const calls = [];
  let open = false;
  const connection = Object.freeze({
    async open() {
      calls.push('open');
      if (failures.open) throw new Error(`${name}_open_failed`);
      open = true;
    },
    async close() {
      calls.push('close');
      open = false;
      if (failures.close) throw new Error(`${name}_close_failed`);
    },
    async execute(sql) {
      calls.push(['execute', sql]);
      return { changes: 0 };
    },
    async query(sql) {
      calls.push(['query', sql]);
      if (sql === 'PRAGMA wal_checkpoint(PASSIVE)' && failures.checkpoint) {
        throw new Error(`${name}_checkpoint_failed`);
      }
      return [];
    },
    async begin() {},
    async commit() {},
    async rollback() {},
    async isTransactionActive() {
      return false;
    },
  });
  return { calls, connection, isOpen: () => open, name };
}

function createHarness({ connections, migrationFailureAt = -1 } = {}) {
  const lifecycle = createLifecycleProbe();
  const gate = createDatabaseCommandGate();
  const created = [];
  const migrations = [];
  const rehydrations = [];
  const available = connections ?? [createConnectionProbe('first')];
  const options = {
    lifecycle: lifecycle.lifecycle,
    commandGate: gate,
    selectedLearnerId: 'learner-a',
    async createConnection() {
      const probe = available[created.length];
      if (!probe) throw new Error('factory_exhausted');
      created.push(probe);
      return probe.connection;
    },
    async migrate(connection) {
      migrations.push(connection);
      if (migrations.length - 1 === migrationFailureAt) {
        throw new Error('migration_failed');
      }
    },
    async rehydrateSelectedLearner(connection, learnerId) {
      rehydrations.push([connection, learnerId]);
    },
  };
  return { available, created, gate, lifecycle, migrations, options, rehydrations };
}

async function waitForState(coordinator, expected) {
  for (let index = 0; index < 100; index += 1) {
    if (coordinator.getDiagnosticState().state === expected) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`Coordinator did not reach ${expected}: ${JSON.stringify(coordinator.getDiagnosticState())}`);
}

test('coordinator exposes exact surface and starts by opening, migrating and rehydrating', async () => {
  const { createDatabaseLifecycleCoordinator } = await import(
    '../src/app/database-lifecycle-coordinator.js'
  );
  const harness = createHarness();
  const coordinator = createDatabaseLifecycleCoordinator(harness.options);

  assert.deepEqual(Object.keys(coordinator), ['start', 'dispose', 'getDiagnosticState']);
  assert.equal(Object.isFrozen(coordinator), true);
  await coordinator.start();
  assert.equal(coordinator.getDiagnosticState().state, 'active');
  assert.deepEqual(harness.available[0].calls, ['open']);
  assert.equal(harness.migrations.length, 1);
  assert.deepEqual(harness.rehydrations, [
    [harness.available[0].connection, 'learner-a'],
  ]);
  assert.equal(harness.gate.isAccepting(), true);
  await coordinator.dispose();
});

test('duplicate events join/no-op and resume-before-pause does not reopen', async () => {
  const { createDatabaseLifecycleCoordinator } = await import(
    '../src/app/database-lifecycle-coordinator.js'
  );
  const harness = createHarness({
    connections: [createConnectionProbe('first'), createConnectionProbe('second')],
  });
  const coordinator = createDatabaseLifecycleCoordinator(harness.options);
  await coordinator.start();

  harness.lifecycle.emit('resume');
  harness.lifecycle.emit('resume');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.created.length, 1);

  harness.lifecycle.emit('pause');
  harness.lifecycle.emit('pause');
  await waitForState(coordinator, 'paused');
  assert.deepEqual(harness.available[0].calls.slice(-2), [
    ['query', 'PRAGMA wal_checkpoint(PASSIVE)'],
    'close',
  ]);

  harness.lifecycle.emit('resume');
  harness.lifecycle.emit('resume');
  await waitForState(coordinator, 'active');
  assert.equal(harness.created.length, 2);
  assert.deepEqual(harness.available[1].calls, ['open']);
  await coordinator.dispose();
});

test('pause rejects queued work before waiting for the currently owned command', async () => {
  const { createDatabaseLifecycleCoordinator } = await import(
    '../src/app/database-lifecycle-coordinator.js'
  );
  const harness = createHarness();
  const coordinator = createDatabaseLifecycleCoordinator(harness.options);
  await coordinator.start();
  const activeStarted = deferred();
  const releaseActive = deferred();
  const active = harness.gate.run(async () => {
    activeStarted.resolve();
    await releaseActive.promise;
    return 'committed';
  });
  await activeStarted.promise;
  let queuedRan = false;
  const queued = harness.gate.run(async () => {
    queuedRan = true;
  });
  const queuedRejected = assert.rejects(
    queued,
    (error) => error?.code === 'sqlite_commands_paused',
  );

  harness.lifecycle.emit('pause');
  await queuedRejected;
  assert.equal(queuedRan, false);
  assert.equal(harness.available[0].calls.includes('close'), false);
  releaseActive.resolve();
  assert.equal(await active, 'committed');
  await waitForState(coordinator, 'paused');
  await coordinator.dispose();
});

test('a rejected active transaction still drains and permits safe close', async () => {
  const { createDatabaseLifecycleCoordinator } = await import(
    '../src/app/database-lifecycle-coordinator.js'
  );
  const harness = createHarness();
  const coordinator = createDatabaseLifecycleCoordinator(harness.options);
  await coordinator.start();
  const activeStarted = deferred();
  const rejectActive = deferred();
  const active = harness.gate.run(async () => {
    activeStarted.resolve();
    await rejectActive.promise;
  });
  await activeStarted.promise;

  harness.lifecycle.emit('pause');
  rejectActive.reject(new Error('transaction_rolled_back'));
  await assert.rejects(active, /transaction_rolled_back/);
  await waitForState(coordinator, 'paused');
  assert.equal(harness.available[0].isOpen(), false);
  await coordinator.dispose();
});

for (const failure of ['checkpoint', 'close']) {
  test(`${failure} failure preserves diagnostics and commands stay paused`, async () => {
    const { createDatabaseLifecycleCoordinator } = await import(
      '../src/app/database-lifecycle-coordinator.js'
    );
    const first = createConnectionProbe('first', { [failure]: true });
    const harness = createHarness({ connections: [first] });
    const coordinator = createDatabaseLifecycleCoordinator(harness.options);
    await coordinator.start();
    harness.lifecycle.emit('pause');
    await waitForState(coordinator, 'failed');

    const diagnostic = coordinator.getDiagnosticState();
    assert.equal(diagnostic.failures.length, 1);
    assert.match(diagnostic.failures[0].message, new RegExp(`${failure}_failed`));
    assert.equal(harness.gate.isAccepting(), false);
    await assert.rejects(
      harness.gate.run(async () => 'must-not-run'),
      (error) => error?.code === 'sqlite_commands_paused',
    );
    assert.deepEqual(coordinator.getDiagnosticState().failures, diagnostic.failures);
    await coordinator.dispose();
  });
}

test('a later resume retries after migration failure without clearing failure history or bytes', async () => {
  const { createDatabaseLifecycleCoordinator } = await import(
    '../src/app/database-lifecycle-coordinator.js'
  );
  const first = createConnectionProbe('first');
  const second = createConnectionProbe('second');
  const harness = createHarness({
    connections: [first, second],
    migrationFailureAt: 0,
  });
  const coordinator = createDatabaseLifecycleCoordinator(harness.options);

  await assert.rejects(coordinator.start(), /migration_failed/);
  assert.equal(coordinator.getDiagnosticState().state, 'failed');
  assert.equal(harness.gate.isAccepting(), false);
  harness.lifecycle.emit('resume');
  await waitForState(coordinator, 'active');
  assert.equal(harness.created.length, 2);
  assert.equal(coordinator.getDiagnosticState().failures.length, 1);
  assert.equal(harness.gate.isAccepting(), true);
  await coordinator.dispose();
});

test('open failure can be retried by a later resume', async () => {
  const { createDatabaseLifecycleCoordinator } = await import(
    '../src/app/database-lifecycle-coordinator.js'
  );
  const harness = createHarness({
    connections: [
      createConnectionProbe('first', { open: true }),
      createConnectionProbe('second'),
    ],
  });
  const coordinator = createDatabaseLifecycleCoordinator(harness.options);
  await assert.rejects(coordinator.start(), /first_open_failed/);
  harness.lifecycle.emit('resume');
  await waitForState(coordinator, 'active');
  assert.equal(coordinator.getDiagnosticState().failures.length, 1);
  await coordinator.dispose();
});

test('dispose during a transition waits safely, closes once and ignores later events', async () => {
  const { createDatabaseLifecycleCoordinator } = await import(
    '../src/app/database-lifecycle-coordinator.js'
  );
  const harness = createHarness({
    connections: [createConnectionProbe('first'), createConnectionProbe('second')],
  });
  const coordinator = createDatabaseLifecycleCoordinator(harness.options);
  await coordinator.start();
  const release = deferred();
  const active = harness.gate.run(() => release.promise);
  harness.lifecycle.emit('pause');
  const disposing = coordinator.dispose();
  release.resolve('done');
  assert.equal(await active, 'done');
  await disposing;

  assert.equal(coordinator.getDiagnosticState().state, 'disposed');
  const created = harness.created.length;
  harness.lifecycle.emit('resume');
  harness.lifecycle.emit('pause');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.created.length, created);
  assert.equal(harness.gate.isAccepting(), false);
});
