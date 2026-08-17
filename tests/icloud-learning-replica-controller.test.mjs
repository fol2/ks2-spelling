import assert from 'node:assert/strict';
import test from 'node:test';

import { startICloudLearningReplica } from '../src/app/icloud-learning-replica-controller.js';
import { emptyStarterSnapshot } from '../src/domain/sync/merge-learning-replica.js';
import { createFakeLearningReplica } from '../src/platform/fakes/create-fake-learning-replica.js';

const remoteProfile = Object.freeze({
  learnerId: 'learner-a',
  nickname: 'Ada',
  yearGroup: 'Y3',
  goal: 10,
  colour: '#2E7D8A',
  createdAt: 100,
  updatedAt: 200,
});

function localProfile(overrides = {}) {
  return {
    ...remoteProfile,
    nickname: 'Local Ada',
    updatedAt: 50,
    ...overrides,
  };
}

test('unavailable replica does not publish', async () => {
  const published = [];
  const replica = {
    ...createFakeLearningReplica({ available: false }),
    async publish(envelope) {
      published.push(envelope);
      return { accepted: 0 };
    },
  };
  const handle = await startICloudLearningReplica({
    replica,
    listProfiles: async () => [localProfile()],
    readSnapshot: async () => emptyStarterSnapshot('learner-a'),
    writeProfile: async () => {
      throw new Error('must not write when unavailable');
    },
    applyIncoming: async () => {
      throw new Error('must not apply when unavailable');
    },
    entitled: false,
    earned: false,
  });
  await handle.publishLearner('learner-a');
  assert.deepEqual(published, []);
});

test('available replica pulls, merges profiles and publishes local learning', async () => {
  const seed = createFakeLearningReplica();
  await seed.publish({
    profiles: [remoteProfile],
    snapshots: [{
      learnerId: 'learner-a',
      payload: {
        ...emptyStarterSnapshot('learner-a'),
        revision: 3,
        catalogueId: 'ks2-core:full',
        grantedEntitlementIds: ['full-ks2'],
      },
    }],
  });
  const written = [];
  const applied = [];
  const published = [];
  const replica = {
    ...seed,
    async publish(envelope) {
      published.push(envelope);
      return seed.publish(envelope);
    },
  };
  const locals = [localProfile()];
  await startICloudLearningReplica({
    replica,
    listProfiles: async () => locals,
    readSnapshot: async () => emptyStarterSnapshot('learner-a'),
    writeProfile: async (profile) => {
      written.push(profile);
    },
    applyIncoming: async (input) => {
      applied.push(input);
    },
    entitled: false,
    earned: false,
  });
  assert.equal(written.length, 1);
  assert.equal(written[0].nickname, 'Ada');
  assert.equal(applied.length, 1);
  assert.equal(applied[0].remoteSnapshot.catalogueId, 'ks2-core:full');
  assert.equal(published.length, 1);
  assert.deepEqual(Object.keys(published[0]).sort(), ['profiles', 'snapshots']);
});

test('controller does not write selected learner or PIN into the replica envelope', async () => {
  const replica = createFakeLearningReplica();
  await replica.publish({
    profiles: [remoteProfile],
    snapshots: [{ learnerId: 'learner-a', payload: emptyStarterSnapshot('learner-a') }],
  });
  const written = [];
  const applied = [];
  const published = [];
  const wrapped = {
    ...replica,
    async publish(envelope) {
      published.push(envelope);
      return replica.publish(envelope);
    },
  };
  await startICloudLearningReplica({
    replica: wrapped,
    listProfiles: async () => [localProfile()],
    readSnapshot: async () => emptyStarterSnapshot('learner-a'),
    writeProfile: async (profile) => {
      written.push(profile);
    },
    applyIncoming: async (input) => {
      applied.push(input);
    },
    entitled: false,
    earned: false,
  });
  for (const envelope of [...written, ...applied, ...published]) {
    assert.equal(Object.hasOwn(envelope, 'selectedLearnerId'), false);
    assert.equal(Object.hasOwn(envelope, 'selectedLearner'), false);
    assert.equal(Object.hasOwn(envelope, 'pin'), false);
    assert.equal(Object.hasOwn(envelope, 'parentPin'), false);
  }
});

test('getStatus throw stays local-only and start does not reject', async () => {
  const published = [];
  const replica = {
    async getStatus() { throw new Error('CloudKit unavailable'); },
    async publish(envelope) { published.push(envelope); return { accepted: 0 }; },
    async pull() { return { profiles: [], snapshots: [] }; },
  };
  const handle = await startICloudLearningReplica({
    replica,
    listProfiles: async () => [localProfile()],
    readSnapshot: async () => emptyStarterSnapshot('learner-a'),
    writeProfile: async () => { throw new Error('must not write'); },
    applyIncoming: async () => { throw new Error('must not apply'); },
    entitled: false,
    earned: false,
  });
  await handle.publishLearner('learner-a');
  assert.deepEqual(published, []);
});
