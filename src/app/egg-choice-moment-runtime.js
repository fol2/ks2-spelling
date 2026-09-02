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
  { firstEl, secondEl, closeEl, dialogEl, active } = {},
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
  const fallback = cycle[0] ?? dialogEl ?? null;
  if (!fallback) return null;
  event.preventDefault?.();
  if (cycle.length <= 1) return { focus: fallback };
  const index = cycle.indexOf(current);
  if (index === -1) return { focus: fallback };
  if (event.shiftKey) {
    return { focus: cycle[(index - 1 + cycle.length) % cycle.length] };
  }
  return { focus: cycle[(index + 1) % cycle.length] };
}
