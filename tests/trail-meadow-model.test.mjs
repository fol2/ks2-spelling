import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTrailMeadowCompanions,
  trailCompanionBehaviour,
} from '../src/app/trail/trail-meadow-model.js';

function companion(monsterId, stage, overrides = {}) {
  return {
    rewardTrackId: `spelling-core-${monsterId}`,
    monsterId,
    branch: 'b1',
    found: true,
    stage,
    art: `/mastery-art/monsters/${monsterId}/b1/${monsterId}-b1-${stage}.640.webp`,
    name: monsterId,
    displayName: monsterId,
    title: `${monsterId} stage ${stage}`,
    stageLabel: `Stage ${stage} of 4`,
    ...overrides,
  };
}

function distance(left, right) {
  const dx = left.x - right.x;
  const dy = (left.footY - right.footY) * 1.4;
  return Math.hypot(dx, dy);
}

function homes(companions) {
  return companions.map(({ monsterId, x, footY }) => ({ monsterId, x, footY }));
}

test('stage-zero companions stay grounded in nests regardless of species', () => {
  for (const monsterId of ['inklet', 'glimmerbug', 'phaeton', 'vellhorn']) {
    assert.deepEqual(trailCompanionBehaviour(companion(monsterId, 0)), {
      path: 'egg',
      motion: 'egg-breathe',
      lane: 'ground',
      description: 'resting in a nest',
    });
  }

  const eggs = buildTrailMeadowCompanions([
    companion('inklet', 0),
    companion('glimmerbug', 0),
    companion('phaeton', 0),
  ], { seed: 'learner-a' });
  assert.ok(eggs.every(({ path, lane, route }) => (
    path === 'egg'
    && lane === 'ground'
    && route.duration === 0
    && route.forward === 0
    && route.back === 0
  )));
});

test('mature species use their canonical ground or air habitat', () => {
  assert.deepEqual(trailCompanionBehaviour(companion('inklet', 2)), {
    path: 'walk',
    motion: 'trot',
    lane: 'ground',
    description: 'trot around the meadow',
  });
  assert.deepEqual(trailCompanionBehaviour(companion('glimmerbug', 2)), {
    path: 'fly-a',
    motion: 'flutter',
    lane: 'air',
    description: 'flutter above the meadow',
  });
  assert.deepEqual(trailCompanionBehaviour(companion('phaeton', 4)), {
    path: 'fly-b',
    motion: 'soar',
    lane: 'air',
    description: 'soar above the meadow',
  });
  assert.deepEqual(trailCompanionBehaviour(companion('vellhorn', 3)), {
    path: 'walk-b',
    motion: 'stalk',
    lane: 'ground',
    description: 'stalk around the meadow',
  });
});

test('layout is stable per learner and separates the four habitat occupants', () => {
  const roster = [
    companion('inklet', 3),
    companion('glimmerbug', 2),
    companion('phaeton', 4, { branch: 'b2' }),
    companion('vellhorn', 1),
  ];
  const first = buildTrailMeadowCompanions(roster, { seed: 'learner-a:Y5' });
  const repeat = buildTrailMeadowCompanions(roster, { seed: 'learner-a:Y5' });
  assert.deepEqual(repeat, first);

  const editedYearGroup = buildTrailMeadowCompanions(roster, {
    seed: 'learner-a:Y3',
  });
  assert.deepEqual(
    homes(editedYearGroup),
    homes(first),
    'editing display context must not rearrange a learner\'s habitat',
  );

  const anotherLearner = buildTrailMeadowCompanions(roster, {
    seed: 'learner-b:Y5',
  });
  assert.notDeepEqual(homes(anotherLearner), homes(first));

  for (let left = 0; left < first.length; left += 1) {
    for (let right = left + 1; right < first.length; right += 1) {
      assert.ok(
        distance(first[left], first[right]) >= 16,
        `${first[left].monsterId} overlaps ${first[right].monsterId}`,
      );
    }
  }
});

test('every evolution stage grows without teleporting a companion home', () => {
  const stageRosters = [1, 2, 3, 4].map((stage) => [
    companion('inklet', stage),
    companion('glimmerbug', stage),
    companion('phaeton', stage),
    companion('vellhorn', stage),
  ]);
  const stages = stageRosters.map((roster) => (
    buildTrailMeadowCompanions(roster, { seed: 'learner-a:Y5' })
  ));

  for (let stage = 1; stage < stages.length; stage += 1) {
    assert.deepEqual(homes(stages[stage]), homes(stages[0]));
    assert.ok(
      stages[stage].every((entry, index) => entry.size > stages[stage - 1][index].size),
      `stage ${stage + 1} must be visibly larger than stage ${stage}`,
    );
  }
  assert.notDeepEqual(
    stages.at(-1).map(({ motion, route }) => ({ motion, route })),
    stages[0].map(({ motion, route }) => ({ motion, route })),
  );
});

test('perspective and authored facing affect presentation without changing progress', () => {
  const young = buildTrailMeadowCompanions([
    companion('phaeton', 1),
  ], { seed: 'learner-a' })[0];
  const final = buildTrailMeadowCompanions([
    companion('phaeton', 4),
  ], { seed: 'learner-a' })[0];
  assert.ok(final.size > young.size);
  assert.equal(final.x, young.x);
  assert.equal(final.footY, young.footY);
  assert.equal(final.face, 1, 'Phaeton b1 is authored facing right');
  assert.equal(final.reverseFace, -1);
  assert.ok(final.airLift < 0);
  assert.ok(final.shadowScale < 1);
  assert.equal(final.stage, 4);
});

test('unfound or artless entries never create invisible interaction targets', () => {
  const roster = [
    companion('inklet', 1, { found: false }),
    companion('glimmerbug', 1, { art: null }),
    companion('phaeton', 1),
  ];
  assert.deepEqual(
    buildTrailMeadowCompanions(roster).map(({ monsterId }) => monsterId),
    ['phaeton'],
  );
});
