function fail(detail) {
  throw new TypeError(`RFC 8785 canonicalisation ${detail}.`);
}

function assertValidUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail('rejects lone Unicode surrogates');
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      fail('rejects lone Unicode surrogates');
    }
  }
}

function encodeArray(value, activeObjects) {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    fail('supports only arrays with the standard prototype');
  }
  const ownKeys = Reflect.ownKeys(value);
  const expectedKeys = new Set([
    ...Array.from({ length: value.length }, (_, index) => String(index)),
    'length',
  ]);
  if (ownKeys.length !== expectedKeys.size || ownKeys.some((key) => !expectedKeys.has(key))) {
    fail('requires dense arrays without extra properties');
  }

  const encoded = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('requires enumerable array data properties');
    }
    encoded.push(encodeValue(descriptor.value, activeObjects));
  }
  return `[${encoded.join(',')}]`;
}

function encodeRecord(value, activeObjects) {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('supports only plain objects');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) {
    fail('rejects symbol properties');
  }
  keys.sort();

  const encoded = [];
  for (const key of keys) {
    assertValidUnicode(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('requires enumerable object data properties');
    }
    encoded.push(`${JSON.stringify(key)}:${encodeValue(descriptor.value, activeObjects)}`);
  }
  return `{${encoded.join(',')}}`;
}

function encodeValue(value, activeObjects) {
  if (value === null || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    assertValidUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail('rejects non-finite numbers');
    }
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    fail(`does not support values of type ${typeof value}`);
  }
  if (activeObjects.has(value)) {
    fail('does not support cycles');
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

export function canonicaliseRfc8785(value) {
  return encodeValue(value, new Set());
}

export function canonicaliseRfc8785Bytes(value) {
  return new TextEncoder().encode(canonicaliseRfc8785(value));
}
