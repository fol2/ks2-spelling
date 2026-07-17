import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

import {
  B3_CAPTURE_STATE_SCHEMA_OBJECTS,
  B3_CAPTURE_STATE_SCHEMA_SQL,
  B3_CAPTURE_STATE_SCHEMA_VERSION,
} from '../scripts/lib/b3-capture-state-schema.mjs';
import { canonicaliseB3ProofValue } from '../src/app/b3-live-proof-protocol.js';

const execFileAsync = promisify(execFile);
const COMMIT = '1'.repeat(40);
const FINGERPRINT = '2'.repeat(64);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fixture(t, label) {
  const root = await mkdtemp(join(tmpdir(), `b3-capture-v2-${label}-`));
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

async function childJson(root, helper, args = []) {
  const { stdout } = await execFileAsync(process.execPath, [
    '--experimental-test-module-mocks',
    new URL(`./helpers/${helper}`, import.meta.url).pathname,
    ...args,
  ], { cwd: root });
  return JSON.parse(stdout);
}

function initialCommand() {
  const unsigned = {
    schemaVersion: 1,
    captureId: '018f1d7b-97e8-4a52-8cf2-783e5089c001',
    platform: 'ios-physical',
    testedApplicationCommit: COMMIT,
    applicationFingerprint: FINGERPRINT,
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

test('D1 freezes SQLite capture authority at schema version 2 with retained steps', () => {
  assert.equal(B3_CAPTURE_STATE_SCHEMA_VERSION, 2);
  const tables = B3_CAPTURE_STATE_SCHEMA_OBJECTS
    .filter(({ type }) => type === 'table')
    .map(({ name }) => name);
  assert.equal(tables.includes('b3_capture_steps'), true);

  const commands = B3_CAPTURE_STATE_SCHEMA_OBJECTS.find(
    ({ type, name }) => type === 'table' && name === 'b3_commands',
  );
  assert.match(commands.sql, /expected_observation_sequence BETWEEN 1 AND 512/u);

  const recoveries = B3_CAPTURE_STATE_SCHEMA_OBJECTS.find(
    ({ type, name }) => type === 'table' && name === 'b3_recoveries',
  );
  assert.match(recoveries.sql, /capture_snapshot_sha256/u);
  assert.doesNotMatch(recoveries.sql, /bundle_state|source_snapshot_sha256/u);
});

function recoverySchemaFixture({ includeTerminalDecision = true } = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(B3_CAPTURE_STATE_SCHEMA_SQL);
  const values = Object.freeze({
    command: '3'.repeat(64),
    sourceRecord: '4'.repeat(64),
    ownerClaim: '5'.repeat(64),
    snapshot: '6'.repeat(64),
    manifest: '7'.repeat(64),
    authority: '8'.repeat(64),
    terminalRecord: '9'.repeat(64),
    terminalClaim: 'a'.repeat(64),
  });
  database.prepare(`
    INSERT INTO b3_capture_start_intents (
      start_intent_sha256, intent_kind, recovered_command_sha256,
      terminal_claim_sha256, capture_id, first_command_sha256,
      first_command_json, first_prepared_record_json,
      first_prepared_record_sha256, intent_state, row_version
    ) VALUES (?, 'initial', NULL, NULL, ?, ?, ?, ?, ?, 'ready', 2)
  `).run(
    'b'.repeat(64), '018f1d7b-97e8-4a52-8cf2-783e5089c001', values.command,
    Buffer.from('{}'), Buffer.from('{}'), 'c'.repeat(64),
  );
  database.prepare(`
    INSERT INTO b3_captures (
      capture_id, start_intent_sha256, capture_state, row_version
    ) VALUES (?, ?, 'abandoned', 2)
  `).run('018f1d7b-97e8-4a52-8cf2-783e5089c001', 'b'.repeat(64));
  database.prepare(`
    INSERT INTO b3_commands (
      command_sha256, allocation_sequence, predecessor_command_sha256,
      command_json, prepared_record_json, prepared_record_sha256, capture_id,
      expected_observation_sequence, previous_observation_sha256
    ) VALUES (?, 1, NULL, ?, ?, ?, ?, 1, ?)
  `).run(
    values.command, Buffer.from('{}'), Buffer.from('{}'), 'c'.repeat(64),
    '018f1d7b-97e8-4a52-8cf2-783e5089c001', '0'.repeat(64),
  );
  database.prepare(`
    INSERT INTO b3_decisions (
      command_sha256, source_state, source_record_sha256, winner_kind,
      next_state, next_record_json, next_record_sha256, claim_json, claim_sha256
    ) VALUES (?, 'restart-required', ?, 'recovery-owner',
      'restart-executing', ?, ?, ?, ?)
  `).run(
    values.command, 'd'.repeat(64), Buffer.from('{}'), values.sourceRecord,
    Buffer.from('{}'), values.ownerClaim,
  );
  database.prepare(`
    INSERT INTO b3_recoveries (
      command_sha256, owner_kind, owner_claim_sha256, capture_id,
      capture_snapshot_sha256, row_version
    ) VALUES (?, 'recovery-owner', ?, ?, ?, 1)
  `).run(
    values.command, values.ownerClaim,
    '018f1d7b-97e8-4a52-8cf2-783e5089c001', values.snapshot,
  );
  database.prepare(`
    INSERT INTO b3_recovery_manifests (
      command_sha256, owner_claim_sha256, capture_snapshot_sha256,
      manifest_json, manifest_sha256
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    values.command, values.ownerClaim, values.snapshot,
    Buffer.from('{}'), values.manifest,
  );
  database.prepare(`
    INSERT INTO b3_recovery_authorities (
      command_sha256, owner_claim_sha256, capture_snapshot_sha256,
      manifest_sha256, authority_json, authority_sha256
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    values.command, values.ownerClaim, values.snapshot, values.manifest,
    Buffer.from('{}'), values.authority,
  );
  if (includeTerminalDecision) {
    database.prepare(`
      INSERT INTO b3_decisions (
        command_sha256, source_state, source_record_sha256, winner_kind,
        next_state, next_record_json, next_record_sha256, claim_json, claim_sha256
      ) VALUES (?, 'restart-executing', ?, 'recovery-terminal',
        'restart-complete', ?, ?, ?, ?)
    `).run(
      values.command, values.sourceRecord, Buffer.from('{}'), values.terminalRecord,
      Buffer.from('{}'), values.terminalClaim,
    );
  }
  return { database, values };
}

function insertRecoveryTerminal(database, values, overrides = {}) {
  const row = { ...values, terminalKind: 'recovery-terminal', ...overrides };
  return database.prepare(`
    INSERT INTO b3_recovery_terminals (
      command_sha256, owner_claim_sha256, capture_snapshot_sha256,
      manifest_sha256, authority_sha256, terminal_kind,
      terminal_record_json, terminal_record_sha256,
      terminal_claim_json, terminal_claim_sha256
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.command, row.ownerClaim, row.snapshot, row.manifest, row.authority,
    row.terminalKind, Buffer.from('{}'), row.terminalRecord,
    Buffer.from('{}'), row.terminalClaim,
  );
}

test('D4.1 terminal row is composite-bound to the exact selected terminal decision', () => {
  {
    const { database, values } = recoverySchemaFixture({
      includeTerminalDecision: false,
    });
    assert.throws(() => insertRecoveryTerminal(database, values), /FOREIGN KEY/u);
    database.close();
  }
  {
    const { database, values } = recoverySchemaFixture();
    insertRecoveryTerminal(database, values);
    assert.equal(database.prepare(`
      SELECT terminal_kind FROM b3_recovery_terminals
    `).get().terminal_kind, 'recovery-terminal');
    database.close();
  }
  for (const [label, overrides, pattern] of [
    ['record', { terminalRecord: 'e'.repeat(64) }, /FOREIGN KEY/u],
    ['claim', { terminalClaim: 'f'.repeat(64) }, /FOREIGN KEY/u],
    ['discriminator', { terminalKind: 'ordinary' }, /CHECK constraint/u],
    ['archive-prerequisite', { authority: '1'.repeat(64) }, /FOREIGN KEY/u],
  ]) {
    const { database, values } = recoverySchemaFixture();
    assert.throws(() => insertRecoveryTerminal(database, values, overrides), pattern, label);
    database.close();
  }
});

test('D4.1 recovery prerequisite composites reject manifest and authority swaps', () => {
  {
    const { database, values } = recoverySchemaFixture();
    assert.throws(() => database.prepare(`
      UPDATE b3_recovery_manifests SET capture_snapshot_sha256 = ?
      WHERE command_sha256 = ?
    `).run('e'.repeat(64), values.command), /FOREIGN KEY/u);
    database.close();
  }
  {
    const { database, values } = recoverySchemaFixture();
    assert.throws(() => database.prepare(`
      UPDATE b3_recovery_authorities SET manifest_sha256 = ?
      WHERE command_sha256 = ?
    `).run('e'.repeat(64), values.command), /FOREIGN KEY/u);
    database.close();
  }
});

test('D1 production database and repository have no working-bundle dependency', async () => {
  for (const path of [
    new URL('../scripts/lib/b3-capture-state-database.mjs', import.meta.url),
    new URL('../scripts/lib/b3-capture-state-repository.mjs', import.meta.url),
    new URL('../scripts/lib/b3-capture-store.mjs', import.meta.url),
  ]) {
    const source = await readFile(path, 'utf8');
    assert.doesNotMatch(source, /b3-capture-bundle-store|CaptureBundle|WorkingBundle/u);
  }
});

test('D1 shared async and sync readers bind one canonical six-field build source',
  async (t) => {
    const root = await fixture(t, 'build-source');
    const result = await childJson(
      root,
      'b3-build-authority-source-probe-child.mjs',
    );

    assert.equal(result.ok, true);
    assert.deepEqual(result.asynchronous, result.synchronous);
    assert.equal(result.asynchronous.identity.ancestors.length, 3);
    assert.equal(result.asynchronous.bytesIsolated, true);
    assert.deepEqual(result.callerAuthority, {
      asynchronous: 'b3_capture_state_invalid',
      synchronous: 'b3_capture_state_invalid',
    });
    assert.equal(result.asynchronous.value.testedApplicationCommit, COMMIT);
    assert.equal(result.asynchronous.value.applicationFingerprint, FINGERPRINT);
    assert.equal(
      sha256(Buffer.from(result.asynchronous.canonicalJson, 'utf8')),
      result.asynchronous.sha256,
    );
    assert.equal(Object.values(result.asynchronous.frozen).every(Boolean), true);
  });

test('D1 build source rejects caller-controlled links and public modes', async (t) => {
  const cases = [
    {
      label: 'public-file',
      mutate: async (root) => chmod(join(
        root, '.native-build', 'b3', 'distribution', 'build-authority.json',
      ), 0o644),
    },
    {
      label: 'hard-link',
      mutate: async (root) => link(
        join(root, '.native-build', 'b3', 'distribution', 'build-authority.json'),
        join(root, '.native-build', 'b3', 'distribution', 'build-authority-copy.json'),
      ),
    },
    {
      label: 'symbolic-link',
      mutate: async (root) => {
        const path = join(
          root, '.native-build', 'b3', 'distribution', 'build-authority.json',
        );
        const retained = `${path}.retained`;
        await rename(path, retained);
        await symlink(retained, path);
      },
    },
    {
      label: 'public-ancestor',
      mutate: async (root) => chmod(join(
        root, '.native-build', 'b3', 'distribution',
      ), 0o755),
    },
  ];

  for (const current of cases) {
    const root = await fixture(t, `build-source-${current.label}`);
    await current.mutate(root);
    for (const reader of ['async', 'sync']) {
      const result = await childJson(
        root,
        'b3-build-authority-source-probe-child.mjs',
        [reader],
      );
      assert.equal(result.ok, false, `${current.label}-${reader}`);
      assert.equal(
        result.error.code,
        'b3_capture_state_invalid',
        `${current.label}-${reader}`,
      );
      assert.match(
        result.error.message,
        /policy|link|authority/u,
        `${current.label}-${reader}`,
      );
    }
  }
});

test('D1 full validation accepts a structurally valid step and rejects corruption',
  async (t) => {
    const root = await fixture(t, 'steps');
    const command = initialCommand();
    const started = await childJson(root, 'b3-capture-store-probe-child.mjs', [
      'start',
      Buffer.from(JSON.stringify(command), 'utf8').toString('base64url'),
    ]);
    assert.equal(started.ok, true);
    const path = join(
      root, '.native-build', 'b3', 'evidence', 'ios-capture-state',
      'recovery.sqlite',
    );
    const recordBytes = Buffer.from('{"record":1}', 'utf8');
    const checkpointBytes = Buffer.from('{"checkpoint":1}', 'utf8');
    const database = new DatabaseSync(path);
    database.prepare(`
      INSERT INTO b3_capture_steps (
        capture_id, observation_sequence, command_sha256, record_json,
        record_sha256, observation_sha256, checkpoint_json, checkpoint_sha256
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?)
    `).run(
      command.captureId,
      database.prepare('SELECT command_sha256 FROM b3_commands').get().command_sha256,
      recordBytes,
      sha256(recordBytes),
      '3'.repeat(64),
      checkpointBytes,
      sha256(checkpointBytes),
    );
    database.close();
    assert.equal((await childJson(
      root,
      'b3-capture-state-open-probe-child.mjs',
    )).ok, true);

    const corruptor = new DatabaseSync(path);
    corruptor.prepare('UPDATE b3_capture_steps SET record_sha256 = ?')
      .run('4'.repeat(64));
    corruptor.close();
    const before = sha256(await readFile(path));
    const rejected = await childJson(root, 'b3-capture-state-open-probe-child.mjs');
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'b3_capture_state_invalid');
    assert.match(rejected.error.message, /step structure/u);
    assert.equal(sha256(await readFile(path)), before);
  });

test('D1 rejects a non-empty v1 database and rollback sidecar before SQLite open',
  async (t) => {
    const root = await fixture(t, 'obsolete-v1');
    const stateDirectory = join(
      root, '.native-build', 'b3', 'evidence', 'ios-capture-state',
    );
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await chmod(join(root, '.native-build', 'b3', 'evidence'), 0o700);
    await chmod(stateDirectory, 0o700);
    const path = join(stateDirectory, 'recovery.sqlite');
    const old = new DatabaseSync(path);
    old.exec(`
      PRAGMA application_id = 1263743810;
      PRAGMA user_version = 1;
      PRAGMA journal_mode = DELETE;
      CREATE TABLE retained_v1(value TEXT NOT NULL) STRICT;
      INSERT INTO retained_v1 VALUES ('non-empty');
    `);
    old.close();
    await chmod(path, 0o600);
    const sidecar = `${path}-journal`;
    await writeFile(sidecar, Buffer.from('retained-sidecar', 'utf8'), { mode: 0o600 });
    const before = {
      database: sha256(await readFile(path)),
      sidecar: sha256(await readFile(sidecar)),
    };

    const result = await childJson(root, 'b3-capture-state-open-probe-child.mjs');

    assert.deepEqual(result, {
      ok: false,
      error: {
        code: 'b3_capture_state_schema_obsolete',
        message: 'B3 capture-state schema version 1 is obsolete',
      },
      persistentOpened: false,
    });
    assert.deepEqual({
      database: sha256(await readFile(path)),
      sidecar: sha256(await readFile(sidecar)),
    }, before);
  });

test('D1 exposes no capture-state migration, reset or destructive schema entrypoint',
  async () => {
    const sources = await Promise.all([
      readFile(new URL('../scripts/lib/b3-capture-state-database.mjs', import.meta.url), 'utf8'),
      readFile(new URL('../scripts/lib/b3-capture-state-repository.mjs', import.meta.url), 'utf8'),
      readFile(new URL('../scripts/lib/b3-capture-store.mjs', import.meta.url), 'utf8'),
    ]);
    for (const source of sources) {
      assert.doesNotMatch(
        source,
        /export\s+(?:async\s+)?function\s+\w*(?:migrat|reset)|DROP TABLE|DELETE FROM/iu,
      );
    }
  });
