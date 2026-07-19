import { captureB4AndroidSplitTiming } from './prove-b4-android.mjs';
import { EXIT_CODES, isMain, printJson } from './lib/run-command.mjs';

function investigationError(code, message) {
  return Object.assign(new Error(message), { code });
}

function roundMs(nanoseconds) {
  return Math.round((nanoseconds / 1_000_000) * 1_000) / 1_000;
}

export function createB4AndroidSplitReport(result) {
  const capture = result?.capture;
  if (capture?.schemaVersion !== 1 || capture.completed !== true ||
      !Array.isArray(capture.observations) || capture.observations.length !== 10) {
    throw investigationError(
      'b4_android_split_capture_invalid',
      'The Android split-timing capture is incomplete.',
    );
  }
  const observations = capture.observations.map((observation, index) => {
    const expectedRevision = 2 + (index * 2);
    const values = [
      observation.submitElapsedRealtimeNanos,
      observation.commitObservedElapsedRealtimeNanos,
      observation.audioActiveElapsedRealtimeNanos,
      observation.feedbackVisibleElapsedRealtimeNanos,
      observation.replayToAudioPlayingVisibleMs,
    ];
    if (observation.answerIndex !== index + 1 ||
        observation.expectedRevision !== expectedRevision ||
        !values.every((value) => Number.isFinite(value) && value >= 0) ||
        observation.commitObservedElapsedRealtimeNanos <
          observation.submitElapsedRealtimeNanos ||
        observation.audioActiveElapsedRealtimeNanos <
          observation.commitObservedElapsedRealtimeNanos ||
        observation.feedbackVisibleElapsedRealtimeNanos <
          observation.audioActiveElapsedRealtimeNanos) {
      throw investigationError(
        'b4_android_split_observation_invalid',
        `The Android split-timing observation for answer ${index + 1} is invalid.`,
      );
    }
    return Object.freeze({
      answerIndex: index + 1,
      expectedRevision,
      commandCommitUpperBoundMs: roundMs(
        observation.commitObservedElapsedRealtimeNanos -
          observation.submitElapsedRealtimeNanos,
      ),
      commitObservationToNativeAudioActiveLowerBoundMs: roundMs(
        observation.audioActiveElapsedRealtimeNanos -
          observation.commitObservedElapsedRealtimeNanos,
      ),
      nativeAudioActiveToFeedbackVisibleUpperBoundMs: roundMs(
        observation.feedbackVisibleElapsedRealtimeNanos -
          observation.audioActiveElapsedRealtimeNanos,
      ),
      submitToFeedbackVisibleMs: roundMs(
        observation.feedbackVisibleElapsedRealtimeNanos -
          observation.submitElapsedRealtimeNanos,
      ),
      replayToAudioPlayingAndPublishVisibleMs: Math.round(
        observation.replayToAudioPlayingVisibleMs * 1_000,
      ) / 1_000,
    });
  });
  return Object.freeze({
    ok: true,
    schemaVersion: 1,
    platform: 'android-emulator',
    splitKind: 'native-playback-bound',
    runner: Object.freeze({
      runtime: `Android ${result.device.release} / API ${result.device.api} (${result.device.build})`,
      deviceProfile: `${result.device.model}; ${result.device.abi}; ${result.device.requestedDevice}`,
      buildConfiguration: 'B4Development debug APK and Android instrumentation APK',
    }),
    observations,
    limitations: Object.freeze([
      'Emulator only; not physical-device or Play-signed distribution evidence.',
      'SQLite polling records an upper bound on command commit and includes polling latency.',
      'The controlled emulator must have no active native player before submission; unprivileged AudioManager callbacks do not expose an attributable player identifier.',
      'AudioManager reports the Chromium native player becoming active, not the later HTML audio playing callback itself.',
      'The native-audio-to-feedback interval includes JavaScript event delivery, controller publish, WebView render and accessibility observation latency.',
    ]),
  });
}

export async function run() {
  return createB4AndroidSplitReport(await captureB4AndroidSplitTiming());
}

export async function main() {
  try {
    printJson(await run());
    return EXIT_CODES.success;
  } catch (error) {
    printJson({
      ok: false,
      code: error.code ?? 'b4_android_split_investigation_failed',
      message: error.message,
    }, process.stderr);
    return EXIT_CODES.commandFailed;
  }
}

if (isMain(import.meta.url)) process.exitCode = await main();
