import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { assertB3GatewayAuthority } from '../src/domain/commerce/commerce-contracts.js';

const AUTHORITY_URL = new URL('../config/b3-gateway-authority.json', import.meta.url);

async function readAuthority() {
  return JSON.parse(await readFile(AUTHORITY_URL, 'utf8'));
}

function clone(value) {
  return structuredClone(value);
}

test('gateway authority binds the approved sandbox and native distributions', async () => {
  const authority = await readAuthority();

  assert.equal(assertB3GatewayAuthority(authority), authority);
  assert.deepEqual(authority, {
    schemaVersion: 1,
    environment: 'sandbox',
    cloudflareAccountId: '6d00cb4a0396c17ad6ba617bcbcaa45d',
    workerName: 'ks2-spelling-b3-sandbox',
    privateR2BucketName: 'ks2-spelling-b3-sandbox-packs',
    publicSandboxOrigin: 'https://b3-gateway.eugnel.uk',
    allowedOrigins: ['capacitor://localhost', 'http://localhost'],
    distribution: {
      applicationId: 'uk.eugnel.ks2spelling',
      iosKind: 'development',
      androidTrack: 'internal',
    },
  });
});

test('gateway authority rejects placeholders, unsafe origins and shape drift', async () => {
  const valid = await readAuthority();
  const mutations = [
    (value) => { value.extra = true; },
    (value) => { value.environment = 'production'; },
    (value) => { value.cloudflareAccountId = 'placeholder'; },
    (value) => { value.cloudflareAccountId = '0'.repeat(32); },
    (value) => { value.workerName = 'ks2-spelling-production'; },
    (value) => { value.privateR2BucketName = 'example-bucket'; },
    (value) => { value.publicSandboxOrigin = 'http://b3-gateway.eugnel.uk'; },
    (value) => { value.publicSandboxOrigin = 'https://user@b3-gateway.eugnel.uk'; },
    (value) => { value.publicSandboxOrigin = 'https://b3-gateway.eugnel.uk/path'; },
    (value) => { value.publicSandboxOrigin = 'https://b3-gateway.eugnel.uk?x=1'; },
    (value) => { value.allowedOrigins = ['*']; },
    (value) => { value.allowedOrigins.push('https://example.com'); },
    (value) => { value.distribution.applicationId = 'uk.eugnel.placeholder'; },
    (value) => { value.distribution.iosKind = 'app-store'; },
    (value) => { value.distribution.androidTrack = 'production'; },
    (value) => { value.distribution.extra = true; },
  ];

  for (const mutate of mutations) {
    const candidate = clone(valid);
    mutate(candidate);
    assert.throws(() => assertB3GatewayAuthority(candidate), /gateway authority/i);
  }
});
