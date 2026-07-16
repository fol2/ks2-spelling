import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

import { canonicaliseB3ProofValue } from '../src/app/b3-live-proof-protocol.js';

const execFileAsync = promisify(execFile);

async function fixture(t, label) {
  const root = await mkdtemp(join(tmpdir(), `b3-capture-store-${label}-`));
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
    testedApplicationCommit: '1'.repeat(40),
    applicationFingerprint: '2'.repeat(64),
    versionName: '0.3.0-b3',
    iosBuildNumber: '19',
    androidVersionCode: 19,
  }), { mode: 0o600 });
  return root;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function initialCommand(
  captureId = '018f1d7b-97e8-4a52-8cf2-783e5089c001',
  platform = 'ios',
) {
  const unsigned = {
    schemaVersion: 1,
    captureId,
    platform: platform === 'ios' ? 'ios-physical' : 'android-play-physical',
    testedApplicationCommit: '1'.repeat(40),
    applicationFingerprint: '2'.repeat(64),
    expectedScenarioIndex: 0,
    expectedSequence: 1,
    previousObservationSha256: '0'.repeat(64),
    installationMode: 'existing',
    actionCode: 'ARM_CAPTURE',
  };
  return {
    ...unsigned,
    challengeSha256: sha256(Buffer.from(
      `ks2-spelling:b3-host-command-challenge:v1\0${canonicaliseB3ProofValue(unsigned)}`,
      'utf8',
    )),
  };
}

async function probe(root, mode, command = null) {
  const helper = new URL('./helpers/b3-capture-store-probe-child.mjs', import.meta.url);
  const { stdout } = await execFileAsync(process.execPath, [
    '--experimental-test-module-mocks', helper.pathname, mode,
    ...(command === null ? [] : [
      Buffer.from(JSON.stringify(command), 'utf8').toString('base64url'),
    ]),
  ], { cwd: root });
  return JSON.parse(stdout);
}

async function alternatingPlatformProbe(root) {
  const helper = new URL(
    './helpers/b3-capture-store-platform-getter-child.mjs',
    import.meta.url,
  );
  const { stdout } = await execFileAsync(process.execPath, [
    '--experimental-test-module-mocks', helper.pathname,
  ], { cwd: root });
  return JSON.parse(stdout);
}

async function reserveInChild(root, command) {
  const helper = new URL('./helpers/b3-capture-state-reserve-child.mjs', import.meta.url);
  const { stdout } = await execFileAsync(process.execPath, [
    '--experimental-test-module-mocks',
    helper.pathname,
    'ios',
    Buffer.from(JSON.stringify(command), 'utf8').toString('base64url'),
  ], { cwd: root });
  return JSON.parse(stdout);
}

async function decideInChild(root, actions) {
  const helper = new URL('./helpers/b3-capture-state-decision-child.mjs', import.meta.url);
  const { stdout } = await execFileAsync(process.execPath, [
    '--experimental-test-module-mocks',
    helper.pathname,
    'ios',
    Buffer.from(JSON.stringify(actions), 'utf8').toString('base64url'),
  ], { cwd: root });
  return JSON.parse(stdout);
}

async function failCheckedSqlInChild(root, command, targetIndex) {
  const helper = new URL(
    './helpers/b3-capture-store-sql-check-child.mjs',
    import.meta.url,
  );
  const { stdout } = await execFileAsync(process.execPath, [
    '--experimental-test-module-mocks',
    helper.pathname,
    String(targetIndex),
    Buffer.from(JSON.stringify(command), 'utf8').toString('base64url'),
  ], { cwd: root });
  return JSON.parse(stdout);
}

