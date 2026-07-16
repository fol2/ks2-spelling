import assert from 'node:assert/strict';
import test from 'node:test';

import { createB3CaptureRecoveryStore } from '../scripts/lib/b3-capture-recovery-store.mjs';
import {
  B3_TEST_COMMIT,
  B3_TEST_HASH,
  platformEvidence,
} from './helpers/b3-evidence-fixtures.mjs';

function buildAuthority(platform) {
  return Object.freeze({
    testedApplicationCommit: B3_TEST_COMMIT,
    applicationFingerprint: B3_TEST_HASH,
    versionName: '0.3.0-b3',
    buildNumber: platform === 'ios' ? '19' : 19,
  });
}

function createStore(platform, bridge) {
  return createB3CaptureRecoveryStore({
    platform,
    buildAuthority: async () => buildAuthority(platform),
    transitionalBridge: bridge,
  });
}

test('recovery store rejects reduced or non-closed distribution projections before recovery mutation', async () => {
  for (const [platform, distribution] of [
    ['ios', platformEvidence().distribution],
    ['android', platformEvidence('android-play-physical').distribution],
  ]) {
    let bridgeMutations = 0;
    const store = createStore(platform, {
      pinInvocation: async () => Object.freeze({ legacy: platform }),
      finaliseInvocation: async () => {
        bridgeMutations += 1;
        return false;
      },
    });
    const invalid = [
      {
        kind: distribution.kind,
        embeddedCommit: distribution.embeddedCommit,
        embeddedFingerprint: distribution.embeddedFingerprint,
      },
      { ...distribution, unexpected: true },
      Object.fromEntries(Object.entries(distribution).slice(0, -1)),
    ];
    if (platform === 'android') {
      invalid.push({
        ...distribution,
        installedApks: distribution.installedApks.map((apk, index) =>
          index === 0 ? { ...apk, unexpected: true } : apk),
      });
    }
    for (const candidate of invalid) {
      const invocation = await store.pinInvocation({ acknowledgeReinstall: true });
      await assert.rejects(
        store.finaliseInvocation({ invocation, distribution: candidate }),
        /distribution.*invalid|distribution.*authority/i,
      );
    }
    assert.equal(bridgeMutations, 0);
  }
});

test('recovery store binds reinstall acknowledgement to the opaque pin passed to finalisation', async () => {
  let finalisationAuthority;
  const store = createStore('ios', {
    pinInvocation: async () => Object.freeze({ legacy: 'authority' }),
    finaliseInvocation: async (authority) => {
      finalisationAuthority = authority;
      return false;
    },
  });
  const invocation = await store.pinInvocation({ acknowledgeReinstall: true });
  await store.finaliseInvocation({
    invocation,
    distribution: platformEvidence().distribution,
  });
  assert.deepEqual(finalisationAuthority, {
    legacyAuthority: { legacy: 'authority' },
    acknowledgeReinstall: true,
  });
});
