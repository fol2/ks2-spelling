const STARTER_CATALOGUE_ID = 'ks2-core:starter';
const STARTER_PACK_ID = 'ks2-core';

const EMPTY_SUBJECT_STATE = Object.freeze({
  ui: Object.freeze({}),
  data: Object.freeze({
    prefs: Object.freeze({ autoSpeak: false }),
    progress: Object.freeze({}),
    guardianMap: Object.freeze({}),
    pattern: Object.freeze({ wobblingByRuntimeItemId: Object.freeze({}) }),
    postMega: null,
    achievements: Object.freeze({}),
    persistenceWarning: null,
  }),
});

export function emptyStarterSnapshot(learnerId) {
  return {
    schemaVersion: 1,
    learnerId,
    revision: 0,
    packId: STARTER_PACK_ID,
    catalogueId: STARTER_CATALOGUE_ID,
    grantedEntitlementIds: [],
    subjectState: structuredClone(EMPTY_SUBJECT_STATE),
    practiceSession: null,
    eventLog: [],
    monsterStateByRewardTrackId: {},
    campStateByPackId: {},
  };
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value) {
  return value === undefined ? value : structuredClone(value);
}

function asRecord(value) {
  return isPlainRecord(value) ? value : {};
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function maxNumber(left, right) {
  const leftNumber = isNumber(left) ? left : 0;
  const rightNumber = isNumber(right) ? right : 0;
  return Math.max(leftNumber, rightNumber);
}

function maxOptionalNumber(left, right) {
  const leftNumber = isNumber(left);
  const rightNumber = isNumber(right);
  if (leftNumber && rightNumber) return Math.max(left, right);
  if (leftNumber) return left;
  if (rightNumber) return right;
  return null;
}

export function mergeProfiles(local, remote) {
  if (local == null) return cloneJson(remote);
  if (remote == null) return cloneJson(local);
  if (!isPlainRecord(local) || !isPlainRecord(remote)) {
    throw new TypeError('Profiles must be plain records.');
  }
  if (local.learnerId !== remote.learnerId) {
    throw new TypeError('Profile learnerId must match.');
  }
  const localTime = isNumber(local.updatedAt) ? local.updatedAt : -Infinity;
  const remoteTime = isNumber(remote.updatedAt) ? remote.updatedAt : -Infinity;
  return cloneJson(remoteTime >= localTime ? remote : local);
}

function mergeProgressItem(local, remote) {
  const localItem = asRecord(local);
  const remoteItem = asRecord(remote);
  const localLastDay = isNumber(localItem.lastDay) ? localItem.lastDay : null;
  const remoteLastDay = isNumber(remoteItem.lastDay) ? remoteItem.lastDay : null;
  const lastDay = maxOptionalNumber(localLastDay, remoteLastDay);
  const localStage = maxNumber(localItem.stage, 0);
  const remoteStage = maxNumber(remoteItem.stage, 0);
  let lastResult = remoteItem.lastResult ?? localItem.lastResult ?? null;
  if (localLastDay != null || remoteLastDay != null) {
    if (remoteLastDay == null) lastResult = localItem.lastResult ?? null;
    else if (localLastDay == null) lastResult = remoteItem.lastResult ?? null;
    else if (remoteLastDay > localLastDay) lastResult = remoteItem.lastResult ?? null;
    else if (localLastDay > remoteLastDay) lastResult = localItem.lastResult ?? null;
    else if (remoteStage >= localStage) lastResult = remoteItem.lastResult ?? null;
    else lastResult = localItem.lastResult ?? null;
  } else if (remoteStage >= localStage) {
    lastResult = remoteItem.lastResult ?? localItem.lastResult ?? null;
  } else {
    lastResult = localItem.lastResult ?? remoteItem.lastResult ?? null;
  }
  return {
    ...cloneJson(localItem),
    ...cloneJson(remoteItem),
    stage: Math.max(localStage, remoteStage),
    attempts: maxNumber(localItem.attempts, remoteItem.attempts),
    correct: maxNumber(localItem.correct, remoteItem.correct),
    wrong: maxNumber(localItem.wrong, remoteItem.wrong),
    dueDay: maxOptionalNumber(localItem.dueDay, remoteItem.dueDay),
    lastDay,
    lastResult,
  };
}

function mergeKeyedRecords(local, remote, mergeShared) {
  const left = asRecord(local);
  const right = asRecord(remote);
  const merged = {};
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (!Object.hasOwn(left, key)) merged[key] = cloneJson(right[key]);
    else if (!Object.hasOwn(right, key)) merged[key] = cloneJson(left[key]);
    else merged[key] = mergeShared(left[key], right[key]);
  }
  return merged;
}

