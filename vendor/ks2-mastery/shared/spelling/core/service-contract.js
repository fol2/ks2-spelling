import {
  SPELLING_COVERAGE_TIER as SPELLING_COVERAGE_TIER_VALUE,
  coverageTierForWord as coverageTierForWordValue,
} from './content/taxonomy.js';

/**
 * P2 versioning convention (H7 synthesis, documented at U10): content-model
 * versions use EVEN numbers; service-state versions use ODD numbers. The two
 * version counters live in different files and get bumped on different
 * cadences, but a collision (e.g. both at 3) would blow an entire day in
 * triage to re-establish which counter moved. The even/odd split rules out
 * collisions by construction — see `SPELLING_CONTENT_MODEL_VERSION` in
 * `src/subjects/spelling/content/model.js` (currently 6).
 */
export const SPELLING_SERVICE_STATE_VERSION = 3;

/**
 * P2 U2: Spelling content-release identifier. Stamped into `data.postMega` at
 * first-graduation so a later content shake-up (new core words, retirements)
 * can diff against the release the learner graduated under. Pattern mirrors
 * Grammar's `GRAMMAR_CONTENT_RELEASE_ID` in `worker/src/subjects/grammar/content.js`
 * — an opaque string constant, bumped by hand when the content bundle changes
 * in a way learners should feel. Bump day: 2026-04-26 (baseline for P2
 * visibility theme).
 */
export const SPELLING_CONTENT_RELEASE_ID = 'spelling-p2-baseline-2026-04-26';

/**
 * P2 U10: re-export of the pattern registry identifiers so consumers
 * (Pattern Quest selector, UI, Admin dashboards) can import a single
 * constant without reaching into `content/patterns.js`. The canonical
 * registry definitions stay in that file; this is a narrow re-export
 * facade — the Array is frozen at definition, and the helpers below are
 * plain pure functions.
 */
export * from './content/patterns.js';
export * from './content/taxonomy.js';

/**
 * P2 U12: re-export of the achievement-framework canonical identifiers so
 * downstream consumers (reward subscriber, repository normaliser, Worker
 * twin, future admin panel) can import from a single service-contract
 * boundary without reaching into the achievements module itself. Mirrors
 * the U10 pattern-registry re-export above.
 */
export * from './achievements.js';

export const SPELLING_ROOT_PHASES = Object.freeze(['dashboard', 'session', 'summary', 'word-bank']);
export const SPELLING_MODES = Object.freeze(['smart', 'trouble', 'test', 'single', 'guardian', 'boss', 'pattern-quest']);

/**
 * P2 U11: Pattern Quest round length. A quest is a fixed-size 5-card round
 * (mass-then-interleave: cards 1-3 massed encoding on the same pattern,
 * cards 4-5 interleaved variety within the pattern). The constant lives
 * here so the selector, the service, and the UI share a single authoritative
 * value — changing the length in one place flows through every consumer.
 */
export const PATTERN_QUEST_ROUND_LENGTH = 5;

export const GUARDIAN_INTERVALS = Object.freeze([3, 7, 14, 30, 60, 90]);
export const GUARDIAN_MAX_REVIEW_LEVEL = GUARDIAN_INTERVALS.length - 1;
export const GUARDIAN_MIN_ROUND_LENGTH = 5;
export const GUARDIAN_MAX_ROUND_LENGTH = 8;
export const GUARDIAN_DEFAULT_ROUND_LENGTH = 8;

// Boss Dictation round bounds (U9). A Boss round draws a uniform random sample
// from the learner's Mega core-pool slugs and rides as a `type: 'test'`-shaped
// session (no retry, no cloze, no skip) with a dedicated `submitBossAnswer`
// path that NEVER demotes `progress.stage` / `dueDay` / `lastDay` / `lastResult`.
// See docs/plans/2026-04-25-005-feat-post-mega-spelling-guardian-hardening-plan.md (U9).
export const BOSS_MIN_ROUND_LENGTH = 8;
export const BOSS_MAX_ROUND_LENGTH = 12;
export const BOSS_DEFAULT_ROUND_LENGTH = 10;

