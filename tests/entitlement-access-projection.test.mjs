import assert from 'node:assert/strict';
import test from 'node:test';

import { projectActiveEntitlements } from '../src/domain/commerce/entitlement-access-projection.js';

const READONLY_SET_KEYS = Object.freeze([
  'size',
  'has',
  'values',
  'keys',
  'entries',
  'forEach',
  Symbol.iterator,
]);

function entitlement(overrides = {}) {
  return {
    entitlementId: 'full-ks2',
    store: 'apple',
    productId: 'uk.eugnel.ks2spelling.fullks2',
    storeTransactionId: overrides.store === 'google'
      ? 'GPA.1234-5678-9012-34567'
      : '2000001234567890',
    state: 'active',
    sealedRefreshHandle: 'b3rh1.1.nonce.ciphertext',
    refreshHandleVersion: 1,
    verifiedAt: 1_768_478_400_000,
    refreshedAt: 1_768_478_400_000,
    revocationAt: null,
    ...overrides,
  };
}

function assertFrozenReadonlySetShape(value) {
  assert.equal(Object.getPrototypeOf(value), null);
  assert.equal(Object.isFrozen(value), true);
  assert.deepEqual(Reflect.ownKeys(value), READONLY_SET_KEYS);
  for (const key of READONLY_SET_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert.ok(descriptor);
    assert.equal(Object.hasOwn(descriptor, 'value'), true);
    assert.equal(descriptor.enumerable, true);
    assert.equal(descriptor.configurable, false);
    assert.equal(descriptor.writable, false);
  }
  assert.equal(value.add, undefined);
  assert.equal(value.delete, undefined);
  assert.equal(value.clear, undefined);
  assert.throws(() => Set.prototype.add.call(value, 'future-pack'), TypeError);
}

test('projection exposes only active app-wide IDs through a truly immutable ReadonlySet', () => {
  const rows = [
    entitlement({
      entitlementId: 'future-pack',
      productId: 'future_pack',
      store: 'google',
    }),
    entitlement({
      entitlementId: 'revoked-pack',
      productId: 'revoked_pack',
      state: 'revoked',
      sealedRefreshHandle: null,
      refreshHandleVersion: null,
      revocationAt: 1_768_478_500_000,
    }),
    entitlement(),
  ];

  const active = projectActiveEntitlements(rows);

  assertFrozenReadonlySetShape(active);
  assert.equal(active.size, 2);
  assert.equal(active.has('full-ks2'), true);
  assert.equal(active.has('future-pack'), true);
  assert.equal(active.has('revoked-pack'), false);
  assert.deepEqual([...active], ['full-ks2', 'future-pack']);
  assert.deepEqual([...active.values()], ['full-ks2', 'future-pack']);
  assert.deepEqual([...active.keys()], ['full-ks2', 'future-pack']);
  assert.deepEqual(
    [...active.entries()],
    [
      ['full-ks2', 'full-ks2'],
      ['future-pack', 'future-pack'],
    ],
  );
  const visited = [];
  active.forEach((value, key, set) => visited.push([value, key, set === active]));
  assert.deepEqual(visited, [
    ['full-ks2', 'full-ks2', true],
    ['future-pack', 'future-pack', true],
  ]);

  assert.throws(() => {
    active.size = 99;
  }, TypeError);
  assert.throws(() => {
    active.has = () => false;
  }, TypeError);
  assert.deepEqual([...active], ['full-ks2', 'future-pack']);
});

test('projection rejects duplicate entitlement authority before filtering revoked rows', () => {
  assert.throws(
    () =>
      projectActiveEntitlements([
        entitlement(),
        entitlement({
          state: 'revoked',
          sealedRefreshHandle: null,
          refreshHandleVersion: null,
          revocationAt: 1_768_478_500_000,
        }),
      ]),
    /duplicate/i,
  );
  assert.throws(
    () => projectActiveEntitlements([entitlement(), entitlement()]),
    /duplicate/i,
  );
});

test('projection rejects malformed, open, inherited and accessor-backed entitlement rows', () => {
  const inherited = Object.create(entitlement());
  const accessor = entitlement();
  let getterCalled = false;
  Object.defineProperty(accessor, 'state', {
    enumerable: true,
    get() {
      getterCalled = true;
      return 'active';
    },
  });

  const invalid = [
    null,
    [],
    entitlement({ unknown: true }),
    entitlement({ entitlementId: 'Full KS2' }),
    entitlement({ state: 'pending' }),
    entitlement({ sealedRefreshHandle: null, refreshHandleVersion: 1 }),
    entitlement({ refreshedAt: 1.5 }),
    entitlement({ storeTransactionId: 'native-secret' }),
    inherited,
    accessor,
  ];
  for (const row of invalid) {
    assert.throws(() => projectActiveEntitlements([row]), TypeError);
  }
  assert.equal(getterCalled, false);
  assert.throws(() => projectActiveEntitlements('not-an-array'), TypeError);
  assert.throws(
    () => projectActiveEntitlements(Object.assign([], { extra: true })),
    TypeError,
  );
});
