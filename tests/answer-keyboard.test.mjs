import assert from 'node:assert/strict';
import test from 'node:test';

import { keyboardInset, observeKeyboardInset } from '../src/app/keyboard-inset.js';
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
  assert.equal(root.dataset.keyboard, 'down');

  // The form accessory bar alone costs about 55pt. That is space worth giving
  // back, but not keys: compacting on it would shrink the card while the screen
  // is still full, which is what a hardware keyboard produces on a simulator.
  view.visualViewport.height = 819;
  listeners.get('resize')();
  assert.equal(style.get('--keyboard-inset'), '55px');
  assert.equal(root.dataset.keyboard, 'down');

  view.visualViewport.height = 438;
  listeners.get('resize')();
  assert.equal(style.get('--keyboard-inset'), '436px');
  assert.equal(root.dataset.keyboard, 'up');

  stop();
  assert.equal(listeners.size, 0);
  assert.equal(style.has('--keyboard-inset'), false);
  assert.equal(Object.hasOwn(root.dataset, 'keyboard'), false);

  // A host with no visual viewport is not an error; there is just no inset.
  assert.equal(typeof observeKeyboardInset({}, root), 'function');
});
