import { useCallback, useEffect, useState } from 'react';

import {
  celebrationHeadline,
  monsterCelebrationArtUrl,
} from './celebration-model.js';

const AUTO_COMPLETE_MS = 2600;
const PARTICLE_COUNT = 10;

function prefersReducedMotion() {
  return typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function CelebrationEffects() {
  return (
    <div className="celebration-effects" aria-hidden="true">
      <span className="celebration-sparkle fx fx-shiny" />
      <div className="celebration-parts">
        {Array.from({ length: PARTICLE_COUNT }, (_, index) => (
          <span className="celebration-part" key={index} />
        ))}
      </div>
    </div>
  );
}

/**
 * Summary-only celebration overlay. Shows one event at a time; tap or
 * auto-complete (~2.6 s) advances. Reduced motion drops particles.
 */
export function CelebrationLayer({ events, haptics, onDone }) {
  const list = Array.isArray(events) ? events : [];
  const [index, setIndex] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);

  useEffect(() => {
    setIndex(0);
  }, [events]);

  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined;
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReducedMotion(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  const event = list[index] ?? null;

  const advance = useCallback(() => {
    if (!event) return;
    if (index + 1 >= list.length) {
      onDone?.();
      return;
    }
    setIndex((current) => current + 1);
  }, [event, index, list.length, onDone]);

  useEffect(() => {
    if (!event) return undefined;
    haptics?.celebrationStart();
    const timer = setTimeout(advance, AUTO_COMPLETE_MS);
    return () => clearTimeout(timer);
    // haptics is an injected fire-and-forget adapter; identity is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, index, advance]);

  if (!event || list.length === 0) return null;

  const headline = celebrationHeadline(event);
  const artUrl = monsterCelebrationArtUrl(
    event.monsterId,
    event.branch,
    event.stage,
  );

  return (
    <div className={`celebration-overlay celebration-${event.kind}`}>
      <button
        type="button"
        className="celebration-card"
        onClick={advance}
      >
        {!reducedMotion && <CelebrationEffects />}
        <figure className="celebration-figure" aria-hidden="true">
          <img
            className="celebration-art"
            src={artUrl}
            alt=""
            width={640}
            height={640}
            decoding="async"
          />
        </figure>
        <p className="celebration-headline">{headline}</p>
      </button>
      <p className="celebration-status" role="status" aria-live="polite">
        {headline}
      </p>
    </div>
  );
}