function spawnBarrierStarter(root, command) {
  const helper = new URL('./helpers/b3-capture-store-race-child.mjs', import.meta.url);
  const child = fork(helper.pathname, [
    Buffer.from(JSON.stringify(command), 'utf8').toString('base64url'),
  ], {
    cwd: root,
    execArgv: ['--experimental-test-module-mocks'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  let readyResolve;
  let readyReject;
  let resultResolve;
  let resultReject;
  let settled = false;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const result = new Promise((resolve, reject) => {
    resultResolve = resolve;
    resultReject = reject;
  });
  child.on('message', (message) => {
    if (message?.type === 'ready') readyResolve();
    if (message?.type === 'result') {
      settled = true;
      resultResolve(message);
    }
  });
  child.on('error', (error) => {
    readyReject(error);
    resultReject(error);
  });
  child.on('exit', (code, signal) => {
    if (settled) return;
    const error = new Error(
      `B3 capture-store race child exited ${code ?? signal}: ${stderr}`,
    );
    readyReject(error);
    resultReject(error);
  });
  return Object.freeze({
    ready,
    result,
    go: () => child.send({ type: 'go' }),
  });
}

function spawnFilesystemDeathStarter(root, command, targetEvent) {
  const helper = new URL(
    './helpers/b3-capture-store-fs-death-child.mjs',
    import.meta.url,
  );
  const child = fork(helper.pathname, [
    String(targetEvent),
    Buffer.from(JSON.stringify(command), 'utf8').toString('base64url'),
  ], {
    cwd: root,
    execArgv: ['--experimental-test-module-mocks'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  let readyResolve;
  let failed = false;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const paused = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      failed = true;
      reject(new Error(`B3 filesystem death child did not pause: ${stderr}`));
    }, 5_000);
    child.on('message', (message) => {
      if (message?.type === 'paused') {
        clearTimeout(timeout);
        resolve(message);
      } else if (message?.type?.startsWith('unexpected-')) {
        clearTimeout(timeout);
        failed = true;
        reject(new Error(JSON.stringify(message)));
      }
    });
  });
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (!failed && signal !== 'SIGKILL') {
        reject(new Error(
          `B3 filesystem death child exited ${code ?? signal}: ${stderr}`,
        ));
        return;
      }
      resolve({ code, signal });
    });
  });
  child.on('message', (message) => {
    if (message?.type === 'ready') readyResolve();
  });
  return Object.freeze({
    ready,
    paused,
    exited,
    go: () => child.send({ type: 'go' }),
    kill: () => child.kill('SIGKILL'),
  });
}

function spawnSqlDeathStarter(root, command, targetEvent) {
  const helper = new URL(
    './helpers/b3-capture-store-sql-death-child.mjs',
    import.meta.url,
  );
  const child = fork(helper.pathname, [
    String(targetEvent),
    Buffer.from(JSON.stringify(command), 'utf8').toString('base64url'),
  ], {
    cwd: root,
    execArgv: ['--experimental-test-module-mocks'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  let readyResolve;
  let pausedResolve;
  let pausedReject;
  let failed = false;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const paused = new Promise((resolve, reject) => {
    pausedResolve = resolve;
    pausedReject = reject;
  });
  const timeout = setTimeout(() => {
    failed = true;
    pausedReject(new Error(`B3 SQL death child did not pause: ${stderr}`));
  }, 5_000);
  child.on('message', (message) => {
    if (message?.type === 'ready') readyResolve();
    if (message?.type === 'paused') {
      clearTimeout(timeout);
      pausedResolve(message);
    } else if (message?.type?.startsWith('unexpected-')) {
      clearTimeout(timeout);
      failed = true;
      pausedReject(new Error(JSON.stringify(message)));
    }
  });
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      if (!failed && signal !== 'SIGKILL') {
        reject(new Error(`B3 SQL death child exited ${code ?? signal}: ${stderr}`));
        return;
      }
      resolve({ code, signal });
    });
  });
  return Object.freeze({
    ready,
    paused,
    exited,
    go: () => child.send({ type: 'go' }),
    kill: () => child.kill('SIGKILL'),
  });
}

test('C2 facade freezes its closed handle and rejects authority before getters', async (t) => {
  const shapeRoot = await fixture(t, 'shape');
  assert.deepEqual(await probe(shapeRoot, 'shape'), {
    ok: true,
    result: ['close', 'startCapture'],
    getterCalls: 0,
  });

  const invalidOpenRoot = await fixture(t, 'invalid-open');
  assert.deepEqual(await probe(invalidOpenRoot, 'invalid-open'), {
    ok: false,
    error: {
      code: 'b3_capture_state_invalid',
      message: 'B3 capture-store open authority is invalid',
    },
    getterCalls: 0,
  });

  const invalidStartRoot = await fixture(t, 'invalid-start');
  assert.deepEqual(await probe(invalidStartRoot, 'invalid-start'), {
    ok: false,
    error: {
      code: 'b3_capture_state_invalid',
      message: 'B3 capture-store start authority is invalid',
    },
    getterCalls: 0,
  });

  const closedRoot = await fixture(t, 'closed');
  assert.deepEqual(await probe(closedRoot, 'closed'), {
    ok: false,
    error: {
      code: 'b3_capture_state_invalid',
      message: 'B3 capture-store is already closed',
    },
    getterCalls: 0,
  });
});

