import {
  normaliseMobileRuntimeSnapshot,
  parseRuntimeItemId,
  validateCatalogueV1,
} from '../index.js';
import {
  GUARDIAN_MAX_REVIEW_LEVEL,
  SPELLING_EVENT_TYPES,
  SPELLING_MASTERY_MILESTONES,
} from '../../core/index.js';
import {
  deriveSpellingRevisionMissionProjection,
  hasFullSpellingRevisionAccessAuthority,
} from './revision-authority.js';

export const SPELLING_COMMAND_SNAPSHOT_SCHEMA_VERSION = 1;
export const SPELLING_COMMAND_PLAN_SCHEMA_VERSION = 1;
export const SPELLING_MOBILE_COMMAND_TYPES = Object.freeze([
  'start-session',
  'submit-answer',
  'continue-session',
  'skip-word',
  'end-session',
  'save-prefs',
  'acknowledge-persistence-warning',
]);

const DAY_MS = 86_400_000;
const ID_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MOBILE_MODES = new Set(['smart', 'trouble', 'test', 'single', 'guardian', 'boss', 'pattern-quest']);
const MOBILE_YEAR_FILTERS = new Set(['core', 'y3-4', 'y5-6']);
const SNAPSHOT_KEYS = new Set([
  'schemaVersion', 'learnerId', 'revision', 'packId', 'catalogueId',
  'grantedEntitlementIds', 'subjectState', 'practiceSession', 'eventLog',
  'monsterStateByRewardTrackId', 'campStateByPackId',
]);
const SUBJECT_KEYS = new Set(['ui', 'data']);
const SUBJECT_DATA_KEYS = new Set([
  'prefs', 'progress', 'guardianMap', 'pattern', 'postMega', 'achievements',
  'persistenceWarning',
]);
const SUBJECT_UI_KEYS = new Set([
  'version', 'phase', 'session', 'feedback', 'summary', 'error',
  'awaitingAdvance', 'serverAuthority', 'postMastery', 'postMasteryDebug',
]);
const PRACTICE_SESSION_KEYS = new Set([
  'id', 'learnerId', 'subjectId', 'status', 'mode', 'state', 'summary',
  'startedAt', 'updatedAt', 'completedAt',
]);
const EVENT_BASE_KEYS = [
  'id', 'type', 'subjectId', 'learnerId', 'sessionId', 'mode', 'createdAt',
];
const EVENT_ITEM_KEYS = ['runtimeItemId', 'legacySlug', 'word', 'family', 'yearBand', 'spellingPool'];
const FROZEN_EVENT_TYPES = new Set(Object.values(SPELLING_EVENT_TYPES));
const FROZEN_MILESTONES = new Set(SPELLING_MASTERY_MILESTONES);
const MONSTER_KEYS = new Set([
  'rewardTrackId', 'packId', 'monsterId', 'branch', 'secureCount', 'caught',
  'derivedStage', 'earnedStageHighWater',
]);
const CAMP_KEYS = new Set([
  'packId', 'campHighWater', 'lastCreditedGuardianDay',
  'lastCreditedEventId', 'acknowledgements',
]);
const PLAN_KEYS = new Set([
  'schemaVersion', 'learnerId', 'expectedRevision', 'nextRevision', 'changed',
  'ok', 'nextSubjectState', 'nextPracticeSession', 'nextEventLog',
  'appendedEvents', 'nextMonsterStateByRewardTrackId', 'nextCampStateByPackId',
  'projections', 'transientEffects', 'result',
]);
const PROJECTION_KEYS = new Set(['monsters', 'revisionMission', 'camp']);
const EFFECT_KEYS = new Set(['type', 'payload']);
const AUDIO_CUE_PAYLOAD_KEYS = new Set(['runtimeItemId', 'sentence', 'slow']);
const REVISION_PROJECTION_KEYS = new Set([
  'missionState', 'eligibleMissionKind', 'guardianDueCount', 'wobblingDueCount',
  'nextGuardianDueDay', 'todayGuardianDay', 'canStartRewardBearing', 'canContinueUnrewarded',
  'campCreditState',
]);
const REVISION_MISSION_STATES = new Set(['locked', 'first-patrol', 'wobbling', 'due', 'rested']);
const ELIGIBLE_REVISION_MISSION_STATES = new Set(['first-patrol', 'wobbling', 'due']);
const CAMP_CREDIT_STATES = new Set(['unavailable', 'available', 'complete-for-today']);
const CAMP_PROJECTION_KEYS = new Set([
  ...CAMP_KEYS, 'creditApplied', 'completedGuardianDay', 'canEarnToday',
]);
const RESULT_KEYS = new Set(['ok', 'changed', 'state', 'events', 'prefs', 'reason']);
const RESULT_REQUIRED_KEYS = new Set(['ok', 'changed', 'state', 'events']);
const PREF_KEYS = new Set([
  'mode', 'yearFilter', 'roundLength', 'showCloze', 'autoSpeak',
  'extraWordFamilies', 'ttsProvider', 'bufferedGeminiVoice',
]);
const TTS_PROVIDERS = new Set(['openai', 'gemini', 'browser']);
const BUFFERED_VOICES = new Set(['Iapetus', 'Sulafat']);
const REVISION_MISSION_KEYS = new Set([
  'sessionId', 'learnerId', 'packId', 'kind', 'startedGuardianDay', 'campEligible',
]);

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`Unknown ${label} key: ${key}.`);
  }
}

function requiredKeys(value, required, label) {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${label} is missing ${key}.`);
  }
}

function canonicalId(value, label) {
  if (typeof value !== 'string' || !ID_SEGMENT.test(value)) {
    throw new TypeError(`${label} must be a canonical lower-case kebab identifier.`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function finiteTimestamp(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite non-negative timestamp.`);
  }
  return value;
}

