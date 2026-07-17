import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { canonicaliseB3ProofValue } from '../../src/app/b3-live-proof-protocol.js';
import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

if (typeof process.send !== 'function') {
  throw new Error('B3 recovery competition IPC is absent');
}
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

function databaseBytes() {
  return readFileSync(resolve(
    '.native-build', 'b3', 'evidence', 'ios-capture-state', 'recovery.sqlite',
  ));
}

const operation = process.argv[2];
const captureId = process.argv[3];
const store = await openB3CaptureStore({ platform: 'ios' });

try {
  const authority = operation === 'ordinary'
    ? (await store.readActiveCommand()).command
    : operation === 'allocator'
      ? freshCommand(captureId)
      : await store.pinRecoveryInvocation({ acknowledgeReinstall: true });
  process.send({ type: 'ready' });
  process.once('message', async (message) => {
    if (message?.type !== 'go') {
      throw new Error('B3 recovery competition barrier differs');
    }
    try {
      if (operation === 'ordinary') {
        const before = databaseBytes();
        try {
          await store.transitionCommand({ source: authority, nextState: 'launched' });
          process.send({
            type: 'result',
            ok: true,
            outcome: { status: 'transitioned' },
          });
        } catch (error) {
          process.send({
            type: 'result',
            ok: true,
            outcome: { status: 'rejected' },
            databaseIdentical: before.equals(databaseBytes()),
            rejection: {
              code: error?.code ?? null,
              message: error?.message ?? String(error),
            },
          });
        }
      } else if (operation === 'allocator') {
        const before = databaseBytes();
        try {
          await store.allocateNextCommand({ command: authority });
          process.send({
            type: 'result',
            ok: true,
            outcome: { status: 'allocated' },
          });
        } catch (error) {
          process.send({
            type: 'result',
            ok: true,
            outcome: { status: 'rejected' },
            databaseIdentical: before.equals(databaseBytes()),
            rejection: {
              code: error?.code ?? null,
              message: error?.message ?? String(error),
            },
          });
        }
      } else if (operation === 'recovery') {
        const outcome = await store.finaliseRecoveryInvocation({
          invocation: authority,
          distribution,
          freshCommand: freshCommand(captureId),
        });
        process.send({ type: 'result', ok: true, outcome });
      } else {
        throw new Error(`B3 recovery competition operation ${operation} is unknown`);
      }
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
