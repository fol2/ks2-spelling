import { openB3CaptureStateRepository } from './b3-capture-state-repository.mjs';

function storeError(message) {
  return Object.assign(new Error(message), { code: 'b3_capture_state_invalid' });
}

function isClosedRecord(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).every((key) => typeof key === 'string') &&
    Reflect.ownKeys(value).sort().join(',') === [...keys].sort().join(',');
}

function snapshotCommand(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some((key) => typeof key !== 'string')) {
    throw storeError('B3 capture-store command authority is invalid');
  }
  const snapshot = {};
  for (const key of Reflect.ownKeys(value)) snapshot[key] = value[key];
  return Object.freeze(snapshot);
}

function snapshotDataRecord(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some((key) => typeof key !== 'string') ||
      Reflect.ownKeys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw storeError(`B3 capture-store ${label} authority is invalid`);
  }
  const snapshot = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw storeError(`B3 capture-store ${label} authority is invalid`);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function snapshotScalarRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw storeError(`B3 capture-store ${label} authority is invalid`);
  }
  const snapshot = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, 'value') ||
        (!['string', 'number', 'boolean'].includes(typeof descriptor.value) &&
          descriptor.value !== null)) {
      throw storeError(`B3 capture-store ${label} authority is invalid`);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function snapshotRecursiveData(value, label, depth = 0) {
  if (depth > 8) throw storeError(`B3 capture-store ${label} authority is invalid`);
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 64 ||
        Array.from({ length: value.length }, (_, index) => index)
          .some((index) => !Object.hasOwn(value, index)) ||
        Reflect.ownKeys(value).some((key) =>
      key !== 'length' && (!/^(?:0|[1-9][0-9]*)$/u.test(String(key)) ||
        Number(key) >= value.length))) {
      throw storeError(`B3 capture-store ${label} authority is invalid`);
    }
    const snapshot = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw storeError(`B3 capture-store ${label} authority is invalid`);
      }
      snapshot.push(snapshotRecursiveData(descriptor.value, label, depth + 1));
    }
    return Object.freeze(snapshot);
  }
  if (typeof value !== 'object' ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw storeError(`B3 capture-store ${label} authority is invalid`);
  }
  const snapshot = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, 'value')) {
      throw storeError(`B3 capture-store ${label} authority is invalid`);
    }
    snapshot[key] = snapshotRecursiveData(descriptor.value, label, depth + 1);
  }
  return Object.freeze(snapshot);
}