/**
 * Canonical set of dashboard/selector-facing Guardian mission states. Order
 * matches the state-machine priority as enforced in `computeGuardianMissionState`:
 * 'locked' (not post-Mega) > 'first-patrol' (fresh graduate, empty map) >
 * 'wobbling' (urgent recovery dominates due) > 'due' (normal daily patrol) >
 * 'optional-patrol' (nothing due but a round can be produced) > 'rested'
 * (terminal — Begin disabled).
 *
 * The 'rested' terminal state disables the Begin button; every other state
 * opens it. Consumers should derive the `guardianMissionAvailable` boolean
 * from this set via `!== 'locked' && !== 'rested'` rather than re-enumerating
 * enabled states.
 *
 * `computeGuardianMissionState` uses this frozen list at runtime as a
 * sanity check: the returned state must be a member of this set, otherwise
 * a typo in the state-machine implementation is caught immediately rather
 * than leaking an unknown label into UI copy.
 */
export const GUARDIAN_MISSION_STATES = Object.freeze([
  'locked',
  'first-patrol',
  'wobbling',
  'due',
  'optional-patrol',
  'rested',
]);
/**
 * Single-source factory for the "locked" post-mastery snapshot. Three fallbacks
 * used to be duplicated in-line:
 *   1. `client-read-models.js::getPostMasteryState` (remote-sync stub before
 *      the first command round-trip hydrates `subjectUi.spelling.postMastery`).
 *   2. `spelling-view-model.js::buildSpellingViewModel` (session-phase shortcut
 *      when `getPostMasteryState` is not worth calling).
 *   3. `computeGuardianMissionState(...) === 'locked'` (the state-machine
 *      return value).
 *
 * Any future field we add to the post-mastery shape must be defaulted in one
 * place, or the remote-sync dashboard risks reading `undefined` for a
 * gating scalar. Callers that want to override a field (e.g. populate
 * `todayDay` from the live clock) can spread the factory output:
 *
 *   { ...createLockedPostMasteryState(), todayDay: currentDay }
 *
 * The factory returns a fresh object every call so callers can mutate the
 * result without aliasing hazards.
 */
export function createLockedPostMasteryState() {
  return {
    // P2 U2: `allWordsMega` is kept as an alias to `allWordsMegaNow` for one
    // release. Consumers gating on dashboard availability should prefer
    // `postMegaDashboardAvailable` (sticky OR live); `allWordsMega` is a
    // legacy surface that is scheduled for removal once every caller has
    // migrated. The stub returns false for both because a locked fallback
    // represents a pre-graduation learner — no live Mega, no sticky bit.
    allWordsMega: false,
    allWordsMegaNow: false,
    postMegaUnlockedEver: false,
    postMegaDashboardAvailable: false,
    newCoreWordsSinceGraduation: 0,
    publishedCoreCount: 0,
    publishedSecureExtensionCount: 0,
    publishedEnrichmentExtraCount: 0,
    guardianDueCount: 0,
    wobblingCount: 0,
    wobblingDueCount: 0,
    nonWobblingDueCount: 0,
    unguardedMegaCount: 0,
    guardianAvailableCount: 0,
    guardianMissionState: 'locked',
    guardianMissionAvailable: false,
    nextGuardianDueDay: null,
    todayDay: 0,
    guardianMap: {},
    recommendedWords: [],
  };
}

/**
 * P2 U2: Normalise a `data.postMega` record to the canonical shape. Returns
 * `null` for any garbage / array / missing input so `data.postMega === null`
 * is the unambiguous "never graduated" marker. Callers (client repository,
 * Worker twin) stop the sibling-record spread when the result is null so
 * the subject-state bundle stays compact.
 */
export function normalisePostMegaRecord(rawValue) {
  if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) return null;
  const unlockedAt = Number(rawValue.unlockedAt);
  const unlockedPublishedCoreCount = Number(rawValue.unlockedPublishedCoreCount);
  const unlockedContentReleaseId = typeof rawValue.unlockedContentReleaseId === 'string'
    ? rawValue.unlockedContentReleaseId
    : '';
  const unlockedBy = typeof rawValue.unlockedBy === 'string' ? rawValue.unlockedBy : '';
  if (!Number.isFinite(unlockedAt) || unlockedAt < 0) return null;
  if (!Number.isFinite(unlockedPublishedCoreCount) || unlockedPublishedCoreCount < 0) return null;
  if (!unlockedContentReleaseId) return null;
  return {
    unlockedAt: Math.floor(unlockedAt),
    unlockedContentReleaseId,
    unlockedPublishedCoreCount: Math.floor(unlockedPublishedCoreCount),
    unlockedBy: unlockedBy || 'all-core-stage-4',
  };
}

