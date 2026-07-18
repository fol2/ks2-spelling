import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

installB3CaptureStateRootMock();

const { openB3CaptureStateRepository } = await import(
  '../../scripts/lib/b3-capture-state-repository.mjs'
);

const platform = process.argv[2];
const command = JSON.parse(Buffer.from(process.argv[3], 'base64url').toString('utf8'));
const repository = await openB3CaptureStateRepository({ platform });
try {
  if (process.argv[4] === 'barrier') {
    process.stdout.write('READY\n');
    await new Promise((resolve) => process.stdin.once('data', resolve));
  }
  const reservation = await repository.reserveInitialCaptureStart({ command });
  process.stdout.write(`${JSON.stringify(reservation)}\n`);
} finally {
  await repository.close();
}
