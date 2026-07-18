import { B4_PRODUCT_IDENTIFIER } from './b4-round-contract.js';

export const B4_CLAIM_LABELS = Object.freeze([
  'pass',
  'investigation-required',
  'incomplete',
  'webview-ceiling',
]);

const RISK_SOURCE = 'frozen source design section 18';
const RISK_RUNNER_KEYS = Object.freeze([
  'runnerImage',
  'hostOS',
  'runtime',
  'deviceProfile',
  'buildConfiguration',
]);
const RISK_RAW_KEYS = Object.freeze([
  'coldLaunchMs',
  'answerFeedbackMs',
  'audioStartMs',
  'nativePayloadBytes',
  'localDatabaseBytes',
]);
const RISK_DEFINITIONS = Object.freeze([
  Object.freeze({
    kind: 'coldLaunch', rawKey: 'coldLaunchMs', count: 1, unit: 'ms', threshold: 2_000,
    label: 'B4 control risk observation; not profile-picker certification',
  }),
  Object.freeze({
    kind: 'answerFeedback', rawKey: 'answerFeedbackMs', count: 10, unit: 'ms', threshold: 100,
    label: 'submit-to-render raw observation; not p95 certification',
  }),
  Object.freeze({
    kind: 'sqliteTransactionUpperBound', rawKey: 'answerFeedbackMs', count: 10, unit: 'ms', threshold: 50,
    label: 'submit-to-feedback upper bound; not isolated SQLite timing certification',
  }),
  Object.freeze({
    kind: 'audioStart', rawKey: 'audioStartMs', count: 2, unit: 'ms', threshold: 250,
    label: 'fresh local player to visible playing; not p95 certification',
  }),
  Object.freeze({
    kind: 'nativePayload', rawKey: 'nativePayloadBytes', count: 1, unit: 'bytes', threshold: 120 * 1024 * 1024,
    label: 'raw unsigned native payload; not compressed store download',
  }),
  Object.freeze({
    kind: 'localDatabase', rawKey: 'localDatabaseBytes', count: 1, unit: 'bytes', threshold: 20 * 1024 * 1024,
    label: 'raw local database; not compacted backup.sqlite',
  }),
]);

export const B4_RISK_OBSERVATION_SPECS = Object.freeze(Object.fromEntries(
  RISK_DEFINITIONS.map(({ kind, count, unit, threshold }) => [
    kind,
    Object.freeze({ count, unit, threshold }),
  ]),
));

const CLAIM_KEYS = Object.freeze([
  'composition',
  'deterministicRound',
  'rehydration',
  'audioAuthority',
]);

function reportError() {
  const error = new Error('B4 development report is invalid.');
  error.code = 'b4_development_report_invalid';
  return error;
}

function platformReportError() {
  const error = new Error('B4 platform risk report is invalid.');
  error.code = 'b4_platform_risk_report_invalid';
  return error;
}

function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  return plainRecord(value) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function technicalOutcome(claims) {
  const labels = Object.values(claims);
  if (labels.includes('webview-ceiling')) return 'webview-ceiling';
  if (labels.includes('incomplete')) return 'incomplete';
  if (labels.includes('investigation-required')) return 'investigation-required';
  return 'pass';
}

function observationResult(rawValue, threshold) {
  if (rawValue === null) return 'incomplete';
  return rawValue <= threshold ? 'pass' : 'investigation-required';
}

function platformTechnicalOutcome(observations) {
  const results = observations.map(({ result }) => result);
  if (results.includes('incomplete')) return 'incomplete';
  if (results.includes('investigation-required')) return 'investigation-required';
  return 'pass';
}

function normaliseRawSeries(value, count) {
  if (count === 1) {
    return [Number.isFinite(value) && value >= 0 ? value : null];
  }
  if (value !== undefined && !Array.isArray(value)) return Array(count).fill(null);
  if (Array.isArray(value) && value.length > count) throw platformReportError();
  return Array.from({ length: count }, (_, index) => {
    const item = value?.[index];
    return Number.isFinite(item) && item >= 0 ? item : null;
  });
}