// Canonical secure-stage threshold shared by the service layer, the
// post-mastery read-model, and the Word Bank view-model. Prior to U2 this
// constant was duplicated as `GUARDIAN_SECURE_STAGE` in shared/spelling/service.js
// and `SECURE_STAGE` in src/subjects/spelling/read-model.js — consolidating
// here is a single source of truth so `isGuardianEligibleSlug` (below) and
// the read-model post-mastery counts cannot drift apart.
export const GUARDIAN_SECURE_STAGE = 4;

/**
 * Orphan sanitiser predicate (U2). A slug is a valid Guardian candidate iff:
 *   1. The current content bundle publishes it (wordBySlug has a record).
 *   2. The learner's progress stage meets `GUARDIAN_SECURE_STAGE` (Mega).
 *   3. The published record is in the `core` pool (extra-pool words never
 *      graduate — `allWordsMega` is a core-pool concept).
 *
 * The check is read-side only: orphan records stay in persisted storage so a
 * content rollback that re-introduces the slug finds its record intact.
 * The three filters above collapse an orphan entry out of the selector,
 * the post-mastery counts, and the Word Bank Guardian chips — keeping
 * selector, read-model, and view-model aligned on a single rule.
 *
 * Lives in `service-contract.js` (not `shared/spelling/service.js`) so the
 * Word Bank view-model can import the predicate without dragging the full
 * spelling service module (and its statutory-word-data imports) into the
 * client bundle. See `scripts/audit-client-bundle.mjs` for the bundle-shape
 * contract this boundary protects.
 *
 * Tolerant of null/garbage inputs: returns false rather than throwing so
 * a partially-corrupt persisted blob cannot crash the read path.
 *
 * @param {string} slug           Candidate slug.
 * @param {object|null} progressMap  slug -> legacy progress record.
 * @param {object|null} wordBySlug   slug -> word metadata.
 * @returns {boolean}
 */
export function isGuardianEligibleSlug(slug, progressMap, wordBySlug) {
  if (!slug || typeof slug !== 'string') return false;
  if (!wordBySlug || typeof wordBySlug !== 'object') return false;
  const word = wordBySlug[slug];
  if (!word || typeof word !== 'object') return false;
  if (coverageTierForWordValue(word) !== SPELLING_COVERAGE_TIER_VALUE.STATUTORY_CORE) return false;
  if (!progressMap || typeof progressMap !== 'object') return false;
  const record = progressMap[slug];
  const stage = Number(record?.stage);
  if (!Number.isFinite(stage) || stage < GUARDIAN_SECURE_STAGE) return false;
  return true;
}

/**
 * Shared mode predicates (U6). Three shapes:
 *   - `isPostMasteryMode` — requires graduation (gates shortcut-start).
 *   - `isMegaSafeMode` — cannot demote `progress.stage` / `dueDay` /
 *     `lastDay` / `lastResult`; includes trouble+practiceOnly.
 *   - `isSingleAttemptMegaSafeMode` — runs one submit per card, no retry.
 *
 * Contract: add a new post-Mega mode here and it applies everywhere that
 * gates shortcut-start.
 *
 * @param {string} mode
 * @returns {boolean}
 */
export function isPostMasteryMode(mode) {
  return mode === 'guardian' || mode === 'boss' || mode === 'pattern-quest';
}

/**
 * @param {string} mode
 * @param {object} [options]
 * @param {boolean} [options.practiceOnly]  Strict boolean; trouble+practiceOnly
 *   is Mega-safe (never demote).
 * @returns {boolean}
 */
export function isMegaSafeMode(mode, options = {}) {
  if (isPostMasteryMode(mode)) return true;
  if (mode !== 'trouble') return false;
  if (!options || typeof options !== 'object') return false;
  return options.practiceOnly === true;
}

/**
 * @param {string} mode
 * @returns {boolean}
 */
