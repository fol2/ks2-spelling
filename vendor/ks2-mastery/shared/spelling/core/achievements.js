/**
 * P2 U12 — Achievement framework skeleton.
 *
 * Exports:
 *   - `ACHIEVEMENT_IDS`               — frozen record of canonical achievement KEYs.
 *   - `ACHIEVEMENT_DEFINITIONS`       — frozen record { [achievementKey]: { title, body } }.
 *   - `deriveAchievementId`           — pure id constructor (kebab-case).
 *   - `evaluateAchievements`          — PURE evaluator returning { unlocks, progressUpdates }.
 *   - `aggregateAchievementState`     — PURE accumulator that walks a domain-event
 *                                       stream and returns the cumulative aggregate
 *                                       state (`guardianCompletedDays`, `recoveredSlugs`,
 *                                       `patternCompletions`) the evaluator reads
 *                                       from. Used by the reward subscriber to
 *                                       derive aggregate state without requiring
 *                                       a repository call.
 *
 * Design notes:
 *   - `evaluateAchievements` is a PURE function. It never reads from storage,
 *     never calls `Date.now()`, and never mutates inputs. The caller is
 *     responsible for computing aggregate state (day sets, recovery slugs,
 *     per-pattern completion history) and for persisting unlocks via the
 *     repository's locked write path.
 *   - Deterministic ID derivation enables idempotency: replaying a domain
 *     event produces the same unlock id, which the persistence layer's
 *     INSERT-OR-IGNORE drops as a duplicate (H4 adversarial guard).
 *   - Progress is tracked internally. The UI does NOT surface a progress bar
 *     before unlock — this module never emits a "progress" DOM field. The
 *     `progressUpdates` return shape is a future-extension reservation for a
 *     parent/admin audit view, never for the learner.
 *
 * Plan: docs/plans/2026-04-26-006-feat-post-mega-spelling-p2-visibility-pattern-foundation-plan.md (U12)
 */

import { SPELLING_EVENT_TYPES } from './events.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// -----------------------------------------------------------------------------
// Thresholds — tunables live here so a future "tighten from 7 days to 10" or
// "bump Recovery Expert from 10 to 15 slugs" is a one-line change.
// -----------------------------------------------------------------------------

export const GUARDIAN_MAINTAINER_DAY_THRESHOLD = 7;
export const RECOVERY_EXPERT_SLUG_THRESHOLD = 10;
export const BOSS_CLEAN_SWEEP_CORRECT_RATIO = 1.0; // 10/10 required
export const PATTERN_MASTERY_STREAK_LENGTH = 3;
export const PATTERN_MASTERY_SPAN_DAYS = 7;

// -----------------------------------------------------------------------------
// Canonical achievement ids — SYMBOLIC names for the ACHIEVEMENT_DEFINITIONS
// lookup and the deriveAchievementId dispatcher. The raw string segment form
// (`guardian:7-day`, `recovery:expert`, etc.) lives at the bottom of the file
// keyed by the symbolic name so a future rename is a single-place change.
// -----------------------------------------------------------------------------

export const ACHIEVEMENT_IDS = Object.freeze({
  GUARDIAN_7_DAY: 'GUARDIAN_7_DAY',
  RECOVERY_EXPERT: 'RECOVERY_EXPERT',
  BOSS_CLEAN_SWEEP: 'BOSS_CLEAN_SWEEP',
  PATTERN_MASTERY: 'PATTERN_MASTERY',
});

// Kebab-case segment form — used by `deriveAchievementId` to build the
// persisted id string. Keep in lockstep with the `ACHIEVEMENT_IDS` record.
const ACHIEVEMENT_ID_SEGMENTS = Object.freeze({
  [ACHIEVEMENT_IDS.GUARDIAN_7_DAY]: 'guardian:7-day',
  [ACHIEVEMENT_IDS.RECOVERY_EXPERT]: 'recovery:expert',
  [ACHIEVEMENT_IDS.BOSS_CLEAN_SWEEP]: 'boss:clean-sweep',
  [ACHIEVEMENT_IDS.PATTERN_MASTERY]: 'pattern',
});

