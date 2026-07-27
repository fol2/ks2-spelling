import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  celebrationCopy,
  celebrationDurationMs,
  celebrationPalette,
  monsterCelebrationArtUrl,
} from './celebration-model.js';
import './celebrations.css';

const PARTICLE_COUNT = 12;

function prefersReducedMotion() {
  return typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function pageIsVisible() {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

function CelebrationEffects({ finalEvolution, reducedMotion }) {
  if (reducedMotion) return null;
  return (
    <span className="celebration-effects" aria-hidden="true">
      <span className="fx fx-shiny" />
      {finalEvolution && <span className="fx fx-mega-aura" />}
      <span className="celebration-parts">
        {Array.from({ length: PARTICLE_COUNT }, (_, index) => (
          <span
            className="celebration-part"
            key={index}
            style={{
              '--particle-angle': `${index * (360 / PARTICLE_COUNT)}deg`,
              '--particle-distance': `${-(72 + (index % 4) * 18)}px`,
              '--particle-delay': `${index * 18}ms`,
            }}
          />
        ))}
      </span>
    </span>
  );
}

function ProgressMeter({ event }) {
  if (
    event?.kind !== 'progress'
    || !Number.isFinite(event.target)
    || event.target <= 0
  ) {
    return null;
  }
  const from = Math.max(0, Math.min(100, event.percentBefore ?? 0)) / 100;
  const to = Math.max(0, Math.min(100, event.percentAfter ?? 0)) / 100;
  return (
    <span
      className="celebration-meter"
      aria-hidden="true"
      style={{
        '--progress-from': from,
        '--progress-to': to,
      }}
    >
      <span className="celebration-meter-track">
        <span className="celebration-meter-fill" />
      </span>
      <span className="celebration-meter-copy">
        <strong>+{event.secureGain}</strong>
        <span>{event.secureCount} / {event.target} secure</span>
      </span>
    </span>
  );
}

/**
 * Summary-only celebration overlay. Milestones and ordinary direct-companion
 * progress share one bounded queue: tap to skip, or let the current card
 * complete automatically. Backgrounding pauses the timer so a reward cannot
 * disappear while the learner is outside the app.
 */
export function CelebrationLayer({ events, haptics, onDone }) {
  const list = Array.isArray(events) ? events : [];
  const [index, setIndex] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);
  const [visible, setVisible] = useState(pageIsVisible);
  const lastHapticKey = useRef('');

  useEffect(() => {
    setIndex(0);
    lastHapticKey.current = '';
  }, [events]);

  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined;
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReducedMotion(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const sync = () => setVisible(pageIsVisible());
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);

  const event = list[index] ?? null;
  const eventKey = event
    ? `${event.rewardTrackId}:${event.kind}:${event.stage}:${index}`
    : '';
  const copy = useMemo(() => celebrationCopy(event), [event]);
  const palette = useMemo(() => celebrationPalette(event), [event]);
  const finalEvolution = event?.kind === 'evolve' && event?.stage >= 4;

  const advance = useCallback(() => {
    if (!event) return;
    if (index + 1 >= list.length) {
      onDone?.();
      return;
    }
    setIndex((current) => current + 1);
  }, [event, index, list.length, onDone]);

  useEffect(() => {
    if (!event || !visible || lastHapticKey.current === eventKey) return;
    lastHapticKey.current = eventKey;
    haptics?.celebrationStart(event.kind, event.stage);
  }, [event, eventKey, haptics, visible]);

  useEffect(() => {
    if (!event || !visible) return undefined;
    const timer = setTimeout(advance, celebrationDurationMs(event));
    return () => clearTimeout(timer);
  }, [advance, event, visible]);

  if (!event || list.length === 0) return null;

  const artUrl = monsterCelebrationArtUrl(
    event.monsterId,
    event.branch,
    event.stage,
  );

  return (
    <section
      className={`celebration-overlay celebration-${event.kind}`}
      data-final={finalEvolution ? 'true' : 'false'}
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      role="dialog"
      aria-modal="true"
      aria-labelledby="celebration-title"
      aria-describedby="celebration-description"
      style={{
        '--celebration-accent': palette.primary,
        '--celebration-secondary': palette.secondary,
        '--celebration-pale': palette.pale,
      }}
    >
      <button
        type="button"
        className="celebration-card"
        onClick={advance}
        aria-label={`${copy.announcement} Tap to continue.`}
      >
        <span className="celebration-stage" aria-hidden="true">
          <CelebrationEffects
            finalEvolution={finalEvolution}
            reducedMotion={reducedMotion}
          />
          <span className="celebration-halo" />
          <img
            className="celebration-art"
            src={artUrl}
            alt=""
            width={640}
            height={640}
            decoding="async"
          />
        </span>

        <span className="celebration-copy">
          <span className="celebration-eyebrow">{copy.eyebrow}</span>
          <span
            id="celebration-title"
            className="celebration-headline"
            role="heading"
            aria-level="2"
          >
            {copy.headline}
          </span>
          <span className="celebration-stage-label">{copy.stageLabel}</span>
          <span id="celebration-description" className="celebration-body">
            {copy.body}
          </span>
          <ProgressMeter event={event} />
          <span className="celebration-action">
            <span>Tap to continue</span>
            {list.length > 1 && (
              <span className="celebration-position">
                {index + 1} of {list.length}
              </span>
            )}
          </span>
        </span>
      </button>

      <p
        className="celebration-status visually-hidden"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {copy.announcement}
      </p>
    </section>
  );
}
