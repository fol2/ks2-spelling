export const HIGHEST_COMPANION_STAGE = 4;

export function clampCompanionStage(stage) {
  const value = Number.isFinite(stage) ? Math.trunc(stage) : 0;
  return Math.max(0, Math.min(HIGHEST_COMPANION_STAGE, value));
}
