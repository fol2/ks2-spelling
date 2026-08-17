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

test('validatePublishRequest and validatePullResult return frozen closed records', () => {
  const published = validatePublishRequest({ profiles: [profile], snapshots: [snapshot] });
  const pulled = validatePullResult({ profiles: [profile], snapshots: [snapshot] });
  assert.equal(Object.isFrozen(published), true);
  assert.equal(Object.isFrozen(pulled), true);
  assert.deepEqual(Object.keys(published).sort(), ['profiles', 'snapshots']);
});

test('profiles must be the seven-key spelling profile not a payload wrapper', () => {
  const accepted = validatePublishRequest({
    profiles: [profile],
    snapshots: [snapshot],
  });
  assert.deepEqual(Object.keys(accepted.profiles[0]).sort(), [
    'colour', 'createdAt', 'goal', 'learnerId', 'nickname', 'updatedAt', 'yearGroup',
  ].sort());
  assert.throws(
    () => validatePublishRequest({
      profiles: [{ learnerId: 'learner-a', payload: {} }],
      snapshots: [snapshot],
    }),
    /must contain exactly the approved fields/,
  );
});

test('publish rejects PIN selectedLearner app_entitlements and storeEntitlements at the envelope top level', () => {
  const base = { profiles: [profile], snapshots: [snapshot] };
  assert.throws(() => validatePublishRequest({ ...base, PIN: '1234' }), /PIN|approved fields/);
  assert.throws(() => validatePublishRequest({ ...base, selectedLearner: 'learner-a' }), /selectedLearner|approved fields/);
  assert.throws(() => validatePublishRequest({ ...base, app_entitlements: [] }), /app_entitlements|approved fields/);
  assert.throws(() => validatePublishRequest({ ...base, storeEntitlements: [] }), /storeEntitlements|approved fields/);
});

test('snapshots may contain grantedEntitlementIds inside payload', () => {
  assert.doesNotThrow(() => validatePublishRequest({
    profiles: [profile],
    snapshots: [{
      learnerId: 'learner-a',
      payload: {
        schemaVersion: 1,
        learnerId: 'learner-a',
        revision: 1,
        packId: 'ks2-core',
        catalogueId: 'ks2-core:full',
        grantedEntitlementIds: ['full-ks2'],
      },
    }],
  }));
});
