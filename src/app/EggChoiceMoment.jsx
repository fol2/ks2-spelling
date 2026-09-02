import { useEffect, useRef, useState } from 'react';

import { eggChoiceCopy, eggChoiceEggIsDisabled, beginEggChoicePick, endEggChoicePick, eggChoiceSaveFailedVisible } from './egg-choice-moment.js';
import {
  eggChoiceMomentKeyDown,
  eggChoiceMomentMountFocus,
  eggChoiceMomentRestoreFocus,
} from './egg-choice-moment-runtime.js';
import { monsterArt } from './mastery-art.js';

/**
 * Calm found celebration: the child taps one painted egg. The tap commits.
 * A failed save keeps the eggs for retry and offers Close so the overlay
 * cannot trap the child.
 */
export function EggChoiceMoment({ monster, onChoose, onDismiss }) {
  const dialog = useRef(null);
  const firstEgg = useRef(null);
  const secondEgg = useRef(null);
  const closeBtn = useRef(null);
  const [failedTrackId, setFailedTrackId] = useState(null);
  const [inFlightBranch, setInFlightBranch] = useState(null);
  const inFlightRef = useRef(null);
  const copy = eggChoiceCopy();
  const monsterId = monster?.monsterId;
  const trackId = monster?.rewardTrackId ?? null;
  const saveFailed = eggChoiceSaveFailedVisible(failedTrackId, trackId);
  const b1Art = monsterArt(monsterId, 0, 'b1');
  const b2Art = monsterArt(monsterId, 0, 'b2');
  const firstDisabled = eggChoiceEggIsDisabled(inFlightBranch, 'b1');
  const secondDisabled = eggChoiceEggIsDisabled(inFlightBranch, 'b2');

  useEffect(() => {
    const previousFocus = document.activeElement;
    const background = document.querySelector('main.product-app');
    background?.setAttribute('inert', '');
    background?.setAttribute('aria-hidden', 'true');
    const handleKeyDown = (event) => {
      const result = eggChoiceMomentKeyDown(event, {
        firstEl: firstEgg.current,
        secondEl: secondEgg.current,
        closeEl: saveFailed ? closeBtn.current : null,
        dialogEl: dialog.current,
        active: document.activeElement,
      });
      if (result?.action === 'dismiss') {
        onDismiss?.();
        return;
      }
      result?.focus?.focus?.({ preventScroll: true });
    };
    eggChoiceMomentMountFocus(firstEgg.current);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      background?.removeAttribute('inert');
      background?.removeAttribute('aria-hidden');
      eggChoiceMomentRestoreFocus(previousFocus);
    };
  }, [onDismiss, saveFailed]);

  const pick = (branch) => {
    if (!beginEggChoicePick(inFlightRef, branch)) return;
    setInFlightBranch(branch);
    const settle = (failed) => {
      endEggChoicePick(inFlightRef);
      setInFlightBranch(null);
      setFailedTrackId(failed ? trackId : null);
    };
    try {
      const result = onChoose(branch);
      if (result && typeof result.then === 'function') {
        void result.then(
          () => settle(false),
          () => settle(true),
        );
        return;
      }
      settle(false);
    } catch {
      settle(true);
    }
  };

  return (
    <section
      ref={dialog}
      tabIndex={-1}
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
            disabled={firstDisabled}
            aria-busy={inFlightBranch === 'b1' ? 'true' : undefined}
            onClick={() => pick('b1')}
          >
            <img src={b1Art ?? undefined} alt="" />
            <span className="visually-hidden">{copy.firstEgg}</span>
          </button>
          <button
            ref={secondEgg}
            type="button"
            className="egg-choice-egg press"
            data-branch="b2"
            disabled={secondDisabled}
            aria-busy={inFlightBranch === 'b2' ? 'true' : undefined}
            onClick={() => pick('b2')}
          >
            <img src={b2Art ?? undefined} alt="" />
            <span className="visually-hidden">{copy.secondEgg}</span>
          </button>
        </div>
        {saveFailed ? (
          <>
            <p role="alert" data-egg-choice-save-failed="true">{copy.saveFailed}</p>
            {typeof onDismiss === 'function' ? (
              <button
                ref={closeBtn}
                type="button"
                className="egg-choice-dismiss press"
                onClick={onDismiss}
              >
                {copy.close}
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
