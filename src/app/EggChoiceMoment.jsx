import { useEffect, useRef } from 'react';

import { eggChoiceCopy } from './egg-choice-moment.js';
import {
  eggChoiceMomentKeyDown,
  eggChoiceMomentMountFocus,
  eggChoiceMomentRestoreFocus,
} from './egg-choice-moment-runtime.js';
import { monsterArt } from './mastery-art.js';

/**
 * Calm found celebration: the child taps one painted egg. The tap commits.
 */
export function EggChoiceMoment({ monster, onChoose }) {
  const firstEgg = useRef(null);
  const secondEgg = useRef(null);
  const copy = eggChoiceCopy();
  const monsterId = monster?.monsterId;
  const b1Art = monsterArt(monsterId, 0, 'b1');
  const b2Art = monsterArt(monsterId, 0, 'b2');

  useEffect(() => {
    const previousFocus = document.activeElement;
    const handleKeyDown = (event) => {
      const result = eggChoiceMomentKeyDown(event, {
        firstEl: firstEgg.current,
        secondEl: secondEgg.current,
      });
      result?.focus?.focus?.({ preventScroll: true });
    };
    eggChoiceMomentMountFocus(firstEgg.current);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      eggChoiceMomentRestoreFocus(previousFocus);
    };
  }, []);

  return (
    <section
      className="product-app egg-choice-moment"
      data-egg-choice-moment="true"
      role="dialog"
      aria-modal="true"
      aria-labelledby="egg-choice-title"
      aria-describedby="egg-choice-body"
    >
      <div>
        <h1 id="egg-choice-title">{copy.headline}</h1>
        <p id="egg-choice-body">{copy.body}</p>
        <div className="egg-choice-eggs">
          <button
            ref={firstEgg}
            type="button"
            className="egg-choice-egg press"
            data-branch="b1"
            onClick={() => onChoose('b1')}
          >
            <img src={b1Art ?? undefined} alt="" />
            <span className="visually-hidden">This egg</span>
          </button>
          <button
            ref={secondEgg}
            type="button"
            className="egg-choice-egg press"
            data-branch="b2"
            onClick={() => onChoose('b2')}
          >
            <img src={b2Art ?? undefined} alt="" />
            <span className="visually-hidden">This egg</span>
          </button>
        </div>
      </div>
    </section>
  );
}
