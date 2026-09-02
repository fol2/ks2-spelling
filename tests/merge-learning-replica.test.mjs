import assert from 'node:assert/strict';
import test from 'node:test';

import {
  emptyStarterSnapshot,
  mergeProfiles,
  mergeSnapshots,
} from '../src/domain/sync/merge-learning-replica.js';

function profile(overrides = {}) {
  return {
    learnerId: 'learner-a',
    nickname: 'Ada',
    yearGroup: 'Y3',
    goal: 10,
    colour: '#2E7D8A',
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function progress(overrides = {}) {
  return {
    stage: 0,
    attempts: 0,
    correct: 0,
    wrong: 0,
    dueDay: 0,
    lastDay: null,
    lastResult: null,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  const base = emptyStarterSnapshot(overrides.learnerId ?? 'learner-a');
  const subjectState = overrides.subjectState ?? {
    ...base.subjectState,
    data: {
      ...base.subjectState.data,
      ...(overrides.prefs ? { prefs: overrides.prefs } : {}),
      ...(overrides.progress ? { progress: overrides.progress } : {}),
      ...(overrides.guardianMap ? { guardianMap: overrides.guardianMap } : {}),
    },
  };
  return {
    ...base,
    ...overrides,
    subjectState,
  };
}

test('mergeProfiles last-writer-wins by updatedAt and prefers remote when times tie', () => {
  assert.equal(
    mergeProfiles(profile({ nickname: 'Ada', updatedAt: 200 }), profile({ nickname: 'Ida', updatedAt: 150 })).nickname,
    'Ada',
  );
  assert.equal(
    mergeProfiles(profile({ nickname: 'Ada', updatedAt: 150 }), profile({ nickname: 'Ida', updatedAt: 200 })).nickname,
    'Ida',
  );
  assert.equal(
    mergeProfiles(profile({ nickname: 'Ada', updatedAt: 200 }), profile({ nickname: 'Ida', updatedAt: 200 })).nickname,
    'Ida',
  );
});

test('mergeProfiles throws when learnerId does not match', () => {
  assert.throws(
    () => mergeProfiles(profile(), profile({ learnerId: 'learner-b' })),
    /learnerId must match/,
  );
});

test('union keeps a word secured only on A', () => {
  const local = snapshot({
    progress: {
      'ks2-core:because': progress({ stage: 4, attempts: 6, correct: 5, lastDay: 10, lastResult: 'correct' }),
    },
  });
  const remote = snapshot({
    revision: 2,
    progress: {
      'ks2-core:circle': progress({ stage: 1, attempts: 2, correct: 1, lastDay: 8, lastResult: 'wrong' }),
    },
  });
  const merged = mergeSnapshots(local, remote);
  assert.equal(merged.subjectState.data.progress['ks2-core:because'].stage, 4);
  assert.equal(merged.subjectState.data.progress['ks2-core:circle'].stage, 1);
});

test('max stage wins for a shared progress key without dropping counts', () => {
  const local = snapshot({
    progress: {
      'ks2-core:because': progress({
        stage: 2, attempts: 4, correct: 3, wrong: 1, dueDay: 4, lastDay: 3, lastResult: 'wrong',
      }),
    },
  });
  const remote = snapshot({
    revision: 3,
    progress: {
      'ks2-core:because': progress({
        stage: 4, attempts: 2, correct: 2, wrong: 0, dueDay: 9, lastDay: 8, lastResult: 'correct',
      }),
    },
  });
  const merged = mergeSnapshots(local, remote).subjectState.data.progress['ks2-core:because'];
  assert.equal(merged.stage, 4);
  assert.equal(merged.attempts, 4);
  assert.equal(merged.correct, 3);
  assert.equal(merged.wrong, 1);
  assert.equal(merged.dueDay, 9);
  assert.equal(merged.lastDay, 8);
  assert.equal(merged.lastResult, 'correct');
});

test('prefs last-writer-wins by snapshot revision and prefer remote when revisions tie', () => {
  const local = snapshot({ revision: 3, prefs: { autoSpeak: true } });
  const olderRemote = snapshot({ revision: 2, prefs: { autoSpeak: false } });
  const newerRemote = snapshot({ revision: 4, prefs: { autoSpeak: false } });
  const tiedRemote = snapshot({ revision: 3, prefs: { autoSpeak: false } });
  assert.equal(mergeSnapshots(local, olderRemote).subjectState.data.prefs.autoSpeak, true);
  assert.equal(mergeSnapshots(local, newerRemote).subjectState.data.prefs.autoSpeak, false);
  assert.equal(mergeSnapshots(local, tiedRemote).subjectState.data.prefs.autoSpeak, false);
});

test('practice session last-writer-wins by snapshot revision', () => {
  const localSession = { id: 'local', learnerId: 'learner-a', status: 'active' };
  const remoteSession = { id: 'remote', learnerId: 'learner-a', status: 'active' };
  const local = snapshot({ revision: 5, practiceSession: localSession });
  const remote = snapshot({ revision: 6, practiceSession: remoteSession });
  assert.equal(mergeSnapshots(local, remote).practiceSession.id, 'remote');
  assert.equal(mergeSnapshots(remote, snapshot({ revision: 4, practiceSession: localSession })).practiceSession.id, 'remote');
});

test('concurrent practice does not drop a word secured only on the other device', () => {
  const local = snapshot({
    revision: 8,
    practiceSession: { id: 'session-a', learnerId: 'learner-a', status: 'active' },
    progress: {
      'ks2-core:because': progress({ stage: 4, attempts: 5, correct: 5, lastDay: 12, lastResult: 'correct' }),
      'ks2-core:enough': progress({ stage: 1, attempts: 1, correct: 0, lastDay: 12, lastResult: 'wrong' }),
    },
  });
  const remote = snapshot({
    revision: 8,
    practiceSession: { id: 'session-b', learnerId: 'learner-a', status: 'active' },
    progress: {
      'ks2-core:circle': progress({ stage: 4, attempts: 4, correct: 4, lastDay: 11, lastResult: 'correct' }),
      'ks2-core:enough': progress({ stage: 2, attempts: 3, correct: 2, lastDay: 11, lastResult: 'correct' }),
    },
  });
  const merged = mergeSnapshots(local, remote);
  assert.equal(merged.subjectState.data.progress['ks2-core:because'].stage, 4);
  assert.equal(merged.subjectState.data.progress['ks2-core:circle'].stage, 4);
  assert.equal(merged.subjectState.data.progress['ks2-core:enough'].stage, 2);
  assert.equal(merged.practiceSession.id, 'session-b');
});

test('eventLog unions by event id and sorts by createdAt then id', () => {
  const local = snapshot({
    eventLog: [
      { id: 'b', createdAt: 20 },
      { id: 'a', createdAt: 10 },
    ],
  });
  const remote = snapshot({
    revision: 2,
    eventLog: [
      { id: 'a', createdAt: 10 },
      { id: 'c', createdAt: 20 },
    ],
  });
  assert.deepEqual(
    mergeSnapshots(local, remote).eventLog.map((event) => event.id),
    ['a', 'b', 'c'],
  );
});

test('catalogueId grantedEntitlementIds and packId stay on the local placeholders', () => {
  const local = snapshot({
    packId: 'ks2-core',
    catalogueId: 'ks2-core:starter',
    grantedEntitlementIds: [],
  });
  const remote = snapshot({
    revision: 9,
    packId: 'should-not-win',
    catalogueId: 'ks2-core:full',
    grantedEntitlementIds: ['full-ks2'],
  });
  const merged = mergeSnapshots(local, remote);
  assert.equal(merged.packId, 'ks2-core');
  assert.equal(merged.catalogueId, 'ks2-core:starter');
  assert.deepEqual(merged.grantedEntitlementIds, []);
});

test('mergeSnapshots throws when learnerId does not match', () => {
  assert.throws(
    () => mergeSnapshots(snapshot(), snapshot({ learnerId: 'learner-b' })),
    /learnerId must match/,
  );
});

test('mergeProfiles with a null local returns a clone of remote', () => {
  const remote = profile({ nickname: 'Ida', updatedAt: 300 });
  const merged = mergeProfiles(null, remote);
  assert.equal(merged.nickname, 'Ida');
  assert.equal(merged.learnerId, remote.learnerId);
  assert.notEqual(merged, remote);
});

test('mergeSnapshots does not mutate frozen local or remote inputs', () => {
  const local = Object.freeze(snapshot({
    progress: Object.freeze({
      'ks2-core:because': Object.freeze(progress({ stage: 4 })),
    }),
  }));
  const remote = Object.freeze(snapshot({
    revision: 2,
    progress: Object.freeze({
      'ks2-core:circle': Object.freeze(progress({ stage: 1 })),
    }),
  }));
  const localProgressKeys = Object.keys(local.subjectState.data.progress);
  mergeSnapshots(local, remote);
  assert.deepEqual(Object.keys(local.subjectState.data.progress), localProgressKeys);
  assert.equal(local.subjectState.data.progress['ks2-core:circle'], undefined);
});

function monsterRecord(branch, overrides = {}) {
  return {
    rewardTrackId: 'spelling-core-inklet',
    packId: 'ks2-core',
    monsterId: 'inklet',
    branch,
    secureCount: 1,
    caught: true,
    derivedStage: 0,
    earnedStageHighWater: 0,
    ...overrides,
  };
}

test('stale replica does not revert a local Codex egg switch on numeric tie', () => {
  const local = snapshot({
    revision: 6,
    monsterStateByRewardTrackId: {
      'spelling-core-inklet': monsterRecord('b2'),
    },
  });
  const remote = snapshot({
    revision: 5,
    monsterStateByRewardTrackId: {
      'spelling-core-inklet': monsterRecord('b1'),
    },
  });
  const merged = mergeSnapshots(local, remote);
  assert.equal(
    merged.monsterStateByRewardTrackId['spelling-core-inklet'].branch,
    'b2',
    'newer local revision wins the branch when secure counts tie',
  );
  assert.equal(merged.revision, 6);
});

test('remote companion progress still wins the branch when it is strictly ahead', () => {
  const local = snapshot({
    revision: 6,
    monsterStateByRewardTrackId: {
      'spelling-core-inklet': monsterRecord('b2', { secureCount: 1 }),
    },
  });
  const remote = snapshot({
    revision: 7,
    monsterStateByRewardTrackId: {
      'spelling-core-inklet': monsterRecord('b1', {
        secureCount: 10,
        derivedStage: 1,
        earnedStageHighWater: 1,
      }),
    },
  });
  const merged = mergeSnapshots(local, remote);
  assert.equal(
    merged.monsterStateByRewardTrackId['spelling-core-inklet'].branch,
    'b1',
  );
  assert.equal(
    merged.monsterStateByRewardTrackId['spelling-core-inklet'].secureCount,
    10,
  );
});

test('newer remote egg switch beats a stale local branch on numeric tie', () => {
  const local = snapshot({
    revision: 5,
    monsterStateByRewardTrackId: {
      'spelling-core-inklet': monsterRecord('b1'),
    },
  });
  const remote = snapshot({
    revision: 6,
    monsterStateByRewardTrackId: {
      'spelling-core-inklet': monsterRecord('b2'),
    },
  });
  const merged = mergeSnapshots(local, remote);
  assert.equal(
    merged.monsterStateByRewardTrackId['spelling-core-inklet'].branch,
    'b2',
    'newer remote revision wins the branch when secure counts tie',
  );
  assert.equal(merged.revision, 6);
});

test('null local snapshot clones remote progress but keeps starter catalogue placeholders', () => {
  const remote = snapshot({
    revision: 7,
    schemaVersion: 3,
    packId: 'should-not-win',
    catalogueId: 'ks2-core:full',
    grantedEntitlementIds: ['full-ks2'],
    progress: {
      'ks2-core:circle': progress({ stage: 4 }),
    },
  });
  const merged = mergeSnapshots(null, remote);
  assert.equal(merged.subjectState.data.progress['ks2-core:circle'].stage, 4);
  assert.equal(merged.packId, 'ks2-core');
  assert.equal(merged.catalogueId, 'ks2-core:starter');
  assert.deepEqual(merged.grantedEntitlementIds, []);
  assert.equal(merged.revision, 7);
  assert.equal(merged.schemaVersion, 3);
});
