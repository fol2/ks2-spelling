import assert from 'node:assert/strict';
import test from 'node:test';

import { createFakeLearningReplica } from '../src/platform/fakes/create-fake-learning-replica.js';
import {
  LEARNING_REPLICA_CONTAINER,
  assertLearningReplicaPort,
  validatePublishRequest,
  validatePullResult,
} from '../src/platform/sync/learning-replica-port.js';

const profile = Object.freeze({
  learnerId: 'learner-a',
  nickname: 'Ada',
  yearGroup: 'Y3',
  goal: 10,
  colour: '#2E7D8A',
  createdAt: 100,
  updatedAt: 100,
});

const snapshot = Object.freeze({
  learnerId: 'learner-a',
  payload: Object.freeze({
    schemaVersion: 1,
    learnerId: 'learner-a',
    revision: 1,
    packId: 'ks2-core',
    catalogueId: 'ks2-core:starter',
    grantedEntitlementIds: [],
  }),
});

test('fake learning replica satisfies the closed port contract', async () => {
  const replica = createFakeLearningReplica();
  assertLearningReplicaPort(replica);
  assert.deepEqual(await replica.getStatus(), {
    available: true,
    account: 'available',
    container: LEARNING_REPLICA_CONTAINER,
  });
  await replica.publish({ profiles: [profile], snapshots: [snapshot] });
  assert.deepEqual(await replica.pull(), {
    profiles: [profile],
    snapshots: [snapshot],
  });
});

test('publish and pull reject extra envelope keys and selected-learner or PIN fields', () => {
  assert.throws(
    () => validatePublishRequest({
      profiles: [profile],
      snapshots: [snapshot],
      selectedLearnerId: 'learner-a',
    }),
    /must not contain selectedLearnerId|must contain exactly the approved fields/,
  );
  assert.throws(
    () => validatePublishRequest({
      profiles: [profile],
      snapshots: [snapshot],
      pin: '1234',
    }),
    /must not contain pin|must contain exactly the approved fields/,
  );
  assert.throws(
    () => validatePullResult({
      profiles: [profile],
      snapshots: [snapshot],
      extra: true,
    }),
    /must contain exactly the approved fields/,
  );
  assert.throws(
    () => validatePublishRequest({
      profiles: [profile],
      snapshots: [{ learnerId: 'learner-a', payload: { parentPin: 'x' } }],
    }),
    /parentPin/,
  );
});

test('unavailable replica status stays local-only', async () => {
  const replica = createFakeLearningReplica({ available: false });
  const status = await replica.getStatus();
  assert.equal(status.available, false);
  assert.equal(status.account, 'noAccount');
  assert.equal(status.container, LEARNING_REPLICA_CONTAINER);
});
