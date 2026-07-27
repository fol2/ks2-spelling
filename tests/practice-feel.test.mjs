import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  autoAdvanceDelayMs,
  earlyRoundSummary,
  roundProgressDots,
} from '../src/app/practice-feel.js';

test('autoAdvanceDelayMs leaves the correction visible for two seconds', () => {
  assert.equal(autoAdvanceDelayMs(), 2_000);
});

test('roundProgressDots marks secured words done and the next one current', () => {
  assert.deepEqual(
    roundProgressDots({ done: 0, total: 5 }),
    ['current', '', '', '', ''],
  );
  assert.deepEqual(
    roundProgressDots({ done: 2, total: 5 }),
    ['done', 'done', 'current', '', ''],
  );
  assert.deepEqual(
    roundProgressDots({ done: 5, total: 5 }),
    ['done', 'done', 'done', 'done', 'done'],
  );
  assert.deepEqual(roundProgressDots(), []);
});

test('earlyRoundSummary reports the words reached, not the whole round', () => {
  assert.equal(earlyRoundSummary(null), null);
  assert.equal(
    earlyRoundSummary({ progress: { total: 5, checked: 0, done: 0, wrongCount: 0 } }),
    null,
    'a round with nothing answered has no summary to show',
  );
  const summary = earlyRoundSummary({
    mode: 'smart',
    label: 'Smart review',
    sessionId: 'session-a',
    progress: { total: 5, checked: 4, done: 1, wrongCount: 1 },
  });
  assert.equal(summary.totalWords, 4);
  assert.equal(summary.correct, 3);
  assert.equal(summary.accuracy, 75);
  assert.deepEqual(
    summary.cards.map(({ label, value }) => [label, value]),
    [['Words reached', 4], ['Secured this round', 1], ['Needed correction', 1]],
  );
});

test('PracticeScreen answer input keeps writingsuggestions="false"', async () => {
  const source = await readFile(
    resolve(import.meta.dirname, '../src/app/ProductApp.jsx'),
    'utf8',
  );
  assert.ok(
    source.includes('writingsuggestions="false"'),
    'answer input must keep writingsuggestions="false"',
  );
  assert.ok(
    source.includes('}, autoAdvanceDelayMs());'),
    'an accepted answer must schedule the next card',
  );
});
