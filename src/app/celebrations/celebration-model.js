import {
  isAggregateMonster,
  monsterDisplayStage,
  monsterIsFound,
} from '../monster-progress-model.js';

/** Pure diff and copy helpers for summary-only monster celebration events. */

const HIGHEST_STAGE = 4;
const DEFAULT_PRESENTATION = Object.freeze({
  name: 'Companion',
  accent: '#3e6fa8',
  secondary: '#9fc1e8',
  pale: '#e8f0fa',
  stages: Object.freeze([
    'Companion Egg',
    'Companion',
    'Growing companion',
    'Strong companion',
    'Grand companion',
  ]),
});

const MONSTER_PRESENTATION = Object.freeze({
  inklet: Object.freeze({
    name: 'Inklet',
    accent: '#3e6fa8',
    secondary: '#9fc1e8',
    pale: '#e8f0fa',
    stages: Object.freeze([
      'Inklet Egg',
      'Inklet',
      'Scribbla',
      'Quillorn',
      'Mega Quillorn',
    ]),
  }),
  glimmerbug: Object.freeze({
    name: 'Glimmerbug',
    accent: '#b43cd9',
    secondary: '#eab3d7',
    pale: '#f8e7f1',
    stages: Object.freeze([
      'Glimmer Egg',
      'Glimmerbug',
      'Lumisprite',
      'Lanternwing',
      'Mega Lanternwing',
    ]),
  }),
  vellhorn: Object.freeze({
    name: 'Vellhorn',
    accent: '#2e8479',
    secondary: '#8fd6c7',
    pale: '#e5f3ef',
    stages: Object.freeze([
      'Vellhorn Egg',
      'Vellhorn',
      'Mossvell',
      'Cresthorn',
      'Mega Cresthorn',
    ]),
  }),
  phaeton: Object.freeze({
    name: 'Phaeton',
    accent: '#d08a2c',
    secondary: '#e8c45a',
    pale: '#f6eed7',
    stages: Object.freeze([
      'Stardrop Egg',
      'Aetherwisp',
      'Cometwing',
      'Starquill Owl',
      'Phaeton',
    ]),
  }),
});

function trackMap(monsters) {
  const map = new Map();
  if (!Array.isArray(monsters)) return map;
  for (const monster of monsters) {
    if (!monster || typeof monster.rewardTrackId !== 'string') continue;
    map.set(monster.rewardTrackId, monster);
  }
  return map;
}

