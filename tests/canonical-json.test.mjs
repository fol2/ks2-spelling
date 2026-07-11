import assert from 'node:assert/strict';
import test from 'node:test';

test('canonical JSON sorts nested object keys and preserves array order', async () => {
  const { canonicalJson } = await import('../src/platform/database/canonical-json.js');

  assert.equal(
    canonicalJson({ z: { beta: 2, alpha: 1 }, a: ['second', 'first'], m: true }),
    '{"a":["second","first"],"m":true,"z":{"alpha":1,"beta":2}}',
  );
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
});

test('canonical JSON key order is independent of locale collation', async () => {
  const { canonicalJson } = await import('../src/platform/database/canonical-json.js');

  assert.equal(canonicalJson({ 'ä': 2, z: 1 }), '{"z":1,"ä":2}');
});

test('canonical JSON rejects cycles and unsupported values at any depth', async () => {
  const { canonicalJson } = await import('../src/platform/database/canonical-json.js');
  const cyclic = {};
  cyclic.self = cyclic;

  const unsupported = [
    cyclic,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    undefined,
    () => undefined,
    Symbol('unsupported'),
    1n,
    new Date(0),
    new Map(),
    { value: undefined },
    [undefined],
  ];
  for (const value of unsupported) {
    assert.throws(() => canonicalJson(value), /canonical JSON/i);
  }
});

test('canonical JSON rejects accessors without invoking them', async () => {
  const { canonicalJson } = await import('../src/platform/database/canonical-json.js');
  let reads = 0;
  const value = {};
  Object.defineProperty(value, 'secret', {
    enumerable: true,
    get() {
      reads += 1;
      return 'leaked';
    },
  });

  assert.throws(() => canonicalJson(value), /canonical JSON/i);
  assert.equal(reads, 0);
});

test('canonical JSON rejects hidden and symbol object properties', async () => {
  const { canonicalJson } = await import('../src/platform/database/canonical-json.js');
  const hidden = { visible: true };
  Object.defineProperty(hidden, 'secret', { value: true });
  const symbol = { visible: true, [Symbol('secret')]: true };

  assert.throws(() => canonicalJson(hidden), /canonical JSON/i);
  assert.throws(() => canonicalJson(symbol), /canonical JSON/i);
});

test('canonical JSON rejects sparse, decorated and custom-prototype arrays', async () => {
  const { canonicalJson } = await import('../src/platform/database/canonical-json.js');
  const sparse = Array(2);
  sparse[1] = 'present';
  const decorated = ['value'];
  decorated.extra = true;
  let inheritedReads = 0;
  const hostilePrototype = Object.create(Array.prototype);
  Object.defineProperty(hostilePrototype, 'secret', {
    get() {
      inheritedReads += 1;
      throw new Error('inherited_accessor_invoked');
    },
  });
  const customPrototype = ['value'];
  Object.setPrototypeOf(customPrototype, hostilePrototype);

  assert.throws(() => canonicalJson(sparse), /canonical JSON/i);
  assert.throws(() => canonicalJson(decorated), /canonical JSON/i);
  assert.throws(() => canonicalJson(customPrototype), /canonical JSON/i);
  assert.equal(inheritedReads, 0);
});

test('canonical JSON rejects nested hostile descriptors without invoking them', async () => {
  const { canonicalJson } = await import('../src/platform/database/canonical-json.js');
  let reads = 0;
  const nested = {};
  Object.defineProperty(nested, 'answer', {
    enumerable: true,
    get() {
      reads += 1;
      throw new Error('nested_accessor_invoked');
    },
  });

  assert.throws(() => canonicalJson({ safe: [{ nested }] }), /canonical JSON/i);
  assert.equal(reads, 0);
});

test('canonical JSON permits repeated non-cyclic references', async () => {
  const { canonicalJson } = await import('../src/platform/database/canonical-json.js');
  const child = { answer: 42 };

  assert.equal(
    canonicalJson({ left: child, right: child }),
    '{"left":{"answer":42},"right":{"answer":42}}',
  );
});

test('canonical JSON SHA-256 uses the canonical UTF-8 bytes', async () => {
  const { canonicalJsonSha256 } = await import(
    '../src/platform/database/canonical-json.js'
  );

  assert.equal(
    await canonicalJsonSha256({ b: 2, a: 1 }),
    '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777',
  );
});
