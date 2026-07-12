export const PACK_SIGNING_ALGORITHM = 'ECDSA_P256_SHA256_DER';
export const PACK_SIGNING_DOMAIN = 'ks2-spelling-pack-manifest-v1';
export const PACK_SIGNING_DOMAIN_BYTES = new TextEncoder().encode(
  `${PACK_SIGNING_DOMAIN}\u0000`,
);

const ENVELOPE_KEYS = Object.freeze([
  'schemaVersion',
  'algorithm',
  'keyId',
  'payloadEncoding',
  'domain',
  'canonicalManifestBase64',
  'signatureDerBase64',
]);
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const P256_ORDER = Uint8Array.from([
  0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00,
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84,
  0xf3, 0xb9, 0xca, 0xc2, 0xfc, 0x63, 0x25, 0x51,
]);

function fail(detail) {
  throw new TypeError(`Signed pack manifest ${detail}.`);
}

function assertBytes(value, label) {
  if (!(value instanceof Uint8Array)) {
    fail(`${label} must be Uint8Array bytes`);
  }
}

function encodeBase64(bytes) {
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const combined = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    encoded += BASE64_ALPHABET[(combined >>> 18) & 63];
    encoded += BASE64_ALPHABET[(combined >>> 12) & 63];
    encoded += second === undefined ? '=' : BASE64_ALPHABET[(combined >>> 6) & 63];
    encoded += third === undefined ? '=' : BASE64_ALPHABET[combined & 63];
  }
  return encoded;
}

export function decodeCanonicalBase64(value, label = 'base64 value') {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    fail(`${label} must use padded canonical base64`);
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array((value.length / 4) * 3 - padding);
  let outputIndex = 0;
  for (let index = 0; index < value.length; index += 4) {
    const first = BASE64_ALPHABET.indexOf(value[index]);
    const second = BASE64_ALPHABET.indexOf(value[index + 1]);
    const third = value[index + 2] === '=' ? 0 : BASE64_ALPHABET.indexOf(value[index + 2]);
    const fourth = value[index + 3] === '=' ? 0 : BASE64_ALPHABET.indexOf(value[index + 3]);
    const combined = (first << 18) | (second << 12) | (third << 6) | fourth;
    if (outputIndex < bytes.length) bytes[outputIndex++] = (combined >>> 16) & 0xff;
    if (outputIndex < bytes.length) bytes[outputIndex++] = (combined >>> 8) & 0xff;
    if (outputIndex < bytes.length) bytes[outputIndex++] = combined & 0xff;
  }
  if (encodeBase64(bytes) !== value) {
    fail(`${label} must use padded canonical base64`);
  }
  return bytes;
}

function decodeUtf8(bytes, label) {
  assertBytes(bytes, label);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail(`${label} must not contain a UTF-8 byte-order mark`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(`${label} must be valid UTF-8`);
  }
}

function scanJsonWithoutDuplicateMembers(source, label) {
  let index = 0;
  const skipWhitespace = () => {
    while (index < source.length && /[\t\n\r ]/.test(source[index])) index += 1;
  };
  const scanString = () => {
    const start = index;
    if (source[index] !== '"') fail(`${label} is not valid JSON`);
    index += 1;
    while (index < source.length) {
      const character = source[index];
      if (character === '"') {
        index += 1;
        try {
          return JSON.parse(source.slice(start, index));
        } catch {
          fail(`${label} is not valid JSON`);
        }
      }
      if (character === '\\') {
        index += 1;
        if (source[index] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(source.slice(index + 1, index + 5))) {
            fail(`${label} is not valid JSON`);
          }
          index += 5;
        } else if ('"\\/bfnrt'.includes(source[index])) {
          index += 1;
        } else {
          fail(`${label} is not valid JSON`);
        }
      } else {
        if (character.charCodeAt(0) <= 0x1f) fail(`${label} is not valid JSON`);
        index += 1;
      }
    }
    fail(`${label} is not valid JSON`);
  };
  const scanValue = () => {
    skipWhitespace();
    if (source[index] === '"') {
      scanString();
      return;
    }
    if (source[index] === '{') {
      index += 1;
      skipWhitespace();
      const members = new Set();
      if (source[index] === '}') {
        index += 1;
        return;
      }
      while (index < source.length) {
        skipWhitespace();
        const member = scanString();
        if (members.has(member)) fail(`${label} contains a duplicate JSON member`);
        members.add(member);
        skipWhitespace();
        if (source[index++] !== ':') fail(`${label} is not valid JSON`);
        scanValue();
        skipWhitespace();
        if (source[index] === '}') {
          index += 1;
          return;
        }
        if (source[index++] !== ',') fail(`${label} is not valid JSON`);
      }
      fail(`${label} is not valid JSON`);
    }
    if (source[index] === '[') {
      index += 1;
      skipWhitespace();
      if (source[index] === ']') {
        index += 1;
        return;
      }
      while (index < source.length) {
        scanValue();
        skipWhitespace();
        if (source[index] === ']') {
          index += 1;
          return;
        }
        if (source[index++] !== ',') fail(`${label} is not valid JSON`);
      }
      fail(`${label} is not valid JSON`);
    }
    const remainder = source.slice(index);
    const token = /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(remainder)?.[0];
    if (!token) fail(`${label} is not valid JSON`);
    index += token.length;
  };

  skipWhitespace();
  scanValue();
  skipWhitespace();
  if (index !== source.length) fail(`${label} is not valid JSON`);
}