function presentationFor(monsterId) {
  return MONSTER_PRESENTATION[monsterId] ?? DEFAULT_PRESENTATION;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function secureCount(monster) {
  return nonNegativeInteger(monster?.secureCount);
}

function finalTarget(monster) {
  const value = Array.isArray(monster?.thresholds)
    ? monster.thresholds.at(-1)
    : 0;
  return nonNegativeInteger(value);
}

function nextThreshold(monster, stage) {
  if (stage >= HIGHEST_STAGE || !Array.isArray(monster?.thresholds)) return null;
  const value = monster.thresholds[stage + 1];
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function progressPercent(count, target) {
  if (target <= 0) return 0;
  return Math.round(Math.min(1, Math.max(0, count / target)) * 100);
}

function progressEvent(beforeMonster, afterMonster) {
  const stage = monsterDisplayStage(afterMonster);
  const beforeCount = secureCount(beforeMonster);
  const afterCount = secureCount(afterMonster);
  const target = finalTarget(afterMonster);
  return {
    kind: 'progress',
    monsterId: afterMonster.monsterId,
    branch: afterMonster.branch ?? beforeMonster.branch ?? null,
    stage,
    rewardTrackId: afterMonster.rewardTrackId,
    secureGain: afterCount - beforeCount,
    secureCount: afterCount,
    target,
    nextThreshold: nextThreshold(afterMonster, stage),
    percentBefore: progressPercent(beforeCount, target),
    percentAfter: progressPercent(afterCount, target),
  };
}

/**
 * Diff two monster projection arrays into ordered celebration events.
 * Missing tracks on either side are ignored. When both caught and evolve
 * fire on the same track, caught comes first. Stage jumps emit one evolve.
 *
 * A direct companion that gained secure evidence without crossing a milestone
 * receives one compact progress moment. Aggregate tracks such as Phaeton reuse
 * the same evidence, so ordinary aggregate gain is deliberately not repeated;
 * their own caught/evolve milestones still celebrate.
 */
export function diffMonsterCelebrations(before, after) {
  const beforeByTrack = trackMap(before);
  const afterByTrack = trackMap(after);
  const events = [];

  for (const [rewardTrackId, afterMonster] of afterByTrack) {
    const beforeMonster = beforeByTrack.get(rewardTrackId);
    if (!beforeMonster) continue;

    const monsterId = afterMonster.monsterId;
    const branch = afterMonster.branch ?? beforeMonster.branch ?? null;
    const stage = monsterDisplayStage(afterMonster);
    const beforeStage = monsterDisplayStage(beforeMonster);
    const caughtNow = !monsterIsFound(beforeMonster) && monsterIsFound(afterMonster);
    const evolvedNow = stage > beforeStage;

    if (caughtNow) {
      events.push({
        kind: 'caught',
        monsterId,
        branch,
        stage,
        rewardTrackId,
      });
    }

    if (evolvedNow) {
      events.push({
        kind: 'evolve',
        monsterId,
        branch,
        stage,
        rewardTrackId,
      });
    }

    const gained = secureCount(afterMonster) - secureCount(beforeMonster);
    if (
      !caughtNow
      && !evolvedNow
      && gained > 0
      && !isAggregateMonster(afterMonster)
      && !isAggregateMonster(beforeMonster)
    ) {
      events.push(progressEvent(beforeMonster, afterMonster));
    }
  }

  return events;
}

/**
 * Sum newly secure words once across direct reward tracks. Aggregate tracks such
 * as Phaeton reuse the same evidence and would otherwise double the result-card
 * gain even though the learner secured only one word.
 */
export function secureWordDelta(before, after) {
  const beforeByTrack = trackMap(before);
  const afterByTrack = trackMap(after);
  let total = 0;

  for (const [rewardTrackId, afterMonster] of afterByTrack) {
    const beforeMonster = beforeByTrack.get(rewardTrackId);
    if (!beforeMonster) continue;
    if (isAggregateMonster(afterMonster) || isAggregateMonster(beforeMonster)) {
      continue;
    }
    const delta = secureCount(afterMonster) - secureCount(beforeMonster);
    if (delta > 0) total += delta;
  }

  return total;
}

export function monsterDisplayName(monsterId) {
  return presentationFor(monsterId).name;
}

export function monsterStageName(monsterId, stage) {
  const bounded = Math.max(
    0,
    Math.min(HIGHEST_STAGE, Number.isFinite(stage) ? Math.trunc(stage) : 0),
  );
  return presentationFor(monsterId).stages[bounded]
    ?? `${monsterDisplayName(monsterId)} stage ${bounded}`;
}

export function celebrationPalette(event) {
  const presentation = presentationFor(event?.monsterId);
  return {
    primary: presentation.accent,
    secondary: presentation.secondary,
    pale: presentation.pale,
  };
}

function secureGainCopy(value) {
  const gain = nonNegativeInteger(value);
  return gain === 1
    ? '1 spelling became secure'
    : `${gain} spellings became secure`;
}

function progressNextCopy(event) {
  if (event?.nextThreshold === null) return 'Every evolution has been reached.';
  const threshold = nonNegativeInteger(event?.nextThreshold);
  const current = nonNegativeInteger(event?.secureCount);
  const remaining = Math.max(0, threshold - current);
  const nextName = monsterStageName(event?.monsterId, nonNegativeInteger(event?.stage) + 1);
  if (remaining === 0) return `${nextName} is ready.`;
  return remaining === 1
    ? `1 more secure spelling to ${nextName}.`
    : `${remaining} more secure spellings to ${nextName}.`;
}

export function celebrationCopy(event) {
  const name = monsterDisplayName(event?.monsterId);
  const stageName = monsterStageName(event?.monsterId, event?.stage);
  const finalEvolution = nonNegativeInteger(event?.stage) >= HIGHEST_STAGE;

  if (event?.kind === 'caught') {
    return {
      eyebrow: event?.monsterId === 'phaeton'
        ? 'Legendary companion found'
        : 'New companion',
      headline: `${name} joined your trail!`,
      stageLabel: stageName,
      body: `Your secure spellings woke ${stageName}.`,
      announcement: `${name} joined your trail as ${stageName}.`,
    };
  }

  if (event?.kind === 'evolve') {
    return {
      eyebrow: finalEvolution ? 'Final evolution' : 'Companion evolved',
      headline: stageName,
      stageLabel: `${name} reached stage ${nonNegativeInteger(event?.stage)} of ${HIGHEST_STAGE}`,
      body: finalEvolution
        ? `${name} reached its final form.`
        : `${name} grew into a new form.`,
      announcement: `${name} evolved into ${stageName}.`,
    };
  }

  if (event?.kind === 'progress') {
    const gain = secureGainCopy(event.secureGain);
    const next = progressNextCopy(event);
    return {
      eyebrow: 'Companion progress',
      headline: `${name} grew stronger`,
      stageLabel: `${stageName} · ${nonNegativeInteger(event.secureCount)} of ${nonNegativeInteger(event.target)} secure`,
      body: `${gain}. ${next}`,
      announcement: `${name} gained ${nonNegativeInteger(event.secureGain)} secure ${event.secureGain === 1 ? 'spelling' : 'spellings'}. ${next}`,
    };
  }

  return {
    eyebrow: 'Companion',
    headline: name,
    stageLabel: stageName,
    body: '',
    announcement: name,
  };
}

export function celebrationHeadline(event) {
  return celebrationCopy(event).headline;
}

export function celebrationDurationMs(event) {
  if (event?.kind === 'progress') return 2400;
  if (event?.kind === 'evolve' && nonNegativeInteger(event?.stage) >= HIGHEST_STAGE) {
    return 4000;
  }
  if (event?.kind === 'evolve') return 3400;
  return 3000;
}

export function monsterCelebrationArtUrl(monsterId, branch, stage) {
  const resolvedMonsterId = typeof monsterId === 'string' && monsterId
    ? monsterId
    : 'inklet';
  const resolvedBranch = branch === 'b2' ? 'b2' : 'b1';
  const resolvedStage = Math.max(
    0,
    Math.min(HIGHEST_STAGE, Number.isFinite(stage) ? Math.trunc(stage) : 0),
  );
  return `/mastery-art/monsters/${resolvedMonsterId}/${resolvedBranch}/${resolvedMonsterId}-${resolvedBranch}-${resolvedStage}.640.webp`;
}
