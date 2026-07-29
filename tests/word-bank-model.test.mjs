import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWordBank } from '../src/app/word-bank-model.js';

function word(overrides = {}) {
  return {
    runtimeItemId: 'ks2-core:accident',
    target: 'accident',
    yearBand: '3-4',
    coverageTier: 'statutory-core',
    stage: 0,
    attempts: 0,
    correct: 0,
    wrong: 0,
    dueDay: null,
    lastResult: null,
    ...overrides,
  };
}

const ALL_SETS = Object.freeze([
  Object.freeze({ id: 'core', label: 'Core', count: 3 }),
  Object.freeze({ id: 'y3-4', label: 'Y3–4', count: 2 }),
  Object.freeze({ id: 'y5-6', label: 'Y5–6', count: 1 }),
]);

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
  assert.equal(bank.setTotal, 2);
  assert.equal(bank.countLabel, '2 words');
  assert.equal(bank.rows[0].note, 'Not met yet');
  assert.equal(bank.rows[1].note, '1 correct · never missed');
});

test('missing due dates do not coerce to guardian day zero', () => {
  const bank = buildWordBank({
    now: 0,
    progress: [word({
      attempts: 3,
      correct: 2,
      wrong: 1,
      dueDay: null,
    })],
  });

  assert.equal(bank.rows[0].due, false);
  assert.equal(bank.rows[0].status, 'learning');
  assert.equal(bank.rows[0].note, '2 correct · 1 to revisit');
  assert.equal(bank.filters.find(({ id }) => id === 'due').count, 0);
  assert.equal(bank.filters.find(({ id }) => id === 'trouble').count, 0);
});

test('word bank offers only vocabulary sets published by the controller', () => {
  const bank = buildWordBank({
    progress: [word()],
    vocabularySets: [
      { id: 'core', label: 'Core', count: 1 },
      { id: 'y3-4', label: 'Y3–4', count: 1 },
      { id: 'y5-6', label: 'Y5–6', count: 0 },
      { id: 'unknown', label: 'Invented', count: 99 },
      { id: 'core', label: 'Duplicate', count: 1 },
    ],
    vocabSet: 'y5-6',
    now: 0,
  });

  assert.deepEqual(bank.vocabSets.map(({ id, label }) => ({ id, label })), [
    { id: 'core', label: 'Core' },
    { id: 'y3-4', label: 'Y3–4' },
  ]);
  assert.equal(bank.vocabSets[0].selected, true);
  assert.deepEqual(bank.rows.map((row) => row.word), ['accident']);
});

test('word bank infers only catalogue-backed year bands when metadata is absent', () => {
  const y34Only = buildWordBank({
    progress: [word()],
    now: 0,
  });
  assert.deepEqual(y34Only.vocabSets.map(({ id }) => id), ['core', 'y3-4']);

  const bothBands = buildWordBank({
    progress: [
      word(),
      word({
        runtimeItemId: 'ks2-core:occupy',
        target: 'occupy',
        yearBand: '5-6',
      }),
    ],
    now: 0,
  });
  assert.deepEqual(bothBands.vocabSets.map(({ id }) => id), [
    'core',
    'y3-4',
    'y5-6',
  ]);
});

test('non-core catalogue rows never leak into statutory vocabulary sets', () => {
  const bank = buildWordBank({
    progress: [
      word(),
      word({
        runtimeItemId: 'extension:occupy',
        target: 'occupy',
        yearBand: '5-6',
        coverageTier: 'extension',
      }),
    ],
    vocabularySets: ALL_SETS,
    now: 0,
  });

  assert.equal(bank.total, 1);
  assert.deepEqual(bank.rows.map((row) => row.word), ['accident']);
  assert.deepEqual(bank.vocabSets.map(({ id }) => id), ['core', 'y3-4']);
  assert.equal(bank.vocabSets.find(({ id }) => id === 'core').count, 1);
});

test('legacy rows without coverage metadata remain readable as core', () => {
  const bank = buildWordBank({
    progress: [word({ coverageTier: null })],
    vocabularySets: [
      { id: 'core', label: 'Core', count: 1 },
      { id: 'y3-4', label: 'Y3–4', count: 1 },
    ],
    now: 0,
  });

  assert.equal(bank.total, 1);
  assert.deepEqual(bank.rows.map((row) => row.word), ['accident']);
  assert.deepEqual(bank.vocabSets.map(({ id }) => id), ['core', 'y3-4']);
});