export function parseJsonWithoutDuplicateMembers(bytes, label) {
  const source = decodeUtf8(bytes, label);
  scanJsonWithoutDuplicateMembers(source, label);
  try {
    return JSON.parse(source);
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function assertClosedEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('envelope must be a JSON object');
  }
  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== ENVELOPE_KEYS.length ||
    actualKeys.some((key) => !ENVELOPE_KEYS.includes(key))
  ) {
    fail('envelope must contain exactly the approved fields');
  }
  if (value.schemaVersion !== 1) fail('envelope schemaVersion must be 1');
  if (value.algorithm !== PACK_SIGNING_ALGORITHM) fail('envelope algorithm is not approved');
  if (typeof value.keyId !== 'string' || value.keyId.length === 0) {
    fail('envelope keyId must be a non-empty string');
  }
  if (value.payloadEncoding !== 'RFC8785_UTF8') {
    fail('envelope payload encoding is not approved');
  }
  if (value.domain !== PACK_SIGNING_DOMAIN) fail('envelope domain is not approved');
  return value;
}

export function parseSignedManifestEnvelope(envelopeBytes) {
  const envelope = assertClosedEnvelope(
    parseJsonWithoutDuplicateMembers(envelopeBytes, 'envelope'),
  );
  return Object.freeze({
    envelope,
    canonicalManifestBytes: decodeCanonicalBase64(
      envelope.canonicalManifestBase64,
      'canonical manifest base64',
    ),
    signatureDer: decodeCanonicalBase64(envelope.signatureDerBase64, 'signature DER base64'),
  });
}

function compareUnsigned(left, right) {
  if (left.length !== right.length) return left.length - right.length;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function readDerInteger(bytes, offset) {
  if (bytes[offset] !== 0x02) fail('signature DER must contain two INTEGER values');
  const length = bytes[offset + 1];
  if (!Number.isInteger(length) || length < 1 || length > 33) {
    fail('signature DER INTEGER length is invalid');
  }
  const start = offset + 2;
  const end = start + length;
  if (end > bytes.length) fail('signature DER INTEGER is truncated');
  const value = bytes.subarray(start, end);
  if ((value[0] & 0x80) !== 0) fail('signature DER INTEGER must be positive');
  if (value.length > 1 && value[0] === 0 && (value[1] & 0x80) === 0) {
    fail('signature DER INTEGER must use minimal encoding');
  }
  const magnitude = value[0] === 0 ? value.subarray(1) : value;
  if (
    magnitude.every((byte) => byte === 0) ||
    compareUnsigned(magnitude, P256_ORDER) >= 0
  ) {
    fail('signature DER INTEGER is outside the P-256 scalar range');
  }
  return end;
}

export function assertCanonicalP256Der(signatureDer) {
  assertBytes(signatureDer, 'signature DER');
  if (signatureDer.length < 8 || signatureDer.length > 72 || signatureDer[0] !== 0x30) {
    fail('signature DER must be a P-256 ECDSA SEQUENCE');
  }
  const sequenceLength = signatureDer[1];
  if ((sequenceLength & 0x80) !== 0 || sequenceLength !== signatureDer.length - 2) {
    fail('signature DER SEQUENCE length is invalid');
  }
  const afterR = readDerInteger(signatureDer, 2);
  const afterS = readDerInteger(signatureDer, afterR);
  if (afterS !== signatureDer.length) fail('signature DER must not contain trailing bytes');
  return signatureDer;
}

export function createPackSigningInput(canonicalManifestBytes) {
  assertBytes(canonicalManifestBytes, 'canonical manifest');
  const input = new Uint8Array(PACK_SIGNING_DOMAIN_BYTES.length + canonicalManifestBytes.length);
  input.set(PACK_SIGNING_DOMAIN_BYTES);
  input.set(canonicalManifestBytes, PACK_SIGNING_DOMAIN_BYTES.length);
  return input;
}
