import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  captureB3IosScreenshotBytes,
  runB3IosScreenshotProcess,
} from '../scripts/lib/b3-ios-proof-screenshot.mjs';
import { createB3TestPng } from './helpers/b3-test-png.mjs';

const DEVICE_ID = '00008140-001234560123001C';

function attachmentManifest(overrides = {}) {
  return [{
    testIdentifier: 'B3ProofUITests/B3ProofScreenshotTests/testCaptureInstalledApplication()',
    attachments: [{
      exportedFileName: 'attachment.png',
      suggestedHumanReadableName: 'b3-ios-sandbox-proof.png',
      isAssociatedWithFailure: false,
      configurationName: 'Test Action',
      deviceName: 'iPhone',
      deviceId: DEVICE_ID,
      ...overrides,
    }],
  }];
}

function attachmentExportRunner(png, exportManifest) {
  return async (_executable, args) => {
    if (args.includes('-resultBundlePath')) {
      await mkdir(args[args.indexOf('-resultBundlePath') + 1], { recursive: true });
    }
    if (args.slice(0, 3).join(' ') === 'xcresulttool export attachments') {
      const output = args[args.indexOf('--output-path') + 1];
      await mkdir(output, { recursive: true });
      await writeFile(join(output, 'attachment.png'), png);
      await exportManifest(output);
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

function runFifoExportProbe({ root, kind }) {
  const program = String.raw`
    import { spawnSync } from 'node:child_process';
    import { mkdir, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { captureB3IosScreenshotBytes } from './scripts/lib/b3-ios-proof-screenshot.mjs';

    const root = process.env.B3_FIFO_PROBE_ROOT;
    const kind = process.env.B3_FIFO_PROBE_KIND;
    const runner = async (_executable, args) => {
      if (args.includes('-resultBundlePath')) {
        await mkdir(args[args.indexOf('-resultBundlePath') + 1], { recursive: true });
      }
      if (args.slice(0, 3).join(' ') === 'xcresulttool export attachments') {
        const output = args[args.indexOf('--output-path') + 1];
        await mkdir(output, { recursive: true });
        const manifest = ${JSON.stringify(attachmentManifest())};
        if (kind === 'manifest') {
          const created = spawnSync('/usr/bin/mkfifo', [join(output, 'manifest.json')]);
          if (created.status !== 0) throw new Error('manifest FIFO creation failed');
        } else {
          await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest));
          const created = spawnSync('/usr/bin/mkfifo', [join(output, 'attachment.png')]);
          if (created.status !== 0) throw new Error('attachment FIFO creation failed');
        }
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    try {
      await captureB3IosScreenshotBytes({
        root,
        deviceId: '${DEVICE_ID}',
        runner,
      });
      process.exitCode = 3;
    } catch (error) {
      process.stdout.write(String(error?.code ?? 'rejected'));
    }
  `;
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 3_000,
    env: {
      ...process.env,
      B3_FIFO_PROBE_ROOT: root,
      B3_FIFO_PROBE_KIND: kind,
    },
  });
  return { ...result, elapsedMs: Date.now() - startedAt };
}

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

test('iOS screenshot production runner terminates its complete timed-out process group', async () => {
  const childProgram = [
    "const { spawn } = require('node:child_process');",
    "const grandchild = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)\"], { stdio: ['ignore', 'pipe', 'ignore'] });",
    "grandchild.stdout.once('data', () => process.stdout.write(String(grandchild.pid), () => {",
    "  process.on('SIGTERM', () => process.exit(0));",
    '  setInterval(() => {}, 1000);',
    '}));',
  ].join('\n');
  let grandchildPid = null;
  try {
    const startedAt = Date.now();
    const result = await runB3IosScreenshotProcess(
      process.execPath,
      ['-e', childProgram],
      { timeoutMs: 1_000 },
    );
    grandchildPid = Number(result.stdout);
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - startedAt >= 1_250, 'runner settled before SIGKILL escalation');
    assert.equal(Number.isSafeInteger(grandchildPid) && grandchildPid > 1, true);
    assert.equal(
      await processStopsWithin(grandchildPid),
      true,
      'iOS screenshot timeout left its descendant running',
    );
  } finally {
    if (Number.isSafeInteger(grandchildPid) && grandchildPid > 1) {
      try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* Best-effort test cleanup. */ }
    }
  }
});

