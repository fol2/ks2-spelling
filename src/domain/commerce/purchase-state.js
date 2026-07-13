export const FULL_KS2_PRODUCT_IDS = Object.freeze([
  'uk.eugnel.ks2spelling.fullks2',
  'full_ks2',
]);

export const FULL_KS2_PACK = Object.freeze({
  entitlementId: 'full-ks2',
  packId: 'b3-sandbox-proof',
  version: '1.0.0-b3.1',
  jobId: 'b3-sandbox-proof.1.0.0-b3.1',
});

export const PURCHASE_CHECKPOINTS = Object.freeze([
  'journal',
  'verify',
  'rejection',
  'mark-verified',
  'entitlement-commit',
  'gateway-completion',
  'store-finish',
  'proof-clear',
  'download-authorisation',
  'download-job',
]);

const AUTHENTICATED_PERMANENT_CODES = new Set([
  'PROOF_REJECTED',
  'PRODUCT_MISMATCH',
  'STORE_TRANSACTION_ID_INVALID',
]);
const DEFINITIVE_MALFORMED_ERRORS = new WeakSet();

export class DefinitiveMalformedSubmittedProofError extends TypeError {
  constructor() {
    super('The submitted store proof is definitively malformed.');
    DEFINITIVE_MALFORMED_ERRORS.add(this);
  }
}

export function classifyGatewayFailure(error) {
  const authenticatedPermanent =
    error instanceof Error &&
    AUTHENTICATED_PERMANENT_CODES.has(error.code) &&
    error.retryable === false &&
    Number.isSafeInteger(error.status) &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 429;
  if (authenticatedPermanent) return 'authenticated-permanent';
  if (error instanceof Error && DEFINITIVE_MALFORMED_ERRORS.has(error)) {
    return 'definitive-malformed-proof';
  }
  return 'recoverable';
}

export function assertApprovedFullKs2ProductId(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== 1 ||
    !Object.hasOwn(value, 'productId') ||
    !Object.getOwnPropertyDescriptor(value, 'productId')?.enumerable ||
    !Object.hasOwn(Object.getOwnPropertyDescriptor(value, 'productId'), 'value') ||
    !FULL_KS2_PRODUCT_IDS.includes(value.productId)
  ) {
    throw new TypeError('A single approved Full KS2 platform product is required.');
  }
  return value.productId;
}