function createRiskObservations(raw) {
  const observations = [];
  for (const definition of RISK_DEFINITIONS) {
    const values = normaliseRawSeries(raw?.[definition.rawKey], definition.count);
    for (const [index, rawValue] of values.entries()) {
      observations.push({
        kind: definition.kind,
        sequence: index + 1,
        rawValue,
        unit: definition.unit,
        comparator: {
          operator: 'less-than-or-equal',
          threshold: definition.threshold,
          unit: definition.unit,
          source: RISK_SOURCE,
        },
        label: definition.label,
        result: observationResult(rawValue, definition.threshold),
      });
    }
  }
  return observations;
}

export function validateB4DevelopmentReport(value) {
  if (!exactKeys(value, [
    'schemaVersion',
    'productIdentifier',
    'claims',
    'technicalOutcome',
  ]) || value.schemaVersion !== 1 ||
    value.productIdentifier !== B4_PRODUCT_IDENTIFIER ||
    !exactKeys(value.claims, CLAIM_KEYS) ||
    !Object.values(value.claims).every((label) => B4_CLAIM_LABELS.includes(label)) ||
    value.technicalOutcome !== technicalOutcome(value.claims)) {
    throw reportError();
  }
  return structuredClone(value);
}

export function createB4DevelopmentReport(claims) {
  if (!exactKeys(claims, CLAIM_KEYS)) throw reportError();
  return validateB4DevelopmentReport({
    schemaVersion: 1,
    productIdentifier: B4_PRODUCT_IDENTIFIER,
    claims: structuredClone(claims),
    technicalOutcome: technicalOutcome(claims),
  });
}

export function validateB4PlatformRiskReport(value) {
  if (!exactKeys(value, [
    'schemaVersion',
    'productIdentifier',
    'evidenceClass',
    'platform',
    'runner',
    'observations',
    'technicalOutcome',
  ]) || value.schemaVersion !== 1 ||
    value.productIdentifier !== B4_PRODUCT_IDENTIFIER ||
    value.evidenceClass !== 'virtual-development-risk-observation' ||
    !['ios-simulator', 'android-emulator'].includes(value.platform) ||
    !exactKeys(value.runner, RISK_RUNNER_KEYS) ||
    !RISK_RUNNER_KEYS.every((key) => typeof value.runner[key] === 'string' && value.runner[key].length > 0) ||
    !Array.isArray(value.observations)) {
    throw platformReportError();
  }

  const expected = createRiskObservations(Object.fromEntries(
    RISK_RAW_KEYS.map((key) => [key, undefined]),
  ));
  if (value.observations.length !== expected.length) throw platformReportError();
  for (const [index, observation] of value.observations.entries()) {
    const definition = expected[index];
    if (!exactKeys(observation, [
      'kind', 'sequence', 'rawValue', 'unit', 'comparator', 'label', 'result',
    ]) || observation.kind !== definition.kind ||
      observation.sequence !== definition.sequence ||
      observation.unit !== definition.unit ||
      observation.label !== definition.label ||
      !exactKeys(observation.comparator, ['operator', 'threshold', 'unit', 'source']) ||
      observation.comparator.operator !== definition.comparator.operator ||
      observation.comparator.threshold !== definition.comparator.threshold ||
      observation.comparator.unit !== definition.comparator.unit ||
      observation.comparator.source !== definition.comparator.source ||
      !(observation.rawValue === null || (
        Number.isFinite(observation.rawValue) && observation.rawValue >= 0
      )) || observation.result !== observationResult(
        observation.rawValue,
        definition.comparator.threshold,
      )) {
      throw platformReportError();
    }
  }
  if (value.technicalOutcome !== platformTechnicalOutcome(value.observations)) {
    throw platformReportError();
  }
  return structuredClone(value);
}

export function createB4PlatformRiskReport({ platform, runner, raw = {} }) {
  if (!plainRecord(raw) || Reflect.ownKeys(raw).some((key) => !RISK_RAW_KEYS.includes(key))) {
    throw platformReportError();
  }
  const observations = createRiskObservations(raw);
  return validateB4PlatformRiskReport({
    schemaVersion: 1,
    productIdentifier: B4_PRODUCT_IDENTIFIER,
    evidenceClass: 'virtual-development-risk-observation',
    platform,
    runner: structuredClone(runner),
    observations,
    technicalOutcome: platformTechnicalOutcome(observations),
  });
}
