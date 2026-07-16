import assert from 'node:assert/strict';
import test from 'node:test';

import { B3_SYNTHETIC_LEARNER_DIGESTS } from '../scripts/lib/b3-evidence.mjs';
import { deriveB3TerminalEvidenceProjection } from '../scripts/lib/b3-live-capture-adapters.mjs';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function authority() {
  return {
    terminal: {
      phase: 'TERMINAL_CAPTURE',
      proofProjection: {
        entitlementAuthority: {
          id: 'full-ks2', state: 'revoked',
          domainSeparatedDigestSha256: HASH_A, refreshHandlePresent: false,
        },
        packAuthority: {
          packId: 'b3-sandbox-proof', manifestSha256: HASH_A,
          archiveSha256: HASH_B, installed: true,
        },
        transactionAuthority: {
          source: 'apple-transaction-id', crossCheckedOnRefresh: true,
          rawProofCleared: true,
        },
        refreshHandleLifecycle: {
          present: false, positiveVersionObserved: false, rotated: true, deleted: true,
        },
        gatewaySmokeAuthority: null,
        transportAuthority: {
          storeAdapter: 'concreteCapacitorStore',
          gatewayAdapter: 'concreteHttpGateway', serverUrl: null,
          nativeOriginAllowed: true, noRedirects: true,
        },
      },
    },
    restoreRecord: {
      installationId: '018f1d7b-97e8-4a52-8cf2-783e5089c002',
      proofProjection: {
        entitlementAuthority: { state: 'active', refreshHandlePresent: true },
        packAuthority: { installed: true },
        refreshHandleLifecycle: { present: true, positiveVersionObserved: true },
        syntheticLearners: {
          positionalSnapshotSha256: [
            B3_SYNTHETIC_LEARNER_DIGESTS['after-fresh-install-reseed'].learnerA,
            B3_SYNTHETIC_LEARNER_DIGESTS['after-fresh-install-reseed'].learnerB,
          ],
        },
      },
    },
    preReinstallRecord: {
      installationId: '018f1d7b-97e8-4a52-8cf2-783e5089c001',
    },
    redownloadRecord: {
      proofProjection: { packAuthority: { installed: true } },
    },
    positiveVersionObserved: true,
    redownloadTransitionValidated: true,
  };
}

test('terminal evidence accepts an earlier positive handle version after terminal deletion', () => {
  const result = deriveB3TerminalEvidenceProjection(authority());
  assert.equal(result.refreshHandleLifecycle.positiveVersionObserved, true);
  assert.equal(result.refreshHandleLifecycle.revokedHandleDeleted, true);
  assert.equal(result.refreshHandleLifecycle.rawProofCleared, true);
  assert.equal(result.pack.redownloaded, true);
  assert.equal(result.restore.freshInstall, true);
});

test('terminal evidence rejects privacy, redownload and lifecycle mutations', () => {
  const mutations = [
    (value) => { value.terminal.proofProjection.transactionAuthority.rawProofCleared = false; },
    (value) => { value.redownloadRecord.proofProjection.packAuthority.installed = false; },
    (value) => { value.positiveVersionObserved = false; },
    (value) => { value.redownloadTransitionValidated = false; },
    (value) => { value.restoreRecord.installationId = value.preReinstallRecord.installationId; },
  ];
  for (const mutate of mutations) {
    const value = authority();
    mutate(value);
    assert.throws(
      () => deriveB3TerminalEvidenceProjection(value),
      /terminal retained authority|incomplete|inconsistent/i,
    );
  }
});
