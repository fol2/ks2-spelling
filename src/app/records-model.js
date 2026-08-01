/**
 * Pure Camp chip projection for persisted achievement unlocks.
 *
 * Why: learners never see progress-before-unlock, so only unlock rows surface;
 * this product only reaches two of the four engine definitions, and advertising
 * a permanently locked record would be dishonest.
 */

import {
  ACHIEVEMENT_DEFINITIONS,
  ACHIEVEMENT_IDS,
  SPELLING_MASTERY_MILESTONES,
  isAchievementProgressKey,
} from '../domain/spelling/index.js';

// The other two quests (Boss Clean Sweep, Pattern Mastery) do not exist here.
const SURFACEABLE_ACHIEVEMENT_IDS = Object.freeze([
  ACHIEVEMENT_IDS.GUARDIAN_7_DAY,
  ACHIEVEMENT_IDS.RECOVERY_EXPERT,
]);

function isUnlockRow(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const unlockedAt = record.unlockedAt;
  return typeof unlockedAt === 'number'
    && Number.isFinite(unlockedAt)
    && unlockedAt >= 0;
}

export function achievementChips(achievements = {}) {
  if (!achievements || typeof achievements !== 'object' || Array.isArray(achievements)) {
    return [];
  }

  const chips = [];
  for (const [id, record] of Object.entries(achievements)) {
    if (isAchievementProgressKey(id)) continue;
    if (!SURFACEABLE_ACHIEVEMENT_IDS.includes(id)) continue;
    if (!isUnlockRow(record)) continue;
    const definition = ACHIEVEMENT_DEFINITIONS[id];
    if (!definition) continue;
    chips.push({
      id,
      title: definition.title,
      body: definition.body,
      unlockedAt: record.unlockedAt,
    });
  }

  chips.sort((left, right) => left.unlockedAt - right.unlockedAt);
  return chips;
}

/**
 * The engine's own mastery milestones as a ladder: every rung, whether it is
 * already behind the learner, and which single rung is the next one to reach.
 *
 * Why: the Codex should show where the journey goes next without inventing a
 * second set of numbers the engine would never celebrate.
 */
export function milestoneLadder(secureWords = 0) {
  const secure = Number.isFinite(secureWords) && secureWords > 0 ? secureWords : 0;
  // Milestones ascend, so the first rung still out of reach is the next target;
  // -1 (every rung reached) marks no rung at all.
  const nextIndex = SPELLING_MASTERY_MILESTONES.findIndex(
    (milestone) => secure < milestone,
  );
  return SPELLING_MASTERY_MILESTONES.map((milestone, index) => ({
    milestone,
    reached: secure >= milestone,
    next: index === nextIndex,
  }));
}
