import { clampCompanionStage } from '../companion-stage-contract.js';

const PATH_BY_MONSTER = Object.freeze({
  inklet: 'walk',
  glimmerbug: 'fly-a',
  phaeton: 'fly-b',
  vellhorn: 'walk-b',
});

const MOTION_BY_MONSTER = Object.freeze({
  inklet: Object.freeze(['egg-breathe', 'waddle', 'trot', 'stride', 'stride']),
  glimmerbug: Object.freeze(['egg-breathe', 'hover', 'flutter', 'glide', 'glide']),
  phaeton: Object.freeze(['egg-breathe', 'hover', 'glide', 'soar', 'soar']),
  vellhorn: Object.freeze(['egg-breathe', 'amble', 'amble', 'stalk', 'stalk']),
});

const SPECIES_SCALE = Object.freeze({
  inklet: 1.02,
  glimmerbug: 0.94,
  phaeton: 1.08,
  vellhorn: 1,
});

const STAGE_SCALE = Object.freeze([0.78, 0.82, 0.9, 1, 1.07]);

// Matches the reviewed upstream asset-facing authority. Every unlisted asset is
// painted facing left; these authored silhouettes face right.
const RIGHT_FACING_ASSETS = new Set([
  'glimmerbug-b2-4',
  'phaeton-b1-0',
  'phaeton-b1-1',
  'phaeton-b1-2',
  'phaeton-b1-3',
  'phaeton-b1-4',
  'phaeton-b2-2',
  'vellhorn-b1-0',
]);

const SOLO_SLOTS = Object.freeze({
  egg: Object.freeze({ x: 50, footY: 84, size: 34 }),
  walk: Object.freeze({ x: 43, footY: 86, size: 42 }),
  'walk-b': Object.freeze({ x: 39, footY: 86, size: 40 }),
  'fly-a': Object.freeze({ x: 59, footY: 69, size: 34 }),
  'fly-b': Object.freeze({ x: 49, footY: 73, size: 36 }),
});

const HABITAT_SLOTS = Object.freeze({
  egg: Object.freeze([
    Object.freeze({ x: 24, footY: 86, size: 32 }),
    Object.freeze({ x: 52, footY: 80, size: 29 }),
    Object.freeze({ x: 78, footY: 87, size: 33 }),
    Object.freeze({ x: 37, footY: 72, size: 27 }),
  ]),
  walk: Object.freeze([
    Object.freeze({ x: 24, footY: 87, size: 41 }),
    Object.freeze({ x: 55, footY: 82, size: 37 }),
    Object.freeze({ x: 76, footY: 88, size: 40 }),
    Object.freeze({ x: 38, footY: 75, size: 34 }),
  ]),
  'walk-b': Object.freeze([
    Object.freeze({ x: 17, footY: 81, size: 38 }),
    Object.freeze({ x: 43, footY: 88, size: 41 }),
    Object.freeze({ x: 68, footY: 83, size: 36 }),
    Object.freeze({ x: 31, footY: 73, size: 32 }),
  ]),
  'fly-a': Object.freeze([
    Object.freeze({ x: 67, footY: 61, size: 31 }),
    Object.freeze({ x: 82, footY: 48, size: 27 }),
    Object.freeze({ x: 49, footY: 55, size: 29 }),
    Object.freeze({ x: 74, footY: 72, size: 33 }),
  ]),
  'fly-b': Object.freeze([
    Object.freeze({ x: 42, footY: 66, size: 33 }),
    Object.freeze({ x: 58, footY: 54, size: 30 }),
    Object.freeze({ x: 29, footY: 58, size: 29 }),
    Object.freeze({ x: 52, footY: 76, size: 36 }),
  ]),
});

const PATH_TIMING = Object.freeze({
  egg: Object.freeze({ duration: [0, 0], forward: [0, 0], back: [0, 0] }),
  walk: Object.freeze({ duration: [23, 29], forward: [28, 50], back: [-34, -20] }),
  'walk-b': Object.freeze({ duration: [26, 32], forward: [-38, -22], back: [20, 38] }),
  'fly-a': Object.freeze({ duration: [15, 19], forward: [30, 54], back: [-34, -20] }),
  'fly-b': Object.freeze({ duration: [18, 23], forward: [-48, -26], back: [24, 48] }),
});

const GAIT_DURATION = Object.freeze({
  'egg-breathe': 3.8,
  waddle: 1.55,
  trot: 1.18,
  stride: 1.35,
  amble: 1.8,
  stalk: 1.55,
  hover: 3.2,
  flutter: 2.4,
  glide: 4.1,
  soar: 5.2,
});

