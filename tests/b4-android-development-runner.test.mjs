import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  acquireB4AndroidRunnerLease,
  combineB4AndroidJourney,
  validateB4AndroidAvdIdentity,
  validateB4AndroidInstrumentationOutput,
  validateB4AndroidLayoutDimensions,
} from '../scripts/prove-b4-android.mjs';

test('the Android runner holds one process-lifetime ownership lease', async (t) => {
  const first = await acquireB4AndroidRunnerLease();
  t.after(() => first.close());
  await assert.rejects(
    acquireB4AndroidRunnerLease(),
    (error) => error?.code === 'b4_android_runner_busy',
  );
  await first.close();

  const successor = await acquireB4AndroidRunnerLease();
  await successor.close();
});

test('the Android runner accepts only its exact launched AVD identity', () => {
  const expected = 'KS2_Spelling_B4_Phone_12345';
  assert.equal(validateB4AndroidAvdIdentity(`${expected}\nOK\n`, expected), expected);
  for (const output of [
    'KS2_Spelling_B4_Phone_99999\nOK\n',
    `${expected}\nforeign\nOK\n`,
    'OK\n',
  ]) {
    assert.throws(
      () => validateB4AndroidAvdIdentity(output, expected),
      (error) => error?.code === 'b4_android_emulator_ownership_lost',
    );
  }
});

test('the Android runner accepts one exact passing instrumentation result only', () => {
  assert.equal(validateB4AndroidInstrumentationOutput(`
Time: 9.013

OK (1 test)

INSTRUMENTATION_CODE: -1
`), 'passed');
  for (const output of ['OK (2 tests)', 'FAILURES!!!\nOK (1 test)', '']) {
    assert.throws(
      () => validateB4AndroidInstrumentationOutput(output),
      (error) => error?.code === 'b4_android_instrumentation_failed',
    );
  }
});

test('the Android runner joins the two process-separated journey phases exactly once', () => {
  const phaseOne = {
    coldLaunchMs: 123,
    audioStartMs: [10, 11],
    answerFeedbackMs: [20, 21, 22],
    minimumControlHeightDp: 49,
    softwareKeyboardObserved: true,
    enterSubmitted: true,
    backgroundAudioStoppedCount: 2,
    resumeProgress: 'Card 2 of 5',
  };
  const phaseTwo = {
    answerFeedbackMs: [23, 24, 25, 26, 27, 28, 29],
    resumeProgressBefore: 'Card 2 of 5',
    resumeProgressAfter: 'Card 2 of 5',
    completed: true,
  };
  assert.deepEqual(combineB4AndroidJourney(phaseOne, phaseTwo), {
    coldLaunchMs: 123,
    audioStartMs: [10, 11],
    answerFeedbackMs: [20, 21, 22, 23, 24, 25, 26, 27, 28, 29],
    minimumControlHeightDp: 49,
    softwareKeyboardObserved: true,
    enterSubmitted: true,
    backgroundAudioStoppedCount: 2,
    resumeProgressBefore: 'Card 2 of 5',
    resumeProgressAfter: 'Card 2 of 5',
    completed: true,
  });
  assert.throws(
    () => combineB4AndroidJourney(phaseOne, {
      ...phaseTwo,
      resumeProgressAfter: 'Card 3 of 5',
    }),
    (error) => error?.code === 'b4_android_journey_invalid',
  );
});

test('the Android runner proves physical portrait and landscape screenshot dimensions', () => {
  assert.throws(
    () => validateB4AndroidLayoutDimensions({
      portrait: { width: 1080, height: 2424 },
      landscape: { width: 1080, height: 2424 },
    }),
    (error) => error?.code === 'b4_android_layout_orientation_invalid',
  );
  assert.deepEqual(validateB4AndroidLayoutDimensions({
    portrait: { width: 1080, height: 2424 },
    landscape: { width: 2424, height: 1080 },
  }), {
    portrait: { width: 1080, height: 2424 },
    landscape: { width: 2424, height: 1080 },
  });
});

test('the bounded Android runner records hosted-image truth and honest emulator limits', async () => {
  const [source, packageJson] = await Promise.all([
    readFile(new URL('../scripts/prove-b4-android.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ]);
  for (const required of [
    'system-images;android-24;google_apis;arm64-v8a',
    'system-images;android-36;google_apis;arm64-v8a',
    'show_ime_with_hard_keyboard',
    'font_scale',
    'waitForApplicationSurface',
    "'uiautomator', 'dump', '/dev/tty'",
    'nativePayloadBytes',
    'localDatabaseBytes',
    'virtual-development-risk-observation',
    'Emulator only; not physical-device, Play-signed distribution or TalkBack evidence.',
    "connect-src 'none'",
    "clientTts: 'none'",
    'acquireB4AndroidRunnerLease',
    "'emu', 'avd', 'name'",
  ]) {
    assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(source, /-no-audio/u);
  assert.match(packageJson, /"prove:b4:android":\s*"node scripts\/prove-b4-android\.mjs"/u);
});
