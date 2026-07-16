import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

if (typeof process.send !== 'function') {
  throw new Error('B3 capture-store race child IPC is absent');
}

const command = JSON.parse(
  Buffer.from(process.argv[2], 'base64url').toString('utf8'),
);

function send(message) {
  return new Promise((resolve, reject) => {
    process.send(message, (error) => error ? reject(error) : resolve());
  });
}

function waitForGo() {
  return new Promise((resolve, reject) => {
    process.once('message', (message) => {
      if (message?.type === 'go') resolve();
      else reject(new Error('B3 capture-store race barrier is invalid'));
    });
  });
}

installB3CaptureStateRootMock();
const { openB3CaptureStore } = await import('../../scripts/lib/b3-capture-store.mjs');
const store = await openB3CaptureStore({ platform: 'ios' });
await send({ type: 'ready' });
await waitForGo();

let result = null;
let error = null;
try {
  result = await store.startCapture({ command });
} catch (cause) {
  error = { code: cause?.code ?? null, message: cause?.message ?? String(cause) };
} finally {
  await store.close();
}
await send({ type: 'result', result, error });
process.disconnect();
