import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DELETED = Object.freeze([
  'scripts/lib/b3-capture-bundle-store.mjs',
  'scripts/lib/b3-capture-recovery-store.mjs',
  'scripts/lib/b3-abandoned-capture.mjs',
  'scripts/lib/b3-host-capture-state.mjs',
  'scripts/lib/b3-issued-command.mjs',
  'scripts/lib/b3-physical-observation-journal.mjs',
  'scripts/lib/b3-device-observation.mjs',
]);

test('D5 removes every superseded filesystem capture authority', async () => {
  for (const relative of DELETED) {
    await assert.rejects(access(resolve(ROOT, relative)), /ENOENT/u);
  }
});

test('D5 live composition has no transitional filesystem or checkpoint surface', async () => {
  const path = resolve(ROOT, 'scripts/lib/b3-live-capture-adapters.mjs');
  const source = await readFile(path, 'utf8');
  assert.doesNotMatch(source, /b3-(?:capture-bundle-store|capture-recovery-store|abandoned-capture|host-capture-state|issued-command\.mjs|physical-observation-journal|device-observation)/u);
  assert.doesNotMatch(source, /persistB3DeviceGatewaySmokeProjection|captureB3ValidatedDeviceObservation|resumeB3IssuedDeviceObservation|resumeB3AmbiguousIssuedCommandAfterReinstall|recoverB3AmbiguousCaptureAfterReinstall|createNextB3HostCommand|advanceB3HostCaptureOne/u);
  const adapter = await import('../scripts/lib/b3-live-capture-adapters.mjs');
  for (const removed of [
    'readB3CaptureCheckpoint', 'writeB3CaptureCheckpoint',
    'persistB3DeviceGatewaySmokeProjection', 'advanceB3HostCaptureOne',
  ]) assert.equal(Object.hasOwn(adapter, removed), false);
});

test('D5 pure proof domain is filesystem-free and every final writer uses the closed publisher', async () => {
  const domain = await readFile(
    resolve(ROOT, 'scripts/lib/b3-capture-proof-domain.mjs'),
    'utf8',
  );
  assert.doesNotMatch(
    domain,
    /node:(?:fs|path)|capture-store|capture-state|process\.env|transport|check-b3-external-prerequisites/u,
  );
  assert.match(domain, /signed-manifest-contract\.js/u);
  for (const relative of [
    'scripts/prove-b3-cloudflare.mjs',
    'scripts/prove-b3-ios.mjs',
    'scripts/prove-b3-android.mjs',
    'scripts/lib/b3-live-capture-adapters.mjs',
  ]) {
    const source = await readFile(resolve(ROOT, relative), 'utf8');
    assert.match(source, /publishB3FinalProofOutput/u, relative);
  }
});
