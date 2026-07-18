import { createHash } from 'node:crypto';

import { canonicaliseB3ProofValue } from '../../src/app/b3-live-proof-protocol.js';
import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

if (typeof process.send !== 'function') throw new Error('B3 recovery race IPC is absent');
installB3CaptureStateRootMock();
const { openB3CaptureStore } = await import('../../scripts/lib/b3-capture-store.mjs');

const COMMIT = '1'.repeat(40);
const FINGERPRINT = '2'.repeat(64);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function freshCommand(captureId) {
  const unsigned = {
    schemaVersion: 1,
    captureId,
    platform: 'ios-physical',
    testedApplicationCommit: COMMIT,
    applicationFingerprint: FINGERPRINT,
    expectedScenarioIndex: 0,
    expectedSequence: 1,
    previousObservationSha256: '0'.repeat(64),
    installationMode: 'existing',
    actionCode: 'ARM_CAPTURE',
  };
  return Object.freeze({
    ...unsigned,
    challengeSha256: sha256(Buffer.from(
      `ks2-spelling:b3-host-command-challenge:v1\0${canonicaliseB3ProofValue(unsigned)}`,
      'utf8',
    )),
  });
}

const distribution = Object.freeze({
  embeddedCommit: COMMIT,
  embeddedFingerprint: FINGERPRINT,
  versionName: '0.3.0-b3',
  kind: 'development',
  iosBuildNumber: '19',
  signedIpaSha256: '3'.repeat(64),
  ipaEmbeddedAuthoritySha256: '4'.repeat(64),
  codeSigningCertificateSha256: '5'.repeat(64),
  installedBundleId: 'uk.eugnel.ks2spelling',
  installedVersion: '0.3.0-b3',
  installedBuild: '19',
  installedEmbeddedAuthoritySha256: '4'.repeat(64),
  installedBuiltByDeveloper: true,
  sandboxReceiptVerified: true,
});

const store = await openB3CaptureStore({ platform: 'ios' });
try {
  const invocation = await store.pinRecoveryInvocation({ acknowledgeReinstall: true });
  process.send({ type: 'ready' });
  process.once('message', async (message) => {
    if (message?.type !== 'go') throw new Error('B3 recovery race barrier differs');
    try {
      const outcome = await store.finaliseRecoveryInvocation({
        invocation,
        distribution,
        freshCommand: freshCommand(process.argv[2]),
      });
      process.send({ type: 'result', ok: true, outcome });
    } catch (error) {
      process.send({
        type: 'result',
        ok: false,
        error: { code: error?.code ?? null, message: error?.message ?? String(error) },
      });
    } finally {
      await store.close();
      process.disconnect();
    }
  });
} catch (error) {
  process.send({
    type: 'result',
    ok: false,
    error: { code: error?.code ?? null, message: error?.message ?? String(error) },
  });
  await store.close();
  process.disconnect();
}
