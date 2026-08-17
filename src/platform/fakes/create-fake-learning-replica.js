import {
  LEARNING_REPLICA_CONTAINER,
  assertLearningReplicaPort,
  validateLearningReplicaStatus,
  validatePublishRequest,
  validatePullResult,
} from '../sync/learning-replica-port.js';

const OPTION_KEYS = new Set(['available', 'account']);

export function createFakeLearningReplica(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Fake learning replica options must be a plain record.');
  }
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || !OPTION_KEYS.has(key)) {
      throw new TypeError('Fake learning replica options contain an unknown field.');
    }
  }
  const available = options.available !== false;
  const account = options.account
    ?? (available ? 'available' : 'noAccount');
  let profiles = [];
  let snapshots = [];

  return assertLearningReplicaPort(Object.freeze({
    async getStatus() {
      return validateLearningReplicaStatus({
        available: available && account === 'available',
        account,
        container: LEARNING_REPLICA_CONTAINER,
      });
    },
    async publish(envelope) {
      const request = validatePublishRequest(envelope);
      profiles = request.profiles.map((profile) => ({ ...profile }));
      snapshots = request.snapshots.map((snapshot) => ({
        learnerId: snapshot.learnerId,
        payload: structuredClone(snapshot.payload),
      }));
      return Object.freeze({ accepted: profiles.length + snapshots.length });
    },
    async pull() {
      return validatePullResult({
        profiles: profiles.map((profile) => ({ ...profile })),
        snapshots: snapshots.map((snapshot) => ({
          learnerId: snapshot.learnerId,
          payload: structuredClone(snapshot.payload),
        })),
      });
    },
  }));
}
