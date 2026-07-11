import { createLegacySpellingEngine } from './legacy-engine.js';
import {
  SPELLING_MASTERY_MILESTONES,
  createSpellingBossCompletedEvent,
  createSpellingGuardianMissionCompletedEvent,
  createSpellingGuardianRecoveredEvent,
  createSpellingGuardianRenewedEvent,
  createSpellingGuardianWobbledEvent,
  createSpellingMasteryMilestoneEvent,
  createSpellingPatternQuestCompletedEvent,
  createSpellingPostMegaUnlockedEvent,
  createSpellingRetryClearedEvent,
  createSpellingSessionCompletedEvent,
  createSpellingWordSecuredEvent,
} from './events.js';
import {
  normaliseBufferedGeminiVoice,
  normaliseTtsProvider,
} from './audio-preferences.js';
import {
  BOSS_DEFAULT_ROUND_LENGTH,
  BOSS_MAX_ROUND_LENGTH,
  BOSS_MIN_ROUND_LENGTH,
  GUARDIAN_DEFAULT_ROUND_LENGTH,
  GUARDIAN_INTERVALS,
  GUARDIAN_MAX_REVIEW_LEVEL,
  GUARDIAN_MAX_ROUND_LENGTH,
  GUARDIAN_MIN_ROUND_LENGTH,
  GUARDIAN_MISSION_STATES,
  GUARDIAN_SECURE_STAGE,
  PATTERN_QUEST_ROUND_LENGTH,
  SPELLING_CONTENT_RELEASE_ID,
  SPELLING_PATTERNS,
  aggregateAchievementState,
  cloneSerialisable,
  computeLaunchedPatternIds,
  coverageTierForWord,
  createInitialSpellingState,
  defaultLearningStatus,
  evaluateAchievements,
  isEnrichmentExtraWord,
  isGuardianEligibleSlug,
  isPatternEligibleSlug,
  isSecureExtensionWord,
  isStatutoryCoreWord,
  normaliseAchievementsMap,
  normaliseBoolean,
  normaliseDurablePersistenceWarning,
  normaliseFeedback,
  normaliseGuardianMap,
  normaliseGuardianRecord,
  normaliseMode,
  normaliseNonNegativeInteger,
  normaliseOptionalString,
  normalisePatternMap,
  normalisePostMegaRecord,
  normaliseRoundLength,
  normaliseStats,
  normaliseString,
  normaliseStringArray,
  normaliseSummary,
  normaliseTimestamp,
  normaliseYearFilter,
  SPELLING_PERSISTENCE_WARNING_REASON,
  SPELLING_ROOT_PHASES,
  SPELLING_SERVICE_STATE_VERSION,
  SPELLING_SESSION_PHASES,
  SPELLING_SESSION_TYPES,
} from './service-contract.js';

const DEFAULT_WORDS = Object.freeze([]);
const DEFAULT_WORD_BY_SLUG = Object.freeze({});
const DIAGNOSTIC_CODES = Object.freeze({
  PERSISTENCE_WARNING_WRITE_FAILED: 'spelling.persistence-warning.write-failed-after-retry',
  PERSISTENCE_WARNING_ACKNOWLEDGE_FAILED: 'spelling.persistence-warning.acknowledge-failed-after-retry',
});

// Re-export `isGuardianEligibleSlug` at the service layer so callers that
// already import other helpers from `shared/spelling/service.js` do not
// need to learn a new module boundary. The canonical definition lives in
// `service-contract.js` to keep the Word Bank view-model's client bundle
// free of the full word dataset (see audit-client-bundle.mjs).
export { isGuardianEligibleSlug };

/**
 * Pure dashboard state machine (U1). Derives the Guardian mission state from
 * aggregate counts so the Setup scene, the module shortcut gate, and any
 * downstream consumer can branch their copy on a single labelled value.
 *
 * Contract:
 *   - `allWordsMega` false → 'locked' (dashboard renders legacy setup).
 *   - Empty guardian map + unguarded Mega slugs AND the combined pool can
 *     fill a minimum-length round (`>= GUARDIAN_MIN_ROUND_LENGTH`) →
 *     'first-patrol'. Below that threshold `selectGuardianWords` would
 *     produce a short round, so we collapse to 'rested' to keep Begin
 *     disabled rather than ship a 1-4 word Guardian.
 *   - Any eligible wobbling-due entry → 'wobbling' (urgent recovery check).
 *     Wobbling always dominates 'due' so a single recovery drill rides even
 *     under the round-length minimum (the selector tops up from non-due
 *     guardians if needed).
 *   - Any eligible due entry → 'due' (the normal daily patrol). Same
 *     top-up reasoning as wobbling — a short due round top-ups from the
 *     non-due bucket.
 *   - No due entries, but a round CAN be produced via top-up or lazy-create
 *     AND the combined pool hits `GUARDIAN_MIN_ROUND_LENGTH`, AND policy
 *     allows optional patrol → 'optional-patrol'.
 *   - Everything guarded, nothing due, no top-up policy (or pool too small)
 *     → 'rested' (Begin disabled, copy shows next check in N days).
 *
 * Short-round invariant (adversarial sev 60/50): `selectGuardianWords` walks
 * four buckets (wobbling-due, non-wobbling-due, lazy-create, top-up) and
 * stops at `GUARDIAN_MIN_ROUND_LENGTH`. If the dashboard advertises
 * 'first-patrol' or 'optional-patrol' without the combined pool reaching
 * that threshold, the learner would tap Begin and receive a 1-4 word round
 * — below the Guardian minimum. This helper therefore gates both states on
 * `unguardedMegaCount + entries.length >= GUARDIAN_MIN_ROUND_LENGTH`. The
 * 'wobbling' and 'due' states skip this check because a single wobbling or
 * due entry plus the selector's own top-up fallback always fills the round.
 *
 * The helper is tolerant of null/garbage inputs: if `ctx` is falsy or
 * `allWordsMega` is not strictly true, the result is 'locked'. This lets
 * the remote-sync client-read-models stub default to 'locked' without a
 * special-case code path.
 *
 * @param {object} ctx
 * @param {boolean} ctx.allWordsMega
 * @param {Array<{slug: string, wobbling: boolean, nextDueDay: number}>} ctx.eligibleGuardianEntries
 *   Guardian records whose slugs have already been run through
 *   `isGuardianEligibleSlug` — orphan slugs must be excluded by the caller
 *   before passing in. The helper trusts this contract rather than
 *   re-filtering (keeps the helper decoupled from `wordBySlug` / `progressMap`).
 * @param {number} ctx.unguardedMegaCount
 *   Number of core-pool Mega slugs that have no entry in the guardian map.
 *   Zero when every Mega word is already being tracked.
 * @param {number} ctx.todayDay   Integer day (Math.floor(ts/DAY_MS)).
 * @param {object} [ctx.policy]
 * @param {boolean} [ctx.policy.allowOptionalPatrol=true]  If false, the
 *   'optional-patrol' branch collapses into 'rested' so the Begin button
 *   stays disabled when the only available round is non-urgent.
 * @returns {string}  One of `GUARDIAN_MISSION_STATES`.
 */
export function computeGuardianMissionState(ctx) {
  const resolved = resolveGuardianMissionState(ctx);
  // Runtime sanity check — if the state-machine above ever returns an
  // unknown label (e.g. a typo like 'fist-patrol'), refuse to leak the
  // garbage into UI copy. Throwing here is loud on purpose: the dashboard
  // branches on this value and would otherwise render the defensive fallback
  // silently, hiding the bug.
  if (!GUARDIAN_MISSION_STATES.includes(resolved)) {
    throw new Error(`computeGuardianMissionState: unknown state "${resolved}"`);
  }
  return resolved;
}

function resolveGuardianMissionState(ctx) {
  if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) return 'locked';
  if (ctx.allWordsMega !== true) return 'locked';

  const todayDay = Number.isFinite(Number(ctx.todayDay)) ? Math.floor(Number(ctx.todayDay)) : 0;
  const entries = Array.isArray(ctx.eligibleGuardianEntries) ? ctx.eligibleGuardianEntries : [];
  const unguardedMegaCount = Number.isFinite(Number(ctx.unguardedMegaCount))
    ? Math.max(0, Math.floor(Number(ctx.unguardedMegaCount)))
    : 0;
  const policy = ctx.policy && typeof ctx.policy === 'object' && !Array.isArray(ctx.policy) ? ctx.policy : {};
  const allowOptionalPatrol = policy.allowOptionalPatrol !== false; // default true

  // Combined-pool size fed to the selector. `selectGuardianWords` walks
  // wobbling-due → non-wobbling-due → lazy-create → top-up and stops at
  // GUARDIAN_MIN_ROUND_LENGTH (5). The dashboard therefore must not offer
  // 'first-patrol' or 'optional-patrol' unless the pool reaches that
  // minimum — otherwise the learner would click Begin and receive a short
  // round with fewer than 5 words, violating the Guardian round invariant.
  const combinedPoolSize = unguardedMegaCount + entries.length;
  const canFillRound = combinedPoolSize >= GUARDIAN_MIN_ROUND_LENGTH;

  // Fresh graduate: has never run Guardian AND has Mega words to patrol.
  // Requires enough combined pool to fill the round; otherwise the learner
  // is effectively 'rested' until more words graduate.
  if (entries.length === 0 && unguardedMegaCount > 0) {
    if (canFillRound) return 'first-patrol';
    return 'rested';
  }

  const wobblingDue = entries.some((entry) => entry?.wobbling === true && Number(entry?.nextDueDay) <= todayDay);
  if (wobblingDue) return 'wobbling';

  const anyDue = entries.some((entry) => Number(entry?.nextDueDay) <= todayDay);
  if (anyDue) return 'due';

  // Nothing due. `optional-patrol` is only offered when a round CAN be
  // produced — either by lazy-creating from an unguarded Mega slug OR by
  // topping up from a non-due guardian (selector's bucket 4). If neither is
  // possible, OR the caller explicitly disabled the optional path, OR the
  // combined pool is below the minimum round length, we are 'rested'.
  const canProduceTopUpRound = unguardedMegaCount > 0 || entries.length > 0;
  if (allowOptionalPatrol && canProduceTopUpRound && canFillRound) return 'optional-patrol';
  return 'rested';
}

/**
 * Pure aggregate helper. Walks `guardianMap` once to produce the filtered
 * eligible-entries list and the decomposed due-count scalars; walks
 * `progressMap` once to produce `unguardedMegaCount`. Returning all seven
 * fields from a single helper means `getPostMasteryState` (service) and
 * `getSpellingPostMasteryState` (read-model) cannot drift — they consume
 * the same derivation.
 *
 * The helper trusts that `isGuardianEligibleSlug` is the single orphan
 * predicate (U2 contract). Callers pass in the ambient `wordBySlug`
 * (runtime content) and `progressMap` (learner state) so the predicate can
 * filter orphan records without the helper itself needing to import word
 * data.
 *
 * Invariant guaranteed by the implementation:
 *   `wobblingDueCount + nonWobblingDueCount === guardianDueCount`
 *
 * @param {object} params
 * @param {object} params.guardianMap   slug -> normalised guardian record
 * @param {object} params.progressMap   slug -> legacy progress record
 * @param {object} params.wordBySlug    slug -> published word metadata
 * @param {number} params.todayDay      integer day (Math.floor(ts/DAY_MS))
 * @returns {{
 *   eligibleGuardianEntries: Array<{slug: string, wobbling: boolean, nextDueDay: number}>,
 *   guardianDueCount: number,
 *   wobblingDueCount: number,
 *   nonWobblingDueCount: number,
 *   wobblingCount: number,
 *   nextGuardianDueDay: number|null,
 *   unguardedMegaCount: number,
 * }}
 */
export function deriveGuardianAggregates({
  guardianMap = {},
  progressMap = {},
  wordBySlug = {},
  todayDay = 0,
} = {}) {
  const safeGuardianMap = guardianMap && typeof guardianMap === 'object' && !Array.isArray(guardianMap)
    ? guardianMap
    : {};
  const safeProgressMap = progressMap && typeof progressMap === 'object' && !Array.isArray(progressMap)
    ? progressMap
    : {};
  const safeWordBySlug = wordBySlug && typeof wordBySlug === 'object' && !Array.isArray(wordBySlug)
    ? wordBySlug
    : {};
  const safeToday = Number.isFinite(Number(todayDay)) ? Math.floor(Number(todayDay)) : 0;

  const eligibleGuardianEntries = [];
  let guardianDueCount = 0;
  let wobblingCount = 0;
  let wobblingDueCount = 0;
  let nonWobblingDueCount = 0;
  let nextGuardianDueDay = null;

  for (const [slug, record] of Object.entries(safeGuardianMap)) {
    if (!record) continue;
    if (!isGuardianEligibleSlug(slug, safeProgressMap, safeWordBySlug)) continue;
    const isWobbling = record.wobbling === true;
    const entryDueDay = Number(record.nextDueDay);
    eligibleGuardianEntries.push({
      slug,
      wobbling: isWobbling,
      nextDueDay: entryDueDay,
    });
    const isDueToday = entryDueDay <= safeToday;
    if (isDueToday) {
      guardianDueCount += 1;
      if (isWobbling) {
        wobblingDueCount += 1;
      } else {
        nonWobblingDueCount += 1;
      }
    }
    if (isWobbling) wobblingCount += 1;
    if (nextGuardianDueDay === null || entryDueDay < nextGuardianDueDay) {
      nextGuardianDueDay = entryDueDay;
    }
  }

  let unguardedMegaCount = 0;
  for (const [slug] of Object.entries(safeProgressMap)) {
    if (!isGuardianEligibleSlug(slug, safeProgressMap, safeWordBySlug)) continue;
    if (Object.prototype.hasOwnProperty.call(safeGuardianMap, slug)) continue;
    unguardedMegaCount += 1;
  }

  return {
    eligibleGuardianEntries,
    guardianDueCount,
    wobblingDueCount,
    nonWobblingDueCount,
    wobblingCount,
    nextGuardianDueDay,
    unguardedMegaCount,
  };
}

const PREF_KEY = 'ks2-platform-v2.spelling-prefs';
const GUARDIAN_PROGRESS_KEY_PREFIX = 'ks2-spell-guardian-';
const PROGRESS_KEY_PREFIX = 'ks2-spell-progress-';
// P2 U2: sticky-graduation sibling key. Stored under the same per-learner
// suffix convention as the other three siblings so `parseStorageKey` in the
// repository can route the write through the subject-state bundle.
const POST_MEGA_KEY_PREFIX = 'ks2-spell-post-mega-';
// P2 U11: Pattern Quest wobble sibling key. Parallel to the Guardian map —
// distinct prefix so the storage proxy can route writes to `data.pattern`.
const PATTERN_KEY_PREFIX = 'ks2-spell-pattern-';
// P2 U9: durable persistence-warning sibling key. Must stay byte-identical
// with PERSISTENCE_WARNING_STORAGE_PREFIX in src/subjects/spelling/repository.js
// and worker/src/subjects/spelling/engine.js — all three route reads/writes
// under this key through the `data.persistenceWarning` sibling of the bundle.
const PERSISTENCE_WARNING_KEY_PREFIX = 'ks2-spell-persistence-warning-';
// P2 U12: achievements sibling key. Mirrors ACHIEVEMENTS_STORAGE_PREFIX in
// src/subjects/spelling/repository.js and worker/src/subjects/spelling/engine.js
// — all three route reads/writes under this key through `data.achievements`.
const ACHIEVEMENTS_KEY_PREFIX = 'ks2-spell-achievements-';
const DAY_MS = 24 * 60 * 60 * 1000;

function createNoopStorage() {
  return {
    getItem() {
      return null;
    },
    setItem() {},
    removeItem() {},
  };
}

function prefsKey(learnerId) {
  return `${PREF_KEY}.${learnerId || 'default'}`;
}

function guardianMapKey(learnerId) {
  return `${GUARDIAN_PROGRESS_KEY_PREFIX}${learnerId || 'default'}`;
}

function progressMapKey(learnerId) {
  return `${PROGRESS_KEY_PREFIX}${learnerId || 'default'}`;
}

// P2 U2: storage key for the sticky-graduation record. The client and Worker
// storage proxies route reads/writes under this prefix through the
// `data.postMega` sibling of the subject-state bundle.
function postMegaKey(learnerId) {
  return `${POST_MEGA_KEY_PREFIX}${learnerId || 'default'}`;
}

// P2 U11: storage key for the Pattern Quest wobble record.
function patternKey(learnerId) {
  return `${PATTERN_KEY_PREFIX}${learnerId || 'default'}`;
}

// P2 U9: storage key for the durable persistence-warning record. The client
// and Worker storage proxies route reads/writes under this prefix through the
// `data.persistenceWarning` sibling of the subject-state bundle.
function persistenceWarningKey(learnerId) {
  return `${PERSISTENCE_WARNING_KEY_PREFIX}${learnerId || 'default'}`;
}

// P2 U12: storage key for the achievements sibling record. The client and
// Worker storage proxies route reads/writes under this prefix through the
// `data.achievements` sibling of the subject-state bundle.
function achievementsKey(learnerId) {
  return `${ACHIEVEMENTS_KEY_PREFIX}${learnerId || 'default'}`;
}

function intervalForLevel(level) {
  const index = Math.max(0, Math.min(GUARDIAN_MAX_REVIEW_LEVEL, Math.floor(Number(level) || 0)));
  return GUARDIAN_INTERVALS[index];
}

/**
 * Pure scheduler helpers — advance* functions never mutate their input record,
 * they return a new record. Day arithmetic is integer-only (Math.floor(ts/DAY_MS))
 * per the plan; no ISO strings anywhere in the guardian path.
 */

export function advanceGuardianOnCorrect(record, todayDay) {
  const safeToday = Number.isFinite(Number(todayDay)) ? Math.floor(Number(todayDay)) : 0;
  const source = normaliseGuardianRecord(record, safeToday);

  if (source.wobbling) {
    // Recovery path — clear wobbling, bump renewals, preserve reviewLevel.
    // Schedule resumes using the existing reviewLevel (does NOT advance).
    // The interval is indexed by the current (preserved) reviewLevel so the
    // learner picks up their spaced-practice ladder rather than starting over.
    return {
      ...source,
      wobbling: false,
      renewals: source.renewals + 1,
      correctStreak: source.correctStreak + 1,
      lastReviewedDay: safeToday,
      nextDueDay: safeToday + intervalForLevel(source.reviewLevel),
    };
  }

  // Non-wobbling success — bump reviewLevel (capped) and correctStreak. Interval
  // is indexed by the CURRENT (pre-advance) reviewLevel so the first success at
  // level 0 schedules +3 days; at cap (level 5) it stays +90.
  const nextLevel = Math.min(GUARDIAN_MAX_REVIEW_LEVEL, source.reviewLevel + 1);
  return {
    ...source,
    reviewLevel: nextLevel,
    correctStreak: source.correctStreak + 1,
    lastReviewedDay: safeToday,
    nextDueDay: safeToday + intervalForLevel(source.reviewLevel),
  };
}

export function advanceGuardianOnWrong(record, todayDay) {
  const safeToday = Number.isFinite(Number(todayDay)) ? Math.floor(Number(todayDay)) : 0;
  const source = normaliseGuardianRecord(record, safeToday);
  return {
    ...source,
    wobbling: true,
    lapses: source.lapses + 1,
    correctStreak: 0,
    lastReviewedDay: safeToday,
    nextDueDay: safeToday + 1,
  };
}

export function ensureGuardianRecord(guardianMap, slug, todayDay) {
  if (!slug || typeof slug !== 'string') return null;
  const map = guardianMap && typeof guardianMap === 'object' && !Array.isArray(guardianMap) ? guardianMap : {};
  if (Object.prototype.hasOwnProperty.call(map, slug) && map[slug]) {
    return map[slug];
  }
  const safeToday = Number.isFinite(Number(todayDay)) ? Math.floor(Number(todayDay)) : 0;
  const fresh = normaliseGuardianRecord({}, safeToday);
  map[slug] = fresh;
  return fresh;
}

function clampSelectionLength(length) {
  const parsed = Number(length);
  const base = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : GUARDIAN_DEFAULT_ROUND_LENGTH;
  if (base < GUARDIAN_MIN_ROUND_LENGTH) return GUARDIAN_MIN_ROUND_LENGTH;
  if (base > GUARDIAN_MAX_ROUND_LENGTH) return GUARDIAN_MAX_ROUND_LENGTH;
  return base;
}

// Boss Dictation round-length clamp (U9). Defaults to
// BOSS_DEFAULT_ROUND_LENGTH (10) when the caller omits a length or passes a
// non-finite value. Otherwise clamped into [BOSS_MIN_ROUND_LENGTH,
// BOSS_MAX_ROUND_LENGTH] = [8, 12]. The clamp lives here so both
// `selectBossWords` and `startSession({ mode: 'boss' })` agree on the bounds
// without duplicating the logic.
function clampBossRoundLength(length) {
  const parsed = Number(length);
  const base = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : BOSS_DEFAULT_ROUND_LENGTH;
  if (base < BOSS_MIN_ROUND_LENGTH) return BOSS_MIN_ROUND_LENGTH;
  if (base > BOSS_MAX_ROUND_LENGTH) return BOSS_MAX_ROUND_LENGTH;
  return base;
}

function compareByDueDayThenSlug(a, b) {
  if (a.nextDueDay !== b.nextDueDay) return a.nextDueDay - b.nextDueDay;
  if (a.slug < b.slug) return -1;
  if (a.slug > b.slug) return 1;
  return 0;
}

function compareByLastReviewedThenSlug(a, b) {
  const aLast = a.lastReviewedDay != null ? a.lastReviewedDay : -1;
  const bLast = b.lastReviewedDay != null ? b.lastReviewedDay : -1;
  if (aLast !== bLast) return aLast - bLast;
  if (a.slug < b.slug) return -1;
  if (a.slug > b.slug) return 1;
  return 0;
}

function deterministicShuffle(items, random) {
  const output = items.slice();
  for (let i = output.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const tmp = output[i];
    output[i] = output[j];
    output[j] = tmp;
  }
  return output;
}

