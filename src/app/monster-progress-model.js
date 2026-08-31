import { HIGHEST_COMPANION_STAGE } from './companion-stage-contract.js';

const DEFAULT_CATCH_THRESHOLD = 1;
// Same floor as the word list, Parent projection and engine mastery stats.
// A3's monster projection still counts only stage === 4; words practised past
// that would otherwise vanish from hatch evidence while the list still reads
// Secure.
export const WORD_SECURE_STAGE = 4;

// The extracted KS2 core catalogue currently has one aggregate reward track:
// Phaeton. Older product projections did not carry sourceRewardTrackIds, so keep
// this compatibility identity until every persisted/app projection includes the
// catalogue topology. A catalogue-backed source list always takes precedence.
const LEGACY_AGGREGATE_MONSTER_IDS = new Set(['phaeton']);

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function monsterSourceRewardTrackIds(monster) {
  return Array.isArray(monster?.sourceRewardTrackIds)
    ? monster.sourceRewardTrackIds.filter(
      (value) => typeof value === 'string' && value,
    )
    : null;
}

export function isAggregateMonster(monster) {
  if (monster?.aggregate === true) return true;
  const sources = monsterSourceRewardTrackIds(monster);
  if (sources !== null) return sources.length > 0;
  return LEGACY_AGGREGATE_MONSTER_IDS.has(monster?.monsterId);
}

export function monsterCatchThreshold(monster) {
  const threshold = monster?.thresholds?.[0];
  return Number.isSafeInteger(threshold) && threshold >= 0
    ? threshold
    : DEFAULT_CATCH_THRESHOLD;
}

export function monsterDisplayStage(
  monster,
  highestStage = HIGHEST_COMPANION_STAGE,
) {
  const ceiling = nonNegativeInteger(highestStage);
  const derived = nonNegativeInteger(monster?.derivedStage);
  const earned = nonNegativeInteger(monster?.earnedStageHighWater);
  return Math.min(ceiling, Math.max(derived, earned));
}

export function monsterIsFound(monster) {
  const secureCount = nonNegativeInteger(monster?.secureCount);
  return monster?.caught === true
    || monsterDisplayStage(monster) > 0
    || secureCount >= monsterCatchThreshold(monster);
}

export function directSecureWordTotal(monsters = []) {
  if (!Array.isArray(monsters)) return 0;
  return monsters.reduce((total, monster) => (
    isAggregateMonster(monster)
      ? total
      : total + nonNegativeInteger(monster?.secureCount)
  ), 0);
}

export function monsterBranch(monster) {
  return monster?.branch === 'b2' ? 'b2' : 'b1';
}

export function wordIsSecure(stage) {
  return Number.isSafeInteger(stage) && stage >= WORD_SECURE_STAGE;
}

export function derivedMonsterStage(secureCount, thresholds) {
  const count = nonNegativeInteger(secureCount);
  if (!Array.isArray(thresholds)) return 0;
  for (
    let index = Math.min(HIGHEST_COMPANION_STAGE, thresholds.length - 1);
    index >= 1;
    index -= 1
  ) {
    if (count >= thresholds[index]) return index;
  }
  return 0;
}

function publishedThresholds(track) {
  return Array.isArray(track?.thresholds)
    ? track.thresholds.filter((value) => Number.isSafeInteger(value) && value > 0)
    : [];
}

function sourceYearBands(track, tracks) {
  const sources = Array.isArray(track?.sourceRewardTrackIds)
    ? track.sourceRewardTrackIds.filter((value) => typeof value === 'string' && value)
    : [];
  if (sources.length === 0) {
    return typeof track?.yearBand === 'string' && track.yearBand
      ? [track.yearBand]
      : [];
  }
  const trackById = new Map(
    (Array.isArray(tracks) ? tracks : []).map((entry) => [entry.rewardTrackId, entry]),
  );
  return sources
    .map((sourceId) => trackById.get(sourceId)?.yearBand)
    .filter((yearBand) => typeof yearBand === 'string' && yearBand);
}

/** How many catalogue items this reward track can actually count. */
export function catalogueTrackPoolSize(track, items = [], tracks = []) {
  const bands = new Set(sourceYearBands(track, tracks));
  if (bands.size === 0) return 0;
  return (Array.isArray(items) ? items : []).filter(
    (item) => bands.has(item?.yearBand),
  ).length;
}

/**
 * Drop published stage thresholds this catalogue cannot fund. Starter copies
 * Full's [1, 10, 30, 60, 100] even though each year band has ten words, so
 * Codex would keep saying "N of 100" / "10 more to hatch" after the trial
 * list is already secure. Catch/hatch stay the reachable prefix.
 */
export function catalogueReachableThresholds(track, items = [], tracks = []) {
  const published = publishedThresholds(track);
  const poolSize = catalogueTrackPoolSize(track, items, tracks);
  if (published.length === 0 || poolSize <= 0) return published;
  const reachable = published.filter((value) => value <= poolSize);
  return reachable.length > 0 ? reachable : published;
}

/**
 * Rebuild companion hatch evidence from the same per-word secure floor the
 * list uses. Branch identity still comes from the saved A3 state.
 */
export function projectMonstersFromWordSecurity({
  rewardTracks = [],
  items = [],
  progress = {},
  currentState = {},
} = {}) {
  const tracks = Array.isArray(rewardTracks) ? rewardTracks : [];
  const catalogueItems = Array.isArray(items) ? items : [];
  const progressMap = progress && typeof progress === 'object' && !Array.isArray(progress)
    ? progress
    : {};
  const saved = currentState && typeof currentState === 'object' && !Array.isArray(currentState)
    ? currentState
    : {};
  const trackById = new Map(tracks.map((track) => [track.rewardTrackId, track]));
  const evidenceByTrackId = new Map();

  function evidenceFor(trackId) {
    if (evidenceByTrackId.has(trackId)) return evidenceByTrackId.get(trackId);
    const track = trackById.get(trackId);
    const empty = new Set();
    if (!track) {
      evidenceByTrackId.set(trackId, empty);
      return empty;
    }
    const sources = Array.isArray(track.sourceRewardTrackIds)
      ? track.sourceRewardTrackIds.filter(
        (value) => typeof value === 'string' && value,
      )
      : [];
    const evidence = sources.length === 0
      ? new Set(catalogueItems
        .filter((item) => item?.yearBand === track.yearBand
          && wordIsSecure(progressMap[item.runtimeItemId]?.stage))
        .map((item) => item.runtimeItemId))
      : new Set(sources.flatMap((sourceId) => [...evidenceFor(sourceId)]));
    evidenceByTrackId.set(trackId, evidence);
    return evidence;
  }

  return tracks.map((track) => {
    const current = saved[track.rewardTrackId];
    const thresholds = catalogueReachableThresholds(track, catalogueItems, tracks);
    const secureCount = evidenceFor(track.rewardTrackId).size;
    const derivedStage = derivedMonsterStage(secureCount, thresholds);
    const earnedStageHighWater = Math.max(
      derivedStage,
      nonNegativeInteger(current?.earnedStageHighWater),
    );
    const catchThreshold = monsterCatchThreshold({ thresholds });
    return {
      rewardTrackId: track.rewardTrackId,
      packId: track.packId,
      monsterId: track.monsterId,
      thresholds: [...thresholds],
      branch: current?.branch ?? null,
      secureCount,
      caught: secureCount >= catchThreshold
        || current?.caught === true
        || earnedStageHighWater > 0,
      derivedStage,
      earnedStageHighWater,
    };
  });
}
