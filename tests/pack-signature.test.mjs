import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { canonicaliseRfc8785Bytes } from '../src/domain/packs/rfc8785.js';
import {
  PACK_SIGNING_ALGORITHM,
  PACK_SIGNING_DOMAIN,
  PACK_SIGNING_DOMAIN_BYTES,
  createPackSigningInput,
} from '../src/domain/packs/signed-manifest-contract.js';
import {
  parsePackKeyValidityBoundary,
  selectPackVerificationKey,
} from '../src/domain/packs/pack-keyring.js';
import { verifySignedPackManifest } from '../src/domain/packs/pack-signature-verifier.js';

const keyring = JSON.parse(
  await readFile(new URL('../config/pack-signing-public-keys.json', import.meta.url), 'utf8'),
);
const VALID_DER = Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]);
const VALID_DER_BASE64 = 'MAYCAQECAQE=';
const NOW = '2026-07-12T12:00:00.000Z';

function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function envelopeForCanonicalBytes(canonicalManifestBytes, overrides = {}) {
  return new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    algorithm: PACK_SIGNING_ALGORITHM,
    keyId: 'b3-test-p256-2026-07',
    payloadEncoding: 'RFC8785_UTF8',
    domain: PACK_SIGNING_DOMAIN,
    canonicalManifestBase64: toBase64(canonicalManifestBytes),
    signatureDerBase64: VALID_DER_BASE64,
    ...overrides,
  }));
}

function validEnvelope(overrides = {}) {
  return envelopeForCanonicalBytes(
    canonicaliseRfc8785Bytes({ packId: 'b3-sandbox-proof', version: '1.0.0-b3.1' }),
    overrides,
  );
}

test('pack signing input is the exact domain, NUL and canonical UTF-8 bytes', () => {
  const canonical = new TextEncoder().encode('{"packId":"b3-sandbox-proof"}');
  const input = createPackSigningInput(canonical);

  assert.deepEqual(
    PACK_SIGNING_DOMAIN_BYTES,
    new TextEncoder().encode('ks2-spelling-pack-manifest-v1\u0000'),
  );
  assert.deepEqual(input, new Uint8Array([...PACK_SIGNING_DOMAIN_BYTES, ...canonical]));
});

test('key selection enforces key, algorithm, environment, pack and inclusive dates', () => {
  const base = {
    keyring,
    keyId: 'b3-test-p256-2026-07',
    packId: 'b3-sandbox-proof',
    environment: 'sandbox',
  };
  const selectAt = (instant) => selectPackVerificationKey({
    ...base,
    clock: () => new Date(instant),
  });

  assert.throws(() => selectAt('2026-06-30T23:59:59.999Z'), /validity|not before/i);
  assert.equal(selectAt('2026-07-01T00:00:00.000Z').keyId, base.keyId);
  assert.equal(selectAt('2027-07-01T00:00:00.000Z').keyId, base.keyId);
  assert.throws(() => selectAt('2027-07-01T00:00:00.001Z'), /validity|expired/i);

  for (const mutation of [
    { keyId: 'unknown' },
    { environment: 'production' },
    { packId: 'other-pack' },
  ]) {
    assert.throws(
      () => selectPackVerificationKey({ ...base, ...mutation, clock: () => new Date(NOW) }),
      /verification key|environment|pack/i,
    );
  }
});

test('key validity boundaries reject normalised and non-canonical calendar dates', () => {
  assert.equal(
    parsePackKeyValidityBoundary('2026-07-01T00:00:00Z', 'test boundary'),
    Date.parse('2026-07-01T00:00:00Z'),
  );
  assert.equal(
    parsePackKeyValidityBoundary('2026-07-01T00:00:00.123Z', 'test boundary'),
    Date.parse('2026-07-01T00:00:00.123Z'),
  );
  for (const boundary of [
    '2026-02-30T00:00:00Z',
    '2026-07-01T24:00:00Z',
    '2026-7-01T00:00:00Z',
    '2026-07-01T00:00:00.00Z',
    '2026-07-01T00:00:00+00:00',
    '2026-07-01T00:00:60Z',
  ]) {
    assert.throws(
      () => parsePackKeyValidityBoundary(boundary, 'test boundary'),
      /valid|canonical|UTC/i,
    );
  }
});

