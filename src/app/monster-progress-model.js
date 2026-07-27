const DEFAULT_CATCH_THRESHOLD = 1;
const DEFAULT_HIGHEST_STAGE = 4;

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
    ? monster.sourceRewardTrackIds.filter((value) => typeof value === 'string' && value)
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
  highestStage = DEFAULT_HIGHEST_STAGE,
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
