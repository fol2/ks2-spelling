import assert from 'node:assert/strict';
import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

installB3CaptureStateRootMock();

const { openB3CaptureStateDatabase } = await import(
  '../../scripts/lib/b3-capture-state-database.mjs'
);
let evaluated = false;
const options = { platform: 'ios' };
Object.defineProperty(options, 'path', {
  enumerable: true,
  get() {
    evaluated = true;
    throw new Error('path getter evaluated');
  },
});
await assert.rejects(
  openB3CaptureStateDatabase(options),
  /open authority|invalid/i,
);
assert.equal(evaluated, false);
process.stdout.write(`${JSON.stringify({ ok: true, evaluated })}\n`);
