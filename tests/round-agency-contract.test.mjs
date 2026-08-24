import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));

async function productAppSource() {
  return readFile(join(root, 'src/app/ProductApp.jsx'), 'utf8');
}

function roundScreenSource(productApp) {
  const start = productApp.indexOf('function RoundScreen({');
  assert.ok(start >= 0, 'RoundScreen must exist');
  const nextExport = productApp.indexOf('\nfunction ResultsScreen({', start);
  assert.ok(nextExport > start, 'RoundScreen must end before ResultsScreen');
  return productApp.slice(start, nextExport);
}

function playTryBlock(roundScreen) {
  const playStart = roundScreen.indexOf('async function play(kind) {');
  assert.ok(playStart >= 0);
  const tryStart = roundScreen.indexOf('try {', playStart);
  const catchStart = roundScreen.indexOf('} catch', tryStart);
  assert.ok(tryStart > playStart && catchStart > tryStart);
  return roundScreen.slice(tryStart, catchStart);
}

test('Skip for now reclaims focus before skipWord and never disables with answered', async () => {
  const productApp = await productAppSource();
  const roundScreen = roundScreenSource(productApp);

  assert.match(
    roundScreen,
    /\{!answered && \(\s*<button[\s\S]*?Skip for now/u,
  );
  assert.match(
    roundScreen,
    /onClick=\{\(\) => \{\s*focusSpellingField\(\);[\s\S]*?sfx\?\.play\('tick'\);[\s\S]*?haptics\?\.uiTick\?\.\(\);[\s\S]*?void onSkip\(\)/u,
  );
  assert.doesNotMatch(
    roundScreen,
    /disabled=\{busy \|\| answered\}/u,
    'Skip must not carry the forbidden busy||answered disable pattern',
  );
  assert.match(
    productApp,
    /onSkip=\{\(\) => services\.learning\.skipWord\(\)\}/u,
  );
});

test('attempts counter reads progress.checked of the round length', async () => {
  const roundScreen = roundScreenSource(await productAppSource());
  assert.match(
    roundScreen,
    /Answered \{practice\.progress\.checked\} of \{practice\.progress\.total \?\? total\}/u,
  );
});

test('feedback cue effect guards with lastCueKey and haptics only on success tones', async () => {
  const roundScreen = roundScreenSource(await productAppSource());
  assert.match(
    roundScreen,
    /const lastCueKeyRef = useRef\(''\)/u,
  );
  assert.match(
    roundScreen,
    /lastCueKeyRef\.current === cueKey/u,
  );
  assert.match(
    roundScreen,
    /\[practice\?\.runtimeItemId, practice\?\.feedback\?\.kind/u,
  );
  assert.match(
    roundScreen,
    /if \(tone === 'success'\) \{\s*haptics\?\.answerCorrect\?\.\(\);[\s\S]*?sfx\?\.play\('correct'\);/u,
  );
  assert.match(
    roundScreen,
    /else if \(tone === 'retry'\) \{\s*sfx\?\.play\('retry'\);/u,
  );
  assert.doesNotMatch(
    roundScreen,
    /tone === 'retry'[\s\S]{0,120}answerCorrect/u,
    'retry feedback must not fire answerCorrect haptics',
  );
});

test('play() notes speech before dictation audio.play', async () => {
  const tryBlock = playTryBlock(roundScreenSource(await productAppSource()));
  const noteAt = tryBlock.indexOf("sfx?.noteSpeechStarted(6000)");
  const playAt = tryBlock.indexOf('await audio.play');
  assert.ok(noteAt >= 0, 'play() must call noteSpeechStarted');
  assert.ok(playAt >= 0, 'play() must still await audio.play');
  assert.ok(
    noteAt < playAt,
    'noteSpeechStarted must run before audio.play so speech ducking is armed',
  );
});

test('Practice marks answer submission and the first feedback paint at their UI seams', async () => {
  const productApp = await productAppSource();
  const roundScreen = roundScreenSource(productApp);

  assert.match(
    productApp,
    /import \{ markB4 \} from '\.\/b4-performance-marks\.js';/u,
  );
  assert.match(
    roundScreen,
    /if \(answered\) \{[\s\S]*?return;[\s\S]*?if \(answer\.trim\(\) === ''\) \{[\s\S]*?return;[\s\S]*?markB4\('product:submit-tap'\);\s*await onSubmit\(answer\)/u,
    'only a non-empty answer check should receive the submit-tap mark',
  );
  assert.match(
    roundScreen,
    /if \(!practice\?\.feedback \|\| typeof requestAnimationFrame !== 'function'\)[\s\S]*?requestAnimationFrame\(\(\) => \{\s*markB4\('product:feedback-painted'\);\s*\}\)/u,
    'feedback paint must be marked from requestAnimationFrame rather than the save promise',
  );
});
