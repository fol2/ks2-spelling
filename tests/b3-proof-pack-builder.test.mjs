import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, cp, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  assertHostileZipPrecondition,
  buildHostileZip,
  expectedHostileZipRejection,
  verifyHostileZipCorpus,
} from './helpers/hostile-zip-builder.mjs';

const ROOT = new URL('../', import.meta.url);
const REQUIRED_HOSTILE_CATEGORIES = [
  'traversal-path', 'absolute-path', 'drive-path', 'backslash-path',
  'dot-segment', 'empty-segment', 'duplicate-path', 'case-fold-collision',
  'unicode-nfc-collision', 'creator-os-zero', 'creator-os-unknown',
  'mode-zero', 'mode-ambiguous', 'symlink-mode', 'hard-link-mode',
  'device-mode', 'fifo-mode', 'socket-mode', 'directory-mode',
  'local-name-mismatch', 'local-flag-mismatch', 'local-method-mismatch',
  'local-crc-mismatch', 'local-size-mismatch', 'duplicate-local-offset',
  'overlapping-local-offset', 'overlapping-data-range', 'central-directory-overlap',
  'truncated-offset', 'overflowing-offset', 'truncated-size', 'overflowing-size',
  'multiple-eocd', 'ambiguous-eocd', 'eocd-not-at-eof', 'prepended-junk',
  'trailing-junk', 'non-zero-extra-field', 'unknown-extra-field',
  'encrypted-flag', 'unknown-flag', 'unknown-compression-method',
  'member-comment', 'multi-disk', 'data-descriptor', 'zip64',
  'local-extracted-size-mismatch', 'undeclared-member', 'missing-member',
  'executable-extension', 'compressed-ceiling', 'extracted-ceiling',
  'file-count-ceiling',
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function md5(bytes) {
  return createHash('md5').update(bytes).digest('hex');
}

function runBuilder(outputDirectory, extraArguments = []) {
  return spawnSync(
    process.execPath,
    ['scripts/build-b3-proof-pack.mjs', '--output-directory', outputDirectory, ...extraArguments],
    { cwd: new URL('.', ROOT), encoding: 'utf8' },
  );
}

test('hostile ZIP manifest freezes actual byte-stable fixtures for every approved category', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('tests/fixtures/b3-hostile-zips/manifest.json', ROOT), 'utf8'),
  );
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.fixtures.map(({ category }) => category), REQUIRED_HOSTILE_CATEGORIES);
  assert.equal(new Set(manifest.fixtures.map(({ file }) => file)).size, manifest.fixtures.length);

  for (const fixture of manifest.fixtures) {
    assert.deepEqual(Object.keys(fixture), ['category', 'file', 'sha256', 'bytes']);
    const bytes = await readFile(new URL(`tests/fixtures/b3-hostile-zips/${fixture.file}`, ROOT));
    assert.equal(bytes.length, fixture.bytes, fixture.category);
    assert.equal(sha256(bytes), fixture.sha256, fixture.category);
    assert.equal(bytes.includes(Buffer.from('PK\x03\x04', 'binary')), true, fixture.category);
    assert.doesNotThrow(
      () => assertHostileZipPrecondition(fixture.category, bytes),
      fixture.category,
    );
  }
});

