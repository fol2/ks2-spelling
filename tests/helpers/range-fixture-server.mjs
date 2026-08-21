import { createServer } from 'node:http';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { verifySignedPackManifest } from '../../src/domain/packs/pack-signature-verifier.js';
import {
  createB3SignedDownloadAccessContract,
  findB3PackAuthority,
} from '../../src/domain/packs/b3-pack-registry.js';
import { findPackAuthority } from '../../src/domain/packs/pack-registry.js';

export const PACK_ID = 'b3-sandbox-proof';
export const VERSION = '1.0.0-b3.1';
export const JOB_ID = `${PACK_ID}.${VERSION}`;
export const HANDLE = 'b3rh1.1.test-nonce.test-ciphertext';
export const ENVELOPE_SHA = '39b6a788a3686d7cbf1fd4791bce45623af21ef53c60eabc03d955395856218a';
export const ARCHIVE_SHA = '4c2ca2eb4d4bb7ac3347b66e3483dcb6aa71b41958704733bfc471c970ce7664';
export const ARCHIVE_ETAG = '913d2b2485ca6cd31d467bd7228d7e75';
export const NOW = Date.parse('2026-07-14T00:00:00.000Z');

export const envelopeBytes = new Uint8Array(await readFile(
  new URL('../fixtures/b3-signed-manifest.json', import.meta.url),
));
export const keyring = JSON.parse(await readFile(
  new URL('../../config/pack-signing-public-keys.json', import.meta.url),
  'utf8',
));
const parsedEnvelope = JSON.parse(new TextDecoder().decode(envelopeBytes));
export const signedManifest = JSON.parse(
  Buffer.from(parsedEnvelope.canonicalManifestBase64, 'base64').toString('utf8'),
);

export function capabilityUrl({ expires = Math.floor(NOW / 1_000) + 600, cap = 'A'.repeat(43) } = {}) {
  return `https://b3-gateway.eugnel.uk/v1/packs/${PACK_ID}/${VERSION}/${PACK_ID}.zip?expires=${expires}&cap=${cap}`;
}

export function authorisation(overrides = {}) {
  const base = {
    store: 'google',
    productId: 'full_ks2',
    environment: 'sandbox',
    applicationId: 'uk.eugnel.ks2spelling',
    entitlementId: 'full-ks2',
    state: 'active',
    storeTransactionId: 'GPA.1234-5678-9012-34567',
    sealedRefreshHandle: HANDLE,
    refreshHandleVersion: 1,
    traceId: '123e4567-e89b-42d3-a456-426614174000',
    workerVersionId: 'worker-test',
    workerScriptAuthoritySha256: 'a'.repeat(64),
    packId: PACK_ID,
    version: VERSION,
    signedManifestEnvelopeBase64: Buffer.from(envelopeBytes).toString('base64'),
    signedEnvelopeSha256: ENVELOPE_SHA,
    objects: [
      { objectKind: 'manifest', sha256: ENVELOPE_SHA, size: 1_135, etag: 'c76b2858b8345814279a1c92ae64e365' },
      { objectKind: 'archive', sha256: ARCHIVE_SHA, size: 1_324, etag: ARCHIVE_ETAG },
    ],
    archiveCapability: {
      packId: PACK_ID,
      version: VERSION,
      archiveName: `${PACK_ID}.zip`,
      sha256: ARCHIVE_SHA,
      compressedBytes: 1_324,
      etag: ARCHIVE_ETAG,
      capabilityUrl: capabilityUrl(),
    },
  };
  return structuredClone({ ...base, ...overrides });
}

export async function realManifestVerifier(input) {
  return verifySignedPackManifest({
    ...input,
    verifyP256Der: async ({ publicKeySpkiDer, signatureDer, signingInput }) =>
      verify(
        'sha256',
        signingInput,
        createPublicKey({ key: publicKeySpkiDer, format: 'der', type: 'spki' }),
        signatureDer,
      ),
  });
}