/**
 * Pure selection function. Picks 5-8 slugs (clamped by length input) from the
 * learner's guardian map + progress map, prioritising wobbling-due → due →
 * lazy-create sample → top-up of non-due guardians.
 *
 * Every bucket runs its candidates through `isGuardianEligibleSlug` so an
 * orphan guardian record (content hot-swap removed the slug from the current
 * bundle, or the learner's stage rolled back below Mega, or the slug was
 * demoted from core to extra) never escapes into the session round.
 *
 * @param {object} params
 * @param {object} params.guardianMap  slug -> normalised guardian record
 * @param {object} params.progressMap  slug -> legacy progress record
 * @param {object} params.wordBySlug   slug -> word metadata (spellingPool, etc.)
 * @param {number} params.todayDay     integer day (Math.floor(ts/DAY_MS))
 * @param {number} params.length       desired round length (clamped 5..8)
 * @param {Function} params.random     injected random; used for lazy-create shuffle
 * @returns {string[]} selected slugs (array of strings)
 */
export function selectGuardianWords({
  guardianMap = {},
  progressMap = {},
  wordBySlug = {},
  todayDay = 0,
  length = GUARDIAN_DEFAULT_ROUND_LENGTH,
  random,
} = {}) {
  const target = clampSelectionLength(length);
  const safeToday = Number.isFinite(Number(todayDay)) ? Math.floor(Number(todayDay)) : 0;
  const guardianEntries = Object.entries(guardianMap || {}).map(([slug, record]) => ({
    slug,
    ...record,
  }));

  // U2: orphan sanitiser — applied to every due bucket so a guardianMap
  // entry that the current content bundle no longer publishes never escapes.
  const wobblingDue = guardianEntries
    .filter((entry) => entry.wobbling === true && entry.nextDueDay <= safeToday)
    .filter((entry) => isGuardianEligibleSlug(entry.slug, progressMap, wordBySlug))
    .sort(compareByDueDayThenSlug);
  const nonWobblingDue = guardianEntries
    .filter((entry) => entry.wobbling !== true && entry.nextDueDay <= safeToday)
    .filter((entry) => isGuardianEligibleSlug(entry.slug, progressMap, wordBySlug))
    .sort(compareByDueDayThenSlug);

  const selected = [];
  const selectedSet = new Set();

  function push(slug) {
    if (!slug || typeof slug !== 'string') return;
    if (selectedSet.has(slug)) return;
    if (selected.length >= target) return;
    selected.push(slug);
    selectedSet.add(slug);
  }

  wobblingDue.forEach((entry) => push(entry.slug));
  if (selected.length < target) nonWobblingDue.forEach((entry) => push(entry.slug));

  // Lazy-create candidates: mega words (stage >= 4) that are NOT yet in the
  // guardian map at all. `isGuardianEligibleSlug` generalises the prior
  // unknown-slug guard by also rejecting extra-pool words — a content
  // demotion from core to extra must not silently graduate into Guardian.
  if (selected.length < target) {
    const lazyCandidates = [];
    for (const [slug] of Object.entries(progressMap || {})) {
      if (Object.prototype.hasOwnProperty.call(guardianMap || {}, slug)) continue;
      if (!isGuardianEligibleSlug(slug, progressMap, wordBySlug)) continue;
      lazyCandidates.push(slug);
    }
    // Alphabetical baseline makes the shuffle deterministic under a seeded rng.
    lazyCandidates.sort();
    const shuffled = deterministicShuffle(lazyCandidates, random);
    for (const slug of shuffled) {
      if (selected.length >= target) break;
      push(slug);
    }
  }

  // Top-up from non-due guardians (sorted by oldest lastReviewedDay first). Only
  // engages if we're still below the minimum round length — matches the plan
  // ("if still under min length (5), top up"). Wobbling non-due entries still
  // keep priority over non-wobbling non-due entries so a recent wobble stays
  // visible when scheduling placed it slightly in the future.
  if (selected.length < GUARDIAN_MIN_ROUND_LENGTH) {
    const nonDue = guardianEntries
      .filter((entry) => entry.nextDueDay > safeToday && !selectedSet.has(entry.slug))
      .filter((entry) => isGuardianEligibleSlug(entry.slug, progressMap, wordBySlug));
    const wobblingNonDue = nonDue
      .filter((entry) => entry.wobbling === true)
      .sort(compareByLastReviewedThenSlug);
    const stableNonDue = nonDue
      .filter((entry) => entry.wobbling !== true)
      .sort(compareByLastReviewedThenSlug);
    for (const entry of [...wobblingNonDue, ...stableNonDue]) {
      if (selected.length >= target) break;
      push(entry.slug);
    }
  }

  return selected;
}

/**
 * Pure Boss Dictation word selector (U9). Draws a uniform random sample of
 * core-pool Mega slugs from the learner's progress map. Extra-pool words are
 * excluded (Mega is a core-pool concept — same rule as `selectGuardianWords`);
 * slugs not published by the current content bundle are also excluded so an
 * orphan progress record from a content hot-swap can never leak into a Boss
 * round.
 *
 * @param {object} params
 * @param {object} params.progressMap  slug -> legacy progress record
 * @param {object} params.wordBySlug   slug -> word metadata (spellingPool, etc.)
 * @param {number} params.length       desired round length (clamped 8..12)
 * @param {Function} params.random     injected random; used for deterministic shuffle
 * @returns {string[]} selected slugs (array of strings)
 */
export function selectBossWords({
  progressMap = {},
  wordBySlug = {},
  length = BOSS_DEFAULT_ROUND_LENGTH,
  random,
} = {}) {
  const target = clampBossRoundLength(length);
  // Candidate filter shares the Mega eligibility predicate with Guardian so
  // extra-pool slugs and orphan content records drop out consistently.
  const candidates = [];
  for (const [slug] of Object.entries(progressMap || {})) {
    if (!isGuardianEligibleSlug(slug, progressMap, wordBySlug)) continue;
    candidates.push(slug);
  }
  if (!candidates.length) return [];
  // Alphabetical baseline makes the shuffle deterministic under a seeded rng.
  candidates.sort();
  const shuffled = deterministicShuffle(candidates, random);
  return shuffled.slice(0, Math.min(target, shuffled.length));
}

/**
 * P2 U11: Pattern Quest grading helpers.
 *
 * NFKC normalisation + typographic leniency are the two deterministic passes
 * applied to learner input before an exact match. The same helpers feed the
 * close-miss predicate (Levenshtein distance 1) for Card 4 (detect-error
 * correction). None of this calls out to an LLM — grading is byte-for-byte
 * reproducible under a seeded run.
 */
function normalisePatternQuestInput(raw) {
  const text = typeof raw === 'string' ? raw : '';
  // NFKC folds compatibility forms (e.g. the fi ligature into "fi") so a
  // learner who pastes text with typographic characters is not penalised.
  const nfkc = text.normalize('NFKC');
  // Typographic leniency: smart quotes → straight, en/em dash → hyphen.
  return nfkc
    .replace(/[‘’‛′‵]/g, "'")
    .replace(/[“”‟″‶]/g, '"')
    .replace(/[–—−]/g, '-')
    .trim();
}

/**
 * Case-insensitive exact match after NFKC + typographic normalisation. The
 * comparison is `.toLocaleLowerCase('en')` to give deterministic locale
 * behaviour regardless of the host's default locale — a learner in TR locale
 * would otherwise hit the Turkish-dotless-i edge case.
 */
function isExactPatternMatch(typed, target) {
  const left = normalisePatternQuestInput(typed).toLocaleLowerCase('en');
  const right = normalisePatternQuestInput(target).toLocaleLowerCase('en');
  return Boolean(left && right && left === right);
}

/**
 * Levenshtein distance capped at 2 — Pattern Quest only cares about
 * distance 0 vs 1 vs "further", so the inner loop bails out as soon as it
 * exceeds 1. A learner typing `competiton` where the target is
 * `competition` is accepted as a typo of the correct word.
 */
function patternLevenshteinWithin1(a, b) {
  const s = normalisePatternQuestInput(a).toLocaleLowerCase('en');
  const t = normalisePatternQuestInput(b).toLocaleLowerCase('en');
  if (s === t) return 0;
  const la = s.length;
  const lb = t.length;
  if (Math.abs(la - lb) > 1) return 2;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < la && j < lb) {
    if (s[i] === t[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return 2;
    if (la > lb) {
      i += 1;
    } else if (lb > la) {
      j += 1;
    } else {
      i += 1;
      j += 1;
    }
  }
  edits += (la - i) + (lb - j);
  return edits > 1 ? 2 : edits;
}

/**
 * Pure Pattern Quest card selector. Picks 5 cards in mass-then-interleave
 * order:
 *   Card 1: `spell` — prompt the target word, expect typed answer.
 *   Card 2: `spell` — second word from the same pattern (massed encoding).
 *   Card 3: `classify` — show a word, pick the pattern from 3 options.
 *   Card 4: `detect-error` — show a misspelling, type the correct form.
 *   Card 5: `explain` — multiple-choice rationale for "why does this word
 *           end in -tion" etc.
 *
 * Selection is deterministic under a seeded `random`. If the pattern lacks
 * ≥4 eligible core words we return an empty array so the caller can refuse
 * to start.
 *
 * @param {object} params
 * @param {string} params.patternId
 * @param {object} params.progressMap  slug -> legacy progress record
 * @param {object} params.wordBySlug   slug -> word metadata (incl. patternIds)
 * @param {Function} params.random     injected random (Fisher-Yates shuffle)
 * @returns {Array<{type: string, slug: string, ...}>}
 */
export function selectPatternQuestCards({
  patternId,
  progressMap = {},
  wordBySlug = {},
  random,
} = {}) {
  if (typeof patternId !== 'string' || !patternId) return [];
  if (!Object.prototype.hasOwnProperty.call(SPELLING_PATTERNS, patternId)) return [];
  const pattern = SPELLING_PATTERNS[patternId];
  if (!pattern || !Array.isArray(pattern.promptTypes) || pattern.promptTypes.length === 0) return [];

  const eligibleSlugs = [];
  for (const [slug] of Object.entries(progressMap || {})) {
    if (!isPatternEligibleSlug(slug, patternId, wordBySlug)) continue;
    eligibleSlugs.push(slug);
  }
  if (eligibleSlugs.length < PATTERN_QUEST_ROUND_LENGTH - 1) {
    // Need at least 4 distinct core words per F10 launch threshold. One slug
    // is re-used for Card 5 (explain) so 4 unique words suffice for a 5-card
    // round.
    return [];
  }
  eligibleSlugs.sort();
  const shuffled = deterministicShuffle(eligibleSlugs, random);
  const [slugA, slugB, slugC, slugD] = shuffled;

  // U11 Fix 4: align the Card 4 misspelling with slugD. Previously the trap
  // was sampled uniformly from `pattern.traps`, which meant the child could
  // see a misspelling of a DIFFERENT word from the one at slot slugD — e.g.
  // the card says `competishun` (trap for `competition`) but the target
  // word is `position`. Typing the correct fix wobbled `position` for a
  // trap that has nothing to do with it. Fix: filter traps by edit-distance
  // ≤ 2 to the slugD target word so the displayed misspelling is always a
  // plausible mis-spell of what we grade against. If no trap is within
  // distance 2, fall back to a deterministic single-character swap of the
  // target word.
  const slugDWord = typeof wordBySlug[slugD]?.word === 'string' ? wordBySlug[slugD].word : '';
  const rawTraps = Array.isArray(pattern.traps)
    ? pattern.traps.filter((trap) => typeof trap === 'string' && trap)
    : [];
  const nearbyMisspellings = slugDWord
    ? rawTraps.filter((trap) => levenshteinWithinN(trap, slugDWord, 2) <= 2)
    : [];
  let misspelling = nearbyMisspellings.length
    ? nearbyMisspellings[Math.floor(random() * nearbyMisspellings.length) % nearbyMisspellings.length]
    : '';
  if (!misspelling && slugDWord) {
    misspelling = deterministicCharSwap(slugDWord, random);
  }

  const cards = [
    { type: 'spell', slug: slugA, patternId },
    { type: 'spell', slug: slugB, patternId },
    { type: 'classify', slug: slugC, patternId },
    {
      type: 'detect-error',
      slug: slugD,
      patternId,
      misspelling: misspelling || slugDWord || '',
    },
    // Card 5 reuses slugA (mass-then-interleave: variety on card 5 is the
    // explain card-type, not a new slug). Deterministic under a seeded
    // shuffle — no second random draw.
    { type: 'explain', slug: slugA, patternId },
  ];

  return cards;
}

/**
 * U11 Fix 4 helper: Levenshtein distance capped at `cap`. Used to filter
 * Pattern-Quest misspelling traps to those within edit-distance 2 of the
 * target word so Card 4 always displays a plausible misspelling of the
 * slug actually being graded.
 */
function levenshteinWithinN(a, b, cap = 2) {
  const s = normalisePatternQuestInput(a).toLocaleLowerCase('en');
  const t = normalisePatternQuestInput(b).toLocaleLowerCase('en');
  if (s === t) return 0;
  const la = s.length;
  const lb = t.length;
  if (Math.abs(la - lb) > cap) return cap + 1;
  // Simple DP, bailing out once the minimum of the current row exceeds cap.
  let prev = new Array(lb + 1);
  let curr = new Array(lb + 1);
  for (let j = 0; j <= lb; j += 1) prev[j] = j;
  for (let i = 1; i <= la; i += 1) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= lb; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > cap) return cap + 1;
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[lb];
}

/**
 * U11 Fix 4 helper: deterministic single-character swap for a fallback
 * misspelling when no trap is within distance 2 of the target. Picks a
 * random position and replaces the character with a nearby one — edit
 * distance exactly 1 against the target.
 */
function deterministicCharSwap(word, random) {
  if (!word || typeof word !== 'string') return '';
  const position = Math.floor(random() * word.length);
  const safePosition = Math.max(0, Math.min(word.length - 1, position));
  const original = word[safePosition];
  // Pick a simple swap: if the char is a vowel, swap with a nearby vowel;
  // otherwise swap with 'z' (conspicuously wrong). Avoids producing the
  // same word back when word[safePosition] is already the swap target.
  const vowelSwap = { a: 'e', e: 'a', i: 'o', o: 'u', u: 'i' };
  const replacement = vowelSwap[original.toLowerCase()]
    || (original.toLowerCase() === 'z' ? 'q' : 'z');
  return `${word.slice(0, safePosition)}${replacement}${word.slice(safePosition + 1)}`;
}

