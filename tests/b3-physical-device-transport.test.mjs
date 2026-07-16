import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  link,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createB3TestPng } from './helpers/b3-test-png.mjs';

import { canonicaliseB3ProofValue } from '../src/app/b3-live-proof-protocol.js';
import {
  createB3PhysicalDeviceTransport,
  runB3PhysicalDeviceProcess,
} from '../scripts/lib/b3-physical-device-transport.mjs';

const COMMIT = 'a'.repeat(40);
const FINGERPRINT = 'b'.repeat(64);
const FIFO_CHILD = fileURLToPath(
  new URL('./helpers/b3-native-transport-fifo-child.mjs', import.meta.url),
);

async function processStopsWithin(pid, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      process.kill(pid, 0);
      const state = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'state='], {
        encoding: 'utf8',
      });
      if (state.status !== 0 || state.stdout.trim().startsWith('Z')) return true;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
      return true;
    }
  }
  return false;
}

function assertFifoChildRejectsPromptly(operation) {
  const result = spawnSync(process.execPath, [FIFO_CHILD, operation], {
    encoding: 'utf8',
    timeout: 2_000,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.ok(JSON.parse(result.stdout).elapsedMs < 1_000);
}

function command(platform) {
  return {
    schemaVersion: 1,
    captureId: '018f1d7b-97e8-4a52-8cf2-783e5089c001',
    platform,
    testedApplicationCommit: COMMIT,
    applicationFingerprint: FINGERPRINT,
    expectedScenarioIndex: 0,
    expectedSequence: 1,
    previousObservationSha256: '0'.repeat(64),
    installationMode: 'existing',
    actionCode: 'ARM_CAPTURE',
    challengeSha256: 'c'.repeat(64),
  };
}

function relaunchCommand() {
  return {
    ...command('ios-physical'),
    expectedSequence: 2,
    previousObservationSha256: 'd'.repeat(64),
    actionCode: 'RELAUNCH',
    challengeSha256: 'e'.repeat(64),
  };
}

test('physical-device production runner terminates its complete timed-out process group', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-process-group-ready-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const readyPath = join(root, 'grandchild-ready.fifo');
  const fifo = spawnSync('/usr/bin/mkfifo', [readyPath]);
  assert.equal(fifo.status, 0, fifo.stderr?.toString('utf8'));
  const childProgram = [
    "trap 'exit 0' TERM",
    'ready_path=$1',
    "/bin/sh -c 'trap \"\" TERM; printf \"ready\\n\" > \"$1\"; exec /bin/sleep 30' b3-grandchild \"$ready_path\" &",
    'grandchild_pid=$!',
    'IFS= read -r ready_token < "$ready_path"',
    '[ "$ready_token" = ready ] || exit 2',
    'printf "%s" "$grandchild_pid"',
    'wait "$grandchild_pid"',
  ].join('\n');
  let grandchildPid = null;
  try {
    const startedAt = Date.now();
    const result = await runB3PhysicalDeviceProcess(
      '/bin/sh',
      ['-c', childProgram, 'b3-process-group-parent', readyPath],
      { timeoutMs: 1_000, stdoutLimit: 64 * 1024, stderrLimit: 64 * 1024 },
    );
    grandchildPid = Number(result.stdout);
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - startedAt >= 1_250, 'runner settled before SIGKILL escalation');
    assert.equal(Number.isSafeInteger(grandchildPid) && grandchildPid > 1, true);
    assert.equal(
      await processStopsWithin(grandchildPid),
      true,
      'physical-device timeout left its descendant running',
    );
  } finally {
    if (Number.isSafeInteger(grandchildPid) && grandchildPid > 1) {
      try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* Best-effort test cleanup. */ }
    }
  }
});