export function createMemoryPackRepository(initialJob = null, initialChunks = []) {
  let job = initialJob ? structuredClone(initialJob) : null;
  let chunks = structuredClone(initialChunks);
  const writes = [];
  const repository = {
    async getDownloadJob() { return job ? Object.freeze({ ...job }) : null; },
    async listDownloadChunks() { return Object.freeze(chunks.map((chunk) => Object.freeze({ ...chunk }))); },
    async upsertDownloadJob(value) { writes.push(['upsert', value]); job = structuredClone(value); return Object.freeze({ ...job }); },
    async replaceDownloadChunks({ chunks: values }) { writes.push(['replace', values]); chunks = structuredClone(values); return chunks; },
    async updateDownloadJob({ expectedState, state, etag, updatedAt }) {
      writes.push(['update', expectedState, state]);
      if (job.state !== expectedState) throw Object.assign(new Error('conflict'), { code: 'sqlite_pack_job_conflict' });
      job = { ...job, state, etag, updatedAt };
      return Object.freeze({ ...job });
    },
    async completeDownloadChunk({ startByte, endByteExclusive, chunkSha256, updatedAt }) {
      writes.push(['complete', startByte, endByteExclusive]);
      const index = chunks.findIndex((chunk) => chunk.startByte === startByte);
      chunks[index] = { ...chunks[index], state: 'complete', chunkSha256 };
      job = {
        ...job,
        completedBytes: chunks.filter((chunk) => chunk.state === 'complete')
          .reduce((total, chunk) => total + chunk.endByteExclusive - chunk.startByte, 0),
        updatedAt,
      };
      return Object.freeze({ ...chunks[index] });
    },
    async clearDownloadChunks({ updatedAt }) {
      writes.push(['clear']);
      chunks = [];
      job = { ...job, completedBytes: 0, updatedAt };
      return Object.freeze([]);
    },
    async deleteDownloadJob() { writes.push(['delete']); const existed = job !== null; job = null; chunks = []; return existed; },
  };
  return Object.freeze({
    repository: Object.freeze(repository),
    writes,
    snapshot: () => structuredClone({ job, chunks }),
  });
}

export function createHarness({
  outcomes = null,
  inspection = null,
  freeBytes = 10_000_000,
  initialJob = null,
  initialChunks = [],
  authoriseOutcomes = null,
  manifestVerifier = realManifestVerifier,
  activeEntitlement = null,
  clock = () => NOW,
} = {}) {
  const memory = createMemoryPackRepository(initialJob, initialChunks);
  const calls = {
    gateway: [], entitlementCas: [], downloads: [], inspections: [], removals: [],
  };
  const queuedAuthorisations = [...(authoriseOutcomes ?? [authorisation(), authorisation()])];
  const defaultDownload = {
    status: 206, startByte: 0, endByteExclusive: 1_324,
    totalBytes: 1_324, bytesWritten: 1_324, etag: ARCHIVE_ETAG,
  };
  const queuedDownloads = [...(outcomes ?? [defaultDownload, defaultDownload])];
  const gateway = {
    async authorisePackDownload(request) {
      calls.gateway.push(structuredClone(request));
      const next = queuedAuthorisations.shift();
      if (next instanceof Error) throw next;
      return structuredClone(next);
    },
  };
  const packTransfer = {
    async getFreeBytes() { return freeBytes; },
    async downloadRange(request) {
      calls.downloads.push(structuredClone(request));
      const next = queuedDownloads.shift();
      if (next instanceof Error) throw next;
      return structuredClone(next);
    },
    async inspectAndExtract(request) {
      calls.inspections.push(structuredClone(request));
      return structuredClone(inspection ?? {
        archiveSha256: ARCHIVE_SHA,
        manifestSha256: ENVELOPE_SHA,
        extractedBytes: 1_082,
        fileCount: 2,
        stagingToken: `staging/${PACK_ID}/${VERSION}`,
      });
    },
    async removeOwnedTemporaryState(request) {
      calls.removals.push(structuredClone(request));
      return { removed: true };
    },
  };
  let projectedActive = structuredClone(activeEntitlement ?? {
    entitlementId: 'full-ks2', state: 'active', sealedRefreshHandle: HANDLE,
    refreshHandleVersion: 1, refreshedAt: NOW - 1,
  });
  const entitlementRepository = {
    async compareAndSwapSealedRefreshHandle(command) {
      calls.entitlementCas.push(structuredClone(command));
      if (projectedActive.state !== 'active' ||
          projectedActive.sealedRefreshHandle !== command.expectedSealedRefreshHandle) {
        throw Object.assign(new Error('sqlite_commerce_entitlement_conflict'), {
          code: 'sqlite_commerce_entitlement_conflict',
        });
      }
      projectedActive = {
        ...projectedActive,
        sealedRefreshHandle: command.sealedRefreshHandle,
        refreshHandleVersion: command.refreshHandleVersion,
        refreshedAt: command.refreshedAt,
      };
      return Object.freeze({ ...projectedActive });
    },
  };
  return {
    dependencies: {
      gateway,
      packTransfer,
      packRepository: memory.repository,
      manifestVerifier,
      keyring,
      gatewayOrigin: ['https:', '', 'b3-gateway.eugnel.uk'].join('/'),
      createDownloadAccessContract: createB3SignedDownloadAccessContract,
      activeEntitlementProjection: async () => structuredClone(projectedActive),
      entitlementRepository,
      currentAppVersion: '0.3.0-b3',
      currentSchemaVersion: 2,
      clock,
      chunkSize: 1_048_576,
      // Since the E2.7 join flip the coordinator has no default pack: the b3
      // proof harness binds explicitly to the registry's b3 row.
      packAuthority: findB3PackAuthority(PACK_ID),
    },
    calls,
    memory,
  };
}