test('iOS screenshot production runner bounds each text stream', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const result = await runB3IosScreenshotProcess(
      process.execPath,
      ['-e', `process.${stream}.write(Buffer.alloc(300 * 1024, 97)); setInterval(() => {}, 1000)`],
      { timeoutMs: 5_000 },
    );
    assert.equal(result.outputExceeded, true);
    assert.equal(Buffer.byteLength(result[stream]), 256 * 1024);
    assert.equal(Buffer.byteLength(result[stream === 'stdout' ? 'stderr' : 'stdout']), 0);
    assert.equal(result.exitCode, 1);
  }
});

test('iOS screenshot capture runs only independent B3ProofUITests and exports its named attachment', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-ios-screenshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const png = createB3TestPng({ width: 1179, height: 2556 });
  const calls = [];
  const runner = async (executable, args) => {
    calls.push([executable, args]);
    if (executable === 'xcodebuild') {
      await mkdir(args[args.indexOf('-resultBundlePath') + 1], { recursive: true });
    }
    if (args.slice(0, 3).join(' ') === 'xcresulttool export attachments') {
      const output = args[args.indexOf('--output-path') + 1];
      await mkdir(output, { recursive: true });
      await writeFile(join(output, 'attachment-1.png'), png);
      await writeFile(join(output, 'manifest.json'), JSON.stringify([{
        testIdentifier: 'B3ProofUITests/B3ProofScreenshotTests/testCaptureInstalledApplication()',
        attachments: [{
          exportedFileName: 'attachment-1.png',
          suggestedHumanReadableName: 'b3-ios-sandbox-proof.png',
          isAssociatedWithFailure: false,
          configurationName: 'Test Action',
          deviceName: 'James iPhone',
          deviceId: DEVICE_ID,
        }],
      }]));
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  assert.deepEqual(await captureB3IosScreenshotBytes({
    root,
    deviceId: DEVICE_ID,
    runner,
  }), png);
  assert.equal(calls[0][0], 'xcodebuild');
  assert.deepEqual(calls[0][1].slice(0, 6), [
    '-project', join(root, 'ios/App/App.xcodeproj'),
    '-scheme', 'B3ProofUITests',
    '-configuration', 'B3SandboxProof',
  ]);
  assert.ok(calls[0][1].includes(`id=${DEVICE_ID}`));
  assert.ok(calls[0][1].includes('-only-testing:B3ProofUITests/B3ProofScreenshotTests/testCaptureInstalledApplication'));
  assert.equal(calls[0][1].includes('B3SandboxProof'), true);
  assert.equal(calls[0][1].includes('App'), false);
  assert.deepEqual(calls[1][0], 'xcrun');
  assert.deepEqual(calls[1][1].slice(0, 3), ['xcresulttool', 'export', 'attachments']);
});

test('iOS screenshot capture rejects wrong attachment, device and path provenance', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-ios-screenshot-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const attachment of [
    {
      exportedFileName: '../outside.png',
      suggestedHumanReadableName: 'b3-ios-sandbox-proof.png',
      deviceId: DEVICE_ID,
    },
    {
      exportedFileName: 'attachment.png',
      suggestedHumanReadableName: 'operator-chosen.png',
      deviceId: DEVICE_ID,
    },
    {
      exportedFileName: 'attachment.png',
      suggestedHumanReadableName: 'b3-ios-sandbox-proof.png',
      deviceId: 'different-device',
    },
  ]) {
    const runner = async (_executable, args) => {
      if (args.includes('-resultBundlePath')) {
        await mkdir(args[args.indexOf('-resultBundlePath') + 1], { recursive: true });
      }
      if (args.slice(0, 3).join(' ') === 'xcresulttool export attachments') {
        const output = args[args.indexOf('--output-path') + 1];
        await mkdir(output, { recursive: true });
        await writeFile(join(output, 'attachment.png'), Buffer.alloc(33));
        await writeFile(join(output, 'manifest.json'), JSON.stringify([{
          testIdentifier: 'B3ProofUITests/B3ProofScreenshotTests/testCaptureInstalledApplication()',
          attachments: [{
            isAssociatedWithFailure: false,
            configurationName: 'Test Action',
            deviceName: 'iPhone',
            ...attachment,
          }],
        }]));
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    await assert.rejects(
      captureB3IosScreenshotBytes({ root, deviceId: DEVICE_ID, runner }),
      /attachment|device|path|manifest/i,
    );
  }
});

test('iOS screenshot capture fails closed before xcodebuild for invalid device IDs', async () => {
  await assert.rejects(
    captureB3IosScreenshotBytes({
      root: '/tmp',
      deviceId: 'id; open Calculator',
      runner: async () => assert.fail('runner must not execute'),
    }),
    /device identifier/i,
  );
});

test('iOS screenshot capture rejects a symbolic-link attachment manifest', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-ios-screenshot-manifest-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outsideManifest = join(root, 'operator-manifest.json');
  const png = createB3TestPng({ width: 1179, height: 2556 });
  await writeFile(outsideManifest, JSON.stringify(attachmentManifest()));
  const runner = attachmentExportRunner(png, (output) =>
    symlink(outsideManifest, join(output, 'manifest.json')));

  await assert.rejects(
    captureB3IosScreenshotBytes({ root, deviceId: DEVICE_ID, runner }),
    /manifest|link|path|regular/i,
  );
});

