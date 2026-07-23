import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createStarterPackAvailabilityController,
} from '../src/app/starter-pack-availability-controller.js';

const INSTALLED = Object.freeze({
  packId: 'ks2-core',
  version: '1.0.0',
  manifestSha256: 'a'.repeat(64),
  pathToken: 'installed/ks2-core/1.0.0',
  activationMarkerSha256: 'b'.repeat(64),
  state: 'ready',
  installedAt: 100,
});
const ACTIVE = Object.freeze({
  packId: INSTALLED.packId,
  version: INSTALLED.version,
  manifestSha256: INSTALLED.manifestSha256,
  pathToken: INSTALLED.pathToken,
  activatedAt: 101,
});
const NATIVE = Object.freeze({
  packId: INSTALLED.packId,
  version: INSTALLED.version,
  manifestSha256: INSTALLED.manifestSha256,
  installedPathToken: INSTALLED.pathToken,
  activationMarkerSha256: INSTALLED.activationMarkerSha256,
});

test('Starter audio availability distinguishes missing, ready and corrupt local authority', async () => {
  let active = null;
  let installed = [];
  let native = [];
  const controller = createStarterPackAvailabilityController({
    packRepository: {
      async getActiveVersion() { return structuredClone(active); },
      async listInstalledVersions() { return structuredClone(installed); },
    },
    packTransfer: {
      async inventoryInstalledVersions() { return structuredClone(native); },
    },
  });

  await controller.refresh();
  assert.deepEqual(controller.getState(), {
    status: 'missing',
    activeVersion: null,
    actionError: null,
  });

  active = ACTIVE;
  installed = [INSTALLED];
  native = [NATIVE];
  await controller.refresh();
  assert.deepEqual(controller.getState(), {
    status: 'ready',
    activeVersion: '1.0.0',
    actionError: null,
  });

  native = [{ ...NATIVE, activationMarkerSha256: 'c'.repeat(64) }];
  await controller.refresh();
  assert.deepEqual(controller.getState(), {
    status: 'corrupt',
    activeVersion: '1.0.0',
    actionError: null,
  });

  controller.reportPlaybackFailure();
  assert.equal(controller.getState().status, 'corrupt');
  await controller.dispose();
});

test('Starter audio recovery stays explicit and never substitutes runtime speech', async () => {
  let failed = true;
  const controller = createStarterPackAvailabilityController({
    packRepository: {
      async getActiveVersion() {
        if (failed) throw new Error('database unavailable');
        return null;
      },
      async listInstalledVersions() { return []; },
    },
    packTransfer: {
      async inventoryInstalledVersions() { return []; },
    },
  });

  await assert.rejects(controller.refresh(), /database unavailable/);
  assert.deepEqual(controller.getState(), {
    status: 'unavailable',
    activeVersion: null,
    actionError: 'starter_audio_check_failed',
  });
  failed = false;
  await controller.recover();
  assert.equal(controller.getState().status, 'missing');
  await controller.dispose();
});
