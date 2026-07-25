// iOS does not shrink a WKWebView when the keyboard opens. The layout viewport
// keeps its full height and the keys are simply drawn over the bottom of the
// page, so `100vh` still measures the whole screen and a card laid out against
// it puts its own submit button underneath the keyboard.
//
// The visual viewport is the one thing that does report the change. The height
// it loses is the height the keyboard took, and publishing that as a custom
// property lets the layout give it back as space.

// Sub-pixel viewport rounding and elastic overscroll both report a few stray
// pixels of loss with no keyboard on screen. A key is taller than this, so
// nothing smaller can be one.
const KEYBOARD_FLOOR_PX = 24;

// Whether the card still has room is a different question from how much space
// the keyboard took, and it has two answers that look identical to a layout: the
// keyboard is drawn over the page, or the phone is in landscape and the whole
// screen is 430pt tall. Both show up as the visual viewport being short, so one
// measurement covers both — and measuring what is left rather than what was
// taken closes the false positive that used to need its own threshold, because
// the iOS form accessory bar costing 55pt of a portrait phone still leaves
// plenty. (The bar itself is hidden at startup; see
// `src/platform/keyboard/capacitor-keyboard.js`.)
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

// Publishes the inset on the document element as `--keyboard-inset` so a layout
// can give the space back, plus a `data-room` flag so it can compact when there
// is no longer room to give. Returns a teardown; safe to call where neither
// viewport exists.
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
