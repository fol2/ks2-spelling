import assert from 'node:assert/strict';
import test from 'node:test';

import { run } from '../scripts/investigate-b4-performance.mjs';
import { B4_COMMAND_TRACE } from '../src/app/b4-round-contract.js';

test('isolated B4 SQLite timing harness completes the frozen 21-command trace', async () => {
  const report = await run();

  assert.equal(report.ok, true);
  assert.equal(report.commandCount, 21);
  assert.equal(report.commandCount, B4_COMMAND_TRACE.length);
  assert.equal(report.perCommandMs.length, 21);
  assert.ok(report.perCommandMs.every(
    (value) => Number.isFinite(value) && value >= 0,
  ));
  assert.equal(typeof report.maxMs, 'number');
  assert.equal(typeof report.meanMs, 'number');
  assert.ok(Number.isFinite(report.maxMs));
  assert.ok(Number.isFinite(report.meanMs));
  assert.deepEqual(report.comparator, {
    sqliteTransactionUpperBoundMs: 50,
  });
  assert.equal(typeof report.withinComparator, 'boolean');
  assert.deepEqual(report.limitations, [
    'Node-process isolation; not a WebView or installed-application measurement.',
  ]);
  assert.deepEqual(Object.keys(report).sort(), [
    'commandCount',
    'comparator',
    'limitations',
    'maxMs',
    'meanMs',
    'ok',
    'perCommandMs',
    'withinComparator',
  ]);
});