test('physical-device production runner bounds stdout and stderr independently', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const result = await runB3PhysicalDeviceProcess(
      process.execPath,
      ['-e', `process.${stream}.write(Buffer.alloc(4096, 97)); setInterval(() => {}, 1000)`],
      { timeoutMs: 5_000, stdoutLimit: 32, stderrLimit: 32 },
    );
    assert.equal(result.outputExceeded, true);
    assert.equal(Buffer.byteLength(result[stream]), 32);
    assert.equal(Buffer.byteLength(result[stream === 'stdout' ? 'stderr' : 'stdout']), 0);
    assert.equal(result.exitCode, 1);
  }
});

test('physical-device observation pull promptly rejects a FIFO output', () => {
  assertFifoChildRejectsPromptly('pulled-observation');
});

test('iOS devicectl JSON output promptly rejects a FIFO', () => {
  assertFifoChildRejectsPromptly('devicectl-json');
});

test('iOS retained launch identity promptly rejects a FIFO', () => {
  assertFifoChildRejectsPromptly('launch-identity');
});

test('iOS transport launches only the fixed bundle and pulls only fixed appData bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-ios-transport-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const observationBytes = Buffer.from('{"device":"observation"}', 'utf8');
  const runner = async (executable, args) => {
    calls.push([executable, args]);
    if (args.slice(0, 4).join(' ') === 'devicectl device process launch') {
      const json = args[args.indexOf('--json-output') + 1];
      await writeFile(json, JSON.stringify({
        info: { outcome: 'success' },
        result: { processIdentifier: 4321 },
      }));
    }
    if (args.includes('processes')) {
      await writeFile(args[args.indexOf('--json-output') + 1], JSON.stringify({
        info: { outcome: 'success' },
        result: {
          runningProcesses: [{
            bundleIdentifier: 'uk.eugnel.ks2spelling',
            processIdentifier: 4321,
            startDate: '2026-07-16T12:00:00.000Z',
          }],
        },
      }));
    }
    if (args.includes('terminate')) {
      await writeFile(args[args.indexOf('--json-output') + 1], JSON.stringify({
        info: { outcome: 'success' },
        result: { processIdentifier: 4321 },
      }));
    }
    if (args.slice(0, 4).join(' ') === 'devicectl device copy from') {
      const destination = args[args.indexOf('--destination') + 1];
      await writeFile(destination, observationBytes);
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const transport = createB3PhysicalDeviceTransport({
    root,
    platform: 'ios',
    env: { B3_IOS_PHYSICAL_DEVICE_ID: '00008140-001234560123001C' },
    runner,
  });
  await transport.launch(command('ios-physical'));
  assert.equal(calls[0][0], 'xcrun');
  assert.deepEqual(calls[0][1].slice(0, 8), [
    'devicectl', 'device', 'process', 'launch', '--device',
    '00008140-001234560123001C', '--terminate-existing', '--json-output',
  ]);
  assert.deepEqual(calls[0][1].slice(-3), [
    'uk.eugnel.ks2spelling', '--b3-proof-command-v1',
    canonicaliseB3ProofValue(command('ios-physical')),
  ]);
  assert.deepEqual(await transport.pullObservation(), observationBytes);
  const copyCall = calls.find(([, args]) => args.slice(0, 4).join(' ') ===
    'devicectl device copy from');
  assert.deepEqual(copyCall[0], 'xcrun');
  assert.deepEqual(copyCall[1].slice(0, 7), [
    'devicectl', 'device', 'copy', 'from', '--device',
    '00008140-001234560123001C', '--source',
  ]);
  assert.equal(
    copyCall[1][copyCall[1].indexOf('--source') + 1],
    'Library/Application Support/b3-proof-observation-v1.json',
  );
  assert.equal(copyCall[1].includes('--domain-type'), true);
  assert.equal(copyCall[1][copyCall[1].indexOf('--domain-type') + 1], 'appDataContainer');
  assert.equal(copyCall[1][copyCall[1].indexOf('--domain-identifier') + 1], 'uk.eugnel.ks2spelling');
  let receiptRetained = false;
  await transport.forceStop({
    command: relaunchCommand(),
    retainReceipt: async ({ processIdentifier, startDate }) => {
      assert.equal(processIdentifier, 4321);
      assert.equal(startDate, '2026-07-16T12:00:00.000Z');
      receiptRetained = true;
    },
  });
  assert.equal(receiptRetained, true);
  assert.equal(calls.filter(([, args]) => args.includes('processes')).length, 2);
  const terminateCall = calls.find(([, args]) => args.includes('terminate'));
  assert.deepEqual(terminateCall[1].slice(0, 8), [
    'devicectl', 'device', 'process', 'terminate', '--device',
    '00008140-001234560123001C', '--pid', '4321',
  ]);
  assert.equal(terminateCall[1].includes('--kill'), true);
});

test('fresh iOS transport cannot authorise force-stop without retained launch identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-ios-resumed-stop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const runner = async (executable, args) => {
    calls.push([executable, args]);
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const transport = createB3PhysicalDeviceTransport({
    root,
    platform: 'ios',
    env: { B3_IOS_PHYSICAL_DEVICE_ID: '00008140-001234560123001C' },
    runner,
  });
  await assert.rejects(
    transport.forceStop({ command: relaunchCommand() }),
    /retained launch identity/i,
  );
  assert.deepEqual(calls, []);
});

