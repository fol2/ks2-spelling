import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('gateway dependency and Worker authority pins are exact', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../gateway/package.json', import.meta.url)));
  const wrangler = JSON.parse((await readFile(new URL('../gateway/wrangler.jsonc', import.meta.url), 'utf8')).replace(/^\s*\/\/.*$/gm, ''));
  assert.equal(packageJson.dependencies['@apple/app-store-server-library'], '3.1.0');
  assert.equal(packageJson.devDependencies.wrangler, '4.110.0');
  assert.equal(packageJson.devDependencies.miniflare, '4.20260708.1');
  assert.equal(wrangler.compatibility_date, '2026-07-12');
  assert.deepEqual(wrangler.compatibility_flags, ['nodejs_compat']);
  assert.deepEqual(wrangler.version_metadata, { binding: 'WORKER_VERSION_METADATA' });
  assert.deepEqual(wrangler.rules, [
    { type: 'Data', globs: ['**/*.der'], fallthrough: true },
  ]);
});

test('official Apple Root CA G3 bytes match the closed source manifest and parse as X.509', async () => {
  const certificate = await readFile(new URL('../gateway/config/apple-root-certificates/AppleRootCA-G3.der', import.meta.url));
  const manifest = JSON.parse(await readFile(new URL('../gateway/config/apple-root-certificates.json', import.meta.url)));
  const fixture = JSON.parse(await readFile(new URL('./fixtures/apple/x509-chain-fixture.json', import.meta.url)));
  const verifierSource = await readFile(new URL('../gateway/src/apple-store-verifier.js', import.meta.url), 'utf8');
  assert.deepEqual(Object.keys(manifest), ['schemaVersion', 'certificates']);
  assert.deepEqual(Object.keys(manifest.certificates[0]), ['name', 'sourceUrl', 'sha256']);
  assert.equal(manifest.certificates[0].name, 'AppleRootCA-G3.der');
  assert.equal(manifest.certificates[0].sourceUrl, 'https://www.apple.com/certificateauthority/AppleRootCA-G3.cer');
  assert.equal(createHash('sha256').update(certificate).digest('hex'), manifest.certificates[0].sha256);
  assert.match(verifierSource, /apple-root-certificates\/AppleRootCA-G3\.der/);
  assert.doesNotMatch(verifierSource, /MIICQzCCAcmgAwIB/);
  const parsed = new X509Certificate(certificate);
  assert.equal(fixture.root, manifest.certificates[0].name);
  assert.match(parsed.subject, new RegExp(fixture.expectedSubject));
  assert.equal(parsed.ca, true);
});

test('real Miniflare/workerd imports Apple 3.1.0 and intercepts Apple and Google API fetches', async () => {
  const { Miniflare } = await import('../gateway/node_modules/miniflare/dist/src/index.js');
  const fixture = JSON.parse(await readFile(new URL('./fixtures/apple/app-store-api-response.json', import.meta.url)));
  const output = await mkdtemp(join(tmpdir(), 'ks2-gateway-workerd-'));
  try {
    await execFileAsync(
      new URL('../gateway/node_modules/.bin/wrangler', import.meta.url).pathname,
      ['deploy', '--dry-run', '--outdir', output],
      {
        cwd: new URL('../gateway/', import.meta.url).pathname,
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      },
    );
    const runtime = new Miniflare({
      modules: true,
      modulesRoot: output,
      modulesRules: [
        { type: 'Data', include: ['**/*.der'] },
        { type: 'ESModule', include: ['**/*.js'] },
      ],
      compatibilityDate: '2026-07-12',
      compatibilityFlags: ['nodejs_compat'],
      scriptPath: join(output, 'handler.js'),
    });
    try {
      const response = await runtime.dispatchFetch('https://worker.test/v1/entitlements/verify', {
        method: 'OPTIONS',
        headers: {
          Origin: 'capacitor://localhost',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Content-Type',
        },
      });
      assert.equal(response.status, 204);
    } finally {
      await runtime.dispose();
    }
  } finally {
    await rm(output, { recursive: true, force: true });
  }

  let intercepted = 0;
  const apiOutput = await mkdtemp(join(tmpdir(), 'ks2-apple-api-workerd-'));
  await execFileAsync(
    new URL('../gateway/node_modules/.bin/wrangler', import.meta.url).pathname,
    [
      'deploy', new URL('./fixtures/apple/workerd-api-fetch-worker.mjs', import.meta.url).pathname,
      '--dry-run', '--outdir', apiOutput,
      '--config', new URL('../gateway/wrangler.jsonc', import.meta.url).pathname,
    ],
    {
      cwd: new URL('../gateway/', import.meta.url).pathname,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    },
  );
  const privateKey = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
  const outbound = new Miniflare({
    modules: true,
    modulesRoot: apiOutput,
    modulesRules: [
      { type: 'Data', include: ['**/*.der'] },
      { type: 'ESModule', include: ['**/*.js'] },
    ],
    compatibilityDate: '2026-07-12',
    compatibilityFlags: ['nodejs_compat'],
    scriptPath: join(apiOutput, 'workerd-api-fetch-worker.js'),
    bindings: { APPLE_TEST_PRIVATE_KEY: privateKey },
    outboundService: async (request) => {
      intercepted += 1;
      const url = new URL(request.url);
      if (url.origin === 'https://api.storekit-sandbox.apple.com') {
        assert.equal(url.pathname, '/inApps/v1/transactions/1234567890');
        return Response.json(fixture);
      }
      if (url.origin === 'https://oauth2.googleapis.com') {
        return Response.json({ access_token: 'runtime-access', expires_in: 3600 });
      }
      assert.equal(url.origin, 'https://androidpublisher.googleapis.com');
      if (url.pathname.includes('/purchases/productsv2/')) {
        return Response.json({
          productLineItem: [{ productId: 'full_ks2' }],
          purchaseStateContext: { purchaseState: 'PURCHASED' },
          testPurchaseContext: { fopType: 'TEST' },
          orderId: 'GPA.1234-5678-9012-34567',
          acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
        });
      }
      assert.match(url.pathname, /\/purchases\/products\/full_ks2\/tokens\/runtime-token:acknowledge$/);
      return new Response(null, { status: 204 });
    },
  });
  try {
    const response = await outbound.dispatchFetch('https://worker.test/runtime-proof');
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.deepEqual(JSON.parse(text), {
      transactionInfo: fixture,
      verifierAvailable: true,
      verifierOnlineChecks: false,
    });
    const google = await outbound.dispatchFetch('https://worker.test/google');
    const googleText = await google.text();
    assert.equal(google.status, 200, googleText);
    assert.deepEqual(JSON.parse(googleText), {
      state: 'active',
      storeTransactionId: 'GPA.1234-5678-9012-34567',
      acknowledged: true,
    });
    assert.equal(intercepted, 4);
  } finally {
    await outbound.dispose();
    await rm(apiOutput, { recursive: true, force: true });
  }
});
