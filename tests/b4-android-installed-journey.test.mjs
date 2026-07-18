import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { B4_COMMAND_TRACE } from '../src/app/b4-round-contract.js';

const JAVA_PATH = new URL(
  '../android/app/src/androidTest/java/uk/eugnel/ks2spelling/B4DevelopmentTest.java',
  import.meta.url,
);

test('the Android installed journey follows the frozen B4 answers without a private bridge', async () => {
  const source = await readFile(JAVA_PATH, 'utf8');
  const answerBlock = source.match(/private static final String\[\] FROZEN_ANSWERS = \{([\s\S]*?)\n    \};/u);
  assert.ok(answerBlock, 'B4DevelopmentTest must declare FROZEN_ANSWERS.');
  const nativeAnswers = [...answerBlock[1].matchAll(/"([a-z]+)"/g)]
    .map(([, answer]) => answer);
  const contractAnswers = B4_COMMAND_TRACE
    .filter(({ type }) => type === 'submit-answer')
    .map(({ payload }) => payload.typed);
  assert.deepEqual(nativeAnswers, contractAnswers);

  for (const required of [
    'testJourneyPhaseOne',
    'testJourneyPhaseTwo',
    'androidx.test.uiautomator',
    'pressEnter',
    'pressBack',
    'pressHome',
    'getVisibleBounds',
    'minimumControlHeightDp',
    'b4EvidencePrefix',
    'Card [1-5] of 5',
    'Round complete',
  ]) {
    assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(source, /B3|proof bridge|target word|currentRuntimeItemId/i);
});