test('fresh iOS transport resumes force-stop from exact append-only launch identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-ios-durable-launch-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const runner = async (_executable, args) => {
    calls.push(args);
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
    } else if (args.includes('terminate')) {
      await writeFile(output, JSON.stringify({
        info: { outcome: 'success' }, result: { processIdentifier: 4321 },
      }));
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  await createB3PhysicalDeviceTransport({
    root,
    platform: 'ios',
    env: { B3_IOS_PHYSICAL_DEVICE_ID: '00008140-001234560123001C' },
    runner,
  }).launch(command('ios-physical'));
  const identityDirectory = join(root, '.native-build/b3/evidence/ios-transport');
  const identityName = (await readdir(identityDirectory))
    .find((name) => name.endsWith('.launch-identity.json'));
  const identityPath = join(identityDirectory, identityName);
  const identityRecord = JSON.parse(await readFile(identityPath, 'utf8'));
  assert.equal((await stat(identityPath)).mode & 0o777, 0o600);
  assert.equal(identityRecord.captureId, command('ios-physical').captureId);
  assert.equal(identityRecord.sequence, 1);
  assert.equal(identityRecord.deviceIdentifier, '00008140-001234560123001C');
  assert.deepEqual(identityRecord.command, command('ios-physical'));
  assert.equal(await readFile(identityPath, 'utf8').then((value) => value.endsWith('\n')), false);
  const crashedWriterAlias = join(
    identityDirectory,
    '.launch-identity-018f1d7b-97e8-4a52-8cf2-783e5089c099.tmp',
  );
  await link(identityPath, crashedWriterAlias);

  let receipt;
  await createB3PhysicalDeviceTransport({
    root,
    platform: 'ios',
    env: { B3_IOS_PHYSICAL_DEVICE_ID: '00008140-001234560123001C' },
    runner,
  }).forceStop({
    command: relaunchCommand(),
    retainReceipt: async (value) => { receipt = value; },
  });
  assert.deepEqual(receipt, {
    deviceIdentifier: '00008140-001234560123001C',
    processIdentifier: 4321,
    startDate: '2026-07-16T12:00:00.000Z',
  });
  await assert.rejects(stat(crashedWriterAlias), /ENOENT/u);
  assert.equal((await stat(identityPath)).nlink, 1);
  assert.equal(calls.filter((args) => args.includes('terminate')).length, 1);
});

