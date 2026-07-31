import assert from 'node:assert/strict';
import test from 'node:test';

import { LEARNER_COLOURS, learnerColour } from '../src/app/learner-colour.js';

test('the learner palette stays inside the Scribe Downs', () => {
  assert.equal(LEARNER_COLOURS.length, 6);
  for (const colour of LEARNER_COLOURS) {
    assert.match(colour, /^#[0-9a-f]{6}$/, `${colour} must be a storable hex`);
  }
  assert.equal(new Set(LEARNER_COLOURS).size, 6, 'no learner shares a colour');
});

test('a learner colour never moves for a given name', () => {
  // The point of deriving rather than storing: a child's colour is the same on
  // every device and cannot be repainted by anything that happens around them.
  assert.equal(learnerColour('Ada'), learnerColour('Ada'));
  // Case and stray whitespace are the same child.
  assert.equal(learnerColour('Ada'), learnerColour('  ada  '));
  assert.equal(learnerColour('Ada'), learnerColour('ADA'));
  // Different names generally differ; these two must, because they are the
  // pair the on-device screenshots are judged against.
  assert.notEqual(learnerColour('Ada'), learnerColour('Sam'));
});

test('a learner colour is always one of the six and always storable', () => {
  for (const name of ['Ada', 'Sam', 'Bea', 'Noor', 'Ibrahim', 'Zoë', '李明', '']) {
    assert.ok(
      LEARNER_COLOURS.includes(learnerColour(name)),
      `${name} must land in the palette`,
    );
  }
  // A missing or non-string name still has to yield a colour the profile
  // contract will accept, because it is written into the stored profile.
  for (const value of [undefined, null, 42, {}, []]) {
    assert.equal(learnerColour(value), LEARNER_COLOURS[0]);
  }
});

test('profile creation derives the stored colour from the nickname', async () => {
  // The module header promises the stored colour field is written from
  // learnerColour at creation. This pins the wiring: ProductApp must import
  // the derivation and must not fall back to the retired hardcoded teal that
  // made two children on one device two identical squares.
  const { readFile } = await import('node:fs/promises');
  const productApp = await readFile(
    new URL('../src/app/ProductApp.jsx', import.meta.url),
    'utf8',
  );
  assert.match(productApp, /import \{ learnerColour \} from '\.\/learner-colour\.js';/u);
  assert.match(productApp, /colour: learnerColour\(nextNickname\)/u);
  assert.doesNotMatch(productApp, /#157A76/u);
});
