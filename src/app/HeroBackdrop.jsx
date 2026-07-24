import { useEffect, useRef, useState } from 'react';
import {
  HERO_TRANSITION_MS,
  heroBgStyle,
  heroPanDelayStyle,
} from './backdrop-model.js';

function prefersReducedMotion() {
  return (
    typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/* Layered hero backdrop with cross-fade and slow horizontal pan.
 *
 * On URL change the new layer fades in over HERO_TRANSITION_MS, then prior
 * layers prune. Under prefers-reduced-motion the swap is instant and static.
 */
export function HeroBackdrop({ url, previousUrl = '' }) {
  const handoffUrl = previousUrl && previousUrl !== url ? previousUrl : '';
  const layerId = useRef(handoffUrl ? 1 : 0);
  const currentUrl = useRef(url || '');
  const initialTransitionId = useRef(handoffUrl ? 1 : null);
  const [layers, setLayers] = useState(() => {
    if (!url) return [];
    const panStyle = prefersReducedMotion() ? {} : heroPanDelayStyle();
    if (prefersReducedMotion() || !handoffUrl) {
      return [{ id: 0, url, phase: 'active', panStyle }];
    }
    return [
      { id: 0, url: handoffUrl, phase: 'exiting', panStyle },
      { id: 1, url, phase: 'entering', panStyle },
    ];
  });

  useEffect(() => {
    const nextId = initialTransitionId.current;
    if (nextId == null || !url || prefersReducedMotion()) return undefined;
    const transitionUrl = url;
    const timer = setTimeout(() => {
      setLayers((current) => {
        if (currentUrl.current !== transitionUrl) return current;
        return current
          .filter((layer) => layer.id === nextId)
          .map((layer) => ({ ...layer, phase: 'active' }));
      });
    }, HERO_TRANSITION_MS);
    return () => clearTimeout(timer);
    // Mount-once handoff settle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!url) {
      currentUrl.current = '';
      setLayers([]);
      return undefined;
    }

    if (currentUrl.current === url) return undefined;
    currentUrl.current = url;
    layerId.current += 1;
    const nextId = layerId.current;
    const reduced = prefersReducedMotion();
    const panStyle = reduced ? {} : heroPanDelayStyle();

    if (reduced) {
      setLayers([{ id: nextId, url, phase: 'active', panStyle }]);
      return undefined;
    }

    setLayers((current) => [
      ...current.slice(-2).map((layer) => ({ ...layer, phase: 'exiting' })),
      { id: nextId, url, phase: 'entering', panStyle },
    ]);

    const timer = setTimeout(() => {
      setLayers((current) => current
        .filter((layer) => layer.id === nextId)
        .map((layer) => ({ ...layer, phase: 'active' })));
    }, HERO_TRANSITION_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [url]);

  if (!layers.length) return null;

  return (
    <div className="hero-backdrop" aria-hidden="true">
      {layers.map((layer) => (
        <div
          className={`hero-art pan hero-layer is-${layer.phase}`}
          data-hero-layer="true"
          style={{ ...heroBgStyle(layer.url), ...layer.panStyle }}
          key={layer.id}
        />
      ))}
    </div>
  );
}
