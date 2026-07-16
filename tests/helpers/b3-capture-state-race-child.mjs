import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

if (typeof process.send !== 'function' || typeof process.argv[2] !== 'string') {
  throw new Error('B3 capture-state race child input or IPC channel is absent');
}

const action = JSON.parse(
  Buffer.from(process.argv[2], 'base64url').toString('utf8'),
);

function waitForGo() {
  return new Promise((resolve, reject) => {
    process.once('message', (message) => {
      if (message?.type !== 'go') {
        reject(new Error('B3 capture-state race barrier is invalid'));
        return;
      }
      resolve();
    });
  });
}

function send(message) {
  return new Promise((resolve, reject) => {
    process.send(message, (error) => error ? reject(error) : resolve());
  });
}

installB3CaptureStateRootMock();
const { openB3CaptureStateRepository } = await import(
  '../../scripts/lib/b3-capture-state-repository.mjs'
);

const repository = await openB3CaptureStateRepository({ platform: 'ios' });
const preflight = await repository.readActiveCommand();
let mutate;
if (action.kind === 'transition' && preflight.kind === 'active') {
  mutate = () => repository.transitionCommand({
    source: preflight.command,
    nextState: action.nextState,
  });
} else if (action.kind === 'consume' && preflight.kind === 'active') {
  mutate = () => repository.consumeCommand({ source: preflight.command });
} else if (action.kind === 'allocate' && preflight.kind === 'none') {
  mutate = () => repository.allocateNextCommand({ command: action.command });
} else {
  await repository.close();
  throw new Error('B3 capture-state race action or preflight is invalid');
}

await send({ type: 'ready', preflight });
await waitForGo();

let result = null;
let error = null;
try {
  result = await mutate();
} catch (cause) {
  error = {
    code: cause?.code ?? null,
    message: cause?.message ?? String(cause),
  };
} finally {
  await repository.close();
}

await send({ type: 'result', operation: action.kind, result, error });
process.disconnect();
