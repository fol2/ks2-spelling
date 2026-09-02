import starterCatalogue from '../../../vendor/ks2-mastery/content/spelling.mobile-runtime-starter.json' with { type: 'json' };
import fullCatalogue from '../../../vendor/ks2-mastery/content/spelling.mobile-runtime-full.json' with { type: 'json' };
import {
  applySpellingCommand as applySpellingCommandExact,
  createInMemorySpellingCommandRepository as createInMemorySpellingCommandRepositoryExact,
  projectParentSpellingProgress as projectParentSpellingProgressExact,
  projectSpellingRevisionMission as projectSpellingRevisionMissionExact,
  validateSpellingCommandPlanV1 as validateSpellingCommandPlanV1Exact,
  validateSpellingCommandRepository,
  validateSpellingCommandSnapshotV1 as validateSpellingCommandSnapshotV1Exact,
} from '../../../vendor/ks2-mastery/shared/spelling/mobile/a3/index.js';
import {
  combineMonsterChoiceRecency,
  recencyForCommittedMonsters,
  restoreMonsterChoiceRecency,
  stripMonsterChoiceRecency,
  takeMonsterChoiceRecency,
} from '../sync/monster-choice-recency.js';

export {
  MOBILE_AUDIO_KINDS,
  MOBILE_AUDIO_PROFILES,
  PACK_MANIFEST_SCHEMA_VERSION,
  SPELLING_COMMAND_MAX_CONFLICT_ATTEMPTS,
  SPELLING_COMMAND_PLAN_SCHEMA_VERSION,
  SPELLING_COMMAND_SNAPSHOT_SCHEMA_VERSION,
  SPELLING_MOBILE_COMMAND_TYPES,
  assertNoDuplicateActiveTargets,
  assertParentProjectionRedacted,
  canonicalGuardianDay,
  createAudioKeyV1,
  createInMemorySpellingProfileRepository,
  createLegacyEngineContentSnapshot,
  createRuntimeItemId,
  createRuntimeItemReference,
  fromLegacyEngineSnapshot,
  normaliseMobileRuntimeSnapshot,
  normaliseSpellingTarget,
  parseRuntimeItemId,
  projectSpellingCampTransition,
  projectSpellingMonsters,
  toLegacyEngineSnapshot,
  validateCatalogueV1,
  validatePackManifestV1,
  validateRewardTrackV1,
  validateSpellingCommandV1,
  validateSpellingProfileRepository,
} from '../../../vendor/ks2-mastery/shared/spelling/mobile/a3/index.js';

function freezeCatalogue(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeCatalogue(child);
    Object.freeze(value);
  }
  return value;
}

const READ_ONLY_STARTER_CATALOGUE = freezeCatalogue(starterCatalogue);
const READ_ONLY_FULL_CATALOGUE = freezeCatalogue(fullCatalogue);

export function loadStarterSpellingCatalogue() {
  return READ_ONLY_STARTER_CATALOGUE;
}

export function loadFullSpellingCatalogue() {
  return READ_ONLY_FULL_CATALOGUE;
}

export {
  ACHIEVEMENT_DEFINITIONS,
  ACHIEVEMENT_IDS,
  isAchievementProgressKey,
} from '../../../vendor/ks2-mastery/shared/spelling/core/achievements.js';

// The Codex milestone ladder reads the engine's milestones, never a second set.
export { SPELLING_MASTERY_MILESTONES } from '../../../vendor/ks2-mastery/shared/spelling/core/events.js';

export function validateSpellingCommandSnapshotV1(snapshot, catalogue) {
  const recency = takeMonsterChoiceRecency(snapshot);
  const validated = validateSpellingCommandSnapshotV1Exact(
    stripMonsterChoiceRecency(snapshot),
    catalogue,
  );
  return restoreMonsterChoiceRecency(validated, recency);
}

export function validateSpellingCommandPlanV1(plan, catalogue, inputSnapshot, options) {
  const recency = combineMonsterChoiceRecency(
    takeMonsterChoiceRecency(plan),
    takeMonsterChoiceRecency(inputSnapshot),
  );
  const validated = validateSpellingCommandPlanV1Exact(
    stripMonsterChoiceRecency(plan),
    catalogue,
    stripMonsterChoiceRecency(inputSnapshot),
    options,
  );
  return restoreMonsterChoiceRecency(validated, recency);
}

export function projectSpellingRevisionMission(input) {
  return projectSpellingRevisionMissionExact({
    ...input,
    snapshot: stripMonsterChoiceRecency(input?.snapshot),
  });
}

export function projectParentSpellingProgress(input) {
  return projectParentSpellingProgressExact({
    ...input,
    learnerSnapshots: Array.isArray(input?.learnerSnapshots)
      ? input.learnerSnapshots.map((snapshot) => stripMonsterChoiceRecency(snapshot))
      : input?.learnerSnapshots,
  });
}

export function applySpellingCommand(input) {
  const recency = combineMonsterChoiceRecency(
    takeMonsterChoiceRecency(input?.command),
    takeMonsterChoiceRecency(input?.snapshot),
  );
  const result = applySpellingCommandExact({
    ...input,
    snapshot: stripMonsterChoiceRecency(input?.snapshot),
    command: stripMonsterChoiceRecency(input?.command),
  });
  return restoreMonsterChoiceRecency(result, recency);
}

export { validateSpellingCommandRepository };

export function createInMemorySpellingCommandRepository(options) {
  const recencyByLearnerId = new Map();
  const snapshots = Array.isArray(options?.snapshots)
    ? options.snapshots.map((snapshot) => {
      const recency = takeMonsterChoiceRecency(snapshot);
      if (typeof snapshot?.learnerId === 'string' && recency.size > 0) {
        recencyByLearnerId.set(snapshot.learnerId, recency);
      }
      return stripMonsterChoiceRecency(snapshot);
    })
    : options?.snapshots;
  const inner = createInMemorySpellingCommandRepositoryExact({
    ...options,
    snapshots,
  });
  return validateSpellingCommandRepository({
    runCommandTransaction(learnerId, planner) {
      let pendingRecency;
      return inner.runCommandTransaction(learnerId, async (fresh, context) => {
        const restored = restoreMonsterChoiceRecency(
          fresh,
          recencyByLearnerId.get(learnerId) ?? new Map(),
        );
        const plan = await planner(restored, context);
        pendingRecency = recencyForCommittedMonsters(
          plan,
          recencyByLearnerId.get(learnerId),
        );
        return stripMonsterChoiceRecency(plan);
      }).then((committed) => {
        if (pendingRecency !== undefined) {
          recencyByLearnerId.set(learnerId, pendingRecency);
        }
        return restoreMonsterChoiceRecency(
          committed,
          recencyByLearnerId.get(learnerId) ?? new Map(),
        );
      });
    },
  });
}