export function isSingleAttemptMegaSafeMode(mode) {
  return isPostMasteryMode(mode);
}
export const SPELLING_YEAR_FILTERS = Object.freeze(['core', 'y3-4', 'y5-6', 'secure-extension', 'extra']);
export const LEGACY_SPELLING_YEAR_FILTER_ALIASES = Object.freeze({
  all: 'core',
});
export const SPELLING_SESSION_TYPES = Object.freeze(['learning', 'test']);
export const SPELLING_SESSION_PHASES = Object.freeze(['question', 'retry', 'correction']);
export const SPELLING_FEEDBACK_KINDS = Object.freeze(['success', 'error', 'info', 'warn']);

export function createInitialSpellingState() {
  return {
    version: SPELLING_SERVICE_STATE_VERSION,
    phase: 'dashboard',
    session: null,
    feedback: null,
    summary: null,
    error: '',
    awaitingAdvance: false,
  };
}

export function defaultLearningStatus(needed = 1) {
  return {
    attempts: 0,
    successes: 0,
    needed,
    hadWrong: false,
    wrongAnswers: [],
    done: false,
    applied: false,
  };
}

export function normaliseMode(value, fallback = 'smart') {
  return SPELLING_MODES.includes(value) ? value : fallback;
}

export function normaliseYearFilter(value, fallback = 'core') {
  const candidate = typeof value === 'string' ? value : '';
  const aliased = LEGACY_SPELLING_YEAR_FILTER_ALIASES[candidate] || candidate;
  const normalisedFallback = SPELLING_YEAR_FILTERS.includes(fallback)
    ? fallback
    : LEGACY_SPELLING_YEAR_FILTER_ALIASES[fallback] || 'core';
  return SPELLING_YEAR_FILTERS.includes(aliased) ? aliased : normalisedFallback;
}

export function normaliseRoundLength(value, mode = 'smart') {
  if (mode === 'test') return 20;
  if (value === 'all') return 'all';
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? String(parsed) : '20';
}

export function normaliseBoolean(value, fallback = false) {
  if (value === true || value === false) return value;
  return fallback;
}

export function normaliseString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

export function normaliseOptionalString(value) {
  return typeof value === 'string' && value ? value : null;
}

export function normaliseNonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function normaliseTimestamp(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function normaliseStringArray(value, filterFn = null) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === 'string' && entry)
    .filter((entry) => (typeof filterFn === 'function' ? filterFn(entry) : true));
}

/**
 * U8: Storage-failure warning surface.
 *
 * Allowed reason strings for `feedback.persistenceWarning`. Kept as a frozen
 * allow-list so a renamed or typo'd reason never reaches the UI. The only
 * reason today is `storage-save-failed`; new entries land here before the
 * service + UI accept them.
 *
 * `SPELLING_PERSISTENCE_WARNING_REASONS` is the frozen array (iteration /
 * contains). `SPELLING_PERSISTENCE_WARNING_REASON` is a frozen record of
 * named constants so every call site can refer to the reason symbolically
 * rather than duplicating the literal — review-fix for the sev-60
 * maintainability finding.
 */
export const SPELLING_PERSISTENCE_WARNING_REASONS = Object.freeze(['storage-save-failed']);
export const SPELLING_PERSISTENCE_WARNING_REASON = Object.freeze({
  STORAGE_SAVE_FAILED: 'storage-save-failed',
});

/**
 * P2 U9: Normalise the durable `data.persistenceWarning` sibling. Unlike the
 * session-scoped `feedback.persistenceWarning` (which carries only `{ reason }`
 * for the current-round banner), the persisted record also carries `occurredAt`
 * (day number) and `acknowledged` (boolean) so the banner survives tab close
 * and dismisses once the learner clicks "I understand". Returns `null` for
 * garbage / missing input so `data.persistenceWarning === null` is the
 * unambiguous "no warning" marker for the sibling record writer.
 *
 * Shape: `{ reason, occurredAt, acknowledged }`.
 *  - `reason`: must be a member of `SPELLING_PERSISTENCE_WARNING_REASONS`.
 *  - `occurredAt`: non-negative integer day number (floor of Date.now() / DAY_MS).
 *  - `acknowledged`: boolean; defaults to false when missing.
 */
export function normaliseDurablePersistenceWarning(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const reason = typeof raw.reason === 'string' ? raw.reason : '';
  if (!SPELLING_PERSISTENCE_WARNING_REASONS.includes(reason)) return null;
  const occurredAtRaw = Number(raw.occurredAt);
  const occurredAt = Number.isFinite(occurredAtRaw) && occurredAtRaw >= 0
    ? Math.floor(occurredAtRaw)
    : 0;
  const acknowledged = raw.acknowledged === true;
  return { reason, occurredAt, acknowledged };
}

