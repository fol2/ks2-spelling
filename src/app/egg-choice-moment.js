import { pendingEggChoice } from './monster-progress-model.js';

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

export function eggChoiceShouldShow({
  monsters,
  screen,
  parentOpen = false,
  switchOpen = false,
  celebrationEvents = [],
  choosableRewardTrackIds,
} = {}) {
  if (parentOpen === true || switchOpen === true) return false;
  if (screen === 'practice') return false;
  if (Array.isArray(celebrationEvents) && celebrationEvents.length > 0) return false;
  return pendingEggChoice(monsters, choosableRewardTrackIds) !== null;
}
