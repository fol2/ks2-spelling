import * as originalSqlite from 'node:sqlite';

import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

const targetIndex = Number(process.argv[2]);
const command = JSON.parse(
  Buffer.from(process.argv[3], 'base64url').toString('utf8'),
);
const statementKinds = [
  ['INSERT INTO b3_captures', 'capture'],
  ['INSERT INTO b3_commands', 'command'],
  ['UPDATE b3_authority_state SET next_allocation_sequence = 2', 'singleton'],
  ["UPDATE b3_capture_start_intents SET intent_state = 'ready'", 'intent'],
];
const trace = [];
const tracedStatements = new WeakMap();

function statementKind(sql) {
  const normalised = String(sql).trim().replace(/\s+/gu, ' ');
  return statementKinds.find(([prefix]) => normalised.startsWith(prefix))?.[1] ?? null;
}

const originalPrepare = originalSqlite.DatabaseSync.prototype.prepare;
const originalRun = originalSqlite.StatementSync.prototype.run;
originalSqlite.DatabaseSync.prototype.prepare = function tracedPrepare(sql) {
  const statement = Reflect.apply(originalPrepare, this, [sql]);
  const kind = statementKind(sql);
  if (kind !== null) tracedStatements.set(statement, kind);
  return statement;
};
originalSqlite.StatementSync.prototype.run = function tracedRun(...values) {
  const result = Reflect.apply(originalRun, this, values);
  const kind = tracedStatements.get(this);
  if (kind === undefined) return result;
  trace.push(kind);
  if (trace.length - 1 !== targetIndex) return result;
  return Object.freeze({ changes: 0, lastInsertRowid: result.lastInsertRowid });
};

installB3CaptureStateRootMock();
const { openB3CaptureStore } = await import('../../scripts/lib/b3-capture-store.mjs');

let store;
try {
  store = await openB3CaptureStore({ platform: 'ios' });
  const result = await store.startCapture({ command });
  process.stdout.write(`${JSON.stringify({ ok: true, result, trace })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: { code: error?.code ?? null, message: error?.message ?? String(error) },
    trace,
  })}\n`);
} finally {
  await store?.close();
  originalSqlite.DatabaseSync.prototype.prepare = originalPrepare;
  originalSqlite.StatementSync.prototype.run = originalRun;
}
