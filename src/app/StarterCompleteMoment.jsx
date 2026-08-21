import { useEffect, useRef } from 'react';

import { starterCompleteMomentCopy } from './starter-complete-moment.js';
import {
  starterCompleteMomentKeyDown,
  starterCompleteMomentMountFocus,
  starterCompleteMomentRestoreFocus,
} from './starter-complete-moment-runtime.js';

/**
 * Calm one-time child-facing signpost after a Starter year band is secured.
 * Routes to the Parent gate. Copy is factual; it must never name a price or
 * start a store transaction.
 */
export function StarterCompleteMoment({
  remainingWordCount,
  onContinue,
  onAskGrownUp,
}) {
  const continueButton = useRef(null);
  const grownUpButton = useRef(null);
  const copy = starterCompleteMomentCopy(remainingWordCount);

  useEffect(() => {
    const previousFocus = document.activeElement;
    const handleKeyDown = (event) => {
      const result = starterCompleteMomentKeyDown(event, {
        continueEl: continueButton.current,
        grownUpEl: grownUpButton.current,
      });
      if (result?.action === 'continue') {
        onContinue();
        return;
      }
      result?.focus?.focus?.({ preventScroll: true });
    };
    starterCompleteMomentMountFocus(continueButton.current);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      starterCompleteMomentRestoreFocus(previousFocus);
    };
  }, [onContinue]);

  return (
    <section
      className="starter-complete-moment"
      data-starter-complete-moment="true"
      role="dialog"
      aria-modal="true"
      aria-labelledby="starter-complete-title"
      aria-describedby="starter-complete-body"
    >
      <div>
        <p className="product-kicker">{copy.eyebrow}</p>
        <h2 id="starter-complete-title">{copy.headline}</h2>
        <p id="starter-complete-body">{copy.body}</p>
        <div>
          <button
            ref={continueButton}
            type="button"
            className="button-quiet press-soft press"
            onClick={onContinue}
          >
            {copy.continueAction}
          </button>
          <button
            ref={grownUpButton}
            type="button"
            className="button-primary press"
            onClick={onAskGrownUp}
          >
            {copy.grownUpAction}
          </button>
        </div>
      </div>
    </section>
  );
}
