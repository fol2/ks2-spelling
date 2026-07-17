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
        if (lock.isTransaction) lock.exec('COMMIT');
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
      lock.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
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
