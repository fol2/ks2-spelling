import {
  companionPalette,
  companionPresentation,
  companionStageName,
  HIGHEST_COMPANION_STAGE,
} from '../companion-presentation.js';
import { clampCompanionStage } from '../companion-stage-contract.js';
import {
  isAggregateMonster,
  monsterDisplayStage,
  monsterIsFound,
} from '../monster-progress-model.js';

/** Pure diff and copy helpers for summary-only monster celebration events. */

const HIGHEST_STAGE = HIGHEST_COMPANION_STAGE;
const CANONICAL_MONSTER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function trackMap(monsters) {
  const map = new Map();
  if (!Array.isArray(monsters)) return map;
  for (const monster of monsters) {
    if (!monster || typeof monster.rewardTrackId !== 'string') continue;
    map.set(monster.rewardTrackId, monster);
  }
  return map;
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
 * Missing tracks on either side are ignored. When both caught and evolve fire
 * on the same transition, the egg reveal comes first and the evolved form
 * follows. Stage jumps emit one evolution moment at the final earned stage.
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
        // A combined catch/evolution transition first reveals the form the
        // learner caught, rather than showing the final art twice in a row.
        stage: evolvedNow ? beforeStage : stage,
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
      && monsterIsFound(afterMonster)
      && !isAggregateMonster(afterMonster)
      && !isAggregateMonster(beforeMonster)
    ) {
      events.push(progressEvent(beforeMonster, afterMonster));
    }
  }

  return events;
}

/** Pick the first direct reward track that meaningfully progressed. */
export function primaryProgressedRewardTrackId(events, monsters) {
  const afterByTrack = trackMap(monsters);
  const list = Array.isArray(events) ? events : [];
  const isDirect = (event) => {
    const monster = afterByTrack.get(event?.rewardTrackId);
    return monster !== undefined && !isAggregateMonster(monster);
  };
  return list.find(
    (event) =>
      (event?.kind === 'caught' || event?.kind === 'evolve') && isDirect(event),
  )?.rewardTrackId
    ?? list.find(
      (event) => event?.kind === 'progress' && isDirect(event),
    )?.rewardTrackId
    ?? null;
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
  return companionPresentation(monsterId).name;
}

export function monsterStageName(monsterId, stage) {
  return companionStageName(monsterId, stage);
}

export function celebrationPalette(event) {
  if (
    event?.kind === 'camp-level'
    || event?.kind === 'milestone'
    || event?.kind === 'achievement'
  ) {
    // Brass tones match the Camp ring and Field Record strip.
    return Object.freeze({
      primary: '#a06b22',
      secondary: '#e0b463',
      pale: '#f6eed7',
    });
  }
  return companionPalette(event?.monsterId);
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
  const nextName = monsterStageName(
    event?.monsterId,
    nonNegativeInteger(event?.stage) + 1,
  );
  if (remaining === 0) return `${nextName} is ready.`;
  return remaining === 1
    ? `1 more secure spelling to ${nextName}.`
    : `${remaining} more secure spellings to ${nextName}.`;
}

export function celebrationProgressMeterCopy(event) {
  const count = nonNegativeInteger(event?.secureCount);
  const target = nonNegativeInteger(event?.target);
  if (target <= 0) return `${count} secure`;
  if (nonNegativeInteger(event?.stage) >= HIGHEST_STAGE && count >= target) {
    return `${count} secure · fully evolved`;
  }
  return `${count} / ${target} secure`;
}

/**
 * Camp-level rise on a rewarded Guardian mission. No monster art — the card
 * is the moment; the Field Record strip remains the lasting record.
 */
export function campLevelCelebration(level) {
  return {
    kind: 'camp-level',
    level: nonNegativeInteger(level),
  };
}

export function milestoneCelebration(record) {
  return Object.freeze({
    kind: 'milestone',
    level: nonNegativeInteger(record?.milestone),
    secureCount: nonNegativeInteger(record?.secureCount),
  });
}

export function achievementCelebration(chip) {
  return Object.freeze({
    kind: 'achievement',
    achievementId: chip.id,
    title: chip.title,
    body: chip.body,
  });
}

