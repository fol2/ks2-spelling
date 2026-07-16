import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

installB3CaptureStateRootMock();

const { openB3CaptureStateRepository } = await import(
  '../../scripts/lib/b3-capture-state-repository.mjs'
);

const mode = process.argv[2];
const platform = process.argv[3];
const commands = process.argv.slice(4).map((value) =>
  JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
let repository;
let getterCalls = 0;
let repositoryClosed = false;
try {
  repository = await openB3CaptureStateRepository({ platform });
  let result;
  if (mode === 'retry') {
    result = [
      await repository.reserveInitialCaptureStart({ command: commands[0] }),
      await repository.reserveInitialCaptureStart({ command: commands[1] }),
    ];
  } else if (mode === 'invalid-extra') {
    const options = {
      get command() {
        getterCalls += 1;
        throw new Error('command getter must not run');
      },
      unexpected: true,
    };
    result = await repository.reserveInitialCaptureStart(options);
  } else if (mode === 'invalid-getter') {
    const options = {
      get command() {
        getterCalls += 1;
        return commands[0];
      },
    };
    result = await repository.reserveInitialCaptureStart(options);
  } else if (mode === 'closed') {
    await repository.close();
    repositoryClosed = true;
    result = await repository.reserveInitialCaptureStart({ command: commands[0] });
  } else if (mode === 'shape') {
    result = Reflect.ownKeys(repository).map(String).sort();
  } else {
    throw new Error('unknown repository probe mode');
  }
  process.stdout.write(`${JSON.stringify({ ok: true, result, getterCalls })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: { code: error?.code ?? null, message: error?.message ?? String(error) },
    getterCalls,
  })}\n`);
} finally {
  if (!repositoryClosed) await repository?.close();
}
