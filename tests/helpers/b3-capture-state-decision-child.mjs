import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

installB3CaptureStateRootMock();

const { openB3CaptureStateRepository } = await import(
  '../../scripts/lib/b3-capture-state-repository.mjs'
);
const { createB3IssuedCommandStateAuthority } = await import(
  '../../scripts/lib/b3-issued-command-authority.mjs'
);

const platform = process.argv[2];
const actions = JSON.parse(Buffer.from(process.argv[3], 'base64url').toString('utf8'));
let repository;
let repositoryClosed = false;
let sourceGetterCalls = 0;
let commandGetterCalls = 0;
let optionGetterCalls = 0;
let allocationCommandGetterCalls = 0;
const synchronousGetterSnapshots = [];
const synchronousAllocationGetterSnapshots = [];
try {
  repository = await openB3CaptureStateRepository({ platform });
  const initial = await repository.readActiveCommand();
  let source = initial.kind === 'active' ? initial.command : null;
  const sources = new Map();
  if (source) {
    sources.set(source.state, source);
    sources.set('A', source);
  }
  const results = [];
  for (const action of actions) {
    let selectedSource;
    if (action.sourceSnapshot !== undefined) {
      selectedSource = action.sourceSnapshot;
    } else if (action.sourceName !== undefined) {
      selectedSource = sources.get(action.sourceName);
    } else {
      selectedSource = action.sourceState === undefined
        ? source
        : sources.get(action.sourceState);
    }
    if (action.op !== 'allocate' && !selectedSource) {
      throw new Error(`decision helper source is absent: ${action.sourceName ?? action.sourceState}`);
    }
    if (action.forgeState) {
      try {
        const forged = createB3IssuedCommandStateAuthority({
          platform,
          command: selectedSource.command,
          state: action.forgeState,
        });
        selectedSource = {
          ...selectedSource,
          state: forged.state,
          recordSha256: forged.recordSha256,
        };
      } catch {
        selectedSource = { ...selectedSource, state: action.forgeState };
      }
    }
    if (action.malformedCommand) {
      selectedSource = {
        ...selectedSource,
        command: {
          ...selectedSource.command,
          challengeSha256: 'not-a-hash',
        },
      };
    }
    if (action.mutateBeforeAwait && action.op !== 'allocate') {
      selectedSource = {
        ...selectedSource,
        command: { ...selectedSource.command },
      };
    }
    if (action.countGetters && action.op !== 'allocate') {
      const originalSource = selectedSource;
      const originalCommand = originalSource.command;
      const countedCommand = Object.fromEntries(Object.keys(originalCommand).map((key) => [
        key,
        undefined,
      ]));
      for (const key of Object.keys(originalCommand)) {
        Object.defineProperty(countedCommand, key, {
          enumerable: true,
          get() {
            commandGetterCalls += 1;
            return originalCommand[key];
          },
        });
      }
      const countedSource = Object.fromEntries(Object.keys(originalSource).map((key) => [
        key,
        undefined,
      ]));
      for (const key of Object.keys(originalSource)) {
        Object.defineProperty(countedSource, key, {
          enumerable: true,
          get() {
            sourceGetterCalls += 1;
            return key === 'command' ? countedCommand : originalSource[key];
          },
        });
      }
      selectedSource = countedSource;
    }
    let result;
    try {
      if (action.op === 'close-transition' || action.op === 'close-consume' ||
          action.op === 'close-allocate') {
        await repository.close();
        repositoryClosed = true;
      }
      if (action.op === 'transition-extra') {
        result = await repository.transitionCommand({
          get source() {
            optionGetterCalls += 1;
            throw new Error('closed options must reject before reading source');
          },
          nextState: action.nextState,
          unexpected: true,
        });
      } else if (action.op === 'consume-extra') {
        result = await repository.consumeCommand({
          get source() {
            optionGetterCalls += 1;
            throw new Error('closed options must reject before reading source');
          },
          unexpected: true,
        });
      } else if (action.op === 'allocate-extra') {
        result = await repository.allocateNextCommand({
          get command() {
            optionGetterCalls += 1;
            throw new Error('closed options must reject before reading command');
          },
          unexpected: true,
        });
      } else if (action.op === 'allocate' || action.op === 'close-allocate') {
        let allocationCommand = action.mutateBeforeAwait
          ? { ...action.command }
          : action.command;
        if (action.countAllocationGetters) {
          const originalCommand = allocationCommand;
          const countedCommand = Object.fromEntries(Object.keys(originalCommand).map((key) => [
            key,
            undefined,
          ]));
          for (const key of Object.keys(originalCommand)) {
            Object.defineProperty(countedCommand, key, {
              enumerable: true,
              get() {
                allocationCommandGetterCalls += 1;
                return originalCommand[key];
              },
            });
          }
          allocationCommand = countedCommand;
        }
        const operation = repository.allocateNextCommand({ command: allocationCommand });
        if (action.observeBeforeAwait) {
          synchronousAllocationGetterSnapshots.push(allocationCommandGetterCalls);
        }
        if (action.mutateBeforeAwait) {
          allocationCommand.challengeSha256 = 'e'.repeat(64);
          allocationCommand.expectedSequence = 99;
        }
        result = await operation;
      } else if (action.op === 'transition' || action.op === 'close-transition') {
        const operation = repository.transitionCommand({
          source: selectedSource,
          nextState: action.nextState,
        });
        if (action.observeBeforeAwait) {
          synchronousGetterSnapshots.push({
            sourceGetterCalls,
            commandGetterCalls,
          });
        }
        if (action.mutateBeforeAwait) {
          selectedSource.state = 'launched';
          selectedSource.recordSha256 = 'f'.repeat(64);
          selectedSource.command.challengeSha256 = 'e'.repeat(64);
        }
        result = await operation;
      } else {
        const operation = repository.consumeCommand({ source: selectedSource });
        if (action.observeBeforeAwait) {
          synchronousGetterSnapshots.push({
            sourceGetterCalls,
            commandGetterCalls,
          });
        }
        if (action.mutateBeforeAwait) {
          selectedSource.state = 'launched';
          selectedSource.recordSha256 = 'f'.repeat(64);
          selectedSource.command.challengeSha256 = 'e'.repeat(64);
        }
        result = await operation;
      }
    } catch (error) {
      if (!action.expectError) throw error;
      result = {
        kind: 'error',
        code: error?.code ?? null,
        message: error?.message ?? String(error),
      };
    }
    results.push(result);
    if (result.command) {
      source = result.command;
      sources.set(source.state, source);
      if (action.saveAs) sources.set(action.saveAs, source);
    }
  }
  const final = repositoryClosed
    ? { kind: 'closed' }
    : await repository.readActiveCommand();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    results,
    final,
    sourceGetterCalls,
    commandGetterCalls,
    optionGetterCalls,
    allocationCommandGetterCalls,
    synchronousGetterSnapshots,
    synchronousAllocationGetterSnapshots,
  })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: { code: error?.code ?? null, message: error?.message ?? String(error) },
  })}\n`);
} finally {
  if (!repositoryClosed) await repository?.close();
}
