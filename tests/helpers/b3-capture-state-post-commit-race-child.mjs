import { writeSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mock } from 'node:test';

import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

const pendingLines = [];
const lineWaiters = [];
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  while (input.includes('\n')) {
    const newline = input.indexOf('\n');
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    const waiter = lineWaiters.shift();
    if (waiter) waiter(line);
    else pendingLines.push(line);
  }
});

function nextLine() {
  if (pendingLines.length > 0) return Promise.resolve(pendingLines.shift());
  return new Promise((resolveLine) => lineWaiters.push(resolveLine));
}

installB3CaptureStateRootMock();

const databasePath = resolve(
  process.cwd(), '.native-build', 'b3', 'evidence', 'ios-capture-state',
  'recovery.sqlite',
);
let bootstrapCommitted = false;
const originalExec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function observedExec(sql) {
  const result = originalExec.call(this, sql);
  if (sql.trim() === 'COMMIT') bootstrapCommitted = true;
  return result;
};
const { default: defaultExport, ...namedExports } = fsPromises;
mock.module('node:fs/promises', {
  defaultExport,
  namedExports: {
    ...namedExports,
    async lstat(path, options) {
      if (bootstrapCommitted && resolve(String(path)) === databasePath) {
        bootstrapCommitted = false;
        writeSync(1, 'PAUSED\n');
        if (await nextLine() !== 'RESUME') throw new Error('unexpected resume authority');
      }
      return fsPromises.lstat(path, options);
    },
  },
});

const { openB3CaptureStateDatabase } = await import(
  '../../scripts/lib/b3-capture-state-database.mjs'
);
const state = await openB3CaptureStateDatabase({ platform: 'ios' });
writeSync(1, 'RETURNED\n');
if (await nextLine() !== 'CLOSE') throw new Error('unexpected close authority');
await state.close();
writeSync(1, 'CLOSED\n');
