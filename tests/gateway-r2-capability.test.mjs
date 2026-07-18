import assert from 'node:assert/strict';
import test from 'node:test';

const OBJECT_KEY = 'packs/b3-sandbox-proof/1.0.0-b3.1/b3-sandbox-proof.zip';
const NOW_MS = 1_782_865_800_000;
const EXPIRES = 1_782_866_400;
const SECRET = Uint8Array.from({ length: 32 }, (_, index) => index);
const KNOWN_CAPABILITY = 'qd_LNx8OsL4YJTLIdugx-Mkg_3dJYuEqwpOzdazrC7U';

test('R2 capability matches the frozen raw-key HMAC-SHA-256 vector', async () => {
  const { issueR2Capability, verifyR2Capability } = await import('../gateway/src/r2-capability.js');
  const capability = await issueR2Capability({
    method: 'GET',
    objectKey: OBJECT_KEY,
    expiresAt: EXPIRES,
    secret: SECRET,
    clock: () => NOW_MS,
  });
  assert.equal(capability, KNOWN_CAPABILITY);
  assert.equal(await verifyR2Capability({
    method: 'GET',
    objectKey: OBJECT_KEY,
    expiresAt: String(EXPIRES),
    capability,
    secret: SECRET,
    clock: () => NOW_MS,
  }), true);
});

test('capability is bound to exact GET, object key and canonical expiry', async () => {
  const { verifyR2Capability } = await import('../gateway/src/r2-capability.js');
  const valid = {
    method: 'GET', objectKey: OBJECT_KEY, expiresAt: String(EXPIRES),
    capability: KNOWN_CAPABILITY, secret: SECRET, clock: () => NOW_MS,
  };
  for (const mutation of [
    { method: 'POST' },
    { method: 'get' },
    { objectKey: `${OBJECT_KEY}.other` },
    { objectKey: 'packs/b3-sandbox-proof/1.0.0-b3.1/../b3-sandbox-proof.zip' },
    { expiresAt: String(EXPIRES - 1) },
    { expiresAt: `0${EXPIRES}` },
    { expiresAt: `${EXPIRES}.0` },
    { expiresAt: `+${EXPIRES}` },
    { capability: `${KNOWN_CAPABILITY}=` },
    { capability: `${KNOWN_CAPABILITY.slice(0, -1)}A` },
    { capability: KNOWN_CAPABILITY.slice(1) },
    { capability: 'not+base64url' },
  ]) {
    assert.equal(await verifyR2Capability({ ...valid, ...mutation }), false, JSON.stringify(mutation));
  }
});

test('capability lifetime is positive and at most 600 seconds against injected time', async () => {
  const { issueR2Capability, verifyR2Capability } = await import('../gateway/src/r2-capability.js');
  const base = {
    method: 'GET', objectKey: OBJECT_KEY, secret: SECRET, clock: () => NOW_MS,
  };
  await assert.rejects(issueR2Capability({ ...base, expiresAt: Math.floor(NOW_MS / 1000) }));
  await assert.rejects(issueR2Capability({ ...base, expiresAt: EXPIRES + 1 }));
  await assert.rejects(issueR2Capability({ ...base, expiresAt: Number.MAX_SAFE_INTEGER }));
  for (const expiresAt of [
    String(Math.floor(NOW_MS / 1000)),
    String(EXPIRES + 1),
    String(Number.MAX_SAFE_INTEGER),
  ]) {
    assert.equal(await verifyR2Capability({
      ...base, expiresAt, capability: KNOWN_CAPABILITY,
    }), false);
  }
});

test('capability secret is exactly 32 raw bytes and every digest byte is compared', async () => {
  const { issueR2Capability, verifyR2Capability } = await import('../gateway/src/r2-capability.js');
  for (const secret of [new Uint8Array(31), new Uint8Array(33), 'AAECAw']) {
    await assert.rejects(issueR2Capability({
      method: 'GET', objectKey: OBJECT_KEY, expiresAt: EXPIRES,
      secret, clock: () => NOW_MS,
    }));
  }
  for (let index = 0; index < 32; index += 1) {
    const bytes = Buffer.from(KNOWN_CAPABILITY, 'base64url');
    bytes[index] ^= 1;
    assert.equal(await verifyR2Capability({
      method: 'GET', objectKey: OBJECT_KEY, expiresAt: String(EXPIRES),
      capability: bytes.toString('base64url'), secret: SECRET, clock: () => NOW_MS,
    }), false, `digest byte ${index}`);
  }
});
