import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function fixture(t, label) {
  const root = await mkdtemp(join(tmpdir(), `b3-recovery-store-${label}-`));
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

async function run(root, mode) {
  const helper = new URL(
    './helpers/b3-capture-state-recovery-store-child.mjs',
    import.meta.url,
  );
  const { stdout } = await execFileAsync(process.execPath, [
    '--experimental-test-module-mocks', helper.pathname, mode,
  ], { cwd: root });
  return JSON.parse(stdout);
}

function spawnRecoveryHelper(root, captureId) {
  const helper = new URL(
    './helpers/b3-capture-state-recovery-race-child.mjs',
    import.meta.url,
  );
  const child = fork(helper.pathname, [captureId], {
    cwd: root,
    execArgv: ['--experimental-test-module-mocks'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  let readyResolve;
  let resultResolve;
  let resultReject;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const result = new Promise((resolve, reject) => {
    resultResolve = resolve;
    resultReject = reject;
  });
  child.on('message', (message) => {
    if (message?.type === 'ready') readyResolve();
    if (message?.type === 'result') resultResolve(message);
  });
  child.on('error', resultReject);
  child.on('exit', (code, signal) => {
    if (code && code !== 0) {
      resultReject(new Error(`recovery helper exited ${code ?? signal}: ${stderr}`));
    }
  });
  return Object.freeze({
    ready,
    result,
    go: () => child.send({ type: 'go' }),
  });
}

function spawnRecoveryCompetitionHelper(root, operation, captureId) {
  const helper = new URL(
    './helpers/b3-capture-state-recovery-competition-child.mjs',
    import.meta.url,
  );
  const child = fork(helper.pathname, [operation, captureId], {
    cwd: root,
    execArgv: ['--experimental-test-module-mocks'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  let readyResolve;
  let resultResolve;
  let resultReject;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const result = new Promise((resolve, reject) => {
    resultResolve = resolve;
    resultReject = reject;
  });
  child.on('message', (message) => {
    if (message?.type === 'ready') readyResolve(message);
    if (message?.type === 'result') resultResolve(message);
  });
  child.on('error', resultReject);
  child.on('exit', (code, signal) => {
    if (code && code !== 0) {
      resultReject(new Error(
        `recovery competition helper exited ${code ?? signal}: ${stderr}`,
      ));
    }
  });
  return Object.freeze({
    ready,
    result,
    go: () => child.send({ type: 'go' }),
  });
}

async function readActive(root) {
  const helper = new URL(
    './helpers/b3-capture-state-recovery-phase-child.mjs',
    import.meta.url,
  );
  const { stdout } = await execFileAsync(process.execPath, [
    '--experimental-test-module-mocks', helper.pathname, 'read-active', 'ios',
  ], { cwd: root });
  return JSON.parse(stdout);
}

test('unacknowledged exact restart-required lineage remains byte-stable and operator-required',
  async (t) => {
    const root = await fixture(t, 'operator-required');
    const result = await run(root, 'operator-required');
    assert.equal(result.ok, true, result.error?.message);
    assert.deepEqual(result.outcome, {
      status: 'operator-required',
      acknowledgementConsumed: false,
    });
    assert.equal(result.active.kind, 'active');
    assert.equal(result.active.command.state, 'restart-required');
    assert.equal(result.databaseIdentical, true);
  });

test('acknowledged restart-required lineage converges through archive, terminal and fresh start',
  async (t) => {
    const root = await fixture(t, 'recovered');
    const result = await run(root, 'recovered');
    assert.equal(result.ok, true, result.error?.message);
    assert.deepEqual(result.outcome, {
      status: 'recovered',
      acknowledgementConsumed: true,
    });
    assert.equal(result.active.kind, 'active');
    assert.equal(result.active.command.state, 'prepared');
    assert.equal(
      result.active.command.captureId,
      '018f1d7b-97e8-4a52-8cf2-783e5089c002',
    );
    assert.equal(result.active.command.allocationSequence, 2);
    assert.equal(result.active.command.command.expectedSequence, 1);
  });

test('an immediate pin after the durable fresh commit adopts it as already recovered',
  async (t) => {
    const root = await fixture(t, 'immediate-retry');
    const result = await run(root, 'immediate-retry');
    assert.equal(result.ok, true, result.error?.message);
    assert.deepEqual(result.outcome, {
      status: 'already-recovered',
      acknowledgementConsumed: true,
    });
    assert.equal(
      result.active.command.captureId,
      '018f1d7b-97e8-4a52-8cf2-783e5089c002',
    );
  });

test('direct-store distribution mismatch rejects with exact database bytes unchanged',
  async (t) => {
    const root = await fixture(t, 'invalid-distribution');
    const result = await run(root, 'invalid-distribution');
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(result.rejected.code, 'b3_capture_state_invalid');
    assert.match(result.rejected.message, /distribution|embedded/u);
    assert.equal(result.databaseIdentical, true);
    assert.equal(result.active.command.state, 'restart-required');
  });

test('direct-store missing distribution rejects before changing exact database bytes',
  async (t) => {
    const root = await fixture(t, 'missing-distribution');
    const result = await run(root, 'missing-distribution');
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(result.rejected.code, 'b3_capture_state_invalid');
    assert.match(result.rejected.message, /distribution/u);
    assert.equal(result.databaseIdentical, true);
    assert.equal(result.active.command.state, 'restart-required');
  });

test('ordinary restart launch winner prevents archive ownership without mutation',
  async (t) => {
    const root = await fixture(t, 'ordinary-first');
    const result = await run(root, 'ordinary-first');
    assert.equal(result.ok, true, result.error?.message);
    assert.deepEqual(result.outcome, {
      status: 'not-applicable',
      acknowledgementConsumed: false,
    });
    assert.equal(result.active.command.state, 'launched');
  });

test('an acknowledgement pinned before the restart gate cannot authorise that later gate',
  async (t) => {
    const root = await fixture(t, 'post-pin-gate');
    const result = await run(root, 'post-pin-gate');
    assert.equal(result.ok, true, result.error?.message);
    assert.deepEqual(result.outcome, {
      status: 'rejected',
      acknowledgementConsumed: false,
    });
    assert.equal(result.active.command.state, 'restart-required');
  });

test('an old pin follows its retained terminal after the fresh successor advances',
  async (t) => {
    const root = await fixture(t, 'stale-successor');
    const result = await run(root, 'stale-successor');
    assert.equal(result.ok, true, result.error?.message);
    assert.deepEqual(result.outcome, {
      status: 'already-recovered',
      acknowledgementConsumed: true,
    });
    assert.equal(result.active.command.state, 'launching');
    assert.equal(
      result.active.command.captureId,
      '018f1d7b-97e8-4a52-8cf2-783e5089c002',
    );
  });

test('recovery invocation pins are single-use and cannot cross stores', async (t) => {
  const doubleRoot = await fixture(t, 'double-use');
  const double = await run(doubleRoot, 'double-use');
  assert.equal(double.ok, true, double.error?.message);
  assert.equal(double.outcome.status, 'recovered');
  assert.equal(double.secondUse.code, 'b3_capture_state_invalid');
  assert.match(double.secondUse.message, /invocation pin/u);

  const crossRoot = await fixture(t, 'cross-store');
  const cross = await run(crossRoot, 'cross-store');
  assert.equal(cross.ok, true, cross.error?.message);
  assert.equal(cross.rejected.code, 'b3_capture_state_invalid');
  assert.match(cross.rejected.message, /invocation pin/u);

  const forgedRoot = await fixture(t, 'forged-pin');
  const forged = await run(forgedRoot, 'forged-pin');
  assert.equal(forged.ok, true, forged.error?.message);
  assert.equal(forged.rejected.code, 'b3_capture_state_invalid');
  assert.match(forged.rejected.message, /invocation pin/u);
});

for (const [phase, expectedStatus, acknowledgementConsumed] of [
  ['archive', 'recovered', false],
  ['terminal', 'already-recovered', false],
  ['fresh', 'already-recovered', true],
]) {
  test(`a durable ${phase} phase reopens and converges through the same store facade`,
    async (t) => {
      const root = await fixture(t, `resume-${phase}`);
      const result = await run(root, `resume-${phase}`);
      assert.equal(result.ok, true, result.error?.message);
      assert.deepEqual(result.outcome, { status: expectedStatus, acknowledgementConsumed });
      assert.equal(result.active.kind, 'active');
      assert.equal(result.active.command.state, 'prepared');
      assert.equal(
        result.active.command.captureId,
        phase === 'archive'
          ? '018f1d7b-97e8-4a52-8cf2-783e5089c003'
          : '018f1d7b-97e8-4a52-8cf2-783e5089c002',
      );
    });
}

test('two real helpers with different fresh UUIDs converge on one retained successor',
  async (t) => {
    const root = await fixture(t, 'duplicate-helpers');
    const seeded = await run(root, 'operator-required');
    assert.equal(seeded.outcome.status, 'operator-required');
    const candidates = [
      '018f1d7b-97e8-4a52-8cf2-783e5089c002',
      '018f1d7b-97e8-4a52-8cf2-783e5089c003',
    ];
    const helpers = candidates.map((captureId) => spawnRecoveryHelper(root, captureId));
    await Promise.all(helpers.map((helper) => helper.ready));
    helpers.forEach((helper) => helper.go());
    const results = await Promise.all(helpers.map((helper) => helper.result));
    for (const result of results) {
      assert.equal(result.ok, true, result.error?.message);
      assert.ok(['recovered', 'already-recovered'].includes(result.outcome.status));
    }
    const retained = await readActive(root);
    assert.equal(retained.ok, true, retained.error?.message);
    assert.equal(retained.result.kind, 'active');
    assert.ok(candidates.includes(retained.result.command.captureId));
    assert.equal(retained.result.command.allocationSequence, 2);
  });

test('ordinary transition and recovery owner converge in both deterministic lock orders',
  async (t) => {
    for (const winner of ['ordinary', 'recovery']) {
      const root = await fixture(t, `ordinary-recovery-${winner}`);
      const seeded = await run(root, 'operator-required');
      assert.equal(seeded.outcome.status, 'operator-required');
      const ordinary = spawnRecoveryCompetitionHelper(
        root,
        'ordinary',
        '018f1d7b-97e8-4a52-8cf2-783e5089c003',
      );
      const recovery = spawnRecoveryCompetitionHelper(
        root,
        'recovery',
        '018f1d7b-97e8-4a52-8cf2-783e5089c002',
      );
      await Promise.all([ordinary.ready, recovery.ready]);
      const first = winner === 'ordinary' ? ordinary : recovery;
      const second = winner === 'ordinary' ? recovery : ordinary;
      first.go();
      const firstResult = await first.result;
      second.go();
      const secondResult = await second.result;
      assert.equal(firstResult.ok, true, firstResult.error?.message);
      assert.equal(secondResult.ok, true, secondResult.error?.message);

      const retained = await readActive(root);
      assert.equal(retained.ok, true, retained.error?.message);
      assert.equal(retained.result.kind, 'active');
      if (winner === 'ordinary') {
        assert.equal(firstResult.outcome.status, 'transitioned');
        assert.equal(secondResult.outcome.status, 'not-applicable');
        assert.equal(retained.result.command.state, 'launched');
        assert.equal(
          retained.result.command.captureId,
          '018f1d7b-97e8-4a52-8cf2-783e5089c001',
        );
      } else {
        assert.equal(firstResult.outcome.status, 'recovered');
        assert.equal(secondResult.outcome.status, 'rejected');
        assert.equal(secondResult.rejection.code, 'b3_capture_state_invalid');
        assert.equal(secondResult.databaseIdentical, true);
        assert.equal(retained.result.command.state, 'prepared');
        assert.equal(
          retained.result.command.captureId,
          '018f1d7b-97e8-4a52-8cf2-783e5089c002',
        );
      }
    }
  });

test('normal allocator and recovery reservation converge in both deterministic lock orders',
  async (t) => {
    for (const firstOperation of ['allocator', 'recovery']) {
      const root = await fixture(t, `allocator-recovery-${firstOperation}`);
      const seeded = await run(root, 'operator-required');
      assert.equal(seeded.outcome.status, 'operator-required');
      const allocator = spawnRecoveryCompetitionHelper(
        root,
        'allocator',
        '018f1d7b-97e8-4a52-8cf2-783e5089c003',
      );
      const recovery = spawnRecoveryCompetitionHelper(
        root,
        'recovery',
        '018f1d7b-97e8-4a52-8cf2-783e5089c002',
      );
      await Promise.all([allocator.ready, recovery.ready]);
      const first = firstOperation === 'allocator' ? allocator : recovery;
      const second = firstOperation === 'allocator' ? recovery : allocator;
      first.go();
      const firstResult = await first.result;
      second.go();
      const secondResult = await second.result;
      assert.equal(firstResult.ok, true, firstResult.error?.message);
      assert.equal(secondResult.ok, true, secondResult.error?.message);
      const allocatorResult = firstOperation === 'allocator'
        ? firstResult
        : secondResult;
      const recoveryResult = firstOperation === 'recovery'
        ? firstResult
        : secondResult;
      assert.equal(allocatorResult.outcome.status, 'rejected');
      assert.equal(allocatorResult.rejection.code, 'b3_capture_state_invalid');
      assert.equal(allocatorResult.databaseIdentical, true);
      assert.equal(recoveryResult.outcome.status, 'recovered');
      const retained = await readActive(root);
      assert.equal(retained.ok, true, retained.error?.message);
      assert.equal(retained.result.kind, 'active');
      assert.equal(retained.result.command.captureId,
        '018f1d7b-97e8-4a52-8cf2-783e5089c002');
      assert.equal(retained.result.command.state, 'prepared');
    }
  });

for (const [phase, expectedStatus, retainedCaptureId] of [
  ['archive', 'recovered', '018f1d7b-97e8-4a52-8cf2-783e5089c003'],
  ['fresh', 'already-recovered', '018f1d7b-97e8-4a52-8cf2-783e5089c002'],
]) {
  test(`an unacknowledged old pin converges after another helper commits ${phase}`,
    async (t) => {
      const root = await fixture(t, `stale-unack-${phase}`);
      const result = await run(root, `stale-unack-after-${phase}`);
      assert.equal(result.ok, true, result.error?.message);
      assert.deepEqual(result.outcome, {
        status: expectedStatus,
        acknowledgementConsumed: false,
      });
      assert.equal(result.active.kind, 'active');
      assert.equal(result.active.command.captureId, retainedCaptureId);
      assert.equal(result.active.command.state, 'prepared');
    });
}

test('an old pin remains already recovered after successor transition, consumption and allocation',
  async (t) => {
    const root = await fixture(t, 'stale-successor-full');
    const result = await run(root, 'stale-successor-full');
    assert.equal(result.ok, true, result.error?.message);
    assert.deepEqual(result.outcome, {
      status: 'already-recovered',
      acknowledgementConsumed: true,
    });
    assert.equal(result.active.kind, 'active');
    assert.equal(result.active.command.captureId,
      '018f1d7b-97e8-4a52-8cf2-783e5089c002');
    assert.equal(result.active.command.state, 'prepared');
    assert.equal(result.active.command.command.expectedSequence, 2);
    assert.equal(result.active.command.allocationSequence, 3);
  });

for (const [phase, expectedStatus, retainedCaptureId] of [
  ['archive', 'recovered', '018f1d7b-97e8-4a52-8cf2-783e5089c003'],
  ['terminal', 'already-recovered', '018f1d7b-97e8-4a52-8cf2-783e5089c002'],
]) {
  test(`normal allocation cannot overtake the ${phase} recovery reservation`,
    async (t) => {
      const root = await fixture(t, `reservation-allocator-${phase}`);
      const result = await run(root, `reservation-allocator-${phase}`);
      assert.equal(result.ok, true, result.error?.message);
      assert.equal(result.allocationRejected.code, 'b3_capture_state_invalid');
      assert.equal(result.databaseIdentical, true);
      assert.deepEqual(result.outcome, {
        status: expectedStatus,
        acknowledgementConsumed: false,
      });
      assert.equal(result.active.command.captureId, retainedCaptureId);
    });
}

test('archived existing observation retries preserve identical and conflict ordering',
  async (t) => {
    const root = await fixture(t, 'archived-publication-retries');
    const result = await run(root, 'archived-publication-retries');
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(result.identical.kind, 'already-published');
    assert.equal(result.conflict.kind, 'publication-conflict');
    assert.equal(result.databaseIdentical, true);
    assert.equal(result.active.kind, 'recovery-pending');
  });

test('public start rejects the exact retained recovery-fresh command after terminal commit',
  async (t) => {
    const root = await fixture(t, 'public-start-terminal');
    const result = await run(root, 'public-start-terminal');
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(result.rejected.code, 'b3_capture_state_invalid');
    assert.equal(result.databaseIdentical, true);
    assert.deepEqual(result.outcome, {
      status: 'already-recovered',
      acknowledgementConsumed: false,
    });
    assert.equal(result.active.command.captureId,
      '018f1d7b-97e8-4a52-8cf2-783e5089c002');
  });

test('archive-only state has no working read and rejects every normal missing-step mutator',
  async (t) => {
    const root = await fixture(t, 'archive-boundaries');
    const result = await run(root, 'archive-boundaries');
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(result.active.kind, 'recovery-pending');
    assert.equal(result.readRejected.code, 'b3_capture_state_invalid');
    assert.match(result.readRejected.message, /no readable working capture/u);
    assert.deepEqual(
      result.mutators.map(({ operation, rejected, databaseIdentical }) => ({
        operation,
        code: rejected.code,
        databaseIdentical,
      })),
      ['start', 'allocate', 'transition', 'publish', 'consume'].map((operation) => ({
        operation,
        code: 'b3_capture_state_invalid',
        databaseIdentical: true,
      })),
    );
  });

test('working capture read exposes only the recovery-fresh capture, never abandoned rows',
  async (t) => {
    const root = await fixture(t, 'fresh-working-read');
    const result = await run(root, 'fresh-working-read');
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(result.capture.captureId,
      '018f1d7b-97e8-4a52-8cf2-783e5089c002');
    assert.deepEqual(result.capture.records, []);
    assert.equal(result.capture.checkpoint, null);
  });
