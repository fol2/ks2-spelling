import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createB3PhysicalDeviceTransport } from '../../scripts/lib/b3-physical-device-transport.mjs';

const operation = process.argv[2];
const root = await mkdtemp(join(tmpdir(), 'b3-native-transport-fifo-child-'));
const launchCommand = {
  schemaVersion: 1,
  captureId: '018f1d7b-97e8-4a52-8cf2-783e5089c001',
  platform: 'ios-physical',
  testedApplicationCommit: 'a'.repeat(40),
  applicationFingerprint: 'b'.repeat(64),
  expectedScenarioIndex: 0,
  expectedSequence: 1,
  previousObservationSha256: '0'.repeat(64),
  installationMode: 'existing',
  actionCode: 'ARM_CAPTURE',
  challengeSha256: 'c'.repeat(64),
};

try {
  const startedAt = Date.now();
  if (operation === 'pulled-observation') {
    const transport = createB3PhysicalDeviceTransport({
      root,
      platform: 'ios',
      env: { B3_IOS_PHYSICAL_DEVICE_ID: '00008140-001234560123001C' },
      runner: async (_executable, args) => {
        const destination = args[args.indexOf('--destination') + 1];
        const fifo = spawnSync('/usr/bin/mkfifo', [destination]);
        assert.equal(fifo.status, 0, fifo.stderr?.toString('utf8'));
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    await assert.rejects(
      transport.pullObservation(),
      /bounded regular file|fixed file|file policy|invalid/i,
    );
  } else if (operation === 'devicectl-json') {
    const transport = createB3PhysicalDeviceTransport({
      root,
      platform: 'ios',
      env: { B3_IOS_PHYSICAL_DEVICE_ID: '00008140-001234560123001C' },
      runner: async (_executable, args) => {
        const output = args[args.indexOf('--json-output') + 1];
        const fifo = spawnSync('/usr/bin/mkfifo', [output]);
        assert.equal(fifo.status, 0, fifo.stderr?.toString('utf8'));
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    await assert.rejects(
      transport.launch(launchCommand),
      /bounded regular file|JSON output|file policy|invalid/i,
    );
  } else if (operation === 'launch-identity') {
    const transport = createB3PhysicalDeviceTransport({
      root,
      platform: 'ios',
      env: { B3_IOS_PHYSICAL_DEVICE_ID: '00008140-001234560123001C' },
      runner: async (_executable, args) => {
        const output = args[args.indexOf('--json-output') + 1];
        if (args.includes('launch')) {
          await writeFile(output, JSON.stringify({
            info: { outcome: 'success' }, result: { processIdentifier: 4321 },
          }));
        } else if (args.includes('processes')) {
          await writeFile(output, JSON.stringify({
            info: { outcome: 'success' },
            result: { runningProcesses: [{
              bundleIdentifier: 'uk.eugnel.ks2spelling',
              processIdentifier: 4321,
              startDate: '2026-07-16T12:00:00.000Z',
            }] },
          }));
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    await transport.launch(launchCommand);
    const directory = join(root, '.native-build/b3/evidence/ios-transport');
    const identityName = (await readdir(directory))
      .find((name) => name.endsWith('.launch-identity.json'));
    const identityPath = join(directory, identityName);
    await rm(identityPath);
    const fifo = spawnSync('/usr/bin/mkfifo', [identityPath]);
    assert.equal(fifo.status, 0, fifo.stderr?.toString('utf8'));
    await assert.rejects(
      transport.launch(launchCommand),
      /launch identity|bounded regular file|file policy|invalid/i,
    );
  } else {
    throw new Error(`Unknown FIFO operation: ${operation}`);
  }
  process.stdout.write(JSON.stringify({ elapsedMs: Date.now() - startedAt }));
} finally {
  await rm(root, { recursive: true, force: true });
}