export const ACHIEVEMENT_DEFINITIONS = Object.freeze({
  [ACHIEVEMENT_IDS.GUARDIAN_7_DAY]: Object.freeze({
    title: 'Guardian 7-day Maintainer',
    body: 'Kept Guardian Missions going on 7 different days.',
  }),
  [ACHIEVEMENT_IDS.RECOVERY_EXPERT]: Object.freeze({
    title: 'Recovery Expert',
    body: 'Brought 10 wobbling words back to steady.',
  }),
  [ACHIEVEMENT_IDS.BOSS_CLEAN_SWEEP]: Object.freeze({
    title: 'Boss Clean Sweep',
    body: 'Every Mega word landed in one Boss round.',
  }),
  [ACHIEVEMENT_IDS.PATTERN_MASTERY]: Object.freeze({
    title: 'Pattern Mastery',
    body: 'Three perfect Pattern Quests on the same pattern, one week apart.',
  }),
});

// -----------------------------------------------------------------------------
// deriveAchievementId — kebab-case deterministic id constructor.
//
// Shapes:
//   guardian.7-day:   achievement:spelling:guardian:7-day:<learnerId>
//   recovery.expert:  achievement:spelling:recovery:expert:<learnerId>
//   boss.clean-sweep: achievement:spelling:boss:clean-sweep:<learnerId>:<sessionId>
//   pattern:          achievement:spelling:pattern:<patternId>:<learnerId>
// -----------------------------------------------------------------------------

export function deriveAchievementId(achievementKey, { learnerId, sessionId, patternId } = {}) {
  const segment = ACHIEVEMENT_ID_SEGMENTS[achievementKey];
  if (!segment) return null;
  const safeLearner = typeof learnerId === 'string' && learnerId ? learnerId : 'default';
  if (achievementKey === ACHIEVEMENT_IDS.BOSS_CLEAN_SWEEP) {
    const safeSession = typeof sessionId === 'string' && sessionId ? sessionId : 'session';
    return `achievement:spelling:${segment}:${safeLearner}:${safeSession}`;
  }
  if (achievementKey === ACHIEVEMENT_IDS.PATTERN_MASTERY) {
    const safePattern = typeof patternId === 'string' && patternId ? patternId : 'pattern';
    return `achievement:spelling:${segment}:${safePattern}:${safeLearner}`;
  }
  return `achievement:spelling:${segment}:${safeLearner}`;
}

// -----------------------------------------------------------------------------
// Helpers — pure.
// -----------------------------------------------------------------------------

