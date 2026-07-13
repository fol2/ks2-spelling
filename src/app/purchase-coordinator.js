import {
  B3_PACK_JOB_AUTHORITY,
  FULL_KS2_PACK,
  FULL_KS2_PRODUCT_IDS,
  PURCHASE_CHECKPOINTS,
  assertApprovedFullKs2ProductId,
  classifyGatewayFailure,
  deriveTransactionReplayJournalId,
} from '../domain/commerce/purchase-state.js';
import { validateObservation } from '../platform/commerce/store-port.js';

const METHOD_NAMES = Object.freeze([
  'purchaseFullKs2',
  'handleObservation',
  'restore',
  'refresh',
  'recover',
]);

function requireFactoryInput(value) {
  const keys = [
    'store',
    'gateway',
    'commerceRepository',
    'downloadRepository',
    'clock',
    'idFactory',
    'failureInjector',
  ];
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    throw new TypeError('Purchase coordinator dependencies are invalid.');
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('Purchase coordinator dependencies must be data fields.');
    }
  }
  const methodGroups = [
    [value.store, ['purchase', 'queryTransactions', 'restore', 'finishTransaction']],
    [value.gateway, ['verifyTransaction', 'completeTransaction', 'refreshEntitlement', 'authorisePackDownload']],
    [value.commerceRepository, [
      'observeTransaction', 'markVerified', 'commitEntitlementAndReadyToComplete',
      'markStoreCompleteAndClearProof', 'markRejectedAndClearProof',
      'replaceSealedRefreshHandle', 'applyRevocationAndDeleteHandle',
      'listRecoverableTransactions', 'listEntitlements',
    ]],
    [value.downloadRepository, ['listDownloadJobs', 'upsertDownloadJob']],
  ];
  for (const [target, methods] of methodGroups) {
    if (!target || methods.some((method) => typeof target[method] !== 'function')) {
      throw new TypeError('Purchase coordinator port is invalid.');
    }
  }
  for (const name of ['clock', 'idFactory', 'failureInjector']) {
    if (typeof value[name] !== 'function') throw new TypeError(`${name} must be a function.`);
  }
  return value;
}

function safeJournalId(idFactory) {
  const value = idFactory();
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value) || value.length > 64) {
    throw new TypeError('idFactory returned an invalid journal identifier.');
  }
  return value;
}

function assertGatewayIdentity(response, authority, expectedState) {
  const keys = [
    'store', 'productId', 'environment', 'entitlementId', 'storeTransactionId',
    'applicationId', 'workerVersionId', 'workerScriptAuthoritySha256',
  ];
  for (const key of keys) {
    if (authority[key] !== undefined && response[key] !== authority[key]) {
      throw Object.assign(new Error('Gateway identity changed during commerce processing.'), {
        code: 'PURCHASE_GATEWAY_IDENTITY_MISMATCH',
      });
    }
  }
  if (response.state !== expectedState) {
    throw Object.assign(new Error('Gateway entitlement state changed unexpectedly.'), {
      code: 'PURCHASE_GATEWAY_STATE_MISMATCH',
    });
  }
  return response;
}

function frozenResult(state) {
  return Object.freeze({ state });
}

