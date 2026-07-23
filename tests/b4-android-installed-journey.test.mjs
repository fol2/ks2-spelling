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
    'scrollUntilVisible',
    'b4EvidencePrefix',
    'Card [1-5] of 5',
    'Round complete',
  ]) {
    assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  const minimumHeightBody = source.match(
    /private double minimumControlHeightDp\(\) \{([\s\S]*?)\n    \}/u,
  );
  assert.ok(minimumHeightBody, 'minimumControlHeightDp must remain directly reviewable.');
  assert.match(
    minimumHeightBody[1],
    /scrollUntilVisible/u,
    'Control-size evidence must scroll to controls outside the initial viewport.',
  );
  const tapBody = source.match(
    /private UiObject2 tap\(String label, BySelector selector\) \{([\s\S]*?)\n    \}/u,
  );
  assert.ok(tapBody, 'Native control activation must remain directly reviewable.');
  assert.match(
    tapBody[1],
    /scrollUntilVisible/u,
    'Native control activation must reach controls outside the initial viewport.',
  );
  const scrollingBody = source.match(
    /private UiObject2 scrollUntilVisible\(String label, BySelector selector\) \{([\s\S]*?)\n    \}/u,
  );
  assert.ok(scrollingBody, 'The installed journey must define bounded viewport scrolling.');
  assert.match(scrollingBody[1], /getVisibleBounds\(\)\.height\(\) > 0/u);
  assert.match(scrollingBody[1], /device\.swipe/u);
  assert.doesNotMatch(source, /B3|proof bridge|target word|currentRuntimeItemId/i);
});
