import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open as openFile,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const execFileAsync = promisify(execFile);
const COMMIT = '1'.repeat(40);
const FINGERPRINT = '2'.repeat(64);
const SCHEMA_SHA256 = '76121199637bf3a587910189149105f0a54efe2d61a205507ce6377e2895b857';
const EXPECTED_TABLES = Object.freeze([
  'b3_authority_state',
  'b3_capture_start_intents',
  'b3_capture_steps',
  'b3_captures',
  'b3_commands',
  'b3_decisions',
  'b3_meta',
  'b3_recoveries',
  'b3_recovery_authorities',
  'b3_recovery_manifests',
  'b3_recovery_terminals',
]);

async function fixture(t, label) {
  const root = await mkdtemp(join(tmpdir(), `b3-capture-db-${label}-`));
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

async function openInChild(root, platform = 'ios', mode = null) {
  const helper = new URL('./helpers/b3-capture-state-database-child.mjs', import.meta.url);
  const args = ['--experimental-test-module-mocks', helper.pathname, platform];
  if (mode !== null) args.push(mode);
  const { stdout } = await execFileAsync(process.execPath, args, {
    cwd: root,
  });
  return JSON.parse(stdout);
}

async function fileSha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function directorySnapshot(path) {
  const entries = await readdir(path);
  const snapshot = [];
  for (const name of entries.sort()) {
    const entryPath = join(path, name);
    const metadata = await lstat(entryPath);
    snapshot.push({
      name,
      type: metadata.isFile() ? 'file' : metadata.isDirectory() ? 'directory' : 'other',
      mode: metadata.mode & 0o7777,
      nlink: metadata.nlink,
      size: metadata.size,
      sha256: metadata.isFile() ? await fileSha256(entryPath) : null,
    });
  }
  return snapshot;
}

function watchChildOutput(child) {
  let stdout = '';
  let stderr = '';
  const waiters = new Set();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    for (const waiter of waiters) {
      if (stdout.includes(waiter.expected)) {
        waiters.delete(waiter);
        waiter.resolve();
      }
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('exit', (code, signal) => {
    for (const waiter of waiters) {
      waiter.reject(new Error(
        `child exited before ${waiter.expected} (${String(code)}, ${String(signal)}): ` +
        `${stderr}`,
      ));
    }
    waiters.clear();
  });
  return Object.freeze({
    waitFor(expected) {
      if (stdout.includes(expected)) return Promise.resolve();
      return new Promise((resolveOutput, reject) => {
        waiters.add({ expected, resolve: resolveOutput, reject });
      });
    },
    stdout: () => stdout,
    stderr: () => stderr,
  });
}

test('temporary cwd alone cannot redirect the module-derived repository root', async (t) => {
  const root = await fixture(t, 'fixed-root');
  const helper = new URL(
    './helpers/b3-capture-state-root-child.mjs', import.meta.url,
  );
  const { stdout } = await execFileAsync(process.execPath, [helper.pathname], { cwd: root });
  assert.equal(JSON.parse(stdout).repositoryRoot, dirname(import.meta.dirname));
});

test('closed capture-state foundation bootstraps one fixed private v2 database',
  async (t) => {
    const root = await fixture(t, 'bootstrap');
    const opened = await openInChild(root);
    assert.deepEqual(opened, { ok: true });

    const stateDirectory = join(
      root, '.native-build', 'b3', 'evidence', 'ios-capture-state',
    );
    const databasePath = join(stateDirectory, 'recovery.sqlite');
    assert.equal((await stat(stateDirectory)).mode & 0o7777, 0o700);
    const databaseMetadata = await stat(databasePath);
    assert.equal(databaseMetadata.mode & 0o7777, 0o600);
    assert.equal(databaseMetadata.nlink, 1);

    const database = new DatabaseSync(databasePath, { readOnly: true });
    t.after(() => database.close());
    const tableRows = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
    `).all();
    assert.deepEqual(tableRows.map(({ name }) => name), EXPECTED_TABLES);
    const meta = database.prepare('SELECT * FROM b3_meta').get();
    assert.equal(meta.singleton, 1);
    assert.equal(meta.schema_version, 2);
    assert.equal(meta.platform, 'ios');
    assert.equal(meta.tested_application_commit, COMMIT);
    assert.equal(meta.application_fingerprint, FINGERPRINT);
    assert.equal(meta.schema_sha256, SCHEMA_SHA256);
    const strictTables = database.prepare(`
      PRAGMA table_list
    `).all().filter(({ schema, name }) => schema === 'main' && EXPECTED_TABLES.includes(name));
    assert.equal(strictTables.length, EXPECTED_TABLES.length);
    assert.equal(strictTables.every(({ strict }) => strict === 1), true);
    assert.equal(database.prepare('PRAGMA application_id').get().application_id, 0x4b533342);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(database.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    assert.deepEqual(database.prepare('SELECT * FROM b3_authority_state').all()
      .map((row) => ({ ...row })), [{
      singleton: 1,
      next_allocation_sequence: 1,
      active_command_sha256: null,
      reserved_start_command_sha256: null,
      row_version: 1,
    }]);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  });

test('existing database rejects an impossible allocation singleton without mutation',
  async (t) => {
    const root = await fixture(t, 'invalid-singleton');
    await openInChild(root);
    const databasePath = join(
      root, '.native-build', 'b3', 'evidence', 'ios-capture-state', 'recovery.sqlite',
    );
    const corruptor = new DatabaseSync(databasePath);
    corruptor.exec('UPDATE b3_authority_state SET next_allocation_sequence = 2');
    corruptor.close();
    const before = await fileSha256(databasePath);

    await assert.rejects(openInChild(root), /allocation|authority|application|invalid/i);
    assert.equal(await fileSha256(databasePath), before);
  });

test('an exact private rollback-journal pathname is left to SQLite rather than classified',
  async (t) => {
    const root = await fixture(t, 'sqlite-journal');
    await openInChild(root);
    const stateDirectory = join(
      root, '.native-build', 'b3', 'evidence', 'ios-capture-state',
    );
    await writeFile(join(stateDirectory, 'recovery.sqlite-journal'), Buffer.alloc(0), {
      mode: 0o600,
      flag: 'wx',
    });

    await openInChild(root);
    const database = new DatabaseSync(join(stateDirectory, 'recovery.sqlite'), {
      readOnly: true,
    });
    assert.equal(database.prepare(`
      SELECT next_allocation_sequence FROM b3_authority_state
    `).get().next_allocation_sequence, 1);
    database.close();
  });

test('a journal disappearing during classification restarts the whole bounded scan',
  async (t) => {
    const root = await fixture(t, 'journal-disappears');
    await openInChild(root);
    const stateDirectory = join(
      root, '.native-build', 'b3', 'evidence', 'ios-capture-state',
    );
    await writeFile(join(stateDirectory, 'recovery.sqlite-journal'), Buffer.alloc(0), {
      mode: 0o600,
      flag: 'wx',
    });
    const helper = new URL(
      './helpers/b3-capture-state-journal-disappears-child.mjs', import.meta.url,
    );
    const { stdout } = await execFileAsync(process.execPath, [
      '--experimental-test-module-mocks', helper.pathname,
    ], { cwd: root });
    assert.deepEqual(JSON.parse(stdout), { outcome: 'opened', deleted: true });
  });

test('SQLite rolls back a hot journal from a killed writer before application validation',
  { timeout: 10_000 }, async (t) => {
    const root = await fixture(t, 'hot-journal');
    await openInChild(root);
    const helper = new URL(
      './helpers/b3-capture-state-hot-journal-child.mjs', import.meta.url,
    );
    const writer = spawn(process.execPath, [
      '--experimental-test-module-mocks', helper.pathname, 'ios',
    ], {
      cwd: root,
      env: {},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => {
      if (writer.exitCode === null && writer.signalCode === null) writer.kill('SIGKILL');
    });
    let stderr = '';
    writer.stderr.setEncoding('utf8');
    writer.stderr.on('data', (chunk) => { stderr += chunk; });
    await new Promise((resolveReady, reject) => {
      let stdout = '';
      writer.stdout.setEncoding('utf8');
      writer.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (stdout === 'HOT\n') resolveReady();
      });
      writer.once('exit', (code, signal) => reject(new Error(
        `hot-journal child exited early (${String(code)}, ${String(signal)}): ${stderr}`,
      )));
    });
    const closed = new Promise((resolveClosed) => writer.once('close', resolveClosed));
    assert.equal(writer.kill('SIGKILL'), true);
    await closed;

    await openInChild(root);
    const database = new DatabaseSync(join(
      root, '.native-build', 'b3', 'evidence', 'ios-capture-state', 'recovery.sqlite',
    ), { readOnly: true });
    assert.equal(database.prepare(`
      SELECT next_allocation_sequence FROM b3_authority_state
    `).get().next_allocation_sequence, 1);
    database.close();
  });

test('duplicate initialisers converge on one exact schema and metadata row', async (t) => {
  const root = await fixture(t, 'duplicate-bootstrap');
  const results = await Promise.all(
    Array.from({ length: 8 }, () => openInChild(root)),
  );
  assert.deepEqual(results, Array.from({ length: 8 }, () => ({ ok: true })));
  const database = new DatabaseSync(join(
    root, '.native-build', 'b3', 'evidence', 'ios-capture-state', 'recovery.sqlite',
  ), { readOnly: true });
  assert.equal(database.prepare('SELECT count(*) AS count FROM b3_meta').get().count, 1);
  assert.equal(database.prepare(`
    SELECT count(*) AS count FROM b3_authority_state
  `).get().count, 1);
  database.close();
});

test('bootstrap converges after process death at every durability boundary',
  { timeout: 30_000 }, async (t) => {
    const points = [
      'evidence-directory-sync',
      'state-directory-sync',
      'database-create',
      'database-file-sync',
      'database-directory-sync',
      'schema-transaction',
      'schema-commit',
      'final-database-sync',
      'final-directory-sync',
    ];
    const helper = new URL(
      './helpers/b3-capture-state-bootstrap-death-child.mjs', import.meta.url,
    );
    for (const point of points) {
      const root = await fixture(t, `bootstrap-death-${point}`);
      const child = spawn(process.execPath, [
        '--experimental-test-module-mocks', helper.pathname, point,
      ], {
        cwd: root,
        env: {},
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const result = await new Promise((resolveChild, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolveChild({ code, signal }));
      });
      assert.deepEqual(result, { code: null, signal: 'SIGKILL' }, `${point}: ${stderr}`);

      assert.deepEqual(await openInChild(root), { ok: true }, point);
      const stateDirectory = join(
        root, '.native-build', 'b3', 'evidence', 'ios-capture-state',
      );
      const database = new DatabaseSync(join(stateDirectory, 'recovery.sqlite'), {
        readOnly: true,
      });
      assert.equal(database.prepare('SELECT count(*) AS count FROM b3_meta').get().count,
        1, point);
      assert.equal(database.prepare(`
        SELECT count(*) AS count FROM b3_authority_state
      `).get().count, 1, point);
      database.close();
    }
  });

test('fresh open returns while a first post-commit writer owns the exact journal',
  { timeout: 10_000 }, async (t) => {
    const root = await fixture(t, 'post-commit-pre-return-journal');
    const openerHelper = new URL(
      './helpers/b3-capture-state-post-commit-race-child.mjs', import.meta.url,
    );
    const opener = spawn(process.execPath, [
      '--experimental-test-module-mocks', openerHelper.pathname,
    ], {
      cwd: root,
      env: {},
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    t.after(() => {
      if (opener.exitCode === null && opener.signalCode === null) opener.kill('SIGKILL');
    });
    const openerOutput = watchChildOutput(opener);
    const openerExit = new Promise((resolveExit) => opener.once('close', (code, signal) => {
      resolveExit({ code, signal });
    }));
    await openerOutput.waitFor('PAUSED\n');

    const writerHelper = new URL(
      './helpers/b3-capture-state-hot-journal-child.mjs', import.meta.url,
    );
    const writer = spawn(process.execPath, [writerHelper.pathname, 'ios'], {
      cwd: root,
      env: {},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => {
      if (writer.exitCode === null && writer.signalCode === null) writer.kill('SIGKILL');
    });
    const writerOutput = watchChildOutput(writer);
    const writerExit = new Promise((resolveExit) => writer.once('close', (code, signal) => {
      resolveExit({ code, signal });
    }));
    await writerOutput.waitFor('HOT\n');

    const journalPath = join(
      root, '.native-build', 'b3', 'evidence', 'ios-capture-state',
      'recovery.sqlite-journal',
    );
    const before = await stat(journalPath);
    assert.equal(before.isFile(), true);
    assert.equal(before.mode & 0o7777, 0o600);
    assert.equal(before.nlink, 1);
    const beforeSha256 = await fileSha256(journalPath);

    const returned = openerOutput.waitFor('RETURNED\n');
    opener.stdin.write('RESUME\n');
    await returned;
    const afterReturn = await stat(journalPath);
    assert.deepEqual(
      [afterReturn.dev, afterReturn.ino, afterReturn.mode, afterReturn.nlink,
        afterReturn.size, await fileSha256(journalPath)],
      [before.dev, before.ino, before.mode, before.nlink, before.size, beforeSha256],
    );

    const closed = openerOutput.waitFor('CLOSED\n');
    opener.stdin.end('CLOSE\n');
    await closed;
    assert.deepEqual(await openerExit, { code: 0, signal: null }, openerOutput.stderr());
    assert.equal(openerOutput.stdout(), 'PAUSED\nRETURNED\nCLOSED\n');
    assert.equal((await stat(journalPath)).ino, before.ino);

    assert.equal(writer.kill('SIGKILL'), true);
    assert.deepEqual(await writerExit, { code: null, signal: 'SIGKILL' });
    assert.deepEqual(await openInChild(root), { ok: true });
    const database = new DatabaseSync(join(
      root, '.native-build', 'b3', 'evidence', 'ios-capture-state', 'recovery.sqlite',
    ), { readOnly: true });
    assert.equal(database.prepare(`
      SELECT next_allocation_sequence FROM b3_authority_state
    `).get().next_allocation_sequence, 1);
    database.close();
  });

test('a live DELETE-journal writer causes bounded SQLite busy, then hot rollback recovers',
  { timeout: 15_000 }, async (t) => {
    const root = await fixture(t, 'live-writer');
    await openInChild(root);
    const helper = new URL(
      './helpers/b3-capture-state-hot-journal-child.mjs', import.meta.url,
    );
    const writer = spawn(process.execPath, [
      '--experimental-test-module-mocks', helper.pathname, 'ios',
    ], {
      cwd: root,
      env: {},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => {
      if (writer.exitCode === null && writer.signalCode === null) writer.kill('SIGKILL');
    });
    await new Promise((resolveReady, reject) => {
      let stdout = '';
      writer.stdout.setEncoding('utf8');
      writer.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (stdout === 'HOT\n') resolveReady();
      });
      writer.once('exit', (code, signal) => reject(new Error(
        `live writer exited early (${String(code)}, ${String(signal)})`,
      )));
    });
    const startedAt = Date.now();
    await assert.rejects(openInChild(root), /busy|locked|database/i);
    assert.equal(Date.now() - startedAt >= 4_500, true);
    const closed = new Promise((resolveClosed) => writer.once('close', resolveClosed));
    writer.kill('SIGKILL');
    await closed;
    await openInChild(root);
  });

test('a helper closes successfully while another honest writer owns the exact journal',
  { timeout: 10_000 }, async (t) => {
    const root = await fixture(t, 'post-commit-journal');
    const holderHelper = new URL(
      './helpers/b3-capture-state-hold-open-child.mjs', import.meta.url,
    );
    const holder = spawn(process.execPath, [
      '--experimental-test-module-mocks', holderHelper.pathname, 'ios',
    ], {
      cwd: root,
      env: {},
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    t.after(() => {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
    });
    let holderOutput = '';
    holder.stdout.setEncoding('utf8');
    const holderOpened = new Promise((resolveOpened, reject) => {
      holder.stdout.on('data', (chunk) => {
        holderOutput += chunk;
        if (holderOutput === 'OPEN\n') resolveOpened();
        if (holderOutput === 'OPEN\nCLOSED\n') resolveOpened();
      });
      holder.once('exit', (code, signal) => reject(new Error(
        `holder exited early (${String(code)}, ${String(signal)})`,
      )));
    });
    await holderOpened;

    const writerHelper = new URL(
      './helpers/b3-capture-state-hot-journal-child.mjs', import.meta.url,
    );
    const writer = spawn(process.execPath, [writerHelper.pathname, 'ios'], {
      cwd: root,
      env: {},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => {
      if (writer.exitCode === null && writer.signalCode === null) writer.kill('SIGKILL');
    });
    await new Promise((resolveReady, reject) => {
      let stdout = '';
      writer.stdout.setEncoding('utf8');
      writer.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (stdout === 'HOT\n') resolveReady();
      });
      writer.once('exit', (code, signal) => reject(new Error(
        `second writer exited early (${String(code)}, ${String(signal)})`,
      )));
    });
    holder.stdin.end('CLOSE\n');
    await new Promise((resolveClosed, reject) => {
      holder.stdout.on('data', () => {
        if (holderOutput === 'OPEN\nCLOSED\n') resolveClosed();
      });
      holder.once('exit', (code, signal) => {
        if (code === 0 && signal === null && holderOutput === 'OPEN\nCLOSED\n') {
          resolveClosed();
        } else {
          reject(new Error(`holder close failed (${String(code)}, ${String(signal)})`));
        }
      });
    });
    assert.equal(holderOutput, 'OPEN\nCLOSED\n');
    writer.kill('SIGKILL');
  });

test('obsolete working-bundle state is ignored by SQLite bootstrap', async (t) => {
  const root = await fixture(t, 'orphan-before-bootstrap');
  const bundles = join(
    root, '.native-build', 'b3', 'evidence', 'ios-capture-bundles',
  );
  await mkdir(join(
    bundles, '018f1d7b-97e8-4a52-8cf2-783e5089c099.working',
  ), { recursive: true, mode: 0o700 });
  for (const path of [join(root, '.native-build', 'b3', 'evidence'), bundles]) {
    await chmod(path, 0o700);
  }

  assert.deepEqual(await openInChild(root), { ok: true });
  assert.equal((await lstat(join(
    root, '.native-build', 'b3', 'evidence', 'ios-capture-state', 'recovery.sqlite',
  ))).isFile(), true);
});

test('existing database does not inspect obsolete working-bundle state',
  async (t) => {
    const root = await fixture(t, 'existing-hostile-bundle');
    await openInChild(root);
    const stateDirectory = join(
      root, '.native-build', 'b3', 'evidence', 'ios-capture-state',
    );
    const bundles = join(
      root, '.native-build', 'b3', 'evidence', 'ios-capture-bundles',
    );
    await mkdir(bundles, { mode: 0o700 });
    await writeFile(join(bundles, 'unexpected'), Buffer.from('hostile'), { mode: 0o600 });
    const databaseBefore = await directorySnapshot(stateDirectory);
    const bundlesBefore = await directorySnapshot(bundles);

    assert.deepEqual(await openInChild(root), { ok: true });

    assert.deepEqual(await directorySnapshot(stateDirectory), databaseBefore);
    assert.deepEqual(await directorySnapshot(bundles), bundlesBefore);
  });

test('pre-existing zero-byte database is the sole incomplete bootstrap state', async (t) => {
  const root = await fixture(t, 'zero-byte');
  const stateDirectory = join(
    root, '.native-build', 'b3', 'evidence', 'ios-capture-state',
  );
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  for (const path of [
    join(root, '.native-build', 'b3', 'evidence'), stateDirectory,
  ]) await chmod(path, 0o700);
  await writeFile(join(stateDirectory, 'recovery.sqlite'), Buffer.alloc(0), {
    mode: 0o600,
    flag: 'wx',
  });

  await openInChild(root);
  assert.equal((await stat(join(stateDirectory, 'recovery.sqlite'))).size > 0, true);
});

test('a journal without its database rejects with the whole namespace unchanged', async (t) => {
  const root = await fixture(t, 'journal-without-database');
  const stateDirectory = join(
    root, '.native-build', 'b3', 'evidence', 'ios-capture-state',
  );
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  for (const path of [
    join(root, '.native-build', 'b3', 'evidence'), stateDirectory,
  ]) await chmod(path, 0o700);
  await writeFile(join(stateDirectory, 'recovery.sqlite-journal'), Buffer.alloc(0), {
    mode: 0o600,
    flag: 'wx',
  });
  const before = await directorySnapshot(stateDirectory);

  await assert.rejects(openInChild(root), /journal|database|sibling|invalid/i);
  assert.deepEqual(await directorySnapshot(stateDirectory), before);
});

test('S1 rejects a structurally valid orphan ready intent without namespace mutation',
  async (t) => {
    const root = await fixture(t, 'orphan-ready-intent');
    await openInChild(root);
    const stateDirectory = join(
      root, '.native-build', 'b3', 'evidence', 'ios-capture-state',
    );
    const database = new DatabaseSync(join(stateDirectory, 'recovery.sqlite'));
    database.prepare(`
      INSERT INTO b3_capture_start_intents (
        start_intent_sha256, intent_kind, recovered_command_sha256,
        terminal_claim_sha256, capture_id, first_command_sha256,
        first_command_json, first_prepared_record_json,
        first_prepared_record_sha256, intent_state, row_version
      ) VALUES (?, 'initial', NULL, NULL, ?, ?, ?, ?, ?, 'ready', 1)
    `).run(
      '3'.repeat(64),
      '018f1d7b-97e8-4a52-8cf2-783e5089c099',
      '4'.repeat(64),
      Buffer.from('{}'),
      Buffer.from('{}'),
      '5'.repeat(64),
    );
    database.close();
    const before = await directorySnapshot(stateDirectory);

    await assert.rejects(openInChild(root), /domain|authority|application|invalid/i);
    assert.deepEqual(await directorySnapshot(stateDirectory), before);
  });

test('invalid persisted schema, metadata, pragma and foreign keys fail closed byte-for-byte',
  async (t) => {
    const scenarios = [
      {
        label: 'application-id',
        mutate(database) { database.exec('PRAGMA application_id = 7'); },
      },
      {
        label: 'user-version',
        mutate(database) { database.exec('PRAGMA user_version = 3'); },
      },
      {
        label: 'journal-mode',
        mutate(database) { database.exec('PRAGMA journal_mode = WAL'); },
      },
      {
        label: 'schema-object',
        mutate(database) { database.exec('CREATE TABLE unexpected(value INTEGER) STRICT'); },
      },
      {
        label: 'metadata-hash',
        mutate(database) {
          database.prepare('UPDATE b3_meta SET schema_sha256 = ?').run('f'.repeat(64));
        },
      },
      {
        label: 'foreign-key',
        mutate(database) {
          database.exec('PRAGMA foreign_keys = OFF');
          database.prepare(`
            INSERT INTO b3_capture_start_intents (
              start_intent_sha256, intent_kind, recovered_command_sha256,
              terminal_claim_sha256, capture_id, first_command_sha256,
              first_command_json, first_prepared_record_json,
              first_prepared_record_sha256, intent_state, row_version
            ) VALUES (?, 'recovery-fresh', ?, ?, ?, ?, ?, ?, ?, 'pending', 1)
          `).run(
            '3'.repeat(64),
            '4'.repeat(64),
            '5'.repeat(64),
            '018f1d7b-97e8-4a52-8cf2-783e5089c099',
            '6'.repeat(64),
            Buffer.from('{}'),
            Buffer.from('{}'),
            '7'.repeat(64),
          );
        },
      },
    ];
    for (const scenario of scenarios) {
      const root = await fixture(t, `invalid-${scenario.label}`);
      await openInChild(root);
      const databasePath = join(
        root, '.native-build', 'b3', 'evidence', 'ios-capture-state', 'recovery.sqlite',
      );
      const database = new DatabaseSync(databasePath);
      scenario.mutate(database);
      database.close();
      const stateDirectory = join(
        root, '.native-build', 'b3', 'evidence', 'ios-capture-state',
      );
      const before = await directorySnapshot(stateDirectory);
      await assert.rejects(openInChild(root), /invalid|differs|foreign|schema|sibling/i,
        scenario.label);
      assert.deepEqual(await directorySnapshot(stateDirectory), before, scenario.label);
    }
  });

test('invalid application and WAL header bytes reject before persistent SQLite open',
  async (t) => {
    const scenarios = [
      {
        label: 'application-id',
        mutate(database) { database.exec('PRAGMA application_id = 7'); },
      },
      {
        label: 'wal-format',
        mutate(database) { database.exec('PRAGMA journal_mode = WAL'); },
      },
    ];
    for (const scenario of scenarios) {
      const root = await fixture(t, `pre-open-${scenario.label}`);
      await openInChild(root);
      const stateDirectory = join(
        root, '.native-build', 'b3', 'evidence', 'ios-capture-state',
      );
      const database = new DatabaseSync(join(stateDirectory, 'recovery.sqlite'));
      scenario.mutate(database);
      database.close();
      const before = await directorySnapshot(stateDirectory);
      const helper = new URL(
        './helpers/b3-capture-state-preopen-header-child.mjs', import.meta.url,
      );
      const { stdout } = await execFileAsync(process.execPath, [
        '--experimental-test-module-mocks', helper.pathname,
      ], { cwd: root });
      assert.deepEqual(JSON.parse(stdout), {
        outcome: 'rejected',
        persistentOpened: false,
      }, scenario.label);
      assert.deepEqual(await directorySnapshot(stateDirectory), before, scenario.label);
    }
  });

test('hostile path, mode, link and sibling states reject without repair', async (t) => {
  const scenarios = [
    {
      label: 'special-mode',
      async mutate({ databasePath }) { await chmod(databasePath, 0o4600); },
    },
    {
      label: 'hard-link',
      async mutate({ root, databasePath }) {
        await link(databasePath, join(root, 'external-database-link'));
      },
    },
    {
      label: 'unexpected-sidecar',
      async mutate({ stateDirectory }) {
        await writeFile(join(stateDirectory, 'recovery.sqlite-wal'), 'hostile', {
          mode: 0o600,
        });
      },
    },
    {
      label: 'state-symlink',
      async mutate({ evidence, stateDirectory }) {
        const moved = join(evidence, 'ios-capture-state-real');
        await rename(stateDirectory, moved);
        await symlink('ios-capture-state-real', stateDirectory);
      },
    },
  ];
  for (const scenario of scenarios) {
    const root = await fixture(t, `hostile-${scenario.label}`);
    await openInChild(root);
    const evidence = join(root, '.native-build', 'b3', 'evidence');
    const stateDirectory = join(evidence, 'ios-capture-state');
    const databasePath = join(stateDirectory, 'recovery.sqlite');
    await scenario.mutate({ root, evidence, stateDirectory, databasePath });
    await assert.rejects(openInChild(root), /invalid|policy|escaped|sibling/i,
      scenario.label);
  }
});

test('damaged SQLite bytes reject without being rewritten', async (t) => {
  const root = await fixture(t, 'corrupt-bytes');
  await openInChild(root);
  const databasePath = join(
    root, '.native-build', 'b3', 'evidence', 'ios-capture-state', 'recovery.sqlite',
  );
  const handle = await openFile(databasePath, 'r+');
  await handle.write(Buffer.alloc(32, 0xff), 0, 32, 100);
  await handle.sync();
  await handle.close();
  const before = await fileSha256(databasePath);
  await assert.rejects(openInChild(root), /database|malformed|corrupt|invalid/i);
  assert.equal(await fileSha256(databasePath), before);
});

test('every connection installs defensive mode, disables extensions and denies mutation authorisers',
  async (t) => {
    const root = await fixture(t, 'authoriser');
    const result = await openInChild(root, 'ios', 'authoriser-probe');
    assert.deepEqual(result, {
      ok: true,
      calls: [
        ['defensive', true],
        ['extension', false],
        ['authoriser'],
        ['authoriser'],
      ],
      decisions: {
        readPragma: 0,
        writePragma: 1,
        tempTable: 1,
        attach: 1,
        reindex: 1,
        analyse: 1,
      },
    });
  });

test('production open rejects a caller-selected path without evaluating it', async (t) => {
  const root = await fixture(t, 'closed-options');
  const helper = new URL(
    './helpers/b3-capture-state-options-child.mjs', import.meta.url,
  );
  const { stdout } = await execFileAsync(process.execPath, [
    '--experimental-test-module-mocks', helper.pathname,
  ], { cwd: root });
  assert.deepEqual(JSON.parse(stdout), { ok: true, evaluated: false });
});

test('platform authority is snapshotted once before validation and path use', async (t) => {
  const root = await fixture(t, 'platform-snapshot');
  const helper = new URL(
    './helpers/b3-capture-state-platform-getter-child.mjs', import.meta.url,
  );
  const { stdout } = await execFileAsync(process.execPath, [
    '--experimental-test-module-mocks', helper.pathname,
  ], { cwd: root });
  assert.deepEqual(JSON.parse(stdout), { outcome: 'opened', getterCalls: 1 });
  await assert.rejects(
    lstat(join(root, '.native-build', 'escaped-capture-state')),
    { code: 'ENOENT' },
  );
});
