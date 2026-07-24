import { useEffect, useRef, useState } from 'react';

import { stageArtUrl } from './monster-stage-model.js';

/**
 * The Monster Stage island. Presentation only: a bounded, aria-hidden Phaser
 * canvas that brings the static stage art to life, with the same still image as
 * a fallback for reduced motion, pre-boot, WebGL context loss and backgrounding.
 * The accessible text equivalent lives beside it on the Monster screen.
 *
 * Props reach the running scene through the game registry (no React re-render of
 * the canvas, no new Game on prop change); a stage increase calls playEvolution.
 */
function StageImage({ src }) {
  return (
    <img
      className="monster-stage-img"
      src={src}
      alt=""
      width={640}
      height={640}
      decoding="async"
    />
  );
}

export default function MonsterStage({
  monsterId = 'inklet',
  branch = 'b1',
  stage = 0,
  secureCount = 0,
  reducedMotion = false,
  lifecycle,
}) {
  const containerRef = useRef(null);
  const gameRef = useRef(null);
  const sceneRef = useRef(null);
  const prevStageRef = useRef(stage);
  const [contextLost, setContextLost] = useState(false);
  const [backgrounded, setBackgrounded] = useState(false);
  const [ready, setReady] = useState(false);

  const artUrl = stageArtUrl(monsterId, branch, stage);
  // Reduced motion or a lost WebGL context both fall back to the still frame.
  const live = !reducedMotion && !contextLost && !backgrounded;

  // Background/foreground: prefer an injected lifecycle, else page visibility.
  useEffect(() => {
    if (lifecycle && typeof lifecycle.subscribe === 'function') {
      const unsubscribe = lifecycle.subscribe((state) => setBackgrounded(!state?.isActive));
      return () => unsubscribe?.();
    }
    if (typeof document === 'undefined') return undefined;
    const onVisibility = () => setBackgrounded(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [lifecycle]);

  // One Phaser.Game per live mount. Recreated when the creature identity or the
  // live/background state changes; stage & progress updates flow via the registry.
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
      const { createMonsterScene } = await import('./monster-scene.js');
      if (cancelled) return;

      const scene = createMonsterScene(Phaser, {
        monsterId,
        branch,
        stage,
        secureCount,
        onReady: () => {
          if (!cancelled) setReady(true);
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
      sceneRef.current = scene;
      prevStageRef.current = stage;

      // Context loss flips this mount to the permanent static frame. Listen for
      // the browser DOM event and Phaser's own signal; the canvas and renderer
      // only exist once the game has booted, so attach those on 'ready'.
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
      sceneRef.current = null;
    };
    // Initial stage/secureCount are captured at creation; later changes are
    // pushed through the registry by the effect below, not by recreating.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, monsterId, branch]);

  // Push prop changes into the running scene without a new Game.
  useEffect(() => {
    const game = gameRef.current;
    const scene = sceneRef.current;
    if (!game || !scene) return;
    game.registry?.set('secureCount', secureCount);
    const previous = prevStageRef.current;
    if (stage > previous) scene.playEvolution?.(previous, stage);
    prevStageRef.current = stage;
    game.registry?.set('stage', stage);
  }, [stage, secureCount]);

  if (!live) {
    return (
      <div className="monster-stage is-static" aria-hidden="true">
        <StageImage src={artUrl} />
      </div>
    );
  }

  return (
    <div className="monster-stage" ref={containerRef} aria-hidden="true">
      {/* Never an empty box: the still frame shows until the canvas paints. */}
      {!ready && <StageImage src={artUrl} />}
    </div>
  );
}
