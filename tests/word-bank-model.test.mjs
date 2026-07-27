import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWordBank } from '../src/app/word-bank-model.js';

function word(overrides = {}) {
  return {
    runtimeItemId: 'ks2-core:accident',
    target: 'accident',
    yearBand: '3-4',
    stage: 0,
    attempts: 0,
    correct: 0,
    wrong: 0,
    dueDay: null,
    lastResult: null,
    ...overrides,
  };
}

test('word bank keeps unseen catalogue words alongside saved progress', () => {
  const bank = buildWordBank({
    now: 0,
    progress: [
      word(),
      word({
        runtimeItemId: 'ks2-core:answer',
        target: 'answer',
        stage: 1,
        attempts: 1,
        correct: 1,
        wrong: 0,
        dueDay: 1,
      }),
    ],
  });

  assert.equal(bank.total, 2);
  assert.equal(bank.rows[0].note, 'Not met yet');
  assert.equal(bank.rows[1].note, '1 correct · never missed');
});

test('word bank filters by vocabulary set, status and live search', () => {
  const progress = [
    word({
      runtimeItemId: 'ks2-core:accident',
      target: 'accident',
      yearBand: '3-4',
      stage: 5,
      attempts: 4,
      correct: 4,
      wrong: 0,
      dueDay: 1,
    }),
    word({
      runtimeItemId: 'ks2-core:occupy',
      target: 'occupy',
      yearBand: '5-6',
      stage: 1,
      attempts: 2,
      correct: 1,
      wrong: 1,
      dueDay: 0,
    }),
    word({
      runtimeItemId: 'ks2-core:answer',
      target: 'answer',
      yearBand: '3-4',
      stage: 1,
      attempts: 1,
      correct: 1,
      wrong: 0,
      dueDay: 1,
    }),
  ];

  const y56 = buildWordBank({ progress, vocabSet: 'y5-6', now: 0 });
  assert.deepEqual(y56.rows.map((row) => row.word), ['occupy']);
  assert.equal(y56.vocabSets.find(({ id }) => id === 'core').label, 'Core');
  assert.equal(y56.vocabSets.find(({ id }) => id === 'y5-6').selected, true);
  assert.equal(y56.filters.find(({ id }) => id === 'all').count, 1);

  const searched = buildWordBank({
    progress,
    query: 'acc',
    now: 0,
  });
  assert.deepEqual(searched.rows.map((row) => row.word), ['accident']);
  assert.equal(searched.empty, false);

  const missed = buildWordBank({
    progress,
    query: 'zzz',
    now: 0,
  });
  assert.equal(missed.empty, true);
  assert.equal(missed.emptyHeading, 'No matching words');

  const secureY34 = buildWordBank({
    progress,
    vocabSet: 'y3-4',
    filter: 'secure',
    now: 0,
  });
  assert.deepEqual(secureY34.rows.map((row) => row.word), ['accident']);
  assert.equal(secureY34.filters.find(({ id }) => id === 'secure').count, 1);
});
