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

  async function close() {
    if (closed) throw storeError('B3 capture-store is already closed');
    closed = true;
    await repository.close();
  }

  return Object.freeze({ startCapture, close });
}
