import { isAggregateMonster } from './monster-progress-model.js';

const CORE_COVERAGE_TIER = 'statutory-core';
const ROUND_SOURCE = 'round';

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isCoreItem(item) {
  return item?.coverageTier == null || item.coverageTier === CORE_COVERAGE_TIER;
}

function isYearBandTrack(track) {
  if (!track || typeof track !== 'object') return false;
  if (typeof track.yearBand !== 'string' || track.yearBand.length === 0) {
    return false;
  }
  if (
    Array.isArray(track.sourceRewardTrackIds)
    && track.sourceRewardTrackIds.length > 0
  ) {
    return false;
  }
  return true;
}

export function coreItemCount(catalogue) {
  const items = Array.isArray(catalogue?.items) ? catalogue.items : [];
  return items.filter(isCoreItem).length;
}

export function remainingStarterWordCount({
  starterCatalogue,
  fullCatalogue,
} = {}) {
  return Math.max(0, coreItemCount(fullCatalogue) - coreItemCount(starterCatalogue));
}

export function starterYearBandTracks(starterCatalogue) {
  const tracks = Array.isArray(starterCatalogue?.rewardTracks)
    ? starterCatalogue.rewardTracks
    : [];
  return tracks.filter(isYearBandTrack);
}

export function starterBandItemCount(starterCatalogue, yearBand) {
  if (typeof yearBand !== 'string' || yearBand.length === 0) return 0;
  const items = Array.isArray(starterCatalogue?.items) ? starterCatalogue.items : [];
  return items.filter((item) => item?.yearBand === yearBand && isCoreItem(item)).length;
}

function monsterByTrack(monsters, rewardTrackId) {
  if (!Array.isArray(monsters)) return null;
  return monsters.find((monster) => monster?.rewardTrackId === rewardTrackId) ?? null;
}

export function monstersFromSnapshot(snapshot) {
  const saved = snapshot?.monsterStateByRewardTrackId;
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return [];
  return Object.entries(saved).map(([rewardTrackId, state]) => ({
    rewardTrackId,
    monsterId: state?.monsterId ?? null,
    secureCount: nonNegativeInteger(state?.secureCount),
  }));
}

export function starterYearBandIsSecure(monsters, starterCatalogue) {
  return starterYearBandTracks(starterCatalogue).some((track) => {
    const threshold = starterBandItemCount(starterCatalogue, track.yearBand);
    if (threshold <= 0) return false;
    const monster = monsterByTrack(monsters, track.rewardTrackId);
    if (isAggregateMonster(monster)) return false;
    return nonNegativeInteger(monster?.secureCount) >= threshold;
  });
}

export function starterCompleteMomentCrossed({
  beforeMonsters,
  afterMonsters,
  starterCatalogue,
} = {}) {
  return !starterYearBandIsSecure(beforeMonsters, starterCatalogue)
    && starterYearBandIsSecure(afterMonsters, starterCatalogue);
}

/**
 * One calm child-facing moment when either Starter year band becomes secure.
 * Live round crossings may show it; restart, reset, import, replica and reseed
 * consume the flag without showing. The presented flag is app-side state.
 */
export function starterCompleteMomentDecision({
  beforeMonsters,
  afterMonsters,
  starterCatalogue,
  presented = false,
  entitled = false,
  remainingWordCount = 0,
  source,
} = {}) {
  if (presented === true) {
    return Object.freeze({ show: false, persist: true });
  }
  const afterSecure = starterYearBandIsSecure(afterMonsters, starterCatalogue);
  if (!afterSecure) {
    return Object.freeze({ show: false, persist: false });
  }
  const remaining = nonNegativeInteger(remainingWordCount);
  const liveCrossing = source === ROUND_SOURCE
    && starterCompleteMomentCrossed({
      beforeMonsters,
      afterMonsters,
      starterCatalogue,
    });
  const show = liveCrossing
    && entitled !== true
    && remaining > 0;
  return Object.freeze({ show, persist: true });
}

export function starterCompleteMomentCopy(remainingWordCount) {
  const remaining = nonNegativeInteger(remainingWordCount);
  const waiting = remaining === 1
    ? 'There is 1 more word waiting.'
    : `There are ${remaining} more words waiting.`;
  return Object.freeze({
    eyebrow: 'Starter set',
    headline: 'These words are secure',
    body: waiting,
    grownUpAction: 'Ask a grown-up',
    continueAction: 'Continue',
    announcement: `These words are secure. ${waiting} Ask a grown-up.`,
  });
}

export async function readAndConsumeStarterCompleteMoment({
  store,
  learnerId,
  monsters,
  starterCatalogue,
  remainingWordCount,
  entitled = false,
  source,
} = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.write !== 'function') {
    throw new TypeError('Starter complete moment store must expose read() and write().');
  }
  if (typeof learnerId !== 'string' || learnerId.length === 0) {
    throw new TypeError('Starter complete moment learnerId must be a non-empty string.');
  }
  const record = await store.read(learnerId);
  const presented = record?.presented === true;
  const decision = starterCompleteMomentDecision({
    beforeMonsters: monsters,
    afterMonsters: monsters,
    starterCatalogue,
    presented,
    entitled,
    remainingWordCount,
    source,
  });
  if (decision.persist && !presented) {
    await store.write(learnerId, { presented: true });
  }
  return presented || decision.persist;
}
