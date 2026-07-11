import {
  deriveGuardianAggregates,
} from '../../core/index.js';
import {
  createLegacyEngineContentSnapshot,
  toLegacyEngineSnapshot,
  validateCatalogueV1,
} from '../index.js';
import {
  canonicalGuardianDay,
  validateSpellingCommandSnapshotV1,
} from './command-contracts.js';
import { validateSpellingProfile } from './profile-repository.js';
import { createSpellingRevisionMissionIntegrity } from './revision-projection.js';

const FORBIDDEN_PARENT_DOMAIN = /monster|camp|reward.?track|branch|high.?water/i;
const REVISION_MODES = new Set(['guardian', 'boss', 'pattern-quest']);
const REVISION_KINDS = new Set(['first-patrol', 'wobbling', 'due']);
const CANONICAL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REVISION_MISSION_KEYS = new Set([
  'sessionId', 'learnerId', 'packId', 'kind', 'startedGuardianDay', 'campEligible',
]);
const SESSION_KEYS = new Set([
  'id', 'learnerId', 'subjectId', 'status', 'mode', 'state', 'summary',
  'startedAt', 'updatedAt', 'completedAt',
]);

function plainRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  return value;
}

function cloneUntrustedData(value, label, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label} must contain finite numbers.`);
    return value;
  }
  if (typeof value !== 'object') throw new TypeError(`${label} must contain only serialisable data.`);
  if (ancestors.has(value)) throw new TypeError(`${label} must not contain cyclic data.`);
  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if ((isArray && prototype !== Array.prototype)
      || (!isArray && prototype !== Object.prototype && prototype !== null)) {
    throw new TypeError(`${label} must contain only plain objects and arrays.`);
  }
  ancestors.add(value);
  if (isArray) {
    const output = [];
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'length') continue;
      if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
        throw new TypeError(`${label} arrays must contain only index keys.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        throw new TypeError(`${label} must not contain accessors or hidden array values.`);
      }
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new TypeError(`${label} must not contain sparse arrays.`);
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      output.push(cloneUntrustedData(descriptor.value, `${label}[${index}]`, ancestors));
    }
    ancestors.delete(value);
    return output;
  }
  const output = Object.getPrototypeOf(value) === null ? Object.create(null) : {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new TypeError(`${label} must not contain symbol keys.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw new TypeError(`${label} must not contain accessors or hidden fields.`);
    }
    output[key] = cloneUntrustedData(descriptor.value, `${label}.${key}`, ancestors);
  }
  ancestors.delete(value);
  return output;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function finiteTimestamp(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite non-negative timestamp.`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function serialisableRedactionWalk(value, ancestors) {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Parent projection must contain finite numbers.');
    return;
  }
  if (typeof value === 'string') {
    if (/sentinel/i.test(value) && FORBIDDEN_PARENT_DOMAIN.test(value)) {
      throw new TypeError('Parent projection contains a forbidden domain value.');
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new TypeError('Parent projection must contain only plain serialisable values.');
  }
  if (ancestors.has(value)) throw new TypeError('Parent projection must not contain cyclic data.');
  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (isArray && prototype !== Array.prototype) {
    throw new TypeError('Parent projection arrays must use only Array.prototype.');
  }
  if (!isArray && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Parent projection must contain only plain objects.');
  }
  ancestors.add(value);
  if (isArray) {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        throw new TypeError('Parent projection arrays must contain only serialisable index keys.');
      }
      if (key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        throw new TypeError('Parent projection arrays must not contain accessors or hidden values.');
      }
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
        if (FORBIDDEN_PARENT_DOMAIN.test(key)) {
          throw new TypeError(`Parent projection contains forbidden key: ${key}.`);
        }
        throw new TypeError('Parent projection arrays must contain only serialisable index keys.');
      }
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new TypeError('Parent projection must not contain sparse arrays.');
      serialisableRedactionWalk(value[index], ancestors);
    }
  } else {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        throw new TypeError('Parent projection objects must contain only serialisable string keys.');
      }
      if (FORBIDDEN_PARENT_DOMAIN.test(key)) {
        throw new TypeError(`Parent projection contains forbidden key: ${key}.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        throw new TypeError('Parent projection objects must not contain accessors or hidden values.');
      }
      serialisableRedactionWalk(descriptor.value, ancestors);
    }
  }
  ancestors.delete(value);
}

function compareCanonicalIds(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function assertParentProjectionRedacted(value) {
  serialisableRedactionWalk(value, new Set());
  return value;
}

function catalogueRegistry(contentSnapshots) {
  if (!Array.isArray(contentSnapshots)) {
    throw new TypeError('contentSnapshots must be an array.');
  }
  const registry = new Map();
  for (const candidate of contentSnapshots) {
    const catalogue = validateCatalogueV1(candidate);
    if (registry.has(catalogue.catalogueId)) {
      throw new TypeError(`Duplicate Parent catalogue: ${catalogue.catalogueId}.`);
    }
    registry.set(catalogue.catalogueId, catalogue);
  }
  return registry;
}

function snapshotRegistry(learnerSnapshots) {
  if (!Array.isArray(learnerSnapshots)) {
    throw new TypeError('learnerSnapshots must be an array.');
  }
  const registry = new Map();
  for (const candidate of learnerSnapshots) {
    const learnerId = candidate?.learnerId;
    if (typeof learnerId !== 'string') continue;
    const entries = registry.get(learnerId) ?? [];
    entries.push(candidate);
    registry.set(learnerId, entries);
  }
  return registry;
}

function emptyChild(profile) {
  return {
    learnerId: profile.learnerId,
    nickname: profile.nickname,
    yearGroup: profile.yearGroup,
    colour: profile.colour,
    publishedItemCount: 0,
    secureItemCount: 0,
    dueItemCount: 0,
    troubleItemCount: 0,
    correctCount: 0,
    wrongCount: 0,
    accuracyPercent: null,
    guardianDueCount: 0,
    wobblingDueCount: 0,
    nextGuardianReviewDay: null,
    recentRevisionSessions: [],
  };
}

function aggregateSnapshot(snapshot, catalogue, todayDay) {
  const knownIds = new Set(catalogue.items.map(({ runtimeItemId }) => runtimeItemId));
  let secureItemCount = 0;
  let dueItemCount = 0;
  let troubleItemCount = 0;
  let correctCount = 0;
  let wrongCount = 0;
  for (const [runtimeItemId, item] of Object.entries(snapshot.subjectState.data.progress)) {
    if (!knownIds.has(runtimeItemId)) continue;
    const secure = item.stage >= 4;
    secureItemCount += secure ? 1 : 0;
    dueItemCount += item.attempts > 0 && item.dueDay <= todayDay && !secure ? 1 : 0;
    troubleItemCount += item.wrong > 0 && (item.wrong >= item.correct || item.dueDay <= todayDay) ? 1 : 0;
    correctCount += item.correct;
    wrongCount += item.wrong;
  }
  const legacy = toLegacyEngineSnapshot({
    progress: snapshot.subjectState.data.progress,
    guardianMap: snapshot.subjectState.data.guardianMap,
    pattern: snapshot.subjectState.data.pattern,
    session: null,
    summary: null,
    events: [],
  }, catalogue);
  const { wordBySlug } = createLegacyEngineContentSnapshot(catalogue);
  const guardian = deriveGuardianAggregates({
    guardianMap: legacy.guardianMap,
    progressMap: legacy.progress,
    wordBySlug,
    todayDay,
  });
  const attempts = correctCount + wrongCount;
  return {
    publishedItemCount: catalogue.items.length,
    secureItemCount,
    dueItemCount,
    troubleItemCount,
    correctCount,
    wrongCount,
    accuracyPercent: attempts > 0 ? Math.round((correctCount / attempts) * 100) : null,
    guardianDueCount: guardian.guardianDueCount,
    wobblingDueCount: guardian.wobblingDueCount,
    nextGuardianReviewDay: guardian.nextGuardianDueDay,
  };
}

function exactSessionKeys(session) {
  const keys = Reflect.ownKeys(session);
  return keys.length === SESSION_KEYS.size
    && keys.every((key) => typeof key === 'string' && SESSION_KEYS.has(key));
}

function exactDataKeys(value, allowed) {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== allowed.size) return null;
  const fields = {};
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.has(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return null;
    fields[key] = descriptor.value;
  }
  return fields;
}

function canonicalSessionId(value) {
  return typeof value === 'string' && CANONICAL_ID.test(value);
}

function revisionSessionFact(raw, learnerId, catalogue) {
  try {
    const session = raw;
    if (!exactSessionKeys(session) || session.learnerId !== learnerId
        || session.subjectId !== 'spelling' || session.status !== 'completed'
        || !REVISION_MODES.has(session.mode)) return null;
    if (!canonicalSessionId(session.id) || !session.state) return null;
    const completionTime = finiteTimestamp(session.completedAt, 'Parent session completedAt');
    const startedAt = finiteTimestamp(session.startedAt, 'Parent session startedAt');
    const updatedAt = finiteTimestamp(session.updatedAt, 'Parent session updatedAt');
    if (updatedAt < startedAt || completionTime < startedAt || completionTime > updatedAt) return null;
    const summary = plainRecord(session.summary, 'Parent session summary');
    if (summary.sessionId !== session.id || summary.mode !== session.mode) return null;
    const total = nonNegativeInteger(summary.totalWords, 'Parent session total');
    const correct = nonNegativeInteger(summary.correct, 'Parent session correct');
    if (correct > total) return null;
    if (summary.wrong !== undefined
        && nonNegativeInteger(summary.wrong, 'Parent session wrong') !== total - correct) return null;
    const state = plainRecord(session.state, 'Parent session state');
    if (state.phase !== 'summary') return null;
    const stateSummary = plainRecord(state.summary, 'Parent state summary');
    if (stateSummary.sessionId !== session.id || stateSummary.mode !== session.mode
        || stateSummary.totalWords !== total || stateSummary.correct !== correct
        || canonicalJson(stateSummary) !== canonicalJson(summary)) return null;
    const historical = plainRecord(state.session, 'Parent historical session');
    if (historical.id !== session.id || historical.profileId !== learnerId
        || historical.mode !== session.mode || historical.startedAt !== startedAt) return null;
    let eligibleMissionKind = null;
    if (session.mode === 'guardian') {
      const mission = plainRecord(historical.revisionMission, 'Parent revision mission');
      const missionFields = exactDataKeys(mission, REVISION_MISSION_KEYS);
      if (!missionFields || missionFields.sessionId !== session.id || missionFields.learnerId !== learnerId
          || missionFields.packId !== catalogue.packId || !REVISION_KINDS.has(missionFields.kind)
          || !Number.isSafeInteger(missionFields.startedGuardianDay)
          || missionFields.startedGuardianDay < 0
          || typeof missionFields.campEligible !== 'boolean'
          || typeof historical.revisionMissionIntegrity !== 'string'
          || !historical.revisionMissionIntegrity) return null;
      const expectedIntegrity = createSpellingRevisionMissionIntegrity({
        session: historical,
        mission: missionFields,
        startedAt,
      });
      if (historical.revisionMissionIntegrity !== expectedIntegrity) return null;
      eligibleMissionKind = missionFields.kind;
    } else if (historical.revisionMission !== undefined
        || historical.revisionMissionIntegrity !== undefined) {
      return null;
    }
    return {
      sessionId: session.id,
      mode: session.mode,
      completedAt: completionTime,
      correct,
      wrong: total - correct,
      total,
      eligibleMissionKind,
    };
  } catch {
    return null;
  }
}

function sessionsForLearner(completedSessions, learnerId, catalogue) {
  const prepared = completedSessions.map((candidate) => {
    try {
      const session = cloneUntrustedData(candidate, 'Parent completed session');
      return plainRecord(session, 'Parent completed session');
    } catch {
      return null;
    }
  }).filter(Boolean);
  const owned = prepared.filter((candidate) => candidate.learnerId === learnerId);
  const idCounts = new Map();
  for (const candidate of owned) {
    if (typeof candidate?.id !== 'string') continue;
    idCounts.set(candidate.id, (idCounts.get(candidate.id) ?? 0) + 1);
  }
  return owned
    .filter((candidate) => idCounts.get(candidate?.id) === 1)
    .map((candidate) => revisionSessionFact(candidate, learnerId, catalogue))
    .filter(Boolean)
    .sort((left, right) => right.completedAt - left.completedAt
      || compareCanonicalIds(left.sessionId, right.sessionId))
    .slice(0, 10)
    .map(({ sessionId: _sessionId, ...fact }) => fact);
}

export function projectParentSpellingProgress({
  profiles,
  learnerSnapshots,
  completedSessions,
  contentSnapshots,
  now,
} = {}) {
  if (!Array.isArray(profiles)) throw new TypeError('profiles must be an array.');
  if (!Array.isArray(completedSessions)) throw new TypeError('completedSessions must be an array.');
  if (typeof now !== 'function') throw new TypeError('Parent projection requires an injected now() clock.');
  const nowMs = finiteTimestamp(now(), 'Parent clock');
  const todayDay = canonicalGuardianDay(nowMs);
  const catalogues = catalogueRegistry(contentSnapshots);
  const snapshots = snapshotRegistry(learnerSnapshots);
  const seenProfiles = new Set();
  const validatedProfiles = profiles.map((candidate) => validateSpellingProfile(candidate));
  for (const profile of validatedProfiles) {
    if (seenProfiles.has(profile.learnerId)) throw new TypeError(`Duplicate Parent profile: ${profile.learnerId}.`);
    seenProfiles.add(profile.learnerId);
  }
  validatedProfiles.sort((left, right) => compareCanonicalIds(left.learnerId, right.learnerId));

  const output = validatedProfiles.map((profile) => {
    const child = emptyChild(profile);
    const candidates = snapshots.get(profile.learnerId) ?? [];
    if (candidates.length !== 1) return child;
    const rawSnapshot = candidates[0];
    const catalogue = catalogues.get(rawSnapshot?.catalogueId);
    if (!catalogue) return child;
    try {
      const snapshot = validateSpellingCommandSnapshotV1(rawSnapshot, catalogue);
      if (snapshot.learnerId !== profile.learnerId) return child;
      return {
        ...child,
        ...aggregateSnapshot(snapshot, catalogue, todayDay),
        recentRevisionSessions: sessionsForLearner(completedSessions, profile.learnerId, catalogue),
      };
    } catch {
      return child;
    }
  });
  assertParentProjectionRedacted(output);
  return structuredClone(output);
}
