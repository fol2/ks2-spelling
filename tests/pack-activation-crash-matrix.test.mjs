import assert from 'node:assert/strict';
import test from 'node:test';

import { createPackActivationCoordinator } from '../src/app/pack-activation-coordinator.js';
import { activationHarness } from './helpers/pack-activation-harness.mjs';

const CHECKPOINTS = [
  'beforeManifestVerification', 'afterManifestVerification',
  'beforeExtraction', 'afterExtraction',
  'beforeSealAndInstall', 'afterSealAndInstall',
  'beforeDatabaseRegisterAndFlip', 'afterDatabaseRegisterAndFlip',
];

test('every activation crash point leaves the old verified pack active or the new verified pack recoverable', async (t) => {
  for (const checkpoint of CHECKPOINTS) {
    await t.test(checkpoint, async () => {
      let injected = false;
      const harness = activationHarness({
        crashInjector(point) {
          if (!injected && point === checkpoint) {
            injected = true;
            throw Object.assign(new Error('injected crash'), { code: 'INJECTED_CRASH' });
          }
        },
      });
      const coordinator = createPackActivationCoordinator(harness.dependencies);
      await assert.rejects(coordinator.activate(harness.input), { code: 'INJECTED_CRASH' });
      const afterCrash = harness.snapshot();
      assert.ok(
        afterCrash.active.version === '0.9.0' || afterCrash.active.version === harness.input.version,
      );
      if ([
        'afterSealAndInstall', 'beforeDatabaseRegisterAndFlip',
      ].includes(checkpoint)) {
        assert.equal(afterCrash.inventory.length, 1, 'native rename is durable');
        assert.equal(afterCrash.active.version, '0.9.0', 'SQLite transaction did not run');
      }
      if (checkpoint === 'afterDatabaseRegisterAndFlip') {
        assert.equal(afterCrash.inventory.length, 1);
        assert.equal(afterCrash.installedRows.length, 1);
        assert.equal(
          afterCrash.active.version,
          harness.input.version,
          'registration and active flip committed together',
        );
      }

      const recovered = await coordinator.activate(harness.input);
      assert.equal(recovered.active.version, harness.input.version);
      assert.equal(harness.snapshot().job.state, 'ready');
    });
  }
});

test('native rejection before rename leaves no installed inventory and replay succeeds', async () => {
  const harness = activationHarness({ sealFailure: 'before-rename' });
  const coordinator = createPackActivationCoordinator(harness.dependencies);
  await assert.rejects(coordinator.activate(harness.input), {
    code: 'PACK_TRANSFER_NATIVE_FAILURE',
  });
  assert.equal(harness.snapshot().inventory.length, 0);
  assert.equal(harness.snapshot().active.version, '0.9.0');

  const recovered = await coordinator.activate(harness.input);
  assert.equal(recovered.state, 'ready');
});

test('lost native result after rename leaves installed inventory and replay recovers it', async () => {
  const harness = activationHarness({ sealFailure: 'lost-result-after-rename' });
  const coordinator = createPackActivationCoordinator(harness.dependencies);
  await assert.rejects(coordinator.activate(harness.input), {
    code: 'PACK_TRANSFER_NATIVE_FAILURE',
  });
  assert.equal(harness.snapshot().inventory.length, 1);
  assert.equal(harness.snapshot().active.version, '0.9.0');

  const recovered = await coordinator.activate(harness.input);
  assert.equal(recovered.state, 'ready');
  assert.equal(harness.calls.filter((call) => call === 'seal').length, 1);
});
