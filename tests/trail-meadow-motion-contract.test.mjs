import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTrailMeadowCompanions,
} from '../src/app/trail/trail-meadow-model.js';

function companion(monsterId, stage) {
  return {
    rewardTrackId: `spelling-core-${monsterId}`,
    monsterId,
    branch: 'b1',
    found: true,
    stage,
    art: `/mastery-art/monsters/${monsterId}/b1/${monsterId}-b1-${stage}.640.webp`,
  };
}

test('mature ground and air routes remain calm, bounded and non-zero', () => {
  const living = buildTrailMeadowCompanions([
    companion('inklet', 3),
    companion('glimmerbug', 3),
    companion('phaeton', 4),
    companion('vellhorn', 3),
  ], { seed: 'learner-a:Y5' });

  const byId = new Map(living.map((entry) => [entry.monsterId, entry]));
  assert.ok(byId.get('inklet').route.duration >= 23);
  assert.ok(byId.get('vellhorn').route.duration >= 26);
  assert.ok(byId.get('glimmerbug').route.duration >= 15);
  assert.ok(byId.get('phaeton').route.duration >= 18);
  assert.ok(living.every(({ route }) => (
    route.duration > 0
    && Math.abs(route.forward) <= 60
    && Math.abs(route.back) <= 60
  )));
});
