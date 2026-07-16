import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

if (typeof process.send !== 'function' || typeof process.argv[2] !== 'string') {
  throw new Error('B3 capture-state race child input or IPC channel is absent');
}

const action = JSON.parse(
  Buffer.from(process.argv[2], 'base64url').toString('utf8'),
);
let sourceGetterCalls = 0;
let commandGetterCalls = 0;
let allocationCommandGetterCalls = 0;

function countedCommand(command, increment) {
  const counted = Object.fromEntries(Object.keys(command).map((key) => [key, undefined]));
  for (const key of Object.keys(command)) {
    Object.defineProperty(counted, key, {
      enumerable: true,
      get() {
        increment();
        return command[key];
      },
    });
  }
  return counted;
}

function countedSource(source) {
  const command = countedCommand(source.command, () => { commandGetterCalls += 1; });
  const counted = Object.fromEntries(Object.keys(source).map((key) => [key, undefined]));
  for (const key of Object.keys(source)) {
    Object.defineProperty(counted, key, {
      enumerable: true,
      get() {
        sourceGetterCalls += 1;
        return key === 'command' ? command : source[key];
      },
    });
  }
  return counted;
}

function getterCounts() {
  return {
    sourceGetterCalls,
    commandGetterCalls,
    allocationCommandGetterCalls,
  };
}

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
  const source = action.countGetters ? countedSource(preflight.command) : preflight.command;
  mutate = () => repository.transitionCommand({
    source,
    nextState: action.nextState,
  });
} else if (action.kind === 'consume' && preflight.kind === 'active') {
  const source = action.countGetters ? countedSource(preflight.command) : preflight.command;
  mutate = () => repository.consumeCommand({ source });
} else if (action.kind === 'allocate' && preflight.kind === 'none') {
  const command = action.countGetters
    ? countedCommand(action.command, () => { allocationCommandGetterCalls += 1; })
    : action.command;
  mutate = () => repository.allocateNextCommand({ command });
} else {
  await repository.close();
  throw new Error('B3 capture-state race action or preflight is invalid');
}

await send({ type: 'ready', preflight });
await waitForGo();

let result = null;
let error = null;
let synchronousGetterSnapshot = null;
try {
  const operation = mutate();
  synchronousGetterSnapshot = getterCounts();
  result = await operation;
} catch (cause) {
  error = {
    code: cause?.code ?? null,
    message: cause?.message ?? String(cause),
  };
} finally {
  await repository.close();
}

await send({
  type: 'result',
  operation: action.kind,
  result,
  error,
  synchronousGetterSnapshot,
  getterCounts: getterCounts(),
});
process.disconnect();