function hashString(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function valueBetween(seed, minimum, maximum) {
  if (minimum === maximum) return minimum;
  const fraction = (seed >>> 0) / 0xffffffff;
  return minimum + (maximum - minimum) * fraction;
}

function stableNumber(key, label, minimum, maximum) {
  return valueBetween(hashString(`${key}:${label}`), minimum, maximum);
}

function pathFor(companion) {
  const stage = clampCompanionStage(companion?.stage);
  if (stage === 0) return 'egg';
  return PATH_BY_MONSTER[companion?.monsterId] ?? 'walk';
}

function motionFor(companion, stage) {
  return MOTION_BY_MONSTER[companion?.monsterId]?.[stage]
    ?? (stage === 0 ? 'egg-breathe' : 'amble');
}

function laneFor(path) {
  return path.startsWith('fly') ? 'air' : 'ground';
}

function perspectiveScale(footY) {
  const depth = Math.max(0, Math.min(1, (footY - 46) / 42));
  return 0.82 + depth * 0.3;
}

function slotDistance(left, right) {
  const dx = left.x - right.x;
  const dy = (left.footY - right.footY) * 1.4;
  return Math.hypot(dx, dy);
}

function minimumSpacing(left, right) {
  if (left.lane !== right.lane) return 18;
  if (left.path === 'egg' && right.path === 'egg') return 22;
  return 28;
}

function slotScore(candidate, placed) {
  if (placed.length === 0) return Infinity;
  return Math.min(...placed.map((other) => (
    slotDistance(candidate, other) / minimumSpacing(candidate, other)
  )));
}

function chooseSlot(path, key, placed, population) {
  if (population === 1) {
    return { ...SOLO_SLOTS[path], path, lane: laneFor(path) };
  }
  const candidates = HABITAT_SLOTS[path] ?? HABITAT_SLOTS.walk;
  const offset = hashString(`${key}:slot`) % candidates.length;
  let best = null;
  let bestScore = -Infinity;
  for (let index = 0; index < candidates.length; index += 1) {
    const source = candidates[(index + offset) % candidates.length];
    const candidate = { ...source, path, lane: laneFor(path) };
    const score = slotScore(candidate, placed);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function visualFace(monsterId, branch, stage) {
  const assetKey = `${monsterId}-${branch}-${stage}`;
  return RIGHT_FACING_ASSETS.has(assetKey) ? 1 : -1;
}

function visualOffsetY(path, monsterId, stage) {
  if (path === 'egg') {
    if (monsterId === 'glimmerbug') return 11;
    if (monsterId === 'inklet') return 9;
    if (monsterId === 'vellhorn') return 7;
    return 5;
  }
  if (path.startsWith('walk')) return stage <= 1 ? 5 : 2;
  return 0;
}

function routeFor(path, key, stage) {
  const timing = PATH_TIMING[path] ?? PATH_TIMING.walk;
  const duration = stableNumber(key, 'duration', ...timing.duration);
  const maturity = 0.88 + stage * 0.035;
  const forward = stableNumber(key, 'forward', ...timing.forward) * maturity;
  const back = stableNumber(key, 'back', ...timing.back) * maturity;
  const flying = path.startsWith('fly');
  return {
    duration: Number(duration.toFixed(2)),
    delay: duration === 0
      ? 0
      : Number((-stableNumber(key, 'delay', 0, duration)).toFixed(2)),
    forward: Math.round(forward),
    back: Math.round(back),
    forwardY: flying
      ? Math.round(stableNumber(key, 'forward-y', path === 'fly-a' ? -9 : -15, 2))
      : 0,
    backY: flying
      ? Math.round(stableNumber(key, 'back-y', 6, path === 'fly-a' ? 17 : 24))
      : 0,
  };
}

function finalSize(slot, companion, stage) {
  const speciesScale = SPECIES_SCALE[companion.monsterId] ?? 1;
  const scale = perspectiveScale(slot.footY) * STAGE_SCALE[stage] * speciesScale;
  return Math.max(23, Math.min(49, Number((slot.size * scale).toFixed(2))));
}

function describeBehaviour(path, motion) {
  if (path === 'egg') return 'resting in a nest';
  if (path === 'walk' || path === 'walk-b') return `${motion} around the meadow`;
  return `${motion} above the meadow`;
}

export function trailCompanionBehaviour(companion = {}) {
  const stage = clampCompanionStage(companion.stage);
  const path = pathFor(companion);
  const motion = motionFor(companion, stage);
  return Object.freeze({
    path,
    motion,
    lane: laneFor(path),
    description: describeBehaviour(path, motion),
  });
}

export function buildTrailMeadowCompanions(
  roster = [],
  { seed = 'trail-meadow' } = {},
) {
  const found = Array.isArray(roster)
    ? roster.filter((companion) => companion?.found && companion?.art)
    : [];
  const placed = [];
  return found.map((companion, index) => {
    const stage = clampCompanionStage(companion.stage);
    const branch = companion.branch === 'b2' ? 'b2' : 'b1';
    const behaviour = trailCompanionBehaviour({ ...companion, stage });
    const key = [
      seed,
      companion.rewardTrackId,
      companion.monsterId,
      branch,
      stage,
    ].join(':');
    const slot = chooseSlot(behaviour.path, key, placed, found.length);
    placed.push(slot);
    const route = routeFor(behaviour.path, key, stage);
    const face = visualFace(companion.monsterId, branch, stage);
    const flying = behaviour.lane === 'air';
    return Object.freeze({
      ...companion,
      stage,
      branch,
      path: behaviour.path,
      motion: behaviour.motion,
      lane: behaviour.lane,
      behaviourLabel: behaviour.description,
      x: slot.x,
      footY: slot.footY,
      size: finalSize(slot, companion, stage),
      zIndex: 20 + Math.round(slot.footY),
      face,
      reverseFace: face * -1,
      route,
      gaitDuration: GAIT_DURATION[behaviour.motion] ?? 1.6,
      gaitDelay: Number((-stableNumber(key, 'gait-delay', 0, 1.5)).toFixed(2)),
      airLift: flying
        ? Number((-stableNumber(key, 'air-lift', 18, companion.monsterId === 'glimmerbug' ? 31 : 26)).toFixed(1))
        : 0,
      visualOffsetY: visualOffsetY(behaviour.path, companion.monsterId, stage),
      shadowScale: Number((flying
        ? stableNumber(key, 'shadow-scale', 0.46, 0.64)
        : stableNumber(key, 'shadow-scale', 0.76, 0.98)).toFixed(3)),
      shadowOpacity: Number((flying
        ? stableNumber(key, 'shadow-opacity', 0.24, 0.38)
        : stableNumber(key, 'shadow-opacity', 0.48, 0.68)).toFixed(3)),
      emergeDelay: `${80 + index * 110}ms`,
    });
  });
}
