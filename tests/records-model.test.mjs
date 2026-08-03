import assert from 'node:assert/strict';
import test from 'node:test';

import { achievementChips, milestoneLadder } from '../src/app/records-model.js';
import {
  ACHIEVEMENT_DEFINITIONS,
  ACHIEVEMENT_IDS,
  SPELLING_MASTERY_MILESTONES,
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

const rungsOf = (ladder, key) => ladder
  .filter((rung) => rung[key])
  .map((rung) => rung.milestone);

test('the milestone ladder lights reached rungs and marks a single next target', () => {
  const start = milestoneLadder(0);
  // The ladder is the engine's own list of milestones, never a second opinion.
  assert.deepEqual(
    start.map((rung) => rung.milestone),
    [...SPELLING_MASTERY_MILESTONES],
  );
  assert.deepEqual(start.map((rung) => rung.milestone), [1, 5, 10, 25, 50, 100, 150, 200]);
  assert.deepEqual(rungsOf(start, 'reached'), []);
  assert.deepEqual(rungsOf(start, 'next'), [1]);

  const midway = milestoneLadder(25);
  assert.deepEqual(rungsOf(midway, 'reached'), [1, 5, 10, 25]);
  assert.deepEqual(rungsOf(midway, 'next'), [50]);

  // Between rungs the reached set does not move; only the target is ahead.
  const between = milestoneLadder(46);
  assert.deepEqual(rungsOf(between, 'reached'), [1, 5, 10, 25]);
  assert.deepEqual(rungsOf(between, 'next'), [50]);

  const complete = milestoneLadder(200);
  assert.deepEqual(rungsOf(complete, 'reached'), [1, 5, 10, 25, 50, 100, 150, 200]);
  assert.deepEqual(rungsOf(complete, 'next'), []);
  assert.deepEqual(rungsOf(milestoneLadder(4321), 'next'), []);
});

test('the milestone ladder reads garbage as a standing start', () => {
  const start = milestoneLadder(0);
  for (const input of [
    undefined,
    null,
    Number.NaN,
    -5,
    Number.POSITIVE_INFINITY,
    'lots',
    {},
  ]) {
    assert.deepEqual(milestoneLadder(input), start);
  }
  assert.equal(milestoneLadder().length, 8);
});
