import { isStatutoryCoreWord } from './taxonomy.js';

/**
 * P2 U10: Spelling pattern registry.
 *
 * A pattern is a morphological or phonological "clue" a KS2 learner can
 * re-apply to many different core words: `-tion`, `i before e`, silent
 * letters, prefixes such as `pre-`/`re-`, and so on. Every core word in
 * `content/spelling.seed.json` carries one or more `patternIds` (or an
 * explicit `exception-word` / `statutory-exception` tag when no regular
 * KS2 pattern applies, e.g. `catch`).
 *
 * The registry is the single source of truth U11 (Pattern Quest) draws
 * from when it builds a 5-card quest round. Each definition carries:
 *
 *   - id             opaque kebab-case identifier, matches tags in seed.
 *   - title          short, child-facing label.
 *   - rule           one-sentence, child-facing description of the clue.
 *   - examples       3-6 well-known words that exhibit the pattern.
 *   - traps          common misspellings / pitfalls for this pattern.
 *   - curriculumBand one of `'y3-4'` | `'y5-6'` (GOV.UK English Appendix 1).
 *   - promptTypes    which U11 card templates this pattern supports —
 *                    `('spell' | 'classify' | 'explain' | 'detect-error')[]`.
 *                    Every promptable pattern ships with all four types
 *                    pre-U11; U11 may narrow this per-pattern once live.
 *                    The special `exception-word` entry carries an empty
 *                    array so it cannot host a quest — it is a registry-
 *                    only catch-all for words the tag system lists under
 *                    `tags: ['exception-word']` rather than a `patternIds`
 *                    entry.
 *
 * Convention: patterns are defined in the stable order below. The registry
 * is frozen at module load so a consumer cannot mutate a shared record.
 *
 * See plan: docs/plans/2026-04-26-006-feat-post-mega-spelling-p2-visibility-pattern-foundation-plan.md §U10.
 */

const ALL_PROMPT_TYPES = Object.freeze(['spell', 'classify', 'explain', 'detect-error']);

/**
 * F10 feasibility: minimum number of core words a pattern must tag before it
 * graduates into the "launched" subset (`computeLaunchedPatternIds`). U11
 * Pattern Quest Card-4 selection needs at least 4 distinct core words per
 * pattern to pick without repetition. Patterns below this threshold stay
 * in the registry but U11 refuses to launch quests for them — the
 * validator emits a warning (never a failure) so content editors can see
 * the gap.
 */
export const PATTERN_LAUNCH_THRESHOLD = 4;

/**
 * Full 15-pattern registry. `computeLaunchedPatternIds()` (below) returns a
 * runtime subset — patterns with &lt;4 tagged core words are excluded from
 * the launched subset but stay in the registry so future expansion can
 * lift them into launch without a content-model bump.
 */
