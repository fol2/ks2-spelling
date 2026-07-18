import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

installB3CaptureStateRootMock();

const { openB3CaptureStateDatabase } = await import(
  '../../scripts/lib/b3-capture-state-database.mjs'
);

const state = await openB3CaptureStateDatabase({ platform: process.argv[2] ?? 'ios' });
process.stdout.write('OPEN\n');
process.stdin.setEncoding('utf8');
process.stdin.once('data', async (value) => {
  if (value !== 'CLOSE\n') throw new Error('unexpected close authority');
  await state.close();
  process.stdout.write('CLOSED\n');
});
