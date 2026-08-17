import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  createParentSecurityController,
} from '../src/app/parent-security-controller.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function createLifecycle() {
  return Object.freeze({
    onPause() {
      return Object.freeze({ async remove() {} });
    },
  });
}

test('rejected fresh-install owner authentication keeps the real Parent surface closed', async (t) => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: join(ROOT, 'vite.config.js'),
    server: { middlewareMode: true },
    appType: 'custom',
  });
  t.after(() => vite.close());
  const { ParentArea } = await vite.ssrLoadModule('/src/app/ProductApp.jsx');

  let record = null;
  const writes = [];
  const controller = await createParentSecurityController({
    repository: Object.freeze({
      async read() {
        return record;
      },
      async write(next) {
        record = structuredClone(next);
        writes.push(structuredClone(next));
        return structuredClone(next);
      },
    }),
    biometrics: Object.freeze({
      async getAvailability() {
        return Object.freeze({ available: false, type: 'none' });
      },
      async authenticate() {
        throw new Error('Biometric quick unlock is outside this test.');
      },
    }),
    deviceAuthentication: Object.freeze({
      async getAvailability() {
        return Object.freeze({ available: true });
      },
      async authenticate(request) {
        assert.deepEqual(request, {
          reason: 'Confirm the device owner to save the Parent PIN',
        });
        const error = new Error('parent_device_authentication_rejected');
        error.code = 'parent_device_authentication_rejected';
        throw error;
      },
    }),
    lifecycle: createLifecycle(),
    pinCrypto: Object.freeze({
      async create() {
        throw new Error('PIN crypto must not run after owner rejection.');
      },
      async verify() {
        return false;
      },
    }),
    now: () => 1_000,
  });
  t.after(() => controller.dispose());

  await assert.rejects(
    controller.setPin({ pin: '739251', confirmation: '739251' }),
    (error) => error?.code === 'parent_device_authentication_rejected',
  );
  assert.equal(record, null);
  assert.deepEqual(writes, []);
  assert.equal(controller.getState().status, 'setup-required');

  const html = renderToStaticMarkup(
    React.createElement(ParentArea, {
      state: controller.getState(),
      profiles: Object.freeze([]),
      progressState: Object.freeze({
        status: 'ready',
        learners: Object.freeze([]),
        actionError: null,
      }),
      commerceState: Object.freeze({
        status: 'ready',
        displayPrice: '£4.99',
        entitlementState: 'none',
        packState: 'missing',
        action: null,
        actionError: null,
      }),
      onClose() {},
      async onSetPin() {},
      async onResetPin() {},
      async onUnlockPin() {},
      async onUnlockBiometrics() {},
      async onSetBiometricsEnabled() {},
      async onEditProfile() {},
      async onRemoveProfile() {},
      async onResetLearning() {},
      async onExportBackup() {},
      async onImportBackup() {},
      async onRefreshProgress() {},
      async onPurchase() {},
      async onRestore() {},
      async onDownload() {},
      async onRecoverCommerce() {},
    }),
  );

  assert.match(html, /Set a Parent PIN/);
  assert.match(html, /device will confirm its owner/i);
  assert.match(html, /did not confirm its owner/i);
  assert.doesNotMatch(
    html,
    /Buy Full KS2|Restore purchases|Manage learners|Delete learner|Reset learning/i,
  );
});
