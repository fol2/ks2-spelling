import * as sqlite from 'node:sqlite';

import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

if (typeof process.send !== 'function') {
  throw new Error('B3 capture-store SQL death child IPC is absent');
}

const targetEvent = Number(process.argv[2]);
const command = JSON.parse(
  Buffer.from(process.argv[3], 'base64url').toString('utf8'),
);

const writeKinds = [
  ['INSERT INTO b3_captures', 'capture'],
  ['INSERT INTO b3_commands', 'command'],
  ['UPDATE b3_authority_state SET next_allocation_sequence = 2', 'singleton'],
  ["UPDATE b3_capture_start_intents SET intent_state = 'ready'", 'intent'],
];
const beforeRunEvents = Object.freeze({ capture: 2, command: 5, singleton: 8, intent: 11 });
const afterRunEvents = Object.freeze({ capture: 3, command: 6, singleton: 9, intent: 12 });
const afterCheckEvents = Object.freeze({ capture: 4, command: 7, singleton: 10, intent: 13 });

function normaliseSql(sql) {
  return String(sql).trim().replace(/\s+/gu, ' ');
}

function writeKind(sql) {
  const normalised = normaliseSql(sql);
  return writeKinds.find(([prefix]) => normalised.startsWith(prefix))?.[1] ?? null;
}

function pause(eventIndex, boundary) {
  if (targetEvent !== eventIndex) return;
  process.send({ type: 'paused', eventIndex, boundary });
  process.kill(process.pid, 'SIGSTOP');
}

installB3CaptureStateRootMock();
const { openB3CaptureStore } = await import('../../scripts/lib/b3-capture-store.mjs');
const store = await openB3CaptureStore({ platform: 'ios' });

const originalExec = sqlite.DatabaseSync.prototype.exec;
const originalPrepare = sqlite.DatabaseSync.prototype.prepare;
const originalRun = sqlite.StatementSync.prototype.run;
const statements = new WeakMap();
let reservationWriteSeen = false;
let reservationCommitted = false;
let pendingCheckedKind = null;
let finalValidationPending = false;
let readyWriteSeen = false;

sqlite.DatabaseSync.prototype.exec = function tracedExec(sql) {
  const normalised = normaliseSql(sql);
  if (normalised === 'BEGIN IMMEDIATE' && reservationCommitted) {
    pause(1, 'before-reconciliation-begin');
  }
  if (normalised === 'COMMIT' && reservationWriteSeen && !reservationCommitted) {
    const result = Reflect.apply(originalExec, this, [sql]);
    reservationCommitted = true;
    pause(0, 'after-reservation-commit');
    return result;
  }
  if (normalised === 'COMMIT' && readyWriteSeen) {
    pause(15, 'before-final-commit');
    const result = Reflect.apply(originalExec, this, [sql]);
    pause(16, 'after-final-commit-before-return');
    return result;
  }
  return Reflect.apply(originalExec, this, [sql]);
};

sqlite.DatabaseSync.prototype.prepare = function tracedPrepare(sql) {
  if (pendingCheckedKind !== null) {
    pause(
      afterCheckEvents[pendingCheckedKind],
      `after-${pendingCheckedKind}-changes-check`,
    );
    pendingCheckedKind = null;
  }
  if (finalValidationPending) {
    pause(14, 'before-final-validation');
    finalValidationPending = false;
  }
  const statement = Reflect.apply(originalPrepare, this, [sql]);
  const normalised = normaliseSql(sql);
  const kind = writeKind(normalised);
  if (kind !== null) statements.set(statement, { kind });
  else if (normalised.startsWith('INSERT INTO b3_capture_start_intents')) {
    statements.set(statement, { kind: 'reservation' });
  }
  return statement;
};

sqlite.StatementSync.prototype.run = function tracedRun(...values) {
  const traced = statements.get(this);
  if (!traced) return Reflect.apply(originalRun, this, values);
  if (traced.kind === 'reservation') {
    const result = Reflect.apply(originalRun, this, values);
    reservationWriteSeen = true;
    return result;
  }
  pause(beforeRunEvents[traced.kind], `before-${traced.kind}-run`);
  const result = Reflect.apply(originalRun, this, values);
  if (traced.kind === 'intent') readyWriteSeen = true;
  pause(afterRunEvents[traced.kind], `after-${traced.kind}-run`);
  return new Proxy(result, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key === 'changes') {
        pendingCheckedKind = traced.kind;
        if (traced.kind === 'intent') finalValidationPending = true;
      }
      return value;
    },
  });
};

process.send({ type: 'ready' });
process.once('message', async (message) => {
  if (message?.type !== 'go') throw new Error('B3 SQL death barrier is invalid');
  try {
    const result = await store.startCapture({ command });
    process.send({ type: 'unexpected-result', result });
  } catch (error) {
    process.send({
      type: 'unexpected-error',
      error: { code: error?.code ?? null, message: error?.message ?? String(error) },
    });
  } finally {
    sqlite.DatabaseSync.prototype.exec = originalExec;
    sqlite.DatabaseSync.prototype.prepare = originalPrepare;
    sqlite.StatementSync.prototype.run = originalRun;
    await store.close();
    process.disconnect();
  }
});
