import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { trailMeadowCompanions } from '../codex-model.js';
import { TrailMeadow } from './TrailMeadow.jsx';
import './trail-meadow-portal.css';

const TRAIL_TARGET = '.trail-scene .meadow';

function currentTarget() {
  return globalThis.document?.querySelector?.(TRAIL_TARGET) ?? null;
}

export function TrailMeadowPortal({ services }) {
  const [profileState, setProfileState] = useState(() =>
    services.controller.getState(),
  );
  const [learningState, setLearningState] = useState(() =>
    services.learning.getState(),
  );
  const [target, setTarget] = useState(null);

  useEffect(() => {
    const profileSubscription = services.controller.subscribe(setProfileState);
    const learningSubscription = services.learning.subscribe(setLearningState);
    return () => {
      profileSubscription.remove();
      learningSubscription.remove();
    };
  }, [services]);

  useEffect(() => {
    if (learningState.screen !== 'home') {
      setTarget(null);
      return undefined;
    }

    const locate = () => {
      const next = currentTarget();
      setTarget((current) => (current === next ? current : next));
    };
    locate();

    const Observer = globalThis.MutationObserver;
    const body = globalThis.document?.body;
    if (typeof Observer !== 'function' || !body) return undefined;
    const observer = new Observer(locate);
    observer.observe(body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [learningState.screen]);

  useEffect(() => {
    if (!target) return undefined;
    target.dataset.integratedTrail = 'true';
    return () => {
      delete target.dataset.integratedTrail;
    };
  }, [target]);

  const selectedProfile = profileState.profiles.find(
    ({ learnerId }) => learnerId === learningState.learnerId,
  );
  const companions = useMemo(
    () => trailMeadowCompanions(learningState.monsters),
    [learningState.monsters],
  );

  if (
    learningState.screen !== 'home'
    || !selectedProfile
    || !target
  ) {
    return null;
  }

  return createPortal(
    <TrailMeadow
      companions={companions}
      seed={`${learningState.learnerId}:${selectedProfile.yearGroup}`}
    />,
    target,
  );
}
