import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assembleB4PhysicalReport,
  B4_PHYSICAL_LIMITATIONS,
} from '../scripts/prove-b4-ios-physical.mjs';
import {
  PHYSICAL_FLOOR_COMPARATOR_KINDS,
  PHYSICAL_FLOOR_REPORT_SCHEMA_VERSION,
  unmeasuredFrameRateCapture,
  unmeasuredMemoryCapture,
} from '../scripts/lib/ios-floor-device-gate.mjs';
import { B4_RISK_OBSERVATION_SPECS } from '../src/app/b4-development-report.js';

const RUNNER = Object.freeze({
  hostOS: 'macOS 27.0 (26A5378n)',
  xcodeVersion: '26.6 (17F109)',
  sdk: 'iphoneos26.5',
  deviceModel: 'iPhone 16 Pro Max',
  deviceOsVersion: '27.0',
  buildConfiguration: 'Release',
  reality: 'physical',
});

const CHECKPOINT = Object.freeze({
  commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  tree: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
});

function journey({
  coldLaunchMs,
  timeToInteractiveMs,
  answerFeedbackMs,
  audioStartMs,
  completed = true,
} = {}) {
  return {
    schemaVersion: 1,
    coldLaunchMs,
    timeToInteractiveMs: timeToInteractiveMs ?? coldLaunchMs,
    answerFeedbackMs,
    audioStartMs,
    minimumControlHeightPoints: 49,
    referenceTextHeightPoints: 23,
    softwareKeyboardObserved: true,
    enterSubmitted: true,
    backgroundAudioStoppedCount: 2,
    resumeProgressBefore: 'Card 2 of 5',
    resumeProgressAfter: 'Card 2 of 5',
    completed,
  };
}

function splitCapture(observations = Array.from({ length: 10 }, (_, index) => ({
  answerIndex: index + 1,
  expectedRevision: 2 + (index * 2),
  submitEpochMs: 1_000 + index,
  audioPlayingVisibleEpochMs: -1,
  feedbackVisibleEpochMs: 1_100 + index,
  replayToAudioPlayingVisibleMs: 300 + index,
}))) {
  return {
    schemaVersion: 1,
    clock: 'Unix epoch milliseconds',
    observations,
    completed: true,
  };
}

function assemble(overrides = {}) {
  return assembleB4PhysicalReport({
    journeyObservations: [
      journey({
        coldLaunchMs: 1_500.4,
        answerFeedbackMs: Array(10).fill(40),
        audioStartMs: [200, 180],
      }),
      journey({
        coldLaunchMs: 1_800.6,
        answerFeedbackMs: Array(10).fill(45),
        audioStartMs: [210, 190],
      }),
      journey({
        coldLaunchMs: 1_700.2,
        answerFeedbackMs: Array(10).fill(42),
        audioStartMs: [205, 185],
      }),
    ],
    splitCapture: splitCapture(),
    isolatedSqliteMaxMs: 29.454,
    frameRate: unmeasuredFrameRateCapture(),
    memory: unmeasuredMemoryCapture(),
    runner: RUNNER,
    applicationCheckpoint: CHECKPOINT,
    ...overrides,
  });
}

test('synthetic physical input produces the ios-physical evidence schema', () => {
  const report = assemble();

  assert.equal(report.schemaVersion, PHYSICAL_FLOOR_REPORT_SCHEMA_VERSION);
  assert.equal(report.platform, 'ios-physical');
  assert.deepEqual(report.coldLaunchSeriesMs, [1_500.4, 1_800.6, 1_700.2]);
  assert.equal(report.coldLaunchSeriesMs.length, 3);
  assert.deepEqual(report.timeToInteractiveSeriesMs, [1_500.4, 1_800.6, 1_700.2]);
  assert.deepEqual(Object.keys(report.comparators).sort(), [...PHYSICAL_FLOOR_COMPARATOR_KINDS].sort());
  assert.deepEqual(report.limitations, B4_PHYSICAL_LIMITATIONS);
  assert.equal(report.limitations.length, 4);
  assert.equal(report.comparators.timeToInteractive.recorded, true);
  assert.equal(report.comparators.timeToInteractive.within, false);
  assert.equal(report.comparators.timeToInteractive.thresholdStatus, 'pending-owner-adjudication');
  assert.equal(report.comparators.frameRate.recorded, false);
  assert.equal(report.comparators.frameRate.within, false);
  assert.equal(report.comparators.frameRate.questionCardDroppedFramesWithin, false);
  assert.equal(report.comparators.memory.recorded, false);
  assert.equal(report.comparators.memory.within, false);
  assert.equal(report.runner.reality, 'physical');
  assert.equal(report.runner.buildConfiguration, 'Release');
  assert.equal(report.runner.sdk, 'iphoneos26.5');
  assert.equal(report.journeys.default.completed, true);
  assert.equal(report.repeatJourneys.length, 2);
  assert.equal(report.splitTimings.observations.length, 10);
  assert.equal(report.isolatedSqlite.maxTransactionMs, 29.454);
  assert.deepEqual(report.applicationCheckpoint, CHECKPOINT);
});

