import { validateCatalogueV1 } from '../index.js';
import { canonicalGuardianDay } from './command-contracts.js';

const CAMP_KEYS = new Set([
  'packId', 'campHighWater', 'lastCreditedGuardianDay',
  'lastCreditedEventId', 'acknowledgements',
]);
const COMPLETION_KEYS = new Set([
  'id', 'type', 'subjectId', 'learnerId', 'sessionId', 'mode', 'createdAt',
  'packId', 'totalWords', 'renewalCount', 'wobbledCount', 'recoveredCount',
]);
const MISSION_KEYS = new Set([
  'sessionId', 'learnerId', 'packId', 'kind',
  'startedGuardianDay', 'campEligible',
]);
const CREDITABLE_MISSION_KINDS = new Set(['first-patrol', 'due', 'wobbling']);
const KNOWN_MISSION_KINDS = new Set([
  ...CREDITABLE_MISSION_KINDS, 'locked', 'rested', 'optional-patrol',
]);
const KNOWN_MODES = new Set(['smart', 'trouble', 'test', 'single', 'guardian', 'boss', 'pattern-quest']);
const CANONICAL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`Unknown ${label} field: ${key}.`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${label}.${key} is required.`);
  }
}

function canonicalId(value, label) {
  if (typeof value !== 'string' || !CANONICAL_ID.test(value)) {
    throw new TypeError(`${label} must be a canonical identifier.`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function assertPlainSerialisable(value, label, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label} must contain finite values.`);
    return;
  }
  if (typeof value !== 'object') throw new TypeError(`${label} must be plain serialisable data.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
    throw new TypeError(`${label} must be plain serialisable data.`);
  }
  if (ancestors.has(value)) throw new TypeError(`${label} must not be cyclic.`);
  ancestors.add(value);
  for (const entry of Object.values(value)) assertPlainSerialisable(entry, label, ancestors);
  ancestors.delete(value);
}

function normaliseCampState(value, { learnerId, packId }) {
  if (value === null || value === undefined) {
    return {
      packId,
      campHighWater: 0,
      lastCreditedGuardianDay: null,
      lastCreditedEventId: null,
      acknowledgements: [],
    };
  }
  const state = record(value, 'Camp state');
  exactKeys(state, CAMP_KEYS, 'Camp state');
  if (state.packId !== packId) throw new TypeError('Camp state pack ownership does not match.');
  nonNegativeInteger(state.campHighWater, 'Camp high-water');
  if (state.lastCreditedGuardianDay !== null) {
    nonNegativeInteger(state.lastCreditedGuardianDay, 'Camp last credited Guardian day');
  }
  if (!Array.isArray(state.acknowledgements)) {
    throw new TypeError('Camp acknowledgements must be an array.');
  }
  assertPlainSerialisable(state.acknowledgements, 'Camp acknowledgements');
  if (state.lastCreditedEventId !== null) {
    const prefix = `spelling.guardian.mission-completed:${learnerId}:`;
    if (typeof state.lastCreditedEventId !== 'string' || !state.lastCreditedEventId.startsWith(prefix)) {
      throw new TypeError('Camp credited event ownership does not match the learner.');
    }
    canonicalId(state.lastCreditedEventId.slice(prefix.length), 'Camp credited session ID');
  }
  if ((state.lastCreditedGuardianDay === null) !== (state.lastCreditedEventId === null)
      || (state.campHighWater === 0) !== (state.lastCreditedGuardianDay === null)) {
    throw new TypeError('Camp high-water and credited evidence must agree.');
  }
  return structuredClone(state);
}

function validateMission(value, { learnerId, packId }) {
  const mission = record(value, 'Revision mission');
  exactKeys(mission, MISSION_KEYS, 'Revision mission');
  canonicalId(mission.sessionId, 'Revision mission session ID');
  if (mission.learnerId !== learnerId) throw new TypeError('Revision mission learner ownership does not match.');
  if (mission.packId !== packId) throw new TypeError('Revision mission pack ownership does not match.');
  if (!KNOWN_MISSION_KINDS.has(mission.kind)) throw new TypeError('Revision mission kind is unsupported.');
  nonNegativeInteger(mission.startedGuardianDay, 'Revision mission started Guardian day');
  if (typeof mission.campEligible !== 'boolean') throw new TypeError('Revision mission campEligible must be boolean.');
  return mission;
}

function validateCompletion(value, { learnerId, packId, sessionId }) {
  const event = record(value, 'Guardian completion event');
  exactKeys(event, COMPLETION_KEYS, 'Guardian completion event');
  if (event.type !== 'spelling.guardian.mission-completed' || event.subjectId !== 'spelling') {
    throw new TypeError('Guardian completion event type and subject are invalid.');
  }
  if (event.learnerId !== learnerId) throw new TypeError('Guardian completion event learner ownership does not match.');
  if (event.packId !== packId) throw new TypeError('Guardian completion event pack ownership does not match.');
  if (event.sessionId !== sessionId) throw new TypeError('Guardian completion event session ownership does not match.');
  canonicalId(event.sessionId, 'Guardian completion session ID');
  if (!KNOWN_MODES.has(event.mode)) throw new TypeError('Guardian completion event mode is unsupported.');
  const expectedId = `spelling.guardian.mission-completed:${learnerId}:${event.sessionId}`;
  if (event.id !== expectedId) throw new TypeError('Guardian completion event ID is not deterministic.');
  const completedGuardianDay = canonicalGuardianDay(event.createdAt);
  for (const key of ['totalWords', 'renewalCount', 'wobbledCount', 'recoveredCount']) {
    nonNegativeInteger(event[key], `Guardian completion event ${key}`);
  }
  if (event.renewalCount + event.wobbledCount + event.recoveredCount > event.totalWords) {
    throw new TypeError('Guardian completion event counts are invalid.');
  }
  return { event, completedGuardianDay };
}

function hasFullAccess(catalogue, grantedEntitlementIds) {
  if (!Array.isArray(grantedEntitlementIds) || new Set(grantedEntitlementIds).size !== grantedEntitlementIds.length) {
    throw new TypeError('Granted entitlement IDs must be a unique array.');
  }
  grantedEntitlementIds.forEach((identifier) => canonicalId(identifier, 'Granted entitlement ID'));
  if (catalogue.catalogueId !== `${catalogue.packId}:full` || catalogue.entitlementIds.length === 0) return false;
  const granted = new Set(grantedEntitlementIds);
  return catalogue.entitlementIds.every((entitlementId) => granted.has(entitlementId));
}

export function projectSpellingCampTransition({
  learnerId,
  packId,
  catalogue: rawCatalogue,
  grantedEntitlementIds,
  currentState,
  completedEvent,
  revisionMission,
} = {}) {
  canonicalId(learnerId, 'Camp learner ID');
  canonicalId(packId, 'Camp pack ID');
  const catalogue = validateCatalogueV1(rawCatalogue);
  if (catalogue.packId !== packId) throw new TypeError('Camp pack does not match its catalogue.');
  const mission = validateMission(revisionMission, { learnerId, packId });
  const { event, completedGuardianDay } = validateCompletion(completedEvent, {
    learnerId,
    packId,
    sessionId: mission.sessionId,
  });
  const state = normaliseCampState(currentState, { learnerId, packId });
  const hasAccess = hasFullAccess(catalogue, grantedEntitlementIds);
  const eligible = hasAccess
    && event.mode === 'guardian'
    && mission.campEligible === true
    && CREDITABLE_MISSION_KINDS.has(mission.kind);
  const uncreditedDay = state.lastCreditedGuardianDay === null
    || completedGuardianDay > state.lastCreditedGuardianDay;
  const creditApplied = eligible && uncreditedDay ? 1 : 0;
  const nextState = creditApplied === 1
    ? {
        ...state,
        campHighWater: state.campHighWater + 1,
        lastCreditedGuardianDay: completedGuardianDay,
        lastCreditedEventId: event.id,
      }
    : state;
  if (!Number.isSafeInteger(nextState.campHighWater)) {
    throw new TypeError('Camp high-water cannot exceed the safe integer range.');
  }
  return {
    ...structuredClone(nextState),
    creditApplied,
    completedGuardianDay,
    canEarnToday: hasAccess
      && CREDITABLE_MISSION_KINDS.has(mission.kind)
      && mission.campEligible === true
      && (nextState.lastCreditedGuardianDay === null
        || completedGuardianDay > nextState.lastCreditedGuardianDay),
  };
}
