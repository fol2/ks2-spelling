// Capacitor's native iOS keyboard resize is deliberately left at its default.
// During the keyboard animation, WebKit versions can update the layout viewport
// and visual viewport at slightly different times. The visual viewport remains
// the useful measurement of what the learner can actually see: when native
// resize has already reduced `innerHeight`, the covered inset naturally resolves
// to zero, while the remaining height still tells the round when to compact.

// Sub-pixel viewport rounding and elastic overscroll both report a few stray
// pixels of loss with no keyboard on screen. A key is taller than this, so
// nothing smaller can be one.
const KEYBOARD_FLOOR_PX = 24;

// Whether the card still has room is a different question from how much space
// the keyboard took. Measuring what remains also covers landscape and split-view
// layouts without pretending that every short visual viewport is a keyboard.
//
// The floor is the height at which the round card stops fitting at full size:
// its own content plus the trail line and the footer under it.
const ROOM_FLOOR_PX = 620;

export function hasRoomForCard(visualHeight) {
  // Unknown means do not compact: a full-size card in a short screen can be
  // scrolled, and a compacted one in a tall screen is stranded.
  if (!Number.isFinite(visualHeight) || visualHeight <= 0) return true;
  return visualHeight >= ROOM_FLOOR_PX;
}

export function keyboardInset(layoutHeight, visual) {
  if (!visual) return 0;
  const { height, offsetTop } = visual;
  if (!Number.isFinite(layoutHeight) || !Number.isFinite(height)) return 0;
  // `offsetTop` counts the part of the layout viewport scrolled off the top of
  // the visual one, which is not keyboard: only the remainder is.
  const covered = layoutHeight - height - (Number.isFinite(offsetTop) ? offsetTop : 0);
  return covered > KEYBOARD_FLOOR_PX ? Math.round(covered) : 0;
}

// Publishes the inset on the document element as `--keyboard-inset` so the
// practice layout can give covered space back, plus a `data-room` flag so it can
// compact whenever the visible viewport is genuinely short. Returns a teardown;
// safe to call where no visual viewport exists.
export function observeKeyboardInset(view = globalThis, element = null) {
  const visual = view?.visualViewport;
  const root = element ?? view?.document?.documentElement ?? null;
  if (!visual || !root?.style) return () => {};

  const publish = () => {
    const inset = keyboardInset(view.innerHeight, visual);
    root.style.setProperty('--keyboard-inset', `${inset}px`);
    root.dataset.room = hasRoomForCard(visual.height) ? 'ample' : 'tight';
  };

  publish();
  visual.addEventListener('resize', publish);
  visual.addEventListener('scroll', publish);
  return () => {
    visual.removeEventListener('resize', publish);
    visual.removeEventListener('scroll', publish);
    root.style.removeProperty('--keyboard-inset');
    delete root.dataset.room;
  };
}
