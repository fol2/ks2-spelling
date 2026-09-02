const CHOICE_RECENCY_KEY = 'branchRevision';

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneWithoutChoiceRecency(monster) {
  if (!isPlainRecord(monster) || !Object.hasOwn(monster, CHOICE_RECENCY_KEY)) {
    return monster;
  }
  const next = { ...monster };
  delete next[CHOICE_RECENCY_KEY];
  return next;
}

function withChoiceRecency(monster, stamp) {
  if (!isPlainRecord(monster) || stamp == null) return monster;
  return { ...monster, [CHOICE_RECENCY_KEY]: stamp };
}

function mapMonsterRecord(monsters, mapper) {
  if (!isPlainRecord(monsters)) return monsters;
  const next = {};
  for (const [rewardTrackId, monster] of Object.entries(monsters)) {
    next[rewardTrackId] = mapper(rewardTrackId, monster);
  }
  return next;
}

export function monsterChoiceStamp(record) {
  const value = record?.[CHOICE_RECENCY_KEY];
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function takeMonsterChoiceRecency(value) {
  const recency = new Map();
  if (!isPlainRecord(value)) return recency;
  const monsters = value.monsterStateByRewardTrackId ?? value.nextMonsterStateByRewardTrackId;
  if (!isPlainRecord(monsters)) return recency;
  for (const [rewardTrackId, monster] of Object.entries(monsters)) {
    const stamp = monsterChoiceStamp(monster);
    if (stamp != null) recency.set(rewardTrackId, stamp);
  }
  return recency;
}

export function combineMonsterChoiceRecency(primary, fallback) {
  const combined = new Map(fallback);
  for (const [rewardTrackId, stamp] of primary) combined.set(rewardTrackId, stamp);
  return combined;
}

export function stripMonsterChoiceRecency(value) {
  if (!isPlainRecord(value)) return value;
  if (isPlainRecord(value.monsterStateByRewardTrackId)) {
    return {
      ...value,
      monsterStateByRewardTrackId: mapMonsterRecord(
        value.monsterStateByRewardTrackId,
        (_id, monster) => cloneWithoutChoiceRecency(monster),
      ),
    };
  }
  if (!isPlainRecord(value.nextMonsterStateByRewardTrackId)) return value;
  const next = {
    ...value,
    nextMonsterStateByRewardTrackId: mapMonsterRecord(
      value.nextMonsterStateByRewardTrackId,
      (_id, monster) => cloneWithoutChoiceRecency(monster),
    ),
  };
  if (Array.isArray(value.projections?.monsters)) {
    next.projections = {
      ...value.projections,
      monsters: value.projections.monsters.map((monster) => cloneWithoutChoiceRecency(monster)),
    };
  }
  return next;
}

export function restoreMonsterChoiceRecency(value, recency) {
  if (!isPlainRecord(value) || !(recency instanceof Map) || recency.size === 0) {
    return value;
  }
  const stampFor = (rewardTrackId, monster) => (
    recency.get(rewardTrackId) ?? recency.get(monster?.rewardTrackId) ?? null
  );
  if (isPlainRecord(value.monsterStateByRewardTrackId)) {
    return {
      ...value,
      monsterStateByRewardTrackId: mapMonsterRecord(
        value.monsterStateByRewardTrackId,
        (rewardTrackId, monster) => withChoiceRecency(monster, stampFor(rewardTrackId, monster)),
      ),
    };
  }
  if (!isPlainRecord(value.nextMonsterStateByRewardTrackId)) return value;
  const next = {
    ...value,
    nextMonsterStateByRewardTrackId: mapMonsterRecord(
      value.nextMonsterStateByRewardTrackId,
      (rewardTrackId, monster) => withChoiceRecency(monster, stampFor(rewardTrackId, monster)),
    ),
  };
  if (Array.isArray(value.projections?.monsters)) {
    next.projections = {
      ...value.projections,
      monsters: value.projections.monsters.map((monster) => (
        withChoiceRecency(monster, stampFor(monster?.rewardTrackId, monster))
      )),
    };
  }
  return next;
}