test('physical comparators honour the frozen section-18 thresholds at the boundary', () => {
  const inside = assemble({
    journeyObservations: [
      journey({
        coldLaunchMs: B4_RISK_OBSERVATION_SPECS.coldLaunch.threshold,
        answerFeedbackMs: Array(10).fill(B4_RISK_OBSERVATION_SPECS.answerFeedback.threshold),
        audioStartMs: [
          B4_RISK_OBSERVATION_SPECS.audioStart.threshold,
          B4_RISK_OBSERVATION_SPECS.audioStart.threshold,
        ],
      }),
      journey({
        coldLaunchMs: B4_RISK_OBSERVATION_SPECS.coldLaunch.threshold,
        answerFeedbackMs: Array(10).fill(1),
        audioStartMs: [1, 1],
      }),
      journey({
        coldLaunchMs: B4_RISK_OBSERVATION_SPECS.coldLaunch.threshold,
        answerFeedbackMs: Array(10).fill(1),
        audioStartMs: [1, 1],
      }),
    ],
    isolatedSqliteMaxMs: B4_RISK_OBSERVATION_SPECS.sqliteTransactionUpperBound.threshold,
  });
  assert.equal(inside.comparators.coldLaunch.within, true);
  assert.equal(inside.comparators.answerFeedback.within, true);
  assert.equal(inside.comparators.sqliteTransactionUpperBound.within, true);
  assert.equal(inside.comparators.audioStart.within, true);
  assert.equal(
    inside.comparators.coldLaunch.threshold,
    B4_RISK_OBSERVATION_SPECS.coldLaunch.threshold,
  );
  assert.equal(
    inside.comparators.answerFeedback.threshold,
    B4_RISK_OBSERVATION_SPECS.answerFeedback.threshold,
  );
  assert.equal(
    inside.comparators.sqliteTransactionUpperBound.threshold,
    B4_RISK_OBSERVATION_SPECS.sqliteTransactionUpperBound.threshold,
  );
  assert.equal(
    inside.comparators.audioStart.threshold,
    B4_RISK_OBSERVATION_SPECS.audioStart.threshold,
  );

  const outside = assemble({
    journeyObservations: [
      journey({
        coldLaunchMs: B4_RISK_OBSERVATION_SPECS.coldLaunch.threshold + 0.001,
        answerFeedbackMs: Array(10).fill(
          B4_RISK_OBSERVATION_SPECS.answerFeedback.threshold + 0.001,
        ),
        audioStartMs: [
          B4_RISK_OBSERVATION_SPECS.audioStart.threshold + 0.001,
          1,
        ],
      }),
      journey({
        coldLaunchMs: 1,
        answerFeedbackMs: Array(10).fill(1),
        audioStartMs: [1, 1],
      }),
      journey({
        coldLaunchMs: 1,
        answerFeedbackMs: Array(10).fill(1),
        audioStartMs: [1, 1],
      }),
    ],
    isolatedSqliteMaxMs:
      B4_RISK_OBSERVATION_SPECS.sqliteTransactionUpperBound.threshold + 0.001,
  });
  assert.equal(outside.comparators.coldLaunch.within, false);
  assert.equal(outside.comparators.answerFeedback.within, false);
  assert.equal(outside.comparators.sqliteTransactionUpperBound.within, false);
  assert.equal(outside.comparators.audioStart.within, false);
});