// The b3 fixture archive is 1,324 bytes — a single chunk, which makes a
// restart and a resume indistinguishable. Resume across chunks is the core
// property of the N-shard install, so it is proven against a real shard row
// (~30 MiB, 30 chunks) with the real hosted envelope. Bytes are never moved:
// downloadRange is a fake that answers exactly what the registry authority
// says the object is.
export async function createShardHarness({
  packId = 'full-ks2-shard-01',
  failAtDownload = () => null,
  freeBytes = 1_073_741_824,
} = {}) {
  const row = findPackAuthority(packId);
  const envelope = await readFile(new URL(
    `../fixtures/packs/full-ks2-shards/${packId}.signed-manifest.json`,
    import.meta.url,
  ));
  const manifest = JSON.parse(Buffer.from(
    JSON.parse(envelope.toString('utf8')).canonicalManifestBase64, 'base64',
  ).toString('utf8'));
  const chunkCount = Math.ceil(row.archiveBytes / 1_048_576);
  const handle = HANDLE;
  const calls = { gateway: [], downloads: [], inspections: [], removals: [] };
  const memory = createMemoryPackRepository();
  const gateway = {
    async authorisePackDownload(request) {
      calls.gateway.push(structuredClone(request));
      return {
        ...authorisation(),
        packId,
        version: row.version,
        signedManifestEnvelopeBase64: envelope.toString('base64'),
        signedEnvelopeSha256: row.manifestSha256,
        objects: [
          { objectKind: 'manifest', sha256: row.manifestSha256, size: row.manifestBytes, etag: row.manifestEtag },
          { objectKind: 'archive', sha256: row.archiveSha256, size: row.archiveBytes, etag: row.archiveEtag },
        ],
        archiveCapability: {
          packId,
          version: row.version,
          archiveName: row.archiveName,
          sha256: row.archiveSha256,
          compressedBytes: row.archiveBytes,
          etag: row.archiveEtag,
          capabilityUrl: `https://b3-gateway.eugnel.uk/v1/packs/${packId}/${row.version}/${row.archiveName}?expires=${Math.floor(NOW / 1_000) + 600}&cap=${'A'.repeat(43)}`,
        },
      };
    },
  };
  const packTransfer = {
    async getFreeBytes() { return freeBytes; },
    async downloadRange(request) {
      calls.downloads.push(structuredClone(request));
      const failure = failAtDownload(request, calls.downloads.length);
      if (failure) throw failure;
      return {
        status: 206,
        startByte: request.startByte,
        endByteExclusive: request.endByteExclusive,
        totalBytes: row.archiveBytes,
        bytesWritten: request.endByteExclusive - request.startByte,
        etag: row.archiveEtag,
      };
    },
    async inspectAndExtract(request) {
      calls.inspections.push(structuredClone(request));
      return {
        archiveSha256: row.archiveSha256,
        manifestSha256: row.manifestSha256,
        extractedBytes: manifest.files.reduce((total, file) => total + file.bytes, 0),
        fileCount: manifest.files.length,
        stagingToken: `staging/${packId}/${row.version}`,
      };
    },
    async removeOwnedTemporaryState(request) {
      calls.removals.push(structuredClone(request));
      return { removed: true };
    },
  };
  let projectedActive = {
    entitlementId: 'full-ks2', state: 'active', sealedRefreshHandle: handle,
    refreshHandleVersion: 1, refreshedAt: NOW - 1,
  };
  const entitlementRepository = {
    async compareAndSwapSealedRefreshHandle(command) {
      projectedActive = {
        ...projectedActive,
        sealedRefreshHandle: command.sealedRefreshHandle,
        refreshHandleVersion: command.refreshHandleVersion,
        refreshedAt: command.refreshedAt,
      };
      return Object.freeze({ ...projectedActive });
    },
  };
  return {
    row,
    chunkCount,
    dependencies: {
      gateway,
      packTransfer,
      packRepository: memory.repository,
      manifestVerifier: realManifestVerifier,
      keyring,
      gatewayOrigin: ['https:', '', 'b3-gateway.eugnel.uk'].join('/'),
      activeEntitlementProjection: async () => structuredClone(projectedActive),
      entitlementRepository,
      currentAppVersion: '0.3.0-b3',
      currentSchemaVersion: 2,
      clock: () => NOW,
      chunkSize: 1_048_576,
      packAuthority: row,
    },
    calls,
    memory,
  };
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function createRangeFixtureServer(bytes, options = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, range: request.headers.range ?? null });
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
    if (!range || options.ignoreRange) {
      response.writeHead(200, {
        'content-length': bytes.length,
        etag: options.etag ?? 'fixture-etag',
      });
      response.end(bytes);
      return;
    }
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), bytes.length - 1);
    if (start >= bytes.length || end < start) {
      response.writeHead(416, { 'content-range': `bytes */${bytes.length}` });
      response.end();
      return;
    }
    const body = bytes.subarray(start, end + 1);
    response.writeHead(206, {
      'content-length': body.length,
      'content-range': `bytes ${start}-${end}/${bytes.length}`,
      etag: options.etag ?? 'fixture-etag',
    });
    response.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return Object.freeze({
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())),
  });
}