/**
 * U8 review fix: banner copy extracted so future wording tweaks live in one
 * place. The wording was updated from the original "Progress could not be
 * saved on this device. Export or free storage." to the more accurate
 * partial-write message below. On a Guardian submit where the progress
 * write succeeded but the guardian write failed (or vice versa), the
 * learner's answer WAS counted in-memory for this round, but the storage
 * state is partially stale — they may see the same word re-appear after a
 * reload. The copy acknowledges that accurately.
 */
export const SPELLING_PERSISTENCE_WARNING_COPY = Object.freeze({
  STORAGE_SAVE_FAILED: 'We could not save your progress on this device. Your answer counted for this round, but you may see this word again after a reload. Free up storage or export your progress.',
});

/**
 * P2 U9: copy for the durable persistence-warning banner. The wording is
 * deliberately more compact than `SPELLING_PERSISTENCE_WARNING_COPY` because
 * the durable banner may surface on the setup scene (learner arrives fresh,
 * no active round) — the "Your answer counted for this round" phrasing from
 * U8 does not apply there. The U9 copy centres on what the learner needs to
 * do: export data or free up storage.
 *
 * Reviewer-feedback fix (PR #279 LOW): keys are indexed by the reason enum
 * VALUE (kebab-case, e.g. `'storage-save-failed'`) so the UI can do a direct
 * `COPY[reason]` lookup and adding a future reason is a one-line change in
 * `SPELLING_PERSISTENCE_WARNING_REASONS` + here. Legacy UPPER_SNAKE key is
 * kept as an alias so any downstream consumer that relied on the symbolic
 * name keeps working.
 */
export const SPELLING_DURABLE_PERSISTENCE_WARNING_COPY = Object.freeze({
  'storage-save-failed': 'Your progress could not be saved on this device. Export your data or free up storage.',
  STORAGE_SAVE_FAILED: 'Your progress could not be saved on this device. Export your data or free up storage.',
});

function normalisePersistenceWarning(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const reason = typeof raw.reason === 'string' ? raw.reason : '';
  if (!SPELLING_PERSISTENCE_WARNING_REASONS.includes(reason)) return null;
  return { reason };
}

export function normaliseFeedback(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const persistenceWarning = normalisePersistenceWarning(value.persistenceWarning);
  const feedback = {
    kind: SPELLING_FEEDBACK_KINDS.includes(value.kind) ? value.kind : 'info',
    headline: normaliseString(value.headline),
    answer: normaliseString(value.answer),
    attemptedAnswer: normaliseString(value.attemptedAnswer).trim().slice(0, 80),
    body: normaliseString(value.body),
    footer: normaliseString(value.footer),
    familyWords: normaliseStringArray(value.familyWords),
  };

  if (
    !feedback.headline
    && !feedback.answer
    && !feedback.attemptedAnswer
    && !feedback.body
    && !feedback.footer
    && !feedback.familyWords.length
    && !persistenceWarning
  ) {
    return null;
  }

  // U8: attach persistenceWarning only when present so the happy-path feedback
  // shape stays byte-identical for downstream consumers that JSON-serialise or
  // structural-compare the feedback object.
  if (persistenceWarning) feedback.persistenceWarning = persistenceWarning;

  return feedback;
}

export function normaliseSummaryCard(card) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) return null;
  const label = normaliseString(card.label);
  const sub = normaliseString(card.sub);
  const value = typeof card.value === 'number' || typeof card.value === 'string'
    ? card.value
    : '';
  if (!label && value === '' && !sub) return null;
  return { label, value, sub };
}

/* Derive the round-level totals the UI needs for the summary scene from the
   engine's card list. The legacy engine emits different card shapes for the
   learning and test flows — learning cards expose the total on the first
   card ("Words in round" / "Practice words") while test cards encode it as
   "correct/total" on the "Score" card. Keeping the derivation here means
   every UI that reads a summary gets the same normalised shape without the
   legacy engine changing. */
