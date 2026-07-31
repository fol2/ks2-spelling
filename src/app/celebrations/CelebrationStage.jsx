import { useEffect, useRef, useState } from 'react';

import {
  celebrationStageDecision,
  monsterCelebrationArtUrl,
} from './celebration-model.js';

/**
 * Celebration Stage island: a transparent, aria-hidden Phaser canvas over the
 * celebration card art. Presentation garnish only — taps fall through to the
 * DOM card. Mirrors MonsterStage: one Game per event key, destroy on
 * background/unmount, permanent static fallback after context loss.
 */
export default function CelebrationStage({
  monsterId = 'inklet',
  branch = 'b1',
  stage = 0,
  kind = 'caught',
  accent = '#3e6fa8',
  secondary = '#9fc1e8',
  eventKey = '',
  durationMs = 3000,
  reducedMotion = false,
  visible = true,
  onReady,
}) {
  const containerRef = useRef(null);
  const gameRef = useRef(null);
  const [contextLost, setContextLost] = useState(false);
  const [ready, setReady] = useState(false);

  const artUrl = monsterCelebrationArtUrl(monsterId, branch, stage);
  const backgrounded = !visible;
  const mode = celebrationStageDecision({
    kind,
    reducedMotion,
    contextLost,
    backgrounded,
  });
  const live = mode === 'live';

  useEffect(() => {
    if (!live) return undefined;
    const container = containerRef.current;
    if (!container) return undefined;

    let cancelled = false;
    let game = null;
    let canvas = null;
    let onLost = null;
    setReady(false);

    (async () => {
      const module = await import('phaser');
      const Phaser = module.default ?? module;
      if (cancelled) return;
      const { createCelebrationScene } = await import('./celebration-scene.js');
      if (cancelled) return;

      const scene = createCelebrationScene(Phaser, {
        monsterId,
        branch,
        stage,
        kind,
        accent,
        secondary,
        eventKey,
        durationMs,
        onReady: () => {
          if (!cancelled) {
            setReady(true);
            onReady?.();
          }
        },
      });

      game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: container,
        transparent: true,
        resolution: Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2),
        scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' },
        scene,
      });
      gameRef.current = game;

      onLost = (event) => {
        event?.preventDefault?.();
        if (!cancelled) setContextLost(true);
      };
      game.events.on('contextlost', onLost);
      game.events.once('ready', () => {
        if (cancelled) return;
        canvas = game.canvas;
        canvas?.addEventListener('webglcontextlost', onLost, false);
        game.renderer?.on?.('contextlost', onLost);
      });
    })();

    return () => {
      cancelled = true;
      canvas?.removeEventListener('webglcontextlost', onLost, false);
      if (game) game.destroy(true);
      gameRef.current = null;
    };
  }, [
    live,
    monsterId,
    branch,
    stage,
    kind,
    accent,
    secondary,
    eventKey,
    durationMs,
    onReady,
  ]);

  // Tear down when the decision flips to static (background / reduced motion /
  // context loss) even if the effect deps have not yet re-run a fresh boot.
  useEffect(() => {
    if (live) return undefined;
    const game = gameRef.current;
    if (game) {
      game.destroy(true);
      gameRef.current = null;
    }
    setReady(false);
    return undefined;
  }, [live]);

  if (!live || !artUrl) return null;

  return (
    <div
      className="celebration-canvas"
      ref={containerRef}
      aria-hidden="true"
      data-ready={ready ? 'true' : 'false'}
      style={{
        pointerEvents: 'none',
        position: 'absolute',
        inset: 0,
        zIndex: 3,
        width: '100%',
        height: '100%',
      }}
    />
  );
}