test('capture-store open snapshots an alternating platform getter exactly once',
  async (t) => {
    const root = await fixture(t, 'alternating-platform');

    const result = await alternatingPlatformProbe(root);

    assert.deepEqual(result, {
      ok: true,
      getterCalls: 1,
      synchronousGetterCalls: 1,
      keys: ['close', 'startCapture'],
    });
    const evidence = join(root, '.native-build', 'b3', 'evidence');
    assert.equal((await lstat(join(evidence, 'ios-capture-state'))).isDirectory(), true);
    await assert.rejects(lstat(join(evidence, 'android-capture-state')), {
      code: 'ENOENT',
    });
  });

test('facade snapshots every command property synchronously before its first await',
  async (t) => {
    const root = await fixture(t, 'synchronous-snapshot');
    const command = initialCommand();

    const result = await probe(root, 'snapshot-before-await', command);

    assert.equal(result.ok, true);
    assert.equal(result.result.kind, 'started');
    assert.equal(result.result.capture.captureId, command.captureId);
    assert.equal(result.synchronousGetterCalls, Object.keys(command).length);
    assert.equal(result.getterCalls, Object.keys(command).length);
  });

test('facade freezes its handle and complete public start result', async (t) => {
  const root = await fixture(t, 'frozen-result');
  const result = await probe(root, 'frozen-start', initialCommand());

  assert.equal(result.ok, true);
  assert.deepEqual(result.freezeProof, {
    handle: true,
    result: true,
    capture: true,
    firstCommand: true,
  });
});

test('an absent initial namespace starts one ready capture and exact empty bundle',
  async (t) => {
    const root = await fixture(t, 'start-absent');
    const command = initialCommand();

    const started = await probe(root, 'start', command);

    assert.deepEqual(started, {
      ok: true,
      result: {
        kind: 'started',
        capture: {
          schemaVersion: 1,
          startIntentSha256:
            '60330a9948db44bae18d3db4324ce708bbe57018c73bf181043e4539a3b3a521',
          intentKind: 'initial',
          recoveredCommandSha256: null,
          terminalClaimSha256: null,
          captureId: command.captureId,
          firstCommandSha256:
            '1f0de6d66179333a8e7adca7cb537342b19278e61aaff41a10a154da04652880',
          firstCommand: command,
          firstPreparedRecordSha256:
            '9d3bfbae6203275b1c7ef777b001f8254ebab77b334843ad8ac2a5c28898beaa',
          intentState: 'ready',
          rowVersion: 2,
        },
      },
      getterCalls: 0,
    });
    const working = join(
      root, '.native-build', 'b3', 'evidence', 'ios-capture-bundles',
      `${command.captureId}.working`,
    );
    assert.deepEqual((await readdir(working)).sort(), [
      'checkpoint', 'derived', 'observations',
    ]);
    for (const path of [
      join(root, '.native-build', 'b3', 'evidence', 'ios-capture-bundles'),
      working,
      join(working, 'observations'),
      join(working, 'checkpoint'),
      join(working, 'derived'),
    ]) {
      const metadata = await lstat(path);
      assert.equal(metadata.isDirectory(), true);
      assert.equal(metadata.isSymbolicLink(), false);
      assert.equal(metadata.mode & 0o7777, 0o700);
    }
    const database = new DatabaseSync(join(
      root, '.native-build', 'b3', 'evidence', 'ios-capture-state', 'recovery.sqlite',
    ), { readOnly: true });
    t.after(() => database.close());
    assert.deepEqual({ ...database.prepare(`
      SELECT intent_state, row_version FROM b3_capture_start_intents
    `).get() }, { intent_state: 'ready', row_version: 2 });
    assert.deepEqual({ ...database.prepare(`
      SELECT next_allocation_sequence, active_command_sha256,
        reserved_start_command_sha256, row_version FROM b3_authority_state
    `).get() }, {
      next_allocation_sequence: 2,
      active_command_sha256:
        '1f0de6d66179333a8e7adca7cb537342b19278e61aaff41a10a154da04652880',
      reserved_start_command_sha256: null,
      row_version: 3,
    });
  });

