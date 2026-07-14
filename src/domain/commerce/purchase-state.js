import packObjectAuthority from '../../../config/b3-pack-object-authority.json' with { type: 'json' };

import { mapStoreProductToEntitlement } from './commerce-contracts.js';

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

function readPackObjectAuthority(value) {
  const archive = value?.objects?.find?.((entry) => entry?.role === 'archive');
  const manifest = value?.objects?.find?.((entry) => entry?.role === 'signed-manifest');
  const valid =
    value?.schemaVersion === 1 &&
    value?.packId === FULL_KS2_PACK.packId &&
    value?.version === FULL_KS2_PACK.version &&
    Array.isArray(value?.objects) &&
    value.objects.length === 2 &&
    archive &&
    manifest &&
    archive.key === 'packs/b3-sandbox-proof/1.0.0-b3.1/b3-sandbox-proof.zip' &&
    manifest.key === 'packs/b3-sandbox-proof/1.0.0-b3.1/signed-manifest.json' &&
    Number.isSafeInteger(archive.bytes) &&
    archive.bytes > 0 &&
    /^[a-f0-9]{64}$/.test(archive.sha256) &&
    /^[a-f0-9]{32}$/.test(archive.etag) &&
    Number.isSafeInteger(manifest.bytes) &&
    manifest.bytes > 0 &&
    /^[a-f0-9]{64}$/.test(manifest.sha256) &&
    /^[a-f0-9]{32}$/.test(manifest.etag);
  if (!valid) throw new TypeError('B3 pack object authority is invalid.');
  return Object.freeze({
    packId: value.packId,
    version: value.version,
    archiveName: 'b3-sandbox-proof.zip',
    manifestSha256: manifest.sha256,
    manifestBytes: manifest.bytes,
    manifestEtag: manifest.etag,
    archiveSha256: archive.sha256,
    archiveBytes: archive.bytes,
    archiveEtag: archive.etag,
  });
}

export const B3_PACK_JOB_AUTHORITY = readPackObjectAuthority(packObjectAuthority);

export const PURCHASE_CHECKPOINTS = Object.freeze([
  'journal',
  'attempt-discard',
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

export function deriveTransactionReplayJournalId(observation) {
  const store = observation?.store;
  const productId = observation?.productId;
  mapStoreProductToEntitlement({ store, productId });
  const eventKind = {
    pending: 'acquisition',
    purchased: 'acquisition',
    revoked: 'revocation',
  }[observation?.outcome];
  if (!eventKind) throw new TypeError('Purchase replay event kind is invalid.');
  return `purchase-${store}-full-ks2-${eventKind}`;
}
