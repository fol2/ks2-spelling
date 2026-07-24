import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createStarterPackAvailabilityController,
} from '../src/app/starter-pack-availability-controller.js';

test('Starter audio availability distinguishes ready and corrupt bundled authority', async () => {
  let available = true;
  const controller = createStarterPackAvailabilityController({
    audioSource: {
      async checkAvailability() {
        if (!available) throw new Error('bundle unavailable');
        return Object.freeze({ version: '1.0.0' });
      },
    },
  });

  await controller.refresh();
  assert.deepEqual(controller.getState(), {
    status: 'ready',
    activeVersion: '1.0.0',
    actionError: null,
  });

  controller.reportPlaybackFailure();
  assert.deepEqual(controller.getState(), {
    status: 'corrupt',
    activeVersion: '1.0.0',
    actionError: 'starter_audio_playback_failed',
  });

  available = false;
  await assert.rejects(controller.recover(), /bundle unavailable/);
  assert.deepEqual(controller.getState(), {
    status: 'unavailable',
    activeVersion: '1.0.0',
    actionError: 'starter_audio_check_failed',
  });
  await controller.dispose();
});

test('Starter audio recovery stays explicit and never substitutes runtime speech', async () => {
  let failed = true;
  const controller = createStarterPackAvailabilityController({
    audioSource: {
      async checkAvailability() {
        if (failed) throw new Error('database unavailable');
        return Object.freeze({ version: '1.0.0' });
      },
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
  assert.deepEqual(controller.getState(), {
    status: 'ready',
    activeVersion: '1.0.0',
    actionError: null,
  });
  await controller.dispose();
});
