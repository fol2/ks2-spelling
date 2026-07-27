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
  celebrationEventKey,
  celebrationPalette,
  celebrationProgressMeterCopy,
  monsterCelebrationArtUrl,
} from './celebration-model.js';
import './celebrations.css';
import './celebration-hardening.css';

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
        <span>{celebrationProgressMeterCopy(event)}</span>
      </span>
    </span>
  );
}

/**
 * Summary-only celebration overlay. Milestones and ordinary direct-companion
 * progress share one bounded queue: tap to skip, or let the current card
 * complete automatically. Backgrounding or keyboard focus preserves the exact
 * remaining time so a reward cannot disappear while the learner is away or
 * actively reading it.
 */
export function CelebrationLayer({ events, haptics, onDone }) {
  const list = Array.isArray(events) ? events : [];
  const [index, setIndex] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);
  const [visible, setVisible] = useState(pageIsVisible);
  const [interactionPaused, setInteractionPaused] = useState(false);
  const dialogRef = useRef(null);
  const cardRef = useRef(null);
  const lastHapticKey = useRef('');
  const remainingMs = useRef(0);

  useEffect(() => {
    setIndex(0);
    setInteractionPaused(false);
    lastHapticKey.current = '';
    remainingMs.current = 0;
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
  const eventKey = celebrationEventKey(event, index);
  const duration = celebrationDurationMs(event);
  const copy = useMemo(() => celebrationCopy(event), [event]);
  const palette = useMemo(() => celebrationPalette(event), [event]);
  const finalEvolution = event?.kind === 'evolve' && event?.stage >= 4;

  const advance = useCallback(() => {
    if (!event) return;
    if (index + 1 >= list.length) {
      // Always close locally as well as notifying the parent. This keeps the
      // layer usable in isolated previews and prevents a missing callback from
      // leaving an undismissable modal over the Results screen.
      setIndex(list.length);
      onDone?.();
      return;
    }
    setIndex((current) => current + 1);
  }, [event, index, list.length, onDone]);

  useEffect(() => {
    if (!eventKey) return;
    remainingMs.current = duration;
    setInteractionPaused(false);
    dialogRef.current?.focus({ preventScroll: true });
  }, [duration, eventKey]);

  useEffect(() => {
    if (!event || !visible || lastHapticKey.current === eventKey) return;
    lastHapticKey.current = eventKey;
    haptics?.celebrationStart?.(event.kind, event.stage);
  }, [event, eventKey, haptics, visible]);

  useEffect(() => {
    if (!eventKey || !visible || interactionPaused) return undefined;
    const delay = Math.max(0, remainingMs.current);
    const startedAt = Date.now();
    let completed = false;
    const timer = setTimeout(() => {
      completed = true;
      remainingMs.current = 0;
      advance();
    }, delay);
    return () => {
      clearTimeout(timer);
      if (!completed) {
        const elapsed = Math.max(0, Date.now() - startedAt);
        remainingMs.current = Math.max(0, delay - elapsed);
      }
    };
  }, [advance, eventKey, interactionPaused, visible]);

  const handleDialogKeyDown = useCallback((keyboardEvent) => {
    if (keyboardEvent.key === 'Escape') {
      keyboardEvent.preventDefault();
      advance();
      return;
    }
    if (keyboardEvent.key === 'Tab') {
      // This modal has one action. Keep keyboard and switch focus inside it
      // rather than allowing the obscured Results controls to receive focus.
      keyboardEvent.preventDefault();
      cardRef.current?.focus({ preventScroll: true });
    }
  }, [advance]);

  if (!event || list.length === 0) return null;

  const artUrl = monsterCelebrationArtUrl(
    event.monsterId,
    event.branch,
    event.stage,
  );

  return (
    <section
      ref={dialogRef}
      className={`celebration-overlay celebration-${event.kind}`}
      data-final={finalEvolution ? 'true' : 'false'}
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      data-interaction-paused={interactionPaused ? 'true' : 'false'}
      role="dialog"
      aria-modal="true"
      aria-label="Companion reward"
      tabIndex={-1}
      onKeyDown={handleDialogKeyDown}
      style={{
        '--celebration-accent': palette.primary,
        '--celebration-secondary': palette.secondary,
        '--celebration-pale': palette.pale,
      }}
    >
      <div className="celebration-scroll">
        <button
          ref={cardRef}
          type="button"
          className="celebration-card"
          onClick={advance}
          onFocus={() => setInteractionPaused(true)}
          onBlur={() => setInteractionPaused(false)}
          aria-label={`Continue after ${copy.headline}`}
        >
          <span className="celebration-stage" aria-hidden="true">
            <CelebrationEffects
              finalEvolution={finalEvolution}
              reducedMotion={reducedMotion}
            />
            <span className="celebration-halo" />
            {artUrl && (
              <img
                className="celebration-art"
                src={artUrl}
                alt=""
                width={640}
                height={640}
                decoding="async"
              />
            )}
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
              <span>Tap or press to continue</span>
              {list.length > 1 && (
                <span className="celebration-position">
                  {index + 1} of {list.length}
                </span>
              )}
            </span>
          </span>
        </button>
      </div>

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
