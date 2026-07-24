import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

import { canonicaliseB3ProofValue } from '../src/app/b3-live-proof-protocol.js';
import {
  createB3InitialCaptureStartAuthority,
  createB3RecoveryFreshCaptureStartAuthority,
} from '../scripts/lib/b3-capture-start-authority.mjs';
import {
  createB3CaptureSnapshotAuthority,
  createB3RecoveryArchiveAuthority,
  createB3RecoveryManifestAuthority,
  createB3RecoveryOwnerClaimAuthority,
  createB3RecoveryTerminalAuthority,
} from '../scripts/lib/b3-capture-recovery-authority.mjs';
import {
  createB3GenericConsumptionClaimAuthority,
  createB3IssuedCommandStateAuthority,
  createB3OrdinaryIssuedCommandClaimAuthority,
  createB3PreparedIssuedCommandAuthority,
} from '../scripts/lib/b3-issued-command-authority.mjs';

const execFileAsync = promisify(execFile);
const COMMIT = '1'.repeat(40);
const FINGERPRINT = '2'.repeat(64);
const CAPTURE_ID = '018f1d7b-97e8-4a52-8cf2-783e5089c001';
const BUILD = Object.freeze({
  testedApplicationCommit: COMMIT,
  applicationFingerprint: FINGERPRINT,
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalBytes(value) {
  return Buffer.from(canonicaliseB3ProofValue(value), 'utf8');
}

function startCommand(captureId = CAPTURE_ID) {
  const unsigned = {
    schemaVersion: 1,
    captureId,
    platform: 'ios-physical',
    testedApplicationCommit: COMMIT,
    applicationFingerprint: FINGERPRINT,
    expectedScenarioIndex: 0,
    expectedSequence: 1,
    previousObservationSha256: '0'.repeat(64),
    installationMode: 'existing',
    actionCode: 'ARM_CAPTURE',
  };
  return Object.freeze({
    ...unsigned,
    challengeSha256: sha256(Buffer.from(
      `ks2-spelling:b3-host-command-challenge:v1\0${canonicaliseB3ProofValue(unsigned)}`,
      'utf8',
    )),
  });
}

function captureCommand({ captureId = CAPTURE_ID, sequence, previousObservationSha256 }) {
  const unsigned = {
    schemaVersion: 1,
    captureId,
    platform: 'ios-physical',
    testedApplicationCommit: COMMIT,
    applicationFingerprint: FINGERPRINT,
    expectedScenarioIndex: 0,
    expectedSequence: sequence,
    previousObservationSha256,
    installationMode: 'existing',
    actionCode: 'ARM_CAPTURE',
  };
  return Object.freeze({
    ...unsigned,
    challengeSha256: sha256(Buffer.from(
      `ks2-spelling:b3-host-command-challenge:v1\0${canonicaliseB3ProofValue(unsigned)}`,
      'utf8',
    )),
  });
}

async function fixture(t, label) {
  const root = await mkdtemp(join(tmpdir(), `b3-recovery-database-${label}-`));
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

async function probe(root, mode = 'read-active') {
  const helper = new URL(
    './helpers/b3-capture-state-recovery-phase-child.mjs',
    import.meta.url,
  );
  const { stdout } = await execFileAsync(process.execPath, [
    '--experimental-test-module-mocks', helper.pathname, mode, 'ios',
  ], { cwd: root });
  return JSON.parse(stdout);
}

async function seedPublishedObservation(root) {
  const helper = new URL('./helpers/b3-capture-state-publisher-child.mjs', import.meta.url);
  const { stdout } = await execFileAsync(process.execPath, [
    '--experimental-test-module-mocks',
    helper.pathname,
    'publish',
    '2026-07-17T10:00:00.000Z',
  ], { cwd: root });
  const result = JSON.parse(stdout);
  assert.equal(result.result?.kind, 'published', result.error?.message);
}

async function publishExisting(root, source, observationBytes) {
  const helper = new URL(
    './helpers/b3-capture-state-recovery-phase-child.mjs',
    import.meta.url,
  );
  const { stdout } = await execFileAsync(process.execPath, [
    '--experimental-test-module-mocks',
    helper.pathname,
    'publish-existing',
    'ios',
    Buffer.from(JSON.stringify(source), 'utf8').toString('base64url'),
    Buffer.from(observationBytes).toString('base64url'),
  ], { cwd: root });
  return JSON.parse(stdout);
}

function databasePath(root) {
  return join(
    root, '.native-build', 'b3', 'evidence',
    'ios-capture-state', 'recovery.sqlite',
  );
}

async function databaseSha256(root) {
  return sha256(await readFile(databasePath(root)));
}

function insertDecision(database, { source, nextState }) {
  const next = createB3IssuedCommandStateAuthority({
    platform: 'ios', command: source.command, state: nextState,
  });
  const claim = createB3OrdinaryIssuedCommandClaimAuthority({
    platform: 'ios', source, nextState,
  });
  database.prepare(`
    INSERT INTO b3_decisions (
      command_sha256, source_state, source_record_sha256, winner_kind,
      next_state, next_record_json, next_record_sha256, claim_json, claim_sha256
    ) VALUES (?, ?, ?, 'ordinary', ?, ?, ?, ?, ?)
  `).run(
    source.commandSha256,
    source.state,
    source.recordSha256,
    next.state,
    canonicalBytes(next),
    next.recordSha256,
    canonicalBytes(claim),
    claim.claimSha256,
  );
  return Object.freeze({ source, next, claim });
}

function seedArchivedRecovery(database) {
  const command = startCommand();
  const start = createB3InitialCaptureStartAuthority({
    platform: 'ios', command, buildAuthority: BUILD,
  });
  const prepared = createB3PreparedIssuedCommandAuthority({
    platform: 'ios', command,
  });
  database.prepare(`
    INSERT INTO b3_capture_start_intents (
      start_intent_sha256, intent_kind, recovered_command_sha256,
      terminal_claim_sha256, capture_id, first_command_sha256,
      first_command_json, first_prepared_record_json,
      first_prepared_record_sha256, intent_state, row_version
    ) VALUES (?, 'initial', NULL, NULL, ?, ?, ?, ?, ?, 'ready', 2)
  `).run(
    start.startIntentSha256,
    start.captureId,
    start.firstCommandSha256,
    start.commandBytes,
    start.preparedRecordBytes,
    start.firstPreparedRecordSha256,
  );
  database.prepare(`
    INSERT INTO b3_captures (
      capture_id, start_intent_sha256, capture_state, row_version
    ) VALUES (?, ?, 'abandoned', 2)
  `).run(start.captureId, start.startIntentSha256);
  database.prepare(`
    INSERT INTO b3_commands (
      command_sha256, allocation_sequence, predecessor_command_sha256,
      command_json, prepared_record_json, prepared_record_sha256, capture_id,
      expected_observation_sequence, previous_observation_sha256
    ) VALUES (?, 1, NULL, ?, ?, ?, ?, 1, ?)
  `).run(
    prepared.commandSha256,
    start.commandBytes,
    start.preparedRecordBytes,
    prepared.recordSha256,
    start.captureId,
    '0'.repeat(64),
  );

  const launching = insertDecision(database, {
    source: prepared,
    nextState: 'launching',
  }).next;
  const restartRequired = insertDecision(database, {
    source: launching,
    nextState: 'restart-required',
  }).next;
  const owner = createB3RecoveryOwnerClaimAuthority({
    platform: 'ios', source: restartRequired,
  });
  database.prepare(`
    INSERT INTO b3_decisions (
      command_sha256, source_state, source_record_sha256, winner_kind,
      next_state, next_record_json, next_record_sha256, claim_json, claim_sha256
    ) VALUES (?, 'restart-required', ?, 'recovery-owner',
      'restart-executing', ?, ?, ?, ?)
  `).run(
    restartRequired.commandSha256,
    restartRequired.recordSha256,
    owner.nextRecordBytes,
    owner.nextRecordSha256,
    owner.claimBytes,
    owner.ownerClaimSha256,
  );
  const snapshot = createB3CaptureSnapshotAuthority({
    platform: 'ios',
    captureId: start.captureId,
    startIntentSha256: start.startIntentSha256,
    captureState: 'abandoned',
    captureRowVersion: 2,
    testedApplicationCommit: COMMIT,
    applicationFingerprint: FINGERPRINT,
    commands: [{
      allocationSequence: 1,
      commandSha256: prepared.commandSha256,
      predecessorCommandSha256: null,
      commandJsonSha256: sha256(start.commandBytes),
      preparedRecordSha256: prepared.recordSha256,
      expectedObservationSequence: 1,
      previousObservationSha256: '0'.repeat(64),
    }],
    decisions: database.prepare(`
      SELECT command_sha256 AS commandSha256,
        source_state AS sourceState,
        source_record_sha256 AS sourceRecordSha256,
        winner_kind AS winnerKind,
        next_state AS nextState,
        next_record_sha256 AS nextRecordSha256,
        claim_sha256 AS claimSha256
      FROM b3_decisions
      ORDER BY command_sha256, source_state
    `).all(),
    steps: [],
  });
  const manifest = createB3RecoveryManifestAuthority({
    platform: 'ios',
    captureId: start.captureId,
    commandSha256: prepared.commandSha256,
    ownerClaimSha256: owner.ownerClaimSha256,
    captureSnapshotSha256: snapshot.captureSnapshotSha256,
    observationCount: 0,
    terminalObservationSha256: '0'.repeat(64),
  });
  const archive = createB3RecoveryArchiveAuthority({
    platform: 'ios',
    captureId: start.captureId,
    commandSha256: prepared.commandSha256,
    ownerClaimSha256: owner.ownerClaimSha256,
    captureSnapshotSha256: snapshot.captureSnapshotSha256,
    manifestSha256: manifest.manifestSha256,
    testedApplicationCommit: COMMIT,
    applicationFingerprint: FINGERPRINT,
  });
  database.prepare(`
    INSERT INTO b3_recoveries (
      command_sha256, owner_kind, owner_claim_sha256, capture_id,
      capture_snapshot_sha256, row_version
    ) VALUES (?, 'recovery-owner', ?, ?, ?, 1)
  `).run(
    prepared.commandSha256,
    owner.ownerClaimSha256,
    start.captureId,
    snapshot.captureSnapshotSha256,
  );
  database.prepare(`
    INSERT INTO b3_recovery_manifests (
      command_sha256, owner_claim_sha256, capture_snapshot_sha256,
      manifest_json, manifest_sha256
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    prepared.commandSha256,
    owner.ownerClaimSha256,
    snapshot.captureSnapshotSha256,
    manifest.manifestBytes,
    manifest.manifestSha256,
  );
  database.prepare(`
    INSERT INTO b3_recovery_authorities (
      command_sha256, owner_claim_sha256, capture_snapshot_sha256,
      manifest_sha256, authority_json, authority_sha256
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    prepared.commandSha256,
    owner.ownerClaimSha256,
    snapshot.captureSnapshotSha256,
    manifest.manifestSha256,
    archive.authorityBytes,
    archive.archiveAuthoritySha256,
  );
  database.prepare(`
    UPDATE b3_authority_state
    SET next_allocation_sequence = 2,
      active_command_sha256 = NULL,
      reserved_start_command_sha256 = NULL,
      row_version = 4
    WHERE singleton = 1
  `).run();
  return Object.freeze({ start, prepared, owner, snapshot, manifest, archive });
}

function seedTerminalPending(database, archived, freshCaptureId, { reserve = true } = {}) {
  const terminal = createB3RecoveryTerminalAuthority({
    platform: 'ios',
    source: archived.owner.nextRecord,
    ownerClaimSha256: archived.owner.ownerClaimSha256,
    captureSnapshotSha256: archived.snapshot.captureSnapshotSha256,
    manifestSha256: archived.manifest.manifestSha256,
    archiveAuthoritySha256: archived.archive.archiveAuthoritySha256,
  });
  database.prepare(`
    INSERT INTO b3_decisions (
      command_sha256, source_state, source_record_sha256, winner_kind,
      next_state, next_record_json, next_record_sha256, claim_json, claim_sha256
    ) VALUES (?, 'restart-executing', ?, 'recovery-terminal',
      'restart-complete', ?, ?, ?, ?)
  `).run(
    archived.prepared.commandSha256,
    archived.owner.nextRecordSha256,
    terminal.terminalRecordBytes,
    terminal.terminalRecordSha256,
    terminal.terminalClaimBytes,
    terminal.terminalClaimSha256,
  );
  database.prepare(`
    INSERT INTO b3_recovery_terminals (
      command_sha256, owner_claim_sha256, capture_snapshot_sha256,
      manifest_sha256, authority_sha256, terminal_kind,
      terminal_record_json, terminal_record_sha256,
      terminal_claim_json, terminal_claim_sha256
    ) VALUES (?, ?, ?, ?, ?, 'recovery-terminal', ?, ?, ?, ?)
  `).run(
    archived.prepared.commandSha256,
    archived.owner.ownerClaimSha256,
    archived.snapshot.captureSnapshotSha256,
    archived.manifest.manifestSha256,
    archived.archive.archiveAuthoritySha256,
    terminal.terminalRecordBytes,
    terminal.terminalRecordSha256,
    terminal.terminalClaimBytes,
    terminal.terminalClaimSha256,
  );
  if (!reserve) return Object.freeze({ terminal, fresh: null });
  const fresh = createB3RecoveryFreshCaptureStartAuthority({
    platform: 'ios',
    command: startCommand(freshCaptureId),
    buildAuthority: BUILD,
    recoveredCommandSha256: archived.prepared.commandSha256,
    terminalClaimSha256: terminal.terminalClaimSha256,
  });
  database.prepare(`
    INSERT INTO b3_capture_start_intents (
      start_intent_sha256, intent_kind, recovered_command_sha256,
      terminal_claim_sha256, capture_id, first_command_sha256,
      first_command_json, first_prepared_record_json,
      first_prepared_record_sha256, intent_state, row_version
    ) VALUES (?, 'recovery-fresh', ?, ?, ?, ?, ?, ?, ?, 'pending', 1)
  `).run(
    fresh.startIntentSha256,
    fresh.recoveredCommandSha256,
    fresh.terminalClaimSha256,
    fresh.captureId,
    fresh.firstCommandSha256,
    fresh.commandBytes,
    fresh.preparedRecordBytes,
    fresh.firstPreparedRecordSha256,
  );
  database.prepare(`
    UPDATE b3_authority_state
    SET reserved_start_command_sha256 = ?, row_version = row_version + 1
    WHERE singleton = 1 AND active_command_sha256 IS NULL
      AND reserved_start_command_sha256 IS NULL
  `).run(fresh.firstCommandSha256);
  return Object.freeze({ terminal, fresh });
}

function reconcileFresh(database, archived, pending) {
  const { fresh } = pending;
  const authority = database.prepare('SELECT * FROM b3_authority_state').get();
  database.prepare(`
    INSERT INTO b3_captures (
      capture_id, start_intent_sha256, capture_state, row_version
    ) VALUES (?, ?, 'working', 1)
  `).run(fresh.captureId, fresh.startIntentSha256);
  database.prepare(`
    INSERT INTO b3_commands (
      command_sha256, allocation_sequence, predecessor_command_sha256,
      command_json, prepared_record_json, prepared_record_sha256, capture_id,
      expected_observation_sequence, previous_observation_sha256
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    fresh.firstCommandSha256,
    authority.next_allocation_sequence,
    archived.prepared.commandSha256,
    fresh.commandBytes,
    fresh.preparedRecordBytes,
    fresh.firstPreparedRecordSha256,
    fresh.captureId,
    '0'.repeat(64),
  );
  database.prepare(`
    UPDATE b3_capture_start_intents
    SET intent_state = 'ready', row_version = 2
    WHERE start_intent_sha256 = ? AND intent_state = 'pending' AND row_version = 1
  `).run(fresh.startIntentSha256);
  database.prepare(`
    UPDATE b3_authority_state
    SET next_allocation_sequence = next_allocation_sequence + 1,
      active_command_sha256 = ?, reserved_start_command_sha256 = NULL,
      row_version = row_version + 1
    WHERE singleton = 1 AND active_command_sha256 IS NULL
      AND reserved_start_command_sha256 = ?
  `).run(fresh.firstCommandSha256, fresh.firstCommandSha256);
  return Object.freeze({
    start: fresh,
    prepared: createB3PreparedIssuedCommandAuthority({
      platform: 'ios', command: fresh.firstCommand,
    }),
  });
}

function archiveExistingWorking(database, working) {
  const launching = insertDecision(database, {
    source: working.prepared,
    nextState: 'launching',
  }).next;
  const restartRequired = insertDecision(database, {
    source: launching,
    nextState: 'restart-required',
  }).next;
  const owner = createB3RecoveryOwnerClaimAuthority({
    platform: 'ios', source: restartRequired,
  });
  database.prepare(`
    INSERT INTO b3_decisions (
      command_sha256, source_state, source_record_sha256, winner_kind,
      next_state, next_record_json, next_record_sha256, claim_json, claim_sha256
    ) VALUES (?, 'restart-required', ?, 'recovery-owner',
      'restart-executing', ?, ?, ?, ?)
  `).run(
    working.prepared.commandSha256,
    restartRequired.recordSha256,
    owner.nextRecordBytes,
    owner.nextRecordSha256,
    owner.claimBytes,
    owner.ownerClaimSha256,
  );
  database.prepare(`
    UPDATE b3_captures
    SET capture_state = 'abandoned', row_version = 2
    WHERE capture_id = ? AND capture_state = 'working' AND row_version = 1
  `).run(working.start.captureId);
  database.prepare(`
    UPDATE b3_authority_state
    SET active_command_sha256 = NULL, row_version = row_version + 1
    WHERE singleton = 1 AND active_command_sha256 = ?
      AND reserved_start_command_sha256 IS NULL
  `).run(working.prepared.commandSha256);
  const commands = database.prepare(`
    SELECT allocation_sequence AS allocationSequence,
      command_sha256 AS commandSha256,
      predecessor_command_sha256 AS predecessorCommandSha256,
      command_json, prepared_record_sha256 AS preparedRecordSha256,
      expected_observation_sequence AS expectedObservationSequence,
      previous_observation_sha256 AS previousObservationSha256
    FROM b3_commands WHERE capture_id = ? ORDER BY allocation_sequence
  `).all(working.start.captureId).map(({ command_json: commandJson, ...row }) => ({
    ...row,
    commandJsonSha256: sha256(commandJson),
  }));
  const decisions = database.prepare(`
    SELECT d.command_sha256 AS commandSha256,
      d.source_state AS sourceState,
      d.source_record_sha256 AS sourceRecordSha256,
      d.winner_kind AS winnerKind,
      d.next_state AS nextState,
      d.next_record_sha256 AS nextRecordSha256,
      d.claim_sha256 AS claimSha256
    FROM b3_decisions d
    JOIN b3_commands c ON c.command_sha256 = d.command_sha256
    WHERE c.capture_id = ? AND d.winner_kind != 'recovery-terminal'
    ORDER BY d.command_sha256, d.source_state
  `).all(working.start.captureId);
  const steps = database.prepare(`
    SELECT observation_sequence AS observationSequence,
      command_sha256 AS commandSha256, record_sha256 AS recordSha256,
      observation_sha256 AS observationSha256,
      checkpoint_sha256 AS checkpointSha256
    FROM b3_capture_steps WHERE capture_id = ? ORDER BY observation_sequence
  `).all(working.start.captureId);
  const snapshot = createB3CaptureSnapshotAuthority({
    platform: 'ios',
    captureId: working.start.captureId,
    startIntentSha256: working.start.startIntentSha256,
    captureState: 'abandoned',
    captureRowVersion: 2,
    testedApplicationCommit: COMMIT,
    applicationFingerprint: FINGERPRINT,
    commands,
    decisions,
    steps,
  });
  const manifest = createB3RecoveryManifestAuthority({
    platform: 'ios', captureId: working.start.captureId,
    commandSha256: working.prepared.commandSha256,
    ownerClaimSha256: owner.ownerClaimSha256,
    captureSnapshotSha256: snapshot.captureSnapshotSha256,
    observationCount: steps.length,
    terminalObservationSha256: steps.at(-1)?.observationSha256 ?? '0'.repeat(64),
  });
  const archive = createB3RecoveryArchiveAuthority({
    platform: 'ios', captureId: working.start.captureId,
    commandSha256: working.prepared.commandSha256,
    ownerClaimSha256: owner.ownerClaimSha256,
    captureSnapshotSha256: snapshot.captureSnapshotSha256,
    manifestSha256: manifest.manifestSha256,
    testedApplicationCommit: COMMIT,
    applicationFingerprint: FINGERPRINT,
  });
  database.prepare(`
    INSERT INTO b3_recoveries (
      command_sha256, owner_kind, owner_claim_sha256, capture_id,
      capture_snapshot_sha256, row_version
    ) VALUES (?, 'recovery-owner', ?, ?, ?, 1)
  `).run(
    working.prepared.commandSha256, owner.ownerClaimSha256,
    working.start.captureId, snapshot.captureSnapshotSha256,
  );
  database.prepare(`
    INSERT INTO b3_recovery_manifests (
      command_sha256, owner_claim_sha256, capture_snapshot_sha256,
      manifest_json, manifest_sha256
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    working.prepared.commandSha256, owner.ownerClaimSha256,
    snapshot.captureSnapshotSha256, manifest.manifestBytes,
    manifest.manifestSha256,
  );
  database.prepare(`
    INSERT INTO b3_recovery_authorities (
      command_sha256, owner_claim_sha256, capture_snapshot_sha256,
      manifest_sha256, authority_json, authority_sha256
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    working.prepared.commandSha256, owner.ownerClaimSha256,
    snapshot.captureSnapshotSha256, manifest.manifestSha256,
    archive.authorityBytes, archive.archiveAuthoritySha256,
  );
  return Object.freeze({ ...working, owner, snapshot, manifest, archive });
}

function seedMaximalArchivedRecovery(database) {
  const firstCommand = startCommand();
  const start = createB3InitialCaptureStartAuthority({
    platform: 'ios', command: firstCommand, buildAuthority: BUILD,
  });
  database.prepare(`
    INSERT INTO b3_capture_start_intents (
      start_intent_sha256, intent_kind, recovered_command_sha256,
      terminal_claim_sha256, capture_id, first_command_sha256,
      first_command_json, first_prepared_record_json,
      first_prepared_record_sha256, intent_state, row_version
    ) VALUES (?, 'initial', NULL, NULL, ?, ?, ?, ?, ?, 'ready', 2)
  `).run(
    start.startIntentSha256, start.captureId, start.firstCommandSha256,
    start.commandBytes, start.preparedRecordBytes,
    start.firstPreparedRecordSha256,
  );
  database.prepare(`
    INSERT INTO b3_captures (
      capture_id, start_intent_sha256, capture_state, row_version
    ) VALUES (?, ?, 'abandoned', 2)
  `).run(start.captureId, start.startIntentSha256);

  const insertCommand = database.prepare(`
    INSERT INTO b3_commands (
      command_sha256, allocation_sequence, predecessor_command_sha256,
      command_json, prepared_record_json, prepared_record_sha256, capture_id,
      expected_observation_sequence, previous_observation_sha256
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertGeneric = database.prepare(`
    INSERT INTO b3_decisions (
      command_sha256, source_state, source_record_sha256, winner_kind,
      next_state, next_record_json, next_record_sha256, claim_json, claim_sha256
    ) VALUES (?, 'prepared', ?, 'generic-consumption', NULL, NULL, NULL, ?, ?)
  `);
  const insertStep = database.prepare(`
    INSERT INTO b3_capture_steps (
      capture_id, observation_sequence, command_sha256,
      record_json, record_sha256, observation_sha256,
      checkpoint_json, checkpoint_sha256
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let predecessorCommandSha256 = null;
  let previousObservationSha256 = '0'.repeat(64);
  let tailPrepared;
  for (let sequence = 1; sequence <= 512; sequence += 1) {
    const command = sequence === 1
      ? firstCommand
      : captureCommand({ sequence, previousObservationSha256 });
    const prepared = createB3PreparedIssuedCommandAuthority({
      platform: 'ios', command,
    });
    insertCommand.run(
      prepared.commandSha256,
      sequence,
      predecessorCommandSha256,
      canonicalBytes(command),
      canonicalBytes(prepared),
      prepared.recordSha256,
      CAPTURE_ID,
      sequence,
      previousObservationSha256,
    );
    predecessorCommandSha256 = prepared.commandSha256;
    tailPrepared = prepared;
    if (sequence < 512) {
      const generic = createB3GenericConsumptionClaimAuthority({
        platform: 'ios', source: prepared,
      });
      insertGeneric.run(
        prepared.commandSha256,
        prepared.recordSha256,
        canonicalBytes(generic),
        generic.claimSha256,
      );
    }
    const recordBytes = canonicalBytes({ schemaVersion: 1, sequence });
    const checkpointBytes = canonicalBytes({ schemaVersion: 1, sequence, checkpoint: true });
    const observationSha256 = sha256(canonicalBytes({ sequence, observed: true }));
    insertStep.run(
      CAPTURE_ID,
      sequence,
      prepared.commandSha256,
      recordBytes,
      sha256(recordBytes),
      observationSha256,
      checkpointBytes,
      sha256(checkpointBytes),
    );
    previousObservationSha256 = observationSha256;
  }

  const launching = insertDecision(database, {
    source: tailPrepared, nextState: 'launching',
  }).next;
  const restartRequired = insertDecision(database, {
    source: launching, nextState: 'restart-required',
  }).next;
  const owner = createB3RecoveryOwnerClaimAuthority({
    platform: 'ios', source: restartRequired,
  });
  database.prepare(`
    INSERT INTO b3_decisions (
      command_sha256, source_state, source_record_sha256, winner_kind,
      next_state, next_record_json, next_record_sha256, claim_json, claim_sha256
    ) VALUES (?, 'restart-required', ?, 'recovery-owner',
      'restart-executing', ?, ?, ?, ?)
  `).run(
    tailPrepared.commandSha256,
    restartRequired.recordSha256,
    owner.nextRecordBytes,
    owner.nextRecordSha256,
    owner.claimBytes,
    owner.ownerClaimSha256,
  );
  database.prepare(`
    UPDATE b3_authority_state
    SET next_allocation_sequence = 513,
      active_command_sha256 = NULL,
      reserved_start_command_sha256 = NULL,
      row_version = 1026
    WHERE singleton = 1
  `).run();

  const commands = database.prepare(`
    SELECT allocation_sequence AS allocationSequence,
      command_sha256 AS commandSha256,
      predecessor_command_sha256 AS predecessorCommandSha256,
      command_json, prepared_record_sha256 AS preparedRecordSha256,
      expected_observation_sequence AS expectedObservationSequence,
      previous_observation_sha256 AS previousObservationSha256
    FROM b3_commands ORDER BY allocation_sequence
  `).all().map(({ command_json: commandJson, ...row }) => ({
    ...row, commandJsonSha256: sha256(commandJson),
  }));
  const decisions = database.prepare(`
    SELECT command_sha256 AS commandSha256, source_state AS sourceState,
      source_record_sha256 AS sourceRecordSha256, winner_kind AS winnerKind,
      next_state AS nextState, next_record_sha256 AS nextRecordSha256,
      claim_sha256 AS claimSha256
    FROM b3_decisions ORDER BY command_sha256, source_state
  `).all();
  const steps = database.prepare(`
    SELECT observation_sequence AS observationSequence,
      command_sha256 AS commandSha256, record_sha256 AS recordSha256,
      observation_sha256 AS observationSha256,
      checkpoint_sha256 AS checkpointSha256
    FROM b3_capture_steps ORDER BY observation_sequence
  `).all();
  const snapshot = createB3CaptureSnapshotAuthority({
    platform: 'ios', captureId: CAPTURE_ID,
    startIntentSha256: start.startIntentSha256,
    captureState: 'abandoned', captureRowVersion: 2,
    testedApplicationCommit: COMMIT, applicationFingerprint: FINGERPRINT,
    commands, decisions, steps,
  });
  const manifest = createB3RecoveryManifestAuthority({
    platform: 'ios', captureId: CAPTURE_ID,
    commandSha256: tailPrepared.commandSha256,
    ownerClaimSha256: owner.ownerClaimSha256,
    captureSnapshotSha256: snapshot.captureSnapshotSha256,
    observationCount: steps.length,
    terminalObservationSha256: steps.at(-1).observationSha256,
  });
  const archive = createB3RecoveryArchiveAuthority({
    platform: 'ios', captureId: CAPTURE_ID,
    commandSha256: tailPrepared.commandSha256,
    ownerClaimSha256: owner.ownerClaimSha256,
    captureSnapshotSha256: snapshot.captureSnapshotSha256,
    manifestSha256: manifest.manifestSha256,
    testedApplicationCommit: COMMIT, applicationFingerprint: FINGERPRINT,
  });
  database.prepare(`
    INSERT INTO b3_recoveries (
      command_sha256, owner_kind, owner_claim_sha256, capture_id,
      capture_snapshot_sha256, row_version
    ) VALUES (?, 'recovery-owner', ?, ?, ?, 1)
  `).run(
    tailPrepared.commandSha256, owner.ownerClaimSha256,
    CAPTURE_ID, snapshot.captureSnapshotSha256,
  );
  database.prepare(`
    INSERT INTO b3_recovery_manifests (
      command_sha256, owner_claim_sha256, capture_snapshot_sha256,
      manifest_json, manifest_sha256
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    tailPrepared.commandSha256, owner.ownerClaimSha256,
    snapshot.captureSnapshotSha256, manifest.manifestBytes,
    manifest.manifestSha256,
  );
  database.prepare(`
    INSERT INTO b3_recovery_authorities (
      command_sha256, owner_claim_sha256, capture_snapshot_sha256,
      manifest_sha256, authority_json, authority_sha256
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    tailPrepared.commandSha256, owner.ownerClaimSha256,
    snapshot.captureSnapshotSha256, manifest.manifestSha256,
    archive.authorityBytes, archive.archiveAuthoritySha256,
  );
  return Object.freeze({
    start,
    prepared: tailPrepared,
    owner,
    snapshot,
    manifest,
    archive,
  });
}

test('D4.2 validates an archived recovery as a closed recovery-pending phase',
  async (t) => {
    const root = await fixture(t, 'archived');
    assert.deepEqual(await probe(root), { ok: true, result: { kind: 'none' } });
    const database = new DatabaseSync(databasePath(root));
    try {
      database.exec('BEGIN IMMEDIATE');
      seedArchivedRecovery(database);
      database.exec('COMMIT');
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK');
      throw error;
    } finally {
      database.close();
    }

    assert.deepEqual(await probe(root), {
      ok: true,
      result: { kind: 'recovery-pending' },
    });
  });

test('D4.2 validates terminal reservation and a fresh working successor without snapshot drift',
  async (t) => {
    const root = await fixture(t, 'terminal-fresh');
    await probe(root);
    const database = new DatabaseSync(databasePath(root));
    let archived;
    let pending;
    try {
      database.exec('BEGIN IMMEDIATE');
      archived = seedArchivedRecovery(database);
      const snapshotBefore = archived.snapshot.captureSnapshotSha256;
      pending = seedTerminalPending(
        database,
        archived,
        '018f1d7b-97e8-4a52-8cf2-783e5089c002',
      );
      assert.equal(archived.snapshot.captureSnapshotSha256, snapshotBefore);
      database.exec('COMMIT');
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK');
      throw error;
    } finally {
      database.close();
    }
    assert.deepEqual(await probe(root), {
      ok: true,
      result: { kind: 'recovery-pending' },
    });

    const reconciler = new DatabaseSync(databasePath(root));
    try {
      reconciler.exec('BEGIN IMMEDIATE');
      reconcileFresh(reconciler, archived, pending);
      reconciler.exec('COMMIT');
    } catch (error) {
      if (reconciler.isTransaction) reconciler.exec('ROLLBACK');
      throw error;
    } finally {
      reconciler.close();
    }
    const active = await probe(root);
    assert.equal(active.ok, true);
    assert.equal(active.result.kind, 'active');
    assert.equal(active.result.command.captureId,
      '018f1d7b-97e8-4a52-8cf2-783e5089c002');
    assert.equal(active.result.command.allocationSequence, 2);
    assert.equal(active.result.command.command.expectedSequence, 1);
    const reopened = new DatabaseSync(databasePath(root), { readOnly: true });
    assert.equal(reopened.prepare(`
      SELECT capture_snapshot_sha256 FROM b3_recoveries WHERE command_sha256 = ?
    `).get(archived.prepared.commandSha256).capture_snapshot_sha256,
    archived.snapshot.captureSnapshotSha256);
    reopened.close();
  });

test('D4.2 validates two abandoned captures, one working capture and the latest lineage',
  async (t) => {
    const root = await fixture(t, 'repeated');
    await probe(root);
    const database = new DatabaseSync(databasePath(root));
    let secondArchive;
    try {
      database.exec('BEGIN IMMEDIATE');
      const firstArchive = seedArchivedRecovery(database);
      const firstPending = seedTerminalPending(
        database,
        firstArchive,
        '018f1d7b-97e8-4a52-8cf2-783e5089c002',
      );
      const secondWorking = reconcileFresh(database, firstArchive, firstPending);
      secondArchive = archiveExistingWorking(database, secondWorking);
      const secondPending = seedTerminalPending(
        database,
        secondArchive,
        '018f1d7b-97e8-4a52-8cf2-783e5089c003',
      );
      reconcileFresh(database, secondArchive, secondPending);
      database.exec('COMMIT');
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK');
      throw error;
    } finally {
      database.close();
    }

    const phase = await probe(root, 'phase');
    assert.equal(phase.ok, true);
    assert.equal(phase.result.kind, 'working');
    assert.deepEqual(phase.result.captureIds, [
      '018f1d7b-97e8-4a52-8cf2-783e5089c001',
      '018f1d7b-97e8-4a52-8cf2-783e5089c002',
      '018f1d7b-97e8-4a52-8cf2-783e5089c003',
    ]);
    assert.equal(phase.result.workingCaptureId,
      '018f1d7b-97e8-4a52-8cf2-783e5089c003');
    assert.equal(phase.result.latestRecoveryCommandSha256,
      secondArchive.prepared.commandSha256);
    assert.equal(phase.result.snapshotArraysFrozen, true);
    assert.equal(phase.result.snapshots.length, 3);
    assert.equal(phase.result.snapshots.every((snapshot) =>
      snapshot.commandCount === 1 &&
      snapshot.stepCount === 0 &&
      snapshot.decisionCount >= 0), true);
  });

test('D4.2 rejects impossible phase, pointer and recovery mixtures without repair',
  async (t) => {
    const scenarios = [
      {
        label: 'terminal-without-pending',
        mutate(database) {
          const archived = seedArchivedRecovery(database);
          seedTerminalPending(
            database,
            archived,
            '018f1d7b-97e8-4a52-8cf2-783e5089c002',
            { reserve: false },
          );
        },
      },
      {
        label: 'wrong-singleton-version',
        mutate(database) {
          seedArchivedRecovery(database);
          database.exec('UPDATE b3_authority_state SET row_version = row_version + 1');
        },
      },
      {
        label: 'two-working-captures',
        mutate(database) {
          const archived = seedArchivedRecovery(database);
          const pending = seedTerminalPending(
            database,
            archived,
            '018f1d7b-97e8-4a52-8cf2-783e5089c002',
          );
          reconcileFresh(database, archived, pending);
          database.exec(`
            UPDATE b3_captures
            SET capture_state = 'working', row_version = 1
            WHERE capture_id = '${CAPTURE_ID}'
          `);
        },
      },
      {
        label: 'fresh-local-sequence-does-not-reset',
        mutate(database) {
          const archived = seedArchivedRecovery(database);
          const pending = seedTerminalPending(
            database,
            archived,
            '018f1d7b-97e8-4a52-8cf2-783e5089c002',
          );
          const fresh = reconcileFresh(database, archived, pending);
          database.prepare(`
            UPDATE b3_commands SET expected_observation_sequence = 2
            WHERE command_sha256 = ?
          `).run(fresh.prepared.commandSha256);
        },
      },
    ];
    for (const scenario of scenarios) {
      const root = await fixture(t, scenario.label);
      await probe(root);
      const database = new DatabaseSync(databasePath(root));
      try {
        database.exec('BEGIN IMMEDIATE');
        scenario.mutate(database);
        database.exec('COMMIT');
      } catch (error) {
        if (database.isTransaction) database.exec('ROLLBACK');
        throw error;
      } finally {
        database.close();
      }
      const before = await databaseSha256(root);
      const rejected = await probe(root, 'open-foundation');
      assert.equal(rejected.ok, false, scenario.label);
      assert.equal(rejected.error.code, 'b3_capture_state_invalid', scenario.label);
      assert.equal(await databaseSha256(root), before, scenario.label);
    }
  });

test('D4.2 derives a 512-command archive and resets the fresh command at global 513/local 1',
  { timeout: 30_000 }, async (t) => {
    const root = await fixture(t, 'maximal');
    await probe(root);
    const database = new DatabaseSync(databasePath(root));
    try {
      database.exec('BEGIN IMMEDIATE');
      const archived = seedMaximalArchivedRecovery(database);
      const pending = seedTerminalPending(
        database,
        archived,
        '018f1d7b-97e8-4a52-8cf2-783e5089c513',
      );
      reconcileFresh(database, archived, pending);
      database.exec('COMMIT');
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK');
      throw error;
    } finally {
      database.close();
    }
    const phase = await probe(root, 'phase');
    assert.equal(phase.ok, true, phase.error?.message);
    assert.equal(phase.result.kind, 'working');
    assert.equal(phase.result.snapshots[0].commandCount, 512);
    assert.equal(phase.result.snapshots[0].decisionCount, 514);
    assert.equal(phase.result.snapshots[0].stepCount, 512);
    assert.equal(phase.result.snapshots[1].firstCommand.allocationSequence, 513);
    assert.equal(phase.result.snapshots[1].firstCommand.expectedObservationSequence, 1);
    assert.equal(phase.result.snapshots[1].firstCommand.previousObservationSha256,
      '0'.repeat(64));
  });

test('D4.2 keeps an archived step readable and forbids a missing archived insertion',
  async (t) => {
    const root = await fixture(t, 'archived-step');
    await seedPublishedObservation(root);
    const database = new DatabaseSync(databasePath(root));
    let observationBytes;
    let source;
    try {
      database.exec('BEGIN IMMEDIATE');
      const start = createB3InitialCaptureStartAuthority({
        platform: 'ios', command: startCommand(), buildAuthority: BUILD,
      });
      const prepared = createB3PreparedIssuedCommandAuthority({
        platform: 'ios', command: start.firstCommand,
      });
      const row = database.prepare(`
        SELECT record_json FROM b3_capture_steps WHERE capture_id = ?
      `).get(CAPTURE_ID);
      observationBytes = canonicalBytes(
        JSON.parse(Buffer.from(row.record_json).toString('utf8')).observation,
      );
      source = {
        schemaVersion: prepared.schemaVersion,
        platform: 'ios',
        allocationSequence: 1,
        predecessorCommandSha256: null,
        captureId: CAPTURE_ID,
        commandSha256: prepared.commandSha256,
        command: prepared.command,
        state: prepared.state,
        recordSha256: prepared.recordSha256,
      };
      archiveExistingWorking(database, { start, prepared });
      database.exec('COMMIT');
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK');
      throw error;
    } finally {
      database.close();
    }
    assert.deepEqual(await probe(root), {
      ok: true,
      result: { kind: 'recovery-pending' },
    });
    const identical = await publishExisting(root, source, observationBytes);
    assert.equal(identical.ok, true, identical.error?.message);
    assert.equal(identical.result.kind, 'already-published');

    const missingRoot = await fixture(t, 'archived-missing-step');
    await probe(missingRoot);
    const missing = new DatabaseSync(databasePath(missingRoot));
    try {
      missing.exec('BEGIN IMMEDIATE');
      seedArchivedRecovery(missing);
      missing.exec('COMMIT');
    } catch (error) {
      if (missing.isTransaction) missing.exec('ROLLBACK');
      throw error;
    } finally {
      missing.close();
    }
    const before = await databaseSha256(missingRoot);
    const rejected = await publishExisting(missingRoot, source, observationBytes);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'b3_capture_state_invalid');
    assert.match(rejected.error.message, /active tail|missing publication/i);
    assert.equal(await databaseSha256(missingRoot), before);
  });
