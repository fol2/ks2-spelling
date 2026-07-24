import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MEADOW_EMPTY_BODY,
  MEADOW_EMPTY_TITLE,
  REACHABLE_SPECIES,
  buildCodexEntries,
  buildMeadowSlots,
  pickFeaturedCodexEntry,
} from '../src/app/meadow/meadow-model.js';

function monster(overrides = {}) {
  return {
    rewardTrackId: 'spelling-core-inklet',
    packId: 'ks2-core',
    monsterId: 'inklet',
    thresholds: [1, 10, 30, 60, 100],
    branch: 'b1',
    secureCount: 0,
    caught: false,
    derivedStage: 0,
    earnedStageHighWater: 0,
    ...overrides,
  };
}

test('reachable roster is the Full-pack trio and never vellhorn', () => {
  assert.deepEqual(
    REACHABLE_SPECIES.map((entry) => entry.monsterId),
    ['inklet', 'glimmerbug', 'phaeton'],
  );
});

test('meadow is empty until something is caught', () => {
  assert.deepEqual(buildMeadowSlots([]), []);
  assert.deepEqual(
    buildMeadowSlots([monster({ caught: false, secureCount: 0 })]),
    [],
  );
  assert.match(MEADOW_EMPTY_TITLE, /Nothing caught yet/);
  assert.match(MEADOW_EMPTY_BODY, /meadow stays tidy/);
});

test('caught Inklet fills the meadow and leaves Full-pack slots locked', () => {
  const slots = buildMeadowSlots([
    monster({ caught: true, secureCount: 1, derivedStage: 0 }),
  ]);
  assert.equal(slots.length, 3);
  assert.equal(slots[0].kind, 'caught');
  assert.equal(slots[0].monsterId, 'inklet');
  assert.match(slots[0].artUrl, /inklet-b1-0\.640\.webp$/);
  assert.equal(slots[1].kind, 'locked');
  assert.equal(slots[1].monsterId, 'glimmerbug');
  assert.equal(slots[2].kind, 'locked');
  assert.equal(slots[2].monsterId, 'phaeton');
});

test('codex lists every reachable species with locked Full-pack silhouettes', () => {
  const entries = buildCodexEntries([
    monster({ caught: true, secureCount: 1, derivedStage: 0, branch: 'b2' }),
  ]);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].caught, true);
  assert.equal(entries[0].name, 'Inklet');
  assert.match(entries[0].artUrl, /inklet-b2-0\.640\.webp$/);
  assert.equal(entries[1].kind, 'locked');
  assert.equal(entries[1].name, 'Unknown creature');
  assert.equal(entries[1].speciesName, 'Glimmerbug');
  assert.equal(entries[2].kind, 'locked');
  assert.equal(entries[2].speciesName, 'Phaeton');
});

test('uncatched catalogue tracks stay locked rather than omitted', () => {
  const entries = buildCodexEntries([
    monster({ caught: false, secureCount: 0 }),
    monster({
      rewardTrackId: 'spelling-core-glimmerbug',
      monsterId: 'glimmerbug',
      caught: false,
    }),
  ]);
  assert.ok(entries.every((entry) => entry.kind === 'locked'));
  assert.equal(pickFeaturedCodexEntry(entries), null);
});

test('pickFeaturedCodexEntry prefers the first caught companion', () => {
  const entries = buildCodexEntries([
    monster({
      rewardTrackId: 'spelling-core-glimmerbug',
      monsterId: 'glimmerbug',
      caught: true,
      secureCount: 1,
      derivedStage: 1,
    }),
  ]);
  assert.equal(pickFeaturedCodexEntry(entries)?.monsterId, 'glimmerbug');
});