test('resumed iOS force-stop rejects a different physical device before inventory or SIGKILL', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-ios-durable-device-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstDevice = '00008140-001234560123001A';
  const secondDevice = '00008140-001234560123001B';
  const calls = [];
  const runner = async (_executable, args) => {
    calls.push(args);
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
    } else if (args.includes('terminate')) {
      await writeFile(output, JSON.stringify({
        info: { outcome: 'success' }, result: { processIdentifier: 4321 },
      }));
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  await createB3PhysicalDeviceTransport({
    root,
    platform: 'ios',
    env: { B3_IOS_PHYSICAL_DEVICE_ID: firstDevice },
    runner,
  }).launch(command('ios-physical'));
  const callCountAfterLaunch = calls.length;

  await assert.rejects(
    createB3PhysicalDeviceTransport({
      root,
      platform: 'ios',
      env: { B3_IOS_PHYSICAL_DEVICE_ID: secondDevice },
      runner,
    }).forceStop({ command: relaunchCommand() }),
    /device.*identity|identity.*device/i,
  );
  assert.equal(calls.length, callCountAfterLaunch);
  assert.equal(calls.some((args) => args.includes('terminate')), false);
});

test('iOS force-stop rejects a different optional terminate-result device before receipt', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-ios-terminate-result-device-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const device = '00008140-001234560123001A';
  let receiptRetained = false;
  const runner = async (_executable, args) => {
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
    } else if (args.includes('terminate')) {
      await writeFile(output, JSON.stringify({
        info: { outcome: 'success' },
        result: {
          processIdentifier: 4321,
          deviceIdentifier: '00008140-001234560123001B',
        },
      }));
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const transport = createB3PhysicalDeviceTransport({
    root,
    platform: 'ios',
    env: { B3_IOS_PHYSICAL_DEVICE_ID: device },
    runner,
  });
  await transport.launch(command('ios-physical'));
  await assert.rejects(
    transport.forceStop({
      command: relaunchCommand(),
      retainReceipt: async () => { receiptRetained = true; },
    }),
    /terminate JSON result/i,
  );
  assert.equal(receiptRetained, false);
});

