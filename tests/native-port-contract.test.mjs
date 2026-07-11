import assert from 'node:assert/strict';
import test from 'node:test';

const CAPABILITIES = ['database', 'commerce', 'packStorage', 'biometrics'];

test('B1 fake native ports expose serialisable prototype-only status', async () => {
  const { assertNativePortContract } = await import(
    '../src/platform/native-port-contract.js'
  );
  const { createB1FakeNativePorts } = await import(
    '../src/platform/fakes/create-b1-fake-native-ports.js'
  );
  const ports = assertNativePortContract(createB1FakeNativePorts());

  assert.deepEqual(ports.capabilities, {
    mode: 'prototype-only',
    database: false,
    commerce: false,
    packStorage: false,
    biometrics: false,
  });
  for (const capability of CAPABILITIES) {
    const status = await ports[capability].getStatus();
    assert.deepEqual(JSON.parse(JSON.stringify(status)), status);
    assert.deepEqual(status, {
      capability,
      enabled: false,
      mode: 'prototype-only',
    });
  }
});

test('B1 fake native operations fail closed', async () => {
  const { B1CapabilityNotEnabledError } = await import(
    '../src/platform/native-port-contract.js'
  );
  const { createB1FakeNativePorts } = await import(
    '../src/platform/fakes/create-b1-fake-native-ports.js'
  );
  const ports = createB1FakeNativePorts();
  const calls = [
    () => ports.database.execute({ statement: 'SELECT 1' }),
    () => ports.commerce.purchase({ productId: 'full-ks2' }),
    () => ports.packStorage.download({ packId: 'ks2-core' }),
    () => ports.biometrics.authenticate({ reason: 'Unlock profile' }),
  ];

  for (const call of calls) {
    await assert.rejects(call, (error) => {
      assert.ok(error instanceof B1CapabilityNotEnabledError);
      assert.equal(error.code, 'B1_CAPABILITY_NOT_ENABLED');
      assert.equal(error.mode, 'prototype-only');
      return true;
    });
  }
});
