import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertB3ProofProjectionPrivacy,
  canonicaliseB3ProofValue,
} from '../src/app/b3-live-proof-protocol.js';

const HASH = 'a'.repeat(64);

function projection() {
  return {
    challengeSha256: HASH,
    scenarioOutcome: 'verified-active',
    entitlementState: 'active',
    packState: 'installed',
    storeCompletionObserved: true,
    storeEvents: [{ operation: 'purchase', outcome: 'purchased' }],
    storeAuthority: {
      environment: 'sandbox',
      productId: 'uk.eugnel.ks2spelling.fullks2',
      localisedPriceObserved: true,
      completionState: 'finished',
    },
    gatewayCalls: [{
      operation: 'verify',
      relation: 'transaction-verification',
      traceId: '018f1d7b-97e8-4a52-8cf2-783e5089c001',
    }],
    gatewaySmokeAuthority: null,
    syntheticLearners: {
      syntheticAuthorityMatched: true,
      positionalSnapshotSha256: [HASH, 'b'.repeat(64)],
    },
    transactionAuthority: {
      source: 'apple-transaction-id',
      crossCheckedOnRefresh: true,
      domainSeparatedDigestSha256: 'c'.repeat(64),
      rawProofCleared: true,
    },
    refreshHandleLifecycle: {
      present: true,
      positiveVersionObserved: true,
      rotated: true,
      deleted: false,
    },
    entitlementAuthority: {
      id: 'full-ks2',
      state: 'active',
      domainSeparatedDigestSha256: 'd'.repeat(64),
      refreshHandlePresent: true,
    },
    packAuthority: {
      packId: 'b3-sandbox-proof',
      manifestSha256: 'e'.repeat(64),
      archiveSha256: 'f'.repeat(64),
      installed: true,
    },
    transportAuthority: {
      storeAdapter: 'concreteCapacitorStore',
      gatewayAdapter: 'concreteHttpGateway',
      serverUrl: null,
      nativeOriginAllowed: true,
      noRedirects: true,
    },
  };
}

function gatewaySmokeAuthority() {
  return {
    schemaVersion: 1,
    deploymentVersionId: 'a8f32f60-16b9-4ca6-9b4a-f771dd5302f7',
    scriptAuthoritySha256: HASH,
    signedEnvelopeSha256: 'b'.repeat(64),
    objects: [
      {
        role: 'signed-manifest',
        key: 'packs/b3-sandbox-proof/1.0.0-b3.1/signed-manifest.json',
        sha256: 'b'.repeat(64),
        size: 1_135,
        etag: 'c76b2858b8345814279a1c92ae64e365',
      },
      {
        role: 'archive',
        key: 'packs/b3-sandbox-proof/1.0.0-b3.1/b3-sandbox-proof.zip',
        sha256: 'c'.repeat(64),
        size: 1_324,
        etag: '913d2b2485ca6cd31d467bd7228d7e75',
      },
    ],
    accessBehaviour: {
      ttlSeconds: 600,
      valid: true,
      tamperedRejected: true,
      expiredRejected: true,
      canonicalEncodingRequired: true,
    },
    byteServingBehaviour: {
      full200: true,
      partial206: true,
      conditional304: true,
      unsatisfied416: true,
      noRedirects: true,
      cacheControl: 'private, no-store',
    },
  };
}

test('proof projection exports only positional learner and domain-separated transaction digests', () => {
  assert.deepEqual(assertB3ProofProjectionPrivacy(projection()), projection());
  const canonical = canonicaliseB3ProofValue(projection());
  assert.doesNotMatch(
    canonical,
    /"Ada"|"Ben"|learner-|nickname|GPA\.|"transactionId"/iu,
  );
});