test('legacy core rows stay isolated from explicitly marked extensions', () => {
  const bank = buildWordBank({
    progress: [
      word({ coverageTier: null }),
      word({
        runtimeItemId: 'extension:occupy',
        target: 'occupy',
        yearBand: '5-6',
        coverageTier: 'extension',
      }),
    ],
    vocabularySets: [
      { id: 'core', label: 'Core', count: 1 },
      { id: 'y3-4', label: 'Y3–4', count: 1 },
      { id: 'y5-6', label: 'Y5–6', count: 1 },
    ],
    vocabSet: 'y5-6',
    now: 0,
  });

  assert.equal(bank.total, 1);
  assert.deepEqual(bank.rows.map((row) => row.word), ['accident']);
  assert.deepEqual(bank.vocabSets.map(({ id }) => id), ['core', 'y3-4']);
  assert.equal(bank.vocabSets[0].selected, true);
});

test('word bank filters by vocabulary set, status and normalised live search', () => {
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
      runtimeItemId: 'ks2-core:self-respect',
      target: 'self-respect',
      yearBand: '3-4',
      stage: 1,
      attempts: 1,
      correct: 1,
      wrong: 0,
      dueDay: 1,
    }),
  ];

  const y56 = buildWordBank({
    progress,
    vocabularySets: ALL_SETS,
    vocabSet: 'y5-6',
    now: 0,
  });
  assert.deepEqual(y56.rows.map((row) => row.word), ['occupy']);
  assert.equal(y56.countLabel, '1 word');
  assert.equal(y56.vocabSets.find(({ id }) => id === 'core').count, 3);
  assert.equal(y56.vocabSets.find(({ id }) => id === 'y5-6').selected, true);
  assert.equal(y56.filters.find(({ id }) => id === 'all').count, 1);

  const searched = buildWordBank({
    progress,
    vocabularySets: ALL_SETS,
    query: '  SELF–RES  ',
    now: 0,
  });
  assert.deepEqual(searched.rows.map((row) => row.word), ['self-respect']);
  assert.equal(searched.countLabel, '1 of 3');
  // Set counts describe the catalogue and must not jump around while typing.
  assert.equal(searched.vocabSets.find(({ id }) => id === 'core').count, 3);
  assert.equal(searched.vocabSets.find(({ id }) => id === 'y3-4').count, 2);

  const missed = buildWordBank({
    progress,
    vocabularySets: ALL_SETS,
    vocabSet: 'y3-4',
    query: 'occupy',
    now: 0,
  });
  assert.equal(missed.empty, true);
  assert.equal(missed.emptyHeading, 'No matching words');
  assert.equal(missed.countLabel, '0 of 2');

  const secureY34 = buildWordBank({
    progress,
    vocabularySets: ALL_SETS,
    vocabSet: 'y3-4',
    filter: 'secure',
    now: 0,
  });
  assert.deepEqual(secureY34.rows.map((row) => row.word), ['accident']);
  assert.equal(secureY34.filters.find(({ id }) => id === 'secure').count, 1);
  assert.equal(secureY34.countLabel, '1 of 2');
});

test('programmatic queries are capped to the same boundary as the input', () => {
  const sixtyFourCharacters = 'a'.repeat(64);
  const bank = buildWordBank({
    progress: [word({
      runtimeItemId: 'ks2-core:long-test-word',
      target: sixtyFourCharacters,
    })],
    query: `${sixtyFourCharacters}ignored-tail`,
    now: 0,
  });

  assert.deepEqual(bank.rows.map((row) => row.word), [sixtyFourCharacters]);
  assert.equal(bank.countLabel, '1 of 1');
});

test('unknown filters and empty set metadata fall back safely', () => {
  const bank = buildWordBank({
    progress: [word()],
    filter: 'not-a-filter',
    vocabSet: 'not-a-set',
    vocabularySets: [],
    query: null,
    now: 0,
  });

  assert.equal(bank.filters.find(({ selected }) => selected).id, 'all');
  assert.equal(bank.vocabSets.find(({ selected }) => selected).id, 'core');
  assert.deepEqual(bank.rows.map((row) => row.word), ['accident']);
});
