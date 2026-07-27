import { HIGHEST_MONSTER_STAGE, monsterArt } from './mastery-art.js';
import {
  directSecureWordTotal,
  isAggregateMonster,
  monsterBranch,
  monsterCatchThreshold,
  monsterDisplayStage,
  monsterIsFound,
  monsterSourceRewardTrackIds,
} from './monster-progress-model.js';

// Presentation facts about each painted companion. Growth itself always comes
// from the learner's saved reward-track state; this table only supplies the
// names, banding and accent the Codex needs to draw one.
const COMPANIONS = Object.freeze({
  inklet: Object.freeze({
    name: 'Inklet',
    band: 'Years 3–4',
    accent: '#3e6fa8',
    blurb: 'Grows as Year 3–4 spellings become secure.',
    hint: 'Secure one Year 3–4 spelling to wake it',
    stages: Object.freeze([
      'Inklet Egg', 'Inklet', 'Scribbla', 'Quillorn', 'Mega Quillorn',
    ]),
  }),
  glimmerbug: Object.freeze({
    name: 'Glimmerbug',
    band: 'Years 5–6',
    accent: '#b43cd9',
    blurb: 'Appears as Year 5–6 spellings settle into memory.',
    hint: 'Secure one Year 5–6 spelling to wake it',
    stages: Object.freeze([
      'Glimmer Egg', 'Glimmerbug', 'Lumisprite', 'Lanternwing', 'Mega Lanternwing',
    ]),
  }),
  vellhorn: Object.freeze({
    name: 'Vellhorn',
    band: 'Extra',
    accent: '#2e8479',
    blurb: 'Appears as Extra spellings stretch beyond the statutory pools.',
    hint: 'Secure one Extra spelling to wake it',
    stages: Object.freeze([
      'Vellhorn Egg', 'Vellhorn', 'Mossvell', 'Cresthorn', 'Mega Cresthorn',
    ]),
  }),
  phaeton: Object.freeze({
    name: 'Phaeton',
    band: 'Legendary',
    accent: '#d08a2c',
    blurb: 'Rises only when both spelling pools grow strong.',
    hint: 'Keep both pools growing to find it',
    stages: Object.freeze([
      'Stardrop Egg', 'Aetherwisp', 'Cometwing', 'Starquill Owl', 'Phaeton',
    ]),
  }),
});

const FALLBACK = Object.freeze({
  name: 'Companion',
  band: 'Trail',
  accent: '#3e6fa8',
  blurb: 'Grows as spellings become secure.',
  hint: 'Secure one spelling to wake it',
  stages: Object.freeze(['Egg', 'Stage one', 'Stage two', 'Stage three', 'Stage four']),
});

function companionFacts(monsterId) {
  return COMPANIONS[monsterId] ?? FALLBACK;
}

function catalogueNumber(index) {
  return String(index + 1).padStart(3, '0');
}

function secureCountOf(monster) {
  return Number.isSafeInteger(monster?.secureCount) && monster.secureCount >= 0
    ? monster.secureCount
    : 0;
}

function stageOf(monster) {
  // Evolution is an earned reward, not a volatile diagnostic. The A3 authority
  // keeps both the current derived stage and a monotonic earned high-water; the
  // Codex and Trail must render the latter so a temporarily wobbly word cannot
  // visually devolve a companion.
  return monsterDisplayStage(monster, HIGHEST_MONSTER_STAGE);
}

function fullyGrownAt(thresholds) {
  return Array.isArray(thresholds) ? thresholds.at(-1) ?? 0 : 0;
}

/** Words still to secure before the next painted stage, or null when grown. */
function wordsToNextStage(monster, stage) {
  if (stage >= HIGHEST_MONSTER_STAGE) return null;
  const next = Array.isArray(monster?.thresholds)
    ? monster.thresholds[stage + 1]
    : undefined;
  if (typeof next !== 'number') return null;
  return Math.max(0, next - secureCountOf(monster));
}

