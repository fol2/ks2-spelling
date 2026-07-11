function canonicalJsonError(message) {
  return new TypeError(`Canonical JSON ${message}.`);
}

function encodeArray(value, activeObjects) {
  const keys = Reflect.ownKeys(value);
  const expectedKeys = new Set([
    ...Array.from({ length: value.length }, (_, index) => String(index)),
    'length',
  ]);
  if (keys.length !== expectedKeys.size || keys.some((key) => !expectedKeys.has(key))) {
    throw canonicalJsonError('arrays must be dense and contain no extra properties');
  }

  const encoded = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw canonicalJsonError('array entries must be enumerable data properties');
    }
    encoded.push(encodeValue(descriptor.value, activeObjects));
  }
  return `[${encoded.join(',')}]`;
}

function encodeRecord(value, activeObjects) {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw canonicalJsonError('supports only plain objects');
  }

  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) {
    throw canonicalJsonError('does not support symbol keys');
  }
  keys.sort();

  const encoded = [];
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw canonicalJsonError('object entries must be enumerable data properties');
    }
    encoded.push(`${JSON.stringify(key)}:${encodeValue(descriptor.value, activeObjects)}`);
  }
  return `{${encoded.join(',')}}`;
}

function encodeValue(value, activeObjects) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw canonicalJsonError('does not support non-finite numbers');
    }
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    throw canonicalJsonError(`does not support values of type ${typeof value}`);
  }
  if (activeObjects.has(value)) {
    throw canonicalJsonError('does not support cycles');
  }

  activeObjects.add(value);
  try {
    return Array.isArray(value)
      ? encodeArray(value, activeObjects)
      : encodeRecord(value, activeObjects);
  } finally {
    activeObjects.delete(value);
  }
}

export function canonicalJson(value) {
  return encodeValue(value, new Set());
}

export async function canonicalJsonSha256(value) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto SHA-256 is unavailable.');
  }
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}