test('hostile ZIP corpus verifier rejects extra, missing, hash-drift and regenerated-byte drift', async (t) => {
  const source = new URL('tests/fixtures/b3-hostile-zips', ROOT);
  for (const mutation of [
    async (directory) => writeFile(join(directory, 'extra.zip'), 'PK\x03\x04extra'),
    async (directory) => unlink(join(directory, 'absolute-path.zip')),
    async (directory) => {
      const manifestPath = join(directory, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.fixtures[0].sha256 = '0'.repeat(64);
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    },
    async (directory) => {
      const path = join(directory, 'absolute-path.zip');
      const bytes = await readFile(path);
      bytes[bytes.length - 1] ^= 1;
      await writeFile(path, bytes);
    },
  ]) {
    const directory = await mkdtemp(join(tmpdir(), 'ks2-b3-hostile-corpus-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await cp(source, directory, { recursive: true });
    await mutation(directory);
    await assert.rejects(
      verifyHostileZipCorpus(directory),
      /hostile ZIP corpus|extra|missing|SHA-256|byte/i,
    );
  }
});

test('overlapping-local-offset is two valid local records with a nested byte range', () => {
  const bytes = buildHostileZip('overlapping-local-offset');
  const endOffset = bytes.lastIndexOf(Buffer.from('PK\x05\x06', 'binary'));
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  const firstOffset = bytes.readUInt32LE(centralOffset + 42);
  const firstNameLength = bytes.readUInt16LE(centralOffset + 28);
  const firstExtraLength = bytes.readUInt16LE(centralOffset + 30);
  const firstCommentLength = bytes.readUInt16LE(centralOffset + 32);
  const secondCentral = centralOffset + 46 + firstNameLength + firstExtraLength + firstCommentLength;
  const secondOffset = bytes.readUInt32LE(secondCentral + 42);
  const firstLocalNameLength = bytes.readUInt16LE(firstOffset + 26);
  const firstLocalExtraLength = bytes.readUInt16LE(firstOffset + 28);
  const firstCompressedBytes = bytes.readUInt32LE(firstOffset + 18);
  const firstRecordEnd = firstOffset + 30 + firstLocalNameLength + firstLocalExtraLength
    + firstCompressedBytes;
  const secondLocalNameLength = bytes.readUInt16LE(secondOffset + 26);
  const secondLocalExtraLength = bytes.readUInt16LE(secondOffset + 28);
  const secondDataStart = secondOffset + 30 + secondLocalNameLength + secondLocalExtraLength;

  assert.equal(bytes.readUInt32LE(firstOffset), 0x04034b50);
  assert.equal(bytes.readUInt32LE(secondOffset), 0x04034b50);
  assert.ok(secondOffset > firstOffset && secondOffset < firstRecordEnd);
  assert.ok(firstRecordEnd <= secondDataStart, 'local records overlap without data overlap');
  assert.doesNotThrow(() => assertHostileZipPrecondition('overlapping-local-offset', bytes));
  assert.equal(
    expectedHostileZipRejection('overlapping-local-offset'),
    'overlapping-local-record-range',
  );
});

test('overlapping-data-range has independently measured valid member data overlap', () => {
  const bytes = buildHostileZip('overlapping-data-range');
  const endOffset = bytes.lastIndexOf(Buffer.from('PK\x05\x06', 'binary'));
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  const firstNameLength = bytes.readUInt16LE(centralOffset + 28);
  const firstExtraLength = bytes.readUInt16LE(centralOffset + 30);
  const firstCommentLength = bytes.readUInt16LE(centralOffset + 32);
  const secondCentral = centralOffset + 46 + firstNameLength + firstExtraLength
    + firstCommentLength;
  const ranges = [centralOffset, secondCentral].map((entryOffset) => {
    const localOffset = bytes.readUInt32LE(entryOffset + 42);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    return {
      localOffset,
      dataStart,
      dataEnd: dataStart + bytes.readUInt32LE(localOffset + 18),
    };
  });
  const [outer, nested] = ranges;

  assert.ok(outer.dataStart < nested.dataEnd && nested.dataStart < outer.dataEnd);
  assert.ok(nested.localOffset > outer.localOffset && nested.localOffset < outer.dataEnd);
  assert.doesNotThrow(() => assertHostileZipPrecondition('overlapping-data-range', bytes));
  assert.equal(
    expectedHostileZipRejection('overlapping-data-range'),
    'overlapping-member-data-range',
  );
  assert.notDeepEqual(bytes, buildHostileZip('overlapping-local-offset'));
});

test('central-directory-overlap remains parseable and bounded inside member data', () => {
  const bytes = buildHostileZip('central-directory-overlap');
  const endOffset = bytes.lastIndexOf(Buffer.from('PK\x05\x06', 'binary'));
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const localOffset = bytes.readUInt32LE(centralOffset + 42);
  const localNameLength = bytes.readUInt16LE(localOffset + 26);
  const localExtraLength = bytes.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataStart + bytes.readUInt32LE(localOffset + 18);

  assert.equal(bytes.readUInt32LE(centralOffset), 0x02014b50);
  assert.equal(centralOffset + centralSize, endOffset);
  assert.ok(centralOffset >= dataStart && centralOffset < dataEnd);
  assert.equal(dataEnd, endOffset);
  assert.doesNotThrow(() => assertHostileZipPrecondition('central-directory-overlap', bytes));
  assert.equal(
    expectedHostileZipRejection('central-directory-overlap'),
    'central-directory-member-overlap',
  );
});

test('two clean proof-pack builds are byte-identical and match tracked authorities', async (t) => {
  const first = await mkdtemp(join(tmpdir(), 'ks2-b3-pack-first-'));
  const second = await mkdtemp(join(tmpdir(), 'ks2-b3-pack-second-'));
  t.after(() => Promise.all([
    rm(first, { recursive: true, force: true }),
    rm(second, { recursive: true, force: true }),
  ]));

  for (const directory of [first, second]) {
    const result = runBuilder(directory);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }

  const trackedEnvelope = await readFile(new URL('tests/fixtures/b3-signed-manifest.json', ROOT));
  const trackedReport = JSON.parse(
    await readFile(new URL('reports/b3/b3-proof-pack-build.json', ROOT), 'utf8'),
  );
  const authority = JSON.parse(
    await readFile(new URL('config/b3-pack-object-authority.json', ROOT), 'utf8'),
  );
  const paths = ['b3-sandbox-proof.zip', 'canonical-manifest.json', 'signed-manifest.json', 'b3-proof-pack-build.json'];
  for (const path of paths) {
    const firstBytes = await readFile(join(first, path));
    const secondBytes = await readFile(join(second, path));
    assert.deepEqual(firstBytes, secondBytes, path);
  }
  assert.deepEqual(await readFile(join(first, 'signed-manifest.json')), trackedEnvelope);
  assert.deepEqual(
    JSON.parse(await readFile(join(first, 'b3-proof-pack-build.json'), 'utf8')),
    trackedReport,
  );

  assert.equal(authority.schemaVersion, 1);
  assert.equal(authority.bucketName, 'ks2-spelling-b3-sandbox-packs');
  assert.equal(authority.packId, 'b3-sandbox-proof');
  assert.equal(authority.version, '1.0.0-b3.1');
  assert.equal(authority.objects.length, 2);
  assert.deepEqual(authority.objects.map(({ role }) => role), ['archive', 'signed-manifest']);
  assert.equal(trackedReport.signedEnvelope.sha256, sha256(trackedEnvelope));
  assert.equal(authority.objects[1].metadata['b3-envelope-sha256'], sha256(trackedEnvelope));

  const objectBytes = [
    await readFile(join(first, 'b3-sandbox-proof.zip')),
    await readFile(join(first, 'signed-manifest.json')),
  ];
  assert.deepEqual(
    authority.objects.map(({ key }) => key),
    [
      'packs/b3-sandbox-proof/1.0.0-b3.1/b3-sandbox-proof.zip',
      'packs/b3-sandbox-proof/1.0.0-b3.1/signed-manifest.json',
    ],
  );
  for (const [index, object] of authority.objects.entries()) {
    assert.deepEqual(
      Object.keys(object),
      ['role', 'key', 'bytes', 'sha256', 'etag', 'metadata'],
    );
    assert.equal(object.bytes, objectBytes[index].length);
    assert.equal(object.sha256, sha256(objectBytes[index]));
    assert.equal(object.etag, md5(objectBytes[index]));
    assert.equal(object.metadata['b3-role'], object.role);
    assert.equal(object.metadata['b3-sha256'], object.sha256);
    assert.equal(object.metadata['b3-size'], String(object.bytes));
  }

  const proofPack = JSON.parse(
    await readFile(new URL('config/b3-proof-pack.json', ROOT), 'utf8'),
  );
  const signature = await readFile(
    new URL('tests/fixtures/keys/b3-sandbox-proof-manifest-signature.der', ROOT),
  );
  assert.equal(sha256(signature), proofPack.signatureDerSha256);
  assert.equal(sha256(trackedEnvelope), proofPack.signedEnvelopeSha256);
});

test('final builder is verify-only and rejects every authoring or signing option', async (t) => {
  const output = await mkdtemp(join(tmpdir(), 'ks2-b3-pack-options-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  for (const option of [
    '--author-fixture-input', '--sign', '--signing-key', '--private-key',
    '--emit-signing-input', '--author',
  ]) {
    const result = runBuilder(output, [option]);
    assert.notEqual(result.status, 0, option);
    assert.match(`${result.stderr}\n${result.stdout}`, /unknown|unsupported|verify-only|author/i, option);
  }

  const source = await readFile(new URL('scripts/build-b3-proof-pack.mjs', ROOT), 'utf8');
  assert.doesNotMatch(source, /createPrivateKey|private\.pem|private-key|\.sign\(|signing-input\.bin/);
  await assert.rejects(access(join(output, 'signing-input.bin')));
});
