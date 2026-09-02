import {
  assignedMonsterBranch,
  companionCanSwitchBranch,
  monsterIsFound,
  pendingEggChoice,
} from './monster-progress-model.js';
import { revealStarterCompleteAfterCelebrations } from './starter-complete-moment-runtime.js';

export const EGG_CHOICE_COPY = Object.freeze({
  headline: 'Which egg is yours?',
  body: 'Tap one.',
  announcement: 'Which egg is yours? Tap one.',
  saveFailed: 'Could not save. Try again.',
  close: 'Close',
});

export function eggChoiceCopy() {
  return EGG_CHOICE_COPY;
}

export function eggChoiceSaveFailedVisible(failedTrackId, currentTrackId) {
  return failedTrackId === currentTrackId
    && typeof currentTrackId === 'string'
    && currentTrackId.length > 0;
}

function stringIds(value) {
  return (Array.isArray(value) ? value : []).filter(
    (id) => typeof id === 'string' && id.length > 0,
  );
}

/**
 * Failed-save Close skips retrying that overlay for that track, not every
 * later egg, Codex switch, or learner. The skip list is dropped when the
 * learner changes or persistence recovers, and painted stage-0 tracks are
 * never kept suppressed so Codex can still switch.
 */
export function nextSkippedEggChoiceTrackIds(
  skippedRewardTrackIds = [],
  {
    dismissedTrackId = null,
    learnerChanged = false,
    persistenceRecovered = false,
    companionSwitchAllowed = false,
    monsters,
  } = {},
) {
  if (learnerChanged === true || persistenceRecovered === true) return [];

  const seen = new Set();
  const next = [];
  for (const id of stringIds(skippedRewardTrackIds)) {
    if (seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  if (typeof dismissedTrackId === 'string' && dismissedTrackId.length > 0
    && !seen.has(dismissedTrackId)) {
    next.push(dismissedTrackId);
  }
  if (!Array.isArray(monsters)) return next;

  const stillChoosable = new Set();
  const switchable = new Set();
  for (const monster of monsters) {
    const id = monster?.rewardTrackId;
    if (typeof id !== 'string' || id.length === 0) continue;
    if (companionCanSwitchBranch(monster)) switchable.add(id);
    if (monsterIsFound(monster) && assignedMonsterBranch(monster) === null) {
      stillChoosable.add(id);
    }
  }
  return next.filter((id) => {
    if (companionSwitchAllowed === true && switchable.has(id)) return false;
    return stillChoosable.has(id);
  });
}

export function eggChoiceShouldShow({
  monsters,
  screen,
  parentOpen = false,
  switchOpen = false,
  celebrationEvents = [],
  choosableRewardTrackIds,
  skippedRewardTrackIds = [],
} = {}) {
  if (parentOpen === true || switchOpen === true) return false;
  if (screen === 'practice') return false;
  if (Array.isArray(celebrationEvents) && celebrationEvents.length > 0) return false;
  return pendingEggChoice(
    monsters,
    choosableRewardTrackIds,
    skippedRewardTrackIds,
  ) !== null;
}

export function planEggChoiceDismiss({
  pendingMoment = null,
  monsters,
  choosableRewardTrackIds,
  skippedRewardTrackIds = [],
  dismissedTrackId = null,
} = {}) {
  const skipped = nextSkippedEggChoiceTrackIds(skippedRewardTrackIds, {
    dismissedTrackId,
    monsters,
  });
  return Object.freeze({
    skippedRewardTrackIds: skipped,
    openStarterComplete: revealStarterCompleteAfterCelebrations(pendingMoment, {
      eggChoicePending: pendingEggChoice(
        monsters,
        choosableRewardTrackIds,
        skipped,
      ) != null,
    }),
  });
}
