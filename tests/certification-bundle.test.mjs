import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createCertificationManifest,
  readBoundedRegularFile,
  serialiseCertificationManifest,
  validateCertificationTopology,
} from '../scripts/build-certification-bundle.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function validInput() {
  return {
    tag: 'cert-b4-development',
    repository: 'fol2/ks2-spelling',
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    evidenceTopology: {
      applicationCheckpoint: 'd'.repeat(40),
      evidenceCommit: 'e'.repeat(40),
    },
    sourceArchive: {
      fileName: `ks2-spelling-cert-b4-development-${'a'.repeat(40)}.tar`,
      byteSize: 29_000_000,
      sha256: 'c'.repeat(64),
    },
    evidenceFiles: [
      { path: 'reports/b4/domain-round-proof.json', byteSize: 240, sha256: 'e'.repeat(64) },
      { path: 'reports/b4/b4-development-report.json', byteSize: 180, sha256: 'f'.repeat(64) },
      { path: 'reports/b3/deterministic-proof.json', byteSize: 120, sha256: 'd'.repeat(64) },
    ],
    buildFiles: [
      { path: 'ios-compile.tar', byteSize: 300, sha256: '3'.repeat(64) },
      { path: 'domain-web.tar', byteSize: 100, sha256: '1'.repeat(64) },
      { path: 'android-compile.tar', byteSize: 200, sha256: '2'.repeat(64) },
    ],
  };
}

test('certification manifest binds the exact source tree and sorted committed evidence', () => {
  const manifest = createCertificationManifest(validInput());

  assert.deepEqual(manifest, {
    schemaVersion: 1,
    kind: 'ks2-spelling-development-milestone',
    tag: 'cert-b4-development',
    repository: 'fol2/ks2-spelling',
    source: {
      commit: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      archive: {
        fileName: `ks2-spelling-cert-b4-development-${'a'.repeat(40)}.tar`,
        byteSize: 29_000_000,
        sha256: 'c'.repeat(64),
      },
    },
    evidence: {
      applicationCheckpoint: 'd'.repeat(40),
      evidenceCommit: 'e'.repeat(40),
      files: [
        { path: 'reports/b3/deterministic-proof.json', byteSize: 120, sha256: 'd'.repeat(64) },
        { path: 'reports/b4/b4-development-report.json', byteSize: 180, sha256: 'f'.repeat(64) },
        { path: 'reports/b4/domain-round-proof.json', byteSize: 240, sha256: 'e'.repeat(64) },
      ],
      aggregateSha256: sha256(
        `reports/b3/deterministic-proof.json\u0000120\u0000${'d'.repeat(64)}\n` +
          `reports/b4/b4-development-report.json\u0000180\u0000${'f'.repeat(64)}\n` +
          `reports/b4/domain-round-proof.json\u0000240\u0000${'e'.repeat(64)}\n`,
      ),
    },
    builds: {
      files: [
        { path: 'android-compile.tar', byteSize: 200, sha256: '2'.repeat(64) },
        { path: 'domain-web.tar', byteSize: 100, sha256: '1'.repeat(64) },
        { path: 'ios-compile.tar', byteSize: 300, sha256: '3'.repeat(64) },
      ],
      aggregateSha256: sha256(
        `android-compile.tar\u0000200\u0000${'2'.repeat(64)}\n` +
          `domain-web.tar\u0000100\u0000${'1'.repeat(64)}\n` +
          `ios-compile.tar\u0000300\u0000${'3'.repeat(64)}\n`,
      ),
    },
    claims: {
      scope: 'development-milestone',
      signedDistribution: false,
      storeReadiness: false,
      productionReadiness: false,
    },
  });
  assert.equal(serialiseCertificationManifest(manifest), `${JSON.stringify(manifest, null, 2)}\n`);
});

test('certification manifest fails closed on unsafe tags, authority and evidence paths', () => {
  assert.throws(
    () => createCertificationManifest({ ...validInput(), tag: 'cert-../release' }),
    /certification tag/i,
  );
  assert.throws(
    () => createCertificationManifest({ ...validInput(), commit: 'not-a-commit' }),
    /source authority/i,
  );
  assert.throws(
    () =>
      createCertificationManifest({
        ...validInput(),
        evidenceFiles: [{ path: '.env', byteSize: 1, sha256: 'd'.repeat(64) }],
      }),
    /evidence path/i,
  );
  assert.throws(
    () => createCertificationManifest({
      ...validInput(),
      buildFiles: [{ path: '../ios.tar', byteSize: 1, sha256: 'd'.repeat(64) }],
    }),
    /build archive/i,
  );
});

test('certification manifest rejects duplicate evidence and archive metadata drift', () => {
  const duplicate = validInput().evidenceFiles[0];
  assert.throws(
    () => createCertificationManifest({ ...validInput(), evidenceFiles: [duplicate, duplicate] }),
    /duplicate evidence path/i,
  );
  assert.throws(
    () =>
      createCertificationManifest({
        ...validInput(),
        sourceArchive: { ...validInput().sourceArchive, fileName: 'different.tar' },
      }),
    /source archive/i,
  );
});

test('certification topology binds one immediate evidence successor to the tagged tree', () => {
  const input = {
    applicationCheckpoint: 'a'.repeat(40),
    evidenceCommit: 'b'.repeat(40),
    evidenceParent: 'a'.repeat(40),
    taggedCommit: 'c'.repeat(40),
    evidenceTree: 'd'.repeat(40),
    taggedTree: 'd'.repeat(40),
    changedPaths: [
      'reports/b4/domain-round-proof.json',
      'reports/b4/b4-development-report.json',
    ],
  };
  assert.deepEqual(validateCertificationTopology(input), {
    applicationCheckpoint: 'a'.repeat(40),
    evidenceCommit: 'b'.repeat(40),
  });
  assert.throws(
    () => validateCertificationTopology({ ...input, evidenceParent: 'f'.repeat(40) }),
    /immediate successor/i,
  );
  assert.throws(
    () => validateCertificationTopology({ ...input, taggedTree: 'f'.repeat(40) }),
    /tagged tree/i,
  );
  assert.throws(
    () => validateCertificationTopology({ ...input, changedPaths: ['src/app/main.js'] }),
    /evidence-only/i,
  );
});

test('certification inputs are bounded regular files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ks2-certification-input-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'evidence.json');
  const link = join(root, 'linked.json');
  await writeFile(file, 'data');
  await symlink(file, link);

  const accepted = await readBoundedRegularFile(file, { maximumBytes: 4 });
  assert.equal(accepted.bytes.toString('utf8'), 'data');
  await assert.rejects(
    readBoundedRegularFile(file, { maximumBytes: 3 }),
    /bounded regular file/i,
  );
  await assert.rejects(
    readBoundedRegularFile(link, { maximumBytes: 4 }),
    /bounded regular file/i,
  );
});
