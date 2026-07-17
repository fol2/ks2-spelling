import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'b3-capture-publication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const distribution = join(root, '.native-build', 'b3', 'distribution');
  await mkdir(distribution, { recursive: true, mode: 0o700 });
  for (const path of [join(root, '.native-build'), join(root, '.native-build', 'b3'), distribution]) {
    await chmod(path, 0o700);
  }
  await writeFile(join(distribution, 'build-authority.json'), JSON.stringify({
    schemaVersion: 1, testedApplicationCommit: '1'.repeat(40),
    applicationFingerprint: '2'.repeat(64), versionName: '0.3.0-b3',
    iosBuildNumber: '19', androidVersionCode: 19,
  }), { mode: 0o600 });
  return root;
}

async function runPublicationChild(root) {
  const helper = new URL('./helpers/b3-capture-state-publication-child.mjs', import.meta.url);
  const { stdout } = await execFileAsync(process.execPath, [
    '--experimental-test-module-mocks', helper.pathname,
  ], { cwd: root });
  return JSON.parse(stdout);
}

async function runPublisher(root, observedAt, mode = 'publish') {
  const helper = new URL('./helpers/b3-capture-state-publisher-child.mjs', import.meta.url);
  const { stdout } = await execFileAsync(process.execPath, [
    '--experimental-test-module-mocks', helper.pathname, mode, observedAt,
  ], { cwd: root });
  return JSON.parse(stdout);
}

async function killPublisher(root, observedAt, mode) {
  try {
    await runPublisher(root, observedAt, mode);
    assert.fail(`${mode} publisher unexpectedly returned`);
  } catch (error) {
    assert.equal(error.signal, 'SIGKILL', error.stderr);
  }
}