function loadJson(storage, key, fallback) {
  try {
    const raw = storage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// U8: Storage-failure warning surface.
//
// `writeJsonToStoragePort` now returns `{ ok, reason? }` instead of swallowing errors
// silently. The legacy swallow is preserved in spirit (the write still never
// throws up to the caller), but the caller can now inspect `ok` and surface a
// `feedback.persistenceWarning` to the learner. The reason string is not
// user-facing — it is captured for future diagnostic hooks.
//
// Every existing caller must either consume the boolean or destructure it
// explicitly; relying on a truthy/falsy check against the raw return value is
// a contract violation (the return value is always an object, so `!!writeJsonToStoragePort`
// is always truthy).
//
// Known non-self-heal case (documented, accepted MVP gap): if the child
// closes the tab before the next submit, the warning dies. A durable cross-
// session warning surface is deferred to a later plan.
function writeJsonToStoragePort(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
    return { ok: true };
  } catch (error) {
    // Storage quota / private mode / disk-full / IO error all land here.
    // The caller decides whether this should surface in the UI.
    return { ok: false, reason: 'setItem-threw', error: error instanceof Error ? error : new Error(String(error)) };
  }
}

function buildCloze(sentence, word) {
  const blanks = '_'.repeat(Math.max(String(word || '').length, 5));
  const escaped = String(word || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\b${escaped}\\b`, 'i');
  return String(sentence || '').replace(pattern, blanks);
}

function acceptedForPrompt(rawAccepted, fallback) {
  const accepted = normaliseStringArray(rawAccepted);
  const fallbackText = normaliseString(fallback);
  if (fallbackText && !accepted.map((entry) => entry.toLowerCase()).includes(fallbackText.toLowerCase())) {
    return [fallbackText, ...accepted];
  }
  return accepted.length ? accepted : (fallbackText ? [fallbackText] : []);
}

function normaliseWordVariants(variants) {
  if (!Array.isArray(variants)) return [];
  return variants
    .map((variant) => {
      if (!variant || typeof variant !== 'object' || Array.isArray(variant)) return null;
      const word = normaliseString(variant.word);
      if (!word) return null;
      return {
        word,
        accepted: acceptedForPrompt(variant.accepted, word),
        sentence: normaliseString(variant.sentence),
        sentences: normaliseStringArray(variant.sentences),
        explanation: normaliseString(variant.explanation),
      };
    })
    .filter(Boolean);
}

function explanationForPrompt(baseWord, promptedWord, prompt = null) {
  const promptExplanation = normaliseString(prompt?.explanation);
  if (promptExplanation) return promptExplanation;
  const target = normaliseString(promptedWord, baseWord?.word).toLowerCase();
  const variants = normaliseWordVariants(baseWord?.variants);
  const variant = variants.find((entry) => entry.word.toLowerCase() === target);
  return variant?.explanation || baseWord?.explanation || '';
}

function wordForPrompt(baseWord, prompt = null) {
  if (!baseWord) return null;
  const promptedWord = normaliseString(prompt?.word, baseWord.word);
  const sentence = normaliseString(prompt?.sentence, baseWord.sentence || '');
  if (promptedWord === baseWord.word && !prompt?.accepted) return baseWord;
  return {
    ...baseWord,
    word: promptedWord,
    accepted: acceptedForPrompt(prompt?.accepted, promptedWord),
    sentence,
    sentences: sentence ? [sentence] : (Array.isArray(baseWord.sentences) ? [...baseWord.sentences] : []),
    explanation: explanationForPrompt(baseWord, promptedWord, prompt),
  };
}

function isKnownSlug(slug, wordBySlug = DEFAULT_WORD_BY_SLUG) {
  return typeof slug === 'string' && Boolean(wordBySlug[slug]);
}

function uniqueStrings(values) {
  return [...new Set(values)];
}

function clockFrom(now) {
  if (typeof now !== 'function') {
    throw new TypeError('Spelling core requires now().');
  }
  return () => {
    const value = Number(now());
    if (!Number.isFinite(value)) {
      throw new TypeError('Spelling core requires now() to return a finite number.');
    }
    return value;
  };
}

function defaultLabelForMode(mode) {
  if (mode === 'trouble') return 'Trouble drill';
  if (mode === 'single') return 'Single-word drill';
  if (mode === 'test') return 'SATs 20 test';
  if (mode === 'guardian') return 'Guardian Mission';
  if (mode === 'boss') return 'Boss Dictation';
  if (mode === 'pattern-quest') return 'Pattern Quest';
  return 'Smart review';
}

function normalisePrefs(rawPrefs = {}) {
  const mode = normaliseMode(rawPrefs.mode, 'smart');
  return {
    mode,
    yearFilter: normaliseYearFilter(rawPrefs.yearFilter, 'core'),
    roundLength: normaliseRoundLength(rawPrefs.roundLength, mode),
    showCloze: normaliseBoolean(rawPrefs.showCloze, true),
    autoSpeak: normaliseBoolean(rawPrefs.autoSpeak, true),
    extraWordFamilies: normaliseBoolean(rawPrefs.extraWordFamilies, false),
    ttsProvider: normaliseTtsProvider(rawPrefs.ttsProvider),
    bufferedGeminiVoice: normaliseBufferedGeminiVoice(rawPrefs.bufferedGeminiVoice),
  };
}

function normaliseLearningStatus(entry, defaultNeeded) {
  const base = entry && typeof entry === 'object' && !Array.isArray(entry)
    ? entry
    : {};
  return {
    attempts: normaliseNonNegativeInteger(base.attempts, 0),
    successes: normaliseNonNegativeInteger(base.successes, 0),
    needed: Math.max(1, normaliseNonNegativeInteger(base.needed, defaultNeeded)),
    hadWrong: normaliseBoolean(base.hadWrong, false),
    wrongAnswers: normaliseStringArray(base.wrongAnswers),
    done: normaliseBoolean(base.done, false),
    applied: normaliseBoolean(base.applied, false),
  };
}

function normaliseTestResults(results, selectedSlugs) {
  const allowed = new Set(selectedSlugs);
  const seen = new Set();
  const list = Array.isArray(results) ? results : [];
  const clean = [];

  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const slug = typeof entry.slug === 'string' ? entry.slug : '';
    if (!allowed.has(slug) || seen.has(slug)) continue;
    clean.push({
      slug,
      answer: normaliseString(entry.answer),
      correct: normaliseBoolean(entry.correct, false),
    });
    seen.add(slug);
  }

  return clean;
}

function buildProgressMeta(session) {
  const total = Array.isArray(session?.uniqueWords) ? session.uniqueWords.length : 0;
  if (session?.type === 'test') {
    const results = Array.isArray(session?.results) ? session.results : [];
    return {
      total,
      checked: results.length,
      done: results.length,
      wrongCount: results.filter((item) => !item.correct).length,
    };
  }
  const statusEntries = Object.values(session?.status || {});
  return {
    total,
    checked: statusEntries.filter((info) => info.attempts > 0).length,
    done: statusEntries.filter((info) => info.done).length,
    wrongCount: statusEntries.filter((info) => info.hadWrong).length,
  };
}

function buildPrompt(engine, session, slug, wordBySlug = DEFAULT_WORD_BY_SLUG) {
  if (!isKnownSlug(slug, wordBySlug)) return null;
  const word = wordBySlug[slug];
  const current = session?.currentPrompt;
  const sentence = current?.slug === slug && typeof current.sentence === 'string'
    ? current.sentence
    : engine.peekPromptSentence(session, slug) || word.sentence || '';
  const promptedWord = current?.slug === slug && typeof current.word === 'string' && current.word
    ? current.word
    : word.word;
  return {
    slug,
    word: promptedWord,
    accepted: acceptedForPrompt(current?.slug === slug && current.accepted ? current.accepted : word.accepted, promptedWord),
    explanation: current?.slug === slug
      ? explanationForPrompt(word, promptedWord, current)
      : explanationForPrompt(word, promptedWord),
    sentence,
    cloze: buildCloze(sentence, promptedWord),
  };
}

function normalisePromptForSlug(rawPrompt, slug, wordBySlug = DEFAULT_WORD_BY_SLUG) {
  if (!isKnownSlug(slug, wordBySlug)) return null;
  if (!rawPrompt || typeof rawPrompt !== 'object' || Array.isArray(rawPrompt)) return null;
  if (typeof rawPrompt.slug === 'string' && rawPrompt.slug !== slug) return null;
  if (typeof rawPrompt.sentence !== 'string') return null;

  const word = wordBySlug[slug];
  const promptedWord = normaliseString(rawPrompt.word, word.word);
  return {
    slug,
    word: promptedWord,
    accepted: acceptedForPrompt(rawPrompt.accepted || word.accepted, promptedWord),
    explanation: explanationForPrompt(word, promptedWord, rawPrompt),
    sentence: rawPrompt.sentence,
    cloze: buildCloze(rawPrompt.sentence, promptedWord),
  };
}

function savedPromptForSlug(rawSession, slug, wordBySlug = DEFAULT_WORD_BY_SLUG) {
  return normalisePromptForSlug(rawSession?.currentPrompt, slug, wordBySlug)
    || normalisePromptForSlug(rawSession?.currentCard?.prompt, slug, wordBySlug);
}

function decorateSession(engine, learnerId, session, wordBySlug = DEFAULT_WORD_BY_SLUG, progressStore = null) {
  if (!session) return null;
  const currentPrompt = session.currentSlug ? buildPrompt(engine, session, session.currentSlug, wordBySlug) : null;
  const currentCard = session.currentSlug && currentPrompt
    ? {
        slug: session.currentSlug,
        word: wordForPrompt(wordBySlug[session.currentSlug], currentPrompt),
        prompt: currentPrompt,
      }
    : null;
  const currentProgress = currentCard?.slug
    ? (progressStore && typeof engine.progressForSlug === 'function'
      ? engine.progressForSlug(progressStore, currentCard.slug)
      : engine.getProgress(learnerId, currentCard.slug))
    : null;

  const base = {
    ...session,
    version: SPELLING_SERVICE_STATE_VERSION,
    currentPrompt,
    currentCard,
    progress: buildProgressMeta(session),
    currentStage: currentProgress?.stage || 0,
  };

  // P2 U11: Pattern Quest decoration. `patternQuestCard` is the self-contained
  // shape the UI renders — it never consults raw `patternQuestCards[cardIndex]`
  // directly because the card objects get frozen through structuredClone on
  // every transition.
  //
  // Fix 2 threads a deterministic per-card shuffle RNG into the decorator so
  // classify / explain choices are shuffled (correct choice NOT always at
  // position 0) while still being reproducible across re-decorations of the
  // same card within a session. The RNG seed includes `session.id` so two
  // sessions with the same patternId still get different orderings.
  if (session.mode === 'pattern-quest') {
    const cards = Array.isArray(session.patternQuestCards) ? session.patternQuestCards : [];
    const cardIndex = Number.isInteger(session.patternQuestCardIndex) ? session.patternQuestCardIndex : 0;
    const card = cards[cardIndex] || null;
    const patternId = typeof session.patternQuestPatternId === 'string' ? session.patternQuestPatternId : '';
    const patternDef = patternId && SPELLING_PATTERNS[patternId] ? SPELLING_PATTERNS[patternId] : null;
    if (card && patternDef) {
      const cardShuffleRandom = deterministicCardSeedRandom({
        patternId,
        slug: card.slug,
        cardIndex,
        type: card.type,
        // Blend the session id so repeated rounds of the same pattern show
        // different choice orderings even if slug/cardIndex repeat.
        extra: session.id || '',
      });
      base.patternQuestCard = decoratePatternQuestCard(card, patternDef, wordBySlug, cardIndex, cards.length, cardShuffleRandom);
    } else {
      base.patternQuestCard = null;
    }
    base.patternQuestProgress = {
      total: cards.length,
      index: cardIndex,
      patternId,
      patternTitle: patternDef?.title || patternId,
    };
  }

  return base;
}

/**
 * P2 U11: Build the UI-facing Pattern Quest card shape. Classify/explain
 * cards carry 3 deterministic choices with the correct option flagged via
 * `correct: true`; ids are re-assigned `option-${index}` AFTER a seeded
 * shuffle so the correct choice is not always position 0 (U11 Fix 2 —
 * reviewer finding: `id === 'option-0'` grading turned Pattern Quest into a
 * "pick top" tell within 2 rounds). Detect-error cards carry the
 * misspelling prompt plus the target word. Spell cards inherit the standard
 * session card shape — no extra decoration beyond the base fields.
 *
 * Shuffle determinism: the `cardShuffleRandom` is derived from the session's
 * seeded random (threaded through `decorateSession` → `decoratePatternQuestCard`)
 * so a repeated decoration produces the same choice order on every call for
 * the same seed + card index. Without a per-card derivation two calls on the
 * same card from different lifecycle points (e.g. initial start + post-
 * submit refresh) would produce different orders and the UI would re-shuffle
 * mid-card. The caller threads a `cardShuffleRandom` that is deterministic
 * per (patternId, slug, type, cardIndex) tuple — see the call site.
 */
function decoratePatternQuestCard(card, patternDef, wordBySlug, cardIndex, totalCards, cardShuffleRandom) {
  const type = typeof card?.type === 'string' ? card.type : '';
  const slug = typeof card?.slug === 'string' ? card.slug : '';
  const word = slug ? wordBySlug[slug] : null;
  const patternId = typeof card?.patternId === 'string' ? card.patternId : (patternDef?.id || '');
  // Use the injected per-card shuffle RNG. Falling back to a deterministic
  // per-(patternId, slug, cardIndex) stream when none is provided keeps tests
  // that call `decoratePatternQuestCard` directly (rare) still deterministic.
  const shuffleRandom = typeof cardShuffleRandom === 'function'
    ? cardShuffleRandom
    : deterministicCardSeedRandom({ patternId, slug, cardIndex, type });

  const base = {
    type,
    slug,
    patternId,
    patternTitle: patternDef?.title || patternId,
    rule: patternDef?.rule || '',
    index: cardIndex,
    total: totalCards,
    word: word?.word || '',
    sentence: word?.sentence || '',
  };

  if (type === 'detect-error') {
    return {
      ...base,
      misspelling: typeof card.misspelling === 'string' ? card.misspelling : '',
      target: word?.word || '',
    };
  }

  if (type === 'classify') {
    const correctChoice = {
      label: patternDef?.title || patternId,
      correct: true,
    };
    const distractors = [];
    for (const [id, def] of Object.entries(SPELLING_PATTERNS)) {
      if (distractors.length >= 2) break;
      if (id === patternId) continue;
      if (!Array.isArray(def.promptTypes) || def.promptTypes.length === 0) continue;
      distractors.push({ label: def.title, correct: false });
    }
    const combined = [correctChoice, ...distractors];
    const shuffled = deterministicShuffle(combined, shuffleRandom).map((choice, index) => ({
      ...choice,
      id: `option-${index}`,
    }));
    return {
      ...base,
      choices: shuffled,
    };
  }

  if (type === 'explain') {
    const correctChoice = {
      label: patternDef?.rule || 'This pattern has its own rule.',
      correct: true,
    };
    const distractors = [];
    for (const [id, def] of Object.entries(SPELLING_PATTERNS)) {
      if (distractors.length >= 2) break;
      if (id === patternId) continue;
      if (!Array.isArray(def.promptTypes) || def.promptTypes.length === 0) continue;
      if (!def.rule) continue;
      distractors.push({ label: def.rule, correct: false });
    }
    const combined = [correctChoice, ...distractors];
    const shuffled = deterministicShuffle(combined, shuffleRandom).map((choice, index) => ({
      ...choice,
      id: `option-${index}`,
    }));
    return {
      ...base,
      choices: shuffled,
    };
  }

  return base;
}

// U11 Fix 2: Deterministic per-card RNG for shuffling classify/explain
// choices. Built from a simple djb2 hash of the card-identity tuple so two
// calls to `decoratePatternQuestCard` for the same card produce the same
// shuffled order — critical for correctness of the submit path (the UI
// reads the id from the decorated session and sends it back; the service
// re-decorates on submit and must agree on which id carries `correct:true`).
//
// The `extra` key (typically session.id) gives two rounds of the same
// pattern different orderings so an "enumeration" test over 10 rounds
// actually observes varying correct-option index rather than the same
// deterministic shuffle repeating.
function deterministicCardSeedRandom({ patternId, slug, cardIndex, type, extra } = {}) {
  let hash = 5381;
  const seedString = `${patternId || ''}|${slug || ''}|${cardIndex || 0}|${type || ''}|${extra || ''}`;
  for (let i = 0; i < seedString.length; i += 1) {
    hash = ((hash << 5) + hash + seedString.charCodeAt(i)) >>> 0;
  }
  let state = hash || 0x9E3779B1;
  return function cardSeededRandom() {
    state = (state + 0x6D2B79F5) >>> 0;
    let result = Math.imul(state ^ (state >>> 15), 1 | state);
    result ^= result + Math.imul(result ^ (result >>> 7), 61 | result);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function buildTransition(state, { events = [], audio = null, changed = true, ok = true } = {}) {
  return {
    ok,
    state,
    events: Array.isArray(events) ? events.filter(Boolean) : [],
    audio,
    changed,
  };
}

function copyState(rawState) {
  return cloneSerialisable(rawState) || createInitialSpellingState();
}

function cloneHeroContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return cloneSerialisable(value);
}

function masteryMilestoneForCount(secureCount) {
  return SPELLING_MASTERY_MILESTONES.includes(secureCount) ? secureCount : null;
}

function sessionCompletedEvents({ learnerId, session, summary, createdAt }) {
  if (session?.practiceOnly) return [];
  return [createSpellingSessionCompletedEvent({ learnerId, session, summary, createdAt })];
}

export function defaultSpellingPrefs() {
  return normalisePrefs();
}

export function createSpellingService({
  repository,
  storage,
  now,
  random,
  audio,
  context,
  diagnostics,
  contentSnapshot,
  cloneContentSnapshot = true,
} = {}) {
  const clock = clockFrom(now);
  if (typeof random !== 'function') {
    throw new TypeError('Spelling core requires random().');
  }
  const resolvedAudio = audio && typeof audio === 'object'
    ? audio
    : { speak: async () => undefined, warmup: () => undefined };
  const resolvedContext = context && typeof context.extractSummaryContext === 'function'
    ? context
    : { extractSummaryContext: () => null };
  const resolvedDiagnostics = diagnostics && typeof diagnostics.warn === 'function'
    ? diagnostics
    : { warn: () => undefined };
  const resolvedStorage = storage || repository?.storage || createNoopStorage();
  const persistence = repository || {
    storage: resolvedStorage,
    syncPracticeSession() {},
    abandonPracticeSession() {},
    resetLearner() {},
  };
  // U8 review fix: read the platform persistence channel's `lastError`
  // snapshot when the host exposes it. This is the only reliable way to
  // observe legacy-engine's silent-swallow on Smart Review / SATs submits
  // in production, where `storage` is the `createSpellingPersistence`
  // proxy whose `setItem` DOES throw on persistAll failure (so the
  // service's own `writeJsonToStoragePort` catches it) but legacy-engine's `saveProgress`
  // catches that throw internally. Comparing the channel's before/after
  // snapshot on each submit surfaces that hidden failure without probing
  // storage a second time.
  //
  // Bare-storage test hosts (no platform repositories) do not expose this
  // adapter — `readPersistenceError()` returns null everywhere, and the
  // submit path falls back to the explicit `saveProgressToStorage` write,
  // whose `writeJsonToStoragePort` try/catch still returns `{ ok: false }` when the
  // underlying `storage.setItem` throws.
  const readPersistenceError = typeof persistence.readPersistenceError === 'function'
    ? () => persistence.readPersistenceError()
    : () => null;
  function persistenceErrorSignatureChanged(before, after) {
    if (!after) return false;
    if (!before) return true;
    if (Number(before.at) !== Number(after.at)) return true;
    return before.message !== after.message;
  }
  const randomFn = random;
  const sourceWords = Array.isArray(contentSnapshot?.words) ? contentSnapshot.words : DEFAULT_WORDS;
  const runtimeWords = cloneContentSnapshot ? cloneSerialisable(sourceWords) : sourceWords;
  const sourceWordBySlug = contentSnapshot?.wordBySlug
    && typeof contentSnapshot.wordBySlug === 'object'
    && !Array.isArray(contentSnapshot.wordBySlug)
    ? contentSnapshot.wordBySlug
    : null;
  const runtimeWordBySlug = sourceWordBySlug
    ? (cloneContentSnapshot ? cloneSerialisable(sourceWordBySlug) : sourceWordBySlug)
    : Object.fromEntries(runtimeWords.map((word) => [
      word.slug,
      cloneContentSnapshot ? cloneSerialisable(word) : word,
    ]));
  const sourceContentSnapshot = contentSnapshot && typeof contentSnapshot === 'object' && !Array.isArray(contentSnapshot)
    ? contentSnapshot
    : {};
  const runtimeContentSnapshot = cloneContentSnapshot
    ? cloneSerialisable(sourceContentSnapshot)
    : { ...sourceContentSnapshot };
  runtimeContentSnapshot.words = cloneContentSnapshot ? cloneSerialisable(runtimeWords) : runtimeWords;
  runtimeContentSnapshot.wordBySlug = cloneContentSnapshot ? cloneSerialisable(runtimeWordBySlug) : runtimeWordBySlug;
  const isRuntimeKnownSlug = (slug) => isKnownSlug(slug, runtimeWordBySlug);
  const engine = createLegacySpellingEngine({
    words: runtimeWords,
    wordMeta: runtimeWordBySlug,
    storage: resolvedStorage,
    audio: resolvedAudio,
    now: clock,
    random: randomFn,
  });

  function getPrefs(learnerId) {
    return normalisePrefs(loadJson(resolvedStorage, prefsKey(learnerId), {}));
  }

  function savePrefs(learnerId, prefs) {
    const next = normalisePrefs({ ...getPrefs(learnerId), ...(prefs || {}) });
    // U8: prefs writes propagate the `{ ok, reason? }` shape through the
    // storage boundary, but prefs-save is not a submit-path surface (no
    // persistenceWarning banner), so the result is currently unconsumed.
    // Kept consistent so every writeJsonToStoragePort caller has the same contract shape.
    writeJsonToStoragePort(resolvedStorage, prefsKey(learnerId), next);
    return next;
  }

  function progressSnapshot(learnerId) {
    return typeof engine.progressFor === 'function' ? engine.progressFor(learnerId) : null;
  }

  function progressForWord(learnerId, word, progressStore = null) {
    if (progressStore && typeof engine.progressForSlug === 'function') {
      return engine.progressForSlug(progressStore, word.slug);
    }
    return engine.getProgress(learnerId, word.slug);
  }

  function getStats(learnerId, yearFilter = 'core', progressStore = null) {
    return normaliseStats(engine.lifetimeStats(learnerId, normaliseYearFilter(yearFilter, 'core'), progressStore || undefined));
  }

  function analyticsWordRow(learnerId, word, progressStore = null) {
    const progress = progressForWord(learnerId, word, progressStore);
    const statusProgressStore = progressStore || { [word.slug]: progress };
    return {
      slug: word.slug,
      word: word.word,
      family: word.family,
      year: word.year,
      yearLabel: word.yearLabel,
      spellingPool: word.spellingPool === 'extra' ? 'extra' : 'core',
      coverageTier: coverageTierForWord(word),
      familyWords: Array.isArray(word.familyWords) ? [...word.familyWords] : [],
      sentence: word.sentence || '',
      explanation: word.explanation || '',
      accepted: Array.isArray(word.accepted) ? [...word.accepted] : [word.slug],
      variants: normaliseWordVariants(word.variants),
      status: engine.statusForWord(learnerId, word, statusProgressStore),
      stageLabel: engine.stageLabel(progress.stage),
      progress: {
        stage: progress.stage,
        attempts: progress.attempts,
        correct: progress.correct,
        wrong: progress.wrong,
        dueDay: progress.dueDay,
        lastDay: progress.lastDay,
        lastResult: progress.lastResult,
      },
    };
  }

  function analyticsWordGroups(learnerId, progressStore = null) {
    const groups = [
      { key: 'y3-4', title: 'Years 3-4', spellingPool: 'core', year: '3-4' },
      { key: 'y5-6', title: 'Years 5-6', spellingPool: 'core', year: '5-6' },
      { key: 'secure-extension', title: 'Secure vocabulary', spellingPool: 'core', year: 'secure-extension' },
      { key: 'extra', title: 'Extra', spellingPool: 'extra', year: 'extra' },
    ];
    return groups.map((group) => ({
      key: group.key,
      title: group.title,
      spellingPool: group.spellingPool,
      year: group.year,
      words: runtimeWords
        .filter((word) => {
          if (group.key === 'secure-extension') return isSecureExtensionWord(word);
          if (group.key === 'extra') return isEnrichmentExtraWord(word);
          return isStatutoryCoreWord(word) && word.year === group.year;
        })
        .map((word) => analyticsWordRow(learnerId, word, progressStore)),
    }));
  }

  function getWordBankEntry(learnerId, slug) {
    if (!isRuntimeKnownSlug(slug)) return null;
    return analyticsWordRow(learnerId, runtimeWordBySlug[slug], progressSnapshot(learnerId));
  }

  function currentTodayDay() {
    return Math.floor(clock() / DAY_MS);
  }

  /**
   * Strict FIFO card advance for Guardian Mission rounds. The legacy
   * advanceCard uses weighted selection over the queue window, which
   * randomises the per-round word order in ways the Guardian selection
   * contract explicitly wants to own. We bypass that and just shift the
   * queue head, rebuilding the currentPrompt via the existing helper.
   */
  function advanceGuardianCard(session) {
    if (!session) return { done: true };
    while (Array.isArray(session.queue) && session.queue.length) {
      const nextSlug = session.queue.shift();
      if (!nextSlug || !runtimeWordBySlug[nextSlug]) continue;
      if (session.status?.[nextSlug]?.done) continue;
      session.currentSlug = nextSlug;
      session.currentPrompt = buildPrompt(engine, session, nextSlug, runtimeWordBySlug);
      session.lastFamily = runtimeWordBySlug[nextSlug]?.family || null;
      session.lastYear = runtimeWordBySlug[nextSlug]?.year || null;
      return { done: false, slug: nextSlug, prompt: session.currentPrompt };
    }
    session.currentSlug = null;
    session.currentPrompt = null;
    return { done: true };
  }

  // Guardian state persists through the same storage proxy as prefs and progress
  // via the ks2-spell-guardian-<learnerId> key. Both the client repository and
  // the Worker engine recognise this prefix and route it through data.guardian
  // in the subject-state record (normalised by U1's normaliseGuardianMap).
  function loadGuardianMap(learnerId) {
    const raw = loadJson(resolvedStorage, guardianMapKey(learnerId), {});
    return normaliseGuardianMap(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}, currentTodayDay());
  }

  // U8: returns `{ ok, reason? }` so callers (submitGuardianAnswer,
  // skipGuardianWord, resetLearner) can decide whether to surface a
  // persistenceWarning. The `resetLearner` caller ignores the return because
  // a warning on a reset path is not actionable. The submit paths consume
  // it.
  function saveGuardianMap(learnerId, map) {
    return writeJsonToStoragePort(resolvedStorage, guardianMapKey(learnerId), map || {});
  }

  // U7 merge-save: per-slug guardian writer.
  //
  // Narrows the read-to-write window WITHIN A SINGLE SERVICE INSTANCE that
  // shares one `repositories` object. Instead of "load the whole map into
  // memory, mutate in-place, save the whole map" (which loses any write that
  // landed on a different slug inside the same service between the load and
  // the save), this helper reloads the latest persisted map, merges in a
  // single slug's record, then saves.
  //
  // Stays synchronous on purpose: no `navigator.locks`, no `await`, no Promise.
  //
  // Cross-tab coordination is provided by U5's `withWriteLock` (the async
  // lock-wrapped persist path in `src/platform/core/repositories/locks/`),
  // writeVersion CAS (`write-version.js`), and BroadcastChannel
  // invalidation (`broadcast-invalidator.js`). See `P2 U5` for invariants.
  // The optimistic-CAS retry loop inside
  // `src/subjects/spelling/repository.js::writeSpellingData` re-hydrates
  // on stale detection so same-disjoint-slug writes from multiple tabs
  // both survive. Same-slug contention remains last-writer-wins — an
  // acceptable semantic for Guardian slugs that advance monotonically on
  // correct answers. See the reviewer-feedback follow-up on the U5 PR
  // for exponential-backoff + higher CAS_MAX_ATTEMPTS handling of
  // cross-domain writeVersion thrash.
  //
  // Same-slug concurrent writes inside one service instance still
  // last-writer-wins.
  //
  // `saveGuardianMap` stays on the API because `resetLearner` (U6) zeros the
  // whole map in one go; that single-write is the only caller that should NOT
  // go through the merge-save path.
  function saveGuardianRecord(learnerId, slug, record) {
    const safeSlug = typeof slug === 'string' ? slug : '';
    // U8: preserve the existing no-op contract for empty slugs, but now return
    // the `{ ok, reason? }` shape so callers don't have to special-case a
    // `void` return against the boolean from real writes. An empty-slug call
    // is treated as a benign success — nothing was requested to persist.
    if (!safeSlug) return { ok: true };
    // Reload from storage so any write performed earlier on this same service
    // instance (possibly via a DIFFERENT slug) is preserved through the merge.
    const latest = loadGuardianMap(learnerId);
    // Normalise on write so malformed records don't leak past one load cycle.
    latest[safeSlug] = normaliseGuardianRecord(record, currentTodayDay());
    // U8: propagate persistence outcome. The U7 merge-save path writes twice
    // in ordinary flow (one load, one save); a failure at the save step is the
    // only observable persistence error, and we forward it so the submit-path
    // caller can flag the round with `feedback.persistenceWarning`.
    return saveGuardianMap(learnerId, latest);
  }

  function loadProgressFromStorage(learnerId) {
    const raw = loadJson(resolvedStorage, progressMapKey(learnerId), {});
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  }

  // P2 U2: load/save helpers for the sticky-graduation sibling. Uses the
  // same JSON/storage path as progress + guardian so a bare-storage test host
  // (no platform repositories) behaves identically to a production host that
  // routes through `createSpellingPersistence`. The proxy's setItem path
  // carries the H3 idempotency guard so a concurrent second-graduation
  // submit cannot overwrite the original record — re-reading inside the
  // critical section is the single source of truth.
  function loadPostMegaFromStorage(learnerId) {
    const raw = loadJson(resolvedStorage, postMegaKey(learnerId), null);
    return normalisePostMegaRecord(raw);
  }

  function savePostMegaToStorage(learnerId, record) {
    const normalised = normalisePostMegaRecord(record);
    if (!normalised) return { ok: true };
    return writeJsonToStoragePort(resolvedStorage, postMegaKey(learnerId), normalised);
  }

  // P2 U11: Pattern Quest wobble-map load/save. Mirrors Guardian's
  // load/saveGuardianMap so the sibling record stays parallel in shape:
  // `{ wobbling: { [slug]: { wobbling, wobbledAt, patternId } } }`. When
  // the persisted bundle has no `pattern` sibling the loader returns
  // `{ wobbling: {} }` rather than null so callers can write directly
  // without a null-guard branch on every submit.
  function loadPatternFromStorage(learnerId) {
    const raw = loadJson(resolvedStorage, patternKey(learnerId), { wobbling: {} });
    return normalisePatternMap(raw) || { wobbling: {} };
  }

  function savePatternToStorage(learnerId, record) {
    const normalised = normalisePatternMap(record) || { wobbling: {} };
    return writeJsonToStoragePort(resolvedStorage, patternKey(learnerId), normalised);
  }

  // P2 U9: load/save helpers for the durable `data.persistenceWarning` sibling.
  // Uses the same `writeJsonToStoragePort` contract as the other siblings so bare-storage
  // hosts (no platform repositories) behave identically to a production host
  // that wires `createSpellingPersistence`. Unlike `savePostMegaToStorage`,
  // this helper is explicitly non-sticky — a second failure overwrites the
  // previous `reason` + `occurredAt` and resets `acknowledged: false`.
  function loadPersistenceWarningFromStorage(learnerId) {
    const raw = loadJson(resolvedStorage, persistenceWarningKey(learnerId), null);
    return normaliseDurablePersistenceWarning(raw);
  }

  function savePersistenceWarningToStorage(learnerId, record) {
    const normalised = normaliseDurablePersistenceWarning(record);
    if (!normalised) return { ok: true };
    return writeJsonToStoragePort(resolvedStorage, persistenceWarningKey(learnerId), normalised);
  }

  // P2 U12: load/save helpers for the achievements sibling.
  function loadAchievementsFromStorage(learnerId) {
    const raw = loadJson(resolvedStorage, achievementsKey(learnerId), {});
    return normaliseAchievementsMap(raw) || {};
  }

  function saveAchievementsToStorage(learnerId, record) {
    const normalised = normaliseAchievementsMap(record) || {};
    return writeJsonToStoragePort(resolvedStorage, achievementsKey(learnerId), normalised);
  }

  /**
   * P2 U12: apply achievement evaluation for an emitted-events batch.
   *
   * Contract:
   *   - Called AFTER the caller has pushed the domain events onto its local
   *     `events` list. We never re-emit duplicates — the reward subscriber
   *     downstream also de-dups on (achievementId) so local-dispatch +
   *     remote-sync echo of the same domain event produces at most ONE
   *     toast at the UI layer.
   *   - For each achievement-relevant event, invokes the pure evaluator with
   *     the running `data.achievements` map (which carries both unlock rows
   *     and `_progress:*` aggregate entries) and merges both new unlocks and
   *     updated progress entries back into storage via
   *     `saveAchievementsToStorage`. The storage proxy's critical section
   *     (INSERT-OR-IGNORE on unlock rows) guarantees H4 idempotency.
   *   - Best-effort on storage failure: the persistence-warning banner is
   *     already surfaced by the upstream submit path, and achievement
   *     unlocks are non-critical (the learner still has the gameplay
   *     outcome; the badge is cosmetic).
   */
  function persistAchievementsForEmittedEvents(learnerId, emittedEvents) {
    if (!Array.isArray(emittedEvents) || emittedEvents.length === 0) return;
    const achievementRelevant = emittedEvents.filter((event) => {
      if (!event || typeof event.type !== 'string') return false;
      return event.type === 'spelling.guardian.mission-completed'
        || event.type === 'spelling.guardian.recovered'
        || event.type === 'spelling.boss.completed'
        || event.type === 'spelling.pattern.quest-completed';
    });
    if (achievementRelevant.length === 0) return;

    // Read the current map once. The evaluator derives aggregate state from
    // `_progress:*` entries inside this map, so a fresh learner starts with
    // an empty aggregate and accumulates across submit paths.
    const merged = { ...loadAchievementsFromStorage(learnerId) };
    let changed = false;

    for (const event of achievementRelevant) {
      const result = evaluateAchievements(event, merged, learnerId);
      // Apply unlocks (INSERT-OR-IGNORE at the caller layer too — the proxy
      // also guards, but guarding here avoids an unnecessary storage write).
      for (const unlock of result.unlocks || []) {
        if (!unlock || typeof unlock.id !== 'string') continue;
        if (merged[unlock.id]) continue;
        merged[unlock.id] = {
          unlockedAt: Number.isFinite(unlock.unlockedAt) ? unlock.unlockedAt : clock(),
        };
        changed = true;
      }
      // Apply progress updates (monotonic — each subsequent event's aggregate
      // includes all prior entries, so OVERWRITE is safe and required).
      for (const update of result.progressUpdates || []) {
        if (!update || typeof update.id !== 'string') continue;
        merged[update.id] = update.record;
        changed = true;
      }
    }

    if (changed) {
      saveAchievementsToStorage(learnerId, merged);
    }
  }

  // P2 U9: durable-warning writer. Called from the submit paths whenever
  // `feedback.persistenceWarning` surfaces on a round. The write itself is
  // bounded-retry: if the FIRST attempt to persist the warning fails (because
  // the underlying storage is the very thing that is broken), we make ONE
  // retry attempt; if that also fails, we fall back to a `diagnostics.warn` so
  // the app never crashes. This matches the P2 U9 plan requirement:
  // "bounded retry ... never crash the app."
  //
  // The record shape is `{ reason, occurredAt: currentTodayDay(),
  // acknowledged: false }`. A subsequent new failure overwrites `reason` +
  // `occurredAt` and resets `acknowledged` to false (the plan invariant).
  function writePersistenceWarning(learnerId, reason) {
    const record = {
      reason,
      occurredAt: currentTodayDay(),
      acknowledged: false,
    };
    const firstAttempt = savePersistenceWarningToStorage(learnerId, record);
    if (firstAttempt.ok === true) return firstAttempt;
    // Bounded retry once. If the first failure was transient (e.g. a race
    // inside the persistence channel), a retry may succeed. If the retry
    // also fails, swallow into diagnostics.warn so the host does not crash.
    const retry = savePersistenceWarningToStorage(learnerId, record);
    if (retry.ok === true) return retry;
    try {
      resolvedDiagnostics.warn({
        code: DIAGNOSTIC_CODES.PERSISTENCE_WARNING_WRITE_FAILED,
        learnerId,
        reason,
      });
    } catch {
      // A thrown diagnostics.warn (very unusual — some sandboxes wrap console)
      // is not actionable for the learner; absorb silently so the submit
      // path does not crash on a diagnostic side-effect.
    }
    return retry;
  }

  // P2 U9: acknowledge dispatcher. Sets `acknowledged: true` while
  // preserving `reason` + `occurredAt` for audit. If no warning is
  // currently persisted this is a silent no-op (no banner to dismiss).
  // A subsequent new failure resets `acknowledged: false` via
  // `writePersistenceWarning`.
  //
  // Reviewer-feedback fix (PR #279 HIGH): apply the same bounded-retry +
  // diagnostics.warn fallback pattern that `writePersistenceWarning` uses. The
  // whole point of the banner is to surface a broken-storage condition, so
  // when the learner clicks "I understand" and storage is STILL broken, we
  // must not silently no-op — the previous behaviour dropped the error and
  // left the record at `acknowledged: false`, making the click feel like a
  // black hole. The dispatchers surface `{ ok: false, reason: 'persist-failed' }`
  // by setting a runtime error so the learner sees the click did not take
  // effect.
  function acknowledgePersistenceWarning(learnerId) {
    const current = loadPersistenceWarningFromStorage(learnerId);
    if (!current) return { ok: true };
    const acknowledgedRecord = {
      reason: current.reason,
      occurredAt: current.occurredAt,
      acknowledged: true,
    };
    const firstAttempt = savePersistenceWarningToStorage(learnerId, acknowledgedRecord);
    if (firstAttempt.ok === true) return { ok: true };
    // Bounded retry once. If the first failure was transient (e.g. a race
    // inside the persistence channel), a retry may succeed.
    const retryAttempt = savePersistenceWarningToStorage(learnerId, acknowledgedRecord);
    if (retryAttempt.ok === true) return { ok: true };
    // Double failure — warn and return ok:false. The banner will re-render
    // on the next selector pass (storage still reports acknowledged=false),
    // but that is honest: storage is still broken. The dispatcher surfaces
    // a runtime error so the click is not silently dropped.
    try {
      resolvedDiagnostics.warn({
        code: DIAGNOSTIC_CODES.PERSISTENCE_WARNING_ACKNOWLEDGE_FAILED,
        learnerId,
        reason: acknowledgedRecord.reason,
      });
    } catch {
      // A thrown diagnostics.warn (very unusual — some sandboxes wrap console)
      // is not actionable for the learner; absorb silently so the ack path
      // does not crash on a diagnostic side-effect.
    }
    return { ok: false, reason: 'persist-failed' };
  }

  // P2 U9: read-side helper for the UI. Returns the normalised record or
  // null. Consumed by `buildSpellingContext` so setup + session scenes can
  // branch on a single helper rather than re-running `loadJson` themselves.
  function getPersistenceWarning(learnerId) {
    return loadPersistenceWarningFromStorage(learnerId);
  }

  // U8: returns `{ ok, reason? }` so submit paths can raise a
  // persistenceWarning. The non-Guardian Smart Review / SATs path writes
  // progress through the legacy engine's own setProgress (not this helper);
  // submitAnswer uses a light probe via this helper to detect the same
  // underlying storage failure without mutating state (see submitAnswer).
  function saveProgressToStorage(learnerId, map) {
    return writeJsonToStoragePort(resolvedStorage, progressMapKey(learnerId), map || {});
  }

  function coreWordCount() {
    return runtimeWords.filter((word) => isStatutoryCoreWord(word)).length;
  }

  function secureCoreCount(progressStore) {
    let count = 0;
    for (const word of runtimeWords) {
      if (!isStatutoryCoreWord(word)) continue;
      const progress = progressStore?.[word.slug];
      if (progress && Number(progress.stage) >= GUARDIAN_SECURE_STAGE) count += 1;
    }
    return count;
  }

  function isAllWordsMega(progressStore) {
    const total = coreWordCount();
    if (!total) return false;
    return secureCoreCount(progressStore) === total;
  }

  /**
   * P2 U2: First-graduation detection for the sticky `data.postMega` record.
   *
   * Two emission paths:
   *
   * **A. Fresh-graduation path** (the canonical U2 write). Requires THREE
   * conjunct conditions:
   *   1. Pre-submit `preSubmitAllMega === false` (learner was not graduated
   *      before this submit).
   *   2. Post-submit `postSubmitAllMega === true` (learner is graduated now).
   *   3. **Submit-caused-this guard (H1 fix)**: the just-submitted slug
   *      transitioned from stage `< 4` to stage `=== 4` in THIS submit.
   *
   * Without condition (3), a content-retirement edge that shrinks
   * `publishedCoreCount` (e.g. dropping two blocker slugs out of the core
   * pool) would flip `isAllWordsMega` from false to true on an already-Mega
   * slug's submit. The H1 guard pins emission to genuine learner action.
   *
   * Emitted with `unlockedBy: 'all-core-stage-4'`.
   *
   * **B. Pre-v3 backfill path** (reviewer adversarial fix — HIGH). Covers the
   * cohort who achieved `allWordsMega: true` under P1/P1.5 BEFORE U2 shipped.
   * Those learners have `data.postMega: null` and cannot graduate via path A
   * because path A's first conjunct (`preSubmitAllMega === false`) rejects
   * every submit — they're already at full Mega. Path B fires when:
   *   1. `preSubmitAllMega === true` (already graduated before this submit).
   *   2. `postSubmitAllMega === true` (still graduated after this submit).
   *   3. No persisted sticky-bit exists yet.
   * On first genuine write after U2 ships, the sticky-bit is persisted with
   * `unlockedBy: 'pre-v3-backfill'` so admins can distinguish it from genuine
   * stage-4 transitions in audit. The emitted event is the same type
   * (`spelling.post-mega.unlocked`) — downstream consumers gate on the
   * `contentReleaseId`, not `unlockedBy`.
   *
   * Returns either the newly-created postMega record (for event emission +
   * caller attribution) or null when no emission is warranted.
   *
   * The persistence is H3-idempotent at the storage-proxy layer: if the
   * proxy's `setItem` sees `data.postMega` already non-null inside its
   * critical section, it drops the write silently. The caller should still
   * check `priorRecord != null` to avoid emitting a duplicate event.
   */
  function detectAndPersistFirstGraduation({
    learnerId,
    preSubmitAllMega,
    postSubmitAllMega,
    submittedSlugPrevStage,
    submittedSlugNewStage,
  }) {
    if (postSubmitAllMega !== true) return null;
    // Defensive belt-and-braces: re-read the persisted sticky-bit. If
    // already set (e.g. a concurrent second tab beat us to the write), do
    // NOT emit a duplicate event. The storage proxy's H3 guard will also
    // refuse to overwrite, but callers should observe the same result.
    // Runs early so BOTH paths (fresh + backfill) share the dedup check.
    const priorRecord = loadPostMegaFromStorage(learnerId);
    if (priorRecord) return null;

    // Path B — pre-v3 backfill. Already-graduated learners without a sticky
    // record get one minted on their next submit. The H1 submit-caused-this
    // guard is intentionally bypassed here: the learner DID reach full Mega,
    // they just did it before U2 shipped. Emission on the first U2-era
    // submit restores audit parity.
    if (preSubmitAllMega === true) {
      const unlockedAt = clock();
      const publishedCoreCount = coreWordCount();
      const record = {
        unlockedAt,
        unlockedContentReleaseId: SPELLING_CONTENT_RELEASE_ID,
        unlockedPublishedCoreCount: publishedCoreCount,
        unlockedBy: 'pre-v3-backfill',
      };
      const saveResult = savePostMegaToStorage(learnerId, record);
      if (!saveResult || saveResult.ok === false) {
        // Storage failure on backfill write. Suppress emission so event +
        // sticky-bit stay in lockstep. Next submit re-detects and retries.
        return null;
      }
      return record;
    }

    // Path A — fresh graduation. H1 submit-caused-this guard.
    if (preSubmitAllMega !== false) return null;
    if (!Number.isFinite(Number(submittedSlugPrevStage))) return null;
    if (!Number.isFinite(Number(submittedSlugNewStage))) return null;
    if (Number(submittedSlugPrevStage) >= GUARDIAN_SECURE_STAGE) return null;
    if (Number(submittedSlugNewStage) < GUARDIAN_SECURE_STAGE) return null;
    const unlockedAt = clock();
    const publishedCoreCount = coreWordCount();
    const record = {
      unlockedAt,
      unlockedContentReleaseId: SPELLING_CONTENT_RELEASE_ID,
      unlockedPublishedCoreCount: publishedCoreCount,
      unlockedBy: 'all-core-stage-4',
    };
    // u2-corr-1 (LOW fix): propagate storage-failure. If the persistence
    // proxy throws (e.g. quota exceeded, private mode, disk full),
    // `savePostMegaToStorage` returns `{ ok: false }`. Suppress the event
    // so emission and sticky-bit stay in lockstep — the learner will retry
    // on the next submit, the guard will re-detect graduation, and the
    // write will be re-attempted. Mega never demotes because this write
    // happens AFTER progress has been persisted, so `progress.stage`
    // already reflects the graduation even when the sticky-bit write fails.
    const saveResult = savePostMegaToStorage(learnerId, record);
    if (!saveResult || saveResult.ok === false) {
      return null;
    }
    return record;
  }

  function getAnalyticsSnapshot(learnerId, { includeWordGroups = true } = {}) {
    const progressStore = progressSnapshot(learnerId);
    const snapshot = {
      version: SPELLING_SERVICE_STATE_VERSION,
      generatedAt: clock(),
      pools: {
        all: getStats(learnerId, 'core', progressStore),
        core: getStats(learnerId, 'core', progressStore),
        y34: getStats(learnerId, 'y3-4', progressStore),
        y56: getStats(learnerId, 'y5-6', progressStore),
        secureExtension: getStats(learnerId, 'secure-extension', progressStore),
        extra: getStats(learnerId, 'extra', progressStore),
      },
    };
    if (includeWordGroups) snapshot.wordGroups = analyticsWordGroups(learnerId, progressStore);
    return snapshot;
  }

  /**
   * Live post-mastery snapshot for UI consumers. Derives the same aggregates
   * as `getSpellingPostMasteryState` (read-model) but against the in-memory
   * service state so the Setup scene, Alt+4 gate, and summary copy see a
   * consistent view without drilling a read-model through the container tree.
   *
   * Returns: { allWordsMega, guardianDueCount, wobblingCount, nextGuardianDueDay,
   *            todayDay, guardianMap, wobblingDueCount, nonWobblingDueCount,
   *            unguardedMegaCount, guardianAvailableCount, guardianMissionState,
   *            guardianMissionAvailable }
   * The raw `guardianMap` is included so UI consumers can compute per-word
   * labels (e.g. "Wobbling — due tomorrow") via `guardianLabel` without a
   * second round-trip to storage. U1 additions mirror the read-model selector
   * shape so the dashboard gate (`guardianMissionAvailable`) and the labelled
   * state (`guardianMissionState`) read the same value whether they are fed
   * by the live service or the pre-computed read-model.
   */
  function getPostMasteryState(learnerId) {
    const progressStore = progressSnapshot(learnerId) || {};
    const guardianMap = loadGuardianMap(learnerId);
    const today = currentTodayDay();
    const allWordsMegaNow = isAllWordsMega(progressStore);
    // P2 U2: sticky-graduation record. Null when never graduated.
    const postMegaRecord = loadPostMegaFromStorage(learnerId);
    // P2 U11: Pattern Quest wobble sibling.
    const patternRecord = loadPatternFromStorage(learnerId);
    const publishedCoreCount = coreWordCount();

    // Shared derivation — same helper feeds `getSpellingPostMasteryState`
    // in the read-model so service and read-model cannot drift. U2 orphan
    // sanitiser lives inside the helper (via `isGuardianEligibleSlug`), so
    // a content hot-swap removing a slug automatically drops it from the
    // counts here and in the read-model.
    const aggregates = deriveGuardianAggregates({
      guardianMap,
      progressMap: progressStore,
      wordBySlug: runtimeWordBySlug,
      todayDay: today,
    });

    const guardianAvailableCount = aggregates.unguardedMegaCount + aggregates.eligibleGuardianEntries.length;
    const guardianMissionState = computeGuardianMissionState({
      allWordsMega: allWordsMegaNow,
      eligibleGuardianEntries: aggregates.eligibleGuardianEntries,
      unguardedMegaCount: aggregates.unguardedMegaCount,
      todayDay: today,
      policy: { allowOptionalPatrol: true },
    });
    const guardianMissionAvailable = guardianMissionState !== 'locked' && guardianMissionState !== 'rested';
    const postMegaUnlockedEver = postMegaRecord != null;
    const postMegaDashboardAvailable = allWordsMegaNow || postMegaUnlockedEver;
    const unlockedPublishedCoreCount = postMegaRecord
      ? Number(postMegaRecord.unlockedPublishedCoreCount) || 0
      : 0;
    const newCoreWordsSinceGraduation = postMegaUnlockedEver
      ? Math.max(0, publishedCoreCount - unlockedPublishedCoreCount)
      : 0;

    // P2 U11: compute `launchedPatternIds` from the live content snapshot
    // so the UI can render only patterns that currently pass the ≥4
    // threshold. Orphan pattern wobbles (slug retired mid-session) are
    // preserved in the map but excluded here via `isPatternEligibleSlug`.
    const patternIdsBySlug = {};
    for (const slug of Object.keys(progressStore)) {
      if (!isGuardianEligibleSlug(slug, progressStore, runtimeWordBySlug)) continue;
      const word = runtimeWordBySlug[slug];
      if (!word || !Array.isArray(word.patternIds)) continue;
      patternIdsBySlug[slug] = word.patternIds.slice();
    }
    const launchedPatternIds = computeLaunchedPatternIds(patternIdsBySlug);

    return {
      // P2 U2 alias — kept for one release to avoid churning every gate
      // site at once. New consumers should gate on
      // `postMegaDashboardAvailable` instead.
      allWordsMega: allWordsMegaNow,
      allWordsMegaNow,
      postMegaUnlockedEver,
      postMegaDashboardAvailable,
      newCoreWordsSinceGraduation,
      publishedCoreCount,
      guardianDueCount: aggregates.guardianDueCount,
      wobblingCount: aggregates.wobblingCount,
      wobblingDueCount: aggregates.wobblingDueCount,
      nonWobblingDueCount: aggregates.nonWobblingDueCount,
      unguardedMegaCount: aggregates.unguardedMegaCount,
      guardianAvailableCount,
      guardianMissionState,
      guardianMissionAvailable,
      nextGuardianDueDay: aggregates.nextGuardianDueDay,
      todayDay: today,
      guardianMap,
      // P2 U11: pattern-quest hydration.
      patternMap: patternRecord,
      launchedPatternIds,
    };
  }

  function buildResumeSession(rawSession, learnerId) {
    if (!rawSession || typeof rawSession !== 'object' || Array.isArray(rawSession)) {
      return { session: null, summary: null, error: 'This spelling session is missing its saved state.' };
    }

    const raw = cloneSerialisable(rawSession);
    const heroContext = cloneHeroContext(raw.heroContext);
    const type = SPELLING_SESSION_TYPES.includes(raw.type) ? raw.type : null;
    if (!type) {
      return { session: null, summary: null, error: 'This spelling session has an unknown type.' };
    }

    let currentSlug = isRuntimeKnownSlug(raw.currentSlug) ? raw.currentSlug : null;
    let uniqueWords = uniqueStrings(normaliseStringArray(raw.uniqueWords, isRuntimeKnownSlug));
    if (currentSlug && !uniqueWords.includes(currentSlug)) uniqueWords = [...uniqueWords, currentSlug];
    if (!uniqueWords.length) {
      return { session: null, summary: null, error: 'This spelling session no longer points at valid words.' };
    }

    const mode = normaliseMode(raw.mode, type === 'test' ? 'test' : 'smart');
    const savedPrompt = savedPromptForSlug(raw, currentSlug, runtimeWordBySlug);
    const session = {
      version: SPELLING_SERVICE_STATE_VERSION,
      id: normaliseString(raw.id, `sess-${clock()}-${randomFn().toString(16).slice(2)}`),
      type,
      mode,
      label: normaliseString(raw.label, defaultLabelForMode(mode)),
      practiceOnly: normaliseBoolean(raw.practiceOnly, false) && type !== 'test',
      fallbackToSmart: normaliseBoolean(raw.fallbackToSmart, false),
      extraWordFamilies: normaliseBoolean(raw.extraWordFamilies, false) && type !== 'test',
      profileId: normaliseString(raw.profileId, learnerId || 'default'),
      uniqueWords,
      queue: [],
      status: {},
      results: [],
      sentenceHistory: raw.sentenceHistory && typeof raw.sentenceHistory === 'object' && !Array.isArray(raw.sentenceHistory)
        ? raw.sentenceHistory
        : {},
      currentSlug,
      currentPrompt: savedPrompt,
      phase: type === 'test'
        ? 'question'
        : (SPELLING_SESSION_PHASES.includes(raw.phase) ? raw.phase : 'question'),
      promptCount: normaliseNonNegativeInteger(raw.promptCount, 0),
      lastFamily: normaliseOptionalString(raw.lastFamily),
      lastYear: normaliseOptionalString(raw.lastYear),
      startedAt: normaliseTimestamp(raw.startedAt, clock()),
      ...(heroContext ? { heroContext } : {}),
      guardianResults: mode === 'guardian' && raw.guardianResults && typeof raw.guardianResults === 'object' && !Array.isArray(raw.guardianResults)
        ? { ...raw.guardianResults }
        : (mode === 'guardian' ? {} : undefined),
      // P2 U11: Pattern Quest bookkeeping survives rehydrate only when the
      // resumed session claims mode='pattern-quest'. All fields are shape-
      // checked so a corrupt persisted blob cannot crash the resume.
      patternQuestPatternId: mode === 'pattern-quest' && typeof raw.patternQuestPatternId === 'string'
        ? raw.patternQuestPatternId
        : (mode === 'pattern-quest' ? '' : undefined),
      patternQuestCards: mode === 'pattern-quest' && Array.isArray(raw.patternQuestCards)
        ? raw.patternQuestCards
            .filter((card) => card && typeof card === 'object' && typeof card.type === 'string' && typeof card.slug === 'string')
            .map((card) => cloneSerialisable(card))
        : (mode === 'pattern-quest' ? [] : undefined),
      patternQuestCardIndex: mode === 'pattern-quest'
        ? normaliseNonNegativeInteger(raw.patternQuestCardIndex, 0)
        : undefined,
      patternQuestResults: mode === 'pattern-quest' && Array.isArray(raw.patternQuestResults)
        ? raw.patternQuestResults
            .filter((entry) => entry && typeof entry === 'object')
            .map((entry) => ({
              type: normaliseString(entry.type),
              slug: normaliseString(entry.slug),
              patternId: normaliseString(entry.patternId),
              correct: entry.correct === true,
              answer: normaliseString(entry.answer),
              ...(entry.closeMiss === true ? { closeMiss: true } : {}),
            }))
        : (mode === 'pattern-quest' ? [] : undefined),
      patternQuestWobbledSlugs: mode === 'pattern-quest' && Array.isArray(raw.patternQuestWobbledSlugs)
        ? uniqueStrings(normaliseStringArray(raw.patternQuestWobbledSlugs))
        : (mode === 'pattern-quest' ? [] : undefined),
      patternQuestSeedSlugs: mode === 'pattern-quest' && Array.isArray(raw.patternQuestSeedSlugs)
        ? uniqueStrings(normaliseStringArray(raw.patternQuestSeedSlugs))
        : (mode === 'pattern-quest' ? uniqueWords.slice() : undefined),
    };

    if (currentSlug && !session.currentPrompt) {
      session.currentPrompt = buildPrompt(engine, session, currentSlug, runtimeWordBySlug);
    }

    if (type === 'learning') {
      const existingStatus = raw.status && typeof raw.status === 'object' && !Array.isArray(raw.status)
        ? raw.status
        : {};
      for (const slug of uniqueWords) {
        const progress = engine.getProgress(learnerId, slug);
        session.status[slug] = normaliseLearningStatus(existingStatus[slug], progress.attempts === 0 ? 2 : 1);
      }
    }

    if (type === 'test') {
      session.results = normaliseTestResults(raw.results, uniqueWords);
    }

    const queued = uniqueStrings(normaliseStringArray(raw.queue, isRuntimeKnownSlug));
    if (queued.length) {
      session.queue = queued;
    } else if (type === 'learning') {
      session.queue = uniqueWords.filter((slug) => slug !== currentSlug && !session.status[slug]?.done);
    } else {
      const answered = new Set(session.results.map((entry) => entry.slug));
      session.queue = uniqueWords.filter((slug) => slug !== currentSlug && !answered.has(slug));
    }

    if (session.currentSlug && !runtimeWordBySlug[session.currentSlug]) {
      session.currentSlug = null;
      session.currentPrompt = null;
    }

    if (!session.currentSlug) {
      // P2 U11: Pattern Quest resume — if there is still a card in-flight at
      // `patternQuestCardIndex`, rebuild the prompt from that card. If the
      // pointer has run off the end, finalise via buildPatternQuestSummary.
      if (session.mode === 'pattern-quest') {
        const cards = Array.isArray(session.patternQuestCards) ? session.patternQuestCards : [];
        const idx = Number.isInteger(session.patternQuestCardIndex) ? session.patternQuestCardIndex : 0;
        if (idx >= cards.length) {
          return {
            session: null,
            summary: buildPatternQuestSummary(session),
            error: '',
          };
        }
        const card = cards[idx];
        const word = runtimeWordBySlug[card.slug];
        if (word) {
          session.currentSlug = card.slug;
          session.currentPrompt = {
            slug: card.slug,
            word: word.word,
            accepted: acceptedForPrompt(word.accepted, word.word),
            explanation: word.explanation || '',
            sentence: word.sentence || '',
            cloze: buildCloze(word.sentence || '', word.word),
          };
        }
      } else {
        const next = session.mode === 'guardian'
          ? advanceGuardianCard(session)
          : engine.advanceCard(session, learnerId);
        if (next.done) {
          const summary = normaliseSummary(engine.finalise(session), isRuntimeKnownSlug);
          if (summary) summary.heroContext = resolvedContext.extractSummaryContext(session);
          return {
            session: null,
            summary,
            error: '',
          };
        }
      }
    }

    return {
      session: decorateSession(engine, learnerId, session, runtimeWordBySlug),
      summary: null,
      error: '',
    };
  }

  function initState(rawState = null, learnerId = null) {
    const source = rawState && typeof rawState === 'object' && !Array.isArray(rawState)
      ? copyState(rawState)
      : createInitialSpellingState();

    let phase = SPELLING_ROOT_PHASES.includes(source.phase) ? source.phase : 'dashboard';
    let feedback = normaliseFeedback(source.feedback);
    let summary = normaliseSummary(source.summary, isRuntimeKnownSlug);
    let error = normaliseString(source.error);
    let session = null;
    let awaitingAdvance = normaliseBoolean(source.awaitingAdvance, false);

    if (phase === 'summary') {
      if (!summary) {
        return {
          ...createInitialSpellingState(),
          error: error || 'This spelling summary could not be restored.',
        };
      }
      return {
        version: SPELLING_SERVICE_STATE_VERSION,
        phase: 'summary',
        session: null,
        feedback: null,
        summary,
        error: '',
        awaitingAdvance: false,
      };
    }

    if (phase === 'session') {
      const restored = buildResumeSession(source.session, learnerId);
      if (restored.summary) {
        return {
          version: SPELLING_SERVICE_STATE_VERSION,
          phase: 'summary',
          session: null,
          feedback: null,
          summary: restored.summary,
          error: '',
          awaitingAdvance: false,
        };
      }

      if (!restored.session) {
        return {
          ...createInitialSpellingState(),
          error: restored.error || error || 'This spelling session could not be resumed.',
        };
      }

      session = restored.session;
      feedback = normaliseFeedback(source.feedback);
      awaitingAdvance = awaitingAdvance && Boolean(feedback);
      error = '';

      return {
        version: SPELLING_SERVICE_STATE_VERSION,
        phase: 'session',
        session,
        feedback,
        summary: null,
        error,
        awaitingAdvance,
      };
    }

    if (phase === 'word-bank') {
      return {
        version: SPELLING_SERVICE_STATE_VERSION,
        phase: 'word-bank',
        session: null,
        feedback: null,
        summary: null,
        error,
        awaitingAdvance: false,
      };
    }

    return {
      version: SPELLING_SERVICE_STATE_VERSION,
      phase: 'dashboard',
      session: null,
      feedback: null,
      summary: null,
      error,
      awaitingAdvance: false,
    };
  }

  function activeAudioCue(learnerId, state, slow = false) {
    const prefs = getPrefs(learnerId);
    if (!prefs.autoSpeak) return null;
    const word = state?.session?.currentCard?.word;
    if (!word) return null;
    return {
      word,
      sentence: state.session.currentCard.prompt?.sentence,
      slow,
    };
  }

  function startGuardianSession(learnerId, options = {}) {
    const progressStore = progressSnapshot(learnerId) || {};
    if (!isAllWordsMega(progressStore)) {
      return buildTransition({
        ...createInitialSpellingState(),
        feedback: {
          kind: 'warn',
          headline: 'Guardian Mission unlocks after every core word is secure',
          body: 'Keep reviewing Smart Review and Trouble Drill until every core word is secure — then Guardian Mission opens.',
        },
      }, { ok: false });
    }

    const today = currentTodayDay();
    const guardianMap = loadGuardianMap(learnerId);
    const desiredLength = options.length === 'all'
      ? GUARDIAN_MAX_ROUND_LENGTH
      : clampSelectionLength(Number(options.length) || GUARDIAN_DEFAULT_ROUND_LENGTH);

    const selectedSlugs = selectGuardianWords({
      guardianMap,
      progressMap: progressStore,
      wordBySlug: runtimeWordBySlug,
      todayDay: today,
      length: desiredLength,
      random: randomFn,
    });

    if (!selectedSlugs.length) {
      return buildTransition({
        ...createInitialSpellingState(),
        feedback: {
          kind: 'info',
          headline: 'No Guardian duties today',
          body: 'Every guarded word is still holding — come back tomorrow for the next Guardian Mission.',
        },
      }, { ok: false });
    }

    const selectedWords = selectedSlugs.map((slug) => runtimeWordBySlug[slug]).filter(Boolean);
    if (!selectedWords.length) {
      return buildTransition({
        ...createInitialSpellingState(),
        error: 'Guardian Mission could not resolve any words.',
      }, { ok: false });
    }

    const created = engine.createSession({
      profileId: learnerId,
      mode: 'guardian',
      yearFilter: 'core',
      length: selectedWords.length,
      words: selectedWords,
      practiceOnly: false,
      extraWordFamilies: false,
    });

    if (!created.ok) {
      return buildTransition({
        ...createInitialSpellingState(),
        error: created.reason || 'Could not start a Guardian Mission.',
      }, { ok: false });
    }

    // Legacy createSession labels 'guardian' as 'Smart review' via fallthrough.
    // Stamp the Guardian Mission label + mission-scoped bookkeeping here.
    created.session.mode = 'guardian';
    created.session.label = 'Guardian Mission';
    created.session.guardianResults = {};
    const heroContext = cloneHeroContext(options.heroContext);
    if (heroContext) created.session.heroContext = heroContext;

    const firstCard = advanceGuardianCard(created.session);
    if (firstCard.done) {
      return buildTransition({
        ...createInitialSpellingState(),
        error: 'Guardian Mission could not prepare the first card.',
      }, { ok: false });
    }

    const session = decorateSession(engine, learnerId, created.session, runtimeWordBySlug, created.progressStore);
    const nextState = {
      version: SPELLING_SERVICE_STATE_VERSION,
      phase: 'session',
      session,
      feedback: null,
      summary: null,
      error: '',
      awaitingAdvance: false,
    };

    persistence.syncPracticeSession(learnerId, nextState);
    return buildTransition(nextState, { audio: activeAudioCue(learnerId, nextState) });
  }

  // U9: Boss Dictation entry point. Mirrors `startGuardianSession` but the
  // word-selection rule is "uniform random sample of core-pool Mega slugs" and
  // the session is forcibly shaped as `type: 'test'` (single-attempt, no cloze,
  // no skip). Round-length clamp lives in `clampBossRoundLength`.
  //
  // The critical bridge is `words: preSelectedWordObjects` on the
  // `engine.createSession` call — without it the engine falls through to
  // `chooseSmartWords` at `legacy-engine.js:461` and the Boss round becomes a
  // Smart Review sample of due/weak words instead of a Mega-only round.
  function startBossSession(learnerId, options = {}) {
    const progressStore = progressSnapshot(learnerId) || {};
    if (!isAllWordsMega(progressStore)) {
      return buildTransition({
        ...createInitialSpellingState(),
        feedback: {
          kind: 'warn',
          headline: 'Boss Dictation unlocks after every core word is secure',
          body: 'Keep reviewing Smart Review and Trouble Drill until every core word is secure — then Boss Dictation opens.',
        },
      }, { ok: false });
    }

    const desiredLength = options.length === 'all'
      ? BOSS_MAX_ROUND_LENGTH
      : clampBossRoundLength(options.length);

    const selectedSlugs = selectBossWords({
      progressMap: progressStore,
      wordBySlug: runtimeWordBySlug,
      length: desiredLength,
      random: randomFn,
    });

    if (!selectedSlugs.length) {
      return buildTransition({
        ...createInitialSpellingState(),
        error: 'Boss Dictation could not resolve any words.',
      }, { ok: false });
    }

    const selectedWords = selectedSlugs.map((slug) => runtimeWordBySlug[slug]).filter(Boolean);
    if (!selectedWords.length) {
      return buildTransition({
        ...createInitialSpellingState(),
        error: 'Boss Dictation could not resolve any words.',
      }, { ok: false });
    }

    const created = engine.createSession({
      profileId: learnerId,
      mode: 'boss',
      yearFilter: 'core',
      length: selectedWords.length,
      words: selectedWords, // load-bearing: without this the engine falls through to chooseSmartWords
      practiceOnly: false,
      extraWordFamilies: false,
    });

    if (!created.ok) {
      return buildTransition({
        ...createInitialSpellingState(),
        error: created.reason || 'Could not start Boss Dictation.',
      }, { ok: false });
    }

    // Type override is mandatory. `legacy-engine.js:490` forces
    // `type: 'learning'` for any non-TEST mode. Boss must explicitly overwrite
    // `session.type = 'test'` so the session-UI helpers, engine.advanceCard
    // (test-typed FIFO path), and engine.finalise (testSummary) all treat this
    // as a test-shaped round. Mirrors Guardian's override at the same spot.
    created.session.type = 'test';
    created.session.mode = 'boss';
    created.session.label = 'Boss Dictation';
    // `session.results` is consumed by testSummary; initialise the array so
    // `submitBossAnswer` can push per-answer results deterministically.
    created.session.results = [];
    const heroContext = cloneHeroContext(options.heroContext);
    if (heroContext) created.session.heroContext = heroContext;
    // Seed-roster contract: uniqueWords is the roster for Boss. A Boss
    // session is strict FIFO over selectBossWords — no card is ever
    // re-queued (engine.advanceCard test-typed path at
    // legacy-engine.js:586-591 just shifts the queue head), so
    // uniqueWords is identical at start and at finalise-time. The
    // BOSS_COMPLETED event factory reads session.uniqueWords.slice() as
    // the seedSlugs payload; bossEventsForSession passes a fresh slice
    // through. We deliberately do NOT stamp a separate `bossSeedSlugs`
    // field on the session — buildResumeSession enumerates session
    // fields explicitly and any unlisted field would be dropped on
    // rehydration, so an orphan `bossSeedSlugs` would quietly disappear
    // after an in-flight session resume and mask its own loss.

    // For a test-typed session, engine.advanceCard shifts the queue head via
    // strict FIFO (`legacy-engine.js:586-591`). Use that path — no custom
    // advancer is needed because Boss's FIFO-over-presorted-queue contract
    // matches the engine's test path exactly.
    const firstCard = engine.advanceCard(created.session, learnerId, created.progressStore);
    if (firstCard.done) {
      return buildTransition({
        ...createInitialSpellingState(),
        error: 'Boss Dictation could not prepare the first card.',
      }, { ok: false });
    }

    const session = decorateSession(engine, learnerId, created.session, runtimeWordBySlug, created.progressStore);
    const nextState = {
      version: SPELLING_SERVICE_STATE_VERSION,
      phase: 'session',
      session,
      feedback: null,
      summary: null,
      error: '',
      awaitingAdvance: false,
    };

    persistence.syncPracticeSession(learnerId, nextState);
    return buildTransition(nextState, { audio: activeAudioCue(learnerId, nextState) });
  }

  // P2 U11: Pattern Quest session starter. Gated on allWordsMega (post-Mega
  // surface) AND on the pattern id being a member of the registry AND having
  // ≥ PATTERN_QUEST_ROUND_LENGTH - 1 eligible core words. Failing any check
  // returns a warning transition identical in shape to Guardian / Boss.
  function startPatternQuestSession(learnerId, options = {}) {
    const progressStore = progressSnapshot(learnerId) || {};
    if (!isAllWordsMega(progressStore)) {
      return buildTransition({
        ...createInitialSpellingState(),
        feedback: {
          kind: 'warn',
          headline: 'Pattern Quest unlocks after every core word is secure',
          body: 'Keep reviewing Smart Review and Trouble Drill until every core word is secure — then Pattern Quest opens.',
        },
      }, { ok: false });
    }

    const patternId = typeof options.patternId === 'string' ? options.patternId : '';
    if (!patternId || !Object.prototype.hasOwnProperty.call(SPELLING_PATTERNS, patternId)) {
      return buildTransition({
        ...createInitialSpellingState(),
        error: 'Pattern Quest could not find that pattern.',
      }, { ok: false });
    }

    // U10 launch-threshold gate. If the pattern has fewer than 4 eligible
    // core words, refuse to start so the UI can show "Not enough words in
    // this pattern yet." without the service fabricating a short round.
    const patternIdsBySlug = {};
    for (const slug of Object.keys(progressStore)) {
      if (!isGuardianEligibleSlug(slug, progressStore, runtimeWordBySlug)) continue;
      const word = runtimeWordBySlug[slug];
      if (!word || !Array.isArray(word.patternIds)) continue;
      patternIdsBySlug[slug] = word.patternIds.slice();
    }
    const launched = computeLaunchedPatternIds(patternIdsBySlug);
    if (!launched.includes(patternId)) {
      return buildTransition({
        ...createInitialSpellingState(),
        feedback: {
          kind: 'info',
          headline: 'Not enough words in this pattern yet',
          body: 'Pattern Quest needs at least 4 core words tagged with this pattern. Come back after more words graduate to Mega.',
        },
      }, { ok: false });
    }

    const cards = selectPatternQuestCards({
      patternId,
      progressMap: progressStore,
      wordBySlug: runtimeWordBySlug,
      random: randomFn,
    });
    if (!cards.length) {
      return buildTransition({
        ...createInitialSpellingState(),
        feedback: {
          kind: 'info',
          headline: 'Not enough words in this pattern yet',
          body: 'Pattern Quest needs at least 4 core words tagged with this pattern.',
        },
      }, { ok: false });
    }

    // Build the session shape manually — Pattern Quest does not ride on the
    // legacy engine's queue/phase state machine. `type: 'learning'` keeps
    // session-ui helpers that branch on `type === 'test'` from leaking SATs
    // copy; the `mode === 'pattern-quest'` override steers every
    // pattern-specific helper to the Pattern Quest shape.
    const sessionId = `sess-${clock()}-${randomFn().toString(16).slice(2)}`;
    const slugs = Array.from(new Set(cards.map((card) => card.slug).filter(Boolean)));
    const firstCard = cards[0];
    const firstWord = runtimeWordBySlug[firstCard.slug];
    const session = {
      version: SPELLING_SERVICE_STATE_VERSION,
      id: sessionId,
      type: 'learning',
      mode: 'pattern-quest',
      label: 'Pattern Quest',
      practiceOnly: false,
      fallbackToSmart: false,
      extraWordFamilies: false,
      profileId: learnerId || 'default',
      uniqueWords: slugs,
      queue: [],
      status: {},
      results: [],
      sentenceHistory: {},
      currentSlug: firstCard.slug,
      currentPrompt: firstWord
        ? {
            slug: firstCard.slug,
            word: firstWord.word,
            accepted: acceptedForPrompt(firstWord.accepted, firstWord.word),
            explanation: firstWord.explanation || '',
            sentence: firstWord.sentence || '',
            cloze: buildCloze(firstWord.sentence || '', firstWord.word),
          }
        : null,
      phase: 'question',
      promptCount: 0,
      lastFamily: firstWord?.family || null,
      lastYear: firstWord?.year || null,
      startedAt: clock(),
      patternQuestPatternId: patternId,
      patternQuestCards: cards,
      patternQuestCardIndex: 0,
      patternQuestResults: [],
      patternQuestWobbledSlugs: [],
      patternQuestSeedSlugs: slugs,
    };
    const heroContext = cloneHeroContext(options.heroContext);
    if (heroContext) session.heroContext = heroContext;

    const decorated = decorateSession(engine, learnerId, session, runtimeWordBySlug);
    const nextState = {
      version: SPELLING_SERVICE_STATE_VERSION,
      phase: 'session',
      session: decorated,
      feedback: null,
      summary: null,
      error: '',
      awaitingAdvance: false,
    };
    persistence.syncPracticeSession(learnerId, nextState);
    return buildTransition(nextState, { audio: activeAudioCue(learnerId, nextState) });
  }

  function startSession(learnerId, options = {}) {
    const mode = normaliseMode(options.mode, 'smart');
    if (mode === 'guardian') {
      return startGuardianSession(learnerId, options);
    }
    if (mode === 'boss') {
      return startBossSession(learnerId, options);
    }
    if (mode === 'pattern-quest') {
      return startPatternQuestSession(learnerId, options);
    }
    const yearFilter = mode === 'test'
      ? 'core'
      : normaliseYearFilter(options.yearFilter, 'core');
    const requestedWords = Array.isArray(options.words)
      ? uniqueStrings(options.words.map((slug) => normaliseString(slug).toLowerCase()).filter(Boolean))
      : null;
    const selectedWords = Array.isArray(options.words)
      ? uniqueStrings(options.words.map((slug) => (isRuntimeKnownSlug(slug) ? runtimeWordBySlug[slug] : null)).filter(Boolean).map((word) => word.slug)).map((slug) => runtimeWordBySlug[slug])
      : null;
    const length = mode === 'test'
      ? 20
      : options.length === 'all'
        ? Number.MAX_SAFE_INTEGER
        : Number(options.length) || 20;
    const practiceOnly = normaliseBoolean(options.practiceOnly, false) && mode !== 'test';

    if (requestedWords?.length && !selectedWords?.length) {
      return buildTransition({
        ...createInitialSpellingState(),
        error: 'Could not start a spelling session.',
      }, { ok: false });
    }

    const created = engine.createSession({
      profileId: learnerId,
      mode,
      yearFilter,
      length,
      words: selectedWords,
      practiceOnly,
      extraWordFamilies: normaliseBoolean(options.extraWordFamilies, false) && yearFilter === 'extra',
    });

    if (!created.ok) {
      return buildTransition({
        ...createInitialSpellingState(),
        error: created.reason || 'Could not start a spelling session.',
      }, { ok: false });
    }

    const heroContext = cloneHeroContext(options.heroContext);
    if (heroContext) created.session.heroContext = heroContext;

    const firstCard = engine.advanceCard(created.session, learnerId, created.progressStore);
    const session = firstCard.done ? null : decorateSession(engine, learnerId, created.session, runtimeWordBySlug, created.progressStore);
    if (!session) {
      return buildTransition({
        ...createInitialSpellingState(),
        error: 'Could not prepare the first spelling card.',
      }, { ok: false });
    }

    const nextState = {
      version: SPELLING_SERVICE_STATE_VERSION,
      phase: 'session',
      session,
      feedback: created.fallback
        ? {
            kind: 'warn',
            headline: 'Trouble drill fell back to Smart Review.',
            body: 'There were no active trouble words, so the engine built a mixed review round instead.',
          }
        : null,
      summary: null,
      error: '',
      awaitingAdvance: false,
    };

    persistence.syncPracticeSession(learnerId, nextState);
    return buildTransition(nextState, { audio: activeAudioCue(learnerId, nextState) });
  }

  function invalidSessionTransition(message) {
    return buildTransition({
      ...createInitialSpellingState(),
      error: message,
    }, { ok: false });
  }

  function submitGuardianAnswer(learnerId, current, rawTyped) {
    const session = cloneSerialisable(current.session);
    const currentSlug = session.currentSlug;
    const baseWord = runtimeWordBySlug[currentSlug];
    if (!baseWord) {
      return invalidSessionTransition('This Guardian Mission card is missing its word metadata.');
    }
    // P2 U2: pre-submit graduation snapshot. Guardian only starts when the
    // learner is already Mega, so `preSubmitAllMega === true` and the H1
    // guard ALWAYS refuses first-graduation emission from this path. We
    // still capture the snapshot for consistency with `submitAnswer` and to
    // make the guard's operation auditable in tests.
    const preSubmitProgressStore = progressSnapshot(learnerId) || {};
    const preSubmitAllMega = isAllWordsMega(preSubmitProgressStore);
    const preSubmitStage = Number(preSubmitProgressStore?.[currentSlug]?.stage) || 0;
    const promptWord = wordForPrompt(baseWord, session.currentPrompt);
    const graded = engine.grade(promptWord, rawTyped);
    const correct = Boolean(graded.correct);

    // Session bookkeeping — single attempt per word, no retry/correction phase.
    const statusEntry = session.status?.[currentSlug] || {
      attempts: 0,
      successes: 0,
      needed: 1,
      hadWrong: false,
      wrongAnswers: [],
      done: false,
      applied: false,
    };
    statusEntry.attempts += 1;
    statusEntry.done = true;
    statusEntry.applied = true;
    if (correct) {
      statusEntry.successes = (statusEntry.successes || 0) + 1;
    } else {
      statusEntry.hadWrong = true;
      statusEntry.wrongAnswers = [...(statusEntry.wrongAnswers || []), rawTyped];
    }
    session.status = session.status || {};
    session.status[currentSlug] = statusEntry;
    session.promptCount = (session.promptCount || 0) + 1;
    session.phase = 'question';

    // Remove this slug from the queue (legacy engine pre-shifts on advanceCard,
    // but we also clean up defensively in case the queue still has the slug).
    if (Array.isArray(session.queue)) {
      session.queue = session.queue.filter((slug) => slug !== currentSlug);
    }

    // Update progress.attempts / correct / wrong only. Stage/dueDay/lastDay/
    // lastResult are preserved — Guardian never demotes Mega.
    const progressMap = loadProgressFromStorage(learnerId);
    const existingProgress = progressMap[currentSlug] && typeof progressMap[currentSlug] === 'object'
      ? progressMap[currentSlug]
      : { stage: 0, attempts: 0, correct: 0, wrong: 0, dueDay: 0, lastDay: null, lastResult: null };
    const nextProgress = { ...existingProgress };
    nextProgress.attempts = (nextProgress.attempts || 0) + 1;
    if (correct) nextProgress.correct = (nextProgress.correct || 0) + 1;
    else nextProgress.wrong = (nextProgress.wrong || 0) + 1;
    progressMap[currentSlug] = nextProgress;
    // U8: capture persistence outcomes for both writes so a single warning can
    // be surfaced on either failure, without demoting Mega. The session
    // continues in-memory whatever the storage outcome — the invariant
    // "stage >= 4" holds across the wrong-answer path already, and the
    // warning is additive on top of feedback.
    //
    // U8 review fix: we also snapshot the platform persistence channel's
    // `lastError` before the writes so a transient failure that the proxy
    // masked (e.g. a partial bundle write fault) still surfaces even if
    // the explicit writeJsonToStoragePort returns `ok: true`. In production the proxy
    // rethrows a fresh error via `errorSignatureChanged`, so writeJsonToStoragePort
    // catches it; this pre/post snapshot is belt-and-braces for hosts
    // that might add extra wrappers in the future.
    const beforeError = readPersistenceError();
    const progressSave = saveProgressToStorage(learnerId, progressMap);

    // Advance the guardian record. Lazy-create if this is the first Guardian
    // touch for the slug. We load a mutable copy for the read-side
    // (`ensureGuardianRecord` plus the wobbling inspection), then commit via
    // the per-slug `saveGuardianRecord` helper.
    //
    // U7 scope: this narrows the read-to-write window within a SINGLE service
    // instance. Two tabs each hold their own per-tab `repositories` cache, so
    // `saveGuardianRecord`'s reload only sees writes made through the same
    // cache — not writes from another tab. Closing the cross-tab race
    // requires the deferred `post-mega-spelling-storage-cas` plan
    // (navigator.locks + BroadcastChannel + writeVersion CAS).
    //
    // Composition note (U7-02, accepted limitation): `beforeRecord` is
    // captured here and used below to compute `wasWobbling` for the outcome
    // event. If another service instance concurrently writes the same slug
    // between this load and `saveGuardianRecord`'s internal reload, the event
    // still reports the outcome of THIS submission (renewed / recovered /
    // wobbled) against the state we observed — which matches user
    // expectations for the tab that actually produced the answer. The map on
    // storage ends last-writer-wins per slug. Full same-slug CAS is deferred
    // with the cross-tab work.
    //
    // Note: when U4's "I don't know" branch lands in `skipWord`, it must also
    // use `saveGuardianRecord` instead of the whole-map writer, otherwise the
    // "I don't know" wobble and a concurrent correct/wrong submit on the same
    // service instance can stomp each other. That wiring is owned by U4
    // itself; this comment is left here so the follow-up is obvious.
    const todayDay = currentTodayDay();
    const guardianMap = loadGuardianMap(learnerId);
    const beforeRecord = ensureGuardianRecord(guardianMap, currentSlug, todayDay);
    const wasWobbling = beforeRecord.wobbling === true;
    const updatedRecord = correct
      ? advanceGuardianOnCorrect(beforeRecord, todayDay)
      : advanceGuardianOnWrong(beforeRecord, todayDay);
    const guardianSave = saveGuardianRecord(learnerId, currentSlug, updatedRecord);
    // U8: a single persistenceWarning deduped across progress + guardian
    // saves. Whichever failed first is sufficient signal for the UI; the
    // banner is deduped per submit so a double failure still surfaces only
    // once.
    //
    // U8 review fix: also dedupe-in any lastError-channel change. The
    // sibling write helpers return `ok: false` on direct throw, but if a
    // host wraps the proxy with its own swallow, the channel diff still
    // catches the failure.
    const afterError = readPersistenceError();
    const lastErrorChanged = persistenceErrorSignatureChanged(beforeError, afterError);
    const persistenceWarning = (!progressSave?.ok || !guardianSave?.ok || lastErrorChanged)
      ? { reason: SPELLING_PERSISTENCE_WARNING_REASON.STORAGE_SAVE_FAILED }
      : null;
    // P2 U9: mirror the session-scoped `feedback.persistenceWarning` into
    // the durable `data.persistenceWarning` sibling so the banner survives
    // tab close. Write is bounded-retry + diagnostics.warn fallback — the
    // service path never crashes the submit even if the storage is
    // fundamentally broken (the very condition we're warning about).
    if (persistenceWarning) {
      writePersistenceWarning(learnerId, persistenceWarning.reason);
    }

    // Record the per-word outcome so the finalisation step can emit the
    // mission-completed event with accurate aggregate counts.
    const outcomeKind = !correct
      ? 'wobbled'
      : wasWobbling
        ? 'recovered'
        : 'renewed';
    session.guardianResults = session.guardianResults || {};
    session.guardianResults[currentSlug] = outcomeKind;

    const eventTime = clock();
    const events = [];
    if (outcomeKind === 'renewed') {
      events.push(createSpellingGuardianRenewedEvent({
        learnerId,
        session,
        slug: currentSlug,
        reviewLevel: updatedRecord.reviewLevel,
        nextDueDay: updatedRecord.nextDueDay,
        createdAt: eventTime,
        wordMeta: runtimeWordBySlug,
      }));
    } else if (outcomeKind === 'wobbled') {
      events.push(createSpellingGuardianWobbledEvent({
        learnerId,
        session,
        slug: currentSlug,
        lapses: updatedRecord.lapses,
        createdAt: eventTime,
        wordMeta: runtimeWordBySlug,
      }));
    } else {
      events.push(createSpellingGuardianRecoveredEvent({
        learnerId,
        session,
        slug: currentSlug,
        renewals: updatedRecord.renewals,
        reviewLevel: updatedRecord.reviewLevel,
        createdAt: eventTime,
        wordMeta: runtimeWordBySlug,
      }));
    }

    // P2 U2: first-graduation detection on the Guardian submit path. The H1
    // submit-caused-this guard will naturally refuse emission here — Guardian
    // only starts when `allWordsMega === true`, so `preSubmitAllMega` is
    // always true and the guard's first conjunct fails. Kept for audit
    // symmetry with `submitAnswer` / `submitBossAnswer`.
    const postSubmitProgressStoreG = progressSnapshot(learnerId) || {};
    const postSubmitAllMegaG = isAllWordsMega(postSubmitProgressStoreG);
    const postMegaUnlockG = detectAndPersistFirstGraduation({
      learnerId,
      preSubmitAllMega,
      postSubmitAllMega: postSubmitAllMegaG,
      submittedSlugPrevStage: preSubmitStage,
      submittedSlugNewStage: Number(postSubmitProgressStoreG?.[currentSlug]?.stage) || preSubmitStage,
    });
    if (postMegaUnlockG) {
      events.push(createSpellingPostMegaUnlockedEvent({
        learnerId,
        unlockedAt: postMegaUnlockG.unlockedAt,
        contentReleaseId: postMegaUnlockG.unlockedContentReleaseId,
        publishedCoreCount: postMegaUnlockG.unlockedPublishedCoreCount,
      }));
    }

    const daysUntilNextCheck = Math.max(0, updatedRecord.nextDueDay - todayDay);
    const feedback = correct
      ? {
          kind: wasWobbling ? 'success' : 'info',
          headline: wasWobbling ? 'Recovered.' : 'Guardian strong.',
          answer: promptWord.word,
          body: wasWobbling
            ? `This word is back under your guard. Next Guardian check in ${daysUntilNextCheck} day${daysUntilNextCheck === 1 ? '' : 's'}.`
            : `This word stays secure. Next Guardian check in ${daysUntilNextCheck} day${daysUntilNextCheck === 1 ? '' : 's'}.`,
        }
      : {
          kind: 'warn',
          headline: 'Wobbling.',
          answer: promptWord.word,
          body: 'Mega stays, but this word will return tomorrow for a Guardian check.',
          attemptedAnswer: rawTyped,
        };
    // U8: attach persistenceWarning so the UI can surface a subtle banner
    // without demoting Mega. The feedback normaliser accepts the optional
    // field; when null it is stripped from the feedback object.
    if (persistenceWarning) feedback.persistenceWarning = persistenceWarning;

    const nextState = {
      version: SPELLING_SERVICE_STATE_VERSION,
      phase: 'session',
      session: decorateSession(engine, learnerId, session, runtimeWordBySlug),
      feedback: normaliseFeedback(feedback),
      summary: null,
      error: '',
      awaitingAdvance: true,
    };

    persistence.syncPracticeSession(learnerId, nextState);
    // P2 U12: per-word Guardian events (renewed/recovered) feed the
    // Recovery Expert progress counter. Evaluator skips non-achievement-
    // relevant events; calling is safe on any emit shape.
    persistAchievementsForEmittedEvents(learnerId, events);
    return buildTransition(nextState, { events });
  }

  // U9: Boss Dictation submit path. Mirrors `submitGuardianAnswer` in shape
  // but does NOT touch the guardian map, and does NOT touch
  // `progress.stage` / `dueDay` / `lastDay` / `lastResult` — Boss's core
  // contract is Mega-never-revoked, same invariant that Guardian enforces via
  // its separate submit path.
  //
  // Critical routing rule: `submitAnswer` must call this BEFORE the
  // `session.type === 'test'` check that routes legacy SATs submissions to
  // `engine.submitTest → applyTestOutcome`. Because Boss sessions are
  // `type: 'test'`-shaped, falling through to the legacy path would demote
  // Mega on a wrong answer.
  function submitBossAnswer(learnerId, current, rawTyped) {
    const session = cloneSerialisable(current.session);
    const currentSlug = session.currentSlug;
    const baseWord = runtimeWordBySlug[currentSlug];
    if (!baseWord) {
      return invalidSessionTransition('This Boss Dictation card is missing its word metadata.');
    }
    // P2 U2: pre-submit graduation snapshot. Boss only starts when the
    // learner is Mega, so H1 guard refuses first-graduation emission.
    const preSubmitProgressStoreB = progressSnapshot(learnerId) || {};
    const preSubmitAllMegaB = isAllWordsMega(preSubmitProgressStoreB);
    const preSubmitStageB = Number(preSubmitProgressStoreB?.[currentSlug]?.stage) || 0;
    const promptWord = wordForPrompt(baseWord, session.currentPrompt);
    const graded = engine.grade(promptWord, rawTyped);
    const correct = Boolean(graded.correct);

    // Record the per-answer entry on the test-typed `session.results` array so
    // the engine's `testSummary` renders the score card `correct/total` on
    // round-end. The engine's native `submitTest` does this too; we mirror the
    // shape exactly so the summary payload is indistinguishable from a SATs
    // test (minus the demotion) at the UI layer.
    session.results = Array.isArray(session.results) ? session.results : [];
    session.results.push({ slug: currentSlug, answer: rawTyped, correct });

    session.phase = 'question';
    session.promptCount = (session.promptCount || 0) + 1;

    // Update progress.attempts / correct / wrong only. Stage / dueDay /
    // lastDay / lastResult are preserved — Boss never demotes Mega.
    //
    // Mega-never-revoked guard: if `progressMap[currentSlug]` is missing or
    // malformed (e.g. a storage-clear race between selectBossWords and the
    // first submit), we REFUSE the write rather than synthesise a fresh
    // `{ stage: 0, ... }` seed. Writing stage:0 for a word that selectBossWords
    // only offered because it was at Mega (stage:4) would silently demote
    // Mega and contradict the invariant the summary copy and footer note
    // already advertise. Return an error transition so the UI surfaces the
    // inconsistency instead of masking it.
    const progressMap = loadProgressFromStorage(learnerId);
    const existingProgress = progressMap[currentSlug];
    if (!existingProgress || typeof existingProgress !== 'object' || Array.isArray(existingProgress)) {
      return invalidSessionTransition('This Boss Dictation word lost its Mega progress mid-round. The round was stopped to protect your Mega count.');
    }
    const nextProgress = { ...existingProgress };
    nextProgress.attempts = (nextProgress.attempts || 0) + 1;
    if (correct) nextProgress.correct = (nextProgress.correct || 0) + 1;
    else nextProgress.wrong = (nextProgress.wrong || 0) + 1;
    progressMap[currentSlug] = nextProgress;
    saveProgressToStorage(learnerId, progressMap);

    const events = [];
    // P2 U2: first-graduation detection on the Boss submit path. Boss only
    // starts post-Mega and never changes `progress.stage`, so the H1 guard
    // ALWAYS refuses — preSubmitAllMega is true AND the submitted slug's
    // stage is already 4. Kept here for audit symmetry.
    const postSubmitProgressStoreB = progressSnapshot(learnerId) || {};
    const postSubmitAllMegaB = isAllWordsMega(postSubmitProgressStoreB);
    const postMegaUnlockB = detectAndPersistFirstGraduation({
      learnerId,
      preSubmitAllMega: preSubmitAllMegaB,
      postSubmitAllMega: postSubmitAllMegaB,
      submittedSlugPrevStage: preSubmitStageB,
      submittedSlugNewStage: Number(postSubmitProgressStoreB?.[currentSlug]?.stage) || preSubmitStageB,
    });
    if (postMegaUnlockB) {
      events.push(createSpellingPostMegaUnlockedEvent({
        learnerId,
        unlockedAt: postMegaUnlockB.unlockedAt,
        contentReleaseId: postMegaUnlockB.unlockedContentReleaseId,
        publishedCoreCount: postMegaUnlockB.unlockedPublishedCoreCount,
      }));
    }

    // Feedback mirrors the legacy test-mode "Saved." prompt so the Boss UI
    // inherits the same "no retry, no correction" microcopy as SATs but the
    // Boss context note + info chip (U5) already distinguish the surfaces for
    // children. The one-shot contract is enforced by awaitingAdvance=true.
    const feedback = correct
      ? { kind: 'info', headline: 'Saved.', answer: promptWord.word, body: 'Moving to the next word.' }
      : { kind: 'warn', headline: 'Saved.', answer: promptWord.word, body: 'Mega stays. Moving to the next word.', attemptedAnswer: rawTyped };

    const nextState = {
      version: SPELLING_SERVICE_STATE_VERSION,
      phase: 'session',
      session: decorateSession(engine, learnerId, session, runtimeWordBySlug),
      feedback: normaliseFeedback(feedback),
      summary: null,
      error: '',
      awaitingAdvance: true,
    };

    persistence.syncPracticeSession(learnerId, nextState);
    return buildTransition(nextState, { events });
  }

  /**
   * P2 U11: Pattern Quest submit path. Routes BEFORE `session.type === 'test'`
   * check in `submitAnswer` so a Pattern Quest session (which rides as
   * `type: 'learning'`-shaped with an overridden `mode = 'pattern-quest'`)
   * can never leak into `engine.submitLearning` / `engine.submitTest`. The
   * contract:
   *
   *   - NEVER writes `progress.stage` / `dueDay` / `lastDay` / `lastResult`.
   *   - Updates `progress.attempts` / `correct` / `wrong` only, mirroring
   *     Boss (U11 Fix 8). Stage / dueDay / lastDay / lastResult are
   *     preserved — Pattern Quest never demotes Mega.
   *   - Writes to `data.pattern.wobbling[slug]` on wrong answers; clears on
   *     correct answers (same shape the Guardian wobble map uses).
   *   - Card 4 gets H5 hardening: empty submit → no-op; typed value that
   *     NFKC-normalises to the exact misspelling shown → gentle re-prompt
   *     (NOT a wobble); within Levenshtein 1 of the target → accepted with
   *     "close miss" feedback.
   *
   * Completion is driven by `patternQuestCardIndex` catching up with
   * `patternQuestCards.length`; the final submit sets `awaitingAdvance=true`
   * and the `continueSession` path finalises via `buildPatternQuestSummary`.
   */
  function submitPatternAnswer(learnerId, current, rawTyped) {
    const session = cloneSerialisable(current.session);
    const cards = Array.isArray(session.patternQuestCards) ? session.patternQuestCards : [];
    const cardIndex = Number.isInteger(session.patternQuestCardIndex)
      ? session.patternQuestCardIndex
      : 0;
    const currentCard = cards[cardIndex] || null;
    if (!currentCard) {
      return invalidSessionTransition('This Pattern Quest card is missing its metadata.');
    }
    const patternId = typeof session.patternQuestPatternId === 'string'
      ? session.patternQuestPatternId
      : '';
    const cardSlug = typeof currentCard.slug === 'string' ? currentCard.slug : '';
    const baseWord = cardSlug ? runtimeWordBySlug[cardSlug] : null;

    // U11 Fix 3: orphan-slug guard. A content hot-swap between session
    // start and submit can leave `patternQuestCards[i].slug` referencing a
    // retired word. `submitPatternAnswer` then hit `baseWord.word` (via the
    // feedback object and close-miss branch) without a null check — TypeError.
    // Refuse the submit with a structured `invalidSessionTransition` mirroring
    // Boss's guard at line ~2564 so the UI surfaces a gentle error instead of
    // crashing the round. Mega is untouched because the guard short-circuits
    // BEFORE any write to `data.pattern.wobbling` or `progress.*`.
    if (!baseWord) {
      return invalidSessionTransition(
        'This Pattern Quest card lost its word metadata mid-round. The round was stopped to protect your Mega count.',
      );
    }

    // U11 card-type submission shapes:
    //   spell / detect-error  — rawTyped carries a typed string
    //   classify / explain    — rawTyped carries a choice-id (e.g. "option-0")
    const trimmedTyped = normaliseString(rawTyped).trim();
    if (!trimmedTyped) {
      return buildTransition({
        ...current,
        feedback: {
          kind: 'warn',
          headline: 'Answer first.',
          body: 'No attempt was recorded.',
        },
        error: '',
        awaitingAdvance: false,
      });
    }

    let correct = false;
    let wobbleSlug = '';
    let feedback = null;
    let remainInPlace = false;
    let closeMiss = false;

    if (currentCard.type === 'spell') {
      // Fix 3 guard above guarantees `baseWord` is non-null here, so we can
      // read `baseWord.word` unconditionally in the feedback object.
      correct = isExactPatternMatch(trimmedTyped, baseWord.word);
      wobbleSlug = cardSlug;
      feedback = correct
        ? { kind: 'success', headline: 'Correct!', answer: baseWord.word, body: 'Same pattern, next one.' }
        : { kind: 'warn', headline: 'Wobble.', answer: baseWord.word, body: 'Mega stays. This word will come back tomorrow.', attemptedAnswer: trimmedTyped };
    } else if (currentCard.type === 'detect-error') {
      const misspelling = typeof currentCard.misspelling === 'string' ? currentCard.misspelling : '';
      const targetWord = baseWord.word || '';
      const normalisedTyped = normalisePatternQuestInput(trimmedTyped).toLocaleLowerCase('en');
      const normalisedMisspelling = normalisePatternQuestInput(misspelling).toLocaleLowerCase('en');
      const normalisedTarget = normalisePatternQuestInput(targetWord).toLocaleLowerCase('en');

      if (normalisedTyped === normalisedMisspelling && normalisedMisspelling && normalisedMisspelling !== normalisedTarget) {
        // H5: child typed the misspelling verbatim — gentle re-prompt, not a
        // wobble. Stay on the same card (awaitingAdvance=false).
        remainInPlace = true;
        correct = false;
        feedback = {
          kind: 'warn',
          headline: 'Looks like the misspelled version.',
          body: 'Try typing the correct spelling.',
        };
      } else if (normalisedTyped === normalisedTarget) {
        correct = true;
        wobbleSlug = cardSlug;
        feedback = { kind: 'success', headline: 'Nice spot!', answer: targetWord, body: 'You fixed it.' };
      } else if (targetWord && patternLevenshteinWithin1(trimmedTyped, targetWord) <= 1) {
        // H5 close-miss: within Levenshtein 1 of the target. Accept but note
        // the typo. No wobble.
        correct = true;
        closeMiss = true;
        wobbleSlug = cardSlug;
        feedback = {
          kind: 'success',
          headline: 'Almost perfect.',
          answer: targetWord,
          body: `Close miss: you typed "${trimmedTyped}". The target was "${targetWord}".`,
        };
      } else {
        correct = false;
        wobbleSlug = cardSlug;
        feedback = { kind: 'warn', headline: 'Wobble.', answer: targetWord, body: 'Mega stays. This word will come back tomorrow.', attemptedAnswer: trimmedTyped };
      }
    } else if (currentCard.type === 'classify' || currentCard.type === 'explain') {
      // Multiple-choice: the current card's CHOICES array is rebuilt by
      // `decoratePatternQuestCard` on every decorateSession call and
      // seeded-shuffled via `deterministicCardSeedRandom` so the correct
      // option is NOT always at position 0 (U11 Fix 2 — the prior
      // `id === 'option-0'` shortcut turned Pattern Quest into a "pick top"
      // tell for children). Re-decorate here with the same seed inputs the
      // client saw to look up which id carries `correct: true`.
      const chosenId = trimmedTyped;
      const patternDef = patternId && SPELLING_PATTERNS[patternId] ? SPELLING_PATTERNS[patternId] : null;
      let decoratedChoices = [];
      if (patternDef) {
        const cardShuffleRandom = deterministicCardSeedRandom({
          patternId,
          slug: cardSlug,
          cardIndex,
          type: currentCard.type,
          extra: session.id || '',
        });
        const decoratedCard = decoratePatternQuestCard(
          currentCard,
          patternDef,
          runtimeWordBySlug,
          cardIndex,
          cards.length,
          cardShuffleRandom,
        );
        decoratedChoices = Array.isArray(decoratedCard?.choices) ? decoratedCard.choices : [];
      }
      const chosen = decoratedChoices.find((choice) => choice && choice.id === chosenId);
      correct = Boolean(chosen && chosen.correct === true);
      wobbleSlug = cardSlug;
      feedback = correct
        ? { kind: 'success', headline: 'Correct!', body: currentCard.type === 'explain' ? 'That is the right reason.' : 'That is the right pattern.' }
        : { kind: 'warn', headline: 'Wobble.', body: currentCard.type === 'explain' ? 'Mega stays. The reason will come back tomorrow.' : 'Mega stays. This pattern will come back tomorrow.' };
    } else {
      return invalidSessionTransition('Unknown Pattern Quest card type.');
    }

    // Write `data.pattern.wobbling[slug]` for wrong answers. Correct answers
    // CLEAR the wobble entry (mirrors Guardian's recovered path). Never
    // touches `progress.stage` / `dueDay` / `lastDay` / `lastResult` — the
    // Mega-never-revoked invariant is pinned here.
    //
    // U11 Fix 8 (reviewer feedback): mirror Boss's progress counter update so
    // Pattern Quest attempts/correct/wrong diverge no longer from Boss +
    // Guardian accounting. Updates only `attempts` / `correct` / `wrong` on
    // the existing progress record — `stage` / `dueDay` / `lastDay` /
    // `lastResult` are preserved explicitly because the Pattern Quest
    // contract is Mega-never-revoked. Skipped when `remainInPlace` is true
    // (H5 re-prompt) so typing the misspelling verbatim does NOT bump
    // attempts. Also skipped when `existingProgress` is missing — Pattern
    // Quest selection already filters by isPatternEligibleSlug, which
    // requires the progress record, but if a racy hot-swap deleted the
    // record between selection and submit we refuse to synthesize a fresh
    // `stage: 0` seed (that would silently demote Mega).
    const patternMap = loadPatternFromStorage(learnerId);
    const todayDay = currentTodayDay();
    const beforeError = readPersistenceError();
    let persistenceSave = { ok: true };
    if (!remainInPlace && wobbleSlug) {
      if (correct) {
        if (patternMap.wobbling[wobbleSlug]) delete patternMap.wobbling[wobbleSlug];
      } else if (patternId) {
        patternMap.wobbling[wobbleSlug] = {
          wobbling: true,
          wobbledAt: todayDay,
          patternId,
        };
      }
      persistenceSave = savePatternToStorage(learnerId, patternMap);
    }
    // Fix 8: progress counter update. Runs AFTER the pattern-map write so a
    // failure on the progress write does not leave the wobble map in a
    // half-committed state (which is itself survivable; the guard emits a
    // persistenceWarning via the unified save-failure signature below).
    let progressSaveResult = { ok: true };
    if (!remainInPlace && cardSlug) {
      const progressMap = loadProgressFromStorage(learnerId);
      const existingProgress = progressMap[cardSlug];
      if (existingProgress && typeof existingProgress === 'object' && !Array.isArray(existingProgress)) {
        const nextProgress = { ...existingProgress };
        nextProgress.attempts = (nextProgress.attempts || 0) + 1;
        if (correct) nextProgress.correct = (nextProgress.correct || 0) + 1;
        else nextProgress.wrong = (nextProgress.wrong || 0) + 1;
        progressMap[cardSlug] = nextProgress;
        progressSaveResult = saveProgressToStorage(learnerId, progressMap);
      }
    }
    const afterError = readPersistenceError();
    const lastErrorChanged = persistenceErrorSignatureChanged(beforeError, afterError);
    const persistenceWarning = (!persistenceSave?.ok || !progressSaveResult?.ok || lastErrorChanged)
      ? { reason: SPELLING_PERSISTENCE_WARNING_REASON.STORAGE_SAVE_FAILED }
      : null;
    if (persistenceWarning && feedback) feedback.persistenceWarning = persistenceWarning;

    // Per-card outcome tracking — `finalisePatternQuest` reads these to count
    // correctCount + build wobbledSlugs without re-driving the state machine.
    const results = Array.isArray(session.patternQuestResults) ? session.patternQuestResults.slice() : [];
    const wobbledList = Array.isArray(session.patternQuestWobbledSlugs)
      ? session.patternQuestWobbledSlugs.slice()
      : [];
    if (!remainInPlace) {
      results.push({
        type: currentCard.type,
        slug: cardSlug,
        patternId,
        correct,
        answer: trimmedTyped,
        ...(closeMiss ? { closeMiss: true } : {}),
      });
      if (!correct && wobbleSlug && !wobbledList.includes(wobbleSlug)) {
        wobbledList.push(wobbleSlug);
      }
    }
    session.patternQuestResults = results;
    session.patternQuestWobbledSlugs = wobbledList;

    // Advance the card pointer on a non-remainInPlace submit.
    let awaitingAdvance = true;
    if (remainInPlace) {
      awaitingAdvance = false;
    } else {
      session.promptCount = (Number(session.promptCount) || 0) + 1;
      session.patternQuestCardIndex = cardIndex + 1;
      const nextCard = cards[cardIndex + 1] || null;
      if (nextCard) {
        const nextWord = runtimeWordBySlug[nextCard.slug];
        session.currentSlug = nextCard.slug;
        session.currentPrompt = nextWord
          ? {
              slug: nextCard.slug,
              word: nextWord.word,
              accepted: acceptedForPrompt(nextWord.accepted, nextWord.word),
              explanation: nextWord.explanation || '',
              sentence: nextWord.sentence || '',
              cloze: buildCloze(nextWord.sentence || '', nextWord.word),
            }
          : null;
      }
    }

    const nextState = {
      version: SPELLING_SERVICE_STATE_VERSION,
      phase: 'session',
      session: decorateSession(engine, learnerId, session, runtimeWordBySlug),
      feedback: normaliseFeedback(feedback),
      summary: null,
      error: '',
      awaitingAdvance,
    };
    persistence.syncPracticeSession(learnerId, nextState);
    return buildTransition(nextState, { events: [] });
  }

  function submitAnswer(learnerId, rawState, typed) {
    const current = initState(rawState, learnerId);
    if (current.phase !== 'session' || !current.session) {
      return invalidSessionTransition('No active spelling session is available for that submission.');
    }

    if (current.awaitingAdvance) {
      return buildTransition(current, { changed: false });
    }

    const rawTyped = normaliseString(typed).trim();
    if (!rawTyped) {
      return buildTransition({
        ...current,
        feedback: {
          kind: 'warn',
          headline: 'Type an answer first.',
          body: 'No attempt was recorded.',
        },
        error: '',
        awaitingAdvance: false,
      });
    }

    // Dispatcher routing — ORDER IS CRITICAL.
    //
    //   mode === 'guardian'      → submitGuardianAnswer (Mega-safe)
    //   mode === 'boss'          → submitBossAnswer     (Mega-safe) — MUST come
    //                                                before the type === 'test'
    //                                                check; otherwise a wrong
    //                                                answer routes to
    //                                                engine.submitTest and
    //                                                applyTestOutcome demotes
    //                                                stage from 4 to 3.
    //   mode === 'pattern-quest' → submitPatternAnswer  (Mega-safe) — MUST
    //                                                come BEFORE the
    //                                                type === 'test' check so
    //                                                a Pattern Quest card
    //                                                never drops into
    //                                                engine.submitLearning
    //                                                (which would touch
    //                                                progress.stage).
    //   type === 'test'          → engine.submitTest    (legacy SATs, demotion-aware)
    //   otherwise                → engine.submitLearning
    if (current.session.mode === 'guardian') {
      return submitGuardianAnswer(learnerId, current, rawTyped);
    }
    if (current.session.mode === 'boss') {
      return submitBossAnswer(learnerId, current, rawTyped);
    }
    if (current.session.mode === 'pattern-quest') {
      return submitPatternAnswer(learnerId, current, rawTyped);
    }

    const session = cloneSerialisable(current.session);
    const entryPhase = session.phase;
    const currentSlug = session.currentSlug;
    // U8 review fix: snapshot the platform persistence channel's lastError
    // BEFORE calling legacy-engine so we can diff after the engine's write.
    // Legacy-engine's `saveProgress` has an internal try/catch that swallows
    // storage throws from the spelling persistence proxy. The channel's
    // lastError (set by `persistAll` inside `createLocalPlatformRepositories`)
    // is the authoritative signal for a silent swallow.
    const beforeError = readPersistenceError();
    // P2 U2: pre-submit graduation snapshot for first-graduation detection.
    // Captured BEFORE the engine call so the H1 guard has a clean baseline
    // to compare against post-submit state. `preSubmitAllMega` must be false
    // for the learner to graduate via this submit; pre-submit stage of the
    // submitted slug must be < 4 for the submit-caused-this guard to pass.
    const preSubmitProgressStore = progressSnapshot(learnerId) || {};
    const preSubmitAllMega = isAllWordsMega(preSubmitProgressStore);
    const preSubmitStage = Number(preSubmitProgressStore?.[currentSlug]?.stage) || 0;
    const result = session.type === 'test'
      ? engine.submitTest(session, learnerId, rawTyped)
      : engine.submitLearning(session, learnerId, rawTyped);

    if (!result) {
      return invalidSessionTransition('This spelling session became stale and was cleared.');
    }

    if (result.empty) {
      return buildTransition({
        ...current,
        feedback: {
          kind: 'warn',
          headline: 'Type an answer first.',
          body: 'No attempt was recorded.',
        },
        error: '',
        awaitingAdvance: false,
      });
    }

    // U8 review fix: dual-mode persistence detection for Smart Review / SATs.
    //
    // (1) Production path: the platform persistence channel's `lastError`
    //     bumps its `at` timestamp every time `persistAll` fails, even when
    //     legacy-engine swallows the proxy throw. We capture the channel
    //     state IMMEDIATELY after `engine.submitLearning` returns — before
    //     the probe write — because a successful probe would clear the
    //     error and the before/after comparison across the probe would miss
    //     a transient failure blip. The mid-submit snapshot is the
    //     authoritative signal for legacy-engine's silent swallow.
    //
    // (2) Bare-storage test path: the service is wired to a raw
    //     MemoryStorage (no platform repositories / persistence channel), so
    //     `readPersistenceError()` returns null. To still surface the
    //     warning on legacy-engine's silent swallow, we write progress once
    //     through `saveProgressToStorage`, whose `writeJsonToStoragePort` try/catch
    //     returns `{ ok: false }` on throw. On production this is also a
    //     valid secondary check — if storage recovered between legacy-engine
    //     and this write, the write succeeds and no warning is surfaced
    //     (which is the correct behaviour — storage IS consistent now).
    //
    // The probe's `progressSnapshot` was previously documented as
    // idempotent — with the proxy throw-on-error fix in `repository.js`,
    // it now genuinely detects a broken storage backing on the same submit.
    // Either signal firing raises the warning.
    const midError = readPersistenceError();
    const midErrorChanged = persistenceErrorSignatureChanged(beforeError, midError);
    const probeProgress = progressSnapshot(learnerId);
    const probeSave = probeProgress ? saveProgressToStorage(learnerId, probeProgress) : { ok: true };
    const persistenceWarning = (!probeSave?.ok || midErrorChanged)
      ? { reason: SPELLING_PERSISTENCE_WARNING_REASON.STORAGE_SAVE_FAILED }
      : null;
    // P2 U9: durable mirror on the Smart Review / SATs submit path too.
    if (persistenceWarning) {
      writePersistenceWarning(learnerId, persistenceWarning.reason);
    }

    const eventTime = clock();
    const events = [];
    if (currentSlug && result.correct && entryPhase !== 'question') {
      events.push(createSpellingRetryClearedEvent({
        learnerId,
        session,
        slug: currentSlug,
        fromPhase: entryPhase,
        attemptCount: session.status?.[currentSlug]?.attempts ?? null,
        createdAt: eventTime,
        wordMeta: runtimeWordBySlug,
      }));
    }
    if (result.outcome?.justMastered && currentSlug) {
      events.push(createSpellingWordSecuredEvent({
        learnerId,
        session,
        slug: currentSlug,
        stage: result.outcome.newStage,
        createdAt: eventTime,
        wordMeta: runtimeWordBySlug,
      }));

      const secureCount = getStats(learnerId, 'all').secure;
      const milestone = masteryMilestoneForCount(secureCount);
      if (milestone) {
        events.push(createSpellingMasteryMilestoneEvent({
          learnerId,
          session,
          milestone,
          secureCount,
          createdAt: eventTime,
        }));
      }
    }

    // P2 U2: first-graduation detection. Run AFTER legacy engine's write so
    // the progress snapshot reflects the newly-promoted stage. `result.outcome`
    // carries the prevStage / newStage of the submitted slug, which feeds the
    // H1 submit-caused-this guard. `detectAndPersistFirstGraduation` itself
    // is conservative — it only emits when all three conjuncts hold AND the
    // storage-proxy H3 guard confirms no prior sticky-bit exists. The write
    // is idempotent, so this helper can run unconditionally on every submit.
    const postSubmitProgressStore = progressSnapshot(learnerId) || {};
    const postSubmitAllMega = isAllWordsMega(postSubmitProgressStore);
    const postMegaUnlock = detectAndPersistFirstGraduation({
      learnerId,
      preSubmitAllMega,
      postSubmitAllMega,
      submittedSlugPrevStage: preSubmitStage,
      submittedSlugNewStage: Number(result.outcome?.newStage) || preSubmitStage,
    });
    if (postMegaUnlock) {
      events.push(createSpellingPostMegaUnlockedEvent({
        learnerId,
        unlockedAt: postMegaUnlock.unlockedAt,
        contentReleaseId: postMegaUnlock.unlockedContentReleaseId,
        publishedCoreCount: postMegaUnlock.unlockedPublishedCoreCount,
      }));
    }

    const nextState = {
      version: SPELLING_SERVICE_STATE_VERSION,
      phase: 'session',
      session: decorateSession(engine, learnerId, session, runtimeWordBySlug),
      feedback: normaliseFeedback({
        ...result.feedback,
        ...(session.type !== 'test' && result.correct === false ? { attemptedAnswer: rawTyped } : {}),
        // U8: attach warning from the probe. Normaliser strips it when null.
        persistenceWarning,
      }),
      summary: null,
      error: '',
      awaitingAdvance: result.nextAction === 'advance',
    };

    const audio = !nextState.awaitingAdvance && result.phase === 'retry'
      ? activeAudioCue(learnerId, nextState, true)
      : null;

    persistence.syncPracticeSession(learnerId, nextState);
    return buildTransition(nextState, { events, audio });
  }

  function guardianMissionEventsForSession(learnerId, session, summary, createdAt) {
    if (session?.mode !== 'guardian') return [];
    const results = session.guardianResults && typeof session.guardianResults === 'object' && !Array.isArray(session.guardianResults)
      ? session.guardianResults
      : {};
    let renewalCount = 0;
    let wobbledCount = 0;
    let recoveredCount = 0;
    for (const outcome of Object.values(results)) {
      if (outcome === 'renewed') renewalCount += 1;
      else if (outcome === 'wobbled') wobbledCount += 1;
      else if (outcome === 'recovered') recoveredCount += 1;
    }
    const events = [];
    const sessionCompleted = createSpellingSessionCompletedEvent({
      learnerId,
      session,
      summary,
      createdAt,
    });
    if (sessionCompleted) events.push(sessionCompleted);
    events.push(createSpellingGuardianMissionCompletedEvent({
      learnerId,
      session,
      renewalCount,
      wobbledCount,
      recoveredCount,
      createdAt,
    }));
    return events;
  }

  // U9: Boss Dictation round-end event fan-out. Emits the standard
  // SESSION_COMPLETED (so legacy consumers that watch for any spelling round
  // still see the event) plus a Boss-specific `spelling.boss.completed` event
  // carrying the per-round score and the exact ordered seed-slug list.
  //
  // Seed roster contract: `session.uniqueWords` IS the seed roster for Boss.
  // Unlike SATs test sessions (where uniqueWords gets mutated by re-queueing
  // of wrong answers), a Boss session is strict FIFO over the selectBossWords
  // output — no card is ever re-queued (see submitBossAnswer + engine.advanceCard
  // test-typed path at legacy-engine.js:586-591). That means uniqueWords at
  // finalise-time is identical to the initial selection. We pass it through as
  // seedSlugs so downstream consumers don't have to separately track a seed
  // copy; the event factory also falls back to uniqueWords when seedSlugs is
  // null/missing, so the invariant is double-locked.
  function bossEventsForSession(learnerId, session, summary, createdAt) {
    if (session?.mode !== 'boss') return [];
    const results = Array.isArray(session.results) ? session.results : [];
    let correct = 0;
    let wrong = 0;
    for (const entry of results) {
      if (entry?.correct === true) correct += 1;
      else wrong += 1;
    }
    const events = [];
    const sessionCompleted = createSpellingSessionCompletedEvent({
      learnerId,
      session,
      summary,
      createdAt,
    });
    if (sessionCompleted) events.push(sessionCompleted);
    const bossCompleted = createSpellingBossCompletedEvent({
      learnerId,
      session,
      summary: { correct, wrong },
      // uniqueWords is the seed roster for Boss (test-typed sessions don't
      // mutate uniqueWords). Passing a fresh slice here keeps the event
      // payload immutable with respect to later session mutations, even
      // though Boss never mutates uniqueWords after start.
      seedSlugs: Array.isArray(session.uniqueWords) ? session.uniqueWords.slice() : null,
      createdAt,
    });
    if (bossCompleted) events.push(bossCompleted);
    return events;
  }

  // U9 blocker fix: Override the `testSummary()` copy for Boss rounds. Boss
  // rides as `session.type = 'test'` to reuse the single-attempt UI, so
  // `engine.finalise()` routes to `testSummary()` which emits SATs-style
  // demotion copy ("pushed back into the learner's due queue", "Marked due
  // again today"). Both statements are FALSE for Boss — Boss is Mega-safe:
  // wrong answers never demote stage and never schedule a word due-soon.
  // We override the message and the "Needs more work" card's sub label so the
  // summary matches the Mega-never-revoked invariant the footer note already
  // advertises (session-ui.js spellingSessionFooterNote).
  //
  // Kept at the service layer (not in legacy-engine.js) per plan rule: Boss
  // bypasses submitTest without modifying legacy.
  function overrideBossSummary(summary) {
    if (!summary || summary.mode !== 'boss') return summary;
    const total = Number.isInteger(summary.totalWords) ? summary.totalWords : 0;
    const correct = Number.isInteger(summary.correct) ? summary.correct : 0;
    const bossMessage = correct === total
      ? `Boss round complete — ${correct} of ${total} Mega words landed. Every Mega word stays Mega.`
      : `Boss round complete — ${correct} of ${total} Mega words landed. Your Mega words stay Mega — review the missed ones on your own.`;
    const cards = Array.isArray(summary.cards)
      ? summary.cards.map((card) => {
          if (card?.label === 'Needs more work') {
            return { ...card, sub: 'Practice these on your own — Mega stays intact.' };
          }
          if (card?.label === 'Correct') {
            // Keep "Correct" sub positive without implying SATs-style scheduling.
            return { ...card, sub: 'Strong on the day' };
          }
          if (card?.label === 'Accuracy') {
            return { ...card, sub: 'Single attempt per word' };
          }
          return card;
        })
      : summary.cards;
    return {
      ...summary,
      message: bossMessage,
      cards,
    };
  }

  /**
   * P2 U11: Pattern Quest summary builder. Mirrors the shape of
   * `engine.finalise` / `normaliseSummary` so downstream UI (summary scene,
   * view-model, ToastShelf subscribers) can read the usual `{ mode, label,
   * cards, mistakes, elapsedMs, totalWords, correct, accuracy }` fields.
   */
  function buildPatternQuestSummary(session) {
    const results = Array.isArray(session?.patternQuestResults) ? session.patternQuestResults : [];
    const total = results.length;
    const correct = results.filter((entry) => entry.correct === true).length;
    const patternId = typeof session?.patternQuestPatternId === 'string'
      ? session.patternQuestPatternId
      : '';
    const patternDef = patternId ? SPELLING_PATTERNS[patternId] : null;
    const mistakes = [];
    const seenMistakeSlugs = new Set();
    for (const entry of results) {
      if (entry.correct === true) continue;
      const slug = typeof entry.slug === 'string' ? entry.slug : '';
      if (!slug || seenMistakeSlugs.has(slug)) continue;
      const word = runtimeWordBySlug[slug];
      if (!word) continue;
      mistakes.push({
        slug,
        word: word.word,
        family: word.family,
        year: word.year,
        yearLabel: word.yearLabel,
        familyWords: Array.isArray(word.familyWords) ? [...word.familyWords] : [],
      });
      seenMistakeSlugs.add(slug);
    }
    const wobbledCount = Array.isArray(session?.patternQuestWobbledSlugs)
      ? session.patternQuestWobbledSlugs.length
      : mistakes.length;
    const accuracy = total > 0 ? Math.round((correct / total) * 100) : null;
    const message = correct === total
      ? `Pattern Quest complete — ${correct} of ${total} right on "${patternDef?.title || patternId}". Mega stays.`
      : `Pattern Quest complete — ${correct} of ${total} right on "${patternDef?.title || patternId}". Mega stays; wobbling cards return tomorrow.`;
    return {
      mode: 'pattern-quest',
      label: 'Pattern Quest',
      message,
      cards: [
        { label: 'Score', value: `${correct}/${total}`, sub: patternDef?.title || patternId },
        { label: 'Correct', value: correct, sub: 'Single attempt per card' },
        { label: 'Wobbling', value: wobbledCount, sub: 'Comes back tomorrow' },
        { label: 'Pattern', value: patternDef?.title || patternId, sub: 'Today\'s quest' },
      ],
      mistakes,
      elapsedMs: Math.max(0, Number(clock()) - (Number(session?.startedAt) || Number(clock()))),
      totalWords: total,
      correct,
      accuracy,
    };
  }

  /**
   * P2 U11: Pattern Quest event fan-out. Emits `spelling.session-completed`
   * (so legacy consumers still see the round) plus
   * `spelling.pattern.quest-completed` with pattern id, slug roster,
   * correct count, and the distinct wobbled-slugs list.
   */
  function patternQuestEventsForSession(learnerId, session, summary, createdAt) {
    if (session?.mode !== 'pattern-quest') return [];
    const results = Array.isArray(session.patternQuestResults) ? session.patternQuestResults : [];
    const correctCount = results.filter((entry) => entry.correct === true).length;
    const slugs = Array.isArray(session.patternQuestSeedSlugs) ? session.patternQuestSeedSlugs.slice() : [];
    const wobbledSlugs = Array.isArray(session.patternQuestWobbledSlugs)
      ? session.patternQuestWobbledSlugs.slice()
      : [];
    const events = [];
    const sessionCompleted = createSpellingSessionCompletedEvent({
      learnerId,
      session,
      summary,
      createdAt,
    });
    if (sessionCompleted) events.push(sessionCompleted);
    // U11 Fix 6: thread patternTitle through the event so the reward-toast
    // subscriber renders readable copy without another registry lookup.
    const patternDefForEvent = typeof session?.patternQuestPatternId === 'string'
      && SPELLING_PATTERNS[session.patternQuestPatternId]
      ? SPELLING_PATTERNS[session.patternQuestPatternId]
      : null;
    const questCompleted = createSpellingPatternQuestCompletedEvent({
      learnerId,
      session,
      patternId: session.patternQuestPatternId,
      patternTitle: patternDefForEvent?.title || '',
      slugs,
      correctCount,
      wobbledSlugs,
      createdAt,
    });
    if (questCompleted) events.push(questCompleted);
    return events;
  }

  function continueSession(learnerId, rawState) {
    const current = initState(rawState, learnerId);
    if (current.phase !== 'session' || !current.session) {
      return invalidSessionTransition('No active spelling session is available to continue.');
    }

    if (!current.awaitingAdvance) {
      return buildTransition(current, { changed: false });
    }

    const session = cloneSerialisable(current.session);
    // P2 U11: Pattern Quest has its own advance — the card pointer is
    // already bumped inside `submitPatternAnswer`, so `continueSession`
    // either finalises (pointer >= cards.length) or rolls the session back
    // to `awaitingAdvance=false` on the next card.
    if (session.mode === 'pattern-quest') {
      const cards = Array.isArray(session.patternQuestCards) ? session.patternQuestCards : [];
      const cardIndex = Number.isInteger(session.patternQuestCardIndex)
        ? session.patternQuestCardIndex
        : 0;
      if (cardIndex >= cards.length) {
        const summary = buildPatternQuestSummary(session);
        if (summary) summary.heroContext = resolvedContext.extractSummaryContext(session);
        const nextState = {
          version: SPELLING_SERVICE_STATE_VERSION,
          phase: 'summary',
          session: null,
          feedback: null,
          summary,
          error: '',
          awaitingAdvance: false,
        };
        persistence.syncPracticeSession(learnerId, nextState);
        const events = patternQuestEventsForSession(learnerId, session, summary, clock());
        // P2 U12: evaluate + persist achievement unlocks from the emitted events.
        persistAchievementsForEmittedEvents(learnerId, events);
        return buildTransition(nextState, { events });
      }
      const nextCard = cards[cardIndex];
      const nextWord = runtimeWordBySlug[nextCard.slug];
      session.currentSlug = nextCard.slug;
      session.currentPrompt = nextWord
        ? {
            slug: nextCard.slug,
            word: nextWord.word,
            accepted: acceptedForPrompt(nextWord.accepted, nextWord.word),
            explanation: nextWord.explanation || '',
            sentence: nextWord.sentence || '',
            cloze: buildCloze(nextWord.sentence || '', nextWord.word),
          }
        : null;
      const nextState = {
        version: SPELLING_SERVICE_STATE_VERSION,
        phase: 'session',
        session: decorateSession(engine, learnerId, session, runtimeWordBySlug),
        feedback: null,
        summary: null,
        error: '',
        awaitingAdvance: false,
      };
      persistence.syncPracticeSession(learnerId, nextState);
      return buildTransition(nextState, { audio: activeAudioCue(learnerId, nextState) });
    }

    const advanced = session.mode === 'guardian'
      ? advanceGuardianCard(session)
      : engine.advanceCard(session, learnerId);

    if (advanced.done) {
      const rawSummary = normaliseSummary(engine.finalise(session), isRuntimeKnownSlug);
      // Boss rides as test-typed so engine.finalise routes to testSummary(),
      // which emits SATs demotion copy. overrideBossSummary swaps in
      // Mega-safe copy without modifying legacy-engine.js.
      const summary = session.mode === 'boss' ? overrideBossSummary(rawSummary) : rawSummary;
      if (summary) summary.heroContext = resolvedContext.extractSummaryContext(session);
      const nextState = {
        version: SPELLING_SERVICE_STATE_VERSION,
        phase: 'summary',
        session: null,
        feedback: null,
        summary,
        error: '',
        awaitingAdvance: false,
      };
      persistence.syncPracticeSession(learnerId, nextState);
      const createdAt = clock();
      let events;
      if (session.mode === 'guardian') {
        events = guardianMissionEventsForSession(learnerId, session, summary, createdAt);
      } else if (session.mode === 'boss') {
        events = bossEventsForSession(learnerId, session, summary, createdAt);
      } else {
        events = sessionCompletedEvents({ learnerId, session, summary, createdAt });
      }
      // P2 U12: evaluate + persist achievements for Guardian mission-completed,
      // Boss completed, and (via the pattern-quest branch above) Pattern Quest
      // completed events. Called after the session's storage writes so any
      // `data.achievements` update reads a coherent post-session snapshot.
      persistAchievementsForEmittedEvents(learnerId, events);
      return buildTransition(nextState, { events });
    }

    const nextState = {
      version: SPELLING_SERVICE_STATE_VERSION,
      phase: 'session',
      session: decorateSession(engine, learnerId, session, runtimeWordBySlug),
      feedback: null,
      summary: null,
      error: '',
      awaitingAdvance: false,
    };

    persistence.syncPracticeSession(learnerId, nextState);
    return buildTransition(nextState, { audio: activeAudioCue(learnerId, nextState) });
  }

  // U4: Guardian-native "I don't know" path. Routes through advanceGuardianOnWrong,
  // emits spelling.guardian.wobbled, records guardianResults[slug] = 'wobbled' so
  // mission-completed aggregates the count, and never mutates progress.stage /
  // dueDay / lastDay / lastResult. Mirrors the wrong-answer branch of
  // submitGuardianAnswer end-to-end: both set awaitingAdvance=true and let
  // continueSession handle the queue advance, so a double-tap on the button
  // no-ops on the second call (continueSession owns the Continue → next-card
  // transition, including the audio cue). See
  // docs/plans/2026-04-25-005-feat-post-mega-spelling-guardian-hardening-plan.md (U4).
  function skipGuardianWord(learnerId, current) {
    const session = cloneSerialisable(current.session);
    const currentSlug = session.currentSlug;
    const baseWord = currentSlug ? runtimeWordBySlug[currentSlug] : null;
    if (!baseWord || session.phase !== 'question') {
      return buildTransition({
        ...current,
        feedback: {
          kind: 'warn',
          headline: 'This word cannot be skipped right now.',
          body: 'Finish the retry or correction step first.',
        },
        error: '',
      });
    }

    // Session bookkeeping — matches submitGuardianAnswer wrong-path shape so
    // summary.mistakes picks this slug up for the practice-only drill (U3).
    const statusEntry = session.status?.[currentSlug] || {
      attempts: 0,
      successes: 0,
      needed: 1,
      hadWrong: false,
      wrongAnswers: [],
      done: false,
      applied: false,
    };
    statusEntry.attempts += 1;
    statusEntry.done = true;
    statusEntry.applied = true;
    statusEntry.hadWrong = true;
    session.status = session.status || {};
    session.status[currentSlug] = statusEntry;
    session.promptCount = (session.promptCount || 0) + 1;
    session.phase = 'question';

    // FIFO-clean: remove the skipped slug from the queue, never re-queue (unlike
    // legacy enqueueLater). submitGuardianAnswer does the same defensively.
    if (Array.isArray(session.queue)) {
      session.queue = session.queue.filter((slug) => slug !== currentSlug);
    }

    // Update progress.attempts + progress.wrong only. Stage/dueDay/lastDay/
    // lastResult are preserved — Mega-never-revoked invariant.
    const progressMap = loadProgressFromStorage(learnerId);
    const existingProgress = progressMap[currentSlug] && typeof progressMap[currentSlug] === 'object'
      ? progressMap[currentSlug]
      : { stage: 0, attempts: 0, correct: 0, wrong: 0, dueDay: 0, lastDay: null, lastResult: null };
    const nextProgress = { ...existingProgress };
    nextProgress.attempts = (nextProgress.attempts || 0) + 1;
    nextProgress.wrong = (nextProgress.wrong || 0) + 1;
    progressMap[currentSlug] = nextProgress;
    // U8 review fix: snapshot lastError before the writes so we can catch
    // a wrapped-host swallow. Mirrors submitGuardianAnswer's check.
    const beforeError = readPersistenceError();
    const progressSave = saveProgressToStorage(learnerId, progressMap);

    // Advance the guardian record the same way a wrong answer does.
    const todayDay = currentTodayDay();
    const guardianMap = loadGuardianMap(learnerId);
    const beforeRecord = ensureGuardianRecord(guardianMap, currentSlug, todayDay);
    const updatedRecord = advanceGuardianOnWrong(beforeRecord, todayDay);
    guardianMap[currentSlug] = updatedRecord;
    const guardianSave = saveGuardianMap(learnerId, guardianMap);
    // U8: propagate persistence failures from the "I don't know" branch the
    // same way submitGuardianAnswer does. A single banner surfaces if either
    // write failed; the session continues in-memory and Mega is untouched.
    const afterError = readPersistenceError();
    const lastErrorChanged = persistenceErrorSignatureChanged(beforeError, afterError);
    const persistenceWarning = (!progressSave?.ok || !guardianSave?.ok || lastErrorChanged)
      ? { reason: SPELLING_PERSISTENCE_WARNING_REASON.STORAGE_SAVE_FAILED }
      : null;
    // P2 U9: durable mirror on the "I don't know" skipWord branch.
    if (persistenceWarning) {
      writePersistenceWarning(learnerId, persistenceWarning.reason);
    }

    // Record the per-word outcome so guardianMissionEventsForSession counts
    // this as a wobble on the final mission-completed event.
    session.guardianResults = session.guardianResults || {};
    session.guardianResults[currentSlug] = 'wobbled';

    const eventTime = clock();
    const events = [];
    const wobbledEvent = createSpellingGuardianWobbledEvent({
      learnerId,
      session,
      slug: currentSlug,
      lapses: updatedRecord.lapses,
      createdAt: eventTime,
      wordMeta: runtimeWordBySlug,
    });
    if (wobbledEvent) events.push(wobbledEvent);

    // Set awaitingAdvance=true so continueSession handles the FIFO advance
    // (including activeAudioCue for the next card). This matches
    // submitGuardianAnswer exactly — double-taps on the button no-op because
    // the skipWord entry check already returns changed:false when
    // awaitingAdvance is set.
    const nextState = {
      version: SPELLING_SERVICE_STATE_VERSION,
      phase: 'session',
      session: decorateSession(engine, learnerId, session, runtimeWordBySlug),
      feedback: normaliseFeedback({
        kind: 'warn',
        headline: 'Wobbling.',
        answer: baseWord.word,
        body: 'Mega stays, but this word will return tomorrow for a Guardian check.',
        // U8: attach the warning into the feedback shape so the React banner
        // surfaces on the "I don't know" branch too. normaliseFeedback drops
        // it when null/undefined, preserving the pre-U8 shape on happy paths.
        persistenceWarning,
      }),
      summary: null,
      error: '',
      awaitingAdvance: true,
    };
    persistence.syncPracticeSession(learnerId, nextState);
    return buildTransition(nextState, { events });
  }

  function skipWord(learnerId, rawState) {
    const current = initState(rawState, learnerId);
    if (current.phase !== 'session' || !current.session) {
      return invalidSessionTransition('No active spelling session is available to skip within.');
    }

    if (current.awaitingAdvance) {
      return buildTransition(current, { changed: false });
    }

    if (current.session.mode === 'guardian') {
      return skipGuardianWord(learnerId, current);
    }

    const session = cloneSerialisable(current.session);
    const skipped = engine.skipCurrent(session);
    if (!skipped) {
      return buildTransition({
        ...current,
        feedback: {
          kind: 'warn',
          headline: 'This word cannot be skipped right now.',
          body: 'Finish the retry or correction step first.',
        },
        error: '',
      });
    }

    const advanced = engine.advanceCard(session, learnerId);
    if (advanced.done) {
      const summary = normaliseSummary(engine.finalise(session), isRuntimeKnownSlug);
      if (summary) summary.heroContext = resolvedContext.extractSummaryContext(session);
      const nextState = {
        version: SPELLING_SERVICE_STATE_VERSION,
        phase: 'summary',
        session: null,
        feedback: null,
        summary,
        error: '',
        awaitingAdvance: false,
      };
      persistence.syncPracticeSession(learnerId, nextState);
      return buildTransition(nextState, {
        events: sessionCompletedEvents({ learnerId, session, summary, createdAt: clock() }),
      });
    }

    const nextState = {
      version: SPELLING_SERVICE_STATE_VERSION,
      phase: 'session',
      session: decorateSession(engine, learnerId, session, runtimeWordBySlug),
      feedback: {
        kind: 'info',
        headline: 'Skipped for now.',
        body: 'This word has been moved later in the round.',
      },
      summary: null,
      error: '',
      awaitingAdvance: false,
    };
    persistence.syncPracticeSession(learnerId, nextState);
    return buildTransition(nextState);
  }

  function endSession(learnerId, rawState = null) {
    const current = rawState ? initState(rawState, learnerId) : createInitialSpellingState();
    if (current.phase === 'session' && current.session) {
      persistence.abandonPracticeSession(learnerId, current);
    }
    return buildTransition(createInitialSpellingState());
  }

  function stageLabel(stage) {
    return engine.stageLabel(stage);
  }

  function resetLearner(learnerId) {
    const currentPrefs = getPrefs(learnerId);
    engine.resetProgress(learnerId);
    persistence.resetLearner?.(learnerId);
    // U8: reset ignores the writeJsonToStoragePort/saveGuardianMap return value — a warning
    // on a reset path is not actionable, and there is no current submit to
    // attach feedback to. The shape change is additive here.
    writeJsonToStoragePort(resolvedStorage, prefsKey(learnerId), {
      ...defaultSpellingPrefs(),
      ttsProvider: currentPrefs.ttsProvider,
      bufferedGeminiVoice: currentPrefs.bufferedGeminiVoice,
    });
    // U6: explicitly zero the Guardian map on the storage proxy, so hosts
    // that wire a persistence adapter without `resetLearner` (or a raw
    // storage-only host) do not leak a non-empty ks2-spell-guardian-*
    // record across a learner reset. Idempotent on an already-empty map.
    saveGuardianMap(learnerId, {});
    // P2 U11: same idempotent-zero for the Pattern Quest wobble sibling so
    // a bare-storage host (no `resetLearner` on the adapter) does not leak
    // `ks2-spell-pattern-*` records across a learner reset.
    savePatternToStorage(learnerId, { wobbling: {} });
    // P2 U2 (MEDIUM reviewer fix): belt-and-braces clear for bare-storage
    // hosts (no `repository` adapter, or a repository without
    // `resetLearner`). `savePostMegaToStorage(null)` is a silent no-op
    // because the helper guards on `normalisePostMegaRecord(null) === null`
    // (see line ~1099-1103), so calling it here would not clear anything.
    // Use `removeItem` directly on the raw storage, inside a try/catch so a
    // throw (quota/IO error on remove) doesn't crash the reset path —
    // reset is best-effort on bare hosts. Idempotent: repeated calls on an
    // already-empty slot are benign.
    try {
      resolvedStorage?.removeItem?.(postMegaKey(learnerId));
    } catch {
      // Swallow — reset is best-effort on bare hosts, and the `resetLearner`
      // API on the persistence adapter above has already cleared the
      // production path via `writeSpellingData(repositories, learnerId, {})`.
    }
    // P2 U9: clear the durable persistence-warning too. A fresh learner
    // should not inherit a previous learner's storage-failure banner after
    // a reset. Same best-effort try/catch applies.
    try {
      resolvedStorage?.removeItem?.(persistenceWarningKey(learnerId));
    } catch {
      // Swallow — reset is best-effort; a stale warning is a minor UX
      // inconvenience, not a data-loss hazard.
    }
    // P2 U12: clear achievements on reset. Unlocks are NOT meant to be
    // carried across a "reset this learner" action — that's how a parent /
    // admin re-starts a child's journey. Reset is the only surface that
    // clears achievements (the setItem INSERT-OR-IGNORE path cannot
    // overwrite an unlock row). Same best-effort try/catch as the other
    // siblings.
    try {
      resolvedStorage?.removeItem?.(achievementsKey(learnerId));
    } catch {
      // Swallow — reset is best-effort; stale achievements are cosmetic
      // across a reset.
    }
  }

  return {
    initState,
    getRuntimeContentSnapshot() {
      return cloneSerialisable(runtimeContentSnapshot);
    },
    getRuntimeRewardTracks() {
      const rewardTracks = runtimeContentSnapshot?.rewardTracks;
      return Array.isArray(rewardTracks) ? cloneSerialisable(rewardTracks) : null;
    },
    getPrefs,
    savePrefs,
    getStats,
    getWordBankEntry,
    getAnalyticsSnapshot,
    getPostMasteryState,
    startSession,
    submitAnswer,
    continueSession,
    skipWord,
    endSession,
    stageLabel,
    resetLearner,
    // U7: synchronous per-slug guardian-map writer. Exposed on the service API
    // so (a) tests can assert the merge-save contract, and (b) future guardian
    // write sites (e.g. U4's "I don't know" branch) can call it directly
    // instead of going through a whole-map load/mutate/save.
    saveGuardianRecord,
    // P2 U9: durable persistence-warning surface. `getPersistenceWarning`
    // is the read-side helper for `buildSpellingContext` (setup + session
    // scene banners). `acknowledgePersistenceWarning` is the dispatcher
    // target for the "I understand" button — sets `acknowledged: true` and
    // keeps the record for audit. `writePersistenceWarning` is internal
    // (called from the submit paths) but exposed here so tests can drive
    // it directly without constructing a full submit round.
    getPersistenceWarning,
    acknowledgePersistenceWarning,
    writePersistenceWarning,
  };
}
