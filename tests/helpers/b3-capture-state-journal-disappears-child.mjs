import * as fsPromises from 'node:fs/promises';
import { mock } from 'node:test';

import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

installB3CaptureStateRootMock();

const { default: defaultExport, ...namedExports } = fsPromises;
let armed = false;
let deleted = false;
mock.module('node:fs/promises', {
  defaultExport,
  namedExports: {
    ...namedExports,
    async readdir(path, options) {
      const entries = await fsPromises.readdir(path, options);
      if (String(path).endsWith('/ios-capture-state') &&
          entries.some((entry) => (entry.name ?? entry) === 'recovery.sqlite-journal')) {
        armed = true;
      }
      return entries;
    },
    async lstat(path, options) {
      if (armed && !deleted && String(path).endsWith('/recovery.sqlite-journal')) {
        await fsPromises.rm(path);
        deleted = true;
      }
      return fsPromises.lstat(path, options);
    },
  },
});

const { openB3CaptureStateDatabase } = await import(
  '../../scripts/lib/b3-capture-state-database.mjs'
);
let outcome = 'opened';
try {
  const state = await openB3CaptureStateDatabase({ platform: 'ios' });
  await state.close();
} catch {
  outcome = 'rejected';
}
process.stdout.write(`${JSON.stringify({ outcome, deleted })}\n`);