test('iOS launch rejects missing, malformed, duplicate or unmatched process start identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-ios-launch-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = 'uk.eugnel.ks2spelling';
  const exact = `{"bundleIdentifier":"${bundle}","processIdentifier":4321`;
  const cases = [
    `${exact}}`,
    `${exact},"startDate":"not-a-date"}`,
    `${exact},"startDate":"2026-02-30T12:00:00.000Z"}`,
    `${exact},"startDate":"2026-07-16T12:00:00.000Z","startDate":"2026-07-16T12:00:01.000Z"}`,
    `{"bundleIdentifier":"${bundle}","processIdentifier":9999,"startDate":"2026-07-16T12:00:00.000Z"}`,
    `${exact},"startDate":"2026-07-16T12:00:00.000Z"},${exact},"startDate":"2026-07-16T12:00:00.000Z"}`,
  ];
  for (const entries of cases) {
    const commands = [];
    const transport = createB3PhysicalDeviceTransport({
      root,
      platform: 'ios',
      env: { B3_IOS_PHYSICAL_DEVICE_ID: '00008140-001234560123001C' },
      runner: async (_executable, args) => {
        const output = args[args.indexOf('--json-output') + 1];
        if (args.includes('launch')) {
          commands.push('launch');
          await writeFile(output, JSON.stringify({
            info: { outcome: 'success' }, result: { processIdentifier: 4321 },
          }));
        } else if (args.includes('processes')) {
          commands.push('processes');
          await writeFile(
            output,
            `{"info":{"outcome":"success"},"result":{"runningProcesses":[${entries}]}}`,
          );
        } else {
          commands.push('unexpected-side-effect');
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    await assert.rejects(
      transport.launch(command('ios-physical')),
      /start|identity|process|JSON|ambiguous/i,
    );
    assert.deepEqual(commands, ['launch', 'processes']);
  }
});

test('iOS launch rejects a different optional launch-result device before process inventory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-ios-launch-result-device-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const transport = createB3PhysicalDeviceTransport({
    root,
    platform: 'ios',
    env: { B3_IOS_PHYSICAL_DEVICE_ID: '00008140-001234560123001A' },
    runner: async (_executable, args) => {
      calls.push(args);
      const output = args[args.indexOf('--json-output') + 1];
      await writeFile(output, JSON.stringify({
        info: { outcome: 'success' },
        result: {
          processIdentifier: 4321,
          deviceIdentifier: '00008140-001234560123001B',
        },
      }));
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  await assert.rejects(
    transport.launch(command('ios-physical')),
    /launch JSON result/i,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].includes('launch'), true);
});

test('iOS launch identity filename retains the full validated safe-integer sequence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-ios-launch-sequence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runner = async (_executable, args) => {
    const output = args[args.indexOf('--json-output') + 1];
    if (args.includes('launch')) {
      await writeFile(output, JSON.stringify({
        info: { outcome: 'success' }, result: { processIdentifier: 4321 },
      }));
    } else {
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
  };
  await createB3PhysicalDeviceTransport({
    root,
    platform: 'ios',
    env: { B3_IOS_PHYSICAL_DEVICE_ID: '00008140-001234560123001C' },
    runner,
  }).launch({
    ...command('ios-physical'),
    expectedSequence: Number.MAX_SAFE_INTEGER,
  });
  const entries = await readdir(join(root, '.native-build/b3/evidence/ios-transport'));
  assert.equal(
    entries.some((name) => name.startsWith(`${Number.MAX_SAFE_INTEGER}-`)),
    true,
  );
});

test('iOS launch-identity ledger rejects hostile links, permissions, duplicate claims and entry floods', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-ios-launch-ledger-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let terminateCalls = 0;
  const runner = async (_executable, args) => {
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
    } else if (args.includes('terminate')) {
      terminateCalls += 1;
      await writeFile(output, JSON.stringify({
        info: { outcome: 'success' }, result: { processIdentifier: 4321 },
      }));
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const options = {
    root,
    platform: 'ios',
    env: { B3_IOS_PHYSICAL_DEVICE_ID: '00008140-001234560123001C' },
    runner,
  };
  await createB3PhysicalDeviceTransport(options).launch(command('ios-physical'));
  const directory = join(root, '.native-build/b3/evidence/ios-transport');
  const identityName = (await readdir(directory))
    .find((name) => name.endsWith('.launch-identity.json'));
  const identityPath = join(directory, identityName);

  const hardLink = `${identityPath}.hostile`;
  await link(identityPath, hardLink);
  await assert.rejects(
    createB3PhysicalDeviceTransport(options).forceStop({ command: relaunchCommand() }),
    /hard-link|file policy|identity/i,
  );
  await rm(hardLink);

  await chmod(identityPath, 0o644);
  await assert.rejects(
    createB3PhysicalDeviceTransport(options).forceStop({ command: relaunchCommand() }),
    /file policy|identity/i,
  );
  await chmod(identityPath, 0o600);

  const symbolicClaim = join(
    directory,
    `00000001-${'f'.repeat(64)}.launch-identity.json`,
  );
  await symlink(identityPath, symbolicClaim);
  await assert.rejects(
    createB3PhysicalDeviceTransport(options).forceStop({ command: relaunchCommand() }),
    /entry policy|identity/i,
  );
  await rm(symbolicClaim);
  assert.equal(terminateCalls, 0);

  await createB3PhysicalDeviceTransport(options).launch({
    ...command('ios-physical'),
    challengeSha256: 'f'.repeat(64),
  });
  await assert.rejects(
    createB3PhysicalDeviceTransport(options).forceStop({ command: relaunchCommand() }),
    /absent|ambiguous/i,
  );
  assert.equal(terminateCalls, 0);

  for (let index = 0; index < 255; index += 1) {
    await writeFile(join(directory, `untrusted-${String(index).padStart(3, '0')}`), 'x', {
      mode: 0o600,
    });
  }
  await assert.rejects(
    createB3PhysicalDeviceTransport(options).forceStop({ command: relaunchCommand() }),
    /entry bound/i,
  );
  assert.equal(terminateCalls, 0);
});

test('iOS force-stop rejects a recycled retained PID before SIGKILL', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-ios-pid-reuse-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let terminateCalls = 0;
  let processInventoryCalls = 0;
  const runner = async (_executable, args) => {
    const output = args[args.indexOf('--json-output') + 1];
    if (args.includes('launch')) {
      await writeFile(output, JSON.stringify({
        info: { outcome: 'success' }, result: { processIdentifier: 4321 },
      }));
    } else if (args.includes('processes')) {
      processInventoryCalls += 1;
      await writeFile(output, JSON.stringify({
        info: { outcome: 'success' },
        result: { runningProcesses: [{
          bundleIdentifier: 'uk.eugnel.ks2spelling',
          processIdentifier: processInventoryCalls === 1 ? 4321 : 9999,
          startDate: processInventoryCalls === 1
            ? '2026-07-16T12:00:00.000Z'
            : '2026-07-16T12:00:01.000Z',
        }] },
      }));
    } else {
      terminateCalls += 1;
      await writeFile(output, JSON.stringify({
        info: { outcome: 'success' }, result: { processIdentifier: 4321 },
      }));
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const transport = createB3PhysicalDeviceTransport({
    root,
    platform: 'ios',
    env: { B3_IOS_PHYSICAL_DEVICE_ID: '00008140-001234560123001C' },
    runner,
  });
  await transport.launch(command('ios-physical'));
  await assert.rejects(
    transport.forceStop({ command: relaunchCommand() }),
    /PID|process|bundle/i,
  );
  assert.equal(terminateCalls, 0);
});

test('iOS force-stop rejects the same numeric PID with a different process start date', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-ios-same-pid-reuse-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let processInventoryCalls = 0;
  let terminateCalls = 0;
  const runner = async (_executable, args) => {
    const output = args[args.indexOf('--json-output') + 1];
    if (args.includes('launch')) {
      await writeFile(output, JSON.stringify({
        info: { outcome: 'success' }, result: { processIdentifier: 4321 },
      }));
    } else if (args.includes('processes')) {
      processInventoryCalls += 1;
      await writeFile(output, JSON.stringify({
        info: { outcome: 'success' },
        result: { runningProcesses: [{
          bundleIdentifier: 'uk.eugnel.ks2spelling',
          processIdentifier: 4321,
          startDate: processInventoryCalls === 1
            ? '2026-07-16T12:00:00.000Z'
            : '2026-07-16T12:00:01.000Z',
        }] },
      }));
    } else {
      terminateCalls += 1;
      await writeFile(output, JSON.stringify({
        info: { outcome: 'success' }, result: { processIdentifier: 4321 },
      }));
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const transport = createB3PhysicalDeviceTransport({
    root,
    platform: 'ios',
    env: { B3_IOS_PHYSICAL_DEVICE_ID: '00008140-001234560123001C' },
    runner,
  });
  await transport.launch(command('ios-physical'));
  await assert.rejects(
    transport.forceStop({ command: relaunchCommand() }),
    /start|identity|process|PID/i,
  );
  assert.equal(terminateCalls, 0);
});

test('Android transport uses explicit activity, fixed external pull and direct binary screencap', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-android-transport-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const observationBytes = Buffer.from('{"device":"observation"}', 'utf8');
  const runner = async (executable, args) => {
    calls.push([executable, args]);
    if (args.includes('pull')) {
      await writeFile(args.at(-1), observationBytes);
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const png = createB3TestPng({ width: 1080, height: 2400 });
  const binaryRunner = async (executable, args) => {
    calls.push([executable, args]);
    return { exitCode: 0, stdout: png, stderr: Buffer.alloc(0) };
  };
  const transport = createB3PhysicalDeviceTransport({
    root,
    platform: 'android',
    env: { B3_ANDROID_PHYSICAL_DEVICE_ID: 'R5CT1234ABC' },
    runner,
    binaryRunner,
  });
  await transport.launch(command('android-play-physical'));
  assert.deepEqual(calls[0], [
    'adb',
    [
      '-s', 'R5CT1234ABC', 'shell', 'am', 'start', '-S', '-W', '-n',
      'uk.eugnel.ks2spelling/.MainActivity', '--es',
      'uk.eugnel.ks2spelling.B3_PROOF_COMMAND_V1',
      canonicaliseB3ProofValue(command('android-play-physical')),
    ],
  ]);
  assert.deepEqual(await transport.pullObservation(), observationBytes);
  assert.equal(
    calls[1][1].at(-2),
    '/sdcard/Android/data/uk.eugnel.ks2spelling/files/b3-proof-observation-v1.json',
  );
  assert.deepEqual(await transport.captureScreenshot(), png);
  await transport.foregroundApplication();
  assert.deepEqual(calls.at(-1)[1], [
    '-s', 'R5CT1234ABC', 'shell', 'am', 'start', '-W', '-n',
    'uk.eugnel.ks2spelling/.MainActivity',
  ]);
  assert.deepEqual(calls[2], [
    'adb',
    ['-s', 'R5CT1234ABC', 'exec-out', 'screencap', '-p'],
  ]);

  const invalid = createB3PhysicalDeviceTransport({
    root,
    platform: 'android',
    env: { B3_ANDROID_PHYSICAL_DEVICE_ID: 'R5CT1234ABC' },
    runner,
    binaryRunner: async () => ({
      exitCode: 0,
      stdout: Buffer.from('not a png'),
      stderr: Buffer.alloc(0),
    }),
  });
  await assert.rejects(invalid.captureScreenshot(), /PNG|screenshot/i);
});

test('device inspection derives bounded physical model and OS from platform tools', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-device-inspection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const iosId = '00008140-001234560123001C';
  const ios = createB3PhysicalDeviceTransport({
    root,
    platform: 'ios',
    env: { B3_IOS_PHYSICAL_DEVICE_ID: iosId },
    runner: async (_executable, args) => {
      await writeFile(args[args.indexOf('--json-output') + 1], JSON.stringify({
        info: { outcome: 'success' },
        result: {
          devices: [{
            identifier: iosId,
            hardwareProperties: { marketingName: 'iPhone 17', reality: 'physical' },
            deviceProperties: { osVersionNumber: '26.0' },
          }],
        },
      }));
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  assert.deepEqual(await ios.inspectDevice(), {
    model: 'iPhone 17', osVersion: '26.0', physical: true,
  });

  const android = createB3PhysicalDeviceTransport({
    root,
    platform: 'android',
    env: { B3_ANDROID_PHYSICAL_DEVICE_ID: 'R5CT1234ABC' },
    runner: async (_executable, args) => {
      const property = args.at(-1);
      const stdout = {
        'ro.kernel.qemu': '',
        'ro.product.model': 'Pixel 9 Pro\n',
        'ro.build.version.release': '16\n',
      }[property];
      return { exitCode: 0, stdout, stderr: '' };
    },
  });
  assert.deepEqual(await android.inspectDevice(), {
    model: 'Pixel 9 Pro', osVersion: '16', physical: true,
  });
});

test('transport fails closed for absent or injectable physical device identifiers', async () => {
  for (const [platform, env, expectedPlatform] of [
    ['ios', {}, 'ios-physical'],
    ['android', { B3_ANDROID_PHYSICAL_DEVICE_ID: 'serial; reboot' }, 'android-play-physical'],
  ]) {
    const transport = createB3PhysicalDeviceTransport({
      root: '/tmp',
      platform,
      env,
      runner: async () => assert.fail('runner must not execute'),
    });
    await assert.rejects(transport.launch(command(expectedPlatform)), /device identifier|physical device/i);
  }
});

test('transport rejects wrong platform commands and bounded command failures without leaking output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'b3-transport-failure-'));
  const secret = 'secret-output-must-not-escape';
  try {
    const transport = createB3PhysicalDeviceTransport({
      root,
      platform: 'ios',
      env: { B3_IOS_PHYSICAL_DEVICE_ID: '00008140-001234560123001C' },
      runner: async () => ({ exitCode: 1, stdout: secret, stderr: secret }),
    });
    await assert.rejects(
      transport.launch(command('android-play-physical')),
      /platform/i,
    );
    await assert.rejects(
      transport.launch(command('ios-physical')),
      (error) => error.code === 'b3_physical_device_command_failed' && !error.message.includes(secret),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
