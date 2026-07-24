/** Pure diff helpers for summary-only monster celebration events. */

function trackMap(monsters) {
  const map = new Map();
  if (!Array.isArray(monsters)) return map;
  for (const monster of monsters) {
    if (!monster || typeof monster.rewardTrackId !== 'string') continue;
    map.set(monster.rewardTrackId, monster);
  }
  return map;
}

/**
 * Diff two monster projection arrays into ordered celebration events.
 * Missing tracks on either side are ignored. When both caught and evolve
 * fire on the same track, caught comes first. Stage jumps emit one evolve.
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
    const stage = afterMonster.derivedStage ?? 0;

    if (!beforeMonster.caught && afterMonster.caught) {
      events.push({
        kind: 'caught',
        monsterId,
        branch,
        stage,
        rewardTrackId,
      });
    }

    const beforeStage = beforeMonster.derivedStage ?? 0;
    if (stage > beforeStage) {
      events.push({
        kind: 'evolve',
        monsterId,
        branch,
        stage,
        rewardTrackId,
      });
    }
  }

  return events;
}

/** Sum secureCount increases across tracks present on both sides. */
export function secureWordDelta(before, after) {
  const beforeByTrack = trackMap(before);
  const afterByTrack = trackMap(after);
  let total = 0;

  for (const [rewardTrackId, afterMonster] of afterByTrack) {
    const beforeMonster = beforeByTrack.get(rewardTrackId);
    if (!beforeMonster) continue;
    const delta = (afterMonster.secureCount ?? 0) - (beforeMonster.secureCount ?? 0);
    if (delta > 0) total += delta;
  }

  return total;
}

export function monsterDisplayName(monsterId) {
  if (typeof monsterId !== 'string' || monsterId.length === 0) return 'Monster';
  return `${monsterId.charAt(0).toUpperCase()}${monsterId.slice(1)}`;
}

export function celebrationHeadline(event) {
  const name = monsterDisplayName(event?.monsterId);
  if (event?.kind === 'caught') return `${name} joined your trail!`;
  if (event?.kind === 'evolve') {
    return `${name} grew to stage ${event.stage}!`;
  }
  return '';
}

export function monsterCelebrationArtUrl(monsterId, branch, stage) {
  const resolvedBranch = branch === 'b2' ? 'b2' : 'b1';
  const resolvedStage = Number.isFinite(stage) ? Math.max(0, Math.trunc(stage)) : 0;
  return `/mastery-art/monsters/${monsterId}/${resolvedBranch}/${monsterId}-${resolvedBranch}-${resolvedStage}.640.webp`;
}
