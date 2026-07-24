/**
 * Pure, dependency-free decisions for the Monster Stage island. These get
 * unit-tested against the on-disk art inventory, so keep them small and exact.
 */

const STAGE_MIN = 0;
const STAGE_MAX = 4;

function clampStage(stage) {
  const value = Number.isFinite(stage) ? Math.trunc(stage) : 0;
  return Math.min(STAGE_MAX, Math.max(STAGE_MIN, value));
}

/**
 * Web path to a stage's whole-creature webp. Unknown branch falls back to b1;
 * stage is clamped into the authored 0..4 range.
 */
export function stageArtUrl(monsterId, branch, stage) {
  const resolvedBranch = branch === 'b2' ? 'b2' : 'b1';
  const resolvedStage = clampStage(stage);
  return `/mastery-art/monsters/${monsterId}/${resolvedBranch}/${monsterId}-${resolvedBranch}-${resolvedStage}.640.webp`;
}

/**
 * Whether a stage change should play the evolution moment. Only an increase
 * evolves; from/to are clamped to the authored range so callers can drive art.
 */
export function evolutionDecision(previousStage, nextStage) {
  const from = clampStage(previousStage);
  const to = clampStage(nextStage);
  return to > from ? { kind: 'evolve', from, to } : { kind: 'none', from, to };
}

/**
 * Whether to show the static frame instead of the live canvas. Context loss or
 * reduced motion both fall back to the still image.
 */
export function contextFallbackDecision({ contextLost, reducedMotion } = {}) {
  return contextLost || reducedMotion ? 'static' : 'live';
}