function mergeNumericOwnKeys(local, remote) {
  const left = asRecord(local);
  const right = asRecord(remote);
  const merged = { ...cloneJson(left), ...cloneJson(right) };
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const leftValue = left[key];
    const rightValue = right[key];
    if (isNumber(leftValue) && isNumber(rightValue)) {
      merged[key] = Math.max(leftValue, rightValue);
    } else if (Array.isArray(leftValue) && Array.isArray(rightValue)) {
      merged[key] = [...new Set([...leftValue, ...rightValue])];
    } else if (isNumber(leftValue) && rightValue === undefined) {
      merged[key] = leftValue;
    } else if (isNumber(rightValue) && leftValue === undefined) {
      merged[key] = rightValue;
    }
  }
  return merged;
}

function numericProgress(record, keys) {
  const value = asRecord(record);
  return keys.reduce((highest, key) => Math.max(highest, maxNumber(value[key], 0)), 0);
}

function mergeGuardianRecord(local, remote) {
  const left = asRecord(local);
  const right = asRecord(remote);
  const preferred = numericProgress(right, Object.keys(right)) >= numericProgress(left, Object.keys(left))
    ? right
    : left;
  return {
    ...cloneJson(preferred),
    ...mergeNumericOwnKeys(left, right),
  };
}

function mergeMonsterRecord(local, remote) {
  const left = asRecord(local);
  const right = asRecord(remote);
  const preferred = numericProgress(right, [
    'secureCount', 'derivedStage', 'earnedStageHighWater', 'stage', 'level', 'xp', 'stars',
  ]) >= numericProgress(left, [
    'secureCount', 'derivedStage', 'earnedStageHighWater', 'stage', 'level', 'xp', 'stars',
  ]) ? right : left;
  const merged = {
    ...cloneJson(preferred),
    ...mergeNumericOwnKeys(left, right),
  };
  if (left.caught === true || right.caught === true) merged.caught = true;
  return merged;
}

function mergeCampRecord(local, remote) {
  const left = asRecord(local);
  const right = asRecord(remote);
  const leftWater = maxNumber(left.campHighWater, 0);
  const rightWater = maxNumber(right.campHighWater, 0);
  const preferred = rightWater >= leftWater ? right : left;
  const acknowledgements = Array.isArray(left.acknowledgements) || Array.isArray(right.acknowledgements)
    ? [...new Set([
      ...(Array.isArray(left.acknowledgements) ? left.acknowledgements : []),
      ...(Array.isArray(right.acknowledgements) ? right.acknowledgements : []),
    ])]
    : preferred.acknowledgements;
  return {
    ...cloneJson(preferred),
    ...mergeNumericOwnKeys(left, right),
    campHighWater: Math.max(leftWater, rightWater),
    lastCreditedGuardianDay: maxOptionalNumber(
      left.lastCreditedGuardianDay,
      right.lastCreditedGuardianDay,
    ),
    lastCreditedEventId: preferred.lastCreditedEventId,
    acknowledgements,
  };
}