function undiscoveredHint(monster, facts, aggregate) {
  if (!aggregate) return facts.hint;
  const threshold = monsterCatchThreshold(monster);
  return `Secure ${threshold} spellings across both pools to find it`;
}

function buildEntry(monster, index) {
  const facts = companionFacts(monster.monsterId);
  const stage = stageOf(monster);
  const found = monsterIsFound(monster);
  const aggregate = isAggregateMonster(monster);
  const branch = monsterBranch(monster);
  const secureCount = secureCountOf(monster);
  const target = fullyGrownAt(monster.thresholds);
  const remaining = wordsToNextStage(monster, stage);
  const sourceRewardTrackIds = monsterSourceRewardTrackIds(monster);
  return {
    rewardTrackId: monster.rewardTrackId,
    monsterId: monster.monsterId,
    ...(sourceRewardTrackIds === null ? {} : { sourceRewardTrackIds }),
    number: catalogueNumber(index),
    accent: facts.accent,
    aggregate,
    branch,
    found,
    stage,
    secureCount,
    target,
    // The Codex roster withholds an unfound creature's identity; screens that
    // are already growing this companion use displayName instead.
    name: found ? facts.name : 'Undiscovered',
    displayName: facts.name,
    title: found ? facts.stages[stage] : '???',
    band: found ? facts.band : 'Undiscovered',
    blurb: facts.blurb,
    stageLabel: found
      ? `Stage ${stage} of ${HIGHEST_MONSTER_STAGE}`
      : 'Not yet found',
    art: monsterArt(monster.monsterId, found ? stage : 0, branch),
    percent: target === 0
      ? 0
      : Math.round(Math.min(1, secureCount / target) * 100),
    count: `${secureCount} of ${target}`,
    next: found
      ? (remaining === null
        ? 'Fully grown'
        : `${remaining} more to ${facts.stages[stage + 1]}`)
      : undiscoveredHint(monster, facts, aggregate),
    growth: facts.stages.map((label, position) => ({
      key: `${monster.rewardTrackId}-${position}`,
      label: found && position <= stage ? label : '???',
      art: monsterArt(monster.monsterId, position, branch),
      reached: found && position <= stage,
      here: found && position === stage,
    })),
    pips: Array.from({ length: HIGHEST_MONSTER_STAGE + 1 }, (_, position) => (
      found && position <= stage
    )),
  };
}

/**
 * Build the Codex view model from the learner's saved reward tracks. The roster
 * only ever contains companions this learner's content actually publishes, so
 * the screen never advertises a creature that cannot be reached.
 */
export function buildCodex(monsters = [], selectedRewardTrackId = null) {
  const roster = monsters.map(buildEntry);
  const hero = roster.find(
    (entry) => entry.rewardTrackId === selectedRewardTrackId,
  ) ?? roster[0] ?? null;
  const found = roster.filter((entry) => entry.found);
  return {
    roster,
    hero,
    foundCount: String(found.length).padStart(2, '0'),
    rosterCount: String(roster.length).padStart(2, '0'),
    // Phaeton is the union of Inklet and Glimmerbug evidence. Count the direct
    // tracks once rather than adding the same secure words a second time through
    // their legendary aggregate.
    secureWords: directSecureWordTotal(roster),
    highestStage: roster.reduce((top, entry) => Math.max(top, entry.stage), 0),
    leftToFind: roster.length - found.length,
  };
}

/**
 * Trail meadow pets mirror Codex Companions: only found creatures appear, in
 * roster order, capped to the painted meadow slots. Unfound companions stay
 * off the downs entirely — no floating egg art.
 */
export function trailMeadowCompanions(roster = [], slotCount = Infinity) {
  if (!Array.isArray(roster)) return [];
  const limit = Number.isFinite(slotCount)
    ? Math.max(0, Math.trunc(slotCount))
    : Infinity;
  return roster.filter((entry) => entry.found).slice(0, limit);
}