function normaliseCurrentAchievements(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function eventDay(event) {
  const ts = Number(event?.createdAt);
  if (!Number.isFinite(ts) || ts < 0) return 0;
  return Math.floor(ts / DAY_MS);
}

function newUnlock(id, unlockedAt, achievementKey, extras = {}) {
  return {
    id,
    achievementKey,
    unlockedAt: Number.isFinite(Number(unlockedAt)) && Number(unlockedAt) >= 0
      ? Math.floor(Number(unlockedAt))
      : 0,
    ...extras,
  };
}

// -----------------------------------------------------------------------------
// aggregateAchievementState — pure accumulator over a list of domain events.
// The reward subscriber calls this on the accumulated event stream it receives
// per publish() call; for persistent idempotency the caller threads the prior
// cumulative aggregate state (derived from the event log at boot) through.
//
// Shape of state:
//   {
//     guardianCompletedDays: Set<integer dayId>,
//     recoveredSlugs:        Set<string slug>,
//     patternCompletions:    { [patternId]: Array<{createdAt, correctCount, sessionId}> },
//   }
//
// Pattern completions are retained as a rolling window of the last
// `PATTERN_MASTERY_STREAK_LENGTH` entries per patternId — older entries are
// discarded so a learner who completes 20 quests over a year still has a
// bounded state footprint.
// -----------------------------------------------------------------------------

function emptyAggregateState() {
  return {
    guardianCompletedDays: new Set(),
    recoveredSlugs: new Set(),
    patternCompletions: {},
  };
}

export function aggregateAchievementState(events, initialState = null) {
  const state = {
    guardianCompletedDays: initialState?.guardianCompletedDays instanceof Set
      ? new Set(initialState.guardianCompletedDays)
      : new Set(),
    recoveredSlugs: initialState?.recoveredSlugs instanceof Set
      ? new Set(initialState.recoveredSlugs)
      : new Set(),
    patternCompletions: initialState?.patternCompletions
      && typeof initialState.patternCompletions === 'object'
      && !Array.isArray(initialState.patternCompletions)
      ? { ...initialState.patternCompletions }
      : {},
  };

  if (!Array.isArray(events)) return state;

  for (const event of events) {
    if (!event || typeof event.type !== 'string') continue;
    if (event.type === SPELLING_EVENT_TYPES.GUARDIAN_MISSION_COMPLETED) {
      state.guardianCompletedDays.add(eventDay(event));
    } else if (event.type === SPELLING_EVENT_TYPES.GUARDIAN_RECOVERED) {
      const slug = typeof event.wordSlug === 'string' ? event.wordSlug : '';
      if (slug) state.recoveredSlugs.add(slug);
    } else if (event.type === SPELLING_EVENT_TYPES.PATTERN_QUEST_COMPLETED) {
      const patternId = typeof event.patternId === 'string' ? event.patternId : '';
      if (!patternId) continue;
      const list = Array.isArray(state.patternCompletions[patternId])
        ? state.patternCompletions[patternId].slice()
        : [];
      list.push({
        createdAt: Number(event.createdAt) || 0,
        correctCount: Number.isFinite(Number(event.correctCount)) ? Number(event.correctCount) : 0,
        sessionId: typeof event.sessionId === 'string' ? event.sessionId : '',
      });
      // Retain the last PATTERN_MASTERY_STREAK_LENGTH entries only.
      while (list.length > PATTERN_MASTERY_STREAK_LENGTH) list.shift();
      state.patternCompletions[patternId] = list;
    }
  }

  return state;
}

// -----------------------------------------------------------------------------
// P2 U12: Progress-state keys inside `data.achievements` — the aggregate
// counters live under reserved `_progress:*` keys alongside the unlock rows.
// A caller that does `for (const [id, record] of Object.entries(data.achievements))`
// to enumerate unlocks must filter out `_progress:*` ids — the UI read-model
// already does this (see the ACHIEVEMENT_ROW_ID_PATTERN check below).
//
// We store progress this way so the evaluator can be pure (reads the input
// map, returns deltas) and the persistence layer merges both unlock rows +
// progress deltas through a single write path.
// -----------------------------------------------------------------------------

export const ACHIEVEMENT_PROGRESS_KEY_PREFIX = '_progress:';
export const ACHIEVEMENT_PROGRESS_KEYS = Object.freeze({
  GUARDIAN_DAYS: '_progress:guardian:days',
  RECOVERED_SLUGS: '_progress:recovery:slugs',
  PATTERN_COMPLETIONS: '_progress:pattern:completions',
});

/**
 * Is this a reserved progress key (not an unlock row)?
 */
export function isAchievementProgressKey(id) {
  return typeof id === 'string' && id.startsWith(ACHIEVEMENT_PROGRESS_KEY_PREFIX);
}

/**
 * Derive aggregate state from the stored `data.achievements` map's
 * `_progress:*` entries. Tolerant of missing / garbage entries.
 */
export function readAggregateStateFromAchievements(currentAchievements) {
  const safe = currentAchievements && typeof currentAchievements === 'object' && !Array.isArray(currentAchievements)
    ? currentAchievements
    : {};
  const daysRecord = safe[ACHIEVEMENT_PROGRESS_KEYS.GUARDIAN_DAYS];
  const slugsRecord = safe[ACHIEVEMENT_PROGRESS_KEYS.RECOVERED_SLUGS];
  const patternsRecord = safe[ACHIEVEMENT_PROGRESS_KEYS.PATTERN_COMPLETIONS];
  return {
    guardianCompletedDays: new Set(Array.isArray(daysRecord?.days) ? daysRecord.days : []),
    recoveredSlugs: new Set(Array.isArray(slugsRecord?.slugs) ? slugsRecord.slugs : []),
    patternCompletions: patternsRecord?.completions && typeof patternsRecord.completions === 'object' && !Array.isArray(patternsRecord.completions)
      ? { ...patternsRecord.completions }
      : {},
  };
}

/**
 * Serialise aggregate state back into `_progress:*` entries so the persistence
 * layer can merge into `data.achievements`. Returns a map of progress-key-id
 * to record.
 */
export function serialiseAggregateStateToProgressEntries(aggregate) {
  const entries = {};
  if (aggregate?.guardianCompletedDays instanceof Set) {
    entries[ACHIEVEMENT_PROGRESS_KEYS.GUARDIAN_DAYS] = {
      days: [...aggregate.guardianCompletedDays].sort((a, b) => a - b),
    };
  }
  if (aggregate?.recoveredSlugs instanceof Set) {
    entries[ACHIEVEMENT_PROGRESS_KEYS.RECOVERED_SLUGS] = {
      slugs: [...aggregate.recoveredSlugs].sort(),
    };
  }
  if (aggregate?.patternCompletions && typeof aggregate.patternCompletions === 'object') {
    entries[ACHIEVEMENT_PROGRESS_KEYS.PATTERN_COMPLETIONS] = {
      completions: { ...aggregate.patternCompletions },
    };
  }
  return entries;
}

// -----------------------------------------------------------------------------
// Per-event evaluators — each takes `{domainEvent, currentAchievements,
// learnerId, aggregateState}` and returns an array of new unlocks. No side
// effects. Achievements already in `currentAchievements` are skipped at this
// layer (caller-side idempotency); the persistence layer enforces a second
// idempotency check via INSERT-OR-IGNORE.
// -----------------------------------------------------------------------------

function evaluateGuardian7DayOnMission({ domainEvent, currentAchievements, learnerId, aggregateState }) {
  if (domainEvent.type !== SPELLING_EVENT_TYPES.GUARDIAN_MISSION_COMPLETED) return [];
  const id = deriveAchievementId(ACHIEVEMENT_IDS.GUARDIAN_7_DAY, { learnerId });
  if (currentAchievements[id]) return [];

  // Merge THIS event's day into aggregate — the caller may have pre-computed
  // aggregate state that DOES include this event, but the evaluator must also
  // work when called with only the prior aggregate + THIS event (see plan
  // pure-function contract).
  const days = new Set(aggregateState.guardianCompletedDays);
  days.add(eventDay(domainEvent));
  if (days.size < GUARDIAN_MAINTAINER_DAY_THRESHOLD) return [];
  return [newUnlock(id, domainEvent.createdAt, ACHIEVEMENT_IDS.GUARDIAN_7_DAY)];
}

function evaluateRecoveryExpertOnRecovered({ domainEvent, currentAchievements, learnerId, aggregateState }) {
  if (domainEvent.type !== SPELLING_EVENT_TYPES.GUARDIAN_RECOVERED) return [];
  const id = deriveAchievementId(ACHIEVEMENT_IDS.RECOVERY_EXPERT, { learnerId });
  if (currentAchievements[id]) return [];

  const slugs = new Set(aggregateState.recoveredSlugs);
  const slug = typeof domainEvent.wordSlug === 'string' ? domainEvent.wordSlug : '';
  if (slug) slugs.add(slug);
  if (slugs.size < RECOVERY_EXPERT_SLUG_THRESHOLD) return [];
  return [newUnlock(id, domainEvent.createdAt, ACHIEVEMENT_IDS.RECOVERY_EXPERT)];
}

function evaluateBossCleanSweepOnBossCompleted({ domainEvent, currentAchievements, learnerId }) {
  if (domainEvent.type !== SPELLING_EVENT_TYPES.BOSS_COMPLETED) return [];
  const correct = Number(domainEvent.correct);
  const length = Number(domainEvent.length);
  if (!Number.isFinite(correct) || !Number.isFinite(length) || length <= 0) return [];
  // 10/10 — every round word landed.
  if (correct !== length) return [];
  // P2 U12 LOW (u12-adv-04): reject when sessionId is null / empty.
  // `deriveAchievementId` would otherwise fall back to the literal 'session'
  // segment and collapse every session-less Boss round into a single shared
  // unlock row (first one wins; subsequent 10/10 sweeps silently drop
  // because `currentAchievements[id]` already set). Keep the row valid by
  // requiring a real sessionId.
  const sessionId = typeof domainEvent.sessionId === 'string' && domainEvent.sessionId
    ? domainEvent.sessionId
    : null;
  if (!sessionId) return [];
  const id = deriveAchievementId(ACHIEVEMENT_IDS.BOSS_CLEAN_SWEEP, { learnerId, sessionId });
  if (currentAchievements[id]) return [];
  return [newUnlock(id, domainEvent.createdAt, ACHIEVEMENT_IDS.BOSS_CLEAN_SWEEP, { sessionId })];
}

function evaluatePatternMasteryOnPatternQuest({ domainEvent, currentAchievements, learnerId, aggregateState }) {
  if (domainEvent.type !== SPELLING_EVENT_TYPES.PATTERN_QUEST_COMPLETED) return [];
  const patternId = typeof domainEvent.patternId === 'string' ? domainEvent.patternId : '';
  if (!patternId) return [];
  const id = deriveAchievementId(ACHIEVEMENT_IDS.PATTERN_MASTERY, { learnerId, patternId });
  if (currentAchievements[id]) return [];

  const prior = Array.isArray(aggregateState.patternCompletions[patternId])
    ? aggregateState.patternCompletions[patternId].slice()
    : [];
  // Append THIS event's completion (without mutating aggregateState).
  prior.push({
    createdAt: Number(domainEvent.createdAt) || 0,
    correctCount: Number.isFinite(Number(domainEvent.correctCount)) ? Number(domainEvent.correctCount) : 0,
    sessionId: typeof domainEvent.sessionId === 'string' ? domainEvent.sessionId : '',
  });
  while (prior.length > PATTERN_MASTERY_STREAK_LENGTH) prior.shift();

  if (prior.length < PATTERN_MASTERY_STREAK_LENGTH) return [];
  // All three entries must be perfect (5/5 — we encode "perfect" as
  // `correctCount === 5`, matching the Pattern Quest round length).
  const allPerfect = prior.every((entry) => Number(entry.correctCount) === 5);
  if (!allPerfect) return [];
  // P2 U12 LOW (u12-adv-03): sort by `createdAt` before extracting first/last
  // so arrival order doesn't mask a 7-day chronological span. A learner who
  // completes 3 quests out of chronological order (remote-sync catch-up,
  // clock-adjustment, replay) would otherwise trip the 7-day gate with
  // `prior[0].createdAt > prior[last].createdAt`, producing a negative span
  // and NEVER unlocking despite qualifying chronologically.
  const sorted = [...prior].sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
  const firstMs = Number(sorted[0].createdAt);
  const lastMs = Number(sorted[sorted.length - 1].createdAt);
  if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs)) return [];
  const spanDays = Math.floor((lastMs - firstMs) / DAY_MS);
  if (spanDays < PATTERN_MASTERY_SPAN_DAYS) return [];
  return [newUnlock(id, domainEvent.createdAt, ACHIEVEMENT_IDS.PATTERN_MASTERY, { patternId })];
}

