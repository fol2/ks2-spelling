import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assembleB4PhysicalReport,
  B4_PHYSICAL_LIMITATIONS,
} from '../scripts/prove-b4-ios-physical.mjs';
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
  answerFeedbackMs,
  audioStartMs,
  completed = true,
} = {}) {
  return {
    schemaVersion: 1,
    coldLaunchMs,
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
    runner: RUNNER,
    applicationCheckpoint: CHECKPOINT,
    ...overrides,
  });
}

test('synthetic physical input produces the ios-physical evidence schema', () => {
  const report = assemble();

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.platform, 'ios-physical');
  assert.deepEqual(report.coldLaunchSeriesMs, [1_500.4, 1_800.6, 1_700.2]);
  assert.equal(report.coldLaunchSeriesMs.length, 3);
  assert.deepEqual(Object.keys(report.comparators).sort(), [
    'answerFeedback',
    'audioStart',
    'coldLaunch',
    'sqliteTransactionUpperBound',
  ]);
  assert.deepEqual(report.limitations, B4_PHYSICAL_LIMITATIONS);
  assert.equal(report.limitations.length, 2);
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
    inside.comparators.coldLaunch.thresholdMs,
    B4_RISK_OBSERVATION_SPECS.coldLaunch.threshold,
  );
  assert.equal(
    inside.comparators.answerFeedback.thresholdMs,
    B4_RISK_OBSERVATION_SPECS.answerFeedback.threshold,
  );
  assert.equal(
    inside.comparators.sqliteTransactionUpperBound.thresholdMs,
    B4_RISK_OBSERVATION_SPECS.sqliteTransactionUpperBound.threshold,
  );
  assert.equal(
    inside.comparators.audioStart.thresholdMs,
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
