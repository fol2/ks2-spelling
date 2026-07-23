import assert from 'node:assert/strict';

import {
  ARCHIVE_ETAG,
  ARCHIVE_SHA,
  ENVELOPE_SHA,
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
  packId = PACK_ID,
  requiredEntitlementId = 'full-ks2',
  sealFailure = null,
  version = VERSION,
} = {}) {
  const calls = [];
  let job = {
    jobId: `${packId}.${version}`,
    packId,
    version,
    manifestSha256: ENVELOPE_SHA,
    archiveName: `${packId}.zip`,
    archiveSha256: ARCHIVE_SHA,
    expectedBytes: 1_324,
    completedBytes: 1_324,
    etag: ARCHIVE_ETAG,
    state: 'downloaded',
    updatedAt: jobUpdatedAt,
  };
  let active = {
    packId,
    version: '0.9.0',
    manifestSha256: '9'.repeat(64),
    pathToken: `installed/${packId}/0.9.0`,
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
        stagingToken: `staging/${packId}/${version}`,
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
        packId,
        version,
        manifestSha256: ENVELOPE_SHA,
        installedPathToken: `installed/${packId}/${version}`,
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
      requiredEntitlementId: receivedEntitlementId, installedVersion, activeVersion,
    }) {
      calls.push('register+flip');
      assert.equal(receivedEntitlementId, requiredEntitlementId);
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
      manifestVerifier: requiredEntitlementId === 'full-ks2' &&
          packId === PACK_ID && version === VERSION
        ? realManifestVerifier
        : async (input) => {
          const verified = await realManifestVerifier(input);
          return {
            ...verified,
            manifest: {
              ...verified.manifest,
              archive: {
                ...verified.manifest.archive,
                name: `${packId}.zip`,
              },
              packId,
              requiredEntitlementId,
              version,
            },
          };
        },
      keyring,
      environment: 'sandbox',
      clock: () => new Date(NOW),
      crashInjector,
    },
    input: { packId, version, signedManifestEnvelope: ENVELOPE },
    snapshot: () => structuredClone({ active, installedRows, inventory, job }),
  };
}
