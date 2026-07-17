import assert from 'node:assert/strict';
import { execFile, fork, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

import { canonicaliseB3ProofValue } from '../src/app/b3-live-proof-protocol.js';
import { createB3GenericConsumptionClaimAuthority } from
  '../scripts/lib/b3-issued-command-authority.mjs';

const execFileAsync = promisify(execFile);
const COMMIT = '1'.repeat(40);
const FINGERPRINT = '2'.repeat(64);
const REPLACEMENT_BUILD_AUTHORITY = Object.freeze({
  schemaVersion: 1,
  testedApplicationCommit: '3'.repeat(40),
  applicationFingerprint: '4'.repeat(64),
  versionName: '0.3.0-b3',
  iosBuildNumber: '20',
  androidVersionCode: 20,
});
const CAPTURE_ID = '018f1d7b-97e8-4a52-8cf2-783e5089c001';
const FIRST_COMMAND_SHA256 = '1f0de6d66179333a8e7adca7cb537342b19278e61aaff41a10a154da04652880';
const FIRST_PREPARED_RECORD_SHA256 =
  '9d3bfbae6203275b1c7ef777b001f8254ebab77b334843ad8ac2a5c28898beaa';
const START_INTENT_SHA256 =
  '60330a9948db44bae18d3db4324ce708bbe57018c73bf181043e4539a3b3a521';
const FIRST_COMMAND_JSON = Buffer.from(
  '{"actionCode":"ARM_CAPTURE","applicationFingerprint":"2222222222222222222222222222222222222222222222222222222222222222","captureId":"018f1d7b-97e8-4a52-8cf2-783e5089c001","challengeSha256":"f144a676e8bf11d8a36b75b4ddb08c62d10b8c69be56e29270f556b9ee42261c","expectedScenarioIndex":0,"expectedSequence":1,"installationMode":"existing","platform":"ios-physical","previousObservationSha256":"0000000000000000000000000000000000000000000000000000000000000000","schemaVersion":1,"testedApplicationCommit":"1111111111111111111111111111111111111111"}',
  'utf8',
);
const FIRST_PREPARED_RECORD_JSON = Buffer.from(
  '{"command":{"actionCode":"ARM_CAPTURE","applicationFingerprint":"2222222222222222222222222222222222222222222222222222222222222222","captureId":"018f1d7b-97e8-4a52-8cf2-783e5089c001","challengeSha256":"f144a676e8bf11d8a36b75b4ddb08c62d10b8c69be56e29270f556b9ee42261c","expectedScenarioIndex":0,"expectedSequence":1,"installationMode":"existing","platform":"ios-physical","previousObservationSha256":"0000000000000000000000000000000000000000000000000000000000000000","schemaVersion":1,"testedApplicationCommit":"1111111111111111111111111111111111111111"},"commandSha256":"1f0de6d66179333a8e7adca7cb537342b19278e61aaff41a10a154da04652880","platform":"ios","recordSha256":"9d3bfbae6203275b1c7ef777b001f8254ebab77b334843ad8ac2a5c28898beaa","schemaVersion":3,"state":"prepared"}',
  'utf8',
);
const LAUNCHED_RECORD_JSON = Buffer.from(
  '{"command":{"actionCode":"ARM_CAPTURE","applicationFingerprint":"2222222222222222222222222222222222222222222222222222222222222222","captureId":"018f1d7b-97e8-4a52-8cf2-783e5089c001","challengeSha256":"f144a676e8bf11d8a36b75b4ddb08c62d10b8c69be56e29270f556b9ee42261c","expectedScenarioIndex":0,"expectedSequence":1,"installationMode":"existing","platform":"ios-physical","previousObservationSha256":"0000000000000000000000000000000000000000000000000000000000000000","schemaVersion":1,"testedApplicationCommit":"1111111111111111111111111111111111111111"},"commandSha256":"1f0de6d66179333a8e7adca7cb537342b19278e61aaff41a10a154da04652880","platform":"ios","recordSha256":"f6006d640ff0469b80b500f9fb1f5f9c996b69fb36e6db959ff6485d520bb2c4","schemaVersion":3,"state":"launched"}',
  'utf8',
);
const LAUNCHING_TO_LAUNCHED_CLAIM_JSON = Buffer.from(
  '{"claimSha256":"0acb91cd0eda8be3051bda358bf13afa1966fb6ed5061d22a8ba04cfa13c833a","commandSha256":"1f0de6d66179333a8e7adca7cb537342b19278e61aaff41a10a154da04652880","expectedState":"launching","nextRecordSha256":"f6006d640ff0469b80b500f9fb1f5f9c996b69fb36e6db959ff6485d520bb2c4","nextState":"launched","platform":"ios","schemaVersion":1}',
  'utf8',
);
const ORDINARY_EDGES = Object.freeze([
  ['prepared', 'launching'],
  ['prepared', 'stop-intent'],
  ['stop-intent', 'stop-executing'],
  ['stop-executing', 'host-stopped'],
  ['host-stopped', 'launching'],
  ['launching', 'launched'],
  ['launching', 'reinstall-authorised'],
  ['launching', 'restart-required'],
  ['reinstall-authorised', 'reinstall-launching'],
  ['reinstall-launching', 'launched'],
  ['reinstall-launching', 'restart-required'],
  ['restart-required', 'launched'],
]);
const ISSUED_COMMAND_STATES = Object.freeze([
  'prepared',
  'stop-intent',
  'stop-executing',
  'host-stopped',
  'launching',
  'reinstall-authorised',
  'reinstall-launching',
  'launched',
  'restart-required',
  'restart-executing',
  'restart-complete',
]);
const PATH_TO_STATE = Object.freeze({
  prepared: [],
  'stop-intent': [['prepared', 'stop-intent']],
  'stop-executing': [
    ['prepared', 'stop-intent'],
    ['stop-intent', 'stop-executing'],
  ],
  'host-stopped': [
    ['prepared', 'stop-intent'],
    ['stop-intent', 'stop-executing'],
    ['stop-executing', 'host-stopped'],
  ],
  launching: [['prepared', 'launching']],
  'reinstall-authorised': [
    ['prepared', 'launching'],
    ['launching', 'reinstall-authorised'],
  ],
  'reinstall-launching': [
    ['prepared', 'launching'],
    ['launching', 'reinstall-authorised'],
    ['reinstall-authorised', 'reinstall-launching'],
  ],
  'restart-required': [
    ['prepared', 'launching'],
    ['launching', 'restart-required'],
  ],
  launched: [
    ['prepared', 'launching'],
    ['launching', 'launched'],
  ],
});

function transitionAction([sourceState, nextState], extra = {}) {
  return { op: 'transition', sourceState, nextState, ...extra };
}

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

async function replaceBuildAuthority(root) {
  const distribution = join(root, '.native-build', 'b3', 'distribution');
  const authorityPath = join(distribution, 'build-authority.json');
  const temporaryPath = join(distribution, 'build-authority.next.json');
  await writeFile(
    temporaryPath,
    JSON.stringify(REPLACEMENT_BUILD_AUTHORITY),
    { mode: 0o600, flag: 'wx' },
  );
  const temporary = await open(temporaryPath, 'r');
  try {
    await temporary.sync();
  } finally {
    await temporary.close();
  }
  await rename(temporaryPath, authorityPath);
  const directory = await open(distribution, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  assert.deepEqual(
    JSON.parse(await readFile(authorityPath, 'utf8')),
    REPLACEMENT_BUILD_AUTHORITY,
  );
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

async function namespaceSnapshot(path) {
  const rows = [];
  async function visit(current, relativePath) {
    const metadata = await lstat(current);
    const row = {
      relativePath,
      mode: metadata.mode,
      nlink: metadata.nlink,
      size: metadata.size,
      type: metadata.isDirectory() ? 'directory' : 'file',
    };
    if (metadata.isFile()) row.sha256 = await fileSha256(current);
    rows.push(row);
    if (metadata.isDirectory()) {
      for (const name of (await readdir(current)).sort()) {
        await visit(join(current, name),
          relativePath === '.' ? name : `${relativePath}/${name}`);
      }
    }
  }
  await visit(path, '.');
  return rows;
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

function laterCommand({
  expectedScenarioIndex,
  expectedSequence,
  previousObservationSha256,
  captureId = CAPTURE_ID,
  platform = 'ios',
}) {
  const commandWithoutChallenge = {
    schemaVersion: 1,
    captureId,
    platform: platform === 'ios' ? 'ios-physical' : 'android-play-physical',
    testedApplicationCommit: COMMIT,
    applicationFingerprint: FINGERPRINT,
    expectedScenarioIndex,
    expectedSequence,
    previousObservationSha256,
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

async function seedReadyInitial(root) {
  const bootstrapped = await probeInChild(root, 'shape');
  assert.equal(bootstrapped.ok, true);
  const database = new DatabaseSync(databasePath(root));
  try {
    database.exec('BEGIN IMMEDIATE');
    database.prepare(`
      INSERT INTO b3_capture_start_intents (
        start_intent_sha256, intent_kind, recovered_command_sha256,
        terminal_claim_sha256, capture_id, first_command_sha256,
        first_command_json, first_prepared_record_json,
        first_prepared_record_sha256, intent_state, row_version
      ) VALUES (?, 'initial', NULL, NULL, ?, ?, ?, ?, ?, 'ready', 2)
    `).run(
      START_INTENT_SHA256,
      CAPTURE_ID,
      FIRST_COMMAND_SHA256,
      FIRST_COMMAND_JSON,
      FIRST_PREPARED_RECORD_JSON,
      FIRST_PREPARED_RECORD_SHA256,
    );
    database.prepare(`
      INSERT INTO b3_captures (
        capture_id, start_intent_sha256, capture_state, row_version
      ) VALUES (?, ?, 'working', 1)
    `).run(CAPTURE_ID, START_INTENT_SHA256);
    database.prepare(`
      INSERT INTO b3_commands (
        command_sha256, allocation_sequence, predecessor_command_sha256,
        command_json, prepared_record_json, prepared_record_sha256, capture_id,
        expected_observation_sequence, previous_observation_sha256
      ) VALUES (?, 1, NULL, ?, ?, ?, ?, 1, ?)
    `).run(
      FIRST_COMMAND_SHA256,
      FIRST_COMMAND_JSON,
      FIRST_PREPARED_RECORD_JSON,
      FIRST_PREPARED_RECORD_SHA256,
      CAPTURE_ID,
      '0'.repeat(64),
    );
    database.prepare(`
      UPDATE b3_authority_state
      SET next_allocation_sequence = 2, active_command_sha256 = ?,
        reserved_start_command_sha256 = NULL, row_version = 3
      WHERE singleton = 1
    `).run(FIRST_COMMAND_SHA256);
    database.exec('COMMIT');
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK');
    throw error;
  } finally {
    database.close();
  }
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

async function decideInChild(root, actions, platform = 'ios') {
  const helper = new URL(
    './helpers/b3-capture-state-decision-child.mjs',
    import.meta.url,
  );
  const { stdout } = await execFileAsync(process.execPath, [
    '--experimental-test-module-mocks',
    helper.pathname,
    platform,
    Buffer.from(JSON.stringify(actions), 'utf8').toString('base64url'),
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

function spawnBarrierReader(root) {
  const helper = new URL(
    './helpers/b3-capture-state-stale-read-child.mjs',
    import.meta.url,
  );
  const child = spawn(process.execPath, [
    '--experimental-test-module-mocks',
    helper.pathname,
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
        const error = new Error(`stale-read child failed (${code}, ${signal}): ${stderr}`);
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

function spawnBarrierMutator(t, root, input) {
  const helper = new URL(
    './helpers/b3-capture-state-race-child.mjs',
    import.meta.url,
  );
  const child = fork(helper.pathname, [
    Buffer.from(JSON.stringify(input), 'utf8').toString('base64url'),
  ], {
    cwd: root,
    execArgv: ['--experimental-test-module-mocks'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  let readyResolve;
  let readyReject;
  let resultResolve;
  let resultReject;
  let reportedResult = null;
  let readySettled = false;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const result = new Promise((resolve, reject) => {
    resultResolve = resolve;
    resultReject = reject;
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('message', (message) => {
    if (message?.type === 'ready' && !readySettled) {
      readySettled = true;
      readyResolve(message.preflight);
    } else if (message?.type === 'result' && reportedResult === null) {
      reportedResult = message;
    }
  });
  child.once('error', (error) => {
    if (!readySettled) {
      readySettled = true;
      readyReject(error);
    }
    resultReject(error);
  });
  child.once('exit', (code, signal) => {
    if (code !== 0 || reportedResult === null) {
      const error = new Error(
        `capture-state mutation child failed (${code}, ${signal}): ${stderr}`,
      );
      if (!readySettled) {
        readySettled = true;
        readyReject(error);
      }
      resultReject(error);
      return;
    }
    resultResolve(Object.freeze({
      operation: reportedResult.operation,
      result: reportedResult.result,
      error: reportedResult.error,
      synchronousGetterSnapshot: reportedResult.synchronousGetterSnapshot,
      getterCounts: reportedResult.getterCounts,
    }));
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  return Object.freeze({
    ready,
    release() { child.send({ type: 'go' }); },
    result,
    terminate() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  });
}

async function raceBarrierMutations(t, root, inputs) {
  if (inputs.some(({ kind }) => kind === 'consume')) {
    const published = await decideInChild(root, [{ op: 'publish', sourceName: 'A' }]);
    assert.equal(published.ok, true);
  }
  let tailObservationSha256 = null;
  if (inputs.some(({ kind }) => kind === 'allocate')) {
    const database = new DatabaseSync(databasePath(root), { readOnly: true });
    try {
      tailObservationSha256 = database.prepare(`
        SELECT observation_sha256 FROM b3_capture_steps
        ORDER BY observation_sequence DESC LIMIT 1
      `).get()?.observation_sha256 ?? null;
    } finally {
      database.close();
    }
  }
  const raceInputs = inputs.map((input) => {
    if (input.kind !== 'allocate' || !tailObservationSha256 ||
        input.command.expectedSequence !== 2) return input;
    return {
      ...input,
      command: laterCommand({
        expectedScenarioIndex: input.command.expectedScenarioIndex,
        expectedSequence: input.command.expectedSequence,
        previousObservationSha256: tailObservationSha256,
      }),
    };
  });
  const children = raceInputs.map((input) => spawnBarrierMutator(t, root, input));
  try {
    const preflights = await Promise.all(children.map((child) => child.ready));
    for (const child of children) child.release();
    const outcomes = await Promise.all(children.map((child) => child.result));
    return Object.freeze({ preflights, outcomes });
  } catch (error) {
    for (const child of children) child.terminate();
    await Promise.allSettled(children.map((child) => child.result));
    throw error;
  }
}

function readRaceDatabaseState(root) {
  const database = new DatabaseSync(databasePath(root), { readOnly: true });
  try {
    return Object.freeze({
      decisions: database.prepare(`
        SELECT command_sha256, source_state, winner_kind, next_state
        FROM b3_decisions ORDER BY command_sha256, source_state
      `).all().map((row) => ({ ...row })),
      commands: database.prepare(`
        SELECT command_sha256, allocation_sequence, predecessor_command_sha256
        FROM b3_commands ORDER BY allocation_sequence
      `).all().map((row) => ({ ...row })),
      authority: {
        ...database.prepare(`
          SELECT next_allocation_sequence, active_command_sha256, row_version
          FROM b3_authority_state
        `).get(),
      },
    });
  } finally {
    database.close();
  }
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

test('repository accepts one independently seeded canonical ready initial command', async (t) => {
  const root = await fixture(t, 'ready-initial');
  await seedReadyInitial(root);

  const reopened = await probeInChild(root, 'shape');

  assert.deepEqual(reopened, {
    ok: true,
    result: [
      'allocateNextCommand',
      'close',
      'consumeCommand',
      'finaliseRecoveryInvocation',
      'publishObservation',
      'readActiveCommand',
      'readCapture',
      'readRecoveryInvocationPin',
      'reconcileInitialCaptureStart',
      'reserveInitialCaptureStart',
      'transitionCommand',
    ],
    getterCalls: 0,
  });
});

test('production open ignores obsolete working-bundle bytes unchanged', async (t) => {
  const root = await fixture(t, 'obsolete-bundle-ignored');
  await probeInChild(root, 'shape');
  const obsolete = join(
    root, '.native-build', 'b3', 'evidence', 'ios-capture-bundles',
  );
  await mkdir(obsolete, { mode: 0o700 });
  await writeFile(join(obsolete, 'unexpected'), 'historical', { mode: 0o600 });
  const before = await namespaceSnapshot(root);

  assert.equal((await probeInChild(root, 'shape')).ok, true);
  assert.deepEqual(await namespaceSnapshot(root), before);
});

test('production open accepts empty, pending and ready state without bundles', async (t) => {
  const emptyRoot = await fixture(t, 'composite-valid-empty');
  assert.equal((await probeInChild(emptyRoot, 'shape')).ok, true);

  const pendingAbsentRoot = await fixture(t, 'composite-valid-pending-absent');
  await reserveInChild(pendingAbsentRoot, initialCommand());
  const pendingAbsentBefore = await namespaceSnapshot(pendingAbsentRoot);
  assert.equal((await probeInChild(pendingAbsentRoot, 'shape')).ok, true);
  assert.deepEqual(await namespaceSnapshot(pendingAbsentRoot), pendingAbsentBefore);

  const readyRoot = await fixture(t, 'composite-valid-ready');
  await seedReadyInitial(readyRoot);
  assert.equal((await probeInChild(readyRoot, 'shape')).ok, true);
});

test('ready initial validation rejects corrupt rows, pointers and orphan decisions unchanged',
  async (t) => {
    const scenarios = [
      {
        label: 'intent',
        mutate(database) {
          database.exec('UPDATE b3_capture_start_intents SET row_version = 3');
        },
      },
      {
        label: 'capture',
        mutate(database) {
          database.exec("UPDATE b3_captures SET capture_state = 'abandoned'");
        },
      },
      {
        label: 'command-bytes',
        mutate(database) {
          database.prepare('UPDATE b3_commands SET command_json = ?')
            .run(Buffer.from(JSON.stringify(initialCommand(), null, 2), 'utf8'));
        },
      },
      {
        label: 'prepared-hash',
        mutate(database) {
          database.prepare('UPDATE b3_commands SET prepared_record_sha256 = ?')
            .run('e'.repeat(64));
        },
      },
      {
        label: 'allocation-gap',
        mutate(database) {
          database.exec('UPDATE b3_commands SET allocation_sequence = 2');
        },
      },
      {
        label: 'first-predecessor',
        mutate(database) {
          database.prepare(`
            UPDATE b3_commands SET predecessor_command_sha256 = command_sha256
          `).run();
        },
      },
      {
        label: 'active-pointer',
        mutate(database) {
          database.exec('UPDATE b3_authority_state SET active_command_sha256 = NULL');
        },
      },
      {
        label: 'orphan-decision',
        mutate(database) {
          database.prepare(`
            INSERT INTO b3_decisions (
              command_sha256, source_state, source_record_sha256, winner_kind,
              next_state, next_record_json, next_record_sha256,
              claim_json, claim_sha256
            ) VALUES (?, 'launching', ?, 'ordinary', 'launched', ?, ?, ?, ?)
          `).run(
            FIRST_COMMAND_SHA256,
            '57686831aa8562d8e309645db655aa17be75d8d647504a1ad17296e456113e09',
            LAUNCHED_RECORD_JSON,
            'f6006d640ff0469b80b500f9fb1f5f9c996b69fb36e6db959ff6485d520bb2c4',
            LAUNCHING_TO_LAUNCHED_CLAIM_JSON,
            '0acb91cd0eda8be3051bda358bf13afa1966fb6ed5061d22a8ba04cfa13c833a',
          );
        },
      },
    ];

    for (const scenario of scenarios) {
      const root = await fixture(t, `ready-corrupt-${scenario.label}`);
      await seedReadyInitial(root);
      const path = databasePath(root);
      const database = new DatabaseSync(path);
      scenario.mutate(database);
      database.close();
      const corruptSha256 = await fileSha256(path);

      const reopened = await probeInChild(root, 'shape');

      assert.equal(reopened.ok, false, scenario.label);
      assert.match(
        reopened.error.message,
        /authority|cardinality|canonical|foreign-key|invalid|unsupported|unselected/i,
        scenario.label,
      );
      assert.equal(await fileSha256(path), corruptSha256, scenario.label);
    }
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
    result: [
      'allocateNextCommand',
      'close',
      'consumeCommand',
      'finaliseRecoveryInvocation',
      'publishObservation',
      'readActiveCommand',
      'readCapture',
      'readRecoveryInvocationPin',
      'reconcileInitialCaptureStart',
      'reserveInitialCaptureStart',
      'transitionCommand',
    ],
    getterCalls: 0,
  });

  const closed = await probeInChild(root, 'closed', [initialCommand()]);
  assert.equal(closed.ok, false);
  assert.match(closed.error.message, /closed/i);

  const readClosed = await probeInChild(await fixture(t, 'read-closed'), 'read-closed');
  assert.equal(readClosed.ok, false);
  assert.match(readClosed.error.message, /closed/i);

  const readExtra = await probeInChild(await fixture(t, 'read-extra'), 'read-extra');
  assert.equal(readExtra.ok, false);
  assert.equal(readExtra.getterCalls, 0);
  assert.match(readExtra.error.message, /read authority/i);
});

test('repository read returns closed empty, pending-start and ready-active outcomes',
  async (t) => {
    const emptyRoot = await fixture(t, 'read-empty');
    assert.deepEqual(await probeInChild(emptyRoot, 'read'), {
      ok: true,
      result: { kind: 'none' },
      getterCalls: 0,
    });

    const pendingRoot = await fixture(t, 'read-pending');
    const pending = await reserveInChild(pendingRoot, initialCommand());
    assert.deepEqual(await probeInChild(pendingRoot, 'read'), {
      ok: true,
      result: { kind: 'start-reserved', intent: pending },
      getterCalls: 0,
    });

    const readyRoot = await fixture(t, 'read-ready');
    await seedReadyInitial(readyRoot);
    assert.deepEqual(await probeInChild(readyRoot, 'read'), {
      ok: true,
      result: {
        kind: 'active',
        command: {
          schemaVersion: 3,
          platform: 'ios',
          allocationSequence: 1,
          predecessorCommandSha256: null,
          captureId: CAPTURE_ID,
          commandSha256: FIRST_COMMAND_SHA256,
          command: initialCommand(),
          state: 'prepared',
          recordSha256: FIRST_PREPARED_RECORD_SHA256,
        },
      },
      getterCalls: 0,
    });
  });

test('repository read owns one SQL snapshot and rolls back invalid authority', async (t) => {
  const validRoot = await fixture(t, 'read-order');
  const valid = await probeInChild(validRoot, 'read-order');
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.result, { kind: 'none' });
  assert.equal(valid.sqlTrace[0], 'BEGIN');
  assert.equal(valid.sqlTrace.includes('READ'), true);
  assert.equal(valid.sqlTrace.at(-1), 'COMMIT');

  const invalidRoot = await fixture(t, 'read-order-invalid');
  const invalid = await probeInChild(invalidRoot, 'read-order-invalid');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.sqlTrace[0], 'BEGIN');
  assert.equal(invalid.sqlTrace.includes('READ'), true);
  assert.equal(invalid.sqlTrace.at(-1), 'ROLLBACK');
});

test('repository read takes one committed snapshot beside a real writer', async (t) => {
  const root = await fixture(t, 'read-live-writer');
  const reader = spawnBarrierReader(root);
  await reader.ready;
  const writer = new DatabaseSync(databasePath(root));
  let observed;
  try {
    writer.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      BEGIN IMMEDIATE;
      UPDATE b3_authority_state SET next_allocation_sequence = 2;
    `);

    reader.release();
    observed = await reader.result;
  } finally {
    if (writer.isTransaction) writer.exec('ROLLBACK');
    writer.close();
  }
  assert.deepEqual(observed, {
    ok: true,
    result: { kind: 'none' },
  });
});

test('every repository read rereads build authority and rejects a stale open session',
  async (t) => {
    const root = await fixture(t, 'fresh-read-build-authority');
    const reader = spawnBarrierReader(root);
    await reader.ready;
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

    reader.release();
    const result = await reader.result;

    assert.equal(result.ok, false);
    assert.match(result.error.message, /build|metadata|authority|differs/i);
    assert.equal(await fileSha256(path), beforeSha256);
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

test('later allocation snapshots once and rejects a stable fresh build replacement',
  async (t) => {
    const root = await fixture(t, 'fresh-build-allocation');
    await seedReadyInitial(root);
    const closed = await decideInChild(root, [{ op: 'consume', sourceName: 'A' }]);
    assert.equal(closed.ok, true);
    assert.equal(closed.results[0].kind, 'consumed');
    const command = laterCommand({
      expectedScenarioIndex: 1,
      expectedSequence: 2,
      previousObservationSha256: 'a'.repeat(64),
    });
    const child = spawnBarrierMutator(t, root, {
      kind: 'allocate',
      command,
      countGetters: true,
    });
    assert.deepEqual(await child.ready, { kind: 'none' });
    const path = databasePath(root);
    const beforeSha256 = await fileSha256(path);

    await replaceBuildAuthority(root);
    child.release();
    const outcome = await child.result;

    assert.equal(outcome.result, null);
    assert.equal(outcome.error.code, 'b3_capture_state_invalid');
    assert.match(outcome.error.message, /build|authority|differs/i);
    assert.deepEqual(outcome.synchronousGetterSnapshot, {
      sourceGetterCalls: 0,
      commandGetterCalls: 0,
      allocationCommandGetterCalls: Object.keys(command).length,
    });
    assert.deepEqual(outcome.getterCounts, outcome.synchronousGetterSnapshot);
    assert.equal(await fileSha256(path), beforeSha256);
  });

test('decision mutators snapshot once and reject a stable fresh build replacement',
  async (t) => {
    for (const [label, action] of [
      ['transition', {
        kind: 'transition',
        nextState: 'launching',
        countGetters: true,
      }],
      ['consumption', { kind: 'consume', countGetters: true }],
    ]) {
      const root = await fixture(t, `fresh-build-${label}`);
      await seedReadyInitial(root);
      const child = spawnBarrierMutator(t, root, action);
      const preflight = await child.ready;
      assert.equal(preflight.kind, 'active', label);
      assert.equal(preflight.command.state, 'prepared', label);
      const path = databasePath(root);
      const beforeSha256 = await fileSha256(path);

      await replaceBuildAuthority(root);
      child.release();
      const outcome = await child.result;

      assert.equal(outcome.result, null, label);
      assert.equal(outcome.error.code, 'b3_capture_state_invalid', label);
      assert.match(outcome.error.message, /build|authority|differs/i, label);
      assert.deepEqual(outcome.synchronousGetterSnapshot, {
        sourceGetterCalls: Object.keys(preflight.command).length,
        commandGetterCalls: Object.keys(preflight.command.command).length,
        allocationCommandGetterCalls: 0,
      }, label);
      assert.deepEqual(
        outcome.getterCounts,
        outcome.synchronousGetterSnapshot,
        label,
      );
      assert.equal(await fileSha256(path), beforeSha256, label);
    }
  });

test('ordinary transition selects prepared to launching and retains an identical retry',
  async (t) => {
    const root = await fixture(t, 'transition-prepared-launching');
    await seedReadyInitial(root);

    const result = await decideInChild(root, [
      { op: 'transition', sourceState: 'prepared', nextState: 'launching' },
      { op: 'transition', sourceState: 'prepared', nextState: 'launching' },
    ]);

    assert.equal(result.ok, true);
    assert.deepEqual(result.results.map(({ kind }) => kind), [
      'transitioned',
      'already-transitioned',
    ]);
    assert.equal(result.results[0].command.state, 'launching');
    assert.deepEqual(result.results[1].command, result.results[0].command);
    assert.deepEqual(result.final, {
      kind: 'active',
      command: result.results[0].command,
    });
  });

test('repository selects every one of the twelve frozen ordinary edges', async (t) => {
  for (const edge of ORDINARY_EDGES) {
    const [sourceState, nextState] = edge;
    const root = await fixture(t, `ordinary-${sourceState}-${nextState}`);
    await seedReadyInitial(root);
    const actions = [
      ...PATH_TO_STATE[sourceState].map((pathEdge) => transitionAction(pathEdge)),
      transitionAction(edge),
    ];

    const result = await decideInChild(root, actions);

    assert.equal(result.ok, true, `${sourceState}:${nextState}`);
    assert.equal(result.results.at(-1).kind, 'transitioned', `${sourceState}:${nextState}`);
    assert.equal(result.results.at(-1).command.state, nextState, `${sourceState}:${nextState}`);
    assert.deepEqual(result.final, {
      kind: 'active',
      command: result.results.at(-1).command,
    }, `${sourceState}:${nextState}`);
  }
});

test('ordinary decision returns its retained winner to a conflicting retry', async (t) => {
  const root = await fixture(t, 'ordinary-conflict');
  await seedReadyInitial(root);

  const result = await decideInChild(root, [
    transitionAction(['prepared', 'launching']),
    transitionAction(['prepared', 'stop-intent']),
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.results[1].kind, 'ordinary-conflict');
  assert.equal(result.results[1].command.state, 'launching');
  assert.deepEqual(result.results[1].command, result.results[0].command);
});

test('ordinary transition rejects non-frozen and recovery edges without mutation', async (t) => {
  const root = await fixture(t, 'ordinary-invalid');
  await seedReadyInitial(root);

  const result = await decideInChild(root, [
    transitionAction(['prepared', 'launched'], { expectError: true }),
    transitionAction(['prepared', 'launching']),
    transitionAction(['launching', 'restart-required']),
    transitionAction(['restart-required', 'restart-executing'], { expectError: true }),
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map(({ kind }) => kind), [
    'error', 'transitioned', 'transitioned', 'error',
  ]);
  assert.equal(result.results[0].code, 'b3_capture_state_invalid');
  assert.equal(result.results[3].code, 'b3_capture_state_invalid');
  assert.match(result.results[0].message, /transition|invalid/i);
  assert.match(result.results[3].message, /transition|invalid/i);
  assert.equal(result.final.command.state, 'restart-required');
});

test('repository rejects every other transition pair for each selected ordinary source',
  async (t) => {
    for (const sourceState of Object.keys(PATH_TO_STATE).filter((state) =>
      ORDINARY_EDGES.some(([source]) => source === state))) {
      const root = await fixture(t, `ordinary-invalid-all-${sourceState}`);
      await seedReadyInitial(root);
      const allowed = new Set(ORDINARY_EDGES
        .filter(([source]) => source === sourceState)
        .map(([, next]) => next));
      const invalidStates = [...ISSUED_COMMAND_STATES, 'unknown-state']
        .filter((nextState) => !allowed.has(nextState));
      const result = await decideInChild(root, [
        ...PATH_TO_STATE[sourceState].map((edge) => transitionAction(edge)),
        ...invalidStates.map((nextState) => ({
          ...transitionAction([sourceState, nextState]),
          expectError: true,
        })),
      ]);

      assert.equal(result.ok, true, sourceState);
      const rejected = result.results.slice(PATH_TO_STATE[sourceState].length);
      assert.equal(rejected.length, invalidStates.length, sourceState);
      for (const outcome of rejected) {
        assert.equal(outcome.kind, 'error', sourceState);
        assert.equal(outcome.code, 'b3_capture_state_invalid', sourceState);
      }
      assert.equal(result.final.command.state, sourceState, sourceState);
    }
  });

test('ordinary transition snapshots every source and nested command getter exactly once',
  async (t) => {
    const root = await fixture(t, 'ordinary-getters-once');
    await seedReadyInitial(root);

    const result = await decideInChild(root, [
      transitionAction(['prepared', 'launching'], { countGetters: true }),
    ]);

    assert.equal(result.ok, true);
    assert.equal(result.sourceGetterCalls, 9);
    assert.equal(result.commandGetterCalls, Object.keys(initialCommand()).length);
  });

test('generic consumption closes prepared exactly once and clears only its active pointer',
  async (t) => {
    const root = await fixture(t, 'consume-prepared');
    await seedReadyInitial(root);

    const result = await decideInChild(root, [
      { op: 'consume', sourceState: 'prepared' },
      { op: 'consume', sourceState: 'prepared' },
      transitionAction(['prepared', 'launching']),
    ]);

    assert.equal(result.ok, true);
    assert.deepEqual(result.results, [
      {
        kind: 'consumed',
        commandSha256: FIRST_COMMAND_SHA256,
        sourceState: 'prepared',
        claimSha256: '09f59c0645547a4d7cf701893b9540e0b5f6862ede5992e744c9434a650947f2',
      },
      {
        kind: 'already-consumed',
        commandSha256: FIRST_COMMAND_SHA256,
        sourceState: 'prepared',
        claimSha256: '09f59c0645547a4d7cf701893b9540e0b5f6862ede5992e744c9434a650947f2',
      },
      {
        kind: 'generic-consumed',
        commandSha256: FIRST_COMMAND_SHA256,
        sourceState: 'prepared',
        claimSha256: '09f59c0645547a4d7cf701893b9540e0b5f6862ede5992e744c9434a650947f2',
      },
    ]);
    assert.deepEqual(result.final, { kind: 'none' });
    const database = new DatabaseSync(databasePath(root), { readOnly: true });
    t.after(() => database.close());
    assert.deepEqual({ ...database.prepare('SELECT * FROM b3_authority_state').get() }, {
      singleton: 1,
      next_allocation_sequence: 2,
      active_command_sha256: null,
      reserved_start_command_sha256: null,
      row_version: 4,
    });
    assert.deepEqual({ ...database.prepare(`
      SELECT source_state, source_record_sha256, winner_kind, next_state,
        next_record_json, next_record_sha256, claim_sha256
      FROM b3_decisions
    `).get() }, {
      source_state: 'prepared',
      source_record_sha256: FIRST_PREPARED_RECORD_SHA256,
      winner_kind: 'generic-consumption',
      next_state: null,
      next_record_json: null,
      next_record_sha256: null,
      claim_sha256: '09f59c0645547a4d7cf701893b9540e0b5f6862ede5992e744c9434a650947f2',
    });
  });

test('generic consumption without its exact committed step rejects without mutation',
  async (t) => {
    const root = await fixture(t, 'consume-requires-step');
    await seedReadyInitial(root);
    const path = databasePath(root);
    const beforeSha256 = await fileSha256(path);

    const result = await decideInChild(root, [
      {
        op: 'consume', sourceState: 'prepared',
        withoutStep: true, expectError: true,
      },
    ]);

    assert.equal(result.ok, true);
    assert.equal(result.results[0].kind, 'error');
    assert.equal(result.results[0].code, 'b3_capture_state_invalid');
    assert.match(result.results[0].message, /committed step|observation step/i);
    assert.equal(await fileSha256(path), beforeSha256);
    assert.equal(result.final.kind, 'active');
    assert.equal(result.final.command.state, 'prepared');
  });

test('ready validation rejects a generically closed command without its step unchanged',
  async (t) => {
    const root = await fixture(t, 'closed-command-requires-step');
    await seedReadyInitial(root);
    const path = databasePath(root);
    const prepared = JSON.parse(FIRST_PREPARED_RECORD_JSON.toString('utf8'));
    const claim = createB3GenericConsumptionClaimAuthority({
      platform: 'ios',
      source: prepared,
    });
    const database = new DatabaseSync(path);
    try {
      database.prepare(`
        INSERT INTO b3_decisions (
          command_sha256, source_state, source_record_sha256, winner_kind,
          next_state, next_record_json, next_record_sha256,
          claim_json, claim_sha256
        ) VALUES (?, ?, ?, 'generic-consumption', NULL, NULL, NULL, ?, ?)
      `).run(
        prepared.commandSha256,
        prepared.state,
        prepared.recordSha256,
        Buffer.from(canonicaliseB3ProofValue(claim), 'utf8'),
        claim.claimSha256,
      );
      database.exec(`
        UPDATE b3_authority_state
        SET active_command_sha256 = NULL, row_version = row_version + 1
      `);
    } finally {
      database.close();
    }
    const corruptSha256 = await fileSha256(path);

    const reopened = await probeInChild(root, 'shape');

    assert.equal(reopened.ok, false);
    assert.match(reopened.error.message, /committed step|retained step|closed tail/i);
    assert.equal(await fileSha256(path), corruptSha256);
  });

test('repository generically consumes each of the eight frozen source states', async (t) => {
  for (const sourceState of [
    'prepared',
    'stop-intent',
    'stop-executing',
    'host-stopped',
    'launching',
    'reinstall-authorised',
    'reinstall-launching',
    'launched',
  ]) {
    const root = await fixture(t, `consume-${sourceState}`);
    await seedReadyInitial(root);
    const result = await decideInChild(root, [
      ...PATH_TO_STATE[sourceState].map((edge) => transitionAction(edge)),
      { op: 'consume', sourceState },
    ]);

    assert.equal(result.ok, true, sourceState);
    assert.equal(result.results.at(-1).kind, 'consumed', sourceState);
    assert.equal(result.results.at(-1).sourceState, sourceState, sourceState);
    assert.deepEqual(result.final, { kind: 'none' }, sourceState);
  }
});

test('generic consumption returns an ordinary winner selected for the same source', async (t) => {
  const root = await fixture(t, 'consume-ordinary-selected');
  await seedReadyInitial(root);

  const result = await decideInChild(root, [
    transitionAction(['prepared', 'launching']),
    { op: 'consume', sourceState: 'prepared' },
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.results[1].kind, 'ordinary-selected');
  assert.deepEqual(result.results[1].command, result.results[0].command);
  assert.equal(result.final.command.state, 'launching');
});

test('generic consumption rejects forbidden, recovery and unknown sources unchanged',
  async (t) => {
    const root = await fixture(t, 'consume-forbidden');
    await seedReadyInitial(root);
    const path = await decideInChild(root, [
      transitionAction(['prepared', 'launching']),
      transitionAction(['launching', 'restart-required']),
    ]);
    assert.equal(path.ok, true);
    const beforeSha256 = await fileSha256(databasePath(root));

    const result = await decideInChild(root, [
      { op: 'consume', sourceState: 'restart-required', expectError: true },
      {
        op: 'consume',
        sourceState: 'restart-required',
        forgeState: 'restart-executing',
        expectError: true,
      },
      {
        op: 'consume',
        sourceState: 'restart-required',
        forgeState: 'restart-complete',
        expectError: true,
      },
      {
        op: 'consume',
        sourceState: 'restart-required',
        forgeState: 'unknown-recovery',
        expectError: true,
      },
    ]);

    assert.equal(result.ok, true);
    assert.deepEqual(result.results.map(({ kind }) => kind), [
      'error', 'error', 'error', 'error',
    ]);
    for (const outcome of result.results) {
      assert.equal(outcome.code, 'b3_capture_state_invalid');
      assert.match(outcome.message, /generic-consumption|state|invalid/i);
    }
    assert.equal(await fileSha256(databasePath(root)), beforeSha256);
    assert.equal(result.final.command.state, 'restart-required');
  });

test('generic consumption snapshots source and nested command getters exactly once',
  async (t) => {
    const root = await fixture(t, 'consume-getters-once');
    await seedReadyInitial(root);

    const result = await decideInChild(root, [
      { op: 'consume', sourceState: 'prepared', countGetters: true },
    ]);

    assert.equal(result.ok, true);
    assert.equal(result.sourceGetterCalls, 9);
    assert.equal(result.commandGetterCalls, Object.keys(initialCommand()).length);
  });

test('corrupt retained decision normalises authority failure and leaves database unchanged',
  async (t) => {
    const root = await fixture(t, 'decision-corrupt-code');
    await seedReadyInitial(root);
    const selected = await decideInChild(root, [
      transitionAction(['prepared', 'launching']),
    ]);
    assert.equal(selected.ok, true);
    const path = databasePath(root);
    const database = new DatabaseSync(path);
    const retained = database.prepare(`
      SELECT claim_json FROM b3_decisions
      WHERE command_sha256 = ? AND source_state = 'prepared'
    `).get(FIRST_COMMAND_SHA256);
    const corrupt = JSON.parse(Buffer.from(retained.claim_json).toString('utf8'));
    corrupt.claimSha256 = 'f'.repeat(64);
    database.prepare(`
      UPDATE b3_decisions SET claim_json = ?
      WHERE command_sha256 = ? AND source_state = 'prepared'
    `).run(
      Buffer.from(canonicaliseB3ProofValue(corrupt), 'utf8'),
      FIRST_COMMAND_SHA256,
    );
    database.close();
    const corruptSha256 = await fileSha256(path);

    const opened = await probeInChild(root, 'shape');

    assert.equal(opened.ok, false);
    assert.equal(opened.error.code, 'b3_capture_state_invalid');
    assert.match(opened.error.message, /decision|claim|authority|invalid/i);
    assert.equal(await fileSha256(path), corruptSha256);
  });

test('decision APIs reject extra options before getters and reject use after close',
  async (t) => {
    for (const [label, actions] of [
      ['transition-extra', [{
        op: 'transition-extra',
        nextState: 'launching',
        expectError: true,
      }]],
      ['consume-extra', [{ op: 'consume-extra', expectError: true }]],
      ['allocate-extra', [{ op: 'allocate-extra', expectError: true }]],
      ['transition-closed', [{
        op: 'close-transition',
        sourceState: 'prepared',
        nextState: 'launching',
        expectError: true,
      }]],
      ['consume-closed', [{
        op: 'close-consume',
        sourceState: 'prepared',
        expectError: true,
      }]],
      ['allocate-closed', [{
        op: 'close-allocate',
        command: laterCommand({
          expectedScenarioIndex: 1,
          expectedSequence: 2,
          previousObservationSha256: 'a'.repeat(64),
        }),
        expectError: true,
      }]],
    ]) {
      const root = await fixture(t, `decision-api-${label}`);
      await seedReadyInitial(root);
      const result = await decideInChild(root, actions);
      assert.equal(result.ok, true, label);
      assert.equal(result.results[0].kind, 'error', label);
      assert.equal(result.results[0].code, 'b3_capture_state_invalid', label);
      if (label.endsWith('extra')) assert.equal(result.optionGetterCalls, 0, label);
    }
  });

test('repository normalises a malformed nested source before database mutation',
  async (t) => {
    const root = await fixture(t, 'decision-malformed-source');
    await seedReadyInitial(root);
    const path = databasePath(root);
    const beforeSha256 = await fileSha256(path);

    const result = await decideInChild(root, [{
      op: 'transition',
      sourceState: 'prepared',
      nextState: 'launching',
      malformedCommand: true,
      expectError: true,
    }]);

    assert.equal(result.ok, true);
    assert.equal(result.results[0].kind, 'error');
    assert.equal(result.results[0].code, 'b3_capture_state_invalid');
    assert.equal(await fileSha256(path), beforeSha256);
  });

test('malformed persisted decision bytes map to capture-state errors without mutation',
  async (t) => {
    const scenarios = [
      {
        label: 'ordinary-claim',
        action: transitionAction(['prepared', 'launching']),
        column: 'claim_json',
      },
      {
        label: 'ordinary-next-record',
        action: transitionAction(['prepared', 'launching']),
        column: 'next_record_json',
      },
      {
        label: 'generic-claim',
        action: { op: 'consume', sourceState: 'prepared' },
        column: 'claim_json',
      },
    ];
    for (const scenario of scenarios) {
      const root = await fixture(t, `decision-malformed-${scenario.label}`);
      await seedReadyInitial(root);
      const selected = await decideInChild(root, [scenario.action]);
      assert.equal(selected.ok, true, scenario.label);
      const path = databasePath(root);
      const database = new DatabaseSync(path);
      database.prepare(`
        UPDATE b3_decisions SET ${scenario.column} = x'7b'
        WHERE command_sha256 = ? AND source_state = 'prepared'
      `).run(FIRST_COMMAND_SHA256);
      database.close();
      const corruptSha256 = await fileSha256(path);

      const reopened = await probeInChild(root, 'shape');

      assert.equal(reopened.ok, false, scenario.label);
      assert.equal(reopened.error.code, 'b3_capture_state_invalid', scenario.label);
      assert.equal(await fileSha256(path), corruptSha256, scenario.label);
    }
  });

test('decision APIs deep-snapshot mutable sources before their first await', async (t) => {
  for (const [label, action, expectedKind, expectedFinal] of [
    [
      'transition',
      {
        op: 'transition',
        sourceState: 'prepared',
        nextState: 'launching',
        mutateBeforeAwait: true,
      },
      'transitioned',
      'active',
    ],
    [
      'consume',
      { op: 'consume', sourceState: 'prepared', mutateBeforeAwait: true },
      'consumed',
      'none',
    ],
  ]) {
    const root = await fixture(t, `decision-sync-snapshot-${label}`);
    await seedReadyInitial(root);

    const result = await decideInChild(root, [action]);

    assert.equal(result.ok, true, label);
    assert.equal(result.results[0].kind, expectedKind, label);
    assert.equal(result.final.kind, expectedFinal, label);
  }
});

test('decision APIs synchronously snapshot each getter once before returning a promise',
  async (t) => {
    for (const [label, action] of [
      ['transition', {
        op: 'transition',
        sourceState: 'prepared',
        nextState: 'launching',
        countGetters: true,
        observeBeforeAwait: true,
      }],
      ['consume', {
        op: 'consume',
        sourceState: 'prepared',
        countGetters: true,
        observeBeforeAwait: true,
      }],
    ]) {
      const root = await fixture(t, `decision-sync-getters-${label}`);
      await seedReadyInitial(root);

      const result = await decideInChild(root, [action]);

      assert.equal(result.ok, true, label);
      assert.deepEqual(result.synchronousGetterSnapshots, [{
        sourceGetterCalls: 9,
        commandGetterCalls: Object.keys(initialCommand()).length,
      }], label);
      assert.equal(result.sourceGetterCalls, 9, label);
      assert.equal(result.commandGetterCalls, Object.keys(initialCommand()).length, label);
    }
  });

test('real processes selecting one identical ordinary successor retain one winner',
  { timeout: 15_000 }, async (t) => {
    const root = await fixture(t, 'decision-race-identical-ordinary');
    await seedReadyInitial(root);

    const race = await raceBarrierMutations(t, root, [
      { kind: 'transition', nextState: 'launching' },
      { kind: 'transition', nextState: 'launching' },
    ]);

    assert.deepEqual(race.preflights[0], race.preflights[1]);
    assert.equal(race.preflights[0].kind, 'active');
    assert.equal(race.preflights[0].command.state, 'prepared');
    assert.deepEqual(race.outcomes.map(({ error }) => error), [null, null]);
    assert.deepEqual(race.outcomes.map(({ result }) => result.kind).sort(), [
      'already-transitioned', 'transitioned',
    ]);
    assert.deepEqual(race.outcomes[0].result.command, race.outcomes[1].result.command);
    assert.equal(race.outcomes[0].result.command.state, 'launching');

    const state = readRaceDatabaseState(root);
    assert.deepEqual(state.decisions, [{
      command_sha256: FIRST_COMMAND_SHA256,
      source_state: 'prepared',
      winner_kind: 'ordinary',
      next_state: 'launching',
    }]);
    assert.deepEqual(state.authority, {
      next_allocation_sequence: 2,
      active_command_sha256: FIRST_COMMAND_SHA256,
      row_version: 3,
    });
  });

test('real processes selecting different ordinary successors retain one typed conflict',
  { timeout: 15_000 }, async (t) => {
    const root = await fixture(t, 'decision-race-different-ordinary');
    await seedReadyInitial(root);

    const race = await raceBarrierMutations(t, root, [
      { kind: 'transition', nextState: 'launching' },
      { kind: 'transition', nextState: 'stop-intent' },
    ]);

    assert.deepEqual(race.preflights[0], race.preflights[1]);
    assert.equal(race.preflights[0].command.state, 'prepared');
    assert.deepEqual(race.outcomes.map(({ error }) => error), [null, null]);
    assert.deepEqual(race.outcomes.map(({ result }) => result.kind).sort(), [
      'ordinary-conflict', 'transitioned',
    ]);
    assert.deepEqual(race.outcomes[0].result.command, race.outcomes[1].result.command);
    assert.equal(
      ['launching', 'stop-intent'].includes(race.outcomes[0].result.command.state),
      true,
    );

    const state = readRaceDatabaseState(root);
    assert.deepEqual(state.decisions, [{
      command_sha256: FIRST_COMMAND_SHA256,
      source_state: 'prepared',
      winner_kind: 'ordinary',
      next_state: race.outcomes[0].result.command.state,
    }]);
    assert.deepEqual(state.authority, {
      next_allocation_sequence: 2,
      active_command_sha256: FIRST_COMMAND_SHA256,
      row_version: 3,
    });
  });

test('real processes consuming one identical source retain one generic winner',
  { timeout: 15_000 }, async (t) => {
    const root = await fixture(t, 'decision-race-identical-consumption');
    await seedReadyInitial(root);

    const race = await raceBarrierMutations(t, root, [
      { kind: 'consume' },
      { kind: 'consume' },
    ]);

    assert.deepEqual(race.preflights[0], race.preflights[1]);
    assert.equal(race.preflights[0].command.state, 'prepared');
    assert.deepEqual(race.outcomes.map(({ error }) => error), [null, null]);
    assert.deepEqual(race.outcomes.map(({ result }) => result.kind).sort(), [
      'already-consumed', 'consumed',
    ]);
    const [first, second] = race.outcomes.map(({ result }) => result);
    assert.equal(first.commandSha256, second.commandSha256);
    assert.equal(first.sourceState, second.sourceState);
    assert.equal(first.claimSha256, second.claimSha256);

    const state = readRaceDatabaseState(root);
    assert.deepEqual(state.decisions, [{
      command_sha256: FIRST_COMMAND_SHA256,
      source_state: 'prepared',
      winner_kind: 'generic-consumption',
      next_state: null,
    }]);
    assert.deepEqual(state.authority, {
      next_allocation_sequence: 2,
      active_command_sha256: null,
      row_version: 4,
    });
  });

test('real ordinary and generic proposals for one source retain one typed winner',
  { timeout: 15_000 }, async (t) => {
    const root = await fixture(t, 'decision-race-ordinary-generic');
    await seedReadyInitial(root);

    const race = await raceBarrierMutations(t, root, [
      { kind: 'transition', nextState: 'launching' },
      { kind: 'consume' },
    ]);

    assert.deepEqual(race.preflights[0], race.preflights[1]);
    assert.equal(race.preflights[0].command.state, 'prepared');
    assert.deepEqual(race.outcomes.map(({ error }) => error), [null, null]);
    const ordinary = race.outcomes.find(({ operation }) => operation === 'transition').result;
    const generic = race.outcomes.find(({ operation }) => operation === 'consume').result;
    const state = readRaceDatabaseState(root);
    assert.equal(state.decisions.length, 1);
    if (ordinary.kind === 'transitioned') {
      assert.equal(generic.kind, 'ordinary-selected');
      assert.deepEqual(generic.command, ordinary.command);
      assert.deepEqual(state.decisions, [{
        command_sha256: FIRST_COMMAND_SHA256,
        source_state: 'prepared',
        winner_kind: 'ordinary',
        next_state: 'launching',
      }]);
      assert.deepEqual(state.authority, {
        next_allocation_sequence: 2,
        active_command_sha256: FIRST_COMMAND_SHA256,
        row_version: 3,
      });
    } else {
      assert.equal(ordinary.kind, 'generic-consumed');
      assert.equal(generic.kind, 'consumed');
      assert.equal(ordinary.commandSha256, generic.commandSha256);
      assert.equal(ordinary.sourceState, generic.sourceState);
      assert.equal(ordinary.claimSha256, generic.claimSha256);
      assert.deepEqual(state.decisions, [{
        command_sha256: FIRST_COMMAND_SHA256,
        source_state: 'prepared',
        winner_kind: 'generic-consumption',
        next_state: null,
      }]);
      assert.deepEqual(state.authority, {
        next_allocation_sequence: 2,
        active_command_sha256: null,
        row_version: 4,
      });
    }
  });

test('one capture allocates contiguous A to B to C after exact generic closures',
  async (t) => {
    const root = await fixture(t, 'allocate-a-b-c');
    await seedReadyInitial(root);
    const commandB = laterCommand({
      expectedScenarioIndex: 1,
      expectedSequence: 2,
      previousObservationSha256: 'a'.repeat(64),
    });
    const commandC = laterCommand({
      expectedScenarioIndex: 2,
      expectedSequence: 3,
      previousObservationSha256: 'b'.repeat(64),
    });

    const result = await decideInChild(root, [
      { op: 'consume', sourceState: 'prepared' },
      { op: 'allocate', command: commandB },
      { op: 'consume', sourceState: 'prepared' },
      { op: 'allocate', command: commandC },
    ]);

    assert.equal(result.ok, true);
    assert.deepEqual(result.results.map(({ kind }) => kind), [
      'consumed', 'allocated', 'consumed', 'allocated',
    ]);
    const allocatedB = result.results[1].command;
    const allocatedC = result.results[3].command;
    assert.equal(allocatedB.allocationSequence, 2);
    assert.equal(allocatedB.predecessorCommandSha256, FIRST_COMMAND_SHA256);
    assert.equal(allocatedB.captureId, CAPTURE_ID);
    assert.equal(allocatedB.state, 'prepared');
    assert.equal(allocatedC.allocationSequence, 3);
    assert.equal(allocatedC.predecessorCommandSha256, allocatedB.commandSha256);
    assert.equal(allocatedC.captureId, CAPTURE_ID);
    assert.equal(allocatedC.state, 'prepared');
    assert.deepEqual(result.final, { kind: 'active', command: allocatedC });

    const database = new DatabaseSync(databasePath(root), { readOnly: true });
    t.after(() => database.close());
    assert.deepEqual(database.prepare(`
      SELECT allocation_sequence, predecessor_command_sha256, capture_id
      FROM b3_commands ORDER BY allocation_sequence
    `).all().map((row) => ({ ...row })), [
      {
        allocation_sequence: 1,
        predecessor_command_sha256: null,
        capture_id: CAPTURE_ID,
      },
      {
        allocation_sequence: 2,
        predecessor_command_sha256: FIRST_COMMAND_SHA256,
        capture_id: CAPTURE_ID,
      },
      {
        allocation_sequence: 3,
        predecessor_command_sha256: allocatedB.commandSha256,
        capture_id: CAPTURE_ID,
      },
    ]);
    assert.deepEqual({ ...database.prepare('SELECT * FROM b3_authority_state').get() }, {
      singleton: 1,
      next_allocation_sequence: 4,
      active_command_sha256: allocatedC.commandSha256,
      reserved_start_command_sha256: null,
      row_version: 7,
    });
    assert.equal(database.prepare('SELECT count(*) AS count FROM b3_captures').get().count, 1);
    assert.equal(database.prepare('SELECT count(*) AS count FROM b3_decisions').get().count, 2);
  });

test('allocation retries retain one active slot winner and classify a different proposal',
  async (t) => {
    const root = await fixture(t, 'allocate-idempotent-conflict');
    await seedReadyInitial(root);
    const commandB = laterCommand({
      expectedScenarioIndex: 1,
      expectedSequence: 2,
      previousObservationSha256: 'a'.repeat(64),
    });
    const commandC = laterCommand({
      expectedScenarioIndex: 2,
      expectedSequence: 3,
      previousObservationSha256: 'b'.repeat(64),
    });

    const result = await decideInChild(root, [
      { op: 'consume', sourceName: 'A' },
      { op: 'allocate', command: commandB, saveAs: 'B' },
      { op: 'allocate', command: commandB },
      { op: 'allocate', command: commandC },
    ]);

    assert.equal(result.ok, true);
    assert.deepEqual(result.results.map(({ kind }) => kind), [
      'consumed', 'allocated', 'already-active', 'allocation-conflict',
    ]);
    assert.deepEqual(result.results[2].command, result.results[1].command);
    assert.deepEqual(result.results[3].command, result.results[1].command);
    assert.deepEqual(result.final, { kind: 'active', command: result.results[1].command });
    const database = new DatabaseSync(databasePath(root), { readOnly: true });
    t.after(() => database.close());
    assert.equal(database.prepare('SELECT count(*) AS count FROM b3_commands').get().count, 2);
  });

test('allocation retry returns the current state of its active retained slot',
  async (t) => {
    const root = await fixture(t, 'allocate-idempotent-current-state');
    await seedReadyInitial(root);
    const commandB = laterCommand({
      expectedScenarioIndex: 1,
      expectedSequence: 2,
      previousObservationSha256: 'a'.repeat(64),
    });

    const result = await decideInChild(root, [
      { op: 'consume', sourceName: 'A' },
      { op: 'allocate', command: commandB, saveAs: 'B' },
      {
        op: 'transition',
        sourceName: 'B',
        nextState: 'launching',
      },
      { op: 'allocate', command: commandB },
    ]);

    assert.equal(result.ok, true);
    assert.deepEqual(result.results.map(({ kind }) => kind), [
      'consumed', 'allocated', 'transitioned', 'already-active',
    ]);
    assert.equal(result.results[3].command.state, 'launching');
    assert.deepEqual(result.results[3].command, result.results[2].command);
    assert.deepEqual(result.final, { kind: 'active', command: result.results[2].command });
  });

test('real processes allocating one identical B proposal retain one sequence-two winner',
  { timeout: 15_000 }, async (t) => {
    const root = await fixture(t, 'allocation-race-identical-b');
    await seedReadyInitial(root);
    const closed = await decideInChild(root, [{ op: 'consume', sourceName: 'A' }]);
    assert.equal(closed.ok, true);
    assert.equal(closed.results[0].kind, 'consumed');
    assert.deepEqual(closed.final, { kind: 'none' });
    const commandB = laterCommand({
      expectedScenarioIndex: 1,
      expectedSequence: 2,
      previousObservationSha256: 'a'.repeat(64),
    });

    const race = await raceBarrierMutations(t, root, [
      { kind: 'allocate', command: commandB },
      { kind: 'allocate', command: commandB },
    ]);

    assert.deepEqual(race.preflights, [{ kind: 'none' }, { kind: 'none' }]);
    assert.deepEqual(race.outcomes.map(({ error }) => error), [null, null]);
    assert.deepEqual(race.outcomes.map(({ result }) => result.kind).sort(), [
      'allocated', 'already-active',
    ]);
    assert.deepEqual(race.outcomes[0].result.command, race.outcomes[1].result.command);
    const winner = race.outcomes[0].result.command;
    assert.equal(winner.allocationSequence, 2);
    assert.equal(winner.predecessorCommandSha256, FIRST_COMMAND_SHA256);

    const state = readRaceDatabaseState(root);
    assert.deepEqual(state.commands.map(({ allocation_sequence }) => allocation_sequence), [1, 2]);
    assert.equal(state.commands[1].command_sha256, winner.commandSha256);
    assert.equal(state.commands[1].predecessor_command_sha256, FIRST_COMMAND_SHA256);
    assert.deepEqual(state.authority, {
      next_allocation_sequence: 3,
      active_command_sha256: winner.commandSha256,
      row_version: 5,
    });
  });

test('real processes allocating different B proposals retain one typed slot conflict',
  { timeout: 15_000 }, async (t) => {
    const root = await fixture(t, 'allocation-race-different-b');
    await seedReadyInitial(root);
    const closed = await decideInChild(root, [{ op: 'consume', sourceName: 'A' }]);
    assert.equal(closed.ok, true);
    assert.equal(closed.results[0].kind, 'consumed');
    assert.deepEqual(closed.final, { kind: 'none' });
    const firstProposal = laterCommand({
      expectedScenarioIndex: 1,
      expectedSequence: 2,
      previousObservationSha256: 'a'.repeat(64),
    });
    const secondProposal = laterCommand({
      expectedScenarioIndex: 2,
      expectedSequence: 2,
      previousObservationSha256: 'a'.repeat(64),
    });

    const race = await raceBarrierMutations(t, root, [
      { kind: 'allocate', command: firstProposal },
      { kind: 'allocate', command: secondProposal },
    ]);

    assert.deepEqual(race.preflights, [{ kind: 'none' }, { kind: 'none' }]);
    assert.deepEqual(race.outcomes.map(({ error }) => error), [null, null]);
    assert.deepEqual(race.outcomes.map(({ result }) => result.kind).sort(), [
      'allocated', 'allocation-conflict',
    ]);
    assert.deepEqual(race.outcomes[0].result.command, race.outcomes[1].result.command);
    const winner = race.outcomes[0].result.command;
    assert.equal([1, 2].includes(winner.command.expectedScenarioIndex), true);
    assert.notEqual(winner.command.previousObservationSha256, 'a'.repeat(64));

    const state = readRaceDatabaseState(root);
    assert.deepEqual(state.commands.map(({ allocation_sequence }) => allocation_sequence), [1, 2]);
    assert.equal(state.commands[1].command_sha256, winner.commandSha256);
    assert.equal(state.commands[1].predecessor_command_sha256, FIRST_COMMAND_SHA256);
    assert.deepEqual(state.authority, {
      next_allocation_sequence: 3,
      active_command_sha256: winner.commandSha256,
      row_version: 5,
    });
  });

test('allocation rejects an unclosed initial active command before retry classification',
  async (t) => {
    const commandB = laterCommand({
      expectedScenarioIndex: 1,
      expectedSequence: 2,
      previousObservationSha256: 'a'.repeat(64),
    });
    for (const [label, proposal] of [
      ['same-a', initialCommand()],
      ['different-b', commandB],
    ]) {
      const root = await fixture(t, `allocate-unclosed-initial-${label}`);
      await seedReadyInitial(root);
      const path = databasePath(root);
      const beforeSha256 = await fileSha256(path);

      const rejected = await decideInChild(root, [{
        op: 'allocate',
        command: proposal,
        expectError: true,
      }]);

      assert.equal(rejected.ok, true, label);
      assert.equal(rejected.results[0].kind, 'error', label);
      assert.equal(rejected.results[0].code, 'b3_capture_state_invalid', label);
      assert.match(rejected.results[0].message, /tail|closed|active/i, label);
      assert.equal(rejected.final.kind, 'active', label);
      assert.equal(rejected.final.command.commandSha256, FIRST_COMMAND_SHA256, label);
      assert.equal(await fileSha256(path), beforeSha256, label);
    }
  });

test('allocation rejects every previously allocated command hash without mutation',
  async (t) => {
    for (const label of ['A', 'B']) {
      const root = await fixture(t, `allocate-old-hash-${label}`);
      await seedReadyInitial(root);
      const commandB = laterCommand({
        expectedScenarioIndex: 1,
        expectedSequence: 2,
        previousObservationSha256: 'a'.repeat(64),
      });
      const closeActions = label === 'A'
        ? [{ op: 'consume', sourceName: 'A' }]
        : [
          { op: 'consume', sourceName: 'A' },
          { op: 'allocate', command: commandB, saveAs: 'B' },
          { op: 'consume', sourceName: 'B' },
        ];
      const closed = await decideInChild(root, closeActions);
      assert.equal(closed.ok, true, label);
      const path = databasePath(root);
      const beforeSha256 = await fileSha256(path);

      const rejected = await decideInChild(root, [{
        op: 'allocate',
        command: label === 'A' ? initialCommand() : commandB,
        expectError: true,
      }]);

      assert.equal(rejected.ok, true, label);
      assert.equal(rejected.results[0].kind, 'error', label);
      assert.equal(rejected.results[0].code, 'b3_capture_state_invalid', label);
      assert.match(rejected.results[0].message, /reuses|earlier|allocation/i, label);
      assert.deepEqual(rejected.final, { kind: 'none' }, label);
      assert.equal(await fileSha256(path), beforeSha256, label);
    }
  });

test('allocation rejects observation sequence 513 before command insertion', async (t) => {
  const root = await fixture(t, 'allocation-sequence-513');
  await seedReadyInitial(root);
  const closed = await decideInChild(root, [{ op: 'consume', sourceName: 'A' }]);
  assert.equal(closed.ok, true);
  assert.equal(closed.results[0].kind, 'consumed');
  const path = databasePath(root);
  const before = await fileSha256(path);
  const proposal = laterCommand({
    expectedScenarioIndex: 8,
    expectedSequence: 513,
    previousObservationSha256: 'a'.repeat(64),
  });

  const result = await decideInChild(root, [{ op: 'allocate', command: proposal }]);

  assert.equal(result.ok, false);
  assert.match(result.error.message, /invalid|sequence|512/u);
  assert.equal(await fileSha256(path), before);
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(database.prepare('SELECT count(*) AS count FROM b3_commands').get().count, 1);
  } finally {
    database.close();
  }
});

test('stale A retries after B and C retain immutable closure without clearing active C',
  async (t) => {
    const root = await fixture(t, 'allocate-stale-a');
    await seedReadyInitial(root);
    const commandB = laterCommand({
      expectedScenarioIndex: 1,
      expectedSequence: 2,
      previousObservationSha256: 'a'.repeat(64),
    });
    const commandC = laterCommand({
      expectedScenarioIndex: 2,
      expectedSequence: 3,
      previousObservationSha256: 'b'.repeat(64),
    });

    const result = await decideInChild(root, [
      { op: 'consume', sourceName: 'A' },
      { op: 'allocate', command: commandB, saveAs: 'B' },
      { op: 'consume', sourceName: 'B' },
      { op: 'allocate', command: commandC, saveAs: 'C' },
      { op: 'consume', sourceName: 'A' },
      {
        op: 'transition',
        sourceName: 'A',
        nextState: 'launching',
      },
    ]);

    assert.equal(result.ok, true);
    assert.equal(result.results[4].kind, 'already-consumed');
    assert.equal(result.results[5].kind, 'generic-consumed');
    assert.deepEqual(result.final, { kind: 'active', command: result.results[3].command });
  });

test('allocation returns the exact pending initial reservation', async (t) => {
  const root = await fixture(t, 'allocate-pending-start');
  const reservation = await reserveInChild(root, initialCommand());
  const path = databasePath(root);
  const beforeSha256 = await fileSha256(path);
  const proposal = laterCommand({
    expectedScenarioIndex: 1,
    expectedSequence: 2,
    previousObservationSha256: 'a'.repeat(64),
  });

  const result = await decideInChild(root, [{ op: 'allocate', command: proposal }]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.results[0], { kind: 'start-reserved', intent: reservation });
  assert.deepEqual(result.final, { kind: 'start-reserved', intent: reservation });
  assert.equal(await fileSha256(path), beforeSha256);
});

test('pending initial authority blocks transition and consumption unchanged', async (t) => {
  const sourceRoot = await fixture(t, 'pending-mutation-source');
  await seedReadyInitial(sourceRoot);
  const sourceResult = await decideInChild(sourceRoot, []);
  assert.equal(sourceResult.ok, true);
  assert.equal(sourceResult.final.kind, 'active');

  const root = await fixture(t, 'pending-mutations');
  const reservation = await reserveInChild(root, initialCommand());
  const path = databasePath(root);
  const beforeSha256 = await fileSha256(path);
  const result = await decideInChild(root, [
    {
      op: 'transition',
      sourceSnapshot: sourceResult.final.command,
      nextState: 'launching',
      expectError: true,
    },
    {
      op: 'consume',
      sourceSnapshot: sourceResult.final.command,
      expectError: true,
    },
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map(({ kind }) => kind), ['error', 'error']);
  assert.deepEqual(result.results.map(({ code }) => code), [
    'b3_capture_state_invalid', 'b3_capture_state_invalid',
  ]);
  assert.deepEqual(result.final, { kind: 'start-reserved', intent: reservation });
  assert.equal(await fileSha256(path), beforeSha256);
});

test('allocation snapshots a mutable command synchronously before its first await',
  async (t) => {
    const root = await fixture(t, 'allocate-sync-snapshot');
    await seedReadyInitial(root);
    const commandB = laterCommand({
      expectedScenarioIndex: 1,
      expectedSequence: 2,
      previousObservationSha256: 'a'.repeat(64),
    });

    const result = await decideInChild(root, [
      { op: 'consume', sourceName: 'A' },
      {
        op: 'allocate',
        command: commandB,
        countAllocationGetters: true,
        observeBeforeAwait: true,
      },
    ]);

    assert.equal(result.ok, true);
    assert.equal(result.results[1].kind, 'allocated');
    assert.deepEqual(result.synchronousAllocationGetterSnapshots, [
      Object.keys(commandB).length,
    ]);
    assert.equal(result.allocationCommandGetterCalls, Object.keys(commandB).length);

    const mutationRoot = await fixture(t, 'allocate-sync-mutation');
    await seedReadyInitial(mutationRoot);
    const mutated = await decideInChild(mutationRoot, [
      { op: 'consume', sourceName: 'A' },
      { op: 'allocate', command: commandB, mutateBeforeAwait: true },
    ]);
    assert.equal(mutated.ok, true);
    assert.equal(mutated.results[1].kind, 'allocated');
    assert.equal(mutated.results[1].command.command.expectedSequence, 2);
    assert.equal(mutated.results[1].command.command.captureId, commandB.captureId);
    assert.notEqual(mutated.results[1].command.command.challengeSha256, 'e'.repeat(64));
    assert.notEqual(mutated.results[1].command.command.expectedSequence, 99);
  });

test('inactive unclosed tails and multi-command orphan decisions reject unchanged',
  async (t) => {
    const inactiveRoot = await fixture(t, 'allocate-inactive-tail');
    await seedReadyInitial(inactiveRoot);
    const inactivePath = databasePath(inactiveRoot);
    const inactive = new DatabaseSync(inactivePath);
    inactive.exec('UPDATE b3_authority_state SET active_command_sha256 = NULL');
    inactive.close();
    const inactiveSha256 = await fileSha256(inactivePath);
    const inactiveOpen = await probeInChild(inactiveRoot, 'shape');
    assert.equal(inactiveOpen.ok, false);
    assert.match(inactiveOpen.error.message, /singleton|authority|invalid/i);
    assert.equal(await fileSha256(inactivePath), inactiveSha256);

    const orphanRoot = await fixture(t, 'allocate-orphan-decision');
    await seedReadyInitial(orphanRoot);
    const commandB = laterCommand({
      expectedScenarioIndex: 1,
      expectedSequence: 2,
      previousObservationSha256: 'a'.repeat(64),
    });
    const allocated = await decideInChild(orphanRoot, [
      { op: 'consume', sourceName: 'A' },
      { op: 'allocate', command: commandB },
    ]);
    assert.equal(allocated.ok, true);
    const orphanPath = databasePath(orphanRoot);
    const orphan = new DatabaseSync(orphanPath);
    orphan.prepare(`
      INSERT INTO b3_decisions (
        command_sha256, source_state, source_record_sha256, winner_kind,
        next_state, next_record_json, next_record_sha256, claim_json, claim_sha256
      ) VALUES (?, 'launching', ?, 'ordinary', 'launched', ?, ?, ?, ?)
    `).run(
      FIRST_COMMAND_SHA256,
      '57686831aa8562d8e309645db655aa17be75d8d647504a1ad17296e456113e09',
      LAUNCHED_RECORD_JSON,
      'f6006d640ff0469b80b500f9fb1f5f9c996b69fb36e6db959ff6485d520bb2c4',
      LAUNCHING_TO_LAUNCHED_CLAIM_JSON,
      '0acb91cd0eda8be3051bda358bf13afa1966fb6ed5061d22a8ba04cfa13c833a',
    );
    orphan.close();
    const orphanSha256 = await fileSha256(orphanPath);
    const orphanOpen = await probeInChild(orphanRoot, 'shape');
    assert.equal(orphanOpen.ok, false);
    assert.match(orphanOpen.error.message, /unselected|orphan|decision/i);
    assert.equal(await fileSha256(orphanPath), orphanSha256);
  });

test('recovery-fresh intent authority blocks every mutator unchanged', async (t) => {
  const sourceRoot = await fixture(t, 'recovery-fresh-source');
  await seedReadyInitial(sourceRoot);
  const sourceResult = await decideInChild(sourceRoot, []);
  assert.equal(sourceResult.ok, true);
  const root = await fixture(t, 'allocate-recovery-fresh');
  await seedReadyInitial(root);
  const path = databasePath(root);
  const database = new DatabaseSync(path);
  database.exec('PRAGMA foreign_keys = OFF');
  database.prepare(`
    UPDATE b3_capture_start_intents
    SET intent_kind = 'recovery-fresh', recovered_command_sha256 = ?,
      terminal_claim_sha256 = ?
  `).run('d'.repeat(64), 'e'.repeat(64));
  database.close();
  const corruptSha256 = await fileSha256(path);
  const proposal = laterCommand({
    expectedScenarioIndex: 1,
    expectedSequence: 2,
    previousObservationSha256: 'a'.repeat(64),
  });

  for (const [label, action] of [
    ['allocation', { op: 'allocate', command: proposal }],
    ['transition', {
      op: 'transition',
      sourceSnapshot: sourceResult.final.command,
      nextState: 'launching',
    }],
    ['consumption', { op: 'consume', sourceSnapshot: sourceResult.final.command }],
  ]) {
    const attempted = await decideInChild(root, [action]);
    assert.equal(attempted.ok, false, label);
    assert.match(attempted.error.message, /foreign-key|authority|invalid/i, label);
    assert.equal(await fileSha256(path), corruptSha256, label);
  }
});

test('a selected persisted recovery decision blocks every mutator unchanged', async (t) => {
  const root = await fixture(t, 'selected-recovery-decision');
  await seedReadyInitial(root);
  const selected = await decideInChild(root, [
    { op: 'transition', sourceState: 'prepared', nextState: 'launching' },
    { op: 'transition', sourceState: 'launching', nextState: 'restart-required' },
  ]);
  assert.equal(selected.ok, true);
  assert.equal(selected.final.kind, 'active');
  assert.equal(selected.final.command.state, 'restart-required');
  const path = databasePath(root);
  const database = new DatabaseSync(path);
  database.prepare(`
    INSERT INTO b3_decisions (
      command_sha256, source_state, source_record_sha256, winner_kind,
      next_state, next_record_json, next_record_sha256, claim_json, claim_sha256
    ) VALUES (?, 'restart-required', ?, 'recovery-owner',
      'restart-executing', ?, ?, ?, ?)
  `).run(
    FIRST_COMMAND_SHA256,
    selected.final.command.recordSha256,
    Buffer.from('{}', 'utf8'),
    'd'.repeat(64),
    Buffer.from('{}', 'utf8'),
    'e'.repeat(64),
  );
  database.close();
  const corruptSha256 = await fileSha256(path);
  const proposal = laterCommand({
    expectedScenarioIndex: 1,
    expectedSequence: 2,
    previousObservationSha256: 'a'.repeat(64),
  });

  for (const [label, action] of [
    ['allocation', { op: 'allocate', command: proposal }],
    ['transition', {
      op: 'transition',
      sourceSnapshot: selected.final.command,
      nextState: 'launched',
    }],
    ['consumption', { op: 'consume', sourceSnapshot: selected.final.command }],
  ]) {
    const attempted = await decideInChild(root, [action]);
    assert.equal(attempted.ok, false, label);
    assert.match(attempted.error.message, /recovery|unsupported|authority|invalid/i, label);
    assert.equal(await fileSha256(path), corruptSha256, label);
  }
});

test('multi-command gaps and predecessor corruption reject without repair', async (t) => {
  for (const [label, mutate] of [
    ['gap', (database) => database.exec(`
      UPDATE b3_commands SET allocation_sequence = 3 WHERE allocation_sequence = 2
    `)],
    ['predecessor', (database) => database.exec(`
      UPDATE b3_commands SET predecessor_command_sha256 = NULL
      WHERE allocation_sequence = 2
    `)],
  ]) {
    const root = await fixture(t, `allocate-corrupt-${label}`);
    await seedReadyInitial(root);
    const commandB = laterCommand({
      expectedScenarioIndex: 1,
      expectedSequence: 2,
      previousObservationSha256: 'a'.repeat(64),
    });
    const allocated = await decideInChild(root, [
      { op: 'consume', sourceName: 'A' },
      { op: 'allocate', command: commandB },
    ]);
    assert.equal(allocated.ok, true, label);
    const path = databasePath(root);
    const database = new DatabaseSync(path);
    mutate(database);
    database.close();
    const corruptSha256 = await fileSha256(path);

    const opened = await probeInChild(root, 'shape');

    assert.equal(opened.ok, false, label);
    assert.match(opened.error.message, /allocated|command|authority|invalid/i, label);
    assert.equal(await fileSha256(path), corruptSha256, label);
  }
});

test('persisted recovery rows block every mutator unchanged', async (t) => {
  const sourceRoot = await fixture(t, 'recovery-row-source');
  await seedReadyInitial(sourceRoot);
  const sourceResult = await decideInChild(sourceRoot, []);
  assert.equal(sourceResult.ok, true);
  const root = await fixture(t, 'allocate-recovery-row');
  await seedReadyInitial(root);
  const path = databasePath(root);
  const database = new DatabaseSync(path);
  database.exec('PRAGMA foreign_keys = OFF');
  database.prepare(`
    INSERT INTO b3_recoveries (
      command_sha256, owner_kind, owner_claim_sha256, capture_id,
      capture_snapshot_sha256, row_version
    ) VALUES (?, 'recovery-owner', ?, ?, ?, 1)
  `).run(FIRST_COMMAND_SHA256, 'd'.repeat(64), CAPTURE_ID, 'e'.repeat(64));
  database.close();
  const corruptSha256 = await fileSha256(path);
  const proposal = laterCommand({
    expectedScenarioIndex: 1,
    expectedSequence: 2,
    previousObservationSha256: 'a'.repeat(64),
  });

  for (const [label, action] of [
    ['allocation', { op: 'allocate', command: proposal }],
    ['transition', {
      op: 'transition',
      sourceSnapshot: sourceResult.final.command,
      nextState: 'launching',
    }],
    ['consumption', { op: 'consume', sourceSnapshot: sourceResult.final.command }],
  ]) {
    const attempted = await decideInChild(root, [action]);
    assert.equal(attempted.ok, false, label);
    assert.match(
      attempted.error.message,
      /foreign-key|recovery|authority|invalid/i,
      label,
    );
    assert.equal(await fileSha256(path), corruptSha256, label);
  }
});