function deriveSummaryTotals(mode, cards, mistakes) {
  const firstValue = cards.length ? cards[0].value : '';
  let totalWords = 0;
  let correct = 0;

  // Boss (U10) and SATs Test share the same testSummary card shape
  // (`Score: 7/10`, `Accuracy: 70%`, `Correct: 7`, `Needs more work: 3`). The
  // score-card "N/M" parse therefore applies to both; without adding 'boss'
  // here the else-branch would fall back to `firstValue = '7/10'` →
  // Number.parseInt → 7, which would lead to `totalWords = 7` and
  // `correct = 7 - mistakes.length = 4`. That would surface as a Boss summary
  // claiming only 7 words landed when 10 were played.
  if (mode === 'test' || mode === 'boss' || mode === 'pattern-quest') {
    const scoreCard = cards.find((card) => card.label === 'Score');
    if (scoreCard && typeof scoreCard.value === 'string') {
      const match = /^(\d+)\s*\/\s*(\d+)$/.exec(scoreCard.value);
      if (match) {
        correct = Number(match[1]);
        totalWords = Number(match[2]);
      }
    }
    if (!totalWords) {
      const correctCard = cards.find((card) => card.label === 'Correct');
      if (correctCard && typeof correctCard.value === 'number') {
        correct = correctCard.value;
      }
      totalWords = correct + mistakes.length;
    }
  } else {
    if (typeof firstValue === 'number') {
      totalWords = firstValue;
    } else {
      const parsed = Number.parseInt(String(firstValue ?? ''), 10);
      totalWords = Number.isFinite(parsed) ? parsed : 0;
    }
    correct = Math.max(0, totalWords - mistakes.length);
  }

  totalWords = Math.max(0, totalWords);
  correct = Math.max(0, Math.min(totalWords, correct));
  const accuracy = totalWords > 0 ? Math.round((correct / totalWords) * 100) : null;
  return { totalWords, correct, accuracy };
}

export function normaliseSummary(value, isKnownSlug) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const cards = Array.isArray(value.cards)
    ? value.cards.map(normaliseSummaryCard).filter(Boolean)
    : [];
  const mistakes = Array.isArray(value.mistakes)
    ? value.mistakes
        .map((word) => {
          if (!word || typeof word !== 'object' || Array.isArray(word)) return null;
          if (!isKnownSlug(word.slug)) return null;
          return {
            slug: word.slug,
            word: normaliseString(word.word),
            family: normaliseString(word.family),
            year: normaliseString(word.year),
            yearLabel: normaliseString(word.yearLabel),
            familyWords: normaliseStringArray(word.familyWords),
          };
        })
        .filter(Boolean)
    : [];
  const mode = normaliseMode(value.mode, 'smart');
  const derived = deriveSummaryTotals(mode, cards, mistakes);
  const providedTotal = Number(value.totalWords);
  const providedCorrect = Number(value.correct);
  const providedAccuracy = value.accuracy;
  const totalWords = Number.isInteger(providedTotal) && providedTotal >= 0
    ? providedTotal
    : derived.totalWords;
  const correct = Number.isInteger(providedCorrect) && providedCorrect >= 0
    ? Math.min(totalWords, providedCorrect)
    : derived.correct;
  const accuracy = typeof providedAccuracy === 'number' && Number.isFinite(providedAccuracy)
    ? providedAccuracy
    : derived.accuracy;
  return {
    mode,
    label: normaliseString(value.label, 'Spelling round'),
    message: normaliseString(value.message, 'Round complete.'),
    cards,
    mistakes,
    elapsedMs: normaliseNonNegativeInteger(value.elapsedMs, 0),
    totalWords,
    correct,
    accuracy,
    // Hero Mode P3: server-owned trust anchor for completion claims.
    heroContext: value.heroContext && typeof value.heroContext === 'object' && !Array.isArray(value.heroContext)
      ? value.heroContext
      : null,
  };
}

export function normaliseStats(value) {
  const stats = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    total: normaliseNonNegativeInteger(stats.total, 0),
    secure: normaliseNonNegativeInteger(stats.secure, 0),
    due: normaliseNonNegativeInteger(stats.due, 0),
    fresh: normaliseNonNegativeInteger(stats.fresh, 0),
    trouble: normaliseNonNegativeInteger(stats.trouble, 0),
    attempts: normaliseNonNegativeInteger(stats.attempts, 0),
    correct: normaliseNonNegativeInteger(stats.correct, 0),
    accuracy: typeof stats.accuracy === 'number' || stats.accuracy === null
      ? stats.accuracy
      : null,
  };
}

