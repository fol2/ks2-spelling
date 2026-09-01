export function eggChoiceMomentMountFocus(firstEl) {
  firstEl?.focus?.({ preventScroll: true });
}

export function eggChoiceMomentRestoreFocus(previous) {
  if (typeof previous?.focus === 'function') previous.focus();
}

export function eggChoiceMomentKeyDown(
  event,
  { firstEl, secondEl, active } = {},
) {
  const current = active
    ?? (typeof document !== 'undefined' ? document.activeElement : null);
  const key = event?.key;
  if (key === 'ArrowLeft' || key === 'ArrowUp' || key === 'Home') {
    event.preventDefault?.();
    return { focus: firstEl };
  }
  if (key === 'ArrowRight' || key === 'ArrowDown' || key === 'End') {
    event.preventDefault?.();
    return { focus: secondEl };
  }
  if (key !== 'Tab') return null;
  if (event.shiftKey && current === firstEl) {
    event.preventDefault?.();
    return { focus: secondEl };
  }
  if (!event.shiftKey && current === secondEl) {
    event.preventDefault?.();
    return { focus: firstEl };
  }
  return null;
}
