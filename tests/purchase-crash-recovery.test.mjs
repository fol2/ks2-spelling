import assert from 'node:assert/strict';
import test from 'node:test';

const CHECKPOINTS = Object.freeze([
  'before:journal', 'after:journal',
  'before:verify', 'after:verify',
  'before:mark-verified', 'after:mark-verified',
  'before:entitlement-commit', 'after:entitlement-commit',
  'before:gateway-completion', 'after:gateway-completion',
  'before:store-finish', 'after:store-finish',
  'before:proof-clear', 'after:proof-clear',
  'before:download-authorisation', 'after:download-authorisation',
  'before:download-job', 'after:download-job',
]);
const MANIFEST_SHA256 = '39b6a788a3686d7cbf1fd4791bce45623af21ef53c60eabc03d955395856218a';
const ARCHIVE_SHA256 = '4c2ca2eb4d4bb7ac3347b66e3483dcb6aa71b41958704733bfc471c970ce7664';
const ARCHIVE_ETAG = '913d2b2485ca6cd31d467bd7228d7e75';

function createWorld() {
  const observation = Object.freeze({
    store: 'google', environment: 'sandbox', productId: 'full_ks2', outcome: 'purchased',
    transactionRef: 'native-purchase', opaqueProof: 'fresh-purchase-proof',
  });
  const journals = new Map();
  const entitlements = new Map();
  const jobs = new Map();
  const gatewayEffects = new Set();
  const storeEffects = new Set();
  const nativeObservations = [observation];
  let nextJournalId = 0;
  const identity = (handle = 'b3rh1.1.nonce.ciphertext') => ({
    store: 'google', productId: 'full_ks2', environment: 'sandbox',
    applicationId: 'uk.eugnel.ks2spelling', entitlementId: 'full-ks2', state: 'active',
    storeTransactionId: 'GPA.1234-5678-9012-34567', sealedRefreshHandle: handle,
    refreshHandleVersion: 1, traceId: '123e4567-e89b-42d3-a456-426614174000',
    workerVersionId: 'worker-test', workerScriptAuthoritySha256: 'a'.repeat(64),
  });
  const repository = {
    async observeTransaction(input) {
      const prior = journals.get(input.journalId);
      if (prior) {
        if (prior.observationState === 'pending' &&
          prior.processingState === 'observed' &&
          input.observationState === 'purchased') {
          prior.observationState = 'purchased';
          prior.opaqueProof = input.opaqueProof;
          prior.updatedAt = input.observedAt;
        }
        return prior;
      }
      const row = { journalId: input.journalId, store: input.store, productId: input.productId,
        storeTransactionId: null, observationState: input.observationState, processingState: 'observed',
        opaqueProof: input.opaqueProof, createdAt: input.observedAt, updatedAt: input.observedAt };
      journals.set(input.journalId, row); return row;
    },
    async markVerified(input) { const row = journals.get(input.journalId); if (row.processingState === 'observed') row.processingState = 'verified'; row.updatedAt = Math.max(row.updatedAt, input.verifiedAt); return row; },
    async commitEntitlementAndReadyToComplete(input) {
      const row = journals.get(input.journalId);
      if (row.processingState === 'verified') { row.processingState = 'store-completion-pending'; row.storeTransactionId = input.storeTransactionId; row.updatedAt = input.committedAt; }
      if (!entitlements.has(input.entitlementId)) entitlements.set(input.entitlementId, { entitlementId: input.entitlementId, store: row.store, productId: row.productId, state: 'active', sealedRefreshHandle: input.sealedRefreshHandle, refreshHandleVersion: input.refreshHandleVersion, verifiedAt: input.committedAt, refreshedAt: input.committedAt, revocationAt: null });
      return { journal: row, entitlement: entitlements.get(input.entitlementId) };
    },
    async markStoreCompleteAndClearProof(input) { const row = journals.get(input.journalId); row.processingState = 'complete'; row.opaqueProof = null; row.updatedAt = input.completedAt; return row; },
    async markRejectedAndClearProof(input) { const row = journals.get(input.journalId); row.processingState = 'rejected'; row.opaqueProof = null; return row; },
    async replaceSealedRefreshHandle(input) { const row = entitlements.get(input.entitlementId); row.sealedRefreshHandle = input.sealedRefreshHandle; row.refreshHandleVersion = input.refreshHandleVersion; row.refreshedAt = input.refreshedAt; return row; },
    async applyRevocationAndDeleteHandle(input) {
      const journal = journals.get(input.journalId);
      const entitlement = entitlements.get(input.entitlementId);
      Object.assign(journal, {
        processingState: 'store-completion-pending',
        storeTransactionId: input.storeTransactionId,
        updatedAt: input.revokedAt,
      });
      Object.assign(entitlement, {
        state: 'revoked',
        sealedRefreshHandle: null,
        refreshHandleVersion: null,
        revocationAt: input.revokedAt,
      });
      return { journal, entitlement };
    },
    async listRecoverableTransactions() { return [...journals.values()].filter((row) => !['complete', 'rejected'].includes(row.processingState)); },
    async listEntitlements() { return [...entitlements.values()]; },
  };
  const store = {
    async queryProducts() { return []; },
    async purchase() { return observation; },
    async queryTransactions() { return [...nativeObservations]; },
    async restore() { return []; },
    async finishTransaction({ transactionRef }) {
      storeEffects.add(transactionRef);
      const index = nativeObservations.findIndex((value) => value.transactionRef === transactionRef);
      if (index >= 0) nativeObservations.splice(index, 1);
      return { completion: 'finished' };
    },
    async subscribeTransactionUpdates() { return { async remove() {} }; },
  };
  const gateway = {
    async verifyTransaction() { return identity(); },
    async completeTransaction({ sealedRefreshHandle }) { gatewayEffects.add(sealedRefreshHandle); return identity(); },
    async refreshEntitlement() { return identity(); },
    async authorisePackDownload() { return { ...identity(), packId: 'b3-sandbox-proof', version: '1.0.0-b3.1', signedManifestEnvelopeBase64: 'e30=', signedEnvelopeSha256: MANIFEST_SHA256, objects: [{ objectKind: 'manifest', sha256: MANIFEST_SHA256, size: 1_135, etag: 'c76b2858b8345814279a1c92ae64e365' }, { objectKind: 'archive', sha256: ARCHIVE_SHA256, size: 1_324, etag: ARCHIVE_ETAG }], archiveCapability: { packId: 'b3-sandbox-proof', version: '1.0.0-b3.1', archiveName: 'b3-sandbox-proof.zip', sha256: ARCHIVE_SHA256, compressedBytes: 1_324, etag: ARCHIVE_ETAG, capabilityUrl: 'https://b3-gateway.eugnel.uk/v1/packs/b3-sandbox-proof/1.0.0-b3.1/b3-sandbox-proof.zip?expires=1783987200&cap=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } }; },
  };
  const downloadRepository = {
    async listDownloadJobs() { return [...jobs.values()]; },
    async upsertDownloadJob(input) { jobs.set(input.jobId, input); return input; },
  };
  const attemptRepository = {
    async preparePendingAttempt(input) {
      const existing = [...journals.values()].find((row) =>
        row.observationState === 'pending' &&
        row.processingState === 'observed' &&
        row.opaqueProof === null &&
        row.storeTransactionId === null);
      if (existing) return existing;
      const stableJournalId = 'purchase-google-full-ks2-acquisition';
      const journalId = !journals.has(stableJournalId) && entitlements.size === 0
        ? stableJournalId
        : input.journalId;
      return repository.observeTransaction({
        journalId,
        store: 'google',
        productId: 'full_ks2',
        observationState: 'pending',
        opaqueProof: null,
        observedAt: input.observedAt,
      });
    },
    async discardPendingAttempt({ journalId }) {
      const row = journals.get(journalId);
      if (!row) return { discarded: false };
      if (row.observationState !== 'pending' || row.processingState !== 'observed' ||
        row.opaqueProof !== null || row.storeTransactionId !== null) {
        throw Object.assign(new Error('attempt conflict'), {
          code: 'sqlite_commerce_attempt_conflict',
        });
      }
      journals.delete(journalId);
      return { discarded: true };
    },
  };
  return {
    repository, attemptRepository, store, gateway, downloadRepository,
    journals, entitlements, jobs,
    gatewayEffects, storeEffects,
    nextJournalId() { nextJournalId += 1; return `journal-${nextJournalId}`; },
    queueNative(value) { nativeObservations.push(value); },
    clearNative() { nativeObservations.splice(0); },
  };
}

async function makeCoordinator(world, checkpoint) {
  const { createPurchaseCoordinator } = await import('../src/app/purchase-coordinator.js');
  let crashed = false;
  return createPurchaseCoordinator({
    store: world.store, gateway: world.gateway, commerceRepository: world.repository,
    attemptRepository: world.attemptRepository,
    downloadRepository: world.downloadRepository, clock: () => 10_000,
    idFactory: () => world.nextJournalId(),
    failureInjector: async (candidate) => {
      if (!crashed && candidate === checkpoint) { crashed = true; throw Object.assign(new Error('simulated crash'), { code: 'SIMULATED_CRASH' }); }
    },
  });
}

test('every before/after state arrow converges under replay without duplicated durable effects', async () => {
  for (const checkpoint of CHECKPOINTS) {
    const world = createWorld();
    const first = await makeCoordinator(world, checkpoint);
    await assert.rejects(
      first.handleObservation((await world.store.queryTransactions())[0]),
      { code: 'SIMULATED_CRASH' },
      checkpoint,
    );
    const replay = await makeCoordinator(world, 'never');
    await replay.recover();
    assert.equal(world.entitlements.size, 1, checkpoint);
    assert.equal([...world.entitlements.values()][0].state, 'active', checkpoint);
    assert.equal(world.gatewayEffects.size, 1, checkpoint);
    assert.equal(world.storeEffects.size, 1, checkpoint);
    assert.equal(world.jobs.size, 1, checkpoint);
    assert.equal([...world.journals.values()].filter((row) => row.opaqueProof !== null && row.observationState === 'purchased').length, 0, checkpoint);
  }
});

test('recovery confirms an already-finished native transaction that vanished before proof clear', async () => {
  const world = createWorld();
  const first = await makeCoordinator(world, 'after:store-finish');
  await assert.rejects(
    first.handleObservation((await world.store.queryTransactions())[0]),
    { code: 'SIMULATED_CRASH' },
  );
  assert.deepEqual(await world.store.queryTransactions(), []);
  await (await makeCoordinator(world, 'never')).recover();
  const [journal] = world.journals.values();
  assert.equal(journal.processingState, 'complete');
  assert.equal(journal.opaqueProof, null);
  assert.equal(world.jobs.size, 1);
});

test('pending completion rejects a reverified store transaction ID mismatch before side effects', async () => {
  const world = createWorld();
  await assert.rejects(
    (await makeCoordinator(world, 'after:entitlement-commit'))
      .handleObservation((await world.store.queryTransactions())[0]),
    { code: 'SIMULATED_CRASH' },
  );
  const journal = [...world.journals.values()][0];
  assert.equal(journal.processingState, 'store-completion-pending');
  let completionCalls = 0;
  world.gateway.verifyTransaction = async () => ({
    store: 'google', productId: 'full_ks2', environment: 'sandbox',
    applicationId: 'uk.eugnel.ks2spelling', entitlementId: 'full-ks2', state: 'active',
    storeTransactionId: 'GPA.9999-9999-9999-99999',
    sealedRefreshHandle: 'b3rh1.2.mismatch.handle', refreshHandleVersion: 2,
    traceId: '123e4567-e89b-42d3-a456-426614174000', workerVersionId: 'worker-test',
    workerScriptAuthoritySha256: 'a'.repeat(64),
  });
  world.gateway.completeTransaction = async () => { completionCalls += 1; throw new Error('must not complete'); };
  await assert.rejects(
    (await makeCoordinator(world, 'never')).recover(),
    { code: 'PURCHASE_GATEWAY_IDENTITY_MISMATCH' },
  );
  assert.equal(completionCalls, 0);
  assert.equal(world.storeEffects.has('native-purchase'), false);
  assert.equal(journal.opaqueProof, 'fresh-purchase-proof');
});

test('same-millisecond clocks allocate strictly monotonic repository timestamps', async () => {
  const world = createWorld();
  const timestamps = [];
  for (const name of ['observeTransaction', 'markVerified', 'commitEntitlementAndReadyToComplete', 'markStoreCompleteAndClearProof', 'replaceSealedRefreshHandle']) {
    const original = world.repository[name];
    world.repository[name] = async (input) => {
      timestamps.push(input.observedAt ?? input.verifiedAt ?? input.committedAt ?? input.completedAt ?? input.refreshedAt);
      return original(input);
    };
  }
  await (await makeCoordinator(world, 'never')).purchaseFullKs2({ productId: 'full_ks2' });
  assert.deepEqual(timestamps, timestamps.toSorted((left, right) => left - right));
  assert.equal(new Set(timestamps).size, timestamps.length);
});

test('permanent rejection crash checkpoints preserve proof before and keep it cleared after', async () => {
  for (const checkpoint of ['before:rejection', 'after:rejection']) {
    const world = createWorld();
    world.gateway.verifyTransaction = async () => {
      throw Object.assign(new Error('authenticated permanent rejection'), {
        code: 'PROOF_REJECTED', status: 422, retryable: false,
      });
    };
    const first = await makeCoordinator(world, checkpoint);
    await assert.rejects(first.handleObservation((await world.store.queryTransactions())[0]), {
      code: 'SIMULATED_CRASH',
    });
    const [journal] = world.journals.values();
    if (checkpoint === 'before:rejection') {
      assert.equal(journal.processingState, 'observed');
      assert.equal(journal.opaqueProof, 'fresh-purchase-proof');
      await assert.rejects(
        (await makeCoordinator(world, 'never')).handleObservation(
          (await world.store.queryTransactions())[0],
        ),
        { code: 'PROOF_REJECTED' },
      );
    } else {
      assert.equal(journal.processingState, 'rejected');
      assert.equal(journal.opaqueProof, null);
      world.clearNative();
      await (await makeCoordinator(world, 'never')).recover();
    }
    assert.equal(journal.processingState, 'rejected', checkpoint);
    assert.equal(journal.opaqueProof, null, checkpoint);
    assert.equal(world.entitlements.size, 0, checkpoint);
    assert.equal(world.storeEffects.size, 0, checkpoint);
    assert.equal(world.jobs.size, 0, checkpoint);
  }
});

test('revocation crash matrix converges with the handle deleted and installed job retained', async () => {
  for (const checkpoint of [
    'before:verify', 'after:verify',
    'before:entitlement-commit', 'after:entitlement-commit',
    'before:store-finish', 'after:store-finish',
    'before:proof-clear', 'after:proof-clear',
  ]) {
    const world = createWorld();
    await (await makeCoordinator(world, 'never')).purchaseFullKs2({ productId: 'full_ks2' });
    const revoked = Object.freeze({
      store: 'google', environment: 'sandbox', productId: 'full_ks2', outcome: 'revoked',
      transactionRef: 'native-revocation', opaqueProof: 'fresh-revocation-proof',
    });
    world.queueNative(revoked);
    const revokedIdentity = {
      store: 'google', productId: 'full_ks2', environment: 'sandbox',
      applicationId: 'uk.eugnel.ks2spelling', entitlementId: 'full-ks2', state: 'revoked',
      storeTransactionId: 'GPA.1234-5678-9012-34567',
      sealedRefreshHandle: 'b3rh1.2.revocation.handle', refreshHandleVersion: 2,
      traceId: '123e4567-e89b-42d3-a456-426614174000', workerVersionId: 'worker-test',
      workerScriptAuthoritySha256: 'a'.repeat(64),
    };
    let refreshCalls = 0;
    world.gateway.refreshEntitlement = async () => {
      refreshCalls += 1;
      return revokedIdentity;
    };
    const first = await makeCoordinator(world, checkpoint);
    await assert.rejects(first.handleObservation(revoked), { code: 'SIMULATED_CRASH' }, checkpoint);
    try {
      await (await makeCoordinator(world, 'never')).recover();
    } catch (error) {
      error.message = `${error.message} (${checkpoint})`;
      throw error;
    }
    const entitlement = [...world.entitlements.values()][0];
    const revocationJournal = [...world.journals.values()].find(
      (row) => row.observationState === 'revoked',
    );
    assert.equal(entitlement.state, 'revoked', checkpoint);
    assert.equal(entitlement.sealedRefreshHandle, null, checkpoint);
    assert.equal(entitlement.refreshHandleVersion, null, checkpoint);
    assert.equal(revocationJournal.processingState, 'complete', checkpoint);
    assert.equal(revocationJournal.opaqueProof, null, checkpoint);
    assert.equal(refreshCalls >= 1, true, checkpoint);
    assert.equal(world.gatewayEffects.has('b3rh1.2.revocation.handle'), false, checkpoint);
    assert.equal(world.storeEffects.has('native-revocation'), true, checkpoint);
    assert.equal(world.jobs.size, 1, checkpoint);
  }
});
