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

// Compacting the card is a bigger claim than giving space back, so it wants a
// bigger threshold. Chrome around a focused field can cost tens of points on its
// own — the iOS form accessory bar is about 55pt, and it appears without any keys
// when a hardware keyboard is attached — and shrinking the card for that leaves
// it stranded in a full screen. Only a loss on the scale of actual keys is one.
// (The bar itself is hidden at startup; see
// `src/platform/keyboard/capacitor-keyboard.js`.)
const COMPACT_FLOOR_PX = 180;

export function keyboardInset(layoutHeight, visual) {
  if (!visual) return 0;
  const { height, offsetTop } = visual;
  if (!Number.isFinite(layoutHeight) || !Number.isFinite(height)) return 0;
  // `offsetTop` counts the part of the layout viewport scrolled off the top of
  // the visual one, which is not keyboard: only the remainder is.
  const covered = layoutHeight - height - (Number.isFinite(offsetTop) ? offsetTop : 0);
  return covered > KEYBOARD_FLOOR_PX ? Math.round(covered) : 0;
}

// Publishes the inset on the document element as `--keyboard-inset`, plus a
// `data-keyboard` flag so a layout can compact itself rather than only shift.
// Returns a teardown; safe to call where neither viewport exists.
export function observeKeyboardInset(view = globalThis, element = null) {
  const visual = view?.visualViewport;
  const root = element ?? view?.document?.documentElement ?? null;
  if (!visual || !root?.style) return () => {};

  const publish = () => {
    const inset = keyboardInset(view.innerHeight, visual);
    root.style.setProperty('--keyboard-inset', `${inset}px`);
    root.dataset.keyboard = inset >= COMPACT_FLOOR_PX ? 'up' : 'down';
  };

  publish();
  visual.addEventListener('resize', publish);
  visual.addEventListener('scroll', publish);
  return () => {
    visual.removeEventListener('resize', publish);
    visual.removeEventListener('scroll', publish);
    root.style.removeProperty('--keyboard-inset');
    delete root.dataset.keyboard;
  };
}
