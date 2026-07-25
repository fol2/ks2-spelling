/** Auto-advance delay for the practice screen (ported delay rule only). */

export function autoAdvanceDelayMs(mode) {
  return mode === 'test' ? 320 : 500;
}

/**
 * The web session scene's dot strip: one dot per word in the round, filled for
 * every word already secured, with the next one marked current. Round lengths
 * are 5, 10 or 20, so the web's bucketing for long rounds never applies here.
 */
export function roundProgressDots({ done = 0, total = 0 } = {}) {
  const size = Math.max(0, Math.trunc(total));
  const secured = Math.min(size, Math.max(0, Math.trunc(done)));
  return Array.from({ length: size }, (_, index) => {
    if (index < secured) return 'done';
    return index === secured ? 'current' : '';
  });
}

/**
 * A summary for a round the learner ended early. The A3 contract has no
 * finalise-now command — `end-session` abandons — so the round-so-far is
 * described from the engine's own session counters rather than invented:
 * `checked` is the words reached, `done` the words secured, `wrongCount` the
 * words that needed a correction. Accuracy uses the same clean-first-attempt
 * rule the engine's own summary uses, over the words actually reached.
 * Returns null when nothing was answered — there is no round to report.
 */
export function earlyRoundSummary(practice) {
  const progress = practice?.progress;
  if (!progress) return null;
  const reached = Math.max(0, Math.trunc(progress.checked ?? 0));
  if (reached === 0) return null;
  const secured = Math.max(0, Math.trunc(progress.done ?? 0));
  const corrected = Math.max(0, Math.trunc(progress.wrongCount ?? 0));
  const clean = Math.max(0, reached - corrected);
  return {
    mode: practice.mode ?? 'smart',
    label: practice.label ?? '',
    sessionId: practice.sessionId ?? null,
    endedEarly: true,
    message:
      'You ended this round early. Every word you answered has been saved.',
    cards: [
      {
        label: 'Words reached',
        value: reached,
        sub: 'Answered before you ended',
      },
      {
        label: 'Secured this round',
        value: secured,
        sub: 'Two clean recalls each',
      },
      {
        label: 'Needed correction',
        value: corrected,
        sub: 'These words came back again',
      },
    ],
    totalWords: reached,
    correct: clean,
    accuracy: Math.round((clean / reached) * 100),
    mistakes: [],
  };
}

// iOS hands every text field the same keyboard, so its `123` page can put a
// digit into a spelling and the web platform offers no way to take that page
// away. Filtering on the way in closes it from this side: no pack target has
// ever held anything but letters, with an apostrophe or hyphen where a word
// carries one, so everything else is dropped as it is typed.
const NOT_SPELLING = /[^\p{L}'’-]+/gu;

export function spellingOnly(typed) {
  return typeof typed === 'string' ? typed.replace(NOT_SPELLING, '') : '';
}
