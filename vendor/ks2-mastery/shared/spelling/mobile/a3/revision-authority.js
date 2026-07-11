import {
  computeGuardianMissionState,
  deriveGuardianAggregates,
  isStatutoryCoreWord,
} from '../../core/index.js';
import {
  createLegacyEngineContentSnapshot,
  toLegacyEngineSnapshot,
  validateCatalogueV1,
} from '../index.js';

const FULL_CATALOGUE_ID = 'ks2-core:full';
const FULL_ENTITLEMENT_ID = 'full-ks2';
const ELIGIBLE_MISSION_STATES = new Set(['first-patrol', 'wobbling', 'due']);

export function hasFullSpellingRevisionAccessAuthority(snapshot, catalogue) {
  if (catalogue.catalogueId !== FULL_CATALOGUE_ID) return false;
  const granted = new Set(snapshot.grantedEntitlementIds);
  return granted.has(FULL_ENTITLEMENT_ID)
    && catalogue.entitlementIds.every((entitlementId) => granted.has(entitlementId));
}

export function deriveSpellingRevisionMissionProjection({
  snapshot,
  contentSnapshot,
  todayGuardianDay,
} = {}) {
  const catalogue = validateCatalogueV1(contentSnapshot);
  if (!Number.isSafeInteger(todayGuardianDay) || todayGuardianDay < 0) {
    throw new TypeError('Revision authority requires a non-negative safe Guardian day.');
  }
  if (!hasFullSpellingRevisionAccessAuthority(snapshot, catalogue)) {
    return {
      missionState: 'locked',
      eligibleMissionKind: null,
      guardianDueCount: 0,
      wobblingDueCount: 0,
      nextGuardianDueDay: null,
      todayGuardianDay,
      canStartRewardBearing: false,
      canContinueUnrewarded: false,
      campCreditState: 'unavailable',
    };
  }

  const legacy = toLegacyEngineSnapshot({
    progress: snapshot.subjectState.data.progress,
    guardianMap: snapshot.subjectState.data.guardianMap,
    pattern: snapshot.subjectState.data.pattern,
    session: null,
    summary: null,
    events: [],
  }, catalogue);
  const { words, wordBySlug } = createLegacyEngineContentSnapshot(catalogue);
  const aggregates = deriveGuardianAggregates({
    guardianMap: legacy.guardianMap,
    progressMap: legacy.progress,
    wordBySlug,
    todayDay: todayGuardianDay,
  });
  const statutoryCoreWords = words.filter(isStatutoryCoreWord);
  const allWordsMega = statutoryCoreWords.length > 0
    && statutoryCoreWords.every((word) => Number(legacy.progress[word.slug]?.stage) >= 4);
  const missionState = computeGuardianMissionState({
    allWordsMega,
    eligibleGuardianEntries: aggregates.eligibleGuardianEntries,
    unguardedMegaCount: aggregates.unguardedMegaCount,
    todayDay: todayGuardianDay,
    policy: { allowOptionalPatrol: false },
  });
  const eligibleMissionKind = ELIGIBLE_MISSION_STATES.has(missionState) ? missionState : null;
  const currentCamp = snapshot.campStateByPackId[catalogue.packId];
  const completeForToday = currentCamp?.lastCreditedGuardianDay != null
    && currentCamp.lastCreditedGuardianDay >= todayGuardianDay;
  const campCreditState = completeForToday ? 'complete-for-today' : 'available';

  return {
    missionState,
    eligibleMissionKind,
    guardianDueCount: aggregates.guardianDueCount,
    wobblingDueCount: aggregates.wobblingDueCount,
    nextGuardianDueDay: aggregates.nextGuardianDueDay,
    todayGuardianDay,
    canStartRewardBearing: eligibleMissionKind !== null && !completeForToday,
    canContinueUnrewarded: eligibleMissionKind !== null && completeForToday,
    campCreditState,
  };
}
