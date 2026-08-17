import {
  LEARNING_REPLICA_METHODS,
  assertLearningReplicaPort,
  validateLearningReplicaStatus,
  validatePublishRequest,
  validatePullResult,
} from './learning-replica-port.js';
import {
  assertClosedRecord,
  assertExactPort,
  assertPromise,
  fail,
} from '../commerce/store-port.js';

function replicaUnavailable() {
  return Object.assign(new Error('The iCloud learning replica is unavailable.'), {
    code: 'icloud_replica_unavailable',
  });
}

function createNativeFacade(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('ICloudLearningReplica plugin', 'must be an object');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 0) {
    assertExactPort(value, LEARNING_REPLICA_METHODS, 'ICloudLearningReplica plugin');
  }
  const methods = {};
  for (const name of LEARNING_REPLICA_METHODS) {
    let method;
    try {
      method = value[name];
    } catch {
      fail('ICloudLearningReplica plugin', `${name} must be available`);
    }
    if (typeof method !== 'function') {
      fail('ICloudLearningReplica plugin', `${name} must be a function`);
    }
    methods[name] = (...arguments_) => Reflect.apply(method, value, arguments_);
  }
  return Object.freeze(methods);
}

async function invoke(plugin, method, request) {
  let pending;
  try {
    pending = request === undefined ? plugin[method]() : plugin[method](request);
  } catch {
    throw replicaUnavailable();
  }
  assertPromise(pending, `ICloudLearningReplica.${method}`);
  try {
    return await pending;
  } catch {
    throw replicaUnavailable();
  }
}

export function createCapacitorICloudLearningReplica(options) {
  assertClosedRecord(options, ['ICloudLearningReplica'], 'Capacitor iCloud replica options');
  const plugin = createNativeFacade(options.ICloudLearningReplica);
  return assertLearningReplicaPort(Object.freeze({
    async getStatus() {
      return validateLearningReplicaStatus(await invoke(plugin, 'getStatus'));
    },
    async publish(envelope) {
      const request = validatePublishRequest(envelope);
      const result = await invoke(plugin, 'publish', request);
      assertClosedRecord(result, ['accepted'], 'Learning replica publish result');
      if (!Number.isSafeInteger(result.accepted) || result.accepted < 0) {
        throw replicaUnavailable();
      }
      return Object.freeze({ accepted: result.accepted });
    },
    async pull() {
      return validatePullResult(await invoke(plugin, 'pull'));
    },
  }));
}