export async function openB3CaptureStore(options) {
  if (!isClosedRecord(options, ['platform'])) {
    throw storeError('B3 capture-store open authority is invalid');
  }
  const platform = options.platform;
  if (!['ios', 'android'].includes(platform)) {
    throw storeError('B3 capture-store open authority is invalid');
  }
  const repository = await openB3CaptureStateRepository({ platform });
  let closed = false;
  const recoveryPins = new WeakMap();

  async function startCapture(startOptions) {
    if (closed) throw storeError('B3 capture-store is already closed');
    if (!isClosedRecord(startOptions, ['command'])) {
      throw storeError('B3 capture-store start authority is invalid');
    }
    const command = snapshotCommand(startOptions.command);
    const outcome = await repository.reconcileInitialCaptureStart({
      command,
    });
    const kinds = Object.freeze({
      'won-reservation': 'started',
      'same-winner': 'already-started',
      'different-winner': 'start-conflict',
    });
    const kind = kinds[outcome.kind];
    if (!kind) throw storeError('B3 capture-store start outcome is invalid');
    return Object.freeze({ kind, capture: outcome.capture });
  }

  async function publishObservation(publicationOptions) {
    if (closed) throw storeError('B3 capture-store is already closed');
    const options = snapshotDataRecord(
      publicationOptions,
      ['source', 'observationBytes'],
      'observation publication',
    );
    const source = snapshotDataRecord(options.source, [
      'allocationSequence', 'captureId', 'command', 'commandSha256', 'platform',
      'predecessorCommandSha256', 'recordSha256', 'schemaVersion', 'state',
    ], 'observation source');
    const sourceSnapshot = Object.freeze({
      ...source,
      command: snapshotScalarRecord(source.command, 'observation source command'),
    });
    const observationBytes = options.observationBytes instanceof Uint8Array
      ? Buffer.from(options.observationBytes)
      : null;
    if (!observationBytes) {
      throw storeError('B3 capture-store observation bytes are invalid');
    }
    return repository.publishObservation({ source: sourceSnapshot, observationBytes });
  }

  async function readActiveCommand(...readOptions) {
    if (closed) throw storeError('B3 capture-store is already closed');
    if (readOptions.length !== 0) {
      throw storeError('B3 capture-store read active command authority is invalid');
    }
    return repository.readActiveCommand();
  }

  async function allocateNextCommand(allocationOptions) {
    if (closed) throw storeError('B3 capture-store is already closed');
    const options = snapshotDataRecord(
      allocationOptions,
      ['command'],
      'next allocation',
    );
    const command = snapshotScalarRecord(options.command, 'allocation command');
    return repository.allocateNextCommand({ command });
  }

  async function transitionCommand(transitionOptions) {
    if (closed) throw storeError('B3 capture-store is already closed');
    const options = snapshotDataRecord(
      transitionOptions,
      ['source', 'nextState'],
      'ordinary transition',
    );
    const source = snapshotDataRecord(options.source, [
      'allocationSequence', 'captureId', 'command', 'commandSha256', 'platform',
      'predecessorCommandSha256', 'recordSha256', 'schemaVersion', 'state',
    ], 'ordinary transition source');
    const sourceSnapshot = Object.freeze({
      ...source,
      command: snapshotScalarRecord(source.command, 'ordinary transition command'),
    });
    if (typeof options.nextState !== 'string') {
      throw storeError('B3 capture-store ordinary transition state is invalid');
    }
    return repository.transitionCommand({
      source: sourceSnapshot,
      nextState: options.nextState,
    });
  }

  async function consumeCommand(consumptionOptions) {
    if (closed) throw storeError('B3 capture-store is already closed');
    const options = snapshotDataRecord(
      consumptionOptions,
      ['source'],
      'generic consumption',
    );
    const source = snapshotDataRecord(options.source, [
      'allocationSequence', 'captureId', 'command', 'commandSha256', 'platform',
      'predecessorCommandSha256', 'recordSha256', 'schemaVersion', 'state',
    ], 'generic consumption source');
    return repository.consumeCommand({
      source: Object.freeze({
        ...source,
        command: snapshotScalarRecord(source.command, 'generic consumption command'),
      }),
    });
  }

  async function readCapture(...readOptions) {
    if (closed) throw storeError('B3 capture-store is already closed');
    if (readOptions.length !== 0) {
      throw storeError('B3 capture-store read capture authority is invalid');
    }
    return repository.readCapture();
  }

  async function pinRecoveryInvocation(pinOptions = {}) {
    if (closed) throw storeError('B3 capture-store is already closed');
    const options = snapshotDataRecord(
      pinOptions,
      ['acknowledgeReinstall'],
      'recovery pin',
    );
    if (typeof options.acknowledgeReinstall !== 'boolean') {
      throw storeError('B3 capture-store recovery pin authority is invalid');
    }
    const acknowledgeReinstall = options.acknowledgeReinstall;
    const repositoryPin = await repository.readRecoveryInvocationPin();
    const invocation = Object.freeze(Object.create(null));
    recoveryPins.set(invocation, Object.freeze({
      repositoryPin,
      acknowledgeReinstall,
      finalised: false,
    }));
    return invocation;
  }

  async function finaliseRecoveryInvocation(finaliseOptions) {
    if (closed) throw storeError('B3 capture-store is already closed');
    const options = snapshotDataRecord(finaliseOptions, [
      'invocation', 'distribution', 'freshCommand',
    ], 'recovery finalisation');
    const retainedPin = recoveryPins.get(options.invocation);
    if (!retainedPin || retainedPin.finalised) {
      throw storeError('B3 capture-store recovery invocation pin is invalid');
    }
    recoveryPins.set(options.invocation, Object.freeze({
      ...retainedPin,
      finalised: true,
    }));
    const distribution = snapshotRecursiveData(
      options.distribution,
      'recovery distribution',
    );
    const freshCommand = snapshotScalarRecord(
      options.freshCommand,
      'recovery fresh command',
    );
    const outcome = await repository.finaliseRecoveryInvocation({
      pin: retainedPin.repositoryPin,
      acknowledgeReinstall: retainedPin.acknowledgeReinstall,
      distribution,
      freshCommand,
    });
    return Object.freeze({
      status: outcome.status,
      acknowledgementConsumed: retainedPin.acknowledgeReinstall &&
        outcome.exactRecoveryLineageConverged,
    });
  }

  async function close() {
    if (closed) throw storeError('B3 capture-store is already closed');
    closed = true;
    await repository.close();
  }

  return Object.freeze({
    startCapture,
    readActiveCommand,
    allocateNextCommand,
    transitionCommand,
    publishObservation,
    consumeCommand,
    readCapture,
    pinRecoveryInvocation,
    finaliseRecoveryInvocation,
    close,
  });
}
