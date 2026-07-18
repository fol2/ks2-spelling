import assert from 'node:assert/strict';
import test from 'node:test';

import {
  B4_CLAIM_LABELS,
  createB4DevelopmentReport,
  validateB4DevelopmentReport,
} from '../src/app/b4-development-report.js';

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
