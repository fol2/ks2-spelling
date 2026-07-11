export const SPELLING_EVENT_TYPES = Object.freeze({
  RETRY_CLEARED: 'spelling.retry-cleared',
  WORD_SECURED: 'spelling.word-secured',
  MASTERY_MILESTONE: 'spelling.mastery-milestone',
  SESSION_COMPLETED: 'spelling.session-completed',
  GUARDIAN_RENEWED: 'spelling.guardian.renewed',
  GUARDIAN_WOBBLED: 'spelling.guardian.wobbled',
  GUARDIAN_RECOVERED: 'spelling.guardian.recovered',
  GUARDIAN_MISSION_COMPLETED: 'spelling.guardian.mission-completed',
  BOSS_COMPLETED: 'spelling.boss.completed',
  POST_MEGA_UNLOCKED: 'spelling.post-mega.unlocked',
  PATTERN_QUEST_COMPLETED: 'spelling.pattern.quest-completed',
});

export const SPELLING_MASTERY_MILESTONES = Object.freeze([1, 5, 10, 25, 50, 100, 150, 200]);

function safeTimestamp(value, fallback = 0) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  const parsedFallback = Number(fallback);
  return Number.isFinite(parsedFallback) && parsedFallback >= 0 ? parsedFallback : 0;
}

function wordFields(slug, wordMeta) {
  if (!wordMeta) return null;
  const word = wordMeta[slug];
  if (!word) return null;
  return {
    wordSlug: word.slug,
    word: word.word,
    family: word.family,
    yearBand: word.year,
    spellingPool: word.spellingPool === 'extra' ? 'extra' : 'core',
  };
}

function eventId(type, parts) {
  return [type, ...parts].map((part) => String(part ?? 'unknown')).join(':');
}

function baseSpellingEvent(type, payload = {}, idParts = []) {
  const createdAt = safeTimestamp(payload.createdAt);
  return {
    id: eventId(type, idParts),
    type,
    subjectId: 'spelling',
    learnerId: payload.learnerId || 'default',
    sessionId: payload.session?.id || payload.sessionId || null,
    mode: payload.session?.mode || payload.mode || null,
    createdAt,
  };
}

export function createSpellingRetryClearedEvent({ learnerId, session, slug, fromPhase, attemptCount = null, createdAt, wordMeta } = {}) {
  const word = wordFields(slug, wordMeta);
  if (!word) return null;
  if (!['retry', 'correction'].includes(fromPhase)) return null;

  return {
    ...baseSpellingEvent(
      SPELLING_EVENT_TYPES.RETRY_CLEARED,
      { learnerId, session, createdAt },
      [learnerId || 'default', session?.id || 'session', slug, fromPhase, Number.isInteger(attemptCount) ? attemptCount : 'na'],
    ),
    ...word,
    fromPhase,
    attemptCount: Number.isInteger(attemptCount) ? attemptCount : null,
  };
}

export function createSpellingWordSecuredEvent({ learnerId, session, slug, stage = null, createdAt, wordMeta } = {}) {
  const word = wordFields(slug, wordMeta);
  if (!word) return null;

  return {
    ...baseSpellingEvent(
      SPELLING_EVENT_TYPES.WORD_SECURED,
      { learnerId, session, createdAt },
      [learnerId || 'default', session?.id || 'session', slug, stage ?? 'secure'],
    ),
    ...word,
    stage: Number.isInteger(stage) ? stage : null,
  };
}

export function createSpellingMasteryMilestoneEvent({ learnerId, session, milestone, secureCount, createdAt } = {}) {
  const parsedMilestone = Number(milestone);
  if (!Number.isInteger(parsedMilestone) || parsedMilestone <= 0) return null;

  return {
    ...baseSpellingEvent(
      SPELLING_EVENT_TYPES.MASTERY_MILESTONE,
      { learnerId, session, createdAt },
      [learnerId || 'default', parsedMilestone],
    ),
    milestone: parsedMilestone,
    secureCount: Number.isInteger(Number(secureCount)) ? Number(secureCount) : parsedMilestone,
  };
}

export function createSpellingSessionCompletedEvent({ learnerId, session, summary, createdAt } = {}) {
  if (!session?.id) return null;
  return {
    ...baseSpellingEvent(
      SPELLING_EVENT_TYPES.SESSION_COMPLETED,
      { learnerId, session, createdAt },
      [learnerId || 'default', session.id],
    ),
    sessionType: session.type,
    totalWords: Array.isArray(session.uniqueWords) ? session.uniqueWords.length : 0,
    mistakeCount: Array.isArray(summary?.mistakes) ? summary.mistakes.length : 0,
  };
}

/**
 * Emitted when a word in a Guardian Mission is answered correctly and its
 * review interval advances to the next schedule step. Carries the resulting
 * reviewLevel and nextDueDay so reward subscribers (landing later) can show
 * "next check in N days" toasts without re-computing the schedule.
 */
