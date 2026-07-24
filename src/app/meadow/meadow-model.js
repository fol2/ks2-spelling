/**
 * Meadow and codex-lite projections over the A3 monster list.
 *
 * Reachable spelling species are the Full-pack trio. Vellhorn stays vendored
 * but unreachable (C6 simplification). On the Starter pack only Inklet can be
 * caught; Glimmerbug and Phaeton still appear as locked silhouette slots so
 * the collection reads as having room to grow.
 */

import { stageArtUrl } from '../monster-stage/monster-stage-model.js';
import { monsterDisplayName } from '../celebrations/celebration-model.js';

export const MEADOW_EMPTY_TITLE = 'Nothing caught yet';
export const MEADOW_EMPTY_BODY =
  'Nothing caught yet. Your meadow stays tidy. Finish a round to see your first monster appear.';

/** Spelling species that may appear in meadow / codex. Order is display order. */
export const REACHABLE_SPECIES = Object.freeze([
  Object.freeze({
    monsterId: 'inklet',
    name: 'Inklet',
    blurb: 'Grows as Year 3–4 spellings become secure.',
  }),
  Object.freeze({
    monsterId: 'glimmerbug',
    name: 'Glimmerbug',
    blurb: 'Appears as Year 5–6 spellings settle into memory.',
  }),
  Object.freeze({
    monsterId: 'phaeton',
    name: 'Phaeton',
    blurb: 'Rises when both spelling pools grow strong.',
  }),
]);

function monsterById(monsters) {
  const map = new Map();
  if (!Array.isArray(monsters)) return map;
  for (const monster of monsters) {
    if (!monster || typeof monster.monsterId !== 'string') continue;
    map.set(monster.monsterId, monster);
  }
  return map;
}

function isCaught(monster) {
  return monster?.caught === true;
}

/**
 * Home meadow slots. Caught species show stage art; every reachable species
 * that is not yet caught appears as a locked silhouette so the strip reads as
 * a collection. When nothing is caught, return [] and let the empty state
 * speak — three locked slots with no companion would feel like a shop window.
 */
export function buildMeadowSlots(monsters) {
  const byId = monsterById(monsters);
  const anyCaught = REACHABLE_SPECIES.some(({ monsterId }) =>
    isCaught(byId.get(monsterId)),
  );
  if (!anyCaught) return [];

  return REACHABLE_SPECIES.map(({ monsterId, name }) => {
    const monster = byId.get(monsterId);
    if (isCaught(monster)) {
      const branch = monster.branch ?? 'b1';
      const stage = monster.derivedStage ?? 0;
      return {
        monsterId,
        name,
        kind: 'caught',
        branch,
        stage,
        secureCount: monster.secureCount ?? 0,
        artUrl: stageArtUrl(monsterId, branch, stage),
      };
    }
    return {
      monsterId,
      name,
      kind: 'locked',
      branch: 'b1',
      stage: 0,
      secureCount: 0,
      artUrl: stageArtUrl(monsterId, 'b1', 0),
    };
  });
}

/**
 * Codex-lite roster: every reachable species, caught ones with live art and
 * unowned ones as locked silhouettes. Species absent from the active
 * catalogue projection (Starter pack) are locked, never omitted.
 */
export function buildCodexEntries(monsters) {
  const byId = monsterById(monsters);
  return REACHABLE_SPECIES.map(({ monsterId, name, blurb }) => {
    const monster = byId.get(monsterId);
    if (isCaught(monster)) {
      const branch = monster.branch ?? 'b1';
      const stage = monster.derivedStage ?? 0;
      return {
        monsterId,
        name: monsterDisplayName(monsterId),
        speciesName: name,
        blurb,
        kind: 'caught',
        caught: true,
        branch,
        stage,
        secureCount: monster.secureCount ?? 0,
        thresholds: Array.isArray(monster.thresholds)
          ? [...monster.thresholds]
          : [],
        artUrl: stageArtUrl(monsterId, branch, stage),
        imageAlt: monsterDisplayName(monsterId),
      };
    }
    return {
      monsterId,
      name: 'Unknown creature',
      speciesName: name,
      blurb,
      kind: 'locked',
      caught: false,
      branch: 'b1',
      stage: 0,
      secureCount: 0,
      thresholds: Array.isArray(monster?.thresholds)
        ? [...monster.thresholds]
        : [],
      artUrl: stageArtUrl(monsterId, 'b1', 0),
      imageAlt: `${name} not caught`,
    };
  });
}

/** First caught entry, or null when the codex is empty of companions. */
export function pickFeaturedCodexEntry(entries) {
  if (!Array.isArray(entries)) return null;
  return entries.find((entry) => entry.caught) ?? null;
}
