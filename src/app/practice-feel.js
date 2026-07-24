/** Auto-advance delay for the practice screen (ported delay rule only). */

export function autoAdvanceDelayMs(mode) {
  return mode === 'test' ? 320 : 500;
}
