import { canonicaliseRfc8785Bytes } from './rfc8785.js';
import {
  assertCanonicalP256Der,
  createPackSigningInput,
  parseJsonWithoutDuplicateMembers,
  parseSignedManifestEnvelope,
} from './signed-manifest-contract.js';
import {
  selectPackVerificationKey,
  selectPackVerificationKeyCandidate,
} from './pack-keyring.js';

function fail(detail) {
  throw new TypeError(`Signed pack manifest ${detail}.`);
}

function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export async function verifySignedPackManifest({
  envelopeBytes,
  keyring,
  environment,
  clock,
  verifyP256Der,
}) {
  if (typeof verifyP256Der !== 'function') fail('requires a P-256 DER verifier');
  if (typeof clock !== 'function') fail('requires an injected clock');
  const verificationInstant = clock();
  const fixedClock = () => verificationInstant;
  const { envelope, canonicalManifestBytes, signatureDer } =
    parseSignedManifestEnvelope(envelopeBytes);
  assertCanonicalP256Der(signatureDer);

  const candidate = selectPackVerificationKeyCandidate({
    keyring,
    keyId: envelope.keyId,
    environment,
    clock: fixedClock,
  });
  const signingInput = createPackSigningInput(canonicalManifestBytes);
  const signatureValid = await verifyP256Der({
    publicKeySpkiDer: candidate.publicKeySpkiDer.slice(),
    signatureDer: signatureDer.slice(),
    signingInput: signingInput.slice(),
  });
  if (signatureValid !== true) fail('signature verification failed');

  const manifest = parseJsonWithoutDuplicateMembers(canonicalManifestBytes, 'manifest JSON');
  let recanonicalised;
  try {
    recanonicalised = canonicaliseRfc8785Bytes(manifest);
  } catch (error) {
    throw new TypeError(`Signed pack manifest canonical payload is invalid: ${error.message}`);
  }
  if (!equalBytes(canonicalManifestBytes, recanonicalised)) {
    fail('payload is not canonical RFC 8785 JSON');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('canonical payload must be a manifest object');
  }
  const selected = selectPackVerificationKey({
    keyring,
    keyId: envelope.keyId,
    packId: manifest.packId,
    environment,
    clock: fixedClock,
  });

  return Object.freeze({
    manifest,
    canonicalManifestBytes: canonicalManifestBytes.slice(),
    keyId: selected.keyId,
    algorithm: selected.algorithm,
  });
}