test('signed manifests verify domain-separated bytes before manifest JSON is parsed', async () => {
  const events = [];
  const result = await verifySignedPackManifest({
    envelopeBytes: validEnvelope(),
    keyring,
    environment: 'sandbox',
    clock: () => new Date(NOW),
    verifyP256Der: async ({ publicKeySpkiDer, signatureDer, signingInput }) => {
      events.push('verify');
      assert.equal(toBase64(publicKeySpkiDer), keyring.keys[0].publicKeySpkiDerBase64);
      assert.deepEqual(signatureDer, VALID_DER);
      assert.deepEqual(
        signingInput.subarray(0, PACK_SIGNING_DOMAIN_BYTES.length),
        PACK_SIGNING_DOMAIN_BYTES,
      );
      return true;
    },
  });

  assert.deepEqual(events, ['verify']);
  assert.equal(result.manifest.packId, 'b3-sandbox-proof');
  assert.equal(result.keyId, 'b3-test-p256-2026-07');

  let invalidJsonVerifyCalls = 0;
  await assert.rejects(
    verifySignedPackManifest({
      envelopeBytes: envelopeForCanonicalBytes(new TextEncoder().encode('{')),
      keyring,
      environment: 'sandbox',
      clock: () => new Date(NOW),
      verifyP256Der: async () => {
        invalidJsonVerifyCalls += 1;
        return true;
      },
    }),
    /manifest.*JSON/i,
  );
  assert.equal(invalidJsonVerifyCalls, 1);
});

test('signed manifests fail closed on signature failure and non-canonical or duplicate payloads', async () => {
  await assert.rejects(
    verifySignedPackManifest({
      envelopeBytes: validEnvelope(),
      keyring,
      environment: 'sandbox',
      clock: () => new Date(NOW),
      verifyP256Der: async () => false,
    }),
    /signature/i,
  );

  for (const source of [
    '{"version":"1.0.0-b3.1", "packId":"b3-sandbox-proof"}',
    '{"packId":"b3-sandbox-proof","packId":"b3-sandbox-proof"}',
  ]) {
    await assert.rejects(
      verifySignedPackManifest({
        envelopeBytes: envelopeForCanonicalBytes(new TextEncoder().encode(source)),
        keyring,
        environment: 'sandbox',
        clock: () => new Date(NOW),
        verifyP256Der: async () => true,
      }),
      /canonical|duplicate/i,
    );
  }
});

test('signed manifests reject unknown envelope fields and fixed-value mutations', async () => {
  const mutations = [
    { extra: true },
    { schemaVersion: 2 },
    { algorithm: 'ECDSA_P256_SHA256_RAW' },
    { payloadEncoding: 'JSON' },
    { domain: 'another-domain' },
    { keyId: 'unknown' },
  ];
  for (const mutation of mutations) {
    await assert.rejects(
      verifySignedPackManifest({
        envelopeBytes: validEnvelope(mutation),
        keyring,
        environment: 'sandbox',
        clock: () => new Date(NOW),
        verifyP256Der: async () => true,
      }),
      /envelope|algorithm|domain|key|encoding|schema/i,
    );
  }
});

test('signed manifests reject duplicate envelope members before invoking the verifier', async () => {
  const canonicalManifestBase64 = toBase64(
    canonicaliseRfc8785Bytes({ packId: 'b3-sandbox-proof' }),
  );
  const source = `{"schemaVersion":1,"schemaVersion":1,"algorithm":"${PACK_SIGNING_ALGORITHM}","keyId":"b3-test-p256-2026-07","payloadEncoding":"RFC8785_UTF8","domain":"${PACK_SIGNING_DOMAIN}","canonicalManifestBase64":"${canonicalManifestBase64}","signatureDerBase64":"${VALID_DER_BASE64}"}`;
  let verifierCalls = 0;

  await assert.rejects(
    verifySignedPackManifest({
      envelopeBytes: new TextEncoder().encode(source),
      keyring,
      environment: 'sandbox',
      clock: () => new Date(NOW),
      verifyP256Der: async () => {
        verifierCalls += 1;
        return true;
      },
    }),
    /duplicate JSON member/i,
  );
  assert.equal(verifierCalls, 0);
});