const EVALUATORS = Object.freeze([
  evaluateGuardian7DayOnMission,
  evaluateRecoveryExpertOnRecovered,
  evaluateBossCleanSweepOnBossCompleted,
  evaluatePatternMasteryOnPatternQuest,
]);

/**
 * Pure evaluator. Returns `{ unlocks: [], progressUpdates: [] }` for unknown /
 * garbage inputs so callers never have to guard against undefined.
 *
 * `options.aggregateState` is optional; when omitted the evaluator derives
 * aggregate state from `currentAchievements`'s reserved `_progress:*` entries
 * (see `readAggregateStateFromAchievements`). Callers can also pass an
 * explicit aggregate when running under a harness with an independent event
 * log.
 *
 * `progressUpdates` carries the aggregate-state mutations THIS event
 * triggers. Callers merge these into their persisted `data.achievements`
 * through the same write path as unlocks; the storage proxy's critical
 * section preserves already-set unlock rows (INSERT-OR-IGNORE) but OVERWRITES
 * progress rows (aggregate state grows monotonically; the latest write is
 * always a superset of prior state because the aggregate Set-valued entries
 * only ever add).
 *
 * @param {object} domainEvent
 * @param {object|null} currentAchievements   { [id]: { unlockedAt } } map
 * @param {string} learnerId
 * @param {object} [options]
 * @param {object} [options.aggregateState]   { guardianCompletedDays, recoveredSlugs, patternCompletions }
 * @returns {{unlocks: object[], progressUpdates: object[]}}
 */
