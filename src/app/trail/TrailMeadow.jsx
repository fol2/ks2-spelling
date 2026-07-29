import { useEffect, useMemo, useState } from 'react';

import { buildTrailMeadowCompanions } from './trail-meadow-model.js';
import './trail-meadow.css';
import './trail-meadow-hardening.css';

const AMBIENT_MOTES = Object.freeze([
  Object.freeze({ left: '14%', top: '26%', delay: '-2.4s', duration: '8.6s' }),
  Object.freeze({ left: '31%', top: '18%', delay: '-5.1s', duration: '10.2s' }),
  Object.freeze({ left: '54%', top: '30%', delay: '-1.2s', duration: '9.4s' }),
  Object.freeze({ left: '72%', top: '20%', delay: '-6.8s', duration: '11.3s' }),
  Object.freeze({ left: '88%', top: '37%', delay: '-3.7s', duration: '8.9s' }),
]);

function TrailCompanion({ companion, poked, onPoke }) {
  const detailsId = `trail-companion-details-${companion.rewardTrackId}`;
  const style = {
    '--trail-x': `${companion.x}%`,
    '--trail-foot-y': `${companion.footY}%`,
    '--trail-size': `${companion.size}%`,
    '--trail-z': companion.zIndex,
    '--trail-route-duration': `${companion.route.duration}s`,
    '--trail-route-delay': `${companion.route.delay}s`,
    '--trail-forward-x': `${companion.route.forward}px`,
    '--trail-back-x': `${companion.route.back}px`,
    '--trail-forward-y': `${companion.route.forwardY}px`,
    '--trail-back-y': `${companion.route.backY}px`,
    '--trail-gait-duration': `${companion.gaitDuration}s`,
    '--trail-gait-delay': `${companion.gaitDelay}s`,
    '--trail-face': companion.face,
    '--trail-face-back': companion.reverseFace,
    '--trail-air-lift': `${companion.airLift}%`,
    '--trail-visual-y': `${companion.visualOffsetY}%`,
    '--trail-shadow-scale': companion.shadowScale,
    '--trail-shadow-scale-far': Number((companion.shadowScale * 0.82).toFixed(3)),
    '--trail-shadow-opacity': companion.shadowOpacity,
    '--trail-shadow-opacity-far': Number((companion.shadowOpacity * 0.66).toFixed(3)),
    '--trail-emerge-delay': companion.emergeDelay,
  };
  const label = [
    companion.displayName ?? companion.name,
    companion.title,
    companion.stageLabel,
    companion.behaviourLabel,
  ].filter(Boolean).join(', ');

  return (
    <button
      type="button"
      className="trail-companion press-soft press"
      data-path={companion.path}
      data-motion={companion.motion}
      data-lane={companion.lane}
      data-stage={companion.stage}
      data-poked={poked ? 'true' : 'false'}
      aria-label={label}
      aria-expanded={poked}
      aria-controls={poked ? detailsId : undefined}
      style={style}
      onClick={onPoke}
    >
      <span className="trail-companion-route" aria-hidden="true">
        <span className="trail-companion-shadow" />
        {companion.path === 'egg' && <span className="trail-companion-nest" />}
        <span className="trail-companion-facing">
          <span className="trail-companion-gait">
            <img
              className="trail-companion-art"
              src={companion.art}
              alt=""
              width={640}
              height={640}
              decoding="async"
            />
          </span>
        </span>
      </span>

      {poked && (
        <span
          id={detailsId}
          className="trail-companion-tag"
          role="status"
          aria-atomic="true"
        >
          <strong>{companion.title}</strong>
          <small>{companion.stageLabel}</small>
        </span>
      )}
    </button>
  );
}

function habitatLabel(population) {
  if (population === 0) return 'The trail is waiting for its first companion';
  if (population === 1) return 'One companion lives on this trail';
  return `${population} companions live on this trail`;
}

export function TrailMeadow({ companions = [], seed = 'trail-meadow' }) {
  const [poked, setPoked] = useState(null);
  const living = useMemo(
    () => buildTrailMeadowCompanions(companions, { seed }),
    [companions, seed],
  );

  useEffect(() => {
    if (!poked) return undefined;
    const timer = setTimeout(() => setPoked(null), 2400);
    return () => clearTimeout(timer);
  }, [poked]);

  return (
    <section
      className="trail-meadow"
      data-population={Math.min(4, living.length)}
      aria-label={habitatLabel(living.length)}
    >
      <span className="trail-meadow-ground" aria-hidden="true" />
      <span className="trail-meadow-path" aria-hidden="true" />
      <span className="trail-meadow-foreground" aria-hidden="true" />
      <span className="trail-meadow-grass grass-left" aria-hidden="true" />
      <span className="trail-meadow-grass grass-right" aria-hidden="true" />
      <span className="trail-meadow-grass grass-near" aria-hidden="true" />

      {AMBIENT_MOTES.map((mote, index) => (
        <span
          // eslint-disable-next-line react/no-array-index-key
          key={index}
          className="trail-meadow-mote"
          aria-hidden="true"
          style={{
            '--mote-left': mote.left,
            '--mote-top': mote.top,
            '--mote-delay': mote.delay,
            '--mote-duration': mote.duration,
          }}
        />
      ))}

      {living.length === 0 && (
        <div className="trail-meadow-empty" role="status">
          <span className="trail-empty-nest" aria-hidden="true" />
          <strong>Your trail is quiet</strong>
          <span>Secure a spelling to wake your first companion.</span>
        </div>
      )}

      {living.map((companion) => (
        <TrailCompanion
          key={companion.rewardTrackId}
          companion={companion}
          poked={poked === companion.rewardTrackId}
          onPoke={() => setPoked((current) => (
            current === companion.rewardTrackId ? null : companion.rewardTrackId
          ))}
        />
      ))}
    </section>
  );
}
