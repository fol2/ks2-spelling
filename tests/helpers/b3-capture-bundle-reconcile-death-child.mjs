import * as originalFs from 'node:fs';
import { relative, resolve } from 'node:path';
import { mock } from 'node:test';

import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

const input = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'));
installB3CaptureStateRootMock();

const trace = [];
const descriptorPaths = new Map();
let operationIndex = 0;
let postconditionStarted = false;
function repositoryRelative(path) {
  const relativePath = relative(process.cwd(), resolve(path));
  if (relativePath === '..' || relativePath.startsWith('../')) {
    throw new Error('B3 reconciliation test path escaped its repository');
  }
  return relativePath || '.';
}

if (input.trace) {
  function pause(phase, entry) {
    if (typeof process.send !== 'function' || !input.death) return;
    const matchesEffect = input.death.kind === 'effect' &&
      input.death.operationIndex === entry.operationIndex &&
      input.death.phase === phase;
    const matchesPostcondition = input.death.kind === 'postcondition' &&
      entry.kind === 'postcondition' &&
      input.death.phase === phase;
    if (!matchesEffect && !matchesPostcondition) return;
    process.send({ type: 'paused', phase, entry, trace: [...trace] });
    process.kill(process.pid, 'SIGSTOP');
  }
  function tracedEffect(entry, effect) {
    const exact = Object.freeze({ operationIndex, ...entry });
    pause('before', exact);
    const result = effect();
    trace.push(exact);
    pause('after', exact);
    operationIndex += 1;
    return result;
  }
  mock.module('node:fs', {
    namedExports: {
      closeSync(descriptor) {
        try {
          return originalFs.closeSync(descriptor);
        } finally {
          descriptorPaths.delete(descriptor);
        }
      },
      constants: originalFs.constants,
      fstatSync: originalFs.fstatSync,
      fsyncSync(descriptor) {
        const path = descriptorPaths.get(descriptor);
        if (!path) throw new Error('B3 reconciliation test fsync path is absent');
        return tracedEffect(
          { kind: 'fsync', path },
          () => originalFs.fsyncSync(descriptor),
        );
      },
      lstatSync(path) {
        const relativePath = repositoryRelative(path);
        if (input.death?.kind === 'postcondition' &&
            operationIndex === input.death.effectCount &&
            relativePath === input.death.firstPath && !postconditionStarted) {
          pause('before', {
            operationIndex,
            kind: 'postcondition',
            path: relativePath,
          });
          postconditionStarted = true;
        }
        return originalFs.lstatSync(path);
      },
      mkdirSync: originalFs.mkdirSync,
      openSync(path, ...options) {
        const descriptor = originalFs.openSync(path, ...options);
        descriptorPaths.set(descriptor, repositoryRelative(path));
        return descriptor;
      },
      readSync: originalFs.readSync,
      readdirSync(path, options) {
        const result = originalFs.readdirSync(path, options);
        if (postconditionStarted && input.death?.kind === 'postcondition' &&
            repositoryRelative(path) === input.death.lastDirectory) {
          pause('after', {
            operationIndex,
            kind: 'postcondition',
            path: input.death.firstPath,
          });
        }
        return result;
      },
      realpathSync: originalFs.realpathSync,
      renameSync(source, destination) {
        return tracedEffect({
          kind: 'rename',
          path: repositoryRelative(source),
          destination: repositoryRelative(destination),
        }, () => originalFs.renameSync(source, destination));
      },
      unlinkSync(path) {
        return tracedEffect(
          { kind: 'unlink', path: repositoryRelative(path) },
          () => originalFs.unlinkSync(path),
        );
      },
    },
  });
}

const {
  inspectB3CaptureBundleInventory,
  reconcileB3DurableBundleActions,
} = await import('../../scripts/lib/b3-capture-bundle-store.mjs');

const inventory = inspectB3CaptureBundleInventory(input.authority);
const selected = input.mode === 'clone'
  ? structuredClone(inventory)
  : inventory;

if (input.mutation?.kind === 'caller-authority') {
  input.authority.databaseState.activeCommand = null;
  input.authority.retainedDomain.observations.length = 0;
} else if (input.mutation?.kind === 'remove-member') {
  originalFs.unlinkSync(resolve(input.mutation.path));
} else if (input.mutation?.kind === 'replace-member') {
  const path = resolve(input.mutation.path);
  const bytes = originalFs.readFileSync(path);
  originalFs.unlinkSync(path);
  originalFs.writeFileSync(path, bytes, { mode: 0o600 });
  originalFs.chmodSync(path, 0o600);
} else if (input.mutation?.kind === 'overwrite-member') {
  const path = resolve(input.mutation.path);
  originalFs.writeFileSync(path, Buffer.from(input.mutation.bytes, 'base64url'));
  originalFs.chmodSync(path, 0o600);
} else if (input.mutation?.kind === 'create-final') {
  const bytes = originalFs.readFileSync(resolve(input.mutation.source));
  originalFs.writeFileSync(resolve(input.mutation.destination), bytes, { mode: 0o600 });
  originalFs.chmodSync(resolve(input.mutation.destination), 0o600);
} else if (input.mutation?.kind === 'replace-parent') {
  const parent = resolve(input.mutation.path);
  const retained = resolve(input.mutation.retainedPath);
  originalFs.renameSync(parent, retained);
  originalFs.mkdirSync(parent, { mode: 0o700 });
  originalFs.chmodSync(parent, 0o700);
  for (const name of originalFs.readdirSync(retained)) {
    originalFs.copyFileSync(resolve(retained, name), resolve(parent, name));
    originalFs.chmodSync(resolve(parent, name), 0o600);
  }
}

function run() {
  try {
    const result = reconcileB3DurableBundleActions(selected);
    const output = {
      ok: true,
      result: result ?? null,
      trace,
    };
    if (typeof process.send === 'function') process.send({ type: 'result', ...output });
    else process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    const output = {
      ok: false,
      code: error?.code ?? null,
      message: error?.message ?? String(error),
      trace,
    };
    if (typeof process.send === 'function') process.send({ type: 'result', ...output });
    else process.stdout.write(`${JSON.stringify(output)}\n`);
  }
}

if (typeof process.send === 'function') {
  process.send({ type: 'ready' });
  process.once('message', (message) => {
    if (message?.type !== 'go') throw new Error('B3 reconciliation death barrier is invalid');
    run();
  });
} else {
  run();
}