export function celebrationCopy(event) {
  if (event?.kind === 'camp-level') {
    const level = nonNegativeInteger(event.level);
    return {
      eyebrow: 'Camp rises',
      headline: 'The camp fire rises',
      stageLabel: `Camp level ${level}`,
      body: `Camp level ${level}. Every day you keep watch, the fire climbs.`,
      announcement: `The camp fire rises. Camp level ${level}.`,
    };
  }

  if (event?.kind === 'milestone') {
    const level = nonNegativeInteger(event.level);
    const noun = level === 1 ? 'spelling' : 'spellings';
    const headline = `${level} ${noun} secure`;
    const body = `Your trail has carried ${level} ${noun} to secure. Keep walking.`;
    return {
      eyebrow: 'Trail record',
      headline,
      stageLabel: `Milestone ${level}`,
      body,
      announcement: `${headline}. ${body}`,
    };
  }

  if (event?.kind === 'achievement') {
    return {
      eyebrow: 'Record of the watch',
      headline: event.title,
      stageLabel: 'Achievement unlocked',
      body: event.body,
      announcement: `Achievement unlocked. ${event.title}.`,
    };
  }

  const presentation = companionPresentation(event?.monsterId);
  const name = presentation.name;
  const stageName = monsterStageName(event?.monsterId, event?.stage);
  const finalEvolution = nonNegativeInteger(event?.stage) >= HIGHEST_STAGE;

  if (event?.kind === 'caught') {
    return {
      eyebrow: presentation.legendary
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
      stageLabel: `${stageName} · ${celebrationProgressMeterCopy(event)}`,
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
  if (
    event?.kind === 'camp-level'
    || event?.kind === 'milestone'
    || event?.kind === 'achievement'
  ) return 2800;
  if (event?.kind === 'progress') return 2400;
  if (event?.kind === 'evolve' && nonNegativeInteger(event?.stage) >= HIGHEST_STAGE) {
    return 4000;
  }
  if (event?.kind === 'evolve') return 3400;
  return 3000;
}

/*
 * Entrance beats, in milliseconds from the moment a card mounts. A catch is a
 * reveal and an evolution is a transformation, so each earns a rhythm; the
 * quiet moments keep a gentle two-beat stagger instead.
 *
 *   caught      veil → rise → burst → copy → settle
 *   evolve      veil → silhouette → shockwave → reveal → copy → settle
 *   progress    veil → mark → copy
 *   camp-level  veil → mark → copy
 *
 * Offsets ascend strictly and every last beat sits at least 600ms inside
 * celebrationDurationMs for its kind, so the finished card is readable before
 * the DOM timer advances the queue.
 */
const CELEBRATION_BEATS = Object.freeze({
  // 120 lifts the art, 220 later the light breaks, then the copy opens out.
  caught: Object.freeze({
    veil: 0,
    rise: 120,
    burst: 340,
    copy: 650,
    settle: 1020,
  }),
  // A steady ~330ms pulse once the silhouette is up: ring, reveal, name, meter.
  evolve: Object.freeze({
    veil: 0,
    silhouette: 90,
    shockwave: 420,
    reveal: 760,
    copy: 1080,
    settle: 1400,
  }),
  progress: Object.freeze({ veil: 0, mark: 90, copy: 380 }),
  milestone: Object.freeze({ veil: 0, mark: 110, copy: 430 }),
  achievement: Object.freeze({ veil: 0, mark: 110, copy: 430 }),
  'camp-level': Object.freeze({ veil: 0, mark: 110, copy: 430 }),
});

/**
 * Named entrance beats for one celebration kind. This model is the single
 * source the stylesheet delays mirror — every per-kind `animation-delay` in
 * celebrations.css, and the live evolve schedule in celebration-scene.js,
 * quotes one of these numbers. Unknown kinds take the progress shape. Tests pin
 * the monotonicity and the duration bound.
 */
export function celebrationBeats(kind) {
  return Object.hasOwn(CELEBRATION_BEATS, kind)
    ? CELEBRATION_BEATS[kind]
    : CELEBRATION_BEATS.progress;
}

/** Stable identity for haptics and remaining-time bookkeeping. */
export function celebrationEventKey(event, index = 0) {
  if (!event) return '';
  return [
    event.rewardTrackId ?? '',
    event.kind ?? '',
    event.branch ?? '',
    // Camp-level moments carry `level` rather than a companion stage.
    nonNegativeInteger(event.stage ?? event.level),
    nonNegativeInteger(event.secureCount),
    nonNegativeInteger(event.secureGain),
    nonNegativeInteger(index),
  ].join(':');
}

export function monsterCelebrationArtUrl(monsterId, branch, stage) {
  if (typeof monsterId !== 'string' || !CANONICAL_MONSTER_ID.test(monsterId)) {
    return null;
  }
  const resolvedBranch = branch === 'b2' ? 'b2' : 'b1';
  const resolvedStage = clampCompanionStage(stage);
  return `/mastery-art/monsters/${monsterId}/${resolvedBranch}/${monsterId}-${resolvedBranch}-${resolvedStage}.640.webp`;
}

/**
 * Whether the Celebration Stage may mount a live Phaser canvas over the card
 * art. Only catch and evolution moments qualify, and only when motion, WebGL
 * context and foreground visibility are all clear. Progress and camp-level
 * cards (no monster art) and any guard failure keep the static presentation.
 */
export function celebrationStageDecision({
  kind,
  reducedMotion = false,
  contextLost = false,
  backgrounded = false,
} = {}) {
  if (kind !== 'caught' && kind !== 'evolve') return 'static';
  if (reducedMotion || contextLost || backgrounded) return 'static';
  return 'live';
}
