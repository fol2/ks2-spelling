import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  B3_FINGERPRINT_EXCLUDED_PREFIXES,
  B3_FINGERPRINT_REQUIRED_INPUTS,
  assertRequiredB3FingerprintInputs,
  fingerprintB3Application,
} from '../scripts/fingerprint-b3-application.mjs';

test('application fingerprint covers app, gateway, native, lock and proof-wrapper inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'b3-fingerprint-'));
  const files = [
    'src/app.js', 'gateway/src/handler.js', 'config/mobile-identity.json',
    'ios/App/App/AppDelegate.swift', 'android/app/build.gradle',
    'scripts/prove-b3-ios.mjs', 'package-lock.json', 'gateway/package-lock.json',
  ];
  for (const path of files) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), `${path}\n`);
  }
  const baseline = await fingerprintB3Application({ root, files });
  assert.equal(baseline.files.length, files.length);
  for (const path of files) {
    await writeFile(join(root, path), `${path}\nchanged\n`);
    const changed = await fingerprintB3Application({ root, files });
    assert.notEqual(changed.sha256, baseline.sha256, path);
    await writeFile(join(root, path), `${path}\n`);
  }
});

test('application fingerprint excludes evidence, dependencies, secrets and generated output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'b3-fingerprint-excluded-'));
  const files = ['src/app.js', 'reports/b3/live.json', 'screenshots/proof.png', '.native-build/b3/proof.json', 'node_modules/x/index.js', '.env', 'ios/App/Signing.p12'];
  for (const path of files) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), path);
  }
  const result = await fingerprintB3Application({ root, files });
  assert.deepEqual(result.files, ['src/app.js']);
  assert.ok(B3_FINGERPRINT_EXCLUDED_PREFIXES.includes('.native-build/'));
});

test('application fingerprint has fail-closed anchors for gateway, proof fixtures and native inputs', () => {
  assert.ok(B3_FINGERPRINT_REQUIRED_INPUTS.includes('gateway/wrangler.jsonc'));
  assert.ok(B3_FINGERPRINT_REQUIRED_INPUTS.includes('tests/fixtures/b3-signed-manifest.json'));
  assert.ok(B3_FINGERPRINT_REQUIRED_INPUTS.includes('tests/fixtures/keys/b3-sandbox-proof-manifest-signature.der'));
  assert.ok(B3_FINGERPRINT_REQUIRED_INPUTS.includes('tests/helpers/hostile-zip-builder.mjs'));
  assert.equal(assertRequiredB3FingerprintInputs(B3_FINGERPRINT_REQUIRED_INPUTS), true);
  for (const removed of B3_FINGERPRINT_REQUIRED_INPUTS) {
    assert.throws(
      () => assertRequiredB3FingerprintInputs(B3_FINGERPRINT_REQUIRED_INPUTS.filter((path) => path !== removed)),
      new RegExp(removed.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')),
    );
  }
});
