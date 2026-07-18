import { B4_PRODUCT_IDENTIFIER } from './b4-round-contract.js';

export const B4_CLAIM_LABELS = Object.freeze([
  'pass',
  'investigation-required',
  'incomplete',
  'webview-ceiling',
]);

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
