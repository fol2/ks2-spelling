import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWordBank } from '../src/app/word-bank-model.js';

test('word bank keeps unseen catalogue words alongside saved progress', () => {
  const bank = buildWordBank({
    now: 0,
    progress: [
      {
        runtimeItemId: 'ks2-core:accident',
        target: 'accident',
        stage: 0,
        attempts: 0,
        correct: 0,
        wrong: 0,
        dueDay: null,
        lastResult: null,
      },
      {
        runtimeItemId: 'ks2-core:answer',
        target: 'answer',
        stage: 1,
        attempts: 1,
        correct: 1,
        wrong: 0,
        dueDay: 1,
        lastResult: 'correct',
      },
    ],
  });

  assert.equal(bank.total, 2);
  assert.equal(bank.rows[0].note, 'Not met yet');
  assert.equal(bank.rows[1].note, '1 correct · never missed');
});
