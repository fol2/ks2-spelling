import * as originalFs from 'node:fs';
import * as originalSqlite from 'node:sqlite';
import { relative, resolve } from 'node:path';
import { mock } from 'node:test';

import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

if (typeof process.send !== 'function') {
  throw new Error('B3 capture-store filesystem death child IPC is absent');
}

const targetEvent = Number(process.argv[2]);
const command = JSON.parse(
  Buffer.from(process.argv[3], 'base64url').toString('utf8'),
);
let operationOrdinal = 0;
const trace = [];
const descriptorPaths = new Map();

function relativeDirectoryPath(path, { canonical = false } = {}) {
  const absolute = canonical ? originalFs.realpathSync(path) : resolve(path);
  const relativePath = relative(process.cwd(), absolute);
  if (!relativePath || relativePath === '..' || relativePath.startsWith('../')) {
    throw new Error('B3 filesystem death path escaped its repository');
  }
  return relativePath;
}

function pause(eventIndex, entry, phase) {
  if (eventIndex !== targetEvent) return;
  process.send({
    type: 'paused',
    eventIndex,
    operationIndex: entry.operationIndex,
    operationOrdinal,
    phase,
    kind: entry.kind,
    path: entry.path,
    trace: [...trace],
  });
  process.kill(process.pid, 'SIGSTOP');
}

function tracedOperation(kind, path, effect) {
  const entry = Object.freeze({
    operationIndex: operationOrdinal,
    kind,
    path,
  });
  pause(operationOrdinal * 2, entry, 'before');
  const result = effect();
  trace.push(entry);
  pause((operationOrdinal * 2) + 1, entry, 'after');
  operationOrdinal += 1;
  return result;
}

mock.module('node:fs', {
  namedExports: {
    closeSync(descriptor) {
      try {
        return originalFs.closeSync(descriptor);
      } finally {
        descriptorPaths.delete(descriptor);
      }
    },
    constants: originalFs.constants,
    fstatSync: originalFs.fstatSync,
    fsyncSync(descriptor) {
      const path = descriptorPaths.get(descriptor);
      if (!path) throw new Error('B3 filesystem death fsync descriptor is unowned');
      return tracedOperation('fsync', path, () => originalFs.fsyncSync(descriptor));
    },
    lstatSync: originalFs.lstatSync,
    mkdirSync(path, options) {
      return tracedOperation(
        'mkdir',
        relativeDirectoryPath(path),
        () => originalFs.mkdirSync(path, options),
      );
    },
    openSync(path, ...options) {
      const descriptor = originalFs.openSync(path, ...options);
      try {
        descriptorPaths.set(
          descriptor,
          relativeDirectoryPath(path, { canonical: true }),
        );
        return descriptor;
      } catch (error) {
        originalFs.closeSync(descriptor);
        throw error;
      }
    },
    readSync: originalFs.readSync,
    readdirSync: originalFs.readdirSync,
    realpathSync: originalFs.realpathSync,
  },
});

const originalPrepare = originalSqlite.DatabaseSync.prototype.prepare;
originalSqlite.DatabaseSync.prototype.prepare = function tracedPrepare(sql) {
  const normalised = String(sql).trim().replace(/\s+/gu, ' ');
  if (normalised.startsWith('INSERT INTO b3_captures')) {
    if (operationOrdinal !== 17 || trace.length !== 17) {
      throw new Error('B3 filesystem death durability trace is incomplete');
    }
    pause(34, {
      operationIndex: 17,
      kind: 'snapshot',
      path: relativeDirectoryPath(resolve(
        '.native-build', 'b3', 'evidence', 'ios-capture-bundles',
        `${command.captureId}.working`,
      ), { canonical: true }),
    }, 'after');
  }
  return Reflect.apply(originalPrepare, this, [sql]);
};

installB3CaptureStateRootMock();
const { openB3CaptureStore } = await import('../../scripts/lib/b3-capture-store.mjs');
const store = await openB3CaptureStore({ platform: 'ios' });
process.send({ type: 'ready' });

process.once('message', async (message) => {
  if (message?.type !== 'go') throw new Error('B3 filesystem death barrier is invalid');
  try {
    const result = await store.startCapture({ command });
    process.send({ type: 'unexpected-result', result, operationOrdinal });
  } catch (error) {
    process.send({
      type: 'unexpected-error',
      error: { code: error?.code ?? null, message: error?.message ?? String(error) },
      operationOrdinal,
    });
  } finally {
    await store.close();
    originalSqlite.DatabaseSync.prototype.prepare = originalPrepare;
    process.disconnect();
  }
});
