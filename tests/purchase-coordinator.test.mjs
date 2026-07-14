import assert from 'node:assert/strict';
import test from 'node:test';

const GOOGLE_PRODUCT_ID = 'full_ks2';
const APPLE_PRODUCT_ID = 'uk.eugnel.ks2spelling.fullks2';
const STORE_TRANSACTION_ID = 'GPA.1234-5678-9012-34567';
const HANDLE = 'b3rh1.1.test-nonce.test-ciphertext';
const MANIFEST_SHA256 = '39b6a788a3686d7cbf1fd4791bce45623af21ef53c60eabc03d955395856218a';
const ARCHIVE_SHA256 = '4c2ca2eb4d4bb7ac3347b66e3483dcb6aa71b41958704733bfc471c970ce7664';
const ARCHIVE_BYTES = 1_324;
const ARCHIVE_ETAG = '913d2b2485ca6cd31d467bd7228d7e75';

function observation(outcome, overrides = {}) {
  const value = {
    store: 'google',
    environment: 'sandbox',
    productId: GOOGLE_PRODUCT_ID,
    outcome,
    transactionRef: `native-${outcome}`,
    ...overrides,
  };
  if (outcome === 'purchased' || outcome === 'revoked') value.opaqueProof ??= `${outcome}-proof`;
  return Object.freeze(value);
}

function identity(overrides = {}) {
  return Object.freeze({
    store: 'google',
    productId: GOOGLE_PRODUCT_ID,
    environment: 'sandbox',
    applicationId: 'uk.eugnel.ks2spelling',
    entitlementId: 'full-ks2',
    state: 'active',
    storeTransactionId: STORE_TRANSACTION_ID,
    sealedRefreshHandle: HANDLE,
    refreshHandleVersion: 1,
    traceId: '123e4567-e89b-42d3-a456-426614174000',
    workerVersionId: 'worker-test',
    workerScriptAuthoritySha256: 'a'.repeat(64),
    ...overrides,
  });
}