function spawnSignalledPublisher(root, observedAt) {
  const helper = new URL('./helpers/b3-capture-state-publisher-child.mjs', import.meta.url);
  const child = fork(helper.pathname, ['signal-before-write', observedAt], {
    cwd: root,
    execArgv: ['--experimental-test-module-mocks'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  let readyResolve;
  let preparedResolve;
  let resultResolve;
  let resultReject;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const prepared = new Promise((resolve) => { preparedResolve = resolve; });
  const result = new Promise((resolve, reject) => {
    resultResolve = resolve;
    resultReject = reject;
  });
  child.on('message', (message) => {
    if (message?.type === 'prepared') preparedResolve();
    if (message?.type === 'ready' && message.attempt === 1) readyResolve();
    if (message?.type === 'result') resultResolve(message.output);
  });
  child.on('error', resultReject);
  child.on('exit', (code, signal) => {
    if (code !== 0) {
      resultReject(new Error(`publisher exited ${code ?? signal}: ${stderr}`));
    }
  });
  return Object.freeze({
    prepared,
    ready,
    result,
    go: () => child.send({ type: 'go' }),
  });
}

function spawnCommandPublicationRole(t, root, role, observedAt) {
  const helper = new URL(
    './helpers/b3-capture-state-command-publication-race-child.mjs',
    import.meta.url,
  );
  const child = fork(helper.pathname, [role, observedAt], {
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
    if (message?.type === 'ready') readyResolve(message);
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
      `B3 command/publication child exited ${code ?? signal}: ${stderr}`,
    );
    readyReject(error);
    resultReject(error);
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  return Object.freeze({
    ready,
    result,
    release: () => child.send({ type: 'go' }),
  });
}

function spawnStoreBackedPublicationRace(t, root) {
  const helper = new URL(
    './helpers/b3-store-backed-publication-race-child.mjs',
    import.meta.url,
  );
  const child = fork(helper.pathname, [], {
    cwd: root,
    execArgv: ['--experimental-test-module-mocks'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  let resultResolve;
  let resultReject;
  let settled = false;
  const barrierResolvers = new Map();
  const barriers = Object.freeze(Object.fromEntries([
    'launch-completion', 'publication', 'consumption',
  ].map((phase) => [phase, new Promise((resolve) => {
    barrierResolvers.set(phase, resolve);
  })])));
  const result = new Promise((resolve, reject) => {
    resultResolve = resolve;
    resultReject = reject;
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  child.on('message', (message) => {
    if (message?.type === 'barrier') barrierResolvers.get(message.phase)?.(message);
    if (message?.type === 'result') {
      settled = true;
      resultResolve(message);
    }
  });
  child.on('error', resultReject);
  child.on('exit', (code, signal) => {
    if (settled) return;
    resultReject(new Error(
      `B3 store-backed publication race child exited ${code ?? signal}: ${stderr}`,
    ));
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  return Object.freeze({
    barriers,
    result,
    release(phase) { child.send({ type: 'go', phase }); },
  });
}

async function replaceBuildSourceInode(root) {
  const directory = join(root, '.native-build', 'b3', 'distribution');
  const path = join(directory, 'build-authority.json');
  const temporary = join(directory, 'build-authority.next.json');
  await writeFile(temporary, await readFile(path), { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

async function rewriteBuildSourceBytes(root) {
  const path = join(root, '.native-build', 'b3', 'distribution', 'build-authority.json');
  const before = await stat(path);
  const bytes = await readFile(path);
  await writeFile(path, Buffer.concat([bytes, Buffer.from('\n', 'utf8')]), { mode: 0o600 });
  const after = await stat(path);
  assert.equal(after.ino, before.ino, 'raw-byte drift must retain the source inode');
}

async function replaceBuildSourceAncestor(root) {
  const parent = join(root, '.native-build', 'b3');
  const directory = join(parent, 'distribution');
  const replaced = join(parent, 'distribution.replaced');
  const bytes = await readFile(join(directory, 'build-authority.json'));
  await rename(directory, replaced);
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, 'build-authority.json'), bytes, { mode: 0o600 });
  await rm(replaced, { recursive: true, force: true });
}

function captureStateDatabasePath(root) {
  return join(
    root, '.native-build', 'b3', 'evidence', 'ios-capture-state', 'recovery.sqlite',
  );
}

function readCaptureStepRow(root) {
  const database = new DatabaseSync(captureStateDatabasePath(root), { readOnly: true });
  try {
    return database.prepare(`
      SELECT * FROM b3_capture_steps WHERE observation_sequence = 1
    `).get();
  } finally {
    database.close();
  }
}

function readRelationalCaptureState(root) {
  const database = new DatabaseSync(captureStateDatabasePath(root), { readOnly: true });
  try {
    return Object.freeze({
      commands: database.prepare(`
        SELECT command_sha256, allocation_sequence
        FROM b3_commands ORDER BY allocation_sequence
      `).all().map((row) => ({ ...row })),
      steps: database.prepare(`
        SELECT command_sha256, observation_sequence
        FROM b3_capture_steps ORDER BY observation_sequence
      `).all().map((row) => ({ ...row })),
      decisions: database.prepare(`
        SELECT command_sha256, source_state, winner_kind, next_state
        FROM b3_decisions ORDER BY command_sha256, source_state
      `).all().map((row) => ({ ...row })),
      authority: {
        ...database.prepare(`
          SELECT active_command_sha256, next_allocation_sequence
          FROM b3_authority_state
        `).get(),
      },
    });
  } finally {
    database.close();
  }
}

async function runReleased(child) {
  await child.ready;
  child.release();
  return child.result;
}

test('D2 facade atomically publishes, retries, conflicts and reads committed capture', async (t) => {
  const root = await fixture(t);
  const result = await runPublicationChild(root);
  assert.equal(result.error, undefined, result.error?.message);
  assert.deepEqual(result.empty.records, []);
  assert.equal(result.empty.checkpoint, null);
  assert.equal(result.empty.gatewaySmokeProjection, null);
  assert.equal(result.first.kind, 'published');
  assert.equal(result.identical.kind, 'already-published');
  assert.equal(result.conflict.kind, 'publication-conflict');
  assert.deepEqual(result.conflict.record, result.first.record);
  assert.deepEqual(result.conflict.checkpoint, result.first.checkpoint);
  assert.equal(result.capture.schemaVersion, 1);
  assert.equal(result.capture.platform, 'ios');
  assert.equal(result.second.kind, 'published');
  assert.equal(result.staleRetry.kind, 'already-published');
  assert.equal(result.capture.records.length, 2);
  assert.deepEqual(result.capture.records[0], result.first.record);
  assert.deepEqual(result.capture.records[1], result.second.record);
  assert.deepEqual(result.capture.checkpoint, result.second.checkpoint);
  assert.equal(result.capture.gatewaySmokeProjection, null);
  assert.deepEqual(result.freezeProof, {
    first: true,
    firstRecord: true,
    firstProjection: true,
    empty: true,
    emptyRecords: true,
    capture: true,
    captureRecords: true,
    checkpoint: true,
  });

  const database = new DatabaseSync(join(
    root, '.native-build', 'b3', 'evidence', 'ios-capture-state', 'recovery.sqlite',
  ), { readOnly: true });
  t.after(() => database.close());
  const rows = database.prepare(`
    SELECT * FROM b3_capture_steps ORDER BY observation_sequence
  `).all();
  assert.equal(rows.length, 2);
  const row = rows[0];
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest(row.record_json), row.record_sha256);
  assert.equal(digest(row.checkpoint_json), row.checkpoint_sha256);
  assert.notEqual(
    JSON.parse(Buffer.from(row.checkpoint_json).toString('utf8')).checkpointSha256,
    row.checkpoint_sha256,
  );
});

test('D2 read rejects structurally rehashed but semantically tampered record bytes', async (t) => {
  const root = await fixture(t);
  assert.equal((await runPublicationChild(root)).error, undefined);
  const path = join(
    root, '.native-build', 'b3', 'evidence', 'ios-capture-state', 'recovery.sqlite',
  );
  const database = new DatabaseSync(path);
  let tamperedBytes;
  try {
    const retained = database.prepare(`
      SELECT record_json FROM b3_capture_steps WHERE observation_sequence = 1
    `).get();
    const record = JSON.parse(Buffer.from(retained.record_json).toString('utf8'));
    record.observation.observedAt = '2026-07-17T10:00:09.000Z';
    tamperedBytes = Buffer.from(JSON.stringify(record), 'utf8');
    database.prepare(`
      UPDATE b3_capture_steps SET record_json = ?, record_sha256 = ?
      WHERE observation_sequence = 1
    `).run(tamperedBytes, createHash('sha256').update(tamperedBytes).digest('hex'));
  } finally {
    database.close();
  }

  const rejected = await runPublicationChild(root);
  assert.equal(rejected.error.code, 'b3_capture_state_invalid');
  assert.match(rejected.error.message, /observation|hash|record|semantic/i);
  const unchanged = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(
      Buffer.from(unchanged.prepare(`
        SELECT record_json FROM b3_capture_steps WHERE observation_sequence = 1
      `).get().record_json).equals(tamperedBytes),
      true,
    );
  } finally {
    unchanged.close();
  }
});

test('D2 real child publishers converge for identical and conflicting proposals',
  { timeout: 15_000 }, async (t) => {
    for (const different of [false, true]) {
      const root = await fixture(t);
      assert.deepEqual(
        await runPublisher(root, '2026-07-17T10:02:00.000Z', 'seed-only'),
        { seeded: true },
      );
      const [left, right] = await Promise.all([
        runPublisher(root, '2026-07-17T10:02:01.000Z'),
        runPublisher(
          root,
          different ? '2026-07-17T10:02:02.000Z' : '2026-07-17T10:02:01.000Z',
        ),
      ]);
      assert.equal(left.error, undefined, left.error?.message);
      assert.equal(right.error, undefined, right.error?.message);
      assert.deepEqual(
        [left.result.kind, right.result.kind].sort(),
        different
          ? ['publication-conflict', 'published']
          : ['already-published', 'published'],
      );
      const database = new DatabaseSync(join(
        root, '.native-build', 'b3', 'evidence', 'ios-capture-state', 'recovery.sqlite',
      ), { readOnly: true });
      try {
        assert.equal(
          database.prepare('SELECT count(*) AS count FROM b3_capture_steps').get().count,
          1,
        );
      } finally {
        database.close();
      }
    }
  });

test('D2 real process death around INSERT and COMMIT converges from SQLite authority',
  { timeout: 20_000 }, async (t) => {
    for (const [mode, recoveredKind] of [
      ['death-before-insert', 'published'],
      ['death-after-insert', 'published'],
      ['death-after-commit', 'already-published'],
    ]) {
      const root = await fixture(t);
      await runPublisher(root, '2026-07-17T10:03:00.000Z', 'seed-only');
      await killPublisher(root, '2026-07-17T10:03:01.000Z', mode);
      const recovered = await runPublisher(root, '2026-07-17T10:03:01.000Z');
      assert.equal(recovered.error, undefined, `${mode}: ${recovered.error?.message}`);
      assert.equal(recovered.result.kind, recoveredKind, mode);
      const database = new DatabaseSync(join(
        root, '.native-build', 'b3', 'evidence', 'ios-capture-state', 'recovery.sqlite',
      ), { readOnly: true });
      try {
        assert.equal(
          database.prepare('SELECT count(*) AS count FROM b3_capture_steps').get().count,
          1,
          mode,
        );
      } finally {
        database.close();
      }
    }
  });

test('D2 real writer lock retries byte, inode and ancestor build-source drift',
  { timeout: 20_000 }, async (t) => {
    for (const [label, mutate] of [
      ['raw-bytes', rewriteBuildSourceBytes],
      ['file-inode', replaceBuildSourceInode],
      ['ancestor-inode', replaceBuildSourceAncestor],
    ]) {
      const root = await fixture(t);
      await runPublisher(root, '2026-07-17T10:05:00.000Z', 'seed-only');
      const lock = new DatabaseSync(captureStateDatabasePath(root));
      const child = spawnSignalledPublisher(root, '2026-07-17T10:05:01.000Z');
      try {
        await child.prepared;
        lock.exec('BEGIN IMMEDIATE');
        child.go();
        await child.ready;
        await mutate(root);
      } finally {
        // This transaction is only a writer-lock barrier and performs no SQL
        // mutation, so release it without an unnecessary EXCLUSIVE commit.
        if (lock.isTransaction) lock.exec('ROLLBACK');
        lock.close();
      }
      const outcome = await child.result;
      assert.equal(outcome.error, undefined, `${label}: ${outcome.error?.message}`);
      assert.equal(outcome.result.kind, 'published', label);
      assert.equal(outcome.attempts, 2, label);
      const database = new DatabaseSync(captureStateDatabasePath(root), { readOnly: true });
      try {
        assert.equal(
          database.prepare('SELECT count(*) AS count FROM b3_capture_steps').get().count,
          1,
          label,
        );
      } finally {
        database.close();
      }
    }
  });

test('D2 publisher retries a winner committed after its read preflight',
  { timeout: 15_000 }, async (t) => {
    const donor = await fixture(t);
    await runPublisher(donor, '2026-07-17T10:05:10.000Z', 'seed-only');
    const donorWinner = await runPublisher(donor, '2026-07-17T10:05:11.000Z');
    assert.equal(donorWinner.result.kind, 'published');
    const winnerRow = readCaptureStepRow(donor);

    const root = await fixture(t);
    await runPublisher(root, '2026-07-17T10:05:12.000Z', 'seed-only');
    const lock = new DatabaseSync(captureStateDatabasePath(root));
    const child = spawnSignalledPublisher(root, '2026-07-17T10:05:13.000Z');
    try {
      await child.prepared;
      // Match the production connection's bounded busy wait: this direct test
      // writer must tolerate the child's transient preflight reader.
      lock.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
      child.go();
      await child.ready;
      lock.prepare(`
        INSERT INTO b3_capture_steps (
          capture_id, observation_sequence, command_sha256,
          record_json, record_sha256, observation_sha256,
          checkpoint_json, checkpoint_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        winnerRow.capture_id,
        winnerRow.observation_sequence,
        winnerRow.command_sha256,
        winnerRow.record_json,
        winnerRow.record_sha256,
        winnerRow.observation_sha256,
        winnerRow.checkpoint_json,
        winnerRow.checkpoint_sha256,
      );
    } finally {
      if (lock.isTransaction) lock.exec('COMMIT');
      lock.close();
    }
    const outcome = await child.result;
    assert.equal(outcome.error, undefined, outcome.error?.message);
    assert.equal(outcome.result.kind, 'publication-conflict');
    assert.equal(outcome.attempts, 2);
    const retained = readCaptureStepRow(root);
    assert.equal(
      Buffer.from(retained.record_json).equals(Buffer.from(winnerRow.record_json)),
      true,
    );
    const database = new DatabaseSync(captureStateDatabasePath(root), { readOnly: true });
    try {
      assert.equal(
        database.prepare('SELECT count(*) AS count FROM b3_capture_steps').get().count,
        1,
      );
    } finally {
      database.close();
    }
  });

test('D2 publication stops after exactly three complete build-source drift attempts',
  { timeout: 15_000 }, async (t) => {
    const root = await fixture(t);
    await runPublisher(root, '2026-07-17T10:06:00.000Z', 'seed-only');
    const outcome = await runPublisher(
      root,
      '2026-07-17T10:06:01.000Z',
      'drift-every-attempt',
    );
    assert.equal(outcome.error.code, 'b3_capture_state_invalid');
    assert.match(outcome.error.message, /build source|changed|publication/i);
    assert.equal(outcome.attempts, 3);
    const database = new DatabaseSync(join(
      root, '.native-build', 'b3', 'evidence', 'ios-capture-state', 'recovery.sqlite',
    ), { readOnly: true });
    try {
      assert.equal(
        database.prepare('SELECT count(*) AS count FROM b3_capture_steps').get().count,
        0,
      );
    } finally {
      database.close();
    }
  });

test('D2 facade invalid-input matrix fails closed without a step or healing write',
  async (t) => {
    const root = await fixture(t);
    await runPublisher(root, '2026-07-17T10:07:00.000Z', 'seed-only');
    const outcome = await runPublisher(
      root,
      '2026-07-17T10:07:01.000Z',
      'invalid-matrix',
    );
    assert.equal(outcome.stepCount, 0);
    assert.equal(outcome.getterCalls, 0);
    assert.deepEqual(Object.keys(outcome.errors).sort(), [
      'accessor', 'closedPublish', 'closedRead', 'empty', 'malformedJson', 'malformedUtf8',
      'nonCanonical', 'nonUint8Array', 'oversized', 'readArgument', 'wrongBuild',
      'wrongPlatform', 'wrongTail',
    ]);
    for (const [label, error] of Object.entries(outcome.errors)) {
      assert.equal(error.accepted, undefined, label);
      assert.equal(error.code, 'b3_capture_state_invalid', label);
    }
  });

test('D2 read fails closed for empty and pending-start state without healing', async (t) => {
  for (const mode of ['read-empty', 'read-pending']) {
    const root = await fixture(t);
    const outcome = await runPublisher(root, '2026-07-17T10:08:00.000Z', mode);
    assert.equal(outcome.error.code, 'b3_capture_state_invalid', mode);
    assert.match(outcome.error.message, /readable|working|capture/i, mode);
    const database = new DatabaseSync(join(
      root, '.native-build', 'b3', 'evidence', 'ios-capture-state', 'recovery.sqlite',
    ), { readOnly: true });
    try {
      assert.equal(
        database.prepare('SELECT count(*) AS count FROM b3_capture_steps').get().count,
        0,
        mode,
      );
    } finally {
      database.close();
    }
  }
});

test('D3 real publisher and ordinary transition converge in both lock orderings',
  { timeout: 15_000 }, async (t) => {
    for (const order of ['publisher-first', 'transition-first']) {
      const root = await fixture(t);
      assert.deepEqual(await runPublisher(
        root,
        '2026-07-17T10:00:00.000Z',
        'seed-only',
      ), { seeded: true });
      const publisher = spawnCommandPublicationRole(
        t, root, 'publish-adopt', '2026-07-17T10:00:00.000Z',
      );
      const transition = spawnCommandPublicationRole(
        t, root, 'transition', '2026-07-17T10:00:00.000Z',
      );
      await Promise.all([publisher.ready, transition.ready]);

      const first = order === 'publisher-first' ? publisher : transition;
      const second = order === 'publisher-first' ? transition : publisher;
      first.release();
      const firstResult = await first.result;
      second.release();
      const secondResult = await second.result;
      const publication = order === 'publisher-first' ? firstResult : secondResult;
      const selected = order === 'publisher-first' ? secondResult : firstResult;

      assert.equal(publication.error, undefined, order);
      assert.equal(publication.result.kind, 'published', order);
      assert.equal(selected.error, undefined, order);
      assert.equal(selected.result.kind, 'transitioned', order);
      assert.equal(selected.result.command.state, 'launching', order);
      assert.equal(
        publication.initialError === null,
        order === 'publisher-first',
        order,
      );
      if (publication.initialError) {
        assert.equal(publication.initialError.code, 'b3_capture_state_invalid', order);
      }
      const state = readRelationalCaptureState(root);
      assert.equal(state.steps.length, 1, order);
      assert.deepEqual(state.decisions.map(({ winner_kind, next_state }) => ({
        winner_kind, next_state,
      })), [{ winner_kind: 'ordinary', next_state: 'launching' }], order);
      assert.equal(state.authority.active_command_sha256, state.commands[0].command_sha256);
    }
  });

test('D3 missing-step consumption cannot commit before publication and later closes',
  { timeout: 15_000 }, async (t) => {
    const root = await fixture(t);
    assert.deepEqual(await runPublisher(
      root,
      '2026-07-17T10:00:00.000Z',
      'seed-only',
    ), { seeded: true });
    const consumer = spawnCommandPublicationRole(
      t, root, 'consume', '2026-07-17T10:00:00.000Z',
    );
    const publisher = spawnCommandPublicationRole(
      t, root, 'publish-prepared', '2026-07-17T10:00:00.000Z',
    );
    await Promise.all([consumer.ready, publisher.ready]);

    consumer.release();
    const rejected = await consumer.result;
    assert.equal(rejected.result, null);
    assert.equal(rejected.error.code, 'b3_capture_state_invalid');
    assert.match(rejected.error.message, /exact committed step/i);
    let state = readRelationalCaptureState(root);
    assert.equal(state.steps.length, 0);
    assert.equal(state.decisions.length, 0);
    assert.equal(state.authority.active_command_sha256, state.commands[0].command_sha256);

    publisher.release();
    const published = await publisher.result;
    assert.equal(published.error, undefined);
    assert.equal(published.result.kind, 'published');
    const retry = spawnCommandPublicationRole(
      t, root, 'consume', '2026-07-17T10:00:00.000Z',
    );
    const consumed = await runReleased(retry);
    assert.equal(consumed.error, undefined);
    assert.equal(consumed.result.kind, 'consumed');
    state = readRelationalCaptureState(root);
    assert.equal(state.steps.length, 1);
    assert.equal(state.decisions[0].winner_kind, 'generic-consumption');
    assert.equal(state.authority.active_command_sha256, null);
  });

test('D3 exact publication retry and valid next allocation succeed from real children',
  { timeout: 15_000 }, async (t) => {
    const root = await fixture(t);
    const observedAt = '2026-07-17T10:00:00.000Z';
    assert.equal((await runPublisher(root, observedAt)).result.kind, 'published');
    const initialConsumer = spawnCommandPublicationRole(t, root, 'consume', observedAt);
    assert.equal((await runReleased(initialConsumer)).result.kind, 'consumed');

    const retry = spawnCommandPublicationRole(t, root, 'publish-prepared', observedAt);
    const allocator = spawnCommandPublicationRole(t, root, 'allocate', observedAt);
    await Promise.all([retry.ready, allocator.ready]);
    retry.release();
    allocator.release();
    const [retried, allocated] = await Promise.all([retry.result, allocator.result]);

    assert.equal(retried.error, undefined);
    assert.equal(retried.result.kind, 'already-published');
    assert.equal(allocated.error, undefined);
    assert.equal(allocated.result.kind, 'allocated');
    assert.equal(allocated.result.command.command.expectedSequence, 2);
    const state = readRelationalCaptureState(root);
    assert.equal(state.steps.length, 1);
    assert.equal(state.decisions[0].winner_kind, 'generic-consumption');
    assert.equal(state.commands.length, 2);
    assert.equal(state.authority.active_command_sha256, state.commands[1].command_sha256);
  });

test('D3 publication retries preserve selected ordinary and generic result unions',
  { timeout: 15_000 }, async (t) => {
    for (const winner of ['ordinary', 'generic-consumption']) {
      const root = await fixture(t);
      const observedAt = '2026-07-17T10:00:00.000Z';
      assert.equal((await runPublisher(root, observedAt)).result.kind, 'published');
      const selector = spawnCommandPublicationRole(
        t,
        root,
        winner === 'ordinary' ? 'transition' : 'consume',
        observedAt,
      );
      const selected = await runReleased(selector);
      assert.equal(selected.error, undefined, winner);
      assert.equal(
        selected.result.kind,
        winner === 'ordinary' ? 'transitioned' : 'consumed',
        winner,
      );

      const retry = spawnCommandPublicationRole(
        t, root, 'publish-prepared', observedAt,
      );
      const loser = spawnCommandPublicationRole(
        t,
        root,
        winner === 'ordinary' ? 'consume-prepared' : 'transition',
        observedAt,
      );
      await Promise.all([retry.ready, loser.ready]);
      retry.release();
      loser.release();
      const [retried, classified] = await Promise.all([retry.result, loser.result]);

      assert.equal(retried.error, undefined, winner);
      assert.equal(retried.result.kind, 'already-published', winner);
      assert.equal(classified.error, undefined, winner);
      assert.equal(
        classified.result.kind,
        winner === 'ordinary' ? 'ordinary-selected' : 'generic-consumed',
        winner,
      );
      const state = readRelationalCaptureState(root);
      assert.equal(state.steps.length, 1, winner);
      assert.equal(state.decisions.length, 1, winner);
      assert.equal(state.decisions[0].winner_kind, winner, winner);
    }
  });

test('D3 real controller adopts or consumes across both publication-transition orderings',
  { timeout: 15_000 }, async (t) => {
    for (const order of ['successor-first', 'publication-first']) {
      const root = await fixture(t);
      const observedAt = '2026-07-17T10:00:00.000Z';
      assert.deepEqual(await runPublisher(root, observedAt, 'seed-only'), { seeded: true });
      const launchIntent = spawnCommandPublicationRole(t, root, 'transition', observedAt);
      assert.equal((await runReleased(launchIntent)).result.kind, 'transitioned');

      const controller = spawnStoreBackedPublicationRace(t, root);
      const launchCompletion = await controller.barriers['launch-completion'];
      assert.equal(launchCompletion.value.state, 'launching', order);
      const restart = spawnCommandPublicationRole(
        t, root, 'transition-restart', observedAt,
      );
      assert.equal((await runReleased(restart)).result.kind, 'transitioned');
      controller.release('launch-completion');

      const publication = await controller.barriers.publication;
      assert.equal(publication.value.state, 'restart-required', order);
      if (order === 'successor-first') {
        const successor = spawnCommandPublicationRole(
          t, root, 'transition-launched', observedAt,
        );
        assert.equal((await runReleased(successor)).result.kind, 'transitioned');
        controller.release('publication');
      } else {
        controller.release('publication');
        await controller.barriers.consumption;
        const successor = spawnCommandPublicationRole(
          t, root, 'transition-launched', observedAt,
        );
        assert.equal((await runReleased(successor)).result.kind, 'transitioned');
        controller.release('consumption');
      }
      if (order === 'successor-first') {
        const progress = await Promise.race([
          controller.barriers.consumption.then((value) => ({ kind: 'barrier', value })),
          controller.result.then((value) => ({ kind: 'result', value })),
        ]);
        assert.equal(progress.kind, 'barrier', progress.value?.error?.message ?? order);
        const consumption = progress.value;
        assert.equal(consumption.value.state, 'launched', order);
        controller.release('consumption');
      }

      const outcome = await controller.result;
      assert.equal(outcome.error, undefined, order);
      assert.equal(outcome.observation.sequence, 1, order);
      const state = readRelationalCaptureState(root);
      assert.equal(state.steps.length, 1, order);
      assert.equal(state.authority.active_command_sha256, null, order);
      assert.deepEqual(state.decisions.map(({ source_state, winner_kind, next_state }) => ({
        source_state, winner_kind, next_state,
      })), [
        {
          source_state: 'launched',
          winner_kind: 'generic-consumption',
          next_state: null,
        },
        {
          source_state: 'launching',
          winner_kind: 'ordinary',
          next_state: 'restart-required',
        },
        {
          source_state: 'prepared',
          winner_kind: 'ordinary',
          next_state: 'launching',
        },
        {
          source_state: 'restart-required',
          winner_kind: 'ordinary',
          next_state: 'launched',
        },
      ], order);
    }
  });
