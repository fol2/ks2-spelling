import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { canonicaliseB3ProofValue } from '../src/app/b3-live-proof-protocol.js';
import {
  captureB3PlayProtectSettingsScreenshot,
  inspectB3PlayProtectRootAttestation,
} from '../scripts/lib/b3-play-protect-attestation.mjs';
import { createB3TestPng } from './helpers/b3-test-png.mjs';

function png() {
  return createB3TestPng({ width: 1080, height: 2400 });
}

test('Play Protect authority binds CLI PNG bytes to a canonical root attestation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-play-protect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const screenshot = await captureB3PlayProtectSettingsScreenshot({ root, bytes: png() });
  const value = {
    schemaVersion: 1,
    platform: 'android-play-physical',
    screenshotPath: screenshot.path,
    screenshotSha256: screenshot.sha256,
    playCertified: true,
  };
  const attestationBytes = Buffer.from(canonicaliseB3ProofValue(value), 'utf8');
  const path = join(
    root,
    '.native-build/b3/evidence/android-play-protect-root-attestation.json',
  );
  await writeFile(path, attestationBytes, { mode: 0o600, flag: 'wx' });

  assert.deepEqual(await inspectB3PlayProtectRootAttestation({ root }), {
    playCertified: true,
    playProtectSettingsScreenshotSha256: screenshot.sha256,
    playProtectRootAttestationSha256:
      createHash('sha256').update(attestationBytes).digest('hex'),
    attestationPath:
      '.native-build/b3/evidence/android-play-protect-root-attestation.json',
  });
});

test('Play Protect authority rejects mismatched or multiply-linked root evidence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-play-protect-reject-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const screenshot = await captureB3PlayProtectSettingsScreenshot({ root, bytes: png() });
  const path = join(
    root,
    '.native-build/b3/evidence/android-play-protect-root-attestation.json',
  );
  await writeFile(path, canonicaliseB3ProofValue({
    schemaVersion: 1,
    platform: 'android-play-physical',
    screenshotPath: screenshot.path,
    screenshotSha256: 'a'.repeat(64),
    playCertified: true,
  }), { mode: 0o600, flag: 'wx' });
  await assert.rejects(inspectB3PlayProtectRootAttestation({ root }), /authority|SHA/i);

  await rm(path);
  await writeFile(path, canonicaliseB3ProofValue({
    schemaVersion: 1,
    platform: 'android-play-physical',
    screenshotPath: screenshot.path,
    screenshotSha256: screenshot.sha256,
    playCertified: true,
  }), { mode: 0o600, flag: 'wx' });
  const alias = `${path}.alias`;
  await link(path, alias);
  await assert.rejects(inspectB3PlayProtectRootAttestation({ root }), /file policy|link/i);
});