export function createSpellingGuardianRenewedEvent({
  learnerId,
  session,
  slug,
  reviewLevel = 0,
  nextDueDay = null,
  createdAt,
  wordMeta,
} = {}) {
  const word = wordFields(slug, wordMeta);
  if (!word) return null;
  return {
    ...baseSpellingEvent(
      SPELLING_EVENT_TYPES.GUARDIAN_RENEWED,
      { learnerId, session, createdAt },
      [learnerId || 'default', session?.id || 'session', slug, Number.isInteger(reviewLevel) ? reviewLevel : 'na'],
    ),
    ...word,
    reviewLevel: Number.isInteger(reviewLevel) && reviewLevel >= 0 ? reviewLevel : 0,
    nextDueDay: Number.isInteger(nextDueDay) && nextDueDay >= 0 ? nextDueDay : null,
  };
}

/**
 * Emitted when a Guardian Mission word is answered wrongly and enters the
 * "wobbling" maintenance state. Mega stays intact; wobbling is a flag on the
 * guardian sibling record, not a demotion of progress.stage. Carries the
 * lapses count so reward subscribers can react to repeated wobbles.
 */
export function createSpellingGuardianWobbledEvent({
  learnerId,
  session,
  slug,
  lapses = 0,
  createdAt,
  wordMeta,
} = {}) {
  const word = wordFields(slug, wordMeta);
  if (!word) return null;
  return {
    ...baseSpellingEvent(
      SPELLING_EVENT_TYPES.GUARDIAN_WOBBLED,
      { learnerId, session, createdAt },
      [learnerId || 'default', session?.id || 'session', slug, Number.isInteger(lapses) ? lapses : 'na'],
    ),
    ...word,
    lapses: Number.isInteger(lapses) && lapses >= 0 ? lapses : 0,
  };
}

/**
 * Emitted when a previously-wobbling word is answered correctly and clears
 * its wobbling flag. Renewal count is the lifetime total of wobbling->clear
 * transitions for this word. reviewLevel is unchanged on recovery (preserves
 * the spaced schedule rather than restarting from 0).
 */
export function createSpellingGuardianRecoveredEvent({
  learnerId,
  session,
  slug,
  renewals = 0,
  reviewLevel = 0,
  createdAt,
  wordMeta,
} = {}) {
  const word = wordFields(slug, wordMeta);
  if (!word) return null;
  return {
    ...baseSpellingEvent(
      SPELLING_EVENT_TYPES.GUARDIAN_RECOVERED,
      { learnerId, session, createdAt },
      [learnerId || 'default', session?.id || 'session', slug, Number.isInteger(renewals) ? renewals : 'na'],
    ),
    ...word,
    renewals: Number.isInteger(renewals) && renewals >= 0 ? renewals : 0,
    reviewLevel: Number.isInteger(reviewLevel) && reviewLevel >= 0 ? reviewLevel : 0,
  };
}

/**
 * Emitted when a Guardian Mission round finalises to summary. Mirrors
 * createSpellingSessionCompletedEvent's shape but carries guardian-specific
 * counts so reward subscribers (and later dashboards) don't have to walk the
 * per-word event stream.
 */
export function createSpellingGuardianMissionCompletedEvent({
  learnerId,
  session,
  renewalCount = 0,
  wobbledCount = 0,
  recoveredCount = 0,
  createdAt,
} = {}) {
  if (!session?.id) return null;
  return {
    ...baseSpellingEvent(
      SPELLING_EVENT_TYPES.GUARDIAN_MISSION_COMPLETED,
      { learnerId, session, createdAt },
      [learnerId || 'default', session.id],
    ),
    totalWords: Array.isArray(session.uniqueWords) ? session.uniqueWords.length : 0,
    renewalCount: Number.isInteger(renewalCount) && renewalCount >= 0 ? renewalCount : 0,
    wobbledCount: Number.isInteger(wobbledCount) && wobbledCount >= 0 ? wobbledCount : 0,
    recoveredCount: Number.isInteger(recoveredCount) && recoveredCount >= 0 ? recoveredCount : 0,
  };
}

/**
 * Emitted when a Boss Dictation round finalises to summary (U9). Mirrors
 * createSpellingGuardianMissionCompletedEvent's shape but carries Boss-specific
 * score metadata (correct/wrong/length + seed slug list). Deterministic event
 * id: `['spelling.boss.completed', learnerId, session.id].join(':')`.
 *
 * The seedSlugs list is the exact ordered sample produced by selectBossWords
 * at round start; reward subscribers and later dashboards can replay the round
 * scope without walking the per-answer event stream.
 */
