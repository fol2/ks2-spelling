import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

installB3CaptureStateRootMock();

const { openB3CaptureStateRepository } = await import(
  '../../scripts/lib/b3-capture-state-repository.mjs'
);

const command = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'));
const repository = await openB3CaptureStateRepository({ platform: 'ios' });
try {
  process.stdout.write('READY\n');
  await new Promise((resolve) => process.stdin.once('data', resolve));
  try {
    const result = await repository.reserveInitialCaptureStart({ command });
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: { code: error?.code ?? null, message: error?.message ?? String(error) },
    })}\n`);
  }
} finally {
  await repository.close();
}