export const SPELLING_PATTERNS = Object.freeze({
  'suffix-tion': Object.freeze({
    id: 'suffix-tion',
    title: 'Words ending in -tion',
    rule: 'Many nouns end with -tion and sound like "shun", often from a verb.',
    examples: Object.freeze(['nation', 'position', 'competition', 'question', 'mention']),
    traps: Object.freeze(['competishun', 'posishon', 'questian']),
    curriculumBand: 'y3-4',
    promptTypes: ALL_PROMPT_TYPES,
  }),
  'suffix-sion': Object.freeze({
    id: 'suffix-sion',
    title: 'Words ending in -sion',
    rule: 'Some nouns end with -sion when the base has a "d", "de" or "s" sound before the ending.',
    examples: Object.freeze(['division', 'decision', 'television', 'conclusion']),
    traps: Object.freeze(['divishun', 'decishon']),
    curriculumBand: 'y3-4',
    promptTypes: ALL_PROMPT_TYPES,
  }),
  'suffix-cian': Object.freeze({
    id: 'suffix-cian',
    title: 'Words ending in -cian',
    rule: 'Job names often end with -cian when they come from an -ic or -ics subject.',
    examples: Object.freeze(['magician', 'electrician', 'politician', 'musician']),
    traps: Object.freeze(['magishun', 'politican']),
    curriculumBand: 'y5-6',
    promptTypes: ALL_PROMPT_TYPES,
  }),
  'suffix-ous': Object.freeze({
    id: 'suffix-ous',
    title: 'Words ending in -ous',
    rule: 'Adjectives ending in -ous often mean "full of" something.',
    examples: Object.freeze(['famous', 'dangerous', 'various', 'mysterious', 'disastrous', 'mischievous']),
    traps: Object.freeze(['famus', 'dangeros', 'mischievious']),
    curriculumBand: 'y3-4',
    promptTypes: ALL_PROMPT_TYPES,
  }),
  'suffix-ly': Object.freeze({
    id: 'suffix-ly',
    title: 'Words ending in -ly',
    rule: 'Add -ly to an adjective to make an adverb. If the root ends in -y, change it to -i before -ly.',
    examples: Object.freeze(['quickly', 'happily', 'clearly', 'accidentally', 'immediately']),
    traps: Object.freeze(['happyly', 'accidently']),
    curriculumBand: 'y3-4',
    promptTypes: ALL_PROMPT_TYPES,
  }),
  'suffix-able-ible': Object.freeze({
    id: 'suffix-able-ible',
    title: 'Words ending in -able or -ible',
    rule: '-able usually attaches to whole root words; -ible often attaches to roots that cannot stand alone.',
    examples: Object.freeze(['possible', 'available', 'divisible', 'sensible', 'terrible']),
    traps: Object.freeze(['possable', 'availible']),
    curriculumBand: 'y5-6',
    promptTypes: ALL_PROMPT_TYPES,
  }),
  'silent-letter': Object.freeze({
    id: 'silent-letter',
    title: 'Words with silent letters',
    rule: 'Some letters are written but not sounded, such as the silent "k" in "know" or silent "h" in "hour".',
    examples: Object.freeze(['knowledge', 'island', 'build', 'answer', 'muscle']),
    traps: Object.freeze(['iland', 'nowledge']),
    curriculumBand: 'y3-4',
    promptTypes: ALL_PROMPT_TYPES,
  }),
  'i-before-e': Object.freeze({
    id: 'i-before-e',
    title: 'The "i before e except after c" pattern',
    rule: 'Write i before e except after c, when the sound is "ee" — but many common words are exceptions.',
    examples: Object.freeze(['believe', 'achieve', 'conscience', 'ancient']),
    traps: Object.freeze(['beleive', 'acheive']),
    curriculumBand: 'y5-6',
    promptTypes: ALL_PROMPT_TYPES,
  }),
  'double-consonant': Object.freeze({
    id: 'double-consonant',
    title: 'Words with a double consonant',
    rule: 'A short vowel before a suffix often needs the final consonant doubled, such as "running" or "stopped".',
    examples: Object.freeze(['address', 'different', 'difficult', 'occasion', 'embarrass', 'occur']),
    traps: Object.freeze(['adress', 'diferent', 'embarass']),
    curriculumBand: 'y3-4',
    promptTypes: ALL_PROMPT_TYPES,
  }),
  'prefix-un-in-im': Object.freeze({
    id: 'prefix-un-in-im',
    title: 'Prefixes un-, in-, im-',
    rule: 'Add un-, in- or im- to the front of a word to mean "not". Use im- before m or p.',
    examples: Object.freeze(['unhappy', 'invisible', 'impossible', 'immediate', 'important']),
    traps: Object.freeze(['inpossible', 'unpossible']),
    curriculumBand: 'y3-4',
    promptTypes: ALL_PROMPT_TYPES,
  }),
  'prefix-pre-re-de': Object.freeze({
    id: 'prefix-pre-re-de',
    title: 'Prefixes pre-, re-, de-',
    rule: 'Pre- means "before", re- means "again", de- means "down from" or "away".',
    examples: Object.freeze(['prepare', 'return', 'decide', 'describe', 'develop']),
    traps: Object.freeze(['prepair', 'dicide']),
    curriculumBand: 'y3-4',
    promptTypes: ALL_PROMPT_TYPES,
  }),
  'homophone': Object.freeze({
    id: 'homophone',
    title: 'Homophones',
    rule: 'Some words sound the same but are spelled differently and mean different things, such as "their", "there" and "they’re".',
    examples: Object.freeze(['heard', 'weight', 'eight']),
    traps: Object.freeze(['hered', 'wieght']),
    curriculumBand: 'y3-4',
    promptTypes: ALL_PROMPT_TYPES,
  }),
  'root-graph-scribe': Object.freeze({
    id: 'root-graph-scribe',
    title: 'Roots -graph- and -scribe-',
    rule: 'The root -graph- means "write" or "draw"; -scribe- also means "write".',
    // Only `describe` is tagged in the current core pool. The other entries are
    // illustrative of the rule (paragraph/photograph/subscribe/prescribe are
    // classic -graph-/-scribe- words a KS2 learner should recognise) but do
    // not yet exist as core-pool words — they stay here as teaching examples
    // so the card copy is honest about the rule even when the tagged set is
    // still below the F10 launch threshold of 4.
    examples: Object.freeze(['describe', 'paragraph', 'photograph', 'subscribe']),
    traps: Object.freeze(['discribe']),
    curriculumBand: 'y5-6',
    promptTypes: ALL_PROMPT_TYPES,
  }),
  'root-port-spect': Object.freeze({
    id: 'root-port-spect',
    title: 'Roots -port- and -spect-',
    rule: 'The root -port- means "carry"; -spect- means "look".',
    examples: Object.freeze(['important', 'opportunity', 'suspect', 'respect']),
    traps: Object.freeze(['opertunity']),
    curriculumBand: 'y5-6',
    promptTypes: ALL_PROMPT_TYPES,
  }),
  // exception-word is a catch-all tag, not a promptable pattern. It stays in
  // the registry for traversal completeness but computeLaunchedPatternIds and
  // U11 Pattern Quest filtering will reject empty promptTypes. The validator's
  // pattern_below_launch_threshold warning is suppressed for it by the same
  // empty-promptTypes filter, so it never permanently shows up in the
  // warning stream.
  'exception-word': Object.freeze({
    id: 'exception-word',
    title: 'Exception words',
    rule: 'Some words do not follow a KS2 pattern — they just have to be learned.',
    examples: Object.freeze(['yacht', 'queue', 'rhythm', 'lightning']),
    traps: Object.freeze(['yot', 'cue', 'rythm']),
    curriculumBand: 'y5-6',
    promptTypes: Object.freeze([]),
  }),
});

