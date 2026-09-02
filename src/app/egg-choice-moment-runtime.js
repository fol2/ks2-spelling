export function eggChoiceMomentMountFocus(firstEl) {
  firstEl?.focus?.({ preventScroll: true });
}

export function eggChoiceMomentRestoreFocus(previous) {
  if (typeof previous?.focus === 'function') previous.focus();
}

function isEnabled(el) {
  return Boolean(el) && el.disabled !== true;
}

function tabCycle(firstEl, secondEl, closeEl) {
  return [firstEl, secondEl, closeEl].filter(isEnabled);
}

export function eggChoiceMomentKeyDown(
  event,
  { firstEl, secondEl, closeEl, active } = {},
) {
  const current = active
    ?? (typeof document !== 'undefined' ? document.activeElement : null);
  const key = event?.key;
  if (key === 'Escape' && closeEl) {
    event.preventDefault?.();
    return { action: 'dismiss' };
  }
  if (key === 'ArrowLeft' || key === 'ArrowUp' || key === 'Home') {
    event.preventDefault?.();
    return { focus: isEnabled(firstEl) ? firstEl : (isEnabled(secondEl) ? secondEl : null) };
  }
  if (key === 'ArrowRight' || key === 'ArrowDown' || key === 'End') {
    event.preventDefault?.();
    return { focus: isEnabled(secondEl) ? secondEl : (isEnabled(firstEl) ? firstEl : null) };
  }
  if (key !== 'Tab') return null;
  const cycle = tabCycle(firstEl, secondEl, closeEl);
  const index = cycle.indexOf(current);
  if (cycle.length < 2 || index === -1) return null;
  if (event.shiftKey && index === 0) {
    event.preventDefault?.();
    return { focus: cycle.at(-1) };
  }
  if (!event.shiftKey && index === cycle.length - 1) {
    event.preventDefault?.();
    return { focus: cycle[0] };
  }
  return null;
}