test('signed manifests require canonical base64 and strict P-256 DER', async () => {
  const mutations = [
    { canonicalManifestBase64: `${toBase64(canonicaliseRfc8785Bytes({ packId: 'b3-sandbox-proof' }))}\n` },
    { canonicalManifestBase64: 'e30' },
    { signatureDerBase64: 'MAYCAQECAQE' },
    { signatureDerBase64: 'MAYCAQECAQE_' },
    { signatureDerBase64: toBase64(Uint8Array.from([0x31, 0x06, 2, 1, 1, 2, 1, 1])) },
    { signatureDerBase64: toBase64(Uint8Array.from([0x30, 0x06, 2, 1, 0x80, 2, 1, 1])) },
    { signatureDerBase64: toBase64(Uint8Array.from([0x30, 0x07, 2, 2, 0, 1, 2, 1, 1])) },
    { signatureDerBase64: toBase64(Uint8Array.from([...VALID_DER, 0])) },
  ];
  for (const mutation of mutations) {
    await assert.rejects(
      verifySignedPackManifest({
        envelopeBytes: validEnvelope(mutation),
        keyring,
        environment: 'sandbox',
        clock: () => new Date(NOW),
        verifyP256Der: async () => true,
      }),
      /base64|DER|signature/i,
    );
  }
});

test('signed manifests enforce environment and signed pack key scope', async () => {
  for (const testCase of [
    { environment: 'production', envelopeBytes: validEnvelope() },
    {
      environment: 'sandbox',
      envelopeBytes: envelopeForCanonicalBytes(canonicaliseRfc8785Bytes({ packId: 'other-pack' })),
    },
  ]) {
    await assert.rejects(
      verifySignedPackManifest({
        ...testCase,
        keyring,
        clock: () => new Date(NOW),
        verifyP256Der: async () => true,
      }),
      /environment|pack|verification key/i,
    );
  }
});

test('key selection rejects malformed or non-canonical P-256 SPKI DER', () => {
  const malformed = structuredClone(keyring);
  malformed.keys[0].publicKeySpkiDerBase64 = VALID_DER_BASE64;

  assert.throws(
    () => selectPackVerificationKey({
      keyring: malformed,
      keyId: 'b3-test-p256-2026-07',
      packId: 'b3-sandbox-proof',
      environment: 'sandbox',
      clock: () => new Date(NOW),
    }),
    /keyring|SPKI/i,
  );
});

test('runtime key selection requires the exact closed Task 2 keyring authority', () => {
  const select = (candidate) => selectPackVerificationKey({
    keyring: candidate,
    keyId: 'b3-test-p256-2026-07',
    packId: 'b3-sandbox-proof',
    environment: 'sandbox',
    clock: () => new Date(NOW),
  });
  const invalidPoint = Buffer.from(keyring.keys[0].publicKeySpkiDerBase64, 'base64');
  invalidPoint[invalidPoint.length - 1] ^= 0x01;
  const mutations = [
    (value) => { value.privateKey = 'forbidden'; },
    (value) => { value.keys[0].privateKeyPem = 'forbidden'; },
    (value) => { value.keys[0].testOnly = false; },
    (value) => { value.keys[0].allowedEnvironments.push('production'); },
    (value) => { value.keys[0].publicKeySpkiDerBase64 = invalidPoint.toString('base64'); },
    (value) => { value.keys[0].publicKeySpkiSha256 = '0'.repeat(64); },
  ];

  for (const mutate of mutations) {
    const candidate = structuredClone(keyring);
    mutate(candidate);
    assert.throws(() => select(candidate), /keyring|verification key/i);
  }
});
