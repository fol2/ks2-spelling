import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

installB3CaptureStateRootMock();

const { openB3CaptureStateDatabase } = await import(
  '../../scripts/lib/b3-capture-state-database.mjs'
);

let getterCalls = 0;
const options = {};
Object.defineProperty(options, 'platform', {
  enumerable: true,
  get() {
    getterCalls += 1;
    return getterCalls === 1 ? 'ios' : '../../escaped';
  },
});

let outcome = 'opened';
try {
  const state = await openB3CaptureStateDatabase(options);
  await state.close();
} catch {
  outcome = 'rejected';
}
process.stdout.write(`${JSON.stringify({ outcome, getterCalls })}\n`);
