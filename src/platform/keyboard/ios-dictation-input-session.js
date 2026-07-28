const SETUP_START_SELECTOR = '.setup-tray > .button-primary';
const ROUND_INPUT_SELECTOR = '#product-spelling-input';
const ROUND_ACTION_SELECTOR = '.round-card button';
const END_ROUND_SELECTOR = '.round-foot button';
const KEEP_ROUND_SELECTOR = '.exit-confirmation .button-quiet';
const LEAVE_ROUND_SELECTOR = '.exit-confirmation .button-danger';
const EXIT_DIALOG_SELECTOR = '.exit-confirmation';
const SESSION_INPUT_ID = 'ios-dictation-input-session';
const ARM_TIMEOUT_MS = 12_000;

const noOp = () => undefined;

function elementFromTarget(target) {
  if (target?.nodeType === 1) return target;
  return target?.parentElement ?? null;
}

export function closestMatching(target, selector) {
  return elementFromTarget(target)?.closest?.(selector) ?? null;
}

export function isUsableControl(control) {
  return Boolean(
    control
      && control.disabled !== true
      && control.getAttribute?.('aria-disabled') !== 'true',
  );
}

export function placementForRect(rect) {
  const left = Number.isFinite(rect?.left) ? rect.left : 0;
  const top = Number.isFinite(rect?.top) ? rect.top : 0;
  const width = Number.isFinite(rect?.width) ? Math.max(1, rect.width) : 1;
  const height = Number.isFinite(rect?.height) ? Math.max(1, rect.height) : 1;
  return Object.freeze({
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    height: `${height}px`,
  });
}

export function writeControlledInputValue(input, value, view = globalThis) {
  if (!input) return false;
  const prototype = view?.HTMLInputElement?.prototype ?? Object.getPrototypeOf(input);
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (typeof setter === 'function') setter.call(input, value);
  else input.value = value;

  const EventConstructor = view?.Event;
  if (typeof EventConstructor === 'function') {
    input.dispatchEvent(new EventConstructor('input', { bubbles: true }));
  }
  return true;
}

function configureSessionInput(input) {
  input.id = SESSION_INPUT_ID;
  input.type = 'text';
  input.name = 'spelling-session';
  input.autocomplete = 'off';
  input.autocapitalize = 'none';
  input.spellcheck = false;
  input.inputMode = 'text';
  input.enterKeyHint = 'go';
  input.lang = 'en-GB';
  input.tabIndex = -1;
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('writingsuggestions', 'false');
  input.setAttribute('aria-label', 'Type the spelling');
  input.setAttribute('aria-hidden', 'true');

  Object.assign(input.style, {
    position: 'fixed',
    left: '0px',
    top: '0px',
    width: '1px',
    height: '1px',
    zIndex: '2147483647',
    border: '0',
    borderRadius: '0',
    padding: '0',
    margin: '0',
    background: 'transparent',
    boxShadow: 'none',
    color: 'transparent',
    caretColor: 'transparent',
    fontSize: '16px',
    lineHeight: '1',
    opacity: '1',
    outline: 'none',
    pointerEvents: 'none',
    transform: 'translate(-200vw, -200vh)',
    WebkitAppearance: 'none',
    appearance: 'none',
  });
}

/**
 * Keep one real text input alive across the asynchronous Setup -> Round screen
 * transition. iOS only promotes a focused WKWebView field to a software-keyboard
 * session while a trusted activation is still running; the round input itself is
 * mounted after startRound() has awaited storage, so focusing that new node is
 * too late. This stable input receives the Set off activation, then stays first
 * responder while its value is mirrored into React's controlled round input.
 */
