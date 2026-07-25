import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasRoomForCard,
  keyboardInset,
  observeKeyboardInset,
} from '../src/app/keyboard-inset.js';
import { spellingOnly } from '../src/app/practice-feel.js';

test('spellingOnly keeps the letters a spelling can hold and drops the rest', () => {
  assert.equal(spellingOnly('bicycle'), 'bicycle');
  // The keyboard's number page is the one iOS will not let the page hide, so
  // a digit must not survive the trip into an answer.
  assert.equal(spellingOnly('bicy2cle'), 'bicycle');
  assert.equal(spellingOnly('12345'), '');
  // A word that carries an apostrophe or a hyphen keeps it, in either quote.
  assert.equal(spellingOnly("don't"), "don't");
  assert.equal(spellingOnly('don’t'), 'don’t');
  assert.equal(spellingOnly('self-respect'), 'self-respect');
  // Whitespace and punctuation cannot appear in a single-word answer.
  assert.equal(spellingOnly('  bi cycle!  '), 'bicycle');
  // Accented letters are letters: `\p{L}`, not `a-z`.
  assert.equal(spellingOnly('café'), 'café');
  assert.equal(spellingOnly(null), '');
  assert.equal(spellingOnly(42), '');
});

test('keyboardInset reports the height the keyboard took and nothing smaller', () => {
  // iOS keeps the layout viewport at full height and shrinks only the visual
  // one, so the difference is the keyboard.
  assert.equal(keyboardInset(874, { height: 438, offsetTop: 0 }), 436);
  // No keyboard: the two agree.
  assert.equal(keyboardInset(874, { height: 874, offsetTop: 0 }), 0);
  // Sub-pixel rounding and elastic overscroll are not a keyboard.
  assert.equal(keyboardInset(874, { height: 866, offsetTop: 0 }), 0);
  // A page scrolled within the visual viewport loses height to the scroll,
  // not to the keyboard; only the remainder counts.
  assert.equal(keyboardInset(874, { height: 438, offsetTop: 120 }), 316);
  assert.equal(keyboardInset(874, null), 0);
  assert.equal(keyboardInset(Number.NaN, { height: 438, offsetTop: 0 }), 0);
});

test('room for the card is measured from what is left, not what was taken', () => {
  // A portrait phone has room; the same phone with the keyboard over it has not.
  assert.equal(hasRoomForCard(874), true);
  assert.equal(hasRoomForCard(438), false);
  // The form accessory bar alone costs about 55pt. That is space worth giving
  // back, but it is not a reason to shrink a card in a screen that is still
  // full — which is what a hardware keyboard produces on a simulator. Measuring
  // what is left says so without needing a second threshold.
  assert.equal(hasRoomForCard(819), true);
  // A phone in landscape is 430pt tall before anything is focused at all. This
  // is the case the old signal could not see: no keyboard, no room.
  assert.equal(hasRoomForCard(430), false);
  // An iPad keeps its room in either orientation, and with the keyboard up.
  assert.equal(hasRoomForCard(1194), true);
  assert.equal(hasRoomForCard(834), true);
  assert.equal(hasRoomForCard(824), true);
  // Unknown means do not compact: a full card in a short screen can be
  // scrolled, a compacted one in a tall screen is stranded.
  assert.equal(hasRoomForCard(Number.NaN), true);
  assert.equal(hasRoomForCard(0), true);
  assert.equal(hasRoomForCard(undefined), true);
});

test('observeKeyboardInset publishes the inset and cleans up after itself', () => {
  const listeners = new Map();
  const style = new Map();
  const root = {
    dataset: {},
    style: {
      setProperty: (name, value) => style.set(name, value),
      removeProperty: (name) => style.delete(name),
    },
  };
  const view = {
    innerHeight: 874,
    visualViewport: {
      height: 874,
      offsetTop: 0,
      addEventListener: (type, fn) => listeners.set(type, fn),
      removeEventListener: (type) => listeners.delete(type),
    },
  };

  const stop = observeKeyboardInset(view, root);
  assert.equal(style.get('--keyboard-inset'), '0px');
  assert.equal(root.dataset.room, 'ample');

  // Space worth giving back, in a screen that still has room for the card.
  view.visualViewport.height = 819;
  listeners.get('resize')();
  assert.equal(style.get('--keyboard-inset'), '55px');
  assert.equal(root.dataset.room, 'ample');

  view.visualViewport.height = 438;
  listeners.get('resize')();
  assert.equal(style.get('--keyboard-inset'), '436px');
  assert.equal(root.dataset.room, 'tight');

  // Landscape: nothing has taken any space, and there is still no room.
  view.innerHeight = 430;
  view.visualViewport.height = 430;
  listeners.get('resize')();
  assert.equal(style.get('--keyboard-inset'), '0px');
  assert.equal(root.dataset.room, 'tight');

  stop();
  assert.equal(listeners.size, 0);
  assert.equal(style.has('--keyboard-inset'), false);
  assert.equal(Object.hasOwn(root.dataset, 'room'), false);

  // A host with no visual viewport is not an error; there is just no inset.
  assert.equal(typeof observeKeyboardInset({}, root), 'function');
});
