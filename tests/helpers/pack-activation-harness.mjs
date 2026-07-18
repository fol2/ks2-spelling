import assert from 'node:assert/strict';

import {
  ARCHIVE_ETAG,
  ARCHIVE_SHA,
  ENVELOPE_SHA,
  JOB_ID,
  NOW,
  PACK_ID,
  VERSION,
  envelopeBytes,
  keyring,
  realManifestVerifier,
} from './range-fixture-server.mjs';

const ENVELOPE = Buffer.from(envelopeBytes).toString('base64');

export function activationHarness({
  crashInjector = () => {},
  jobUpdatedAt = NOW - 10,
  activeActivatedAt = NOW - 20,
  entitlementActive = true,
  sealFailure = null,
} = {}) {
  const calls = [];
  let job = {
    jobId: JOB_ID,
    packId: PACK_ID,
    version: VERSION,
    manifestSha256: ENVELOPE_SHA,
    archiveName: `${PACK_ID}.zip`,
    archiveSha256: ARCHIVE_SHA,
    expectedBytes: 1_324,
    completedBytes: 1_324,
    etag: ARCHIVE_ETAG,
    state: 'downloaded',
    updatedAt: jobUpdatedAt,
  };
  let active = {
    packId: PACK_ID,
    version: '0.9.0',
    manifestSha256: '9'.repeat(64),
    pathToken: `installed/${PACK_ID}/0.9.0`,
    activatedAt: activeActivatedAt,
  };
  const installedRows = [];
  let inventory = [];
  const packTransfer = {
    async inventoryInstalledVersions() {
      calls.push('inventory');
      return structuredClone(inventory);
    },
    async inspectAndExtract(request) {
      calls.push('extract');
      assert.equal(request.signedManifestEnvelopeBase64, ENVELOPE);
      return {
        archiveSha256: ARCHIVE_SHA,
        manifestSha256: ENVELOPE_SHA,
        extractedBytes: 1_082,
        fileCount: 2,
        stagingToken: `staging/${PACK_ID}/${VERSION}`,
      };
    },
    async sealAndInstall() {
      calls.push('seal');
      if (sealFailure === 'before-rename') {
        sealFailure = null;
        throw Object.assign(new Error('native failure'), {
          code: 'PACK_TRANSFER_NATIVE_FAILURE',
        });
      }
      const sealed = {
        packId: PACK_ID,
        version: VERSION,
        manifestSha256: ENVELOPE_SHA,
        installedPathToken: `installed/${PACK_ID}/${VERSION}`,
        activationMarkerSha256: 'a'.repeat(64),
      };
      inventory = [sealed];
      if (sealFailure === 'lost-result-after-rename') {
        sealFailure = null;
        throw Object.assign(new Error('lost native result'), {
          code: 'PACK_TRANSFER_NATIVE_FAILURE',
        });
      }
      return {
        installedPathToken: sealed.installedPathToken,
        activationMarkerSha256: sealed.activationMarkerSha256,
      };
    },
  };
  const packRepository = {
    async getDownloadJob() { return structuredClone(job); },
    async listInstalledVersions() { return structuredClone(installedRows); },
    async getActiveVersion() { return structuredClone(active); },
    async updateDownloadJob(command) {
      calls.push(`job:${command.expectedState}->${command.state}`);
      assert.equal(job.state, command.expectedState);
      job = { ...job, state: command.state, updatedAt: command.updatedAt };
      return structuredClone(job);
    },
    async registerAndFlipActiveVersion({
      requiredEntitlementId, installedVersion, activeVersion,
    }) {
      calls.push('register+flip');
      assert.equal(requiredEntitlementId, 'full-ks2');
      if (!entitlementActive) {
        throw Object.assign(new Error('sqlite_pack_entitlement_inactive'), {
          code: 'sqlite_pack_entitlement_inactive',
        });
      }
      assert.equal(installedVersion.manifestSha256, ENVELOPE_SHA);
      assert.equal(installedVersion.activationMarkerSha256, 'a'.repeat(64));
      const existing = installedRows.find((row) => row.version === installedVersion.version);
      if (existing) assert.deepEqual(existing, installedVersion);
      else installedRows.push(structuredClone(installedVersion));
      active = structuredClone(activeVersion);
      return structuredClone(active);
    },
  };
  return {
    calls,
    dependencies: {
      packTransfer,
      packRepository,
      manifestVerifier: realManifestVerifier,
      keyring,
      environment: 'sandbox',
      clock: () => new Date(NOW),
      crashInjector,
    },
    input: { packId: PACK_ID, version: VERSION, signedManifestEnvelope: ENVELOPE },
    snapshot: () => structuredClone({ active, installedRows, inventory, job }),
  };
}