export function createSpellingBossCompletedEvent({
  learnerId,
  session,
  summary,
  seedSlugs = null,
  createdAt,
} = {}) {
  if (!session?.id) return null;
  const correct = Number.isInteger(Number(summary?.correct)) && Number(summary.correct) >= 0
    ? Number(summary.correct)
    : 0;
  const wrong = Number.isInteger(Number(summary?.wrong)) && Number(summary.wrong) >= 0
    ? Number(summary.wrong)
    : 0;
  const length = Array.isArray(session.uniqueWords) ? session.uniqueWords.length : (correct + wrong);
  const safeSeedSlugs = Array.isArray(seedSlugs)
    ? seedSlugs.filter((slug) => typeof slug === 'string' && slug)
    : (Array.isArray(session.uniqueWords) ? session.uniqueWords.slice() : []);
  return {
    ...baseSpellingEvent(
      SPELLING_EVENT_TYPES.BOSS_COMPLETED,
      { learnerId, session, createdAt },
      [learnerId || 'default', session.id],
    ),
    length,
    correct,
    wrong,
    seedSlugs: safeSeedSlugs,
  };
}

/**
 * P2 U2: Emitted exactly once per learner, on the moment they first achieve
 * `allWordsMega: true` via a submit that transitioned a slug `< 4 → === 4`.
 * Carries the content-release-id the learner graduated under so downstream
 * consumers (U3 seed harness, U12 reward subscriber) can diff against the
 * current content bundle.
 *
 * Deterministic id format: `spelling.post-mega.unlocked:<learnerId>:<unlockedAt>`.
 * Idempotent at the persistence layer (H3 guard) AND at the event layer: the
 * service never emits this event twice because the pre/post submit-caused-this
 * guard fails on any subsequent Mega-producing submit (stage was already
 * at 4 pre-submit).
 */
/**
 * P2 U11: Emitted when a Pattern Quest round finalises. Carries the pattern
 * id, the ordered slug list (roster of the 5-card round), the correct count,
 * and the list of slugs that wobbled during the round. A round where all 5
 * cards were correct emits `correctCount: 5, wobbledSlugs: []`; any wrong
 * answer populates `wobbledSlugs` with the distinct slug(s) that wobbled
 * (cards 1/2/4 reference specific slugs; cards 3 and 5 reference the quest
 * pattern generally via one of the round's slugs so achievement logic can
 * still associate wrongs to the pattern).
 *
 * Deterministic id format:
 *   `spelling.pattern.quest-completed:<learnerId>:<sessionId>:<patternId>`.
 * Emission always runs after the round is finalised (summary phase), so one
 * session id produces at most one event.
 */
export function createSpellingPatternQuestCompletedEvent({
  learnerId,
  session,
  patternId,
  patternTitle = '',
  slugs = [],
  correctCount = 0,
  wobbledSlugs = [],
  createdAt,
} = {}) {
  if (!session?.id) return null;
  if (typeof patternId !== 'string' || !patternId) return null;
  const safeSlugs = Array.isArray(slugs)
    ? slugs.filter((slug) => typeof slug === 'string' && slug)
    : [];
  const safeWobbled = Array.isArray(wobbledSlugs)
    ? wobbledSlugs.filter((slug) => typeof slug === 'string' && slug)
    : [];
  const safeCorrect = Number.isInteger(Number(correctCount)) && Number(correctCount) >= 0
    ? Number(correctCount)
    : 0;
  // Fix 6: pattern title travels with the event so the reward-toast
  // subscriber renders readable copy ("Pattern Quest: 3/5 on Words ending
  // in -tion") without a separate registry lookup. Subscribers that
  // receive a shipped event without patternTitle (legacy events persisted
  // before Fix 6) fall back to patternId.
  const safeTitle = typeof patternTitle === 'string' ? patternTitle : '';
  return {
    ...baseSpellingEvent(
      SPELLING_EVENT_TYPES.PATTERN_QUEST_COMPLETED,
      { learnerId, session, createdAt },
      [learnerId || 'default', session.id, patternId],
    ),
    patternId,
    patternTitle: safeTitle,
    slugs: safeSlugs,
    correctCount: safeCorrect,
    wobbledSlugs: safeWobbled,
  };
}

export function createSpellingPostMegaUnlockedEvent({
  learnerId,
  unlockedAt,
  contentReleaseId,
  publishedCoreCount,
} = {}) {
  const safeLearnerId = learnerId || 'default';
  const safeUnlockedAt = safeTimestamp(unlockedAt);
  const safePublished = Number.isInteger(Number(publishedCoreCount)) && Number(publishedCoreCount) >= 0
    ? Number(publishedCoreCount)
    : 0;
  const safeReleaseId = typeof contentReleaseId === 'string' && contentReleaseId
    ? contentReleaseId
    : '';
  return {
    ...baseSpellingEvent(
      SPELLING_EVENT_TYPES.POST_MEGA_UNLOCKED,
      { learnerId: safeLearnerId, createdAt: safeUnlockedAt },
      [safeLearnerId, safeUnlockedAt],
    ),
    unlockedAt: safeUnlockedAt,
    contentReleaseId: safeReleaseId,
    publishedCoreCount: safePublished,
  };
}
