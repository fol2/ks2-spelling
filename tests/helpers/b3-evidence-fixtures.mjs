import {
  B3_ANDROID_SCENARIOS,
  B3_IOS_SCENARIOS,
  B3_SYNTHETIC_LEARNER_AUTHORITY_SHA256,
  B3_SYNTHETIC_LEARNER_DIGESTS,
} from '../../scripts/lib/b3-evidence.mjs';

export const B3_TEST_HASH = 'a'.repeat(64);
export const B3_TEST_COMMIT = 'b'.repeat(40);
const TRACE_IDS = [
  '018f1d7b-97e8-4a52-8cf2-783e5089c001',
  '018f1d7b-97e8-4a52-8cf2-783e5089c002',
  '018f1d7b-97e8-4a52-8cf2-783e5089c003',
  '018f1d7b-97e8-4a52-8cf2-783e5089c004',
  '018f1d7b-97e8-4a52-8cf2-783e5089c005',
  '018f1d7b-97e8-4a52-8cf2-783e5089c006',
];

export function cloudflareEvidence() {
  const object = (role, key, extra = {}) => ({
    role, key, sha256: B3_TEST_HASH, size: 10, etag: 'safe-etag',
    customMetadata: {
      'b3-role': role, 'b3-sha256': B3_TEST_HASH, 'b3-size': '10', ...extra,
    },
  });
  return {
    schemaVersion: 1,
    testedApplicationCommit: B3_TEST_COMMIT,
    applicationFingerprint: B3_TEST_HASH,
    worker: {
      accountId: '6d00cb4a0396c17ad6ba617bcbcaa45d', name: 'ks2-spelling-b3-sandbox',
      publicSandboxOrigin: 'https://b3-gateway.eugnel.uk', deploymentVersionId: 'version-1',
      scriptAuthoritySha256: B3_TEST_HASH, compatibilityDate: '2026-07-12',
      compatibilityFlags: ['nodejs_compat'],
      bindings: { r2: 'PACKS', rateLimit: 'GATEWAY_RATE_LIMIT', versionMetadata: 'WORKER_VERSION_METADATA' },
      requiredSecretNames: ['APPLE_IAP_ISSUER_ID', 'APPLE_IAP_KEY_ID', 'APPLE_IAP_PRIVATE_KEY', 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON', 'ENTITLEMENT_HANDLE_KEY_CURRENT', 'ENTITLEMENT_HANDLE_KEY_PREVIOUS', 'R2_CAPABILITY_HMAC_KEY'],
      remoteSecretNamesVerified: true,
    },
    bucket: { approvedIdentifier: 'ks2-spelling-b3-sandbox-packs', private: true, r2DevPublicAccess: false, customDomains: [] },
    signedEnvelopeSha256: B3_TEST_HASH,
    objects: [
      object('signed-manifest', 'packs/b3-sandbox-proof/1.0.0-b3.1/signed-manifest.json', { 'b3-envelope-sha256': B3_TEST_HASH }),
      object('archive', 'packs/b3-sandbox-proof/1.0.0-b3.1/b3-sandbox-proof.zip'),
    ],
    capability: { ttlSeconds: 600, valid: true, tamperedRejected: true, expiredRejected: true, canonicalEncodingRequired: true },
    range: { full200: true, partial206: true, conditional304: true, unsatisfied416: true, noRedirects: true, cacheControl: 'private, no-store' },
    rateLimit: { everyPublicPostGetCovered: true, limitedStatus: 429, limitedBodyReads: 0, limitedUpstreamCalls: 0, missingBindingFailedClosed: true },
  };
}

export function platformEvidence(platform = 'ios-physical') {
  const ios = platform === 'ios-physical';
  const scenarios = ios ? B3_IOS_SCENARIOS : B3_ANDROID_SCENARIOS;
  let trace = 0;
  const transitions = scenarios.map(({ scenario, outcome, traces }, index) => ({
    scenario,
    startedAt: new Date(Date.UTC(2026, 6, 14, 10, index)).toISOString(),
    completedAt: new Date(Date.UTC(2026, 6, 14, 10, index, 30)).toISOString(),
    outcome,
    gatewayTraces: traces.map(({ operation, relation }) => ({ operation, relation, traceId: TRACE_IDS[trace++] })),
  }));
  const preservation = (scenario, baseline) => ({
    scenario, baseline,
    learnerAInitialSha256: B3_SYNTHETIC_LEARNER_DIGESTS[baseline].learnerA,
    learnerAFinalSha256: B3_SYNTHETIC_LEARNER_DIGESTS[baseline].learnerA,
    learnerBInitialSha256: B3_SYNTHETIC_LEARNER_DIGESTS[baseline].learnerB,
    learnerBFinalSha256: B3_SYNTHETIC_LEARNER_DIGESTS[baseline].learnerB,
  });
  return {
    schemaVersion: 1,
    testedApplicationCommit: B3_TEST_COMMIT,
    applicationFingerprint: B3_TEST_HASH,
    platform,
    device: ios ? { model: 'iPhone 17', osVersion: '26.0', physical: true } : { model: 'Pixel 9', osVersion: '16', physical: true, playCertified: true },
    store: { environment: ios ? 'sandbox' : 'play-test', productId: ios ? 'uk.eugnel.ks2spelling.fullks2' : 'full_ks2', localisedPriceObserved: true },
    transitions,
    storeCompletion: ios ? { finished: true } : { acknowledged: true },
    ...(ios ? { storeKitTest: { reportSha256: B3_TEST_HASH, scenarios: ['storekit-test-pending-approve', 'storekit-test-pending-decline'], liveSandbox: false } } : {}),
    distribution: ios ? {
      embeddedCommit: B3_TEST_COMMIT, embeddedFingerprint: B3_TEST_HASH, versionName: '0.3.0-b3', kind: 'development', iosBuildNumber: '19', signedIpaSha256: B3_TEST_HASH,
      ipaEmbeddedAuthoritySha256: B3_TEST_HASH, codeSigningCertificateSha256: B3_TEST_HASH, installedBundleId: 'uk.eugnel.ks2spelling', installedVersion: '0.3.0-b3', installedBuild: '19', installedEmbeddedAuthoritySha256: B3_TEST_HASH, developmentIdentityVerified: true, sandboxReceiptVerified: true,
    } : {
      embeddedCommit: B3_TEST_COMMIT, embeddedFingerprint: B3_TEST_HASH, versionName: '0.3.0-b3', kind: 'play-internal', androidVersionCode: 19, signedAabSha256: B3_TEST_HASH,
      aabEmbeddedAuthoritySha256: B3_TEST_HASH, playAppSigningCertificateSha256: B3_TEST_HASH, installer: 'com.android.vending', installedEmbeddedAuthoritySha256: B3_TEST_HASH, pmPathOrderVerified: true,
      installedApks: [{ order: 0, kind: 'base', splitName: '', sha256: B3_TEST_HASH }, { order: 1, kind: 'split', splitName: 'config.en', sha256: B3_TEST_HASH }],
    },
    gateway: {
      accountId: '6d00cb4a0396c17ad6ba617bcbcaa45d', workerName: 'ks2-spelling-b3-sandbox', publicSandboxOrigin: 'https://b3-gateway.eugnel.uk', deploymentVersionId: 'version-1', scriptAuthoritySha256: B3_TEST_HASH, signedEnvelopeSha256: B3_TEST_HASH,
      manifestObject: { key: 'packs/b3-sandbox-proof/1.0.0-b3.1/signed-manifest.json', sha256: B3_TEST_HASH, size: 10, etag: 'safe-etag', metadataMatched: true },
      archiveObject: { key: 'packs/b3-sandbox-proof/1.0.0-b3.1/b3-sandbox-proof.zip', sha256: B3_TEST_HASH, size: 10, etag: 'safe-etag', metadataMatched: true },
    },
    transport: { concreteCapacitorStore: true, concreteHttpGateway: true, serverUrl: null, nativeOriginAllowed: true, noRedirects: true },
    storeTransactionAuthority: { source: ios ? 'apple-transaction-id' : 'google-order-id', crossCheckedOnRefresh: true, rawValueCommitted: false },
    refreshHandleLifecycle: { positiveVersionObserved: true, rawProofCleared: true, restoredFreshHandle: true, revokedHandleDeleted: true, rawHandleCommitted: false },
    entitlement: { id: 'full-ks2', finalState: 'revoked', digest: B3_TEST_HASH, refreshHandlePresent: false },
    pack: { packId: 'b3-sandbox-proof', manifestSha256: B3_TEST_HASH, archiveSha256: B3_TEST_HASH, installed: true, redownloaded: true },
    syntheticLearnerAuthoritySha256: B3_SYNTHETIC_LEARNER_AUTHORITY_SHA256,
    learnerPreservation: [preservation('purchase-install', 'before-purchase'), preservation('refund-revoke-after-fresh-install-reseed', 'after-fresh-install-reseed')],
    restore: { freshInstall: true, entitlementRebuilt: true, packRedownloaded: true, learnerBackupRestoreClaimed: false, baselineCreatedAfterFreshInstall: true },
    screenshotSha256: B3_TEST_HASH,
    manualVisualInspection: 'passed',
  };
}
