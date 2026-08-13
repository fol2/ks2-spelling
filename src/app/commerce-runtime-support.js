import { verifySignedPackManifest } from '../domain/packs/pack-signature-verifier.js';

// Shared commerce runtime helpers. Moved verbatim out of
// create-b3-app-services.js at E2.7 so the shipping product composition can
// import them without pulling the B3 proof composition (and its deterministic
// fake adapters) into the product bundle graph.

export function isRecoverableExternalFailure(error) {
  if (!(error instanceof Error)) return false;
  if (error.code === 'STORE_NATIVE_FAILURE') return true;
  if (
    (error.code === 'GATEWAY_OFFLINE' || error.code === 'GATEWAY_TIMEOUT') &&
    error.retryable !== false
  ) {
    return true;
  }
  return error.retryable === true && (
    error.status === 429 ||
    (Number.isInteger(error.status) && error.status >= 500)
  );
}

function p256DerToRaw(signatureDer) {
  const bytes = new Uint8Array(signatureDer);
  if (bytes[0] !== 0x30 || bytes[1] !== bytes.length - 2 || bytes[2] !== 0x02) {
    throw new TypeError('P-256 DER signature is invalid.');
  }
  const rLength = bytes[3];
  const sTag = 4 + rLength;
  if (bytes[sTag] !== 0x02 || sTag + 2 + bytes[sTag + 1] !== bytes.length) {
    throw new TypeError('P-256 DER signature is invalid.');
  }
  const normalise = (start, length) => {
    const integer = bytes.slice(start, start + length);
    const magnitude = integer[0] === 0 ? integer.slice(1) : integer;
    if (magnitude.length === 0 || magnitude.length > 32) {
      throw new TypeError('P-256 DER signature is invalid.');
    }
    const output = new Uint8Array(32);
    output.set(magnitude, 32 - magnitude.length);
    return output;
  };
  const raw = new Uint8Array(64);
  raw.set(normalise(4, rLength), 0);
  raw.set(normalise(sTag + 2, bytes[sTag + 1]), 32);
  return raw;
}

export async function verifyManifest(input) {
  return verifySignedPackManifest({
    ...input,
    async verifyP256Der({ publicKeySpkiDer, signatureDer, signingInput }) {
      const key = await globalThis.crypto.subtle.importKey(
        'spki',
        publicKeySpkiDer,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
      return globalThis.crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        p256DerToRaw(signatureDer),
        signingInput,
      );
    },
  });
}

export function createGatewayRecorder(
  gateway,
  recordEnvelope,
  observeAuthorisation = () => {},
  recordObservationFailure = () => {},
) {
  function markObservationFailure() {
    try {
      recordObservationFailure();
    } catch {
      // Proof bookkeeping cannot replace the production gateway result.
    }
  }
  return Object.freeze({
    verifyTransaction: (request) => gateway.verifyTransaction(request),
    completeTransaction: (request) => gateway.completeTransaction(request),
    refreshEntitlement: (request) => gateway.refreshEntitlement(request),
    async authorisePackDownload(request) {
      const result = await gateway.authorisePackDownload(request);
      // The full authorisation travels with the envelope so multi-pack
      // recorders can key their capture by result.packId (E2.7 trap: a
      // single-slot recorder activates every shard against the last envelope).
      recordEnvelope(result.signedManifestEnvelopeBase64, result);
      try {
        const observation = observeAuthorisation(result);
        if (observation && typeof observation.then === 'function') {
          void observation.catch(markObservationFailure);
        }
      } catch {
        // Proof observation cannot replace the production gateway result.
        markObservationFailure();
      }
      return result;
    },
  });
}
