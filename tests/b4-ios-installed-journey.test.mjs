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
    'input.wait(for: \\.hasFocus, toEqual: true, timeout: 5)',
    'keyboard.waitForExistence(timeout: 5)',
    'application.terminate()',
    'XCUIDevice.shared.press(.home)',
    'minimumControlHeightPoints',
    'referenceTextHeightPoints',
    'application.staticTexts["Type the spelling"]',
    'coldLaunchMs',
    'answerFeedbackMs',
    'audioStartMs',
    'b4-ios-journey-observations.json',
    'revealCompletionForScreenshot',
    'Start a fresh round',
    'swipeUp',
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
  assert.doesNotMatch(source, /currentInteractionOptions|SkipPreEventQuiescence/u);
  assert.doesNotMatch(source, /webView\.swipeDown\(\)/u);

  const replayLoop = source.match(
    /for label in \["Replay", "Slow replay"\] \{([\s\S]*?)\n        \}/u,
  );
  assert.ok(replayLoop, 'The installed journey must query each replay control by label.');
  const queryIndex = replayLoop[1].indexOf('application.buttons[label]');
  const tapIndex = replayLoop[1].indexOf('control.tap()');
  assert.ok(
    queryIndex >= 0 && tapIndex > queryIndex,
    'Each replay control must be queried after foregrounding and before its tap.',
  );
});

test('the B4 learner surface uses the standard WebKit Dynamic Type root', async () => {
  const source = await readFile(new URL('../src/app/app.css', import.meta.url), 'utf8');
  assert.match(source, /@supports \(font: -apple-system-body\)/u);
  assert.match(source, /\.b4-learner-shell\s*\{\s*font: -apple-system-body;/u);
  assert.match(source, /\.b4-round-heading h1[\s\S]*?font-size: 2\.5em;/u);
  assert.match(source, /\.b4-audio-disclosure[\s\S]*?font-size: 0\.9em;/u);
});