test('nested keys and values cannot smuggle prohibited proof or identity material', () => {
  const smuggles = [
    ['purchaseToken', 'digest'],
    ['receipt', 'safe-looking'],
    ['nested', { orderId: 'GPA.1234-5678-9012-34567' }],
    ['nested', [{ detail: 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signature' }]],
    ['nested', { sealedRefreshHandle: 'b3rh1.1.nonce.ciphertext' }],
    ['nested', { capability: 'https://example.test/file?cap=secret' }],
    ['nested', { testerAccount: 'child@example.test' }],
    ['nested', { deviceIdentifier: 'device-123' }],
    ['nested', { learnerId: 'learner-a' }],
    ['nested', { nickname: 'Ada' }],
  ];
  for (const [key, value] of smuggles) {
    const candidate = projection();
    candidate[key] = value;
    assert.throws(
      () => assertB3ProofProjectionPrivacy(candidate),
      /privacy|projection|schema|prohibited/i,
      key,
    );
  }
});

test('gateway smoke projection is redacted and cannot export a URL, query, handle or rate-limit claim', () => {
  const complete = projection();
  complete.gatewaySmokeAuthority = gatewaySmokeAuthority();
  assert.deepEqual(assertB3ProofProjectionPrivacy(complete), complete);
  assert.doesNotMatch(
    canonicaliseB3ProofValue(complete.gatewaySmokeAuthority),
    /https?:\/\/|[?&](?:cap|token|handle)=|sealedRefreshHandle|capabilityUrl|rateLimit/iu,
  );

  for (const mutate of [
    (value) => { value.gatewaySmokeAuthority.objects[0].key = 'https://example.test/?cap=secret'; },
    (value) => { value.gatewaySmokeAuthority.capabilityUrl = 'https://example.test/?cap=secret'; },
    (value) => { value.gatewaySmokeAuthority.sealedRefreshHandle = 'b3rh1.1.nonce.ciphertext'; },
    (value) => { value.gatewaySmokeAuthority.rateLimit = { everyPublicPostGetCovered: true }; },
  ]) {
    const candidate = projection();
    candidate.gatewaySmokeAuthority = gatewaySmokeAuthority();
    mutate(candidate);
    assert.throws(
      () => assertB3ProofProjectionPrivacy(candidate),
      /privacy|prohibited|gateway smoke|closed schema|authority/i,
    );
  }
});

test('projection bounds reject oversized and non-canonical Unicode payloads', () => {
  const oversized = projection();
  oversized.syntheticLearners.positionalSnapshotSha256 = Array.from(
    { length: 1_025 },
    () => HASH,
  );
  assert.throws(() => assertB3ProofProjectionPrivacy(oversized), /array|projection|bound/i);

  const unknownUnicodeKey = projection();
  unknownUnicodeKey['nickna\u006de'] = 'e\u0301'.repeat(40_000);
  assert.throws(
    () => assertB3ProofProjectionPrivacy(unknownUnicodeKey),
    /privacy|projection|schema|size|canonical|NFC/i,
  );
});

test('gateway call projection is closed, bounded and uniquely traceable', () => {
  for (const mutate of [
    (value) => { value.gatewayCalls[0].operation = 'request'; },
    (value) => { value.gatewayCalls[0].relation = 'operator-says-it-passed'; },
    (value) => { value.gatewayCalls[0].rawRequest = { purchaseToken: 'secret' }; },
    (value) => { value.gatewayCalls.push({ ...value.gatewayCalls[0] }); },
    (value) => {
      value.gatewayCalls = Array.from({ length: 17 }, (_, index) => ({
        ...value.gatewayCalls[0],
        traceId: `018f1d7b-97e8-4a52-8cf2-${String(index + 1).padStart(12, '0')}`,
      }));
    },
  ]) {
    const candidate = projection();
    mutate(candidate);
    assert.throws(
      () => assertB3ProofProjectionPrivacy(candidate),
      /gateway|privacy|schema|bound|uniqueness/i,
    );
  }
});

test('durable and transport authorities are exact, redacted and mutually coherent', () => {
  for (const mutate of [
    (value) => { value.entitlementAuthority.sealedRefreshHandle = 'hidden'; },
    (value) => { value.transactionAuthority.rawProofCleared = 'yes'; },
    (value) => { value.entitlementAuthority.domainSeparatedDigestSha256 = null; },
    (value) => { value.packAuthority.archiveSha256 = null; },
    (value) => {
      value.packAuthority = {
        packId: null, manifestSha256: null, archiveSha256: null, installed: false,
      };
    },
    (value) => { value.transportAuthority.storeAdapter = 'fakeStore'; },
    (value) => { value.transportAuthority.serverUrl = 'https://proxy.example'; },
    (value) => { value.transportAuthority.noRedirects = false; },
  ]) {
    const candidate = projection();
    mutate(candidate);
    assert.throws(
      () => assertB3ProofProjectionPrivacy(candidate),
      /authority|privacy|schema|transport|pack|entitlement/i,
    );
  }
});

test('store authority is closed, redacted and completion-coherent', () => {
  for (const mutate of [
    (value) => { value.storeAuthority.environment = 'production'; },
    (value) => { value.storeAuthority.completionState = 'unknown'; },
    (value) => { value.storeAuthority.localisedPriceObserved = 'yes'; },
    (value) => { value.storeAuthority.receipt = 'hidden'; },
    (value) => { value.storeCompletionObserved = false; },
  ]) {
    const candidate = projection();
    mutate(candidate);
    assert.throws(
      () => assertB3ProofProjectionPrivacy(candidate),
      /store authority|schema|privacy|completion/i,
    );
  }
});

test('privacy and canonical scans reject accessors without executing them and preserve __proto__ keys', () => {
  const candidate = projection();
  let getterCalls = 0;
  Object.defineProperty(candidate.syntheticLearners, 'nickname', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'Ada';
    },
  });
  assert.throws(
    () => assertB3ProofProjectionPrivacy(candidate),
    /data|accessor|canonical|privacy/i,
  );
  assert.equal(getterCalls, 0);

  const protoKey = JSON.parse('{"__proto__":{"safe":true},"a":1}');
  assert.equal(
    canonicaliseB3ProofValue(protoKey),
    '{"__proto__":{"safe":true},"a":1}',
  );
  assert.equal({}.safe, undefined);
});
