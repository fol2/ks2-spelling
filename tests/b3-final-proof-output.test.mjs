import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { B3_CAPTURE_STATE_SCHEMA_SQL } from '../scripts/lib/b3-capture-state-schema.mjs';
import { publishB3FinalProofOutput } from '../scripts/lib/b3-final-proof-output.mjs';

const CLOUDFARE = 'reports/b3/cloudflare-sandbox-proof.json';
const IOS = 'reports/b3/ios-sandbox-proof.json';
const OUTPUTS = Object.freeze([
  CLOUDFARE,
  IOS,
  'reports/b3/ios-sandbox-proof.png',
  'reports/b3/android-sandbox-proof.json',
  'reports/b3/android-sandbox-proof.png',
  'reports/b3/b3-exit-report.json',
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fixture(t, label) {
  const root = await mkdtemp(join(tmpdir(), `b3-final-output-${label}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, '.native-build', 'b3', 'evidence');
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  for (const path of [
    join(root, '.native-build'), join(root, '.native-build', 'b3'), evidence,
  ]) await chmod(path, 0o700);
  const databasePath = join(evidence, 'publisher-proof.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(B3_CAPTURE_STATE_SCHEMA_SQL);
  database.close();
  await chmod(databasePath, 0o600);
  return { root, databasePath };
}

async function assertDatabaseUnchanged(databasePath, operation) {
  const before = sha256(await readFile(databasePath));
  await operation();
  assert.equal(sha256(await readFile(databasePath)), before);
}

test('final proof publisher creates once and accepts exact identical bytes without changing SQLite', async (t) => {
  const { root, databasePath } = await fixture(t, 'idempotent');
  const bytes = Buffer.from('{\n  "status": "pass"\n}\n');

  await assertDatabaseUnchanged(databasePath, async () => {
    const created = await publishB3FinalProofOutput({ root, output: CLOUDFARE, bytes });
    assert.deepEqual(created, {
      path: CLOUDFARE,
      sha256: sha256(bytes),
      status: 'created',
    });
  });
  await assertDatabaseUnchanged(databasePath, async () => {
    const identical = await publishB3FinalProofOutput({ root, output: CLOUDFARE, bytes });
    assert.equal(identical.status, 'identical');
  });
  assert.deepEqual(await readFile(join(root, CLOUDFARE)), bytes);
});

test('final proof publisher rejects partial, different, symlink and FIFO outputs without changing SQLite', async (t) => {
  const bytes = Buffer.from('{\n  "status": "pass"\n}\n');
  for (const [label, prepare] of [
    ['partial', async (path) => writeFile(path, bytes.subarray(0, 5), { mode: 0o600 })],
    ['different', async (path) => writeFile(path, Buffer.from('different'), { mode: 0o600 })],
    ['writable', async (path) => {
      await writeFile(path, bytes, { mode: 0o600 });
      await chmod(path, 0o666);
    }],
    ['symlink', async (path, root) => {
      const target = join(root, 'outside');
      await writeFile(target, bytes, { mode: 0o600 });
      await symlink(target, path);
    }],
    ['fifo', async (path) => {
      const { execFile } = await import('node:child_process');
      await new Promise((resolve, reject) => execFile('mkfifo', [path], (error) =>
        error ? reject(error) : resolve()));
    }],
  ]) await t.test(label, async (subtest) => {
    const { root, databasePath } = await fixture(subtest, label);
    await mkdir(join(root, 'reports/b3'), { recursive: true, mode: 0o700 });
    const path = join(root, CLOUDFARE);
    await prepare(path, root);
    await assertDatabaseUnchanged(databasePath, () => assert.rejects(
      publishB3FinalProofOutput({ root, output: CLOUDFARE, bytes }),
      /conflict|policy|regular|link|writable/i,
    ));
  });
});

test('final proof publisher accepts only a transient two-link final', async (t) => {
  const { root, databasePath } = await fixture(t, 'links');
  const reports = join(root, 'reports/b3');
  await mkdir(reports, { recursive: true, mode: 0o700 });
  const bytes = Buffer.from('{\n  "status": "pass"\n}\n');
  const finalPath = join(root, CLOUDFARE);
  const extraPath = join(reports, 'test-owned-extra-link');
  await writeFile(finalPath, bytes, { mode: 0o600 });
  await link(finalPath, extraPath);
  setTimeout(() => void unlink(extraPath), 15);
  await assertDatabaseUnchanged(databasePath, async () => {
    assert.equal((await publishB3FinalProofOutput({
      root, output: CLOUDFARE, bytes,
    })).status, 'identical');
  });

  await link(finalPath, extraPath);
  await assertDatabaseUnchanged(databasePath, () => assert.rejects(
    publishB3FinalProofOutput({ root, output: CLOUDFARE, bytes }),
    /link|conflict/i,
  ));
});

test('concurrent final proof publishers converge only for identical bytes', async (t) => {
  const identical = await fixture(t, 'concurrent-identical');
  const bytes = Buffer.from('{\n  "status": "pass"\n}\n');
  const outcomes = await Promise.all([
    publishB3FinalProofOutput({ root: identical.root, output: CLOUDFARE, bytes }),
    publishB3FinalProofOutput({ root: identical.root, output: CLOUDFARE, bytes }),
  ]);
  assert.deepEqual(outcomes.map(({ status }) => status).sort(), ['created', 'identical']);

  const different = await fixture(t, 'concurrent-different');
  const settled = await Promise.allSettled([
    publishB3FinalProofOutput({ root: different.root, output: IOS, bytes }),
    publishB3FinalProofOutput({
      root: different.root,
      output: IOS,
      bytes: Buffer.from('{\n  "status": "fail"\n}\n'),
    }),
  ]);
  assert.equal(settled.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(settled.filter(({ status }) => status === 'rejected').length, 1);
});

test('final proof publisher exposes only the six frozen output identities and snapshots input bytes', async (t) => {
  const { root } = await fixture(t, 'closed');
  await assert.rejects(
    publishB3FinalProofOutput({
      root, output: 'reports/b3/arbitrary.json', bytes: Buffer.from('{}\n'),
    }),
    /identity|output/i,
  );
  for (const [index, output] of OUTPUTS.entries()) {
    const isolated = await fixture(t, `closed-${index}`);
    assert.equal((await publishB3FinalProofOutput({
      root: isolated.root,
      output,
      bytes: Buffer.from(`frozen-output-${index}`),
    })).path, output);
  }
  const bytes = Buffer.from('{\n  "status": "pass"\n}\n');
  const publication = publishB3FinalProofOutput({ root, output: IOS, bytes });
  bytes.fill(0);
  await publication;
  assert.equal((await readFile(join(root, IOS), 'utf8')).includes('pass'), true);
});
