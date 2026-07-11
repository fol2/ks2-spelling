import { validateCatalogueV1 } from '../index.js';
import {
  canonicalGuardianDay,
  validateSpellingCommandSnapshotV1,
} from './command-contracts.js';
import {
  deriveSpellingRevisionMissionProjection,
  hasFullSpellingRevisionAccessAuthority,
} from './revision-authority.js';

const REVISION_MISSION_INTEGRITY_VERSION = 'revision-mission-v1';

function revisionMissionIntegrityValue({ session, mission, startedAt }) {
  return [
    REVISION_MISSION_INTEGRITY_VERSION,
    session.id,
    session.profileId,
    session.mode,
    startedAt,
    mission.sessionId,
    mission.learnerId,
    mission.packId,
    mission.kind,
    mission.startedGuardianDay,
    mission.campEligible ? 'reward-bearing' : 'unrewarded',
  ].join('|');
}

export function createSpellingRevisionMissionIntegrity({ session, mission, startedAt } = {}) {
  if (!session || typeof session !== 'object' || session.mode !== 'guardian') {
    throw new TypeError('Revision mission integrity requires an A1 Guardian session.');
  }
  if (!mission || typeof mission !== 'object') {
    throw new TypeError('Revision mission integrity requires mission metadata.');
  }
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt < 0) {
    throw new TypeError('Revision mission integrity requires a finite non-negative practice start time.');
  }
  if (session.startedAt !== startedAt) {
    throw new TypeError('Revision mission integrity does not match the A1 session start time.');
  }
  if (mission.startedGuardianDay !== canonicalGuardianDay(startedAt)) {
    throw new TypeError('Revision mission integrity does not match its canonical start day.');
  }
  return revisionMissionIntegrityValue({ session, mission, startedAt });
}

export function assertSpellingRevisionMissionIntegrity(snapshot) {
  const practice = snapshot.practiceSession;
  const session = practice?.state?.session;
  const mission = session?.revisionMission;
  const integrity = session?.revisionMissionIntegrity;
  if (mission === undefined && integrity === undefined) return;
  if (!practice || !session || mission === undefined || typeof integrity !== 'string' || !integrity) {
    throw new TypeError('Revision mission integrity metadata is incomplete.');
  }
  const expected = createSpellingRevisionMissionIntegrity({
    session,
    mission,
    startedAt: practice.startedAt,
  });
  if (integrity !== expected) throw new TypeError('Revision mission integrity check failed.');
}

export function projectSpellingRevisionMission({
  snapshot: rawSnapshot,
  contentSnapshot,
  nowMs,
} = {}) {
  const catalogue = validateCatalogueV1(contentSnapshot);
  const snapshot = validateSpellingCommandSnapshotV1(rawSnapshot, catalogue);
  const todayDay = canonicalGuardianDay(nowMs);
  return deriveSpellingRevisionMissionProjection({
    snapshot,
    contentSnapshot: catalogue,
    todayGuardianDay: todayDay,
  });
}

export function hasFullSpellingRevisionAccess(snapshot, catalogue) {
  return hasFullSpellingRevisionAccessAuthority(snapshot, catalogue);
}
