export {
  advanceGuardianOnCorrect,
  advanceGuardianOnWrong,
  computeGuardianMissionState,
  createSpellingService,
  defaultSpellingPrefs,
  deriveGuardianAggregates,
  ensureGuardianRecord,
  isGuardianEligibleSlug,
  selectBossWords,
  selectGuardianWords,
  selectPatternQuestCards,
} from './service.js';
export { createLegacySpellingEngine } from './legacy-engine.js';
export * from './service-contract.js';
export * from './events.js';
export * from './audio-preferences.js';