export function evaluateAchievements(domainEvent, currentAchievements, learnerId, options = {}) {
  if (!domainEvent || typeof domainEvent.type !== 'string') {
    return { unlocks: [], progressUpdates: [] };
  }
  const safeAchievements = normaliseCurrentAchievements(currentAchievements);
  const safeLearnerId = typeof learnerId === 'string' && learnerId ? learnerId : (domainEvent.learnerId || '');
  const safeAggregate = options?.aggregateState
    || readAggregateStateFromAchievements(safeAchievements);

  const unlocks = [];
  for (const evaluator of EVALUATORS) {
    const produced = evaluator({
      domainEvent,
      currentAchievements: safeAchievements,
      learnerId: safeLearnerId,
      aggregateState: safeAggregate,
    });
    if (Array.isArray(produced)) unlocks.push(...produced);
  }

  // Compute the aggregate state AFTER this event so callers can persist the
  // updated counters for the NEXT event in the stream. The progressUpdates
  // shape is a list of `{ id, record }` entries matching the persisted
  // `data.achievements` schema. Only emitted for events that actually
  // contribute to aggregate state — unknown / unrelated events return empty
  // progressUpdates so callers can `if (!updates.length) return` cheaply.
  const eventContributesToAggregate = domainEvent.type === SPELLING_EVENT_TYPES.GUARDIAN_MISSION_COMPLETED
    || domainEvent.type === SPELLING_EVENT_TYPES.GUARDIAN_RECOVERED
    || domainEvent.type === SPELLING_EVENT_TYPES.PATTERN_QUEST_COMPLETED;
  if (!eventContributesToAggregate) {
    return { unlocks, progressUpdates: [] };
  }
  const nextAggregate = aggregateAchievementState([domainEvent], safeAggregate);
  const progressEntries = serialiseAggregateStateToProgressEntries(nextAggregate);
  const progressUpdates = Object.entries(progressEntries).map(([id, record]) => ({ id, record }));

  return { unlocks, progressUpdates };
}

