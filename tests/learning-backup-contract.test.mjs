import assert from 'node:assert/strict';
import test from 'node:test';

import { loadStarterSpellingCatalogue } from '../src/domain/spelling/index.js';
import {
  createLearningBackupCodec,
} from '../src/domain/security/learning-backup-contract.js';

const catalogue = loadStarterSpellingCatalogue();
const cataloguesById = Object.freeze({
  [catalogue.catalogueId]: catalogue,
});

function profile(learnerId = 'learner-a') {
  return {
    learnerId,
    nickname: 'Ada',
    yearGroup: 'Y3',
    goal: 10,
    colour: '#2E7D8A',
    createdAt: 100,
    updatedAt: 100,
  };
}

function snapshot(learnerId = 'learner-a') {
  return {
    schemaVersion: 1,
    learnerId,
    revision: 0,
    packId: 'ks2-core',
    catalogueId: 'ks2-core:starter',
    grantedEntitlementIds: [],
    subjectState: {
      ui: {},
      data: {
        prefs: { autoSpeak: false },
        progress: {},
        guardianMap: {},
        pattern: { wobblingByRuntimeItemId: {} },
        postMega: null,
        achievements: {},
        persistenceWarning: null,
      },
    },
    practiceSession: null,
    eventLog: [],
    monsterStateByRewardTrackId: {},
    campStateByPackId: {},
  };
}

test('learning backup codec round-trips one bounded canonical learner backup', () => {
  const codec = createLearningBackupCodec({ cataloguesById });
  const bytes = codec.encode({
    exportedAt: 200,
    selectedLearnerId: 'learner-a',
    learners: [{
      profile: profile(),
      snapshot: snapshot(),
    }],
  });

  assert.equal(typeof bytes, 'string');
  assert.equal(bytes.endsWith('\n'), false);
  assert.doesNotMatch(
    bytes,
    /parent-security|verifierBase64|sealed_refresh_handle|installed_pack|download_job/i,
  );
  assert.deepEqual(codec.decode(bytes), {
    schemaVersion: 1,
    appId: 'uk.eugnel.ks2spelling',
    exportedAt: 200,
    selectedLearnerId: 'learner-a',
    learners: [{
      profile: profile(),
      snapshot: snapshot(),
    }],
  });
});

test('learning backup codec rejects non-canonical, cross-learner and oversized input', () => {
  const codec = createLearningBackupCodec({
    cataloguesById,
    maximumBytes: 2_000,
  });
  const valid = codec.encode({
    exportedAt: 200,
    selectedLearnerId: 'learner-a',
    learners: [{
      profile: profile(),
      snapshot: snapshot(),
    }],
  });

  assert.throws(() => codec.decode(`${valid}\n`), /backup/i);
  assert.throws(
    () => codec.encode({
      exportedAt: 200,
      selectedLearnerId: 'learner-a',
      learners: [{
        profile: profile(),
        snapshot: snapshot('learner-b'),
      }],
    }),
    /learner|backup/i,
  );
  assert.throws(
    () => createLearningBackupCodec({
      cataloguesById,
      maximumBytes: 100,
    }).decode(valid),
    /size|large|backup/i,
  );
});
