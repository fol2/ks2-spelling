import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

import { canonicaliseB3ProofValue } from '../src/app/b3-live-proof-protocol.js';

const execFileAsync = promisify(execFile);
const COMMIT = '1'.repeat(40);
const FINGERPRINT = '2'.repeat(64);
const CAPTURE_ID = '018f1d7b-97e8-4a52-8cf2-783e5089c001';
const FIRST_COMMAND_SHA256 = '1f0de6d66179333a8e7adca7cb537342b19278e61aaff41a10a154da04652880';
const FIRST_PREPARED_RECORD_SHA256 =
  '9d3bfbae6203275b1c7ef777b001f8254ebab77b334843ad8ac2a5c28898beaa';
const START_INTENT_SHA256 =
  '60330a9948db44bae18d3db4324ce708bbe57018c73bf181043e4539a3b3a521';

async function fixture(t, label) {
  const root = await mkdtemp(join(tmpdir(), `b3-capture-repository-${label}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const distribution = join(root, '.native-build', 'b3', 'distribution');
  await mkdir(distribution, { recursive: true, mode: 0o700 });
  for (const path of [
    join(root, '.native-build'),
    join(root, '.native-build', 'b3'),
    distribution,
  ]) await chmod(path, 0o700);
  await writeFile(join(distribution, 'build-authority.json'), JSON.stringify({
    schemaVersion: 1,
    testedApplicationCommit: COMMIT,
    applicationFingerprint: FINGERPRINT,
    versionName: '0.3.0-b3',
    iosBuildNumber: '19',
    androidVersionCode: 19,
  }), { mode: 0o600 });
  return root;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fileSha256(path) {
  return sha256(await readFile(path));
}

function databasePath(root, platform = 'ios') {
  return join(
    root,
    '.native-build',
    'b3',
    'evidence',
    `${platform}-capture-state`,
    'recovery.sqlite',
  );
}

function initialCommand(captureId = CAPTURE_ID, platform = 'ios') {
  const commandWithoutChallenge = {
    schemaVersion: 1,
    captureId,
    platform: platform === 'ios' ? 'ios-physical' : 'android-play-physical',
    testedApplicationCommit: COMMIT,
    applicationFingerprint: FINGERPRINT,
    expectedScenarioIndex: 0,
    expectedSequence: 1,
    previousObservationSha256: '0'.repeat(64),
    installationMode: 'existing',
    actionCode: 'ARM_CAPTURE',
  };
  return {
    ...commandWithoutChallenge,
    challengeSha256: sha256(Buffer.from(
      `ks2-spelling:b3-host-command-challenge:v1\0${canonicaliseB3ProofValue(commandWithoutChallenge)}`,
      'utf8',
    )),
  };
}

async function reserveInChild(root, command, platform = 'ios') {
  const helper = new URL('./helpers/b3-capture-state-reserve-child.mjs', import.meta.url);
  const { stdout } = await execFileAsync(process.execPath, [
    '--experimental-test-module-mocks',
    helper.pathname,
    platform,
    Buffer.from(JSON.stringify(command), 'utf8').toString('base64url'),
  ], { cwd: root });
  return JSON.parse(stdout);
}

async function probeInChild(root, mode, commands = [], platform = 'ios') {
  const helper = new URL(
    './helpers/b3-capture-state-repository-probe-child.mjs',
    import.meta.url,
  );
  const { stdout } = await execFileAsync(process.execPath, [
    '--experimental-test-module-mocks',
    helper.pathname,
    mode,
    platform,
    ...commands.map((command) =>
      Buffer.from(JSON.stringify(command), 'utf8').toString('base64url')),
  ], { cwd: root });
  return JSON.parse(stdout);
}

async function foundationSurfaceInChild(root) {
  const helper = new URL('./helpers/b3-capture-state-database-child.mjs', import.meta.url);
  const { stdout } = await execFileAsync(process.execPath, [
    '--experimental-test-module-mocks', helper.pathname, 'ios', 'surface-shape',
  ], { cwd: root });
  return JSON.parse(stdout);
}

function spawnBarrierReserver(root, command, platform = 'ios') {
  const helper = new URL('./helpers/b3-capture-state-reserve-child.mjs', import.meta.url);
  const child = spawn(process.execPath, [
    '--experimental-test-module-mocks',
    helper.pathname,
    platform,
    Buffer.from(JSON.stringify(command), 'utf8').toString('base64url'),
    'barrier',
  ], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (stdout.includes('READY\n')) readyResolve();
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const result = new Promise((resolve, reject) => {
    child.once('exit', (code, signal) => {
      if (code !== 0) {
        const error = new Error(`reservation child failed (${code}, ${signal}): ${stderr}`);
        readyReject(error);
        reject(error);
        return;
      }
      const lines = stdout.trim().split('\n');
      resolve(JSON.parse(lines.at(-1)));
    });
  });
  return Object.freeze({
    ready,
    release() { child.stdin.end('go\n'); },
    result,
  });
}

function spawnStaleBuildReserver(root, command) {
  const helper = new URL(
    './helpers/b3-capture-state-stale-build-child.mjs',
    import.meta.url,
  );
  const child = spawn(process.execPath, [
    '--experimental-test-module-mocks',
    helper.pathname,
    Buffer.from(JSON.stringify(command), 'utf8').toString('base64url'),
  ], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (stdout.includes('READY\n')) readyResolve();
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const result = new Promise((resolve, reject) => {
    child.once('exit', (code, signal) => {
      if (code !== 0) {
        const error = new Error(`stale-build child failed (${code}, ${signal}): ${stderr}`);
        readyReject(error);
        reject(error);
        return;
      }
      resolve(JSON.parse(stdout.trim().split('\n').at(-1)));
    });
  });
  return Object.freeze({
    ready,
    release() { child.stdin.end('go\n'); },
    result,
  });
}

test('initial capture start reserves one immutable canonical command without allocating it',
  async (t) => {
    const root = await fixture(t, 'initial');
    const command = initialCommand();

    const reservation = await reserveInChild(root, command);

    assert.deepEqual(reservation, {
      schemaVersion: 1,
      startIntentSha256: START_INTENT_SHA256,
      intentKind: 'initial',
      recoveredCommandSha256: null,
      terminalClaimSha256: null,
      captureId: CAPTURE_ID,
      firstCommandSha256: FIRST_COMMAND_SHA256,
      firstCommand: command,
      firstPreparedRecordSha256: FIRST_PREPARED_RECORD_SHA256,
      intentState: 'pending',
      rowVersion: 1,
    });
    const database = new DatabaseSync(join(
      root, '.native-build', 'b3', 'evidence', 'ios-capture-state', 'recovery.sqlite',
    ), { readOnly: true });
    t.after(() => database.close());
    assert.deepEqual(database.prepare(`
      SELECT start_intent_sha256, intent_kind, capture_id, first_command_sha256,
        first_prepared_record_sha256, intent_state, row_version
      FROM b3_capture_start_intents
    `).all().map((row) => ({ ...row })), [{
      start_intent_sha256: START_INTENT_SHA256,
      intent_kind: 'initial',
      capture_id: CAPTURE_ID,
      first_command_sha256: FIRST_COMMAND_SHA256,
      first_prepared_record_sha256: FIRST_PREPARED_RECORD_SHA256,
      intent_state: 'pending',
      row_version: 1,
    }]);
    assert.deepEqual(database.prepare('SELECT * FROM b3_authority_state').all()
      .map((row) => ({ ...row })), [{
      singleton: 1,
      next_allocation_sequence: 1,
      active_command_sha256: null,
      reserved_start_command_sha256: FIRST_COMMAND_SHA256,
      row_version: 2,
    }]);
    assert.equal(database.prepare('SELECT count(*) AS count FROM b3_captures').get().count, 0);
    assert.equal(database.prepare('SELECT count(*) AS count FROM b3_commands').get().count, 0);
  });

test('two real processes proposing different initial commands converge on one committed winner',
  async (t) => {
    const root = await fixture(t, 'duplicate-processes');
    const first = spawnBarrierReserver(
      root,
      initialCommand('018f1d7b-97e8-4a52-8cf2-783e5089c011'),
    );
    const second = spawnBarrierReserver(
      root,
      initialCommand('018f1d7b-97e8-4a52-8cf2-783e5089c012'),
    );
    await Promise.all([first.ready, second.ready]);

    first.release();
    second.release();
    const [firstResult, secondResult] = await Promise.all([first.result, second.result]);

    assert.deepEqual(firstResult, secondResult);
    assert.equal([
      '018f1d7b-97e8-4a52-8cf2-783e5089c011',
      '018f1d7b-97e8-4a52-8cf2-783e5089c012',
    ].includes(firstResult.captureId), true);
    const database = new DatabaseSync(join(
      root, '.native-build', 'b3', 'evidence', 'ios-capture-state', 'recovery.sqlite',
    ), { readOnly: true });
    assert.equal(database.prepare(`
      SELECT count(*) AS count FROM b3_capture_start_intents
    `).get().count, 1);
    assert.equal(database.prepare(`
      SELECT count(*) AS count FROM b3_commands
    `).get().count, 0);
    database.close();
  });

test('one repository session makes exact retries idempotent and different proposals adopt the winner',
  async (t) => {
    const root = await fixture(t, 'same-session-retry');
    const winner = initialCommand();
    const loser = initialCommand('018f1d7b-97e8-4a52-8cf2-783e5089c099');

    const probe = await probeInChild(root, 'retry', [winner, loser]);

    assert.equal(probe.ok, true);
    assert.deepEqual(probe.result[0], probe.result[1]);
    assert.equal(probe.result[0].captureId, winner.captureId);
  });

test('repository surface is closed and rejects use after close', async (t) => {
  const root = await fixture(t, 'closed-surface');
  assert.deepEqual(await foundationSurfaceInChild(root), {
    ok: true,
    surfaceKeys: ['close'],
  });
  const shape = await probeInChild(root, 'shape');
  assert.deepEqual(shape, {
    ok: true,
    result: ['close', 'reserveInitialCaptureStart'],
    getterCalls: 0,
  });

  const closed = await probeInChild(root, 'closed', [initialCommand()]);
  assert.equal(closed.ok, false);
  assert.match(closed.error.message, /closed/i);
});

test('invalid options and commands fail before any reservation mutation', async (t) => {
  const root = await fixture(t, 'invalid-input');
  await probeInChild(root, 'shape');
  const path = databasePath(root);
  const originalSha256 = await fileSha256(path);

  const extra = await probeInChild(root, 'invalid-extra');
  assert.equal(extra.ok, false);
  assert.equal(extra.getterCalls, 0);
  assert.match(extra.error.message, /reservation authority/i);
  assert.equal(await fileSha256(path), originalSha256);

  for (const command of [
    {},
    { ...initialCommand(), testedApplicationCommit: '3'.repeat(40) },
    { ...initialCommand(), actionCode: 'QUERY_PRODUCT' },
    initialCommand(CAPTURE_ID, 'android'),
  ]) {
    const invalid = await probeInChild(root, 'invalid-getter', [command]);
    assert.equal(invalid.ok, false);
    assert.equal(invalid.getterCalls, 1);
    assert.match(invalid.error.message, /invalid|authority|closed schema|differs/i);
    assert.equal(await fileSha256(path), originalSha256);
  }
});

test('invalid repository platform fails before creating capture-state namespace', async (t) => {
  const root = await fixture(t, 'invalid-platform');

  const invalid = await probeInChild(root, 'shape', [], 'watchos');

  assert.equal(invalid.ok, false);
  assert.match(invalid.error.message, /open authority/i);
  await assert.rejects(lstat(join(
    root, '.native-build', 'b3', 'evidence',
  )), { code: 'ENOENT' });
});

test('tampered pending intent and singleton authority fail closed without mutation',
  async (t) => {
    const scenarios = [
      {
        label: 'noncanonical-command',
        mutate(database, command) {
          database.prepare(`
            UPDATE b3_capture_start_intents SET first_command_json = ?
          `).run(Buffer.from(JSON.stringify(command, null, 2), 'utf8'));
        },
      },
      {
        label: 'intent-hash',
        mutate(database) {
          database.prepare(`
            UPDATE b3_capture_start_intents SET start_intent_sha256 = ?
          `).run('f'.repeat(64));
        },
      },
      {
        label: 'noncanonical-prepared-record',
        mutate(database) {
          const { first_prepared_record_json: bytes } = database.prepare(`
            SELECT first_prepared_record_json FROM b3_capture_start_intents
          `).get();
          database.prepare(`
            UPDATE b3_capture_start_intents SET first_prepared_record_json = ?
          `).run(Buffer.from(JSON.stringify(JSON.parse(Buffer.from(bytes)), null, 2), 'utf8'));
        },
      },
      {
        label: 'prepared-hash',
        mutate(database) {
          database.prepare(`
            UPDATE b3_capture_start_intents SET first_prepared_record_sha256 = ?
          `).run('e'.repeat(64));
        },
      },
      {
        label: 'singleton',
        mutate(database) {
          database.prepare(`
            UPDATE b3_authority_state SET next_allocation_sequence = 2
          `).run();
        },
      },
      {
        label: 'conflicting-reservation',
        mutate(database) {
          database.exec('PRAGMA foreign_keys = OFF');
          database.prepare(`
            UPDATE b3_authority_state SET reserved_start_command_sha256 = ?
          `).run('d'.repeat(64));
        },
      },
      {
        label: 'unsupported-capture',
        mutate(database) {
          database.prepare(`
            INSERT INTO b3_captures (
              capture_id, start_intent_sha256, capture_state, row_version
            ) VALUES (?, ?, 'working', 1)
          `).run(CAPTURE_ID, START_INTENT_SHA256);
        },
      },
    ];

    for (const scenario of scenarios) {
      const root = await fixture(t, `tampered-${scenario.label}`);
      const command = initialCommand();
      await reserveInChild(root, command);
      const path = databasePath(root);
      const database = new DatabaseSync(path);
      scenario.mutate(database, command);
      database.close();
      const tamperedSha256 = await fileSha256(path);

      const opened = await probeInChild(root, 'shape');

      assert.equal(opened.ok, false, scenario.label);
      assert.match(
        opened.error.message,
        /invalid|differs|unsupported|foreign-key/i,
        scenario.label,
      );
      assert.equal(await fileSha256(path), tamperedSha256, scenario.label);
    }
  });

test('legacy filesystem authority rejects before capture-state bootstrap', async (t) => {
  const root = await fixture(t, 'legacy-state');
  const evidence = join(root, '.native-build', 'b3', 'evidence');
  await mkdir(join(evidence, 'ios-issued-command-ledger'), {
    recursive: true,
    mode: 0o700,
  });
  await chmod(evidence, 0o700);

  const opened = await probeInChild(root, 'shape');

  assert.equal(opened.ok, false);
  assert.match(opened.error.message, /legacy-state/i);
  await assert.rejects(lstat(databasePath(root)), { code: 'ENOENT' });
});

test('every reservation rereads build authority and rejects a stale open-session command',
  async (t) => {
    const root = await fixture(t, 'fresh-build-authority');
    const staleCommand = initialCommand();
    const reserver = spawnStaleBuildReserver(root, staleCommand);
    await reserver.ready;
    const path = databasePath(root);
    const beforeSha256 = await fileSha256(path);
    await writeFile(join(
      root, '.native-build', 'b3', 'distribution', 'build-authority.json',
    ), JSON.stringify({
      schemaVersion: 1,
      testedApplicationCommit: '3'.repeat(40),
      applicationFingerprint: '4'.repeat(64),
      versionName: '0.3.0-b3',
      iosBuildNumber: '20',
      androidVersionCode: 20,
    }), { mode: 0o600 });

    reserver.release();
    const result = await reserver.result;

    assert.equal(result.ok, false);
    assert.match(result.error.message, /build|metadata|authority|differs/i);
    assert.equal(await fileSha256(path), beforeSha256);
  });
