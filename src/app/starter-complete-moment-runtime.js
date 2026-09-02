import {
  achievementCelebration,
  campLevelCelebration,
  diffMonsterCelebrations,
  milestoneCelebration,
  primaryProgressedRewardTrackId,
  secureWordDelta,
} from './celebrations/celebration-model.js';
import { pendingEggChoice } from './monster-progress-model.js';
import { starterCompleteMomentDecision } from './starter-complete-moment.js';

function remainingWordCountOf(value) {
  return Number.isSafeInteger(value) ? value : 0;
}

/**
 * Results-entry plan: celebration queue first, then found-egg choice, then
 * the one-time Starter signpost. A live crossing with no celebration events
 * and no pending egg opens immediately.
 */
export function planSummaryRewards({
  previousScreen,
  next,
  remainingWordCount,
  entitled,
  starterCatalogue,
} = {}) {
  if (previousScreen === 'summary' && next?.screen !== 'summary') {
    return Object.freeze({
      leaveSummary: true,
      celebrationEvents: null,
      pendingMoment: null,
      openMoment: false,
      secureGain: 0,
      campGain: 0,
      preferredTrack: null,
      warmCelebrationStage: false,
    });
  }
  if (previousScreen === 'summary' || next?.screen !== 'summary') {
    return Object.freeze({
      leaveSummary: false,
      celebrationEvents: null,
      pendingMoment: null,
      openMoment: false,
      secureGain: 0,
      campGain: 0,
      preferredTrack: null,
      warmCelebrationStage: false,
    });
  }

  const remaining = remainingWordCountOf(remainingWordCount);
  const before = next.roundBaseline?.monsters ?? [];
  const monsterEvents = diffMonsterCelebrations(before, next.monsters);
  const raisedCamp = (next.camp?.campHighWater ?? 0)
    - (next.roundBaseline?.camp?.campHighWater
      ?? next.camp?.campHighWater
      ?? 0);
  const roundSessionId = next.roundBaseline?.sessionId ?? null;
  const milestoneCards = roundSessionId
    ? (next.records?.milestones ?? [])
      .filter((record) => record.sessionId === roundSessionId)
      .map(milestoneCelebration)
    : [];
  const baselineAchievementIds = next.roundBaseline?.achievementIds ?? [];
  const achievementCards = (next.achievements ?? [])
    .filter((chip) => !baselineAchievementIds.includes(chip.id))
    .map(achievementCelebration);
  const celebrationEvents = [
    ...monsterEvents,
    ...milestoneCards,
    ...achievementCards,
    ...(raisedCamp > 0 ? [campLevelCelebration(next.camp?.campHighWater)] : []),
  ];
  const decision = starterCompleteMomentDecision({
    beforeMonsters: before,
    afterMonsters: next.monsters,
    starterCatalogue,
    presented: next.starterCompleteMomentPresented === true,
    entitled,
    remainingWordCount: remaining,
    source: 'round',
  });
  const pendingMoment = decision.show ? { remainingWordCount: remaining } : null;
  const eggChoice = pendingEggChoice(next.monsters);
  return Object.freeze({
    leaveSummary: false,
    celebrationEvents,
    pendingMoment,
    openMoment: decision.show && celebrationEvents.length === 0 && eggChoice == null,
    eggChoice: eggChoice
      ? Object.freeze({
        rewardTrackId: eggChoice.rewardTrackId,
        monsterId: eggChoice.monsterId,
      })
      : null,
    secureGain: secureWordDelta(before, next.monsters),
    campGain: raisedCamp,
    preferredTrack: primaryProgressedRewardTrackId(monsterEvents, next.monsters)
      ?? next.roundBaseline?.companionRewardTrackId
      ?? null,
    warmCelebrationStage: celebrationEvents.some(
      (event) => event.kind === 'caught' || event.kind === 'evolve',
    ),
  });
}

export function revealStarterCompleteAfterCelebrations(
  pendingMoment,
  { eggChoicePending = false } = {},
) {
  return pendingMoment != null && eggChoicePending !== true;
}

/**
 * Persist the presented flag before dismissing. A write failure or missing
 * persist keeps the pending moment so the learner can retry; the crossing
 * itself will not fire again.
 */
export async function acknowledgeStarterCompleteMoment({
  inFlight,
  persist,
  dismiss,
} = {}) {
  if (
    !inFlight
    || typeof persist !== 'function'
    || typeof dismiss !== 'function'
  ) {
    throw new TypeError(
      'Starter complete acknowledgement requires inFlight, persist() and dismiss().',
    );
  }
  if (inFlight.current) return false;
  inFlight.current = true;
  try {
    await persist();
    dismiss();
    return true;
  } catch {
    return false;
  } finally {
    inFlight.current = false;
  }
}

export function createStarterCompleteAskGrownUpHandler({ persist, openParent } = {}) {
  if (typeof persist !== 'function' || typeof openParent !== 'function') {
    throw new TypeError('Ask-a-grown-up handler requires persist() and openParent().');
  }
  return async function askGrownUp() {
    const persisted = await persist();
    if (persisted === true) openParent();
    return persisted === true;
  };
}

export function starterCompleteMomentMountFocus(continueEl) {
  continueEl?.focus?.({ preventScroll: true });
}

export function starterCompleteMomentRestoreFocus(previous) {
  if (typeof previous?.focus === 'function') previous.focus();
}

export function starterCompleteMomentKeyDown(
  event,
  { continueEl, grownUpEl, active } = {},
) {
  if (event?.key === 'Escape') {
    event.preventDefault?.();
    return { action: 'continue' };
  }
  if (event?.key !== 'Tab') return null;
  const current = active
    ?? (typeof document !== 'undefined' ? document.activeElement : null);
  if (event.shiftKey && current === continueEl) {
    event.preventDefault?.();
    return { focus: grownUpEl };
  }
  if (!event.shiftKey && current === grownUpEl) {
    event.preventDefault?.();
    return { focus: continueEl };
  }
  return null;
}
