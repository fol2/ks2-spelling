import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { B4_COMMAND_TRACE } from '../src/app/b4-round-contract.js';

const SWIFT_PATH = new URL(
  '../ios/App/B3ProofUITests/B4DevelopmentTests.swift',
  import.meta.url,
);

test('the iOS installed journey follows the frozen B4 answers without a proof bridge', async () => {
  const source = await readFile(SWIFT_PATH, 'utf8');
  const answerBlock = source.match(/private let frozenAnswers = \[([\s\S]*?)\n    \]/);
  assert.ok(answerBlock, 'B4DevelopmentTests must declare frozenAnswers.');

  const nativeAnswers = [...answerBlock[1].matchAll(/"([a-z]+)"/g)]
    .map(([, answer]) => answer);
  const contractAnswers = B4_COMMAND_TRACE
    .filter(({ type }) => type === 'submit-answer')
    .map(({ payload }) => payload.typed);
  assert.deepEqual(nativeAnswers, contractAnswers);

  for (const required of [
    'testInstalledFiveCardJourney',
    'application.keyboards.firstMatch',
    'application.terminate()',
    'XCUIDevice.shared.press(.home)',
    'minimumControlHeightPoints',
    'coldLaunchMs',
    'answerFeedbackMs',
    'audioStartMs',
    'b4-ios-journey-observations.json',
    'testTabletLayoutScreenshots',
    'XCUIDevice.shared.orientation = .portrait',
    'XCUIDevice.shared.orientation = .landscapeLeft',
    'b4-ios-layout-portrait',
    'b4-ios-layout-landscape',
    'frame.width > element.frame.height',
  ]) {
    assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.doesNotMatch(source, /B3|proof bridge|target word|currentRuntimeItemId/i);
});