// -----------------------------------------------------------------------------
// P2 U12: `data.achievements` normaliser — mirrors `normalisePostMegaRecord` /
// `normalisePatternMap`. The map carries TWO kinds of entry:
//   1. Unlock rows: `{ [unlockId]: { unlockedAt } }` — normal achievement
//      ids like `achievement:spelling:guardian:7-day:learner-a`. Read-model
//      enumerates these to render the unlocked list.
//   2. Progress rows: `{ [progressKey]: { days? / slugs? / completions? } }`
//      — reserved `_progress:*` keys holding the aggregate state the
//      evaluator reads between events. NOT rendered in the UI. Read-model
//      filters by `isAchievementProgressKey`.
//
// Any garbage value in either slot collapses to `null` so the persistence
// layer skips attaching the sibling entirely.
// -----------------------------------------------------------------------------

function normaliseProgressRecord(rawValue) {
  if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) return null;
  const record = {};
  if (Array.isArray(rawValue.days)) {
    record.days = rawValue.days
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v) && v >= 0)
      .map((v) => Math.floor(v));
  }
  if (Array.isArray(rawValue.slugs)) {
    record.slugs = rawValue.slugs.filter((s) => typeof s === 'string' && s);
  }
  if (rawValue.completions && typeof rawValue.completions === 'object' && !Array.isArray(rawValue.completions)) {
    const comp = {};
    for (const [patternId, list] of Object.entries(rawValue.completions)) {
      if (typeof patternId !== 'string' || !patternId) continue;
      if (!Array.isArray(list)) continue;
      comp[patternId] = list
        .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
        .map((entry) => ({
          createdAt: Number.isFinite(Number(entry.createdAt)) ? Number(entry.createdAt) : 0,
          correctCount: Number.isFinite(Number(entry.correctCount)) ? Number(entry.correctCount) : 0,
          sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : '',
        }));
    }
    record.completions = comp;
  }
  // Only return a record if at least one progress field is present.
  if (!record.days && !record.slugs && !record.completions) return null;
  return record;
}

export function normaliseAchievementRecord(rawValue) {
  if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) return null;
  const unlockedAt = Number(rawValue.unlockedAt);
  if (!Number.isFinite(unlockedAt) || unlockedAt < 0) return null;
  return { unlockedAt: Math.floor(unlockedAt) };
}

export function normaliseAchievementsMap(rawValue) {
  if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) return null;
  const output = {};
  for (const [id, record] of Object.entries(rawValue)) {
    if (typeof id !== 'string' || !id) continue;
    if (isAchievementProgressKey(id)) {
      const normalised = normaliseProgressRecord(record);
      if (normalised) output[id] = normalised;
      continue;
    }
    const normalised = normaliseAchievementRecord(record);
    if (!normalised) continue;
    output[id] = normalised;
  }
  return output;
}
