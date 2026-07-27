import { clampCompanionStage } from '../companion-stage-contract.js';

/**
 * Pure, dependency-free decisions for the Monster Stage island. These get
 * unit-tested against the on-disk art inventory, so keep them small and exact.
 */

/**
 * Web path to a stage's whole-creature webp. Unknown branch falls back to b1;
 * stage is clamped into the authored 0..4 range.
 */
export function stageArtUrl(monsterId, branch, stage) {
  const resolvedBranch = branch === 'b2' ? 'b2' : 'b1';
  const resolvedStage = clampCompanionStage(stage);
  return `/mastery-art/monsters/${monsterId}/${resolvedBranch}/${monsterId}-${resolvedBranch}-${resolvedStage}.640.webp`;
}

/**
 * Whether a stage change should play the evolution moment. Only an increase
 * evolves; from/to are clamped to the authored range so callers can drive art.
 */
export function evolutionDecision(previousStage, nextStage) {
  const from = clampCompanionStage(previousStage);
  const to = clampCompanionStage(nextStage);
  return to > from ? { kind: 'evolve', from, to } : { kind: 'none', from, to };
}

/**
 * Whether to show the static frame instead of the live canvas. Context loss or
 * reduced motion both fall back to the still image.
 */
export function contextFallbackDecision({ contextLost, reducedMotion } = {}) {
  return contextLost || reducedMotion ? 'static' : 'live';
}
