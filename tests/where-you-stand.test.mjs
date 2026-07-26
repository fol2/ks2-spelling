import test from 'node:test';
import assert from 'node:assert/strict';

import { whereYouStand } from '../src/app/where-you-stand.js';

const cell = (cells, label) => cells.find((entry) => entry.label === label);

test('whereYouStand derives the standing panel from saved progress', () => {
  const progress = [
    // secure, not due yet, last answer right
    { stage: 4, attempts: 6, correct: 6, wrong: 0, dueDay: 900, lastResult: 'correct' },
    // climbing, due today, wobbled last time
    { stage: 2, attempts: 5, correct: 3, wrong: 2, dueDay: 800, lastResult: 'wrong' },
    // met once, due in the past so still due
    { stage: 1, attempts: 1, correct: 1, wrong: 0, dueDay: 799, lastResult: 'correct' },
  ];

  const cells = whereYouStand(progress, 20, 800);

  assert.equal(cell(cells, 'Total spellings').value, 3);
  assert.equal(cell(cells, 'Secure').value, 1);
  // dueDay 800 and 799 have come round; 900 has not.
  assert.equal(cell(cells, 'Due today').value, 2);
  assert.equal(cell(cells, 'Weak spots').value, 1);
  // 20 in the pack, 3 met.
  assert.equal(cell(cells, 'Unseen').value, 17);
  // 10 correct of 12 attempts.
  assert.equal(cell(cells, 'Accuracy').value, '83%');
});

test('whereYouStand holds up before the learner has answered anything', () => {
  const cells = whereYouStand([], 20, 800);

  assert.equal(cell(cells, 'Total spellings').value, 0);
  assert.equal(cell(cells, 'Unseen').value, 20);
  // No attempts means no accuracy to report, rather than a confident zero.
  assert.equal(cell(cells, 'Accuracy').value, '—');
});

test('whereYouStand tolerates missing or malformed input', () => {
  assert.equal(whereYouStand(null, null, null).length, 6);
  assert.equal(cell(whereYouStand(null, null, null), 'Unseen').value, 0);
  // A pack smaller than what is recorded must not report negative unseen.
  assert.equal(cell(whereYouStand([{ stage: 1 }, { stage: 1 }], 1, 0), 'Unseen').value, 0);
});
