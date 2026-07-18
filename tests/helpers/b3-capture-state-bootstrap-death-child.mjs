import { constants as fsConstants, writeSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mock } from 'node:test';

import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

const point = process.argv[2];
const allowedPoints = new Set([
  'evidence-directory-sync',
  'state-directory-sync',
  'database-create',
  'database-file-sync',
  'database-directory-sync',
  'schema-transaction',
  'schema-commit',
  'final-database-sync',
  'final-directory-sync',
]);
if (!allowedPoints.has(point)) throw new Error('invalid bootstrap death point');

function die() {
  writeSync(1, `DIED:${point}\n`);
  process.kill(process.pid, 'SIGKILL');
}

installB3CaptureStateRootMock();

const handlePaths = new WeakMap();
const syncCounts = new Map();
const probe = await fsPromises.open(import.meta.filename, 'r');
const fileHandlePrototype = Object.getPrototypeOf(probe);
await probe.close();
const originalSync = fileHandlePrototype.sync;
fileHandlePrototype.sync = async function observedSync() {
  const result = await originalSync.call(this);
  const path = handlePaths.get(this);
  if (path === undefined) return result;
  const count = (syncCounts.get(path) ?? 0) + 1;
  syncCounts.set(path, count);
  const repositoryRoot = resolve(process.cwd());
  const evidenceParent = resolve(repositoryRoot, '.native-build', 'b3');
  const evidence = resolve(evidenceParent, 'evidence');
  const stateDirectory = resolve(evidence, 'ios-capture-state');
  const databasePath = resolve(stateDirectory, 'recovery.sqlite');
  if ((point === 'evidence-directory-sync' && path === evidenceParent) ||
      (point === 'state-directory-sync' && path === evidence) ||
      (point === 'database-file-sync' && path === databasePath && count === 1) ||
      (point === 'database-directory-sync' && path === stateDirectory && count === 1) ||
      (point === 'final-database-sync' && path === databasePath && count === 2) ||
      (point === 'final-directory-sync' && path === stateDirectory && count === 2)) {
    die();
  }
  return result;
};

const { default: defaultExport, ...namedExports } = fsPromises;
mock.module('node:fs/promises', {
  defaultExport,
  namedExports: {
    ...namedExports,
    async open(path, flags, mode) {
      const handle = await fsPromises.open(path, flags, mode);
      const resolvedPath = resolve(String(path));
      handlePaths.set(handle, resolvedPath);
      if (point === 'database-create' &&
          resolvedPath.endsWith('/ios-capture-state/recovery.sqlite') &&
          typeof flags === 'number' && (flags & fsConstants.O_EXCL) !== 0) {
        die();
      }
      return handle;
    },
  },
});

const originalExec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function observedExec(sql) {
  const result = originalExec.call(this, sql);
  if ((point === 'schema-transaction' &&
       sql.includes('INSERT INTO b3_authority_state')) ||
      (point === 'schema-commit' && sql.trim() === 'COMMIT')) {
    die();
  }
  return result;
};

const { openB3CaptureStateDatabase } = await import(
  '../../scripts/lib/b3-capture-state-database.mjs'
);
await openB3CaptureStateDatabase({ platform: 'ios' });
throw new Error(`bootstrap death point was not reached: ${point}`);
