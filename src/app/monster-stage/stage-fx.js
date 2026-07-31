/**
 * Shared painterly FX primitives for the Monster Stage and Celebration Stage.
 * Keep these tween-only and self-cleaning so either scene can tear down cleanly.
 */

/**
 * Soft rising mote burst. `rng` must be a [0, 1) function so cadence stays
 * deterministic when the caller seeds an LCG.
 */
export function spawnBurst(scene, {
  x,
  y,
  count,
  colours,
  rng,
  depth = 4,
  driftY = 40,
  durationBase = 600,
  durationSpread = 300,
}) {
  const pick = typeof rng === 'function' ? rng : Math.random;
  const palette = Array.isArray(colours) && colours.length > 0
    ? colours
    : [0xffffff];

  for (let index = 0; index < count; index += 1) {
    const circle = scene.add
      .circle(
        x + (pick() * 40 - 20),
        y + (pick() * 20 - 10),
        3 + pick() * 3,
        palette[(pick() * palette.length) | 0],
        0.9,
      )
      .setDepth(depth);
    scene.tweens.add({
      targets: circle,
      y: circle.y - driftY - pick() * driftY,
      alpha: 0,
      scale: 0.4,
      duration: durationBase + pick() * durationSpread,
      ease: 'Sine.Out',
      onComplete: () => circle.destroy(),
    });
  }
}

/**
 * Additive glow swell that yoyos once and destroys itself. `Phaser` is passed
 * in so callers stay free of a static phaser import.
 */
export function glowPulse(scene, Phaser, {
  x,
  y,
  radius,
  colour = 0xe2a62b,
  depth = 1,
  peakAlpha = 0.5,
  scaleTo = 1.4,
  duration = 500,
}) {
  const glow = scene.add
    .circle(x, y, radius, colour, 0)
    .setDepth(depth)
    .setBlendMode(Phaser.BlendModes.ADD);
  scene.tweens.add({
    targets: glow,
    alpha: peakAlpha,
    scale: scaleTo,
    duration,
    yoyo: true,
    ease: 'Sine.InOut',
    onComplete: () => glow.destroy(),
  });
  return glow;
}

/**
 * Expanding stroke ring — used for evolution shockwaves and stage-4 flourish.
 */
export function shockwaveRing(scene, {
  x,
  y,
  colour = 0xffffff,
  startRadius = 12,
  endScale = 5.5,
  duration = 700,
  depth = 2,
  lineWidth = 3,
  startAlpha = 0.65,
  delay = 0,
}) {
  const ring = scene.add
    .circle(x, y, startRadius, colour, 0)
    .setStrokeStyle(lineWidth, colour, startAlpha)
    .setDepth(depth)
    .setAlpha(startAlpha);
  scene.tweens.add({
    targets: ring,
    scale: endScale,
    alpha: 0,
    duration,
    delay,
    ease: 'Sine.Out',
    onComplete: () => ring.destroy(),
  });
  return ring;
}
