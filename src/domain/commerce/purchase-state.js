import { PACK_REGISTRY, findPackAuthority } from '../packs/pack-registry.js';

import {
  findStoreProductByEntitlementId,
  mapStoreProductToEntitlement,
} from './commerce-contracts.js';

function packJobFacts(row) {
  return Object.freeze({
    packId: row.packId,
    version: row.version,
    archiveName: row.archiveName,
    manifestSha256: row.manifestSha256,
    manifestBytes: row.manifestBytes,
    manifestEtag: row.manifestEtag,
    archiveSha256: row.archiveSha256,
    archiveBytes: row.archiveBytes,
    archiveEtag: row.archiveEtag,
  });
}

export const B3_PACK_JOB_AUTHORITY = packJobFacts(findPackAuthority('b3-sandbox-proof'));

// The catalogue is the only place an entitlement's store products and packs are named.
// Coordinators bind to one entitlementId and read everything else from here.
export function resolveCommerceProduct(entitlementId) {
  const product = findStoreProductByEntitlementId(entitlementId);
  return Object.freeze({
    entitlementId: product.entitlementId,
    productIds: Object.freeze([product.appleProductId, product.googleProductId]),
    packIds: product.packIds,
  });
}

// Multi-shard resolution: every pack a product delivers must be a registry row
// bound to that product's entitlement, else the download path fails closed.
export function resolvePackJobAuthorities(product, registry = PACK_REGISTRY) {
  if (!Array.isArray(product?.packIds) || product.packIds.length === 0) {
    throw new TypeError('A product must deliver at least one tracked pack.');
  }
  return Object.freeze(product.packIds.map((packId) => {
    const pack = findPackAuthority(packId, registry);
    if (pack.requiredEntitlementId !== product.entitlementId) {
      throw new TypeError('A tracked pack is not bound to the product entitlement.');
    }
    return Object.freeze({
      entitlementId: product.entitlementId,
      packId: pack.packId,
      version: pack.version,
      jobId: `${pack.packId}.${pack.version}`,
    });
  }));
}

// ponytail: [0] is exact while the catalogue sells one pack; the composition
// slices (E2.3/E2.7) replace this single-pack binding when real shards land.
export const FULL_KS2_PACK = resolvePackJobAuthorities(resolveCommerceProduct('full-ks2'))[0];

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

export function assertApprovedProductId(value, approvedProductIds) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== 1 ||
    !Object.hasOwn(value, 'productId') ||
    !Object.getOwnPropertyDescriptor(value, 'productId')?.enumerable ||
    !Object.hasOwn(Object.getOwnPropertyDescriptor(value, 'productId'), 'value') ||
    !approvedProductIds.includes(value.productId)
  ) {
    throw new TypeError('A single approved platform product is required.');
  }
  return value.productId;
}

export function deriveTransactionReplayJournalId(observation) {
  const store = observation?.store;
  const productId = observation?.productId;
  const entitlementId = mapStoreProductToEntitlement({ store, productId });
  const eventKind = {
    pending: 'acquisition',
    purchased: 'acquisition',
    revoked: 'revocation',
  }[observation?.outcome];
  if (!eventKind) throw new TypeError('Purchase replay event kind is invalid.');
  return `purchase-${store}-${entitlementId}-${eventKind}`;
}