function assertPlainSerialisable(value, label, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label} must contain only finite serialisable numbers.`);
    return;
  }
  if (typeof value !== 'object') throw new TypeError(`${label} must be plain serialisable data.`);
  if (ancestors.has(value)) throw new TypeError(`${label} must not contain cyclic data.`);
  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if ((isArray && prototype !== Array.prototype)
      || (!isArray && prototype !== Object.prototype && prototype !== null)) {
    throw new TypeError(`${label} must be plain serialisable data.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === 'symbol')) {
    throw new TypeError(`${label} must not contain symbol keys.`);
  }
  ancestors.add(value);
  if (isArray) {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')) {
      throw new TypeError(`${label} must have an intrinsic array length.`);
    }
    const indexKeys = ownKeys.filter((key) => key !== 'length');
    if (indexKeys.length !== lengthDescriptor.value) {
      throw new TypeError(`${label} must not contain sparse arrays or extra properties.`);
    }
    for (const key of indexKeys) {
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key || index >= lengthDescriptor.value) {
        throw new TypeError(`${label} must contain only canonical array indices.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError(`${label}[${key}] must be an enumerable own data property.`);
      }
      assertPlainSerialisable(descriptor.value, `${label}[${key}]`, ancestors);
    }
  } else {
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError(`${label}.${key} must be an enumerable own data property.`);
      }
      assertPlainSerialisable(descriptor.value, `${label}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function serialisableClone(value, label) {
  assertPlainSerialisable(value, label);
  return structuredClone(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validateEntitlements(value) {
  if (!Array.isArray(value) || new Set(value).size !== value.length) {
    throw new TypeError('grantedEntitlementIds must be a unique array.');
  }
  value.forEach((identifier) => canonicalId(identifier, 'Entitlement ID'));
  return [...value];
}

function ownershipWalk(value, learnerId, label) {
  if (!value || typeof value !== 'object') return;
  if (!Array.isArray(value)) {
    if (Object.hasOwn(value, 'learnerId') && value.learnerId !== learnerId) {
      throw new TypeError(`${label} learner ownership does not match the snapshot learner.`);
    }
    if (Object.hasOwn(value, 'subjectId') && value.subjectId !== 'spelling') {
      throw new TypeError(`${label} subject ownership must be spelling.`);
    }
  }
  for (const entry of Object.values(value)) ownershipWalk(entry, learnerId, label);
}

function validateRevisionMission(value, session, learnerId, catalogue, label) {
  const mission = record(value, label);
  exactKeys(mission, REVISION_MISSION_KEYS, label);
  requiredKeys(mission, REVISION_MISSION_KEYS, label);
  if (session.mode !== 'guardian') throw new TypeError(`${label} is allowed only on a Guardian session.`);
  if (mission.sessionId !== session.id) throw new TypeError(`${label}.sessionId does not match its session.`);
  if (mission.learnerId !== learnerId) throw new TypeError(`${label}.learnerId does not match its learner.`);
  if (mission.packId !== catalogue.packId) throw new TypeError(`${label}.packId does not match its catalogue.`);
  if (!['first-patrol', 'wobbling', 'due'].includes(mission.kind)) throw new TypeError(`${label}.kind is unsupported.`);
  nonNegativeInteger(mission.startedGuardianDay, `${label}.startedGuardianDay`);
  if (typeof mission.campEligible !== 'boolean') throw new TypeError(`${label}.campEligible must be boolean.`);
}

function validateNestedSession(value, learnerId, catalogue, label) {
  if (value === null || value === undefined) return;
  const session = record(value, label);
  canonicalId(session.id, `${label}.id`);
  if (session.profileId !== learnerId) throw new TypeError(`${label}.profileId does not match its learner.`);
  if (!MOBILE_MODES.has(session.mode)) throw new TypeError(`${label}.mode is unsupported.`);
  if (session.revisionMission !== undefined) {
    validateRevisionMission(session.revisionMission, session, learnerId, catalogue, `${label}.revisionMission`);
  }
}

function normaliseSubjectState(value, catalogue, events, learnerId) {
  const subject = record(value, 'subjectState');
  exactKeys(subject, SUBJECT_KEYS, 'subjectState');
  requiredKeys(subject, SUBJECT_KEYS, 'subjectState');
  const ui = record(subject.ui, 'subjectState.ui');
  const data = record(subject.data, 'subjectState.data');
  exactKeys(ui, SUBJECT_UI_KEYS, 'subjectState.ui');
  exactKeys(data, SUBJECT_DATA_KEYS, 'subjectState.data');
  requiredKeys(data, SUBJECT_DATA_KEYS, 'subjectState.data');
  const bridge = normaliseMobileRuntimeSnapshot({
    ...data,
    session: Object.hasOwn(ui, 'session') ? ui.session : null,
    summary: Object.hasOwn(ui, 'summary') ? ui.summary : null,
    events,
  }, catalogue);
  const nextUi = serialisableClone(ui, 'subjectState.ui');
  if (Object.hasOwn(ui, 'session')) nextUi.session = bridge.session;
  if (Object.hasOwn(ui, 'summary')) nextUi.summary = bridge.summary;
  const nextData = {
    ...serialisableClone(data, 'subjectState.data'),
    progress: bridge.progress,
    guardianMap: bridge.guardianMap,
    pattern: bridge.pattern,
  };
  ownershipWalk(nextUi, learnerId, 'subjectState.ui');
  validateNestedSession(nextUi.session, learnerId, catalogue, 'subjectState.ui.session');
  return { ui: nextUi, data: nextData };
}

function eventInteger(event, key, label, { nullable = false } = {}) {
  if (nullable && event[key] === null) return;
  nonNegativeInteger(event[key], `${label}.${key}`);
}

function eventItem(event, catalogue, label) {
  const item = catalogue.items.find(({ runtimeItemId }) => runtimeItemId === event.runtimeItemId);
  if (!item) throw new TypeError(`${label} references an unknown runtime item.`);
  if (event.legacySlug !== item.legacySlug || event.word !== item.target || event.family !== item.family
      || event.yearBand !== item.yearBand || event.spellingPool !== 'core') {
    throw new TypeError(`${label} item metadata does not match its catalogue.`);
  }
  return item;
}

function eventShape(event, extraKeys, label) {
  const allowed = new Set([...EVENT_BASE_KEYS, ...extraKeys]);
  exactKeys(event, allowed, label);
  requiredKeys(event, allowed, label);
}

function deterministicEventId(event, catalogue, label) {
  const item = EVENT_ITEM_KEYS.every((key) => Object.hasOwn(event, key)) ? eventItem(event, catalogue, label) : null;
  switch (event.type) {
    case SPELLING_EVENT_TYPES.RETRY_CLEARED:
      eventShape(event, [...EVENT_ITEM_KEYS, 'fromPhase', 'attemptCount'], label);
      if (!['retry', 'correction'].includes(event.fromPhase)) throw new TypeError(`${label}.fromPhase is unsupported.`);
      if (event.sessionId === null || event.mode === null) throw new TypeError(`${label} must belong to one session.`);
      eventInteger(event, 'attemptCount', label, { nullable: true });
      return [event.type, event.learnerId, event.sessionId, item.legacySlug, event.fromPhase, event.attemptCount ?? 'na'].join(':');
    case SPELLING_EVENT_TYPES.WORD_SECURED:
      eventShape(event, [...EVENT_ITEM_KEYS, 'stage'], label);
      eventInteger(event, 'stage', label, { nullable: true });
      if (event.sessionId === null || event.mode === null) throw new TypeError(`${label} must belong to one session.`);
      if (event.stage !== null && event.stage > 4) throw new TypeError(`${label}.stage cannot exceed 4.`);
      return [event.type, event.learnerId, event.sessionId, item.legacySlug, event.stage ?? 'secure'].join(':');
    case SPELLING_EVENT_TYPES.MASTERY_MILESTONE:
      eventShape(event, ['milestone', 'secureCount'], label);
      eventInteger(event, 'milestone', label);
      eventInteger(event, 'secureCount', label);
      if (!FROZEN_MILESTONES.has(event.milestone) || event.secureCount < event.milestone) throw new TypeError(`${label} milestone evidence is invalid.`);
      return [event.type, event.learnerId, event.milestone].join(':');
    case SPELLING_EVENT_TYPES.SESSION_COMPLETED:
      eventShape(event, ['sessionType', 'totalWords', 'mistakeCount'], label);
      if (!['learning', 'test'].includes(event.sessionType)) throw new TypeError(`${label}.sessionType is unsupported.`);
      eventInteger(event, 'totalWords', label);
      eventInteger(event, 'mistakeCount', label);
      if (event.sessionId === null || event.mode === null || event.mistakeCount > event.totalWords) throw new TypeError(`${label} session completion evidence is invalid.`);
      return [event.type, event.learnerId, event.sessionId].join(':');
    case SPELLING_EVENT_TYPES.GUARDIAN_RENEWED:
      eventShape(event, [...EVENT_ITEM_KEYS, 'reviewLevel', 'nextDueDay'], label);
      eventInteger(event, 'reviewLevel', label);
      eventInteger(event, 'nextDueDay', label, { nullable: true });
      if (event.sessionId === null || event.mode !== 'guardian' || event.reviewLevel > GUARDIAN_MAX_REVIEW_LEVEL) throw new TypeError(`${label} Guardian renewal evidence is invalid.`);
      return [event.type, event.learnerId, event.sessionId, item.legacySlug, event.reviewLevel].join(':');
    case SPELLING_EVENT_TYPES.GUARDIAN_WOBBLED:
      eventShape(event, [...EVENT_ITEM_KEYS, 'lapses'], label);
      eventInteger(event, 'lapses', label);
      if (event.sessionId === null || event.mode !== 'guardian') throw new TypeError(`${label}.mode must be guardian.`);
      return [event.type, event.learnerId, event.sessionId, item.legacySlug, event.lapses].join(':');
    case SPELLING_EVENT_TYPES.GUARDIAN_RECOVERED:
      eventShape(event, [...EVENT_ITEM_KEYS, 'renewals', 'reviewLevel'], label);
      eventInteger(event, 'renewals', label);
      eventInteger(event, 'reviewLevel', label);
      if (event.sessionId === null || event.mode !== 'guardian' || event.reviewLevel > GUARDIAN_MAX_REVIEW_LEVEL) throw new TypeError(`${label} Guardian recovery evidence is invalid.`);
      return [event.type, event.learnerId, event.sessionId, item.legacySlug, event.renewals].join(':');
    case SPELLING_EVENT_TYPES.GUARDIAN_MISSION_COMPLETED:
      eventShape(event, ['totalWords', 'renewalCount', 'wobbledCount', 'recoveredCount', ...(event.packId === undefined ? [] : ['packId'])], label);
      for (const key of ['totalWords', 'renewalCount', 'wobbledCount', 'recoveredCount']) eventInteger(event, key, label);
      if (event.sessionId === null || event.mode !== 'guardian'
          || event.renewalCount + event.wobbledCount + event.recoveredCount > event.totalWords) {
        throw new TypeError(`${label} Guardian completion evidence is invalid.`);
      }
      return [event.type, event.learnerId, event.sessionId].join(':');
    case SPELLING_EVENT_TYPES.BOSS_COMPLETED:
      eventShape(event, ['length', 'correct', 'wrong', 'seedRuntimeItemIds'], label);
      for (const key of ['length', 'correct', 'wrong']) eventInteger(event, key, label);
      if (event.sessionId === null || event.mode !== 'boss' || event.length === 0 || event.correct + event.wrong !== event.length) throw new TypeError(`${label} Boss evidence is invalid.`);
      if (!Array.isArray(event.seedRuntimeItemIds) || new Set(event.seedRuntimeItemIds).size !== event.seedRuntimeItemIds.length) throw new TypeError(`${label}.seedRuntimeItemIds must be a unique array.`);
      return [event.type, event.learnerId, event.sessionId].join(':');
    case SPELLING_EVENT_TYPES.POST_MEGA_UNLOCKED:
      eventShape(event, ['unlockedAt', 'contentReleaseId', 'publishedCoreCount'], label);
      eventInteger(event, 'publishedCoreCount', label);
      finiteTimestamp(event.unlockedAt, `${label}.unlockedAt`);
      if (event.sessionId !== null || event.mode !== null || event.unlockedAt !== event.createdAt
          || typeof event.contentReleaseId !== 'string' || !event.contentReleaseId) throw new TypeError(`${label} post-Mega evidence is invalid.`);
      return [event.type, event.learnerId, event.unlockedAt].join(':');
    case SPELLING_EVENT_TYPES.PATTERN_QUEST_COMPLETED:
      eventShape(event, ['patternId', 'patternTitle', 'runtimeItemIds', 'correctCount', 'wobbledRuntimeItemIds'], label);
      canonicalId(event.patternId, `${label}.patternId`);
      eventInteger(event, 'correctCount', label);
      if (event.sessionId === null || event.mode !== 'pattern-quest' || typeof event.patternTitle !== 'string'
          || event.correctCount > 5 || !Array.isArray(event.runtimeItemIds) || !Array.isArray(event.wobbledRuntimeItemIds)
          || new Set(event.runtimeItemIds).size !== event.runtimeItemIds.length
          || new Set(event.wobbledRuntimeItemIds).size !== event.wobbledRuntimeItemIds.length
          || event.wobbledRuntimeItemIds.some((runtimeItemId) => !event.runtimeItemIds.includes(runtimeItemId))) {
        throw new TypeError(`${label} Pattern Quest evidence is invalid.`);
      }
      return [event.type, event.learnerId, event.sessionId, event.patternId].join(':');
    default:
      throw new TypeError(`${label}.type is not a frozen A1 Spelling event type.`);
  }
}

function validateEvent(value, learnerId, catalogue, label) {
  const raw = record(value, label);
  const canonical = normaliseMobileRuntimeSnapshot({ events: [raw] }, catalogue).events[0];
  if (typeof canonical.id !== 'string' || !canonical.id) throw new TypeError(`${label}.id must be non-empty.`);
  if (!FROZEN_EVENT_TYPES.has(canonical.type)) throw new TypeError(`${label}.type is not a frozen A1 Spelling event type.`);
  if (canonical.subjectId !== 'spelling') throw new TypeError(`${label}.subjectId must be spelling.`);
  if (canonical.learnerId !== learnerId) throw new TypeError(`${label} belongs to another learner.`);
  if (canonical.sessionId !== null && canonical.sessionId !== undefined) canonicalId(canonical.sessionId, `${label}.sessionId`);
  if (canonical.mode !== null && canonical.mode !== undefined && !MOBILE_MODES.has(canonical.mode)) throw new TypeError(`${label}.mode is unsupported.`);
  finiteTimestamp(canonical.createdAt, `${label}.createdAt`);
  if (canonical.packId !== undefined && canonical.packId !== catalogue.packId) throw new TypeError(`${label}.packId does not match the catalogue.`);
  const expectedId = deterministicEventId(canonical, catalogue, label);
  if (canonical.id !== expectedId) throw new TypeError(`${label}.id is not deterministic for its canonical payload.`);
  return canonical;
}

function validateEventLog(value, learnerId, catalogue, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  const output = value.map((entry, index) => validateEvent(entry, learnerId, catalogue, `${label}[${index}]`));
  const ids = output.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new TypeError(`${label} contains duplicate event IDs.`);
  return output;
}

function canonicaliseUiState(state, subjectData, catalogue, learnerId, label) {
  const ui = record(state, label);
  exactKeys(ui, SUBJECT_UI_KEYS, label);
  const bridge = normaliseMobileRuntimeSnapshot({
    ...subjectData,
    session: Object.hasOwn(ui, 'session') ? ui.session : null,
    summary: Object.hasOwn(ui, 'summary') ? ui.summary : null,
  }, catalogue);
  const output = serialisableClone(ui, label);
  if (Object.hasOwn(ui, 'session')) output.session = bridge.session;
  if (Object.hasOwn(ui, 'summary')) output.summary = bridge.summary;
  ownershipWalk(output, learnerId, label);
  return output;
}

function validatePracticeSession(value, subjectState, learnerId, catalogue) {
  const activeUiSession = subjectState.ui.session ?? null;
  if (value === null) {
    if (activeUiSession) throw new TypeError('An active UI session requires a matching practice session.');
    return null;
  }
  const practice = record(value, 'practiceSession');
  exactKeys(practice, PRACTICE_SESSION_KEYS, 'practiceSession');
  requiredKeys(practice, PRACTICE_SESSION_KEYS, 'practiceSession');
  canonicalId(practice.id, 'practiceSession.id');
  if (practice.learnerId !== learnerId) throw new TypeError('practiceSession learner ownership does not match.');
  if (practice.subjectId !== 'spelling') throw new TypeError('practiceSession.subjectId must be spelling.');
  if (!['active', 'completed', 'abandoned'].includes(practice.status)) throw new TypeError('practiceSession.status is unsupported.');
  if (!MOBILE_MODES.has(practice.mode)) throw new TypeError('practiceSession.mode is unsupported.');
  finiteTimestamp(practice.startedAt, 'practiceSession.startedAt');
  finiteTimestamp(practice.updatedAt, 'practiceSession.updatedAt');
  if (practice.updatedAt < practice.startedAt) throw new TypeError('practiceSession.updatedAt cannot precede startedAt.');
  const state = canonicaliseUiState(practice.state, subjectState.data, catalogue, learnerId, 'practiceSession.state');
  const stateSession = state.session ?? null;
  validateNestedSession(stateSession, learnerId, catalogue, 'practiceSession.state.session');
  if (stateSession?.id !== undefined && stateSession.id !== practice.id) throw new TypeError('practiceSession state session ID does not match.');
  if (stateSession?.mode !== undefined && stateSession.mode !== practice.mode) throw new TypeError('practiceSession state mode does not match.');
  if (practice.status === 'active') {
    if (!activeUiSession || activeUiSession.id !== practice.id || !stateSession || stateSession.id !== practice.id) {
      throw new TypeError('Active practice session must agree with the active UI session.');
    }
    if (JSON.stringify(activeUiSession) !== JSON.stringify(stateSession)) {
      throw new TypeError('Active practice session state must agree with the active UI session.');
    }
    if (practice.summary !== null || practice.completedAt !== null) throw new TypeError('Active practice session cannot be completed.');
  } else {
    if (activeUiSession) throw new TypeError('A completed or abandoned practice session cannot masquerade as the active UI session.');
    if (practice.status === 'completed') {
      const rawSummary = record(practice.summary, 'practiceSession.summary');
      if (rawSummary.sessionId !== practice.id
          || (rawSummary.mode !== undefined && rawSummary.mode !== practice.mode)
          || (state.summary?.sessionId !== undefined && state.summary.sessionId !== practice.id)
          || (state.summary?.mode !== undefined && state.summary.mode !== practice.mode)) {
        throw new TypeError('practiceSession summary does not match its completed session row.');
      }
      finiteTimestamp(practice.completedAt, 'practiceSession.completedAt');
      if (practice.completedAt < practice.startedAt || practice.completedAt > practice.updatedAt) {
        throw new TypeError('practiceSession.completedAt must fall within its durable timestamps.');
      }
    } else if (stateSession || practice.summary !== null || practice.completedAt !== null) {
      throw new TypeError('An abandoned practice session must not retain active or completion fields.');
    }
  }
  const summary = practice.summary === null
    ? null
    : normaliseMobileRuntimeSnapshot({ summary: practice.summary }, catalogue).summary;
  ownershipWalk(practice, learnerId, 'practiceSession');
  return {
    ...serialisableClone(practice, 'practiceSession'),
    state,
    summary,
  };
}

function validateMonsterState(value, catalogue) {
  const state = record(value, 'monsterStateByRewardTrackId');
  const tracks = new Map(catalogue.rewardTracks.map((track) => [track.rewardTrackId, track]));
  const output = {};
  for (const [rewardTrackId, raw] of Object.entries(state)) {
    const track = tracks.get(rewardTrackId);
    if (!track) throw new TypeError(`Unknown Monster reward-track key: ${rewardTrackId}.`);
    const entry = record(raw, `Monster ${rewardTrackId}`);
    exactKeys(entry, MONSTER_KEYS, `Monster ${rewardTrackId}`);
    requiredKeys(entry, MONSTER_KEYS, `Monster ${rewardTrackId}`);
    if (entry.rewardTrackId !== rewardTrackId || entry.packId !== catalogue.packId || entry.monsterId !== track.monsterId) {
      throw new TypeError(`Monster ${rewardTrackId} identity does not match its catalogue.`);
    }
    if (!['b1', 'b2'].includes(entry.branch)) throw new TypeError(`Monster ${rewardTrackId} branch must be b1 or b2.`);
    nonNegativeInteger(entry.secureCount, `Monster ${rewardTrackId} secureCount`);
    if (typeof entry.caught !== 'boolean') throw new TypeError(`Monster ${rewardTrackId} caught must be boolean.`);
    for (const key of ['derivedStage', 'earnedStageHighWater']) {
      nonNegativeInteger(entry[key], `Monster ${rewardTrackId} ${key}`);
      if (entry[key] > 4) throw new TypeError(`Monster ${rewardTrackId} ${key} cannot exceed 4.`);
    }
    if (entry.earnedStageHighWater < entry.derivedStage) throw new TypeError(`Monster ${rewardTrackId} high-water cannot regress.`);
    let expectedDerivedStage = 0;
    for (let index = Math.min(4, track.thresholds.length - 1); index >= 1; index -= 1) {
      if (entry.secureCount >= track.thresholds[index]) {
        expectedDerivedStage = index;
        break;
      }
    }
    if (entry.derivedStage !== expectedDerivedStage) throw new TypeError(`Monster ${rewardTrackId} derivedStage does not match its thresholds.`);
    if ((entry.secureCount >= track.thresholds[0] || entry.earnedStageHighWater > 0) && entry.caught !== true) {
      throw new TypeError(`Monster ${rewardTrackId} caught cannot regress below earned evidence.`);
    }
    output[rewardTrackId] = serialisableClone(entry, `Monster ${rewardTrackId}`);
  }
  return output;
}

function validateCampState(value, catalogue, learnerId) {
  const state = record(value, 'campStateByPackId');
  const output = {};
  for (const [packId, raw] of Object.entries(state)) {
    canonicalId(packId, `Camp pack key ${packId}`);
    const entry = record(raw, `Camp ${packId}`);
    exactKeys(entry, CAMP_KEYS, `Camp ${packId}`);
    requiredKeys(entry, CAMP_KEYS, `Camp ${packId}`);
    if (entry.packId !== packId) throw new TypeError(`Camp ${packId} identity does not match its key.`);
    nonNegativeInteger(entry.campHighWater, `Camp ${packId} campHighWater`);
    if (entry.lastCreditedGuardianDay !== null) nonNegativeInteger(entry.lastCreditedGuardianDay, `Camp ${packId} lastCreditedGuardianDay`);
    if (entry.lastCreditedEventId !== null && (typeof entry.lastCreditedEventId !== 'string' || !entry.lastCreditedEventId)) {
      throw new TypeError(`Camp ${packId} lastCreditedEventId must be non-empty or null.`);
    }
    if (entry.lastCreditedEventId !== null) {
      const prefix = `spelling.guardian.mission-completed:${learnerId}:`;
      if (!entry.lastCreditedEventId.startsWith(prefix)) {
        throw new TypeError(`Camp ${packId} credit event ownership does not match its learner.`);
      }
      canonicalId(entry.lastCreditedEventId.slice(prefix.length), `Camp ${packId} credited session ID`);
    }
    if ((entry.lastCreditedGuardianDay === null) !== (entry.lastCreditedEventId === null)
        || (entry.campHighWater === 0) !== (entry.lastCreditedGuardianDay === null)) {
      throw new TypeError(`Camp ${packId} credit high-water and audit evidence must agree.`);
    }
    if (!Array.isArray(entry.acknowledgements)) throw new TypeError(`Camp ${packId} acknowledgements must be an array.`);
    output[packId] = serialisableClone(entry, `Camp ${packId}`);
  }
  return output;
}

function emptyCampState(packId) {
  return {
    packId,
    campHighWater: 0,
    lastCreditedGuardianDay: null,
    lastCreditedEventId: null,
    acknowledgements: [],
  };
}

function validateMonsterProjection(value, durableMonster) {
  if (!Array.isArray(value)) throw new TypeError('projections.monsters must be an array.');
  const expectedEntries = Object.values(durableMonster);
  if (value.length !== expectedEntries.length) {
    throw new TypeError('Monster projection must contain exactly the durable catalogue-declared reward tracks.');
  }
  const seen = new Set();
  const output = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = record(value[index], `Monster projection[${index}]`);
    const rewardTrackId = entry.rewardTrackId;
    if (typeof rewardTrackId !== 'string' || seen.has(rewardTrackId)) {
      throw new TypeError('Monster projection contains a duplicate or malformed reward track.');
    }
    seen.add(rewardTrackId);
    const expected = durableMonster[rewardTrackId];
    if (!expected || canonicalJson(entry) !== canonicalJson(expected)) {
      throw new TypeError(`Monster projection ${rewardTrackId} does not match its durable Monster state.`);
    }
    output.push(serialisableClone(expected, `Monster projection[${index}]`));
  }
  return output;
}

function validateRevisionProjection(value, {
  input,
  catalogue,
  durable,
  nextRevision,
}) {
  const projection = record(value, 'revisionMission projection');
  exactKeys(projection, REVISION_PROJECTION_KEYS, 'revisionMission projection');
  requiredKeys(projection, REVISION_PROJECTION_KEYS, 'revisionMission projection');
  if (!REVISION_MISSION_STATES.has(projection.missionState)) {
    throw new TypeError('revisionMission projection missionState is unsupported.');
  }
  const eligible = ELIGIBLE_REVISION_MISSION_STATES.has(projection.missionState)
    ? projection.missionState
    : null;
  if (projection.eligibleMissionKind !== eligible) {
    throw new TypeError('revisionMission projection eligible mission kind does not match its mission state.');
  }
  nonNegativeInteger(projection.guardianDueCount, 'revisionMission projection guardianDueCount');
  nonNegativeInteger(projection.wobblingDueCount, 'revisionMission projection wobblingDueCount');
  if (projection.wobblingDueCount > projection.guardianDueCount) {
    throw new TypeError('revisionMission projection wobbling count cannot exceed its due count.');
  }
  if (projection.nextGuardianDueDay !== null) {
    nonNegativeInteger(projection.nextGuardianDueDay, 'revisionMission projection nextGuardianDueDay');
  }
  nonNegativeInteger(projection.todayGuardianDay, 'revisionMission projection todayGuardianDay');
  if (projection.guardianDueCount > 0 && projection.nextGuardianDueDay === null) {
    throw new TypeError('revisionMission projection due work requires a next Guardian due day.');
  }
  if (projection.missionState === 'first-patrol'
      && (projection.guardianDueCount !== 0 || projection.wobblingDueCount !== 0)) {
    throw new TypeError('revisionMission first patrol cannot contain due work.');
  }
  if (projection.missionState === 'wobbling' && projection.wobblingDueCount === 0) {
    throw new TypeError('revisionMission wobbling state requires wobbling due work.');
  }
  if (projection.missionState === 'due' && projection.guardianDueCount === 0) {
    throw new TypeError('revisionMission due state requires Guardian due work.');
  }
  for (const key of ['canStartRewardBearing', 'canContinueUnrewarded']) {
    if (typeof projection[key] !== 'boolean') throw new TypeError(`revisionMission projection ${key} must be boolean.`);
  }
  if (!CAMP_CREDIT_STATES.has(projection.campCreditState)) {
    throw new TypeError('revisionMission projection campCreditState is unsupported.');
  }
  const fullAccess = hasFullSpellingRevisionAccessAuthority(input, catalogue);
  if (!fullAccess) {
    const unavailable = projection.missionState === 'locked'
      && projection.eligibleMissionKind === null
      && projection.guardianDueCount === 0
      && projection.wobblingDueCount === 0
      && projection.nextGuardianDueDay === null
      && projection.canStartRewardBearing === false
      && projection.canContinueUnrewarded === false
      && projection.campCreditState === 'unavailable';
    if (!unavailable) throw new TypeError('revisionMission projection must be locked and unavailable without Full access.');
  } else {
    if (projection.campCreditState === 'unavailable') {
      throw new TypeError('revisionMission projection cannot be unavailable with Full access.');
    }
    const expectedStart = eligible !== null && projection.campCreditState === 'available';
    const expectedContinue = eligible !== null && projection.campCreditState === 'complete-for-today';
    if (projection.canStartRewardBearing !== expectedStart
        || projection.canContinueUnrewarded !== expectedContinue) {
      throw new TypeError('revisionMission projection access booleans do not match mission and Camp state.');
    }
  }
  const output = serialisableClone(projection, 'revisionMission projection');
  const candidateSnapshot = {
    ...input,
    revision: nextRevision,
    subjectState: durable.subjectState,
    practiceSession: durable.practiceSession,
    eventLog: durable.eventLog,
    monsterStateByRewardTrackId: durable.monster,
    campStateByPackId: durable.camp,
  };
  const authoritative = deriveSpellingRevisionMissionProjection({
    snapshot: candidateSnapshot,
    contentSnapshot: catalogue,
    todayGuardianDay: output.todayGuardianDay,
  });
  if (canonicalJson(output) !== canonicalJson(authoritative)) {
    throw new TypeError('revisionMission projection does not match the durable revision authority.');
  }
  return output;
}

function validateCampProjection(value, {
  input,
  catalogue,
  learnerId,
  durable,
  durableCamp,
  appendedEvents,
  revisionProjection,
}) {
  const projection = record(value, 'Camp projection');
  exactKeys(projection, CAMP_PROJECTION_KEYS, 'Camp projection');
  requiredKeys(projection, CAMP_PROJECTION_KEYS, 'Camp projection');
  if (projection.packId !== catalogue.packId) throw new TypeError('Camp projection must belong to the active pack.');
  const durableActive = durableCamp[catalogue.packId] || emptyCampState(catalogue.packId);
  const projectedDurable = Object.fromEntries([...CAMP_KEYS].map((key) => [key, projection[key]]));
  const canonicalProjected = validateCampState(
    { [catalogue.packId]: projectedDurable },
    catalogue,
    learnerId,
  )[catalogue.packId];
  if (canonicalJson(canonicalProjected) !== canonicalJson(durableActive)) {
    throw new TypeError('Camp projection does not match the active durable Camp state.');
  }
  if (![0, 1].includes(projection.creditApplied)) throw new TypeError('Camp projection creditApplied must be 0 or 1.');
  if (projection.completedGuardianDay !== null) {
    nonNegativeInteger(projection.completedGuardianDay, 'Camp projection completedGuardianDay');
  }
  if (typeof projection.canEarnToday !== 'boolean') throw new TypeError('Camp projection canEarnToday must be boolean.');
  if (projection.canEarnToday !== revisionProjection.canStartRewardBearing) {
    throw new TypeError('Camp projection canEarnToday does not match the revision mission projection.');
  }
  const inputInactivePackIds = Object.keys(input.campStateByPackId)
    .filter((packId) => packId !== catalogue.packId);
  const durableInactivePackIds = Object.keys(durableCamp)
    .filter((packId) => packId !== catalogue.packId);
  if (JSON.stringify(durableInactivePackIds) !== JSON.stringify(inputInactivePackIds)) {
    throw new TypeError('Camp history cannot add, remove or reorder inactive packs.');
  }
  for (const packId of inputInactivePackIds) {
    if (JSON.stringify(durableCamp[packId]) !== JSON.stringify(input.campStateByPackId[packId])) {
      throw new TypeError(`Camp history for inactive pack ${packId} must remain byte-for-byte unchanged.`);
    }
  }
  const guardianCompletions = appendedEvents.filter(
    (event) => event.type === SPELLING_EVENT_TYPES.GUARDIAN_MISSION_COMPLETED,
  );
  if (guardianCompletions.length > 1) {
    throw new TypeError('One command can contain exactly one Guardian completion transition.');
  }
  if (guardianCompletions.length === 1) {
    const [completion] = guardianCompletions;
    const inputPractice = input.practiceSession;
    const inputSession = inputPractice?.state?.session;
    const outputPractice = durable.practiceSession;
    const outputUi = durable.subjectState.ui;
    const outputHistoricalSession = outputPractice?.state?.session;
    const summary = outputUi.summary;
    const stampedOrigin = inputPractice?.status === 'active'
      && inputPractice.id === completion.sessionId
      && inputPractice.mode === 'guardian'
      && inputSession?.id === completion.sessionId
      && inputSession?.mode === 'guardian'
      && inputSession?.revisionMission?.sessionId === completion.sessionId
      && inputSession?.revisionMission?.learnerId === learnerId
      && inputSession?.revisionMission?.packId === catalogue.packId;
    const completedOutput = outputPractice?.status === 'completed'
      && outputPractice.id === completion.sessionId
      && outputPractice.learnerId === learnerId
      && outputPractice.mode === 'guardian'
      && outputPractice.completedAt === completion.createdAt
      && outputPractice.updatedAt === completion.createdAt
      && outputUi.phase === 'summary'
      && (outputUi.session ?? null) === null
      && summary?.sessionId === completion.sessionId
      && summary?.mode === 'guardian'
      && canonicalJson(outputPractice.summary) === canonicalJson(summary)
      && canonicalJson(outputPractice.state?.summary) === canonicalJson(summary)
      && canonicalJson(outputHistoricalSession) === canonicalJson(inputSession);
    if (completion.packId !== catalogue.packId || !stampedOrigin || !completedOutput) {
      throw new TypeError('Guardian completion evidence requires one completed practice session, matching UI summary and historical stamped origin.');
    }
  }
  if (projection.completedGuardianDay === null) {
    if (guardianCompletions.length > 0) throw new TypeError('Camp projection is missing its completed Guardian day.');
  } else if (!guardianCompletions.some(
    (event) => canonicalGuardianDay(event.createdAt) === projection.completedGuardianDay,
  )) {
    throw new TypeError('Camp projection completed Guardian day lacks matching event evidence.');
  }
  const inputActive = input.campStateByPackId[catalogue.packId];
  if (projection.creditApplied === 0) {
    if (canonicalJson(durableCamp) !== canonicalJson(input.campStateByPackId)) {
      throw new TypeError('Camp durable state cannot change when no credit is applied.');
    }
  } else {
    const creditedEvent = guardianCompletions.find(
      (event) => event.id === canonicalProjected.lastCreditedEventId,
    );
    const origin = input.practiceSession?.state?.session?.revisionMission;
    const validOrigin = origin
      && origin.sessionId === creditedEvent?.sessionId
      && origin.learnerId === learnerId
      && origin.packId === catalogue.packId
      && ELIGIBLE_REVISION_MISSION_STATES.has(origin.kind)
      && origin.campEligible === true;
    const advancesDay = inputActive?.lastCreditedGuardianDay == null
      || projection.completedGuardianDay > inputActive.lastCreditedGuardianDay;
    if (!hasFullSpellingRevisionAccessAuthority(input, catalogue)
        || !validOrigin
        || !advancesDay
        || projection.completedGuardianDay === null
        || canonicalProjected.lastCreditedGuardianDay !== projection.completedGuardianDay
        || canonicalProjected.campHighWater !== (inputActive?.campHighWater || 0) + 1) {
      throw new TypeError('Camp credited projection requires Full access, a stamped eligible Guardian origin and advancing durable evidence.');
    }
  }
  return {
    ...canonicalProjected,
    creditApplied: projection.creditApplied,
    completedGuardianDay: projection.completedGuardianDay,
    canEarnToday: projection.canEarnToday,
  };
}

function validateTransientEffects(value, catalogue) {
  if (!Array.isArray(value)) throw new TypeError('transientEffects must be an array.');
  const runtimeItemIds = new Set(catalogue.items.map(({ runtimeItemId }) => runtimeItemId));
  return Array.prototype.map.call(value, (raw, index) => {
    const effect = record(raw, `transientEffects[${index}]`);
    exactKeys(effect, EFFECT_KEYS, `transientEffects[${index}]`);
    requiredKeys(effect, EFFECT_KEYS, `transientEffects[${index}]`);
    if (effect.type !== 'audio-cue') throw new TypeError(`transientEffects[${index}] must be an audio-cue.`);
    const payload = record(effect.payload, `transientEffects[${index}].payload`);
    exactKeys(payload, AUDIO_CUE_PAYLOAD_KEYS, `transientEffects[${index}].payload`);
    requiredKeys(payload, AUDIO_CUE_PAYLOAD_KEYS, `transientEffects[${index}].payload`);
    if (payload.runtimeItemId !== null
        && (typeof payload.runtimeItemId !== 'string' || !runtimeItemIds.has(payload.runtimeItemId))) {
      throw new TypeError(`transientEffects[${index}] references an unknown runtime item.`);
    }
    if (payload.sentence !== null && typeof payload.sentence !== 'string') {
      throw new TypeError(`transientEffects[${index}].payload.sentence must be a string or null.`);
    }
    if (typeof payload.slow !== 'boolean') throw new TypeError(`transientEffects[${index}].payload.slow must be boolean.`);
    return serialisableClone(effect, `transientEffects[${index}]`);
  });
}

function validatePlanResult(value, {
  plan,
  durable,
  appendedEvents,
  catalogue,
  learnerId,
}) {
  const result = record(value, 'plan result');
  exactKeys(result, RESULT_KEYS, 'plan result');
  requiredKeys(result, RESULT_REQUIRED_KEYS, 'plan result');
  if (typeof result.ok !== 'boolean' || result.ok !== plan.ok) throw new TypeError('Plan result ok must match plan ok.');
  if (typeof result.changed !== 'boolean' || result.changed !== plan.changed) {
    throw new TypeError('Plan result changed must match plan changed.');
  }
  const state = canonicaliseUiState(result.state, durable.subjectState.data, catalogue, learnerId, 'plan result.state');
  if (canonicalJson(state) !== canonicalJson(durable.subjectState.ui)) {
    throw new TypeError('Plan result state must match the canonical next UI state.');
  }
  const events = validateEventLog(result.events, learnerId, catalogue, 'plan result.events');
  const durableEvents = new Map(durable.eventLog.map((event) => [event.id, event]));
  for (const event of events) {
    if (!durableEvents.has(event.id) || canonicalJson(durableEvents.get(event.id)) !== canonicalJson(event)) {
      throw new TypeError('Plan result event must exist byte-identically in nextEventLog.');
    }
  }
  const resultEventIds = new Set(events.map(({ id }) => id));
  if (appendedEvents.some(({ id }) => !resultEventIds.has(id))) {
    throw new TypeError('Plan result events must expose every newly appended event.');
  }
  if (!plan.changed && events.length > 0) throw new TypeError('A changed false result cannot expose events.');
  const output = { ok: result.ok, changed: result.changed, state, events };
  if (Object.hasOwn(result, 'prefs')) {
    validatePrefs(result.prefs);
    const prefs = serialisableClone(result.prefs, 'plan result.prefs');
    if (JSON.stringify(prefs) !== JSON.stringify(durable.subjectState.data.prefs)) {
      throw new TypeError('Plan result prefs must match durable subject prefs byte-for-byte.');
    }
    output.prefs = prefs;
  }
  if (Object.hasOwn(result, 'reason')) {
    if (typeof result.reason !== 'string' || !result.reason) throw new TypeError('Plan result reason must be a non-empty string.');
    output.reason = result.reason;
  }
  return output;
}

export function canonicalGuardianDay(nowMs) {
  finiteTimestamp(nowMs, 'Guardian clock');
  const day = Math.floor(nowMs / DAY_MS);
  if (!Number.isSafeInteger(day)) throw new TypeError('Guardian clock must resolve to a safe canonical day.');
  return day;
}

export function validateSpellingCommandSnapshotV1(value, catalogueValue) {
  assertPlainSerialisable(value, 'Spelling command snapshot');
  const catalogue = validateCatalogueV1(catalogueValue);
  const snapshot = record(value, 'Spelling command snapshot');
  exactKeys(snapshot, SNAPSHOT_KEYS, 'snapshot');
  requiredKeys(snapshot, SNAPSHOT_KEYS, 'snapshot');
  if (snapshot.schemaVersion !== SPELLING_COMMAND_SNAPSHOT_SCHEMA_VERSION) throw new TypeError('Unsupported Spelling command snapshot schema version.');
  canonicalId(snapshot.learnerId, 'learnerId');
  nonNegativeInteger(snapshot.revision, 'revision');
  canonicalId(snapshot.packId, 'packId');
  const catalogueIdentity = parseRuntimeItemId(snapshot.catalogueId);
  if (snapshot.packId !== catalogue.packId || snapshot.catalogueId !== catalogue.catalogueId
      || catalogueIdentity.packId !== snapshot.packId) {
    throw new TypeError('Snapshot pack/catalogue identity does not match the validated catalogue.');
  }
  const grantedEntitlementIds = validateEntitlements(snapshot.grantedEntitlementIds);
  const eventLog = validateEventLog(snapshot.eventLog, snapshot.learnerId, catalogue, 'eventLog');
  const subjectState = normaliseSubjectState(snapshot.subjectState, catalogue, eventLog, snapshot.learnerId);
  const practiceSession = validatePracticeSession(snapshot.practiceSession, subjectState, snapshot.learnerId, catalogue);
  return {
    schemaVersion: SPELLING_COMMAND_SNAPSHOT_SCHEMA_VERSION,
    learnerId: snapshot.learnerId,
    revision: snapshot.revision,
    packId: snapshot.packId,
    catalogueId: snapshot.catalogueId,
    grantedEntitlementIds,
    subjectState,
    practiceSession,
    eventLog,
    monsterStateByRewardTrackId: validateMonsterState(snapshot.monsterStateByRewardTrackId, catalogue),
    campStateByPackId: validateCampState(snapshot.campStateByPackId, catalogue, snapshot.learnerId),
  };
}

function validateStartPayload(payload) {
  exactKeys(payload, new Set(['mode', 'yearFilter', 'length', 'practiceOnly', 'words', 'patternId', 'revisionIntent']), 'start-session payload');
  if (!MOBILE_MODES.has(payload.mode)) throw new TypeError('start-session mode is unsupported.');
  if (payload.yearFilter !== undefined && !MOBILE_YEAR_FILTERS.has(payload.yearFilter)) throw new TypeError('start-session yearFilter is unsupported.');
  if (payload.length !== undefined && payload.length !== 'all'
      && (!Number.isSafeInteger(payload.length) || payload.length <= 0)) throw new TypeError('start-session length must be a positive safe integer or all.');
  if (payload.practiceOnly !== undefined && typeof payload.practiceOnly !== 'boolean') throw new TypeError('start-session practiceOnly must be boolean.');
  if (payload.words !== undefined) {
    if (!Array.isArray(payload.words) || new Set(payload.words).size !== payload.words.length) throw new TypeError('start-session words must be a unique array.');
    payload.words.forEach(parseRuntimeItemId);
  }
  if (payload.patternId !== undefined) canonicalId(payload.patternId, 'start-session patternId');
  if (payload.revisionIntent !== undefined) {
    if (payload.mode !== 'guardian') throw new TypeError('revisionIntent is allowed only for Guardian.');
    if (!['reward-bearing', 'unrewarded'].includes(payload.revisionIntent)) throw new TypeError('revisionIntent must be reward-bearing or unrewarded.');
  }
}

function validatePrefs(prefs) {
  const value = record(prefs, 'save-prefs payload.prefs');
  exactKeys(value, PREF_KEYS, 'save-prefs preference');
  if (value.mode !== undefined && !MOBILE_MODES.has(value.mode)) throw new TypeError('Preference mode is unsupported.');
  if (value.yearFilter !== undefined && !MOBILE_YEAR_FILTERS.has(value.yearFilter)) throw new TypeError('Preference yearFilter is unsupported.');
  if (value.roundLength !== undefined && value.roundLength !== 'all'
      && !(/^[1-9]\d*$/.test(value.roundLength) || (Number.isSafeInteger(value.roundLength) && value.roundLength > 0))) {
    throw new TypeError('Preference roundLength must be positive or all.');
  }
  for (const key of ['showCloze', 'autoSpeak', 'extraWordFamilies']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new TypeError(`Preference ${key} must be boolean.`);
  }
  for (const key of ['ttsProvider', 'bufferedGeminiVoice']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || !value[key])) throw new TypeError(`Preference ${key} must be a non-empty string.`);
  }
  if (value.ttsProvider !== undefined && !TTS_PROVIDERS.has(value.ttsProvider)) throw new TypeError('Preference ttsProvider is unsupported.');
  if (value.bufferedGeminiVoice !== undefined && !BUFFERED_VOICES.has(value.bufferedGeminiVoice)) throw new TypeError('Preference bufferedGeminiVoice is unsupported.');
  if (value.extraWordFamilies === true) throw new TypeError('Extra word families are outside the A3 mobile catalogue.');
}

export function validateSpellingCommandV1(value) {
  assertPlainSerialisable(value, 'Spelling command');
  const command = record(value, 'Spelling command');
  exactKeys(command, new Set(['type', 'payload']), 'command');
  requiredKeys(command, new Set(['type', 'payload']), 'command');
  if (!SPELLING_MOBILE_COMMAND_TYPES.includes(command.type)) throw new TypeError(`Unsupported Spelling command: ${String(command.type)}.`);
  const payload = record(command.payload, `${command.type} payload`);
  if (command.type === 'start-session') validateStartPayload(payload);
  else if (command.type === 'submit-answer') {
    exactKeys(payload, new Set(['typed']), 'submit-answer payload');
    requiredKeys(payload, new Set(['typed']), 'submit-answer payload');
    if (typeof payload.typed !== 'string') throw new TypeError('submit-answer typed must be a string.');
  } else if (command.type === 'save-prefs') {
    exactKeys(payload, new Set(['prefs']), 'save-prefs payload');
    requiredKeys(payload, new Set(['prefs']), 'save-prefs payload');
    validatePrefs(payload.prefs);
  } else {
    exactKeys(payload, new Set(), `${command.type} payload`);
  }
  return serialisableClone(command, 'Spelling command');
}

function validatePlanDurable(value, catalogue, learnerId) {
  const eventLog = validateEventLog(value.nextEventLog, learnerId, catalogue, 'nextEventLog');
  const subjectState = normaliseSubjectState(value.nextSubjectState, catalogue, eventLog, learnerId);
  const practiceSession = validatePracticeSession(value.nextPracticeSession, subjectState, learnerId, catalogue);
  return {
    subjectState,
    practiceSession,
    eventLog,
    monster: validateMonsterState(value.nextMonsterStateByRewardTrackId, catalogue),
    camp: validateCampState(value.nextCampStateByPackId, catalogue, learnerId),
  };
}

function validatePlanTimestampAuthority({
  input,
  durable,
  appendedEvents,
  expectedNowMs,
}) {
  for (const event of appendedEvents) {
    if (event.createdAt !== expectedNowMs) {
      throw new TypeError('Every genuinely appended event timestamp must match the exact certified command clock.');
    }
  }

  const previous = input.practiceSession;
  const next = durable.practiceSession;
  if (JSON.stringify(next) === JSON.stringify(previous)) return;
  if (next === null) {
    throw new TypeError('A changed practice session must retain an authoritative timestamped row.');
  }
  if (previous === null || previous.id !== next.id) {
    if (next.startedAt !== expectedNowMs || next.updatedAt !== expectedNowMs
        || (next.status === 'completed' && next.completedAt !== expectedNowMs)) {
      throw new TypeError('A new practice session timestamp must match the exact certified command clock.');
    }
    return;
  }
  if (previous.status !== 'active') {
    throw new TypeError('An unchanged historical practice session must remain byte-for-byte unchanged.');
  }
  if (next.startedAt !== previous.startedAt || next.updatedAt !== expectedNowMs) {
    throw new TypeError('A continued practice session timestamp must preserve startedAt and match the exact certified command clock.');
  }
  if (next.status === 'completed' && next.completedAt !== expectedNowMs) {
    throw new TypeError('A completed practice session timestamp must match the exact certified command clock.');
  }
}

export function validateSpellingCommandPlanV1(
  value,
  catalogueValue,
  inputSnapshotValue = undefined,
  { expectedNowMs } = {},
) {
  if (inputSnapshotValue === undefined) throw new TypeError('Spelling command plan validation requires its input snapshot.');
  const expectedGuardianDay = canonicalGuardianDay(expectedNowMs);
  assertPlainSerialisable(value, 'Spelling command plan');
  const catalogue = validateCatalogueV1(catalogueValue);
  const input = validateSpellingCommandSnapshotV1(inputSnapshotValue, catalogue);
  const plan = record(value, 'Spelling command plan');
  exactKeys(plan, PLAN_KEYS, 'plan');
  requiredKeys(plan, PLAN_KEYS, 'plan');
  if (plan.schemaVersion !== SPELLING_COMMAND_PLAN_SCHEMA_VERSION) throw new TypeError('Unsupported Spelling command plan schema version.');
  canonicalId(plan.learnerId, 'plan learnerId');
  nonNegativeInteger(plan.expectedRevision, 'expectedRevision');
  nonNegativeInteger(plan.nextRevision, 'nextRevision');
  if (typeof plan.changed !== 'boolean' || typeof plan.ok !== 'boolean') throw new TypeError('Plan changed and ok must be booleans.');
  const expectedNextRevision = plan.expectedRevision + (plan.changed ? 1 : 0);
  if (!Number.isSafeInteger(expectedNextRevision) || plan.nextRevision !== expectedNextRevision) {
    throw new TypeError('Plan nextRevision does not match its changed flag.');
  }
  const durable = validatePlanDurable(plan, catalogue, plan.learnerId);
  if (!Array.isArray(plan.appendedEvents)) throw new TypeError('appendedEvents must be an array.');
  const existingById = new Map(input.eventLog.map((event) => [event.id, event]));
  const appendedById = new Map();
  const appendedEvents = [];
  for (let index = 0; index < plan.appendedEvents.length; index += 1) {
    const event = validateEvent(plan.appendedEvents[index], plan.learnerId, catalogue, `appendedEvents[${index}]`);
    const existing = existingById.get(event.id) || appendedById.get(event.id);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(event)) throw new TypeError('spelling_event_id_collision');
      continue;
    }
    appendedById.set(event.id, event);
    appendedEvents.push(event);
  }
  const expectedEventLog = [...input.eventLog, ...appendedEvents];
  if (durable.eventLog.length !== expectedEventLog.length) {
    throw new TypeError('nextEventLog must preserve the exact existing event history and append only new events.');
  }
  for (let index = 0; index < expectedEventLog.length; index += 1) {
    const actual = durable.eventLog[index];
    const expected = expectedEventLog[index];
    if (actual.id === expected.id && canonicalJson(actual) !== canonicalJson(expected)) {
      throw new TypeError('spelling_event_id_collision');
    }
    if (actual.id !== expected.id || canonicalJson(actual) !== canonicalJson(expected)) {
      throw new TypeError('nextEventLog must preserve the exact existing event history and append only new events.');
    }
  }
  validatePlanTimestampAuthority({ input, durable, appendedEvents, expectedNowMs });
  const projections = record(plan.projections, 'plan projections');
  exactKeys(projections, PROJECTION_KEYS, 'projection');
  requiredKeys(projections, PROJECTION_KEYS, 'projection');
  const monsterProjection = validateMonsterProjection(projections.monsters, durable.monster);
  const revisionProjection = validateRevisionProjection(projections.revisionMission, {
    input,
    catalogue,
    durable,
    nextRevision: plan.nextRevision,
  });
  if (revisionProjection.todayGuardianDay !== expectedGuardianDay) {
    throw new TypeError('revisionMission projection day does not match the certified Guardian day.');
  }
  const campProjection = validateCampProjection(projections.camp, {
    input,
    catalogue,
    learnerId: plan.learnerId,
    durable,
    durableCamp: durable.camp,
    appendedEvents,
    revisionProjection,
  });
  const transientEffects = validateTransientEffects(plan.transientEffects, catalogue);
  const result = validatePlanResult(plan.result, {
    plan,
    durable,
    appendedEvents,
    catalogue,
    learnerId: plan.learnerId,
  });
  if (!plan.changed && (appendedEvents.length || transientEffects.length)) {
    throw new TypeError('A changed false plan cannot append events or expose transient effects.');
  }
  const output = {
    schemaVersion: SPELLING_COMMAND_PLAN_SCHEMA_VERSION,
    learnerId: plan.learnerId,
    expectedRevision: plan.expectedRevision,
    nextRevision: plan.nextRevision,
    changed: plan.changed,
    ok: plan.ok,
    nextSubjectState: durable.subjectState,
    nextPracticeSession: durable.practiceSession,
    nextEventLog: durable.eventLog,
    appendedEvents,
    nextMonsterStateByRewardTrackId: durable.monster,
    nextCampStateByPackId: durable.camp,
    projections: {
      monsters: monsterProjection,
      revisionMission: revisionProjection,
      camp: campProjection,
    },
    transientEffects,
    result,
  };
  if (input.learnerId !== output.learnerId || input.revision !== output.expectedRevision) {
    throw new TypeError('Plan learner ownership or expected revision does not match its input snapshot.');
  }
  if (!output.changed) {
    const durablePairs = [
      [output.nextSubjectState, input.subjectState],
      [output.nextPracticeSession, input.practiceSession],
      [output.nextEventLog, input.eventLog],
      [output.nextMonsterStateByRewardTrackId, input.monsterStateByRewardTrackId],
      [output.nextCampStateByPackId, input.campStateByPackId],
    ];
    if (durablePairs.some(([next, previous]) => JSON.stringify(next) !== JSON.stringify(previous))) {
      throw new TypeError('A changed false plan must keep every durable next value byte-for-byte unchanged.');
    }
  }
  return output;
}