export function installIOSDictationInputSession(view = globalThis) {
  const document = view?.document;
  const body = document?.body;
  if (!document || !body?.append) return noOp;

  const root = document.documentElement;
  const sessionInput = document.createElement('input');
  configureSessionInput(sessionInput);
  body.append(sessionInput);

  let activeRoundInput = null;
  let roundRestore = null;
  let lastRoundDisabled = null;
  let armed = false;
  let sawBusy = false;
  let paused = false;
  let refocusAfterKeep = false;
  let protectFocusAfterDialogClose = false;
  let startForwarded = false;
  let armTimer = null;
  let focusGuardTimer = null;
  let reconcileFrame = null;

  const requestFrame = typeof view.requestAnimationFrame === 'function'
    ? view.requestAnimationFrame.bind(view)
    : (callback) => view.setTimeout(callback, 0);
  const cancelFrame = typeof view.cancelAnimationFrame === 'function'
    ? view.cancelAnimationFrame.bind(view)
    : view.clearTimeout.bind(view);

  function setPhase(phase) {
    if (!root?.dataset) return;
    if (phase) root.dataset.dictationInputSession = phase;
    else delete root.dataset.dictationInputSession;
  }

  function placeOver(target, interactive) {
    if (!target?.getBoundingClientRect) return false;
    const placement = placementForRect(target.getBoundingClientRect());
    Object.assign(sessionInput.style, placement, {
      pointerEvents: interactive ? 'auto' : 'none',
      transform: 'none',
    });
    sessionInput.tabIndex = 0;
    sessionInput.removeAttribute('aria-hidden');
    return true;
  }

  function dockForSetup(startButton) {
    if (!startButton?.getBoundingClientRect || !isUsableControl(startButton)) {
      park();
      return false;
    }
    const placement = placementForRect(startButton.getBoundingClientRect());
    Object.assign(sessionInput.style, placement, {
      pointerEvents: 'auto',
      transform: 'none',
    });
    // Keep the real Set off button as the accessible control. A direct touch can
    // still land on this text field and create the iOS keyboard session; keyboard
    // and assistive-technology activation of the button use the capture fallback.
    sessionInput.tabIndex = -1;
    sessionInput.setAttribute('aria-hidden', 'true');
    return true;
  }

  function park() {
    if (document.activeElement === sessionInput) sessionInput.blur();
    Object.assign(sessionInput.style, {
      left: '0px',
      top: '0px',
      width: '1px',
      height: '1px',
      pointerEvents: 'none',
      transform: 'translate(-200vw, -200vh)',
    });
    sessionInput.tabIndex = -1;
    sessionInput.setAttribute('aria-hidden', 'true');
  }

  function focusSessionInput() {
    try {
      sessionInput.focus({ preventScroll: true });
    } catch {
      sessionInput.focus();
    }
    try {
      const end = sessionInput.value.length;
      sessionInput.setSelectionRange(end, end);
    } catch {
      // Some accessibility input modes expose no selection range. Focus is the
      // only part needed to retain the keyboard session.
    }
  }

  function clearArmTimer() {
    if (armTimer == null) return;
    view.clearTimeout(armTimer);
    armTimer = null;
  }

  function clearFocusGuard() {
    if (focusGuardTimer != null) view.clearTimeout(focusGuardTimer);
    focusGuardTimer = null;
    protectFocusAfterDialogClose = false;
  }

  function scheduleArmExpiry() {
    clearArmTimer();
    armTimer = view.setTimeout(() => {
      armTimer = null;
      if (activeRoundInput || !armed) return;
      const startButton = document.querySelector(SETUP_START_SELECTOR);
      if (startButton?.disabled) {
        // A slow repository transaction must not cost the trusted keyboard
        // session. Recheck while the real control still says Preparing.
        scheduleArmExpiry();
        return;
      }
      disarm();
      reconcile();
    }, ARM_TIMEOUT_MS);
  }

  function restoreRoundInput() {
    if (!activeRoundInput || !roundRestore) return;
    if (roundRestore.ariaHidden == null) {
      activeRoundInput.removeAttribute('aria-hidden');
    } else {
      activeRoundInput.setAttribute('aria-hidden', roundRestore.ariaHidden);
    }
    if (roundRestore.tabIndex == null) {
      activeRoundInput.removeAttribute('tabindex');
    } else {
      activeRoundInput.setAttribute('tabindex', roundRestore.tabIndex);
    }
    activeRoundInput.style.pointerEvents = roundRestore.pointerEvents;
  }

  function deactivateRoundInput() {
    restoreRoundInput();
    activeRoundInput = null;
    roundRestore = null;
    lastRoundDisabled = null;
  }

  function disarm() {
    clearArmTimer();
    armed = false;
    sawBusy = false;
    paused = false;
    refocusAfterKeep = false;
    startForwarded = false;
    clearFocusGuard();
    deactivateRoundInput();
    if (document.activeElement === sessionInput) sessionInput.blur();
    sessionInput.value = '';
    setPhase(null);
    park();
  }

  function mirrorSessionValue() {
    if (!activeRoundInput || activeRoundInput.disabled) return false;
    return writeControlledInputValue(activeRoundInput, sessionInput.value, view);
  }

  function activateRoundInput(roundInput) {
    if (activeRoundInput !== roundInput) {
      deactivateRoundInput();
      activeRoundInput = roundInput;
      roundRestore = {
        ariaHidden: roundInput.getAttribute('aria-hidden'),
        tabIndex: roundInput.getAttribute('tabindex'),
        pointerEvents: roundInput.style.pointerEvents,
      };
      roundInput.setAttribute('aria-hidden', 'true');
      roundInput.setAttribute('tabindex', '-1');
      roundInput.style.pointerEvents = 'none';
      lastRoundDisabled = roundInput.disabled;

      const buffered = sessionInput.value;
      if (armed && buffered !== '' && roundInput.value === '' && !roundInput.disabled) {
        writeControlledInputValue(roundInput, buffered, view);
      } else {
        sessionInput.value = roundInput.value ?? '';
      }
    }

    clearArmTimer();
    armed = false;
    sawBusy = false;
    if (paused) {
      setPhase('paused');
      park();
      return;
    }
    setPhase('round');
    placeOver(roundInput, true);
  }

  function armFrom(startButton, { direct = false } = {}) {
    if (!isUsableControl(startButton) || activeRoundInput) return;
    paused = false;
    if (!armed) {
      sessionInput.value = '';
      startForwarded = false;
    }
    armed = true;
    sawBusy = startButton.disabled === true;
    setPhase('armed');
    placeOver(startButton, direct);
    focusSessionInput();
    scheduleArmExpiry();
  }

  function reconcile() {
    const roundInput = document.querySelector(ROUND_INPUT_SELECTOR);
    if (roundInput) {
      // Escape closes LeaveRoundDialog without a button click. Once the dialog is
      // gone but the round remains, restore the spelling session as the modal's
      // semantic equivalent of Keep practising.
      if (paused && !document.querySelector(EXIT_DIALOG_SELECTOR)) {
        resumeRoundInputSession({ guardFocus: true });
      }
      const changedRound = activeRoundInput !== roundInput;
      activateRoundInput(roundInput);
      if (paused) return;
      const disabledChanged = lastRoundDisabled !== roundInput.disabled;
      if (!changedRound && disabledChanged) {
        sessionInput.value = roundInput.value ?? '';
      }
      lastRoundDisabled = roundInput.disabled;
      placeOver(roundInput, true);
      return;
    }

    if (activeRoundInput) {
      disarm();
      return;
    }

    const startButton = document.querySelector(SETUP_START_SELECTOR);
    if (armed && startButton) {
      // Keep shielding the real button after its action has been forwarded. This
      // closes the tiny pre-render window in which a double tap could start the
      // same asynchronous transaction twice.
      placeOver(startButton, true);
      if (startButton.disabled) {
        sawBusy = true;
      } else if (sawBusy) {
        // startRound() returned to Setup instead of mounting a round.
        disarm();
        dockForSetup(startButton);
      }
      return;
    }

    // Armed without Setup (learner left the screen) or idle without a dock
    // target: never leave an interactive shield floating over another place.
    if (armed) {
      disarm();
      return;
    }

    setPhase(null);
    if (!dockForSetup(startButton)) park();
  }

  function scheduleReconcile() {
    if (reconcileFrame != null) return;
    reconcileFrame = requestFrame(() => {
      reconcileFrame = null;
      reconcile();
    });
  }

  function onMutations(records = []) {
    // React may add and remove `disabled` before one MutationObserver delivery
    // when startRound fails quickly. Record that the busy phase happened even
    // when the final button state is already enabled, so retry is not blocked by
    // the armed overlay until its safety timeout.
    if (armed && records.some((record) => (
      record.type === 'attributes'
      && record.attributeName === 'disabled'
      && closestMatching(record.target, SETUP_START_SELECTOR)
    ))) {
      sawBusy = true;
    }
    scheduleReconcile();
  }

  function pauseRoundInputSession() {
    if (!activeRoundInput) return;
    paused = true;
    refocusAfterKeep = false;
    clearFocusGuard();
    setPhase('paused');
    if (document.activeElement === sessionInput) sessionInput.blur();
    park();
  }

  function resumeRoundInputSession({ afterKeep = false, guardFocus = false } = {}) {
    if (!activeRoundInput) return;
    paused = false;
    refocusAfterKeep = afterKeep;
    if (afterKeep || guardFocus) {
      clearFocusGuard();
      protectFocusAfterDialogClose = true;
      focusGuardTimer = view.setTimeout(clearFocusGuard, 1_000);
    }
    setPhase('round');
    placeOver(activeRoundInput, true);
    focusSessionInput();
  }

  function onSessionPointerDown() {
    if (activeRoundInput) {
      // Backgrounding can leave the DOM focus token intact after UIKit has put
      // the software keyboard away. A real tap on the answer line must reassert
      // first responder ownership inside that new trusted pointer turn.
      focusSessionInput();
      return;
    }
    const startButton = document.querySelector(SETUP_START_SELECTOR);
    if (isUsableControl(startButton)) armFrom(startButton, { direct: true });
  }

  function onSessionClick() {
    if (activeRoundInput || !armed || startForwarded) return;
    const startButton = document.querySelector(SETUP_START_SELECTOR);
    // Once React has disabled Set off, the overlay deliberately swallows repeat
    // taps rather than dismissing the keyboard or starting a second transaction.
    if (!isUsableControl(startButton)) return;
    // The trusted touch belongs to the real input, which is the reliable iOS
    // keyboard activation. Forward only the product action to React's button.
    startForwarded = true;
    startButton.click();
  }

  function onDocumentActivation(event) {
    const startButton = closestMatching(event.target, SETUP_START_SELECTOR);
    if (startButton) {
      armFrom(startButton);
      // A real button activation already carries the product action itself. Mark
      // it forwarded so the transparent field can shield any immediate repeat.
      startForwarded = true;
      return;
    }

    if (!activeRoundInput) return;

    const endRound = closestMatching(event.target, END_ROUND_SELECTOR);
    const leaveRound = closestMatching(event.target, LEAVE_ROUND_SELECTOR);
    if (endRound || leaveRound) {
      pauseRoundInputSession();
      return;
    }

    const keepRound = closestMatching(event.target, KEEP_ROUND_SELECTOR);
    if (isUsableControl(keepRound)) {
      if (event.type === 'click') {
        resumeRoundInputSession({ afterKeep: true });
      }
      return;
    }

    const roundAction = closestMatching(event.target, ROUND_ACTION_SELECTOR);
    if (isUsableControl(roundAction)) resumeRoundInputSession();
  }

  function onDocumentClickBubble() {
    if (!refocusAfterKeep) return;
    refocusAfterKeep = false;
    resumeRoundInputSession();
  }

  function onDocumentFocusIn(event) {
    if (
      !protectFocusAfterDialogClose
      || paused
      || !activeRoundInput
      || event.target === sessionInput
    ) return;
    // LeaveRoundDialog correctly restores the control that was focused before it
    // opened. The persistent spelling field has already become first responder
    // again after Keep or Escape, so reclaim any later passive focus restoration
    // before UIKit finishes dismissing that keyboard session.
    focusSessionInput();
  }

  function onSessionInput() {
    if (!activeRoundInput) return;
    if (activeRoundInput.disabled) {
      sessionInput.value = activeRoundInput.value ?? '';
      return;
    }
    mirrorSessionValue();
  }

  function onSessionKeyDown(event) {
    if (event.key !== 'Enter' || !activeRoundInput) return;
    const form = activeRoundInput.form ?? activeRoundInput.closest?.('form');
    const submit = form?.querySelector?.('button[type="submit"]') ?? null;
    if (!form || submit?.disabled) return;
    event.preventDefault();
    if (typeof form.requestSubmit === 'function') form.requestSubmit(submit ?? undefined);
  }

  function reposition() {
    if (paused) return;
    if (activeRoundInput) placeOver(activeRoundInput, true);
    else if (armed) {
      const startButton = document.querySelector(SETUP_START_SELECTOR);
      if (startButton) placeOver(startButton, true);
    }
  }

  document.addEventListener('pointerup', onDocumentActivation, true);
  document.addEventListener('click', onDocumentActivation, true);
  document.addEventListener('click', onDocumentClickBubble);
  // The compact round can scroll inside the scene rather than the window. Scroll
  // does not bubble, so capture it at the document and keep the fixed input over
  // the visible answer line instead of leaving an invisible hit target behind.
  document.addEventListener('scroll', reposition, true);
  document.addEventListener('focusin', onDocumentFocusIn, true);
  sessionInput.addEventListener('pointerdown', onSessionPointerDown);
  sessionInput.addEventListener('click', onSessionClick);
  sessionInput.addEventListener('input', onSessionInput);
  sessionInput.addEventListener('keydown', onSessionKeyDown);
  view.addEventListener?.('resize', reposition);
  view.visualViewport?.addEventListener?.('resize', reposition);
  view.visualViewport?.addEventListener?.('scroll', reposition);

  const MutationObserverConstructor = view.MutationObserver;
  const observer = typeof MutationObserverConstructor === 'function'
    ? new MutationObserverConstructor(onMutations)
    : null;
  observer?.observe(body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['disabled'],
    attributeOldValue: true,
  });
  reconcile();

  return () => {
    clearArmTimer();
    clearFocusGuard();
    if (reconcileFrame != null) cancelFrame(reconcileFrame);
    observer?.disconnect();
    document.removeEventListener('pointerup', onDocumentActivation, true);
    document.removeEventListener('click', onDocumentActivation, true);
    document.removeEventListener('click', onDocumentClickBubble);
    document.removeEventListener('scroll', reposition, true);
    document.removeEventListener('focusin', onDocumentFocusIn, true);
    sessionInput.removeEventListener('pointerdown', onSessionPointerDown);
    sessionInput.removeEventListener('click', onSessionClick);
    sessionInput.removeEventListener('input', onSessionInput);
    sessionInput.removeEventListener('keydown', onSessionKeyDown);
    view.removeEventListener?.('resize', reposition);
    view.visualViewport?.removeEventListener?.('resize', reposition);
    view.visualViewport?.removeEventListener?.('scroll', reposition);
    restoreRoundInput();
    if (document.activeElement === sessionInput) sessionInput.blur();
    sessionInput.remove();
    setPhase(null);
  };
}