export function createPurchaseCoordinator(rawDependencies) {
  const dependencies = requireFactoryInput(rawDependencies);
  const {
    store,
    gateway,
    commerceRepository,
    downloadRepository,
    clock,
    idFactory,
    failureInjector,
  } = dependencies;
  // The native application composition owns one coordinator and one reconciler per
  // database connection. This queue is therefore the single proof-processing lane.
  let tail = Promise.resolve();
  let lastTimestamp = -1;
  let timestampFloorSeeded = false;

  function serialise(operation) {
    const run = tail.then(operation, operation);
    tail = run.catch(() => {});
    return run;
  }

  function timestampAfter(...values) {
    const sampled = clock();
    if (!Number.isSafeInteger(sampled) || sampled < 0) {
      throw new TypeError('clock must return a safe non-negative integer.');
    }
    const floor = Math.max(lastTimestamp, ...values.filter(Number.isSafeInteger));
    const next = Math.max(sampled, floor + 1);
    if (!Number.isSafeInteger(next)) throw new TypeError('Commerce timestamp overflowed.');
    lastTimestamp = next;
    return next;
  }

  async function checkpoint(position, name) {
    if (!PURCHASE_CHECKPOINTS.includes(name)) throw new TypeError('Unknown purchase checkpoint.');
    await failureInjector(`${position}:${name}`);
  }

  async function around(name, operation) {
    await checkpoint('before', name);
    const result = await operation();
    await checkpoint('after', name);
    return result;
  }

  async function listRecoverable() {
    const rows = await commerceRepository.listRecoverableTransactions();
    if (!Array.isArray(rows)) throw new TypeError('Recoverable transaction list is invalid.');
    return rows;
  }

  function absorbTimestampFloor(rows) {
    for (const row of rows) {
      for (const key of ['updatedAt', 'verifiedAt', 'refreshedAt', 'revocationAt']) {
        if (Number.isSafeInteger(row[key])) lastTimestamp = Math.max(lastTimestamp, row[key]);
      }
    }
  }

  async function listEntitlements() {
    const rows = await commerceRepository.listEntitlements();
    if (!Array.isArray(rows)) throw new TypeError('Entitlement list is invalid.');
    absorbTimestampFloor(rows);
    return rows;
  }

  async function seedTimestampFloor() {
    if (timestampFloorSeeded) return;
    const recoverable = await listRecoverable();
    absorbTimestampFloor(recoverable);
    await listEntitlements();
    timestampFloorSeeded = true;
  }

  function sameEventKind(left, right) {
    const kind = (value) => value === 'pending' || value === 'purchased'
      ? 'acquisition'
      : value;
    return kind(left) === kind(right);
  }

  async function locateJournal(value, stableJournalId) {
    const rows = await listRecoverable();
    const exact = rows.find((row) =>
      row.store === value.store &&
      row.productId === value.productId &&
      sameEventKind(row.observationState, value.outcome) &&
      row.opaqueProof === (value.opaqueProof ?? null)) ?? null;
    const stable = rows.find((row) => row.journalId === stableJournalId) ?? null;
    const promotablePending = value.outcome === 'purchased' ? rows.filter((row) =>
      row.store === value.store &&
      row.productId === value.productId &&
      row.observationState === 'pending' &&
      row.processingState === 'observed' &&
      row.storeTransactionId === null &&
      row.opaqueProof === null) : [];
    return exact ?? stable ?? (promotablePending.length === 1 ? promotablePending[0] : null);
  }

  async function persistHandle(response, previousTimestamp = -1) {
    if (response.state !== 'active') return null;
    return commerceRepository.replaceSealedRefreshHandle({
      entitlementId: response.entitlementId,
      sealedRefreshHandle: response.sealedRefreshHandle,
      refreshHandleVersion: response.refreshHandleVersion,
      refreshedAt: timestampAfter(previousTimestamp),
    });
  }

  async function ensureDownloadJob(authority) {
    const jobs = await downloadRepository.listDownloadJobs();
    const existing = jobs.find((job) => job.jobId === FULL_KS2_PACK.jobId);
    if (existing) {
      const safeStates = new Set([
        'queued', 'downloading', 'downloaded', 'extracting', 'ready', 'failed',
      ]);
      const safeExisting =
        existing.packId === FULL_KS2_PACK.packId &&
        existing.version === FULL_KS2_PACK.version &&
        existing.archiveName === B3_PACK_JOB_AUTHORITY.archiveName &&
        existing.manifestSha256 === B3_PACK_JOB_AUTHORITY.manifestSha256 &&
        existing.archiveSha256 === B3_PACK_JOB_AUTHORITY.archiveSha256 &&
        existing.expectedBytes === B3_PACK_JOB_AUTHORITY.archiveBytes &&
        existing.etag === B3_PACK_JOB_AUTHORITY.archiveEtag &&
        Number.isSafeInteger(existing.completedBytes) &&
        existing.completedBytes >= 0 &&
        existing.completedBytes <= existing.expectedBytes &&
        safeStates.has(existing.state);
      if (!safeExisting) {
        throw Object.assign(new Error('The durable download job authority is inconsistent.'), {
          code: 'PURCHASE_DOWNLOAD_JOB_AUTHORITY_MISMATCH',
        });
      }
      return existing;
    }
    const response = await around('download-authorisation', () =>
      gateway.authorisePackDownload({
        sealedRefreshHandle: authority.sealedRefreshHandle,
        packId: FULL_KS2_PACK.packId,
        version: FULL_KS2_PACK.version,
      }));
    assertGatewayIdentity(response, authority, 'active');
    const capability = response.archiveCapability;
    const manifestObject = response.objects?.[0];
    const archiveObject = response.objects?.[1];
    if (
      response.signedEnvelopeSha256 !== B3_PACK_JOB_AUTHORITY.manifestSha256 ||
      !Array.isArray(response.objects) ||
      response.objects.length !== 2 ||
      manifestObject?.objectKind !== 'manifest' ||
      manifestObject.sha256 !== B3_PACK_JOB_AUTHORITY.manifestSha256 ||
      manifestObject.size !== B3_PACK_JOB_AUTHORITY.manifestBytes ||
      manifestObject.etag !== B3_PACK_JOB_AUTHORITY.manifestEtag ||
      archiveObject?.objectKind !== 'archive' ||
      archiveObject.sha256 !== B3_PACK_JOB_AUTHORITY.archiveSha256 ||
      archiveObject.size !== B3_PACK_JOB_AUTHORITY.archiveBytes ||
      archiveObject.etag !== B3_PACK_JOB_AUTHORITY.archiveEtag ||
      capability.packId !== B3_PACK_JOB_AUTHORITY.packId ||
      capability.version !== B3_PACK_JOB_AUTHORITY.version ||
      capability.archiveName !== B3_PACK_JOB_AUTHORITY.archiveName ||
      capability.sha256 !== B3_PACK_JOB_AUTHORITY.archiveSha256 ||
      capability.compressedBytes !== B3_PACK_JOB_AUTHORITY.archiveBytes ||
      capability.etag !== B3_PACK_JOB_AUTHORITY.archiveEtag
    ) {
      throw Object.assign(new Error('The gateway pack authority does not match the tracked proof.'), {
        code: 'PURCHASE_DOWNLOAD_AUTHORITY_MISMATCH',
      });
    }
    await persistHandle(response, authority.refreshedAt ?? authority.updatedAt ?? -1);
    return around('download-job', () => downloadRepository.upsertDownloadJob({
      jobId: FULL_KS2_PACK.jobId,
      packId: FULL_KS2_PACK.packId,
      version: FULL_KS2_PACK.version,
      manifestSha256: response.signedEnvelopeSha256,
      archiveName: capability.archiveName,
      archiveSha256: capability.sha256,
      expectedBytes: capability.compressedBytes,
      completedBytes: 0,
      etag: capability.etag,
      state: 'queued',
      updatedAt: timestampAfter(),
    }));
  }

  async function verifyJournal(journal, suppliedAuthority = null) {
    let verified;
    if (suppliedAuthority) {
      verified = suppliedAuthority;
    } else {
      try {
        verified = await around('verify', () => gateway.verifyTransaction({
          store: journal.store,
          environment: 'sandbox',
          productId: journal.productId,
          opaqueProof: journal.opaqueProof,
        }));
      } catch (error) {
        const classification = classifyGatewayFailure(error);
        if (classification !== 'recoverable') {
          await around('rejection', () => commerceRepository.markRejectedAndClearProof({
            journalId: journal.journalId,
            rejectionKind: classification,
            rejectedAt: timestampAfter(journal.updatedAt),
          }));
        }
        throw error;
      }
    }
    const expectedState = journal.observationState === 'revoked' ? 'revoked' : 'active';
    assertGatewayIdentity(verified, {
      store: journal.store,
      productId: journal.productId,
      environment: 'sandbox',
      entitlementId: FULL_KS2_PACK.entitlementId,
      applicationId: 'uk.eugnel.ks2spelling',
    }, expectedState);
    if (journal.processingState === 'observed') {
      journal = await around('mark-verified', () => commerceRepository.markVerified({
        journalId: journal.journalId,
        verifiedAt: timestampAfter(journal.updatedAt),
      }));
    }
    return { journal, verified };
  }

  async function finishNativeAndClear(journal, nativeObservation, nativeSnapshotKnown) {
    let nativeConfirmed = nativeSnapshotKnown && nativeObservation === null;
    if (nativeObservation) {
      const finish = await around('store-finish', () => store.finishTransaction({
        transactionRef: nativeObservation.transactionRef,
      }));
      nativeConfirmed = finish?.completion === 'finished';
    }
    if (!nativeConfirmed) return { journal, complete: false };
    const complete = await around('proof-clear', () =>
      commerceRepository.markStoreCompleteAndClearProof({
        journalId: journal.journalId,
        completedAt: timestampAfter(journal.updatedAt),
      }));
    return { journal: complete, complete: true };
  }

  async function finishAcquisition(journal, verified, nativeObservation, nativeSnapshotKnown) {
    const completed = await around('gateway-completion', () => gateway.completeTransaction({
      sealedRefreshHandle: verified.sealedRefreshHandle,
    }));
    assertGatewayIdentity(completed, verified, verified.state);
    if (completed.state === 'active') {
      await persistHandle(completed, journal.updatedAt);
    }
    const result = await finishNativeAndClear(journal, nativeObservation, nativeSnapshotKnown);
    if (!result.complete) return frozenResult('store-completion-pending');
    await ensureDownloadJob(completed);
    return frozenResult(result.journal.processingState);
  }

  async function processRevocationJournal(
    journal,
    nativeObservation,
    nativeSnapshotKnown,
    suppliedAuthority,
  ) {
    if (journal.processingState === 'store-completion-pending') {
      if (
        suppliedAuthority &&
        suppliedAuthority.storeTransactionId !== journal.storeTransactionId
      ) {
        throw Object.assign(new Error('Reverified store transaction authority changed.'), {
          code: 'PURCHASE_GATEWAY_IDENTITY_MISMATCH',
        });
      }
      const result = await finishNativeAndClear(
        journal,
        nativeObservation,
        nativeSnapshotKnown,
      );
      return frozenResult(result.complete ? result.journal.processingState : 'store-completion-pending');
    }

    let authority = suppliedAuthority;
    if (!authority) {
      const entitlements = await listEntitlements();
      const active = entitlements.find((entitlement) =>
        entitlement.entitlementId === FULL_KS2_PACK.entitlementId &&
        entitlement.store === journal.store &&
        entitlement.productId === journal.productId &&
        entitlement.state === 'active');
      if (active) {
        authority = await around('verify', () => gateway.refreshEntitlement({
          sealedRefreshHandle: active.sealedRefreshHandle,
        }));
        assertGatewayIdentity(authority, active, 'revoked');
      }
    }
    const verifiedResult = await verifyJournal(journal, authority);
    journal = verifiedResult.journal;
    const verified = verifiedResult.verified;
    if (journal.processingState !== 'verified') {
      throw Object.assign(new Error('Durable revocation journal state is invalid.'), {
        code: 'PURCHASE_JOURNAL_STATE_INVALID',
      });
    }
    const revoked = await around('entitlement-commit', () =>
      commerceRepository.applyRevocationAndDeleteHandle({
        journalId: journal.journalId,
        entitlementId: verified.entitlementId,
        storeTransactionId: verified.storeTransactionId,
        revokedAt: timestampAfter(journal.updatedAt),
      }));
    journal = revoked.journal;
    const result = await finishNativeAndClear(journal, nativeObservation, nativeSnapshotKnown);
    return frozenResult(result.complete ? result.journal.processingState : 'store-completion-pending');
  }

  async function processDurableJournal(
    journal,
    nativeObservation,
    nativeSnapshotKnown,
    suppliedAuthority = null,
  ) {
    if (journal.observationState === 'pending') return frozenResult('pending');
    if (journal.observationState === 'revoked') {
      return processRevocationJournal(
        journal,
        nativeObservation,
        nativeSnapshotKnown,
        suppliedAuthority,
      );
    }
    const { journal: verifiedJournal, verified } = await verifyJournal(journal);
    journal = verifiedJournal;
    if (journal.processingState === 'verified') {
      const committed = await around('entitlement-commit', () =>
        commerceRepository.commitEntitlementAndReadyToComplete({
          journalId: journal.journalId,
          entitlementId: verified.entitlementId,
          storeTransactionId: verified.storeTransactionId,
          sealedRefreshHandle: verified.sealedRefreshHandle,
          refreshHandleVersion: verified.refreshHandleVersion,
          committedAt: timestampAfter(journal.updatedAt),
        }));
      journal = committed.journal;
    } else if (journal.processingState !== 'store-completion-pending') {
      throw Object.assign(new Error('Durable purchase journal state is invalid.'), {
        code: 'PURCHASE_JOURNAL_STATE_INVALID',
      });
    }
    if (
      journal.processingState === 'store-completion-pending' &&
      verified.storeTransactionId !== journal.storeTransactionId
    ) {
      throw Object.assign(new Error('Reverified store transaction authority changed.'), {
        code: 'PURCHASE_GATEWAY_IDENTITY_MISMATCH',
      });
    }
    return finishAcquisition(journal, verified, nativeObservation, nativeSnapshotKnown);
  }

  async function processTerminalJournal(journal) {
    if (journal.processingState === 'rejected') return frozenResult('rejected');
    if (journal.processingState !== 'complete') {
      throw Object.assign(new Error('Unexpected terminal purchase state.'), {
        code: 'PURCHASE_JOURNAL_STATE_INVALID',
      });
    }
    if (journal.observationState !== 'revoked') {
      const entitlements = await listEntitlements();
      const active = entitlements.find((entitlement) =>
        entitlement.entitlementId === FULL_KS2_PACK.entitlementId &&
        entitlement.state === 'active');
      if (active) await ensureDownloadJob(active);
    }
    return frozenResult('complete');
  }

  async function processObservation(rawObservation, {
    attemptMode = 'proactive',
    suppliedAuthority = null,
    nativeSnapshotKnown = false,
  } = {}) {
    const value = validateObservation(rawObservation);
    if (value.outcome === 'cancelled' || value.outcome === 'unverified') {
      return frozenResult(value.outcome);
    }
    await seedTimestampFloor();
    const stableJournalId = deriveTransactionReplayJournalId(value);
    let journal = await locateJournal(value, stableJournalId);
    const entitlements = await listEntitlements();
    const entitlement = entitlements.find((candidate) =>
      candidate.entitlementId === FULL_KS2_PACK.entitlementId &&
      candidate.store === value.store &&
      candidate.productId === value.productId) ?? null;
    if (!journal && value.outcome === 'purchased' && entitlement?.state === 'active' &&
      attemptMode !== 'restore') {
      await ensureDownloadJob(entitlement);
      return frozenResult('complete');
    }
    if (!journal && value.outcome === 'revoked' && entitlement?.state === 'revoked') {
      return frozenResult('complete');
    }

    const nativeObservation = value;
    if (journal) {
      const promotesPending =
        journal.observationState === 'pending' &&
        value.outcome === 'purchased' &&
        journal.processingState === 'observed';
      if (promotesPending) {
        journal = await around('journal', () => commerceRepository.observeTransaction({
          journalId: journal.journalId,
          store: value.store,
          productId: value.productId,
          observationState: value.outcome,
          opaqueProof: value.opaqueProof,
          observedAt: timestampAfter(journal.updatedAt),
        }));
      }
    } else {
      journal = await around('journal', () => commerceRepository.observeTransaction({
        journalId: stableJournalId,
        store: value.store,
        productId: value.productId,
        observationState: value.outcome,
        opaqueProof: value.opaqueProof ?? null,
        observedAt: timestampAfter(),
      }));
    }
    if (journal.processingState === 'complete' || journal.processingState === 'rejected') {
      const acquisition = value.outcome === 'pending' || value.outcome === 'purchased';
      const needsFreshAttempt =
        (attemptMode === 'restore' && acquisition) ||
        (attemptMode === 'purchase' && acquisition && journal.processingState === 'rejected') ||
        (value.outcome === 'revoked' && entitlement?.state === 'active');
      if (!needsFreshAttempt) return processTerminalJournal(journal);
      journal = await around('journal', () => commerceRepository.observeTransaction({
        journalId: safeJournalId(idFactory),
        store: value.store,
        productId: value.productId,
        observationState: value.outcome,
        opaqueProof: value.opaqueProof ?? null,
        observedAt: timestampAfter(journal.updatedAt),
      }));
    }
    if (value.outcome === 'pending') return frozenResult('pending');
    return processDurableJournal(
      journal,
      nativeObservation,
      nativeSnapshotKnown,
      suppliedAuthority,
    );
  }

  async function recoverInternal() {
    await seedTimestampFloor();
    const native = await store.queryTransactions({ productIds: [...FULL_KS2_PRODUCT_IDS] });
    for (const observation of native) {
      await processObservation(observation, { nativeSnapshotKnown: true });
    }
    const recoverable = await listRecoverable();
    for (const journal of recoverable) {
      if (journal.observationState === 'pending') continue;
      const matching = native.find((candidate) =>
        candidate.store === journal.store &&
        candidate.productId === journal.productId &&
        candidate.opaqueProof === journal.opaqueProof) ?? null;
      const conflicting = native.some((candidate) =>
        candidate.store === journal.store &&
        candidate.productId === journal.productId &&
        sameEventKind(candidate.outcome, journal.observationState) &&
        candidate.opaqueProof !== journal.opaqueProof);
      await processDurableJournal(journal, matching, !conflicting);
    }
    const entitlements = await listEntitlements();
    for (const entitlement of entitlements) {
      if (entitlement.entitlementId === FULL_KS2_PACK.entitlementId && entitlement.state === 'active') {
        await ensureDownloadJob(entitlement);
      }
    }
    return frozenResult('reconciled');
  }

  async function purchaseFullKs2(request) {
    if (arguments.length !== 1) throw new TypeError('purchaseFullKs2 requires one input.');
    return serialise(async () => {
      const productId = assertApprovedFullKs2ProductId(request);
      return processObservation(await store.purchase({ productId }), {
        attemptMode: 'purchase',
      });
    });
  }

  async function handleObservation(value) {
    if (arguments.length !== 1) throw new TypeError('handleObservation requires one input.');
    return serialise(() => processObservation(value));
  }

  async function restore() {
    if (arguments.length !== 0) throw new TypeError('restore does not accept input.');
    return serialise(async () => {
      const observations = await store.restore({ productIds: [...FULL_KS2_PRODUCT_IDS] });
      const selected = new Map();
      for (const observation of observations) {
        const value = validateObservation(observation);
        const key = ['pending', 'purchased', 'revoked'].includes(value.outcome)
          ? deriveTransactionReplayJournalId(value)
          : `${value.store}:${value.productId}:${value.outcome}`;
        const existing = selected.get(key);
        if (!existing || (existing.outcome === 'pending' && value.outcome === 'purchased')) {
          selected.set(key, value);
        }
      }
      for (const observation of selected.values()) {
        await processObservation(observation, { attemptMode: 'restore' });
      }
      return frozenResult('restored');
    });
  }

  async function refresh() {
    if (arguments.length !== 0) throw new TypeError('refresh does not accept input.');
    return serialise(async () => {
      await seedTimestampFloor();
      const entitlements = await listEntitlements();
      for (const entitlement of entitlements) {
        if (entitlement.state !== 'active') continue;
        const response = await around('verify', () => gateway.refreshEntitlement({
          sealedRefreshHandle: entitlement.sealedRefreshHandle,
        }));
        assertGatewayIdentity(response, entitlement, response.state);
        if (response.state === 'active') {
          await persistHandle(response, entitlement.refreshedAt);
        } else {
          const native = await store.queryTransactions({
            productIds: [...FULL_KS2_PRODUCT_IDS],
          });
          const revocation = native.find((observation) =>
            observation.outcome === 'revoked' &&
            observation.store === entitlement.store &&
            observation.productId === entitlement.productId) ?? null;
          if (!revocation) {
            throw Object.assign(new Error('A verified store revocation observation is required.'), {
              code: 'PURCHASE_REVOCATION_OBSERVATION_REQUIRED',
            });
          }
          await processObservation(revocation, { suppliedAuthority: response });
        }
      }
      return frozenResult('refreshed');
    });
  }

  async function recover() {
    if (arguments.length !== 0) throw new TypeError('recover does not accept input.');
    return serialise(recoverInternal);
  }

  const coordinator = { purchaseFullKs2, handleObservation, restore, refresh, recover };
  if (Reflect.ownKeys(coordinator).join('|') !== METHOD_NAMES.join('|')) {
    throw new TypeError('Purchase coordinator surface is invalid.');
  }
  return Object.freeze(coordinator);
}