export function cloneSerialisable(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function clampReviewLevel(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  if (parsed < 0) return 0;
  if (parsed > GUARDIAN_MAX_REVIEW_LEVEL) return GUARDIAN_MAX_REVIEW_LEVEL;
  return Math.floor(parsed);
}

function normaliseNullableDay(value) {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

function normaliseDay(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

/**
 * Normalise a per-word guardian record to the canonical shape. Garbage
 * or missing input yields a safe default record. The default `nextDueDay`
 * must be supplied by the caller (usually `todayDay()`), because this
 * module must stay pure — it cannot call `Date.now()` directly without
 * breaking deterministic tests in shared/spelling/service.js.
 */
export function normaliseGuardianRecord(rawValue, todayDay = 0) {
  const raw = rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue) ? rawValue : {};
  const safeToday = Number.isFinite(Number(todayDay)) && Number(todayDay) >= 0 ? Math.floor(Number(todayDay)) : 0;
  return {
    reviewLevel: clampReviewLevel(raw.reviewLevel),
    lastReviewedDay: normaliseNullableDay(raw.lastReviewedDay),
    nextDueDay: normaliseDay(raw.nextDueDay, safeToday),
    correctStreak: normaliseNonNegativeInteger(raw.correctStreak, 0),
    lapses: normaliseNonNegativeInteger(raw.lapses, 0),
    renewals: normaliseNonNegativeInteger(raw.renewals, 0),
    wobbling: normaliseBoolean(raw.wobbling, false),
  };
}

/**
 * Normalise a slug -> guardian record map. Drops entries with empty/invalid
 * slugs or with values that cannot be objects. Preserves valid slugs, with
 * each record individually normalised.
 */
export function normaliseGuardianMap(rawValue, todayDay = 0) {
  const raw = rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue) ? rawValue : {};
  const output = {};
  for (const [slug, entry] of Object.entries(raw)) {
    if (!slug || typeof slug !== 'string') continue;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    output[slug] = normaliseGuardianRecord(entry, todayDay);
  }
  return output;
}

/**
 * P2 U11: Normalise a single pattern-wobble record. The canonical shape is
 * `{ wobbling: boolean, wobbledAt: integerDay, patternId: string }`. Garbage
 * inputs collapse to `null` rather than throwing so a partially-corrupt
 * persisted blob cannot crash the read path.
 *
 * @param {*} rawValue
 * @returns {{wobbling: boolean, wobbledAt: number, patternId: string}|null}
 */
export function normalisePatternWobbleRecord(rawValue) {
  if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) return null;
  const wobbling = rawValue.wobbling === true;
  const wobbledAt = Number(rawValue.wobbledAt);
  const patternId = typeof rawValue.patternId === 'string' ? rawValue.patternId : '';
  if (!patternId) return null;
  if (!Number.isFinite(wobbledAt) || wobbledAt < 0) return null;
  return {
    wobbling,
    wobbledAt: Math.floor(wobbledAt),
    patternId,
  };
}

/**
 * P2 U11: Normalise `data.pattern`. Shape:
 *   { wobbling: { [slug]: { wobbling, wobbledAt, patternId } } }
 * This is the parallel-sibling map to `data.guardian.wobbling` — Pattern
 * Quest wrong answers write here, never to `data.progress` / `data.guardian`.
 *
 * Garbage input collapses to `null` so pre-U11 persisted bundles (no
 * `data.pattern` sibling) skip the field entirely when normalising.
 *
 * @param {*} rawValue
 * @returns {{wobbling: Record<string, object>}|null}
 */
export function normalisePatternMap(rawValue) {
  if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) return null;
  const rawWobbling = rawValue.wobbling && typeof rawValue.wobbling === 'object' && !Array.isArray(rawValue.wobbling)
    ? rawValue.wobbling
    : {};
  const wobbling = {};
  for (const [slug, entry] of Object.entries(rawWobbling)) {
    if (!slug || typeof slug !== 'string') continue;
    const record = normalisePatternWobbleRecord(entry);
    if (record) wobbling[slug] = record;
  }
  return { wobbling };
}
