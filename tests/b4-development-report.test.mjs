import assert from 'node:assert/strict';
import test from 'node:test';

import {
  B4_CLAIM_LABELS,
  B4_RISK_OBSERVATION_SPECS,
  createB4DevelopmentReport,
  createB4PlatformRiskReport,
  validateB4DevelopmentReport,
  validateB4PlatformRiskReport,
} from '../src/app/b4-development-report.js';

const runner = Object.freeze({
  runnerImage: 'macos-26',
  hostOS: 'macOS 26.0',
  runtime: 'iOS 26.5 Simulator',
  deviceProfile: 'iPhone 17',
  buildConfiguration: 'B4Development unsigned Simulator',
});

const raw = Object.freeze({
  coldLaunchMs: 900,
  answerFeedbackMs: Object.freeze([35, 34, 36, 35, 33, 31, 32, 36, 34, 33]),
  audioStartMs: Object.freeze([90, 110]),
  nativePayloadBytes: 25_000_000,
  localDatabaseBytes: 500_000,
});

test('B4 Task 1 report stays shallow and uses only development claim labels', () => {
  assert.deepEqual(B4_CLAIM_LABELS, [
    'pass',
    'investigation-required',
    'incomplete',
    'webview-ceiling',
  ]);
  const report = createB4DevelopmentReport({
    composition: 'pass',
    deterministicRound: 'pass',
    rehydration: 'pass',
    audioAuthority: 'incomplete',
  });
  assert.deepEqual(validateB4DevelopmentReport(report), report);
  assert.deepEqual(Object.keys(report), [
    'schemaVersion',
    'productIdentifier',
    'claims',
    'technicalOutcome',
  ]);
  assert.equal(report.technicalOutcome, 'incomplete');
  assert.doesNotMatch(JSON.stringify(report), /Gate B|store|cloud|device|GO|NO_GO/u);
});

test('B4 report rejects future decisions and unknown labels', () => {
  assert.throws(
    () => createB4DevelopmentReport({ composition: 'go' }),
    (error) => error?.code === 'b4_development_report_invalid',
  );
  assert.throws(
    () => validateB4DevelopmentReport({ gateBDecision: 'GO' }),
    (error) => error?.code === 'b4_development_report_invalid',
  );
});

test('platform risk report keeps complete raw journey facts beside frozen comparators', () => {
  assert.deepEqual(B4_RISK_OBSERVATION_SPECS, {
    coldLaunch: { count: 1, unit: 'ms', threshold: 2_000 },
    answerFeedback: { count: 10, unit: 'ms', threshold: 100 },
    sqliteTransactionUpperBound: { count: 10, unit: 'ms', threshold: 50 },
    audioStart: { count: 2, unit: 'ms', threshold: 250 },
    nativePayload: { count: 1, unit: 'bytes', threshold: 120 * 1024 * 1024 },
    localDatabase: { count: 1, unit: 'bytes', threshold: 20 * 1024 * 1024 },
  });
  const report = createB4PlatformRiskReport({
    platform: 'ios-simulator',
    runner,
    raw,
  });
  assert.deepEqual(validateB4PlatformRiskReport(report), report);
  assert.equal(report.observations.length, 25);
  assert.equal(report.technicalOutcome, 'pass');
  assert.equal(report.observations[0].label, 'B4 control risk observation; not profile-picker certification');
  assert.equal(
    report.observations.find(({ kind }) => kind === 'sqliteTransactionUpperBound').label,
    'submit-to-feedback upper bound; not isolated SQLite timing certification',
  );
  assert.match(JSON.stringify(report), /not compressed store download/u);
  assert.match(JSON.stringify(report), /not compacted backup\.sqlite/u);
  assert.match(JSON.stringify(report), /not p95 certification/u);
  assert.doesNotMatch(JSON.stringify(report), /physical-reference-certified|store-ready/u);
});

test('platform risk report marks breaches for investigation and missing facts incomplete', () => {
  const breach = createB4PlatformRiskReport({
    platform: 'android-emulator',
    runner: { ...runner, runnerImage: 'ubuntu-24.04', runtime: 'Android 36 arm64 emulator' },
    raw: { ...raw, audioStartMs: [251, 110] },
  });
  assert.equal(breach.technicalOutcome, 'investigation-required');
  assert.equal(
    breach.observations.find(({ rawValue }) => rawValue === 251).result,
    'investigation-required',
  );

  const incomplete = createB4PlatformRiskReport({
    platform: 'ios-simulator',
    runner,
    raw: { ...raw, answerFeedbackMs: raw.answerFeedbackMs.slice(0, 9) },
  });
  assert.equal(incomplete.technicalOutcome, 'incomplete');
  assert.equal(incomplete.observations.filter(({ rawValue }) => rawValue === null).length, 2);
});

test('platform risk report rejects relabelled, forged or malformed observations', () => {
  const report = createB4PlatformRiskReport({ platform: 'ios-simulator', runner, raw });
  const mutations = [
    (value) => { value.observations[0].comparator.threshold = 9_999; },
    (value) => { value.observations[0].label = 'certified'; },
    (value) => { value.observations[0].result = 'investigation-required'; },
    (value) => { value.technicalOutcome = 'webview-ceiling'; },
    (value) => { value.runner.deviceAccount = 'private'; },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(report);
    mutate(candidate);
    assert.throws(
      () => validateB4PlatformRiskReport(candidate),
      (error) => error?.code === 'b4_platform_risk_report_invalid',
    );
  }
});
