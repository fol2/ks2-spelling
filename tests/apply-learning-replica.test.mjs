import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  applyReplicaSnapshot,
  deriveDeviceLearningGrant,
  isRemoteFull,
} from '../src/domain/sync/apply-learning-replica.js';
import { emptyStarterSnapshot } from '../src/domain/sync/merge-learning-replica.js';
import { PRESERVED_FULL_LEARNING_KEY_PREFIX } from '../src/platform/database/sqlite-spelling-profile-store.js';

function snapshot(overrides = {}) {
  const base = emptyStarterSnapshot(overrides.learnerId ?? 'learner-a');
  return {
    ...base,
    ...overrides,
    subjectState: overrides.subjectState ?? {
      ...base.subjectState,
      data: {
        ...base.subjectState.data,
        progress: overrides.progress ?? base.subjectState.data.progress,
      },
    },
  };
}

test('device learning grant matches store entitlement and never copies a replica grant', () => {
  assert.deepEqual(deriveDeviceLearningGrant({ entitled: false }), {
    catalogueId: 'ks2-core:starter',
    grantedEntitlementIds: [],
  });
  assert.deepEqual(deriveDeviceLearningGrant({ entitled: true }), {
    catalogueId: 'ks2-core:full',
    grantedEntitlementIds: ['full-ks2'],
  });
});

test('never-entitled device receiving Full remote stays on Starter and parks Full history', () => {
  const local = snapshot({
    progress: {
      'ks2-core:because': {
        stage: 2, attempts: 3, correct: 2, wrong: 1, dueDay: 4, lastDay: 3, lastResult: 'wrong',
      },
    },
  });
  const remote = snapshot({
    revision: 4,
    catalogueId: 'ks2-core:full',
    grantedEntitlementIds: ['full-ks2'],
    progress: {
      'ks2-core:circle': {
        stage: 4, attempts: 4, correct: 4, wrong: 0, dueDay: 8, lastDay: 7, lastResult: 'correct',
      },
    },
  });
  const result = applyReplicaSnapshot({
    localSnapshot: local,
    remoteSnapshot: remote,
    entitled: false,
    earned: false,
  });
  assert.equal(result.action, 'park-full');
  assert.equal(result.working.catalogueId, 'ks2-core:starter');
  assert.deepEqual(result.working.grantedEntitlementIds, []);
  assert.equal(result.working.subjectState.data.progress['ks2-core:circle'].stage, 4);
  assert.equal(result.preserved.catalogueId, 'ks2-core:full');
  assert.deepEqual(result.preserved.grantedEntitlementIds, ['full-ks2']);
  assert.equal(
    `${PRESERVED_FULL_LEARNING_KEY_PREFIX}${local.learnerId}`,
    'preserved-full-learning-v1:learner-a',
  );
});

test('entitled device applies the merged Full working grant', () => {
  const result = applyReplicaSnapshot({
    localSnapshot: snapshot(),
    remoteSnapshot: snapshot({
      revision: 2,
      catalogueId: 'ks2-core:full',
      grantedEntitlementIds: ['full-ks2'],
    }),
    entitled: true,
    earned: true,
  });
  assert.equal(result.action, 'apply');
  assert.equal(result.working.catalogueId, 'ks2-core:full');
  assert.deepEqual(result.working.grantedEntitlementIds, ['full-ks2']);
  assert.equal(result.preserved, null);
});

test('working grant always matches this device even when remote is Full', () => {
  const neverEntitled = applyReplicaSnapshot({
    localSnapshot: snapshot(),
    remoteSnapshot: snapshot({
      catalogueId: 'ks2-core:full',
      grantedEntitlementIds: ['full-ks2'],
    }),
    entitled: false,
    earned: false,
  });
  const entitled = applyReplicaSnapshot({
    localSnapshot: snapshot({ catalogueId: 'ks2-core:starter', grantedEntitlementIds: [] }),
    remoteSnapshot: snapshot({
      catalogueId: 'ks2-core:full',
      grantedEntitlementIds: ['full-ks2'],
    }),
    entitled: true,
    earned: false,
  });
  assert.equal(neverEntitled.working.catalogueId, 'ks2-core:starter');
  assert.equal(entitled.working.catalogueId, 'ks2-core:full');
});

test('imported Full cannot become the working catalogue when earned is true but the device is not entitled', () => {
  const result = applyReplicaSnapshot({
    localSnapshot: snapshot(),
    remoteSnapshot: snapshot({
      catalogueId: 'ks2-core:full',
      grantedEntitlementIds: ['full-ks2'],
    }),
    entitled: false,
    earned: true,
  });
  assert.equal(result.action, 'park-full');
  assert.equal(result.working.catalogueId, 'ks2-core:starter');
  assert.equal(isRemoteFull(result.preserved), true);
});

test('reverting the park-full branch goes red', async () => {
  const source = await readFile(
    new URL('../src/domain/sync/apply-learning-replica.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /park-full/);
  assert.match(source, /isRemoteFull/);
  assert.match(source, /entitled !== true/);
  assert.doesNotMatch(source, /isRemoteFullSnapshot/);
});

test('reverting the park-full branch goes red on never-entitled Full import', () => {
  const result = applyReplicaSnapshot({
    localSnapshot: snapshot(),
    remoteSnapshot: snapshot({
      catalogueId: 'ks2-core:full',
      grantedEntitlementIds: ['full-ks2'],
    }),
    entitled: false,
    earned: false,
  });
  assert.equal(result.action, 'park-full');
  assert.equal(isRemoteFull(result.preserved), true);
  assert.equal(result.preserved.catalogueId, 'ks2-core:full');
  assert.equal(result.working.catalogueId, 'ks2-core:starter');
  assert.deepEqual(result.working.grantedEntitlementIds, []);
});
