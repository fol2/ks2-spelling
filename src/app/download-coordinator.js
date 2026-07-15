import {
  B3_DOWNLOAD_CHUNK_BYTES,
  assertSubmittedDownloadEntitlement,
  createVerifiedDownloadAuthority,
} from
  '../domain/packs/signed-download-access-contract.js';

const PACK_ID = 'b3-sandbox-proof';
const VERSION = '1.0.0-b3.1';
const STAGING_METADATA_BYTES = 65_536;
const METHODS = Object.freeze(['queue', 'resume', 'retry', 'cancelTemporary']);

function downloadError(code) {
  return Object.assign(new Error(code), { code });
}

function safeBytes(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} is invalid.`);
  return value;
}

export function requiredFreeBytes({
  remainingCompressedBytes,
  fullExtractedBytes,
  stagingMetadataBytes,
}) {
  safeBytes(remainingCompressedBytes, 'Remaining compressed bytes');
  safeBytes(fullExtractedBytes, 'Full extracted bytes');
  safeBytes(stagingMetadataBytes, 'Staging metadata bytes');
  const total = remainingCompressedBytes + fullExtractedBytes + stagingMetadataBytes +
    (remainingCompressedBytes + fullExtractedBytes) * 0.10;
  if (!Number.isSafeInteger(Math.ceil(total))) throw new TypeError('Required free bytes overflowed.');
  return Math.ceil(total);
}

function requireDependencies(value) {
  const keys = [
    'gateway', 'packTransfer', 'packRepository', 'manifestVerifier', 'keyring',
    'activeEntitlementProjection', 'entitlementRepository',
    'currentAppVersion', 'currentSchemaVersion',
    'clock', 'chunkSize',
  ];
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== keys.length ||
      Reflect.ownKeys(value).some((key) => !keys.includes(key))) {
    throw new TypeError('Download coordinator dependencies are invalid.');
  }
  const requiredMethods = [
    [value.gateway, ['authorisePackDownload']],
    [value.packTransfer, [
      'getFreeBytes', 'downloadRange', 'inspectAndExtract', 'removeOwnedTemporaryState',
    ]],
    [value.packRepository, [
      'clearDownloadChunks', 'completeDownloadChunk', 'deleteDownloadJob',
      'getDownloadJob', 'listDownloadChunks', 'replaceDownloadChunks',
      'updateDownloadJob', 'upsertDownloadJob',
    ]],
    [value.entitlementRepository, ['compareAndSwapSealedRefreshHandle']],
  ];
  if (requiredMethods.some(([port, methods]) =>
    !port || methods.some((method) => typeof port[method] !== 'function'))) {
    throw new TypeError('Download coordinator port is invalid.');
  }
  if (typeof value.manifestVerifier !== 'function' ||
      typeof value.activeEntitlementProjection !== 'function' ||
      typeof value.clock !== 'function' || value.chunkSize !== B3_DOWNLOAD_CHUNK_BYTES ||
      value.currentAppVersion !== '0.3.0-b3' || value.currentSchemaVersion !== 2) {
    throw new TypeError('Download coordinator authority is invalid.');
  }
  return value;
}

function decodeBase64(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw downloadError('DOWNLOAD_ENVELOPE_INVALID');
  }
  const binary = globalThis.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function exactInput(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== keys.length ||
      Reflect.ownKeys(value).some((key) => !keys.includes(key))) {
    throw new TypeError('Download operation input is invalid.');
  }
  return value;
}

function makeChunks(jobId, expectedBytes, chunkSize) {
  const chunks = [];
  for (let startByte = 0; startByte < expectedBytes; startByte += chunkSize) {
    chunks.push({
      jobId,
      startByte,
      endByteExclusive: Math.min(startByte + chunkSize, expectedBytes),
      state: 'pending',
      chunkSha256: null,
    });
  }
  return chunks;
}

function isValidChunkLedger(job, chunks, archiveSha256) {
  if (!Array.isArray(chunks) || chunks.length === 0) return false;
  let completedBytes = 0;
  let expectedStart = 0;
  let pendingSeen = false;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (!chunk || chunk.jobId !== job.jobId ||
        chunk.startByte !== expectedStart ||
        !Number.isSafeInteger(chunk.endByteExclusive) ||
        chunk.endByteExclusive <= chunk.startByte ||
        chunk.endByteExclusive - chunk.startByte > B3_DOWNLOAD_CHUNK_BYTES ||
        chunk.endByteExclusive > job.expectedBytes ||
        !['pending', 'complete'].includes(chunk.state) ||
        (pendingSeen && chunk.state === 'complete') ||
        (chunk.state === 'pending' && chunk.chunkSha256 !== null) ||
        (chunk.state === 'complete' && chunk.chunkSha256 !== archiveSha256)) {
      return false;
    }
    if (chunk.state === 'complete') {
      completedBytes += chunk.endByteExclusive - chunk.startByte;
    } else {
      pendingSeen = true;
    }
    expectedStart = chunk.endByteExclusive;
  }
  return expectedStart === job.expectedBytes && completedBytes === job.completedBytes;
}

function assertJobAuthority(job, authority) {
  if (!job || job.jobId !== authority.jobId || job.packId !== authority.packId ||
      job.version !== authority.version || job.manifestSha256 !== authority.manifestSha256 ||
      job.archiveName !== authority.archiveName || job.archiveSha256 !== authority.archiveSha256 ||
      job.expectedBytes !== authority.compressedBytes || job.etag !== authority.etag) {
    throw downloadError('DOWNLOAD_JOB_AUTHORITY_MISMATCH');
  }
  return job;
}

export function createDownloadCoordinator(rawDependencies) {
  const dependencies = requireDependencies(rawDependencies);
  const {
    gateway, packTransfer, packRepository, manifestVerifier, keyring,
    activeEntitlementProjection, entitlementRepository,
    currentAppVersion, currentSchemaVersion, clock, chunkSize,
  } = dependencies;
  let tail = Promise.resolve();
  let lastTimestamp = -1;

  function serialise(operation) {
    const run = tail.then(operation, operation);
    tail = run.catch(() => {});
    return run;
  }

  function sampleWallMilliseconds() {
    const sampled = clock();
    const milliseconds = sampled instanceof Date ? sampled.getTime() : sampled;
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new TypeError('Download clock is invalid.');
    }
    return milliseconds;
  }

  function nextDurableTimestamp() {
    const next = Math.max(sampleWallMilliseconds(), lastTimestamp + 1);
    if (!Number.isSafeInteger(next)) throw new TypeError('Download timestamp overflowed.');
    lastTimestamp = next;
    return next;
  }

  function absorbEntitlementTimestampFloor(activeEntitlement) {
    if (!Number.isSafeInteger(activeEntitlement.refreshedAt) ||
        activeEntitlement.refreshedAt < 0) {
      throw downloadError('DOWNLOAD_ENTITLEMENT_TIMESTAMP_INVALID');
    }
    lastTimestamp = Math.max(lastTimestamp, activeEntitlement.refreshedAt);
    if (lastTimestamp === Number.MAX_SAFE_INTEGER) {
      throw new TypeError('Download timestamp overflowed.');
    }
  }

  function absorbJobTimestampFloor(job) {
    if (!Number.isSafeInteger(job.updatedAt) || job.updatedAt < 0) {
      throw downloadError('DOWNLOAD_JOB_TIMESTAMP_INVALID');
    }
    lastTimestamp = Math.max(lastTimestamp, job.updatedAt);
    if (lastTimestamp === Number.MAX_SAFE_INTEGER) {
      throw new TypeError('Download timestamp overflowed.');
    }
  }

  // Entitlement reads remain a zero-argument projection. Rotation uses the
  // explicit app-wide SQLite CAS port; pack repositories never receive either
  // handle or a capability URL.
  async function readActiveEntitlement() {
    return activeEntitlementProjection();
  }

  async function authorise(sealedRefreshHandle) {
    const activeEntitlement = await readActiveEntitlement();
    assertSubmittedDownloadEntitlement({
      activeEntitlement,
      submittedSealedRefreshHandle: sealedRefreshHandle,
    });
    absorbEntitlementTimestampFloor(activeEntitlement);
    const authorisation = await gateway.authorisePackDownload({
      sealedRefreshHandle,
      packId: PACK_ID,
      version: VERSION,
    });
    const verificationMilliseconds = sampleWallMilliseconds();
    const envelopeBytes = decodeBase64(authorisation.signedManifestEnvelopeBase64);
    const verifiedManifest = await manifestVerifier({
      envelopeBytes,
      keyring,
      environment: 'sandbox',
      clock: () => new Date(verificationMilliseconds),
    });
    const authority = createVerifiedDownloadAuthority({
      authorisation,
      verifiedManifest,
      envelopeSha256: await sha256Hex(envelopeBytes),
      activeEntitlement,
      submittedSealedRefreshHandle: sealedRefreshHandle,
      currentAppVersion,
      currentSchemaVersion,
      nowUnixSeconds: Math.floor(verificationMilliseconds / 1_000),
    });
    if (authorisation.sealedRefreshHandle !== sealedRefreshHandle) {
      const adopted = await entitlementRepository.compareAndSwapSealedRefreshHandle({
        entitlementId: 'full-ks2',
        expectedSealedRefreshHandle: sealedRefreshHandle,
        sealedRefreshHandle: authorisation.sealedRefreshHandle,
        refreshHandleVersion: authorisation.refreshHandleVersion,
        refreshedAt: nextDurableTimestamp(),
      });
      assertSubmittedDownloadEntitlement({
        activeEntitlement: adopted,
        submittedSealedRefreshHandle: authorisation.sealedRefreshHandle,
      });
      if (adopted.refreshHandleVersion !== authorisation.refreshHandleVersion) {
        throw downloadError('DOWNLOAD_REFRESH_HANDLE_ADOPTION_MISMATCH');
      }
    }
    return Object.freeze({
      authority,
      sealedRefreshHandle: authorisation.sealedRefreshHandle,
    });
  }

  async function ensureJob(authority) {
    let job = await packRepository.getDownloadJob({ jobId: authority.jobId });
    const existingJob = job !== null;
    if (!job) {
      job = await packRepository.upsertDownloadJob({
        jobId: authority.jobId,
        packId: authority.packId,
        version: authority.version,
        manifestSha256: authority.manifestSha256,
        archiveName: authority.archiveName,
        archiveSha256: authority.archiveSha256,
        expectedBytes: authority.compressedBytes,
        completedBytes: 0,
        etag: authority.etag,
        state: 'queued',
        updatedAt: nextDurableTimestamp(),
      });
    }
    assertJobAuthority(job, authority);
    if (existingJob) absorbJobTimestampFloor(job);
    if (job.state === 'failed' || job.state === 'queued') {
      ({ job } = await restartChunkPlan(job));
    } else if (job.state === 'downloading') {
      const chunks = await packRepository.listDownloadChunks({ jobId: job.jobId });
      if (!isValidChunkLedger(job, chunks, authority.archiveSha256)) {
        ({ job } = await restartChunkPlan(job));
      }
    }
    return job;
  }

  async function assertStorage(job, authority) {
    const required = requiredFreeBytes({
      remainingCompressedBytes: job.expectedBytes - job.completedBytes,
      fullExtractedBytes: authority.extractedBytes,
      stagingMetadataBytes: STAGING_METADATA_BYTES,
    });
    const free = await packTransfer.getFreeBytes();
    if (!Number.isSafeInteger(free) || free < required) {
      throw Object.assign(downloadError('DOWNLOAD_STORAGE_INSUFFICIENT'), { requiredBytes: required });
    }
  }

  async function restartChunkPlan(job) {
    await packRepository.clearDownloadChunks({
      jobId: job.jobId,
      updatedAt: nextDurableTimestamp(),
    });
    if (job.state === 'downloading') {
      job = await packRepository.updateDownloadJob({
        jobId: job.jobId, expectedState: 'downloading', state: 'failed',
        etag: job.etag, updatedAt: nextDurableTimestamp(),
      });
    }
    if (job.state === 'failed') {
      job = await packRepository.updateDownloadJob({
        jobId: job.jobId, expectedState: 'failed', state: 'queued',
        etag: job.etag, updatedAt: nextDurableTimestamp(),
      });
    }
    if (job.state !== 'queued') throw downloadError('DOWNLOAD_JOB_STATE_INVALID');
    await packRepository.replaceDownloadChunks({
      jobId: job.jobId,
      chunks: makeChunks(job.jobId, job.expectedBytes, chunkSize),
    });
    job = await packRepository.updateDownloadJob({
      jobId: job.jobId, expectedState: 'queued', state: 'downloading',
      etag: job.etag, updatedAt: nextDurableTimestamp(),
    });
    return { job, chunks: await packRepository.listDownloadChunks({ jobId: job.jobId }) };
  }

  async function download(authority, job, sealedRefreshHandle) {
    if (job.state === 'downloaded' || job.state === 'extracting' || job.state === 'ready') {
      return Object.freeze({ state: job.state, job });
    }
    if (job.state !== 'downloading') throw downloadError('DOWNLOAD_JOB_STATE_INVALID');
    await assertStorage(job, authority);
    let chunks = await packRepository.listDownloadChunks({ jobId: job.jobId });
    let renewals = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (chunk.state === 'complete') continue;
      let result;
      try {
        result = await packTransfer.downloadRange({
          capabilityUrl: authority.capabilityUrl,
          packId: authority.packId,
          version: authority.version,
          archiveName: authority.archiveName,
          startByte: chunk.startByte,
          endByteExclusive: chunk.endByteExclusive,
          truncate: chunk.startByte === 0,
        });
      } catch (error) {
        if (!['PACK_CAPABILITY_EXPIRED', 'PACK_RANGE_NOT_SATISFIABLE'].includes(error?.code)) {
          throw error;
        }
        if (renewals >= 1) throw downloadError('DOWNLOAD_CAPABILITY_RENEWAL_EXHAUSTED');
        renewals += 1;
        const renewed = await authorise(sealedRefreshHandle);
        authority = renewed.authority;
        sealedRefreshHandle = renewed.sealedRefreshHandle;
        if (error.code === 'PACK_RANGE_NOT_SATISFIABLE') {
          ({ job, chunks } = await restartChunkPlan(job));
          await assertStorage(job, authority);
          index = -1;
          continue;
        }
        index -= 1;
        continue;
      }
      if (result.status === 200 && chunk.startByte !== 0) {
        ({ job, chunks } = await restartChunkPlan(job));
        await assertStorage(job, authority);
        index = -1;
        continue;
      }
      const acceptedStatus = result.status === 206 ||
        (result.status === 200 && chunk.startByte === 0 &&
         chunk.endByteExclusive === authority.compressedBytes);
      if (!acceptedStatus || result.startByte !== chunk.startByte ||
          result.endByteExclusive !== chunk.endByteExclusive ||
          result.totalBytes !== authority.compressedBytes || result.etag !== authority.etag) {
        ({ job, chunks } = await restartChunkPlan(job));
        throw downloadError('DOWNLOAD_RANGE_AUTHORITY_MISMATCH');
      }
      await packRepository.completeDownloadChunk({
        jobId: job.jobId,
        startByte: chunk.startByte,
        endByteExclusive: chunk.endByteExclusive,
        // The native bridge owns bytes and final archive hashing; this durable
        // marker is deliberately the immutable archive authority, not an ETag.
        chunkSha256: authority.archiveSha256,
        updatedAt: nextDurableTimestamp(),
      });
    }
    let inspection;
    try {
      inspection = await packTransfer.inspectAndExtract({
        packId: authority.packId,
        version: authority.version,
        archiveName: authority.archiveName,
        signedManifestEnvelopeBase64: authority.signedManifestEnvelopeBase64,
      });
    } catch (error) {
      ({ job } = await restartChunkPlan(job));
      await packTransfer.removeOwnedTemporaryState({
        packId: authority.packId,
        version: authority.version,
      });
      throw error;
    }
    if (
      inspection.archiveSha256 !== authority.archiveSha256 ||
      inspection.manifestSha256 !== authority.manifestSha256 ||
      inspection.extractedBytes !== authority.extractedBytes ||
      inspection.fileCount !== authority.fileCount
    ) {
      ({ job } = await restartChunkPlan(job));
      await packTransfer.removeOwnedTemporaryState({
        packId: authority.packId,
        version: authority.version,
      });
      throw downloadError('DOWNLOAD_FINAL_INTEGRITY_MISMATCH');
    }
    job = await packRepository.updateDownloadJob({
      jobId: job.jobId, expectedState: 'downloading', state: 'downloaded',
      etag: authority.etag, updatedAt: nextDurableTimestamp(),
    });
    return Object.freeze({ state: 'downloaded', job });
  }

  async function run(input) {
    const value = exactInput(input, ['sealedRefreshHandle']);
    if (typeof value.sealedRefreshHandle !== 'string' || value.sealedRefreshHandle.length === 0) {
      throw new TypeError('Sealed refresh handle is invalid.');
    }
    // Authorisation and full signed-manifest trust deliberately precede all job,
    // chunk, archive-network and native mutations.
    const authorised = await authorise(value.sealedRefreshHandle);
    const job = await ensureJob(authorised.authority);
    return download(authorised.authority, job, authorised.sealedRefreshHandle);
  }

  async function queue(input) {
    if (arguments.length !== 1) throw new TypeError('queue requires one input.');
    return serialise(() => run(input));
  }
  async function resume(input) {
    if (arguments.length !== 1) throw new TypeError('resume requires one input.');
    return serialise(() => run(input));
  }
  async function retry(input) {
    if (arguments.length !== 1) throw new TypeError('retry requires one input.');
    return serialise(() => run(input));
  }
  async function cancelTemporary(input) {
    if (arguments.length !== 1) throw new TypeError('cancelTemporary requires one input.');
    const value = exactInput(input, ['jobId']);
    if (value.jobId !== `${PACK_ID}.${VERSION}`) throw new TypeError('Download job is invalid.');
    return serialise(async () => {
      const deleted = await packRepository.deleteDownloadJob({ jobId: value.jobId });
      await packTransfer.removeOwnedTemporaryState({ packId: PACK_ID, version: VERSION });
      return deleted;
    });
  }

  const coordinator = { queue, resume, retry, cancelTemporary };
  if (Reflect.ownKeys(coordinator).some((key) => !METHODS.includes(key))) {
    throw new TypeError('Download coordinator surface is invalid.');
  }
  return Object.freeze(coordinator);
}