function mergeEventLog(local, remote) {
  const events = new Map();
  for (const event of [...(Array.isArray(local) ? local : []), ...(Array.isArray(remote) ? remote : [])]) {
    if (!isPlainRecord(event) || typeof event.id !== 'string') continue;
    if (!events.has(event.id)) events.set(event.id, cloneJson(event));
  }
  return [...events.values()].sort((left, right) => {
    const time = (isNumber(left.createdAt) ? left.createdAt : 0)
      - (isNumber(right.createdAt) ? right.createdAt : 0);
    if (time !== 0) return time;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

function pickByRevision(local, remote, localRevision, remoteRevision, reader) {
  if (remoteRevision > localRevision) return cloneJson(reader(remote));
  if (localRevision > remoteRevision) return cloneJson(reader(local));
  return cloneJson(reader(remote));
}

export function mergeSnapshots(local, remote) {
  if (local == null && remote == null) {
    throw new TypeError('Snapshots are required.');
  }
  if (local == null) {
    const cloned = cloneJson(remote);
    return {
      ...cloned,
      packId: STARTER_PACK_ID,
      catalogueId: STARTER_CATALOGUE_ID,
      grantedEntitlementIds: [],
    };
  }
  if (remote == null) return cloneJson(local);
  if (!isPlainRecord(local) || !isPlainRecord(remote)) {
    throw new TypeError('Snapshots must be plain records.');
  }
  if (local.learnerId !== remote.learnerId) {
    throw new TypeError('Snapshot learnerId must match.');
  }

  const localRevision = maxNumber(local.revision, 0);
  const remoteRevision = maxNumber(remote.revision, 0);
  const localSubject = asRecord(local.subjectState);
  const remoteSubject = asRecord(remote.subjectState);
  const localData = asRecord(localSubject.data);
  const remoteData = asRecord(remoteSubject.data);

  return {
    schemaVersion: local.schemaVersion ?? remote.schemaVersion ?? 1,
    learnerId: local.learnerId,
    revision: Math.max(localRevision, remoteRevision),
    packId: local.packId ?? STARTER_PACK_ID,
    catalogueId: local.catalogueId ?? STARTER_CATALOGUE_ID,
    grantedEntitlementIds: Array.isArray(local.grantedEntitlementIds)
      ? cloneJson(local.grantedEntitlementIds)
      : [],
    subjectState: {
      ui: pickByRevision(localSubject, remoteSubject, localRevision, remoteRevision, (value) => (
        asRecord(value).ui ?? {}
      )),
      data: {
        prefs: pickByRevision(localData, remoteData, localRevision, remoteRevision, (value) => (
          asRecord(value).prefs ?? { autoSpeak: false }
        )),
        progress: mergeKeyedRecords(localData.progress, remoteData.progress, mergeProgressItem),
        guardianMap: mergeKeyedRecords(
          localData.guardianMap,
          remoteData.guardianMap,
          mergeGuardianRecord,
        ),
        pattern: pickByRevision(localData, remoteData, localRevision, remoteRevision, (value) => (
          asRecord(value).pattern ?? { wobblingByRuntimeItemId: {} }
        )),
        postMega: pickByRevision(localData, remoteData, localRevision, remoteRevision, (value) => (
          asRecord(value).postMega ?? null
        )),
        achievements: pickByRevision(localData, remoteData, localRevision, remoteRevision, (value) => (
          asRecord(value).achievements ?? {}
        )),
        persistenceWarning: pickByRevision(localData, remoteData, localRevision, remoteRevision, (value) => (
          asRecord(value).persistenceWarning ?? null
        )),
      },
    },
    practiceSession: pickByRevision(local, remote, localRevision, remoteRevision, (value) => (
      value.practiceSession ?? null
    )),
    eventLog: mergeEventLog(local.eventLog, remote.eventLog),
    monsterStateByRewardTrackId: mergeKeyedRecords(
      local.monsterStateByRewardTrackId,
      remote.monsterStateByRewardTrackId,
      mergeMonsterRecord,
    ),
    campStateByPackId: mergeKeyedRecords(
      local.campStateByPackId,
      remote.campStateByPackId,
      mergeCampRecord,
    ),
  };
}