/**
 * Stable array of pattern identifiers. Exposed for consumers that need an
 * iteration order (Pattern Quest selector, Admin dashboard, etc.). Order
 * matches the `SPELLING_PATTERNS` keys declared above.
 */
export const SPELLING_PATTERN_IDS = Object.freeze(Object.keys(SPELLING_PATTERNS));

/**
 * F10 feasibility finding: U11 Card-4 selection requires ≥4 distinct core
 * words per pattern. Patterns below the threshold stay in the registry but
 * are excluded from the "launched" subset — U11 refuses to start a quest
 * for a non-launched pattern. This is the pure-function form; consumers
 * pass a map of slug -> patternIds[] derived from the runtime content
 * snapshot.
 *
 * Patterns with empty `promptTypes` (today: `exception-word`) are registry-
 * only catch-alls, not promptable quests. They are excluded from the
 * launched set even if they would clear the threshold, so the warning
 * stream does not permanently report them.
 *
 * @param {Object} patternIdsBySlug  slug -> patternIds[]
 * @param {number} [threshold]       minimum core words per pattern
 * @returns {string[]}               launched pattern ids, in registry order
 */
export function computeLaunchedPatternIds(patternIdsBySlug, threshold = PATTERN_LAUNCH_THRESHOLD) {
  const counts = new Map();
  if (patternIdsBySlug && typeof patternIdsBySlug === 'object') {
    for (const value of Object.values(patternIdsBySlug)) {
      if (!Array.isArray(value)) continue;
      for (const patternId of value) {
        if (typeof patternId !== 'string' || !patternId) continue;
        counts.set(patternId, (counts.get(patternId) || 0) + 1);
      }
    }
  }
  return SPELLING_PATTERN_IDS.filter((id) => {
    const pattern = SPELLING_PATTERNS[id];
    if (!pattern || !Array.isArray(pattern.promptTypes) || pattern.promptTypes.length === 0) {
      return false;
    }
    return (counts.get(id) || 0) >= threshold;
  });
}

/**
 * Orphan sanitiser parity (mirrors `isGuardianEligibleSlug` in
 * `service-contract.js`). A slug is eligible for Pattern Quest selection
 * iff its `patternId` still exists in the registry AND the slug is still
 * published in the current content snapshot. Used by U11 to filter
 * `data.pattern.wobbling[slug]` entries so a content hot-swap that drops
 * a pattern does not strand a wobble record on a missing pattern.
 *
 * Tolerant of null/garbage inputs — returns false rather than throwing so
 * a partially-corrupt persisted blob cannot crash the read path.
 *
 * @param {string} slug
 * @param {string} patternId
 * @param {object|null} wordBySlug
 * @returns {boolean}
 */
export function isPatternEligibleSlug(slug, patternId, wordBySlug) {
  if (!slug || typeof slug !== 'string') return false;
  if (!patternId || typeof patternId !== 'string') return false;
  if (!Object.prototype.hasOwnProperty.call(SPELLING_PATTERNS, patternId)) return false;
  if (!wordBySlug || typeof wordBySlug !== 'object') return false;
  const word = wordBySlug[slug];
  if (!word || typeof word !== 'object') return false;
  if (!isStatutoryCoreWord(word)) return false;
  // The word must actually carry the requested patternId. Otherwise a content hot-swap
  // that retags a word (without removing the slug or pattern) would still pass as eligible.
  if (!Array.isArray(word.patternIds) || !word.patternIds.includes(patternId)) {
    return false;
  }
  return true;
}
