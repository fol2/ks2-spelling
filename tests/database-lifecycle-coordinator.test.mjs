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
    subscriptionCount() {
      return Object.values(listeners).reduce((total, set) => total + set.size, 0);
    },
  });
}

function createConnectionProbe(name, failures = {}) {
  const calls = [];
  let open = false;
  const connection = Object.freeze({
    async open() {
      calls.push('open');
      const fails =
        typeof failures.open === 'function' ? failures.open() : failures.open;
      if (fails) throw new Error(`${name}_open_failed`);
      open = true;
    },
    async close() {
      calls.push('close');
      const fails =
        typeof failures.close === 'function' ? failures.close() : failures.close;
      if (fails) throw new Error(`${name}_close_failed`);
      open = false;
    },
    async execute(sql) {
      calls.push(['execute', sql]);
      return { changes: 0 };
    },
    async query(sql) {
      calls.push(['query', sql]);
      const checkpointFails =
        typeof failures.checkpoint === 'function'
          ? failures.checkpoint()
          : failures.checkpoint;
      if (sql === 'PRAGMA wal_checkpoint(PASSIVE)' && checkpointFails) {
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
  return { calls, connection, failures, isOpen: () => open, name };
}

function createRetryingNativeSqliteProbe(closeFailures = 2) {
  const calls = [];
  let remainingCloseFailures = closeFailures;
  let databaseSequence = 0;
  const CapacitorSQLite = Object.freeze({ plugin: 'fake-native-sqlite' });

  class SQLiteConnection {
    constructor(plugin) {
      assert.equal(plugin, CapacitorSQLite);
      calls.push(['manager.constructor']);
    }

    async createConnection(...args) {
      databaseSequence += 1;
      const databaseId = databaseSequence;
      calls.push(['manager.createConnection', databaseId, ...args]);
      return {
        async open() {
          calls.push(['database.open', databaseId]);
        },
        async execute() {
          return { changes: { changes: 0 } };
        },
        async run() {
          return { changes: { changes: 0 } };
        },
        async query(sql) {
          calls.push(['database.query', databaseId, sql]);
          return { values: [] };
        },
        async beginTransaction() {
          return { changes: { changes: 0 } };
        },
        async commitTransaction() {
          return { changes: { changes: 0 } };
        },
        async rollbackTransaction() {
          return { changes: { changes: 0 } };
        },
        async isTransactionActive() {
          return { result: false };
        },
      };
    }

    async closeConnection(...args) {
      calls.push(['manager.closeConnection', ...args]);
      if (remainingCloseFailures > 0) {
        remainingCloseFailures -= 1;
        throw new Error('native_close_uncertain');
      }
    }
  }

  return {
    calls,
    dependencies: {
      Capacitor: { isNativePlatform: () => true },
      CapacitorSQLite,
      SQLiteConnection,
    },
  };
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

async function waitFor(predicate, label) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for ${label}`);
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

test('coordinator resolves the selected learner after each migration and permits no selection', async () => {
  const { createDatabaseLifecycleCoordinator } = await import(
    '../src/app/database-lifecycle-coordinator.js'
  );
  const harness = createHarness({
    connections: [createConnectionProbe('first'), createConnectionProbe('second')],
  });
  let selectedLearnerId = null;
  delete harness.options.selectedLearnerId;
  harness.options.resolveSelectedLearnerId = async () => selectedLearnerId;
  const coordinator = createDatabaseLifecycleCoordinator(harness.options);

  await coordinator.start();
  assert.deepEqual(harness.rehydrations, []);
  harness.lifecycle.emit('pause');
  await waitForState(coordinator, 'paused');
  selectedLearnerId = 'learner-b';
  harness.lifecycle.emit('resume');
  await waitForState(coordinator, 'active');
  assert.deepEqual(harness.rehydrations, [
    [harness.available[1].connection, 'learner-b'],
  ]);
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
    const second = createConnectionProbe('second');
    const harness = createHarness({ connections: [first, second] });
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

    const callsBeforeDuplicatePause = first.calls.length;
    harness.lifecycle.emit('pause');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(coordinator.getDiagnosticState().state, 'failed');
    assert.equal(first.calls.length, callsBeforeDuplicatePause);
    assert.deepEqual(coordinator.getDiagnosticState().failures, diagnostic.failures);

    if (failure === 'close') {
      assert.equal(first.isOpen(), true, 'a rejected close may leave the connection live');
      harness.lifecycle.emit('resume');
      await waitFor(
        () => coordinator.getDiagnosticState().failures.length === 2,
        'the exact connection close retry to fail',
      );
      assert.equal(harness.created.length, 1, 'no replacement may open before close');
      assert.equal(first.isOpen(), true);
    }

    first.failures[failure] = false;
    harness.lifecycle.emit('resume');
    await waitForState(coordinator, 'active');
    assert.equal(harness.created.length, 2);
    assert.equal(first.isOpen(), false);
    assert.equal(second.isOpen(), true);
    await coordinator.dispose();
  });
}

for (const resumeFailure of ['open', 'migration']) {
  test(`active pause then resume ${resumeFailure} failure stays recoverable`, async () => {
    const { createDatabaseLifecycleCoordinator } = await import(
      '../src/app/database-lifecycle-coordinator.js'
    );
    const first = createConnectionProbe('first');
    const second = createConnectionProbe('second', {
      open: resumeFailure === 'open',
    });
    const third = createConnectionProbe('third');
    const harness = createHarness({
      connections: [first, second, third],
      migrationFailureAt: resumeFailure === 'migration' ? 1 : -1,
    });
    const coordinator = createDatabaseLifecycleCoordinator(harness.options);
    await coordinator.start();
    harness.lifecycle.emit('pause');
    await waitForState(coordinator, 'paused');

    harness.lifecycle.emit('resume');
    await waitForState(coordinator, 'failed');
    const failed = coordinator.getDiagnosticState();
    assert.equal(failed.failures.length, 1);
    assert.match(failed.failures[0].message, new RegExp(`${resumeFailure}_failed`));
    assert.equal(harness.gate.isAccepting(), false);
    assert.equal(harness.created.length, 2);
    assert.equal(first.isOpen(), false);
    assert.equal(second.isOpen(), false);

    harness.lifecycle.emit('pause');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(coordinator.getDiagnosticState(), failed);

    harness.lifecycle.emit('resume');
    await waitForState(coordinator, 'active');
    assert.equal(harness.created.length, 3);
    assert.equal(third.isOpen(), true);
    assert.deepEqual(coordinator.getDiagnosticState().failures, failed.failures);
    await coordinator.dispose();
  });
}

test('dispose retries the retained exact connection after a pause close failure', async () => {
  const { createDatabaseLifecycleCoordinator } = await import(
    '../src/app/database-lifecycle-coordinator.js'
  );
  const first = createConnectionProbe('first', { close: true });
  const harness = createHarness({
    connections: [first, createConnectionProbe('must-not-be-created')],
  });
  const coordinator = createDatabaseLifecycleCoordinator(harness.options);
  await coordinator.start();
  harness.lifecycle.emit('pause');
  await waitForState(coordinator, 'failed');
  assert.equal(first.isOpen(), true);

  first.failures.close = false;
  await coordinator.dispose();

  assert.equal(first.isOpen(), false);
  assert.equal(harness.created.length, 1);
  assert.equal(coordinator.getDiagnosticState().state, 'disposed');
});

test('coordinator retries the real Capacitor adapter close before replacement', async () => {
  const { createDatabaseLifecycleCoordinator } = await import(
    '../src/app/database-lifecycle-coordinator.js'
  );
  const { createCapacitorSqliteConnection } = await import(
    '../src/platform/database/capacitor-sqlite-connection.js'
  );
  const lifecycle = createLifecycleProbe();
  const commandGate = createDatabaseCommandGate();
  const native = createRetryingNativeSqliteProbe(2);
  const createdConnections = [];
  const coordinator = createDatabaseLifecycleCoordinator({
    lifecycle: lifecycle.lifecycle,
    commandGate,
    selectedLearnerId: 'learner-a',
    async createConnection() {
      const connection = await createCapacitorSqliteConnection(
        native.dependencies,
      );
      createdConnections.push(connection);
      return connection;
    },
    async migrate() {},
    async rehydrateSelectedLearner() {},
  });
  await coordinator.start();
  lifecycle.emit('pause');
  await waitForState(coordinator, 'failed');

  lifecycle.emit('resume');
  await waitFor(
    () => coordinator.getDiagnosticState().failures.length === 2,
    'second native close rejection',
  );
  assert.equal(createdConnections.length, 1);
  assert.equal(
    native.calls.filter(([name]) => name === 'manager.createConnection').length,
    1,
  );

  lifecycle.emit('resume');
  await waitForState(coordinator, 'active');
  assert.equal(createdConnections.length, 2);
  const createIndexes = native.calls
    .map(([name], index) => (name === 'manager.createConnection' ? index : -1))
    .filter((index) => index !== -1);
  const closeIndexes = native.calls
    .map(([name], index) => (name === 'manager.closeConnection' ? index : -1))
    .filter((index) => index !== -1);
  assert.equal(closeIndexes.length, 3);
  assert.equal(closeIndexes.every((index) => index < createIndexes[1]), true);
  assert.equal(coordinator.getDiagnosticState().failures.length, 2);
  assert.equal(commandGate.isAccepting(), true);
  await coordinator.dispose();
});

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

test('dispose during starting stops after the in-flight factory and never opens', async () => {
  const { createDatabaseLifecycleCoordinator } = await import(
    '../src/app/database-lifecycle-coordinator.js'
  );
  const harness = createHarness();
  const factoryStarted = deferred();
  const releaseFactory = deferred();
  const candidate = createConnectionProbe('candidate');
  harness.options.createConnection = async () => {
    harness.created.push(candidate);
    factoryStarted.resolve();
    await releaseFactory.promise;
    return candidate.connection;
  };
  const coordinator = createDatabaseLifecycleCoordinator(harness.options);
  const starting = coordinator.start();
  await factoryStarted.promise;
  assert.equal(coordinator.getDiagnosticState().state, 'starting');

  const disposing = coordinator.dispose();
  releaseFactory.resolve();
  await Promise.all([starting, disposing]);

  assert.deepEqual(candidate.calls, ['close']);
  assert.equal(harness.migrations.length, 0);
  assert.equal(harness.rehydrations.length, 0);
  assert.equal(harness.lifecycle.subscriptionCount(), 0);
  assert.equal(harness.gate.isAccepting(), false);
  assert.equal(coordinator.getDiagnosticState().state, 'disposed');
});

test('an immediate dispose cannot race start into installing subscriptions', async () => {
  const { createDatabaseLifecycleCoordinator } = await import(
    '../src/app/database-lifecycle-coordinator.js'
  );
  const harness = createHarness();
  const coordinator = createDatabaseLifecycleCoordinator(harness.options);

  await Promise.all([coordinator.start(), coordinator.dispose()]);

  assert.equal(harness.lifecycle.subscriptionCount(), 0);
  assert.equal(harness.created.length, 0);
  assert.equal(coordinator.getDiagnosticState().state, 'disposed');
});

test('dispose during resuming stops after migration and never rehydrates or resumes', async () => {
  const { createDatabaseLifecycleCoordinator } = await import(
    '../src/app/database-lifecycle-coordinator.js'
  );
  const first = createConnectionProbe('first');
  const second = createConnectionProbe('second');
  const harness = createHarness({ connections: [first, second] });
  const migrationStarted = deferred();
  const releaseMigration = deferred();
  harness.options.migrate = async (connection) => {
    harness.migrations.push(connection);
    if (harness.migrations.length === 2) {
      migrationStarted.resolve();
      await releaseMigration.promise;
    }
  };
  const coordinator = createDatabaseLifecycleCoordinator(harness.options);
  await coordinator.start();
  harness.lifecycle.emit('pause');
  await waitForState(coordinator, 'paused');
  harness.lifecycle.emit('resume');
  await migrationStarted.promise;
  assert.equal(coordinator.getDiagnosticState().state, 'resuming');

  const disposing = coordinator.dispose();
  releaseMigration.resolve();
  await disposing;

  assert.equal(harness.rehydrations.length, 1);
  assert.equal(harness.gate.isAccepting(), false);
  assert.equal(second.isOpen(), false);
  assert.equal(harness.lifecycle.subscriptionCount(), 0);
  assert.equal(coordinator.getDiagnosticState().state, 'disposed');
});
