import assert from 'node:assert/strict';
import test from 'node:test';

import { achievementChips } from '../src/app/records-model.js';
import {
  ACHIEVEMENT_DEFINITIONS,
  ACHIEVEMENT_IDS,
} from '../src/domain/spelling/index.js';

test('achievement chips project unlock rows and drop progress, unreachable and garbage', () => {
  const chips = achievementChips({
    [ACHIEVEMENT_IDS.RECOVERY_EXPERT]: { unlockedAt: 200 },
    [ACHIEVEMENT_IDS.GUARDIAN_7_DAY]: { unlockedAt: 100 },
    '_progress:guardian:days': { days: [1, 2, 3] },
    [ACHIEVEMENT_IDS.BOSS_CLEAN_SWEEP]: { unlockedAt: 50 },
    [ACHIEVEMENT_IDS.PATTERN_MASTERY]: { unlockedAt: 60 },
    UNKNOWN_GARBAGE: { unlockedAt: 10 },
    BAD_NULL: null,
    BAD_ARRAY: [],
    BAD_UNLOCKED: { unlockedAt: 'soon' },
    BAD_NEGATIVE: { unlockedAt: -1 },
    BAD_INFINITE: { unlockedAt: Number.POSITIVE_INFINITY },
  });

  assert.deepEqual(chips, [
    {
      id: ACHIEVEMENT_IDS.GUARDIAN_7_DAY,
      title: 'Guardian 7-day Maintainer',
      body: ACHIEVEMENT_DEFINITIONS[ACHIEVEMENT_IDS.GUARDIAN_7_DAY].body,
      unlockedAt: 100,
    },
    {
      id: ACHIEVEMENT_IDS.RECOVERY_EXPERT,
      title: 'Recovery Expert',
      body: ACHIEVEMENT_DEFINITIONS[ACHIEVEMENT_IDS.RECOVERY_EXPERT].body,
      unlockedAt: 200,
    },
  ]);
  assert.equal(chips[0].title, 'Guardian 7-day Maintainer');
  assert.equal(chips[1].title, 'Recovery Expert');
});

test('achievement chips tolerate null, undefined and non-object input', () => {
  assert.deepEqual(achievementChips(), []);
  assert.deepEqual(achievementChips(null), []);
  assert.deepEqual(achievementChips(undefined), []);
  assert.deepEqual(achievementChips('nope'), []);
  assert.deepEqual(achievementChips(42), []);
  assert.deepEqual(achievementChips([]), []);
});