test('Android initial start and retry retain one exact offline bundle', async (t) => {
  const root = await fixture(t, 'android-start-retry');
  const command = initialCommand(
    '018f1d7b-97e8-4a52-8cf2-783e5089c002',
    'android',
  );

  const started = await probe(root, 'start-android', command);
  const retried = await probe(root, 'start-android', command);

  assert.equal(started.ok, true);
  assert.equal(started.result.kind, 'started');
  assert.equal(retried.ok, true);
  assert.equal(retried.result.kind, 'already-started');
  assert.equal(retried.result.capture.captureId, command.captureId);
  const working = join(
    root, '.native-build', 'b3', 'evidence', 'android-capture-bundles',
    `${command.captureId}.working`,
  );
  assert.deepEqual((await readdir(working)).sort(), [
    'checkpoint', 'derived', 'observations',
  ]);
});

test('hostile initial bundle rejects before the reservation can change database bytes',
  async (t) => {
    const root = await fixture(t, 'hostile-before-reservation');
    await probe(root, 'shape');
    const evidence = join(root, '.native-build', 'b3', 'evidence');
    const bundles = join(evidence, 'ios-capture-bundles');
    const databasePath = join(
      evidence, 'ios-capture-state', 'recovery.sqlite',
    );
    const before = await readFile(databasePath);

    const result = await probe(root, 'hostile-before-start', initialCommand());

    assert.deepEqual(result, {
      ok: false,
      error: {
        code: 'b3_capture_bundle_invalid',
        message: 'B3 capture bundle root inventory is not structurally closed',
      },
      getterCalls: 0,
    });
    assert.deepEqual(await readFile(databasePath), before);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    t.after(() => database.close());
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM b3_capture_start_intents
    `).get().count, 0);
    assert.equal(await readFile(join(bundles, 'unexpected'), 'utf8'), 'hostile');
  });

test('an impossible committed partial SQL state rejects without creating a bundle',
  async (t) => {
    const root = await fixture(t, 'impossible-partial-sql');
    const command = initialCommand();
    await reserveInChild(root, command);

    const result = await probe(root, 'partial-capture-before-start', command);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'b3_capture_state_invalid');
    assert.match(result.error.message, /pending|capture|authority|invalid/iu);
    await assert.rejects(lstat(join(
      root, '.native-build', 'b3', 'evidence', 'ios-capture-bundles',
    )), { code: 'ENOENT' });
    const database = new DatabaseSync(join(
      root, '.native-build', 'b3', 'evidence', 'ios-capture-state',
      'recovery.sqlite',
    ), { readOnly: true });
    try {
      assert.equal(database.prepare(`
        SELECT COUNT(*) AS count FROM b3_captures
      `).get().count, 1);
      assert.equal(database.prepare(`
        SELECT COUNT(*) AS count FROM b3_commands
      `).get().count, 0);
      assert.equal(database.prepare(`
        SELECT intent_state FROM b3_capture_start_intents
      `).get().intent_state, 'pending');
    } finally {
      database.close();
    }
  });

test('pending initial start converges from every recognised empty bundle subset',
  async (t) => {
    const children = ['observations', 'checkpoint', 'derived'];
    const cases = [
      { label: 'absent-root', kind: 'absent' },
      { label: 'empty-root', kind: 'empty' },
      ...Array.from({ length: 8 }, (_, mask) => ({
        label: `working-subset-${mask}`,
        kind: 'working-subset',
        mask,
      })),
    ];

    for (const current of cases) {
      const root = await fixture(t, current.label);
      const command = initialCommand();
      await reserveInChild(root, command);
      const bundles = join(
        root, '.native-build', 'b3', 'evidence', 'ios-capture-bundles',
      );
      const working = join(bundles, `${command.captureId}.working`);
      if (current.kind !== 'absent') await mkdir(bundles, { mode: 0o700 });
      if (current.kind === 'working-subset') {
        await mkdir(working, { mode: 0o700 });
        for (const [index, child] of children.entries()) {
          if ((current.mask & (1 << index)) !== 0) {
            await mkdir(join(working, child), { mode: 0o700 });
          }
        }
      }

      const reconciled = await probe(root, 'start', command);

      assert.equal(reconciled.ok, true, current.label);
      assert.equal(reconciled.result.kind, 'already-started', current.label);
      assert.equal(reconciled.result.capture.captureId, command.captureId, current.label);
      assert.deepEqual((await readdir(working)).sort(), [
        'checkpoint', 'derived', 'observations',
      ], current.label);
      const database = new DatabaseSync(join(
        root, '.native-build', 'b3', 'evidence', 'ios-capture-state',
        'recovery.sqlite',
      ), { readOnly: true });
      try {
        assert.deepEqual({ ...database.prepare(`
          SELECT intent_state, capture_id FROM b3_capture_start_intents
        `).get() }, {
          intent_state: 'ready',
          capture_id: command.captureId,
        }, current.label);
        assert.equal(database.prepare(`
          SELECT COUNT(*) AS count FROM b3_captures
        `).get().count, 1, current.label);
        assert.equal(database.prepare(`
          SELECT COUNT(*) AS count FROM b3_commands
        `).get().count, 1, current.label);
      } finally {
        database.close();
      }
    }
  });

test('a different pending loser completes only the retained winner and reports conflict',
  async (t) => {
    const root = await fixture(t, 'different-loser-reconciles');
    const winner = initialCommand();
    const loser = initialCommand('018f1d7b-97e8-4a52-8cf2-783e5089c099');
    await reserveInChild(root, winner);

    const result = await probe(root, 'start', loser);

    assert.equal(result.ok, true);
    assert.equal(result.result.kind, 'start-conflict');
    assert.equal(result.result.capture.captureId, winner.captureId);
    assert.equal(result.result.capture.firstCommand.captureId, winner.captureId);
    const bundles = join(
      root, '.native-build', 'b3', 'evidence', 'ios-capture-bundles',
    );
    assert.deepEqual(await readdir(bundles), [`${winner.captureId}.working`]);
    const database = new DatabaseSync(join(
      root, '.native-build', 'b3', 'evidence', 'ios-capture-state',
      'recovery.sqlite',
    ), { readOnly: true });
    try {
      assert.equal(database.prepare(`
        SELECT COUNT(*) AS count FROM b3_capture_start_intents
      `).get().count, 1);
      assert.equal(database.prepare(`
        SELECT COUNT(*) AS count FROM b3_commands
        WHERE capture_id = ?
      `).get(loser.captureId).count, 0);
    } finally {
      database.close();
    }
  });

test('ready initial identity retries after transition and consumption without allocation',
  async (t) => {
    for (const current of [{
      label: 'transitioned',
      actions: [{ op: 'transition', sourceName: 'A', nextState: 'launching' }],
    }, {
      label: 'consumed',
      actions: [{ op: 'consume', sourceName: 'A' }],
    }]) {
      const root = await fixture(t, `ready-retry-${current.label}`);
      const command = initialCommand();
      assert.equal((await probe(root, 'start', command)).result.kind, 'started');
      const changed = await decideInChild(root, current.actions);
      assert.equal(changed.ok, true, current.label);

      const retried = await probe(root, 'start', command);

      assert.equal(retried.ok, true, current.label);
      assert.equal(retried.result.kind, 'already-started', current.label);
      assert.equal(retried.result.capture.captureId, command.captureId, current.label);
      const database = new DatabaseSync(join(
        root, '.native-build', 'b3', 'evidence', 'ios-capture-state',
        'recovery.sqlite',
      ), { readOnly: true });
      try {
        assert.equal(database.prepare(`
          SELECT COUNT(*) AS count FROM b3_commands
        `).get().count, 1, current.label);
        assert.equal(database.prepare(`
          SELECT next_allocation_sequence FROM b3_authority_state
        `).get().next_allocation_sequence, 2, current.label);
      } finally {
        database.close();
      }
    }
  });

test('each initial reconciliation SQL write is checked before the next write',
  async (t) => {
    const statementKinds = ['capture', 'command', 'singleton', 'intent'];
    for (const [targetIndex, target] of statementKinds.entries()) {
      const root = await fixture(t, `checked-sql-${target}`);
      const command = initialCommand();
      await reserveInChild(root, command);

      const result = await failCheckedSqlInChild(root, command, targetIndex);

      assert.equal(result.ok, false, target);
      assert.deepEqual(result.error, {
        code: 'b3_capture_state_invalid',
        message: 'B3 capture-state initial reconciliation lost authority',
      }, target);
      assert.deepEqual(result.trace, statementKinds.slice(0, targetIndex + 1), target);
    }
  });

test('real same and different starters converge on one retained capture', async (t) => {
  for (const current of [{
    label: 'same',
    left: initialCommand(),
    right: initialCommand(),
    expectedKinds: ['already-started', 'started'],
  }, {
    label: 'different',
    left: initialCommand(),
    right: initialCommand('018f1d7b-97e8-4a52-8cf2-783e5089c099'),
    expectedKinds: ['start-conflict', 'started'],
  }]) {
    const root = await fixture(t, `race-${current.label}`);
    await probe(root, 'shape');
    const left = spawnBarrierStarter(root, current.left);
    const right = spawnBarrierStarter(root, current.right);
    await Promise.all([left.ready, right.ready]);
    left.go();
    right.go();

    const outcomes = await Promise.all([left.result, right.result]);

    assert.deepEqual(outcomes.map((outcome) => outcome.error), [null, null], current.label);
    assert.deepEqual(outcomes.map((outcome) => outcome.result.kind).sort(),
      current.expectedKinds, current.label);
    const captureIds = new Set(outcomes.map((outcome) => outcome.result.capture.captureId));
    assert.equal(captureIds.size, 1, current.label);
    const [captureId] = captureIds;
    const bundles = join(
      root, '.native-build', 'b3', 'evidence', 'ios-capture-bundles',
    );
    assert.deepEqual(await readdir(bundles), [`${captureId}.working`], current.label);
    const database = new DatabaseSync(join(
      root, '.native-build', 'b3', 'evidence', 'ios-capture-state',
      'recovery.sqlite',
    ), { readOnly: true });
    try {
      assert.equal(database.prepare(`
        SELECT COUNT(*) AS count FROM b3_capture_start_intents
      `).get().count, 1, current.label);
      assert.equal(database.prepare(`
        SELECT COUNT(*) AS count FROM b3_captures
      `).get().count, 1, current.label);
      assert.equal(database.prepare(`
        SELECT COUNT(*) AS count FROM b3_commands
      `).get().count, 1, current.label);
    } finally {
      database.close();
    }
  }
});

test('every filesystem durability boundary retries the retained pending start',
  { timeout: 60_000 }, async (t) => {
    const operations = [
      'mkdir-root',
      'fsync-new-root',
      'fsync-evidence',
      'mkdir-working',
      'fsync-new-working',
      'fsync-root-parent',
      'mkdir-observations',
      'fsync-new-observations',
      'fsync-working-after-observations',
      'mkdir-checkpoint',
      'fsync-new-checkpoint',
      'fsync-working-after-checkpoint',
      'mkdir-derived',
      'fsync-new-derived',
      'fsync-working-after-derived',
      'fsync-complete-working',
      'fsync-complete-root',
    ];
    const cases = operations.flatMap((operation) => [
      `before-${operation}`,
      `after-${operation}`,
    ]);
    cases.push('after-empty-snapshot');
    const captureId = initialCommand().captureId;
    const bundlesPath = '.native-build/b3/evidence/ios-capture-bundles';
    const workingPath = `${bundlesPath}/${captureId}.working`;
    const expectedTrace = [
      { operationIndex: 0, kind: 'mkdir', path: bundlesPath },
      { operationIndex: 1, kind: 'fsync', path: bundlesPath },
      { operationIndex: 2, kind: 'fsync', path: '.native-build/b3/evidence' },
      { operationIndex: 3, kind: 'mkdir', path: workingPath },
      { operationIndex: 4, kind: 'fsync', path: workingPath },
      { operationIndex: 5, kind: 'fsync', path: bundlesPath },
      { operationIndex: 6, kind: 'mkdir', path: `${workingPath}/observations` },
      { operationIndex: 7, kind: 'fsync', path: `${workingPath}/observations` },
      { operationIndex: 8, kind: 'fsync', path: workingPath },
      { operationIndex: 9, kind: 'mkdir', path: `${workingPath}/checkpoint` },
      { operationIndex: 10, kind: 'fsync', path: `${workingPath}/checkpoint` },
      { operationIndex: 11, kind: 'fsync', path: workingPath },
      { operationIndex: 12, kind: 'mkdir', path: `${workingPath}/derived` },
      { operationIndex: 13, kind: 'fsync', path: `${workingPath}/derived` },
      { operationIndex: 14, kind: 'fsync', path: workingPath },
      { operationIndex: 15, kind: 'fsync', path: workingPath },
      { operationIndex: 16, kind: 'fsync', path: bundlesPath },
    ];

    for (const [targetEvent, label] of cases.entries()) {
      const root = await fixture(t, `fs-death-${targetEvent}`);
      const command = initialCommand();
      const reservation = await reserveInChild(root, command);
      const starter = spawnFilesystemDeathStarter(root, command, targetEvent);
      await starter.ready;
      starter.go();
      const paused = await starter.paused;
      starter.kill();
      assert.equal((await starter.exited).signal, 'SIGKILL', label);
      assert.equal(paused.eventIndex, targetEvent, label);
      if (targetEvent < 34) {
        const operationIndex = Math.floor(targetEvent / 2);
        const expected = expectedTrace[operationIndex];
        const phase = targetEvent % 2 === 0 ? 'before' : 'after';
        assert.equal(paused.operationIndex, operationIndex, label);
        assert.equal(paused.phase, phase, label);
        assert.equal(paused.kind, expected.kind, label);
        assert.equal(paused.path, expected.path, label);
        assert.deepEqual(
          paused.trace,
          expectedTrace.slice(0, operationIndex + (phase === 'after' ? 1 : 0)),
          label,
        );
      } else {
        assert.equal(paused.operationIndex, 17, label);
        assert.equal(paused.phase, 'after', label);
        assert.equal(paused.kind, 'snapshot', label);
        assert.equal(paused.path, workingPath, label);
        assert.deepEqual(paused.trace, expectedTrace, label);
      }

      const retried = await probe(root, 'start', command);

      assert.equal(retried.ok, true, label);
      assert.equal(retried.result.kind, 'already-started', label);
      assert.equal(retried.result.capture.captureId, reservation.captureId, label);
      assert.equal(
        retried.result.capture.firstCommandSha256,
        reservation.firstCommandSha256,
        label,
      );
      const working = join(
        root, '.native-build', 'b3', 'evidence', 'ios-capture-bundles',
        `${reservation.captureId}.working`,
      );
      assert.deepEqual((await readdir(working)).sort(), [
        'checkpoint', 'derived', 'observations',
      ], label);
    }
  });

test('every SQL reconciliation boundary retries one retained start',
  { timeout: 60_000 }, async (t) => {
    const boundaries = [
      'after-reservation-commit',
      'before-reconciliation-begin',
      'before-capture-run',
      'after-capture-run',
      'after-capture-changes-check',
      'before-command-run',
      'after-command-run',
      'after-command-changes-check',
      'before-singleton-run',
      'after-singleton-run',
      'after-singleton-changes-check',
      'before-intent-run',
      'after-intent-run',
      'after-intent-changes-check',
      'before-final-validation',
      'before-final-commit',
      'after-final-commit-before-return',
    ];

    for (const [targetEvent, label] of boundaries.entries()) {
      const root = await fixture(t, `sql-death-${targetEvent}`);
      const command = initialCommand();
      await probe(root, 'shape');
      const starter = spawnSqlDeathStarter(root, command, targetEvent);
      await starter.ready;
      starter.go();
      const paused = await starter.paused;
      assert.equal(paused.eventIndex, targetEvent, label);
      assert.equal(paused.boundary, label, label);
      starter.kill();
      assert.equal((await starter.exited).signal, 'SIGKILL', label);

      const retried = await probe(root, 'start', command);

      assert.equal(retried.ok, true, label);
      assert.equal(retried.result.kind, 'already-started', label);
      assert.equal(retried.result.capture.captureId, command.captureId, label);
      const database = new DatabaseSync(join(
        root, '.native-build', 'b3', 'evidence', 'ios-capture-state',
        'recovery.sqlite',
      ), { readOnly: true });
      try {
        assert.equal(database.prepare(`
          SELECT COUNT(*) AS count FROM b3_capture_start_intents
        `).get().count, 1, label);
        assert.equal(database.prepare(`
          SELECT COUNT(*) AS count FROM b3_captures
        `).get().count, 1, label);
        assert.equal(database.prepare(`
          SELECT COUNT(*) AS count FROM b3_commands
        `).get().count, 1, label);
      } finally {
        database.close();
      }
    }
  });
