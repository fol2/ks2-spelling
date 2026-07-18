import { DatabaseSync } from 'node:sqlite';

import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

installB3CaptureStateRootMock();

let persistentOpened = false;
const originalEnableDefensive = DatabaseSync.prototype.enableDefensive;
DatabaseSync.prototype.enableDefensive = function observedEnableDefensive(value) {
  persistentOpened = true;
  return originalEnableDefensive.call(this, value);
};

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
DatabaseSync.prototype.enableDefensive = originalEnableDefensive;
process.stdout.write(`${JSON.stringify({ outcome, persistentOpened })}\n`);