test('iOS screenshot capture promptly rejects a FIFO attachment manifest', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-ios-screenshot-manifest-fifo-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = runFifoExportProbe({ root, kind: 'manifest' });

  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.match(result.stdout, /b3_ios_screenshot_capture_invalid|rejected/u);
  assert.ok(result.elapsedMs < 2_500, 'FIFO manifest rejection exceeded its fixed bound');
});

test('iOS screenshot capture promptly rejects a FIFO selected attachment', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-ios-screenshot-attachment-fifo-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = runFifoExportProbe({ root, kind: 'attachment' });

  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.match(result.stdout, /b3_ios_screenshot_capture_invalid|rejected/u);
  assert.ok(result.elapsedMs < 2_500, 'FIFO attachment rejection exceeded its fixed bound');
});

test('iOS screenshot capture rejects a hard-linked attachment manifest', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-ios-screenshot-manifest-hard-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outsideManifest = join(root, 'operator-manifest.json');
  const png = createB3TestPng({ width: 1179, height: 2556 });
  await writeFile(outsideManifest, JSON.stringify(attachmentManifest()));
  const runner = attachmentExportRunner(png, (output) =>
    link(outsideManifest, join(output, 'manifest.json')));

  await assert.rejects(
    captureB3IosScreenshotBytes({ root, deviceId: DEVICE_ID, runner }),
    /manifest|link|path|regular/i,
  );
});

test('iOS screenshot capture rejects an oversized attachment manifest before parsing it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-ios-screenshot-manifest-oversized-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const png = createB3TestPng({ width: 1179, height: 2556 });
  const runner = attachmentExportRunner(png, (output) =>
    writeFile(join(output, 'manifest.json'), JSON.stringify(attachmentManifest({
      arguments: 'a'.repeat(256 * 1024),
    }))));

  await assert.rejects(
    captureB3IosScreenshotBytes({ root, deviceId: DEVICE_ID, runner }),
    /manifest.*bound|bound.*manifest|manifest.*size/i,
  );
});

test('iOS screenshot capture rejects an attachment export directory outside its private capture root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'b3-ios-screenshot-export-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = join(root, 'operator-attachments');
  const png = createB3TestPng({ width: 1179, height: 2556 });
  await mkdir(outside);
  await writeFile(join(outside, 'attachment.png'), png);
  await writeFile(join(outside, 'manifest.json'), JSON.stringify(attachmentManifest()));

  const runner = async (_executable, args) => {
    if (args.includes('-resultBundlePath')) {
      await mkdir(args[args.indexOf('-resultBundlePath') + 1], { recursive: true });
    }
    if (args.slice(0, 3).join(' ') === 'xcresulttool export attachments') {
      await symlink(outside, args[args.indexOf('--output-path') + 1]);
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  await assert.rejects(
    captureB3IosScreenshotBytes({ root, deviceId: DEVICE_ID, runner }),
    /attachment.*directory|directory.*attachment|contain|escape|link/i,
  );
});