function authorisation(overrides = {}) {
  return Object.freeze({
    ...identity(),
    packId: 'b3-sandbox-proof',
    version: '1.0.0-b3.1',
    signedManifestEnvelopeBase64: 'e30=',
    signedEnvelopeSha256: MANIFEST_SHA256,
    objects: Object.freeze([
      Object.freeze({ objectKind: 'manifest', sha256: MANIFEST_SHA256, size: 1_135, etag: 'c76b2858b8345814279a1c92ae64e365' }),
      Object.freeze({ objectKind: 'archive', sha256: ARCHIVE_SHA256, size: ARCHIVE_BYTES, etag: ARCHIVE_ETAG }),
    ]),
    archiveCapability: Object.freeze({
      packId: 'b3-sandbox-proof',
      version: '1.0.0-b3.1',
      archiveName: 'b3-sandbox-proof.zip',
      sha256: ARCHIVE_SHA256,
      compressedBytes: ARCHIVE_BYTES,
      etag: ARCHIVE_ETAG,
      capabilityUrl: 'https://b3-gateway.eugnel.uk/v1/packs/b3-sandbox-proof/1.0.0-b3.1/b3-sandbox-proof.zip?expires=1783987200&cap=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    }),
    ...overrides,
  });
}

function createHarness({ purchaseOutcome = observation('purchased'), verifyError } = {}) {
  const calls = [];
  const journals = [];
  const entitlements = [];
  const jobs = [];
  const repository = {
    async observeTransaction(value) {
      calls.push(['observeTransaction', value]);
      const existing = journals.find((candidate) => candidate.journalId === value.journalId);
      if (existing) {
        if (
          existing.observationState === 'pending' &&
          existing.processingState === 'observed' &&
          (value.observationState === 'purchased' || value.observationState === 'revoked')
        ) {
          Object.assign(existing, {
            observationState: value.observationState,
            opaqueProof: value.opaqueProof,
            updatedAt: value.observedAt,
          });
        }
        return existing;
      }
      const row = {
        journalId: value.journalId,
        store: value.store,
        productId: value.productId,
        storeTransactionId: null,
        observationState: value.observationState,
        processingState: 'observed',
        opaqueProof: value.opaqueProof,
        createdAt: value.observedAt,
        updatedAt: value.observedAt,
      };
      journals.push(row);
      return row;
    },
    async markVerified(value) {
      calls.push(['markVerified', value]);
      const row = journals.find((candidate) => candidate.journalId === value.journalId);
      row.processingState = 'verified';
      row.updatedAt = value.verifiedAt;
      return row;
    },
    async commitEntitlementAndReadyToComplete(value) {
      calls.push(['commitEntitlementAndReadyToComplete', value]);
      const row = journals.find((candidate) => candidate.journalId === value.journalId);
      row.processingState = 'store-completion-pending';
      row.storeTransactionId = value.storeTransactionId;
      row.updatedAt = value.committedAt;
      const entitlement = entitlements[0] ?? {
        entitlementId: value.entitlementId,
        store: row.store,
        productId: row.productId,
        state: 'active',
        verifiedAt: value.committedAt,
        revocationAt: null,
      };
      if (entitlements[0] && value.committedAt <= entitlement.refreshedAt) {
        throw Object.assign(new Error('restore timestamp did not advance'), {
          code: 'TEST_TIMESTAMP_NOT_MONOTONIC',
        });
      }
      Object.assign(entitlement, {
        sealedRefreshHandle: value.sealedRefreshHandle,
        refreshHandleVersion: value.refreshHandleVersion,
        refreshedAt: value.committedAt,
      });
      entitlements.splice(0, entitlements.length, entitlement);
      return { journal: row, entitlement };
    },
    async markStoreCompleteAndClearProof(value) {
      calls.push(['markStoreCompleteAndClearProof', value]);
      const row = journals.find((candidate) => candidate.journalId === value.journalId);
      row.processingState = 'complete';
      row.opaqueProof = null;
      row.updatedAt = value.completedAt;
      return row;
    },
    async markRejectedAndClearProof(value) {
      calls.push(['markRejectedAndClearProof', value]);
      const row = journals.find((candidate) => candidate.journalId === value.journalId);
      row.processingState = 'rejected';
      row.opaqueProof = null;
      row.updatedAt = value.rejectedAt;
      return row;
    },
    async replaceSealedRefreshHandle(value) {
      calls.push(['replaceSealedRefreshHandle', value]);
      const row = entitlements.find((candidate) => candidate.entitlementId === value.entitlementId);
      Object.assign(row, {
        sealedRefreshHandle: value.sealedRefreshHandle,
        refreshHandleVersion: value.refreshHandleVersion,
        refreshedAt: value.refreshedAt,
      });
      return row;
    },
    async applyRevocationAndDeleteHandle(value) {
      calls.push(['applyRevocationAndDeleteHandle', value]);
      const row = entitlements.find((candidate) => candidate.entitlementId === value.entitlementId);
      Object.assign(row, { state: 'revoked', sealedRefreshHandle: null, refreshHandleVersion: null });
      const journal = journals.find((candidate) => candidate.journalId === value.journalId);
      Object.assign(journal, {
        processingState: 'store-completion-pending',
        storeTransactionId: value.storeTransactionId,
        updatedAt: value.revokedAt,
      });
      return { journal, entitlement: row };
    },
    async listRecoverableTransactions() {
      calls.push(['listRecoverableTransactions']);
      return journals.filter((row) => !['complete', 'rejected'].includes(row.processingState));
    },
    async listEntitlements() {
      calls.push(['listEntitlements']);
      return entitlements;
    },
  };
  const store = {
    async queryProducts() { return []; },
    async purchase(value) { calls.push(['purchase', value]); return purchaseOutcome; },
    async queryTransactions() { return []; },
    async restore() { return []; },
    async finishTransaction(value) { calls.push(['finishTransaction', value]); return { completion: 'finished' }; },
    async subscribeTransactionUpdates() { return { async remove() {} }; },
  };
  const gateway = {
    async verifyTransaction(value) {
      calls.push(['verifyTransaction', value]);
      if (verifyError) throw verifyError;
      return identity();
    },
    async completeTransaction(value) { calls.push(['completeTransaction', value]); return identity(); },
    async refreshEntitlement(value) { calls.push(['refreshEntitlement', value]); return identity(); },
    async authorisePackDownload(value) { calls.push(['authorisePackDownload', value]); return authorisation(); },
  };
  const downloadRepository = {
    async listDownloadJobs() { calls.push(['listDownloadJobs']); return jobs; },
    async upsertDownloadJob(value) { calls.push(['upsertDownloadJob', value]); jobs.push(value); return value; },
  };
  const attemptRepository = {
    async preparePendingAttempt(value) {
      calls.push(['preparePendingAttempt', value]);
      const existing = journals.find((row) =>
        row.observationState === 'pending' &&
        row.processingState === 'observed' &&
        row.opaqueProof === null &&
        row.storeTransactionId === null);
      if (existing) return existing;
      const stableJournalId = 'purchase-google-full-ks2-acquisition';
      const journalId = !journals.some((row) => row.journalId === stableJournalId) &&
        entitlements.length === 0
        ? stableJournalId
        : value.journalId;
      return repository.observeTransaction({
        journalId,
        store: 'google',
        productId: GOOGLE_PRODUCT_ID,
        observationState: 'pending',
        opaqueProof: null,
        observedAt: value.observedAt,
      });
    },
    async discardPendingAttempt(value) {
      calls.push(['discardPendingAttempt', value]);
      const index = journals.findIndex((row) => row.journalId === value.journalId);
      if (index === -1) return { discarded: false };
      const row = journals[index];
      if (row.observationState !== 'pending' || row.processingState !== 'observed' ||
        row.opaqueProof !== null || row.storeTransactionId !== null) {
        throw Object.assign(new Error('attempt conflict'), {
          code: 'sqlite_commerce_attempt_conflict',
        });
      }
      journals.splice(index, 1);
      return { discarded: true };
    },
  };
  return {
    calls, journals, entitlements, jobs, repository, attemptRepository,
    store, gateway, downloadRepository,
  };
}

async function coordinator(harness, overrides = {}) {
  const { createPurchaseCoordinator } = await import('../src/app/purchase-coordinator.js');
  return createPurchaseCoordinator({
    store: harness.store,
    gateway: harness.gateway,
    commerceRepository: harness.repository,
    attemptRepository: harness.attemptRepository,
    downloadRepository: harness.downloadRepository,
    clock: () => 1_000,
    idFactory: () => 'journal-one',
    failureInjector: async () => {},
    ...overrides,
  });
}

test('purchase coordinator exposes only the five frozen async methods', async () => {
  const value = await coordinator(createHarness());
  assert.deepEqual(Reflect.ownKeys(value), [
    'purchaseFullKs2', 'handleObservation', 'restore', 'refresh', 'recover',
  ]);
  assert.equal(Object.isFrozen(value), true);
  for (const method of Reflect.ownKeys(value)) {
    assert.equal(Object.getPrototypeOf(value[method]), Object.getPrototypeOf(async function () {}));
  }
  await assert.rejects(value.purchaseFullKs2({ productId: GOOGLE_PRODUCT_ID }, 'extra'), TypeError);
  await assert.rejects(value.handleObservation(observation('cancelled'), 'extra'), TypeError);
  await assert.rejects(value.restore('extra'), TypeError);
  await assert.rejects(value.refresh('extra'), TypeError);
  await assert.rejects(value.recover('extra'), TypeError);
  await assert.rejects(
    coordinator(createHarness(), { attemptRepository: Object.freeze({}) }),
    TypeError,
  );
  await assert.rejects(
    coordinator(createHarness(), {
      attemptRepository: Object.freeze({
        async preparePendingAttempt() {},
        async discardPendingAttempt() {},
        async extra() {},
      }),
    }),
    TypeError,
  );
  await assert.rejects(
    coordinator(createHarness(), { idFactory: () => 'journal.with-dot' })
      .then((candidate) => candidate.purchaseFullKs2({ productId: GOOGLE_PRODUCT_ID })),
    TypeError,
  );
  await assert.rejects(
    coordinator(createHarness(), { idFactory: () => 'journal_with_underscore' })
      .then((candidate) => candidate.purchaseFullKs2({ productId: GOOGLE_PRODUCT_ID })),
    TypeError,
  );
});

test('a purchased observation journals before verification and finishes before proof clear and job creation', async () => {
  const harness = createHarness();
  const value = await coordinator(harness);
  await value.purchaseFullKs2({ productId: GOOGLE_PRODUCT_ID });
  assert.deepEqual(harness.calls.map(([name]) => name), [
    'listRecoverableTransactions',
    'listEntitlements',
    'listEntitlements',
    'listRecoverableTransactions',
    'listRecoverableTransactions',
    'preparePendingAttempt',
    'observeTransaction',
    'purchase',
    'listRecoverableTransactions',
    'listEntitlements',
    'observeTransaction',
    'verifyTransaction',
    'markVerified',
    'commitEntitlementAndReadyToComplete',
    'completeTransaction',
    'replaceSealedRefreshHandle',
    'finishTransaction',
    'markStoreCompleteAndClearProof',
    'listDownloadJobs',
    'authorisePackDownload',
    'replaceSealedRefreshHandle',
    'upsertDownloadJob',
  ]);
  assert.equal(harness.journals[0].opaqueProof, null);
  assert.equal(harness.entitlements[0].state, 'active');
  assert.deepEqual(harness.jobs[0], {
    jobId: 'b3-sandbox-proof.1.0.0-b3.1',
    packId: 'b3-sandbox-proof',
    version: '1.0.0-b3.1',
    manifestSha256: MANIFEST_SHA256,
    archiveName: 'b3-sandbox-proof.zip',
    archiveSha256: ARCHIVE_SHA256,
    expectedBytes: ARCHIVE_BYTES,
    completedBytes: 0,
    etag: ARCHIVE_ETAG,
    state: 'queued',
    updatedAt: 1_007,
  });
  assert.equal(JSON.stringify(harness.calls).match(/learner|child|monster|session|progress/gi), null);
  assert.equal(JSON.stringify(harness.jobs).includes('capabilityUrl'), false);
});

test('cancelled and unverified observations never journal or grant; pending journals without proof', async () => {
  for (const outcome of ['cancelled', 'unverified']) {
    const harness = createHarness({ purchaseOutcome: observation(outcome) });
    await (await coordinator(harness)).purchaseFullKs2({ productId: GOOGLE_PRODUCT_ID });
    assert.equal(harness.journals.length, 0, outcome);
    assert.equal(
      harness.calls.some(([name]) => name === 'discardPendingAttempt'),
      true,
      outcome,
    );
    assert.equal(harness.entitlements.length, 0, outcome);
  }
  const pending = createHarness({ purchaseOutcome: observation('pending') });
  await (await coordinator(pending)).purchaseFullKs2({ productId: GOOGLE_PRODUCT_ID });
  assert.equal(pending.journals[0].observationState, 'pending');
  assert.equal(pending.journals[0].opaqueProof, null);
  assert.equal(pending.calls.some(([name]) => name === 'verifyTransaction'), false);
});

test('only authenticated permanent proof failures clear the durable proof', async () => {
  for (const code of ['PROOF_REJECTED', 'PRODUCT_MISMATCH', 'STORE_TRANSACTION_ID_INVALID']) {
    const error = Object.assign(new Error('safe'), { code, status: 422, retryable: false });
    const harness = createHarness({ verifyError: error });
    await assert.rejects((await coordinator(harness)).purchaseFullKs2({ productId: GOOGLE_PRODUCT_ID }));
    assert.equal(harness.journals[0].processingState, 'rejected', code);
    assert.equal(harness.journals[0].opaqueProof, null, code);
  }
  {
    const { DefinitiveMalformedSubmittedProofError } = await import(
      '../src/domain/commerce/purchase-state.js'
    );
    const error = new DefinitiveMalformedSubmittedProofError();
    const harness = createHarness({ verifyError: error });
    await assert.rejects((await coordinator(harness)).purchaseFullKs2({ productId: GOOGLE_PRODUCT_ID }));
    assert.equal(harness.journals[0].processingState, 'rejected');
    assert.equal(harness.journals[0].opaqueProof, null);
    assert.equal(
      harness.calls.find(([name]) => name === 'markRejectedAndClearProof')[1].rejectionKind,
      'definitive-malformed-proof',
    );
  }
  for (const error of [
    Object.assign(new Error('offline'), { code: 'GATEWAY_OFFLINE', status: null, retryable: true }),
    Object.assign(new Error('timeout'), { code: 'GATEWAY_TIMEOUT', status: null, retryable: true }),
    Object.assign(new Error('rate'), { code: 'RATE_LIMITED', status: 429, retryable: true }),
    Object.assign(new Error('server'), { code: 'GATEWAY_UNAVAILABLE', status: 503, retryable: true }),
    Object.assign(new Error('malformed transient'), { code: 'GATEWAY_RESPONSE_INVALID', status: 503, retryable: true }),
    Object.assign(new Error('spoofed permanent at rate limit'), { code: 'PROOF_REJECTED', status: 429, retryable: false }),
  ]) {
    const harness = createHarness({ verifyError: error });
    await assert.rejects((await coordinator(harness)).purchaseFullKs2({ productId: GOOGLE_PRODUCT_ID }));
    assert.equal(harness.journals[0].processingState, 'observed', error.code);
    assert.equal(harness.journals[0].opaqueProof, 'purchased-proof', error.code);
    assert.equal(harness.calls.some(([name]) => name === 'markRejectedAndClearProof'), false, error.code);
  }
});

test('purchase accepts only one explicit approved platform product and restore requests both fixed products', async () => {
  const harness = createHarness();
  const value = await coordinator(harness);
  await assert.rejects(value.purchaseFullKs2(), TypeError);
  await assert.rejects(value.purchaseFullKs2({ productId: 'Full KS2' }), TypeError);
  let getterCalled = false;
  const accessor = {};
  Object.defineProperty(accessor, 'productId', {
    enumerable: true,
    get() { getterCalled = true; return GOOGLE_PRODUCT_ID; },
  });
  await assert.rejects(value.purchaseFullKs2(accessor), TypeError);
  assert.equal(getterCalled, false);
  harness.store.restore = async (request) => { harness.calls.push(['restore', request]); return []; };
  await value.restore();
  assert.deepEqual(harness.calls.find(([name]) => name === 'restore')[1], {
    productIds: [APPLE_PRODUCT_ID, GOOGLE_PRODUCT_ID],
  });
});

test('pending promotes to purchased in one journal and leaves no recoverable orphan', async () => {
  const harness = createHarness({ purchaseOutcome: observation('pending') });
  const value = await coordinator(harness);
  await value.purchaseFullKs2({ productId: GOOGLE_PRODUCT_ID });
  await value.handleObservation(observation('purchased', {
    transactionRef: 'native-promoted',
    opaqueProof: 'promoted-proof',
  }));
  assert.equal(harness.journals.length, 1);
  assert.equal(harness.journals[0].observationState, 'purchased');
  assert.equal(harness.journals[0].processingState, 'complete');
  assert.equal(harness.journals[0].opaqueProof, null);
  assert.deepEqual(await harness.repository.listRecoverableTransactions(), []);
});

test('restore journals fresh proof, reseals the existing entitlement and never duplicates its job', async () => {
  const harness = createHarness();
  let identifier = 0;
  const value = await coordinator(harness, { idFactory: () => `journal-${identifier += 1}` });
  await value.purchaseFullKs2({ productId: GOOGLE_PRODUCT_ID });
  const fresh = observation('purchased', {
    transactionRef: 'native-restore',
    opaqueProof: 'fresh-restore-proof',
  });
  harness.store.restore = async () => [fresh];
  harness.gateway.verifyTransaction = async (request) => identity({
    sealedRefreshHandle: request.opaqueProof === fresh.opaqueProof ? 'b3rh1.2.restore.handle' : HANDLE,
    refreshHandleVersion: request.opaqueProof === fresh.opaqueProof ? 2 : 1,
  });
  harness.gateway.completeTransaction = async ({ sealedRefreshHandle }) => identity({
    sealedRefreshHandle,
    refreshHandleVersion: sealedRefreshHandle.includes('.2.') ? 2 : 1,
  });
  harness.gateway.authorisePackDownload = async () => authorisation({
    sealedRefreshHandle: 'b3rh1.2.restore.handle',
    refreshHandleVersion: 2,
  });
  await value.restore();
  assert.equal(harness.journals.length, 2);
  assert.equal(harness.journals.every((journal) => journal.processingState === 'complete'), true);
  assert.equal(harness.entitlements.length, 1);
  assert.equal(harness.entitlements[0].sealedRefreshHandle, 'b3rh1.2.restore.handle');
  assert.equal(harness.entitlements[0].refreshHandleVersion, 2);
  assert.equal(harness.jobs.length, 1);
});

test('verified revocation locks access and deletes its handle without deleting the download job', async () => {
  const harness = createHarness();
  let identifier = 0;
  const value = await coordinator(harness, { idFactory: () => `journal-${identifier += 1}` });
  await value.purchaseFullKs2({ productId: GOOGLE_PRODUCT_ID });
  const revoked = observation('revoked', {
    transactionRef: 'native-revocation',
    opaqueProof: 'fresh-revocation-proof',
  });
  harness.gateway.refreshEntitlement = async () => identity({
    state: 'revoked',
    sealedRefreshHandle: 'b3rh1.2.revocation.handle',
    refreshHandleVersion: 2,
  });
  await value.handleObservation(revoked);
  assert.equal(harness.entitlements[0].state, 'revoked');
  assert.equal(harness.entitlements[0].sealedRefreshHandle, null);
  assert.equal(harness.entitlements[0].refreshHandleVersion, null);
  assert.equal(harness.jobs.length, 1);
  assert.equal(harness.journals.at(-1).opaqueProof, null);
});

test('refresh rotates active authority and requires a fresh store proof before revoking', async () => {
  const harness = createHarness();
  let identifier = 0;
  const value = await coordinator(harness, { idFactory: () => `journal-${identifier += 1}` });
  await value.purchaseFullKs2({ productId: GOOGLE_PRODUCT_ID });
  harness.gateway.refreshEntitlement = async () => identity({
    sealedRefreshHandle: 'b3rh1.2.refresh.handle',
    refreshHandleVersion: 2,
  });
  await value.refresh();
  assert.equal(harness.entitlements[0].sealedRefreshHandle, 'b3rh1.2.refresh.handle');
  const revokedIdentity = identity({
    state: 'revoked',
    sealedRefreshHandle: 'b3rh1.3.revocation.handle',
    refreshHandleVersion: 3,
  });
  harness.gateway.refreshEntitlement = async () => revokedIdentity;
  harness.store.queryTransactions = async () => [];
  await assert.rejects(value.refresh(), { code: 'PURCHASE_REVOCATION_OBSERVATION_REQUIRED' });
  assert.equal(harness.entitlements[0].state, 'active');
  const revoked = observation('revoked', {
    transactionRef: 'native-refresh-revocation',
    opaqueProof: 'fresh-refresh-revocation-proof',
  });
  harness.store.queryTransactions = async () => [revoked];
  harness.gateway.verifyTransaction = async () => revokedIdentity;
  harness.gateway.completeTransaction = async () => revokedIdentity;
  await value.refresh();
  assert.equal(harness.entitlements[0].state, 'revoked');
  assert.equal(harness.entitlements[0].sealedRefreshHandle, null);
});

test('an existing fixed job validates locally and recovery remains offline', async () => {
  const harness = createHarness();
  const value = await coordinator(harness);
  await value.purchaseFullKs2({ productId: GOOGLE_PRODUCT_ID });
  let networkCalls = 0;
  harness.gateway.authorisePackDownload = async () => {
    networkCalls += 1;
    throw new Error('offline recovery must not authorise again');
  };
  harness.store.queryTransactions = async () => [];
  await value.recover();
  assert.equal(networkCalls, 0);
  const valid = harness.jobs[0];
  for (const mutation of [
    { packId: 'poison-pack' },
    { manifestSha256: 'd'.repeat(64) },
    { archiveSha256: 'e'.repeat(64) },
    { expectedBytes: valid.expectedBytes + 1 },
    { etag: 'wrong-but-well-formed-etag' },
  ]) {
    harness.jobs[0] = { ...valid, ...mutation };
    await assert.rejects(
      value.recover(),
      { code: 'PURCHASE_DOWNLOAD_JOB_AUTHORITY_MISMATCH' },
    );
    assert.equal(networkCalls, 0);
  }
});

test('repeated current-entitlement observations use one stable tombstone across coordinators', async () => {
  const purchased = observation('purchased', {
    transactionRef: 'native-current-entitlement',
    opaqueProof: 'current-entitlement-proof',
  });
  const harness = createHarness({ purchaseOutcome: purchased });
  await (await coordinator(harness, { idFactory: () => 'first-random-attempt' }))
    .purchaseFullKs2({ productId: GOOGLE_PRODUCT_ID });
  const durableBefore = JSON.stringify({
    journals: harness.journals,
    entitlements: harness.entitlements,
    jobs: harness.jobs,
  });
  harness.store.queryTransactions = async () => [purchased];
  let gatewayCalls = 0;
  for (const method of ['verifyTransaction', 'completeTransaction', 'authorisePackDownload']) {
    harness.gateway[method] = async () => {
      gatewayCalls += 1;
      throw new Error('terminal replay must remain offline');
    };
  }
  await (await coordinator(harness, { idFactory: () => 'different-random-attempt' })).recover();
  assert.equal(gatewayCalls, 0);
  assert.equal(harness.journals.length, 1);
  assert.equal(JSON.stringify(harness.journals).includes(purchased.transactionRef), false);
  assert.equal(JSON.stringify({
    journals: harness.journals,
    entitlements: harness.entitlements,
    jobs: harness.jobs,
  }), durableBefore);
});

test('permanently rejected current observation never restores proof on a fresh coordinator', async () => {
  const purchased = observation('purchased', {
    transactionRef: 'native-permanent-rejection',
    opaqueProof: 'permanently-rejected-proof',
  });
  const error = Object.assign(new Error('permanent'), {
    code: 'PROOF_REJECTED', status: 422, retryable: false,
  });
  const harness = createHarness({ purchaseOutcome: purchased, verifyError: error });
  await assert.rejects(
    (await coordinator(harness, { idFactory: () => 'first-rejection-attempt' }))
      .purchaseFullKs2({ productId: GOOGLE_PRODUCT_ID }),
    { code: 'PROOF_REJECTED' },
  );
  assert.equal(harness.journals[0].opaqueProof, null);
  harness.store.queryTransactions = async () => [purchased];
  let gatewayCalls = 0;
  harness.gateway.verifyTransaction = async () => { gatewayCalls += 1; throw error; };
  await (await coordinator(harness, { idFactory: () => 'second-rejection-attempt' })).recover();
  assert.equal(gatewayCalls, 0);
  assert.equal(harness.journals.length, 1);
  assert.equal(harness.journals[0].processingState, 'rejected');
  assert.equal(harness.journals[0].opaqueProof, null);
});

test('fresh coordinator seeds a rolled-back clock before an explicit Restore', async () => {
  const harness = createHarness();
  let firstIdentifier = 0;
  await (await coordinator(harness, {
    clock: () => 50_000,
    idFactory: () => `initial-${firstIdentifier += 1}`,
  })).purchaseFullKs2({ productId: GOOGLE_PRODUCT_ID });
  const priorRefreshedAt = harness.entitlements[0].refreshedAt;
  const fresh = observation('purchased', {
    transactionRef: 'native-lower-clock-restore',
    opaqueProof: 'lower-clock-restore-proof',
  });
  harness.store.restore = async () => [fresh];
  harness.gateway.verifyTransaction = async () => identity({
    sealedRefreshHandle: 'b3rh1.2.lower-clock.handle', refreshHandleVersion: 2,
  });
  harness.gateway.completeTransaction = async () => identity({
    sealedRefreshHandle: 'b3rh1.2.lower-clock.handle', refreshHandleVersion: 2,
  });
  await (await coordinator(harness, {
    clock: () => 1,
    idFactory: () => 'fresh-restore-attempt',
  })).restore();
  assert.equal(harness.entitlements[0].refreshedAt > priorRefreshedAt, true);
  assert.equal(harness.entitlements[0].sealedRefreshHandle, 'b3rh1.2.lower-clock.handle');
});