test('comparators take the worst value across every journey run', () => {
  const tailSpike = assemble({
    journeyObservations: [
      journey({
        coldLaunchMs: 1_000,
        answerFeedbackMs: Array(10).fill(1),
        audioStartMs: [1, 1],
      }),
      journey({
        coldLaunchMs: 1_000,
        answerFeedbackMs: Array(10).fill(1),
        audioStartMs: [1, 1],
      }),
      journey({
        coldLaunchMs: 1_000,
        answerFeedbackMs: [
          ...Array(9).fill(1),
          B4_RISK_OBSERVATION_SPECS.answerFeedback.threshold + 500,
        ],
        audioStartMs: [1, B4_RISK_OBSERVATION_SPECS.audioStart.threshold + 500],
      }),
    ],
  });
  assert.equal(tailSpike.comparators.answerFeedback.within, false);
  assert.equal(
    tailSpike.comparators.answerFeedback.observedMs,
    B4_RISK_OBSERVATION_SPECS.answerFeedback.threshold + 500,
  );
  assert.equal(tailSpike.comparators.audioStart.within, false);
  assert.equal(
    tailSpike.comparators.audioStart.observedMs,
    B4_RISK_OBSERVATION_SPECS.audioStart.threshold + 500,
  );
});

test('assembleB4PhysicalReport rejects an incomplete journey capture', () => {
  assert.throws(
    () => assemble({
      journeyObservations: [
        journey({
          coldLaunchMs: 1_000,
          answerFeedbackMs: Array(10).fill(40),
          audioStartMs: [200, 180],
          completed: false,
        }),
        journey({
          coldLaunchMs: 1_000,
          answerFeedbackMs: Array(10).fill(40),
          audioStartMs: [200, 180],
        }),
        journey({
          coldLaunchMs: 1_000,
          answerFeedbackMs: Array(10).fill(40),
          audioStartMs: [200, 180],
        }),
      ],
    }),
    (error) => error?.code === 'b4_ios_physical_journey_incomplete',
  );
});

test('assembleB4PhysicalReport fails closed when time-to-interactive is absent', () => {
  const observations = [
    journey({
      coldLaunchMs: 1_000,
      answerFeedbackMs: Array(10).fill(40),
      audioStartMs: [200, 180],
    }),
    journey({
      coldLaunchMs: 1_000,
      answerFeedbackMs: Array(10).fill(40),
      audioStartMs: [200, 180],
    }),
    journey({
      coldLaunchMs: 1_000,
      answerFeedbackMs: Array(10).fill(40),
      audioStartMs: [200, 180],
    }),
  ];
  delete observations[0].timeToInteractiveMs;
  assert.throws(
    () => assemble({ journeyObservations: observations }),
    (error) => error?.code === 'b4_ios_physical_time_to_interactive_unmeasured',
  );
});

test('measured TTI, frame rate and memory stay pending and never score GREEN', () => {
  const report = assemble({
    frameRate: {
      questionCardDroppedFrames: 0,
      riskSurfaces: {
        codexZoomMonsterStage: { observedFps: 60 },
        celebrationTier: { observedFps: 60 },
        ambientBackdropPan: { observedFps: 60 },
      },
    },
    memory: { peakBytes: 80 * 1024 * 1024 },
  });
  assert.equal(report.comparators.timeToInteractive.threshold, null);
  assert.equal(report.comparators.timeToInteractive.thresholdStatus, 'pending-owner-adjudication');
  assert.equal(report.comparators.timeToInteractive.within, false);
  assert.equal(report.comparators.frameRate.recorded, true);
  assert.equal(report.comparators.frameRate.questionCardDroppedFramesWithin, true);
  assert.equal(report.comparators.frameRate.threshold, null);
  assert.equal(report.comparators.frameRate.within, false);
  assert.equal(report.comparators.memory.recorded, true);
  assert.equal(report.comparators.memory.threshold, null);
  assert.equal(report.comparators.memory.within, false);
});

test('a dropped frame during a question card fails that clause even before an fps threshold exists', () => {
  const report = assemble({
    frameRate: {
      questionCardDroppedFrames: 1,
      riskSurfaces: {
        codexZoomMonsterStage: { observedFps: 60 },
        celebrationTier: { observedFps: 60 },
        ambientBackdropPan: { observedFps: 60 },
      },
    },
    memory: { peakBytes: 1 },
  });
  assert.equal(report.comparators.frameRate.questionCardDroppedFramesWithin, false);
  assert.equal(report.comparators.frameRate.within, false);
});

test('unknown frame-rate risk surfaces fail closed', () => {
  assert.throws(
    () => assemble({
      frameRate: {
        questionCardDroppedFrames: 0,
        riskSurfaces: {
          otherSurface: { observedFps: 60 },
        },
      },
    }),
    (error) => error?.code === 'b4_ios_physical_frame_rate_risk_surfaces_invalid',
  );
});
