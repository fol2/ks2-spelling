import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';

import downloadableTable from '../config/downloadable-pack-authorities.json' with { type: 'json' };
import {
  PRODUCTION_PACK_IDS,
  PRODUCTION_PACK_OBJECT_AUTHORITY_RELATIVE,
  PRODUCTION_PACK_OBJECT_BUCKET,
  PRODUCTION_PACK_OBJECT_FORBIDDEN_SUBSTRINGS,
  PRODUCTION_PACK_OBJECT_ROLES,
  PRODUCTION_PACK_VERSION,
  PRODUCTION_SIGNING_KEY_ID,
  assertDocumentsMatch,
  assertProductionPackObjectAuthority,
  assertProductionPackObjectAuthorityBytes,
  assertProductionPackObjectAuthorityMatchesGateway,
  assertProductionPackObjectIdentities,
  buildProductionPackObjectAuthorityFromLive,
  crossCheckLocalCeremonyBytes,
  expectedObjectKey,
  expectedProductionObjectKeys,
  hashObjectBytes,
  serialiseProductionPackObjectAuthority,
} from '../scripts/lib/production-pack-object-authority.mjs';
import {
  createCeremonyReader,
  generateProductionPackObjectAuthority,
  readCloudflareAccessToken,
} from '../scripts/generate-production-pack-object-authority.mjs';

const ROOT = join(import.meta.dirname, '..');

function envelopeBytes(packId) {
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    algorithm: 'ECDSA_P256_SHA256_DER',
    keyId: PRODUCTION_SIGNING_KEY_ID,
    payloadEncoding: 'RFC8785_UTF8',
    domain: 'ks2-spelling-pack-manifest-v1',
    canonicalManifestBase64: Buffer.from(packId).toString('base64'),
    signatureDerBase64: Buffer.from(packId).toString('base64'),
  }, null, 2)}\n`, 'utf8');
}

function syntheticPackObjects() {
  const objects = [];
  for (const packId of PRODUCTION_PACK_IDS) {
    const archive = Buffer.from(`archive-bytes:${packId}`);
    const manifest = envelopeBytes(packId);
    objects.push({
      key: expectedObjectKey(packId, 'archive'),
      bytes: archive,
    });
    objects.push({
      key: expectedObjectKey(packId, 'signed-manifest'),
      bytes: manifest,
    });
  }
  return objects;
}

function listingFromObjects(objects, mutate) {
  return objects.map((object) => {
    const hashed = hashObjectBytes(object.bytes);
    const entry = {
      key: object.key,
      size: hashed.bytes,
      etag: hashed.etag,
      custom_metadata: {},
    };
    mutate?.(entry, object);
    return entry;
  });
}

function syntheticReaders(objects, {
  listingMutate,
  getMutate,
} = {}) {
  const byKey = new Map(objects.map((object) => [object.key, object.bytes]));
  return {
    listObjects: async () => listingFromObjects(objects, listingMutate),
    getObject: async (key) => {
      const bytes = Buffer.from(byKey.get(key));
      return getMutate ? getMutate(key, bytes) : bytes;
    },
  };
}

async function validDocument() {
  return buildProductionPackObjectAuthorityFromLive(syntheticReaders(syntheticPackObjects()));
}

async function sourceFiles(relativeDir) {
  const directory = join(ROOT, relativeDir);
  const files = [];
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return files;
}

test('the production layout pins fifteen Full-KS2 shard ids, versions and thirty object keys', () => {
  assert.deepEqual(PRODUCTION_PACK_IDS, [
    'full-ks2-shard-01', 'full-ks2-shard-02', 'full-ks2-shard-03', 'full-ks2-shard-04',
    'full-ks2-shard-05', 'full-ks2-shard-06', 'full-ks2-shard-07', 'full-ks2-shard-08',
    'full-ks2-shard-09', 'full-ks2-shard-10', 'full-ks2-shard-11', 'full-ks2-shard-12',
    'full-ks2-shard-13', 'full-ks2-shard-14', 'full-ks2-shard-15',
  ]);
  assert.equal(PRODUCTION_PACK_VERSION, '1.0.0');
  assert.deepEqual([...PRODUCTION_PACK_OBJECT_ROLES], ['archive', 'signed-manifest']);
  const keys = expectedProductionObjectKeys();
  assert.equal(keys.length, 30);
  assert.equal(new Set(keys).size, 30);
  assert.equal(keys[0], 'packs/full-ks2-shard-01/1.0.0/full-ks2-shard-01-1.0.0.zip');
  assert.equal(keys[1], 'packs/full-ks2-shard-01/1.0.0/signed-manifest.json');
  assert.equal(keys[28], 'packs/full-ks2-shard-15/1.0.0/full-ks2-shard-15-1.0.0.zip');
  assert.equal(keys[29], 'packs/full-ks2-shard-15/1.0.0/signed-manifest.json');
});

test('a synthetic fifteen-pack snapshot builds a closed multi-pack production document', async () => {
  const document = await validDocument();
  assert.equal(document.bucketName, PRODUCTION_PACK_OBJECT_BUCKET);
  assert.equal(document.packs.length, 15);
  assert.equal(document.packs.flatMap((pack) => pack.objects).length, 30);
  assert.equal(document.packs[0].objects[0].metadata && Object.keys(document.packs[0].objects[0].metadata).length, 0);
  assertProductionPackObjectIdentities(serialiseProductionPackObjectAuthority(document));
});

test('the single-pack sandbox shape is not a production pack-object authority', () => {
  const sandbox = {
    schemaVersion: 1,
    bucketName: PRODUCTION_PACK_OBJECT_BUCKET,
    packId: 'full-ks2-shard-01',
    version: '1.0.0',
    objects: [],
  };
  assert.throws(() => assertProductionPackObjectAuthority(sandbox), /closed document/i);
});

test('validator mutations of pack count, object coverage, identities and metadata fail closed', async () => {
  const document = await validDocument();
  const mutations = [
    (value) => { value.extra = true; },
    (value) => { value.bucketName = 'ks2-spelling-b3-sandbox-packs'; },
    (value) => { value.packs = value.packs.slice(0, 14); },
    (value) => { value.packs[0].packId = 'b3-sandbox-proof'; },
    (value) => { value.packs[0].version = '9.9.9'; },
    (value) => { value.packs[0].objects = [value.packs[0].objects[0]]; },
    (value) => { value.packs[0].objects[1].metadata = { 'b3-role': 'signed-manifest' }; },
    (value) => { value.packs[0].objects[0].sha256 = 'not-a-digest'; },
    (value) => { value.packs[0].objects.reverse(); },
    (value) => {
      value.packs.push(structuredClone(value.packs[0]));
      value.packs[15].packId = 'full-ks2-shard-16';
    },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(document);
    mutate(candidate);
    assert.throws(() => assertProductionPackObjectAuthority(candidate), TypeError);
  }
});

test('synthetic listing drift in count, extra keys, missing keys or etag mismatch fails closed', async () => {
  const objects = syntheticPackObjects();
  await assert.rejects(
    buildProductionPackObjectAuthorityFromLive(syntheticReaders(objects.slice(0, 29))),
    /exactly 30 objects/i,
  );
  await assert.rejects(
    buildProductionPackObjectAuthorityFromLive(syntheticReaders([
      ...objects,
      { key: 'packs/extra/1.0.0/extra.zip', bytes: Buffer.from('extra') },
    ])),
    /exactly 30 objects/i,
  );
  await assert.rejects(
    buildProductionPackObjectAuthorityFromLive(syntheticReaders(objects, {
      listingMutate: (entry) => {
        if (entry.key.endsWith('signed-manifest.json')) entry.etag = 'a'.repeat(32);
      },
    })),
    /differs from the single-part listing etag/i,
  );
  await assert.rejects(
    buildProductionPackObjectAuthorityFromLive(syntheticReaders(objects, {
      getMutate: (key, bytes) => (key.includes('shard-01') && key.endsWith('.zip')
        ? Buffer.concat([bytes, Buffer.from('x')])
        : bytes),
    })),
    /differs from the listing/i,
  );
});

test('a synthetic signed-manifest that names the sandbox test key is rejected', async () => {
  const objects = syntheticPackObjects();
  const hostile = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    algorithm: 'ECDSA_P256_SHA256_DER',
    keyId: 'b3-test-p256-2026-07',
    payloadEncoding: 'RFC8785_UTF8',
    domain: 'ks2-spelling-pack-manifest-v1',
    canonicalManifestBase64: 'Zg==',
    signatureDerBase64: 'Zg==',
  }, null, 2)}\n`);
  objects[1] = { key: objects[1].key, bytes: hostile };
  await assert.rejects(
    buildProductionPackObjectAuthorityFromLive(syntheticReaders(objects)),
    /b3-test-p256-2026-07|must not contain sandbox identity/i,
  );
});

test('local ceremony MD5 must match the declared single-part etag when a ceremony file is present', async () => {
  const objects = syntheticPackObjects();
  const archive = objects[0];
  const hashed = hashObjectBytes(archive.bytes);
  assert.equal(
    crossCheckLocalCeremonyBytes({
      key: archive.key,
      localBytes: archive.bytes,
      liveBytes: hashed.bytes,
      liveSha256: hashed.sha256,
      liveEtag: hashed.etag,
    }),
    true,
  );
  assert.throws(
    () => crossCheckLocalCeremonyBytes({
      key: archive.key,
      localBytes: Buffer.concat([archive.bytes, Buffer.from('nope')]),
      liveBytes: hashed.bytes,
      liveSha256: hashed.sha256,
      liveEtag: hashed.etag,
    }),
    /local ceremony MD5/i,
  );
  const document = await buildProductionPackObjectAuthorityFromLive({
    ...syntheticReaders(objects),
    readCeremonyObject: async (key) => (
      key === archive.key ? archive.bytes : null
    ),
  });
  assert.equal(document.packs[0].objects[0].etag, hashed.etag);
  await assert.rejects(
    buildProductionPackObjectAuthorityFromLive({
      ...syntheticReaders(objects),
      readCeremonyObject: async (key) => (
        key === archive.key ? Buffer.from('stale-ceremony') : null
      ),
    }),
    /local ceremony MD5/i,
  );
});

test('the ceremony reader accepts both the wizard packs/ layout and the unprefixed tree', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-ceremony-'));
  const objects = syntheticPackObjects();
  const archive = objects[0];
  try {
    await mkdir(join(directory, dirname(archive.key)), { recursive: true });
    await writeFile(join(directory, archive.key), archive.bytes);
    const prefixed = createCeremonyReader(directory);
    assert.deepEqual(await prefixed(archive.key), archive.bytes);
    const unprefixedRoot = await mkdtemp(join(tmpdir(), 'ks2-ceremony-flat-'));
    const relativeKey = archive.key.replace(/^packs\//u, '');
    await mkdir(join(unprefixedRoot, dirname(relativeKey)), { recursive: true });
    await writeFile(join(unprefixedRoot, relativeKey), archive.bytes);
    const unprefixed = createCeremonyReader(unprefixedRoot);
    assert.deepEqual(await unprefixed(archive.key), archive.bytes);
    await rm(unprefixedRoot, { recursive: true, force: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('check mode fails when a synthetic snapshot drifts from the committed document', async () => {
  const objects = syntheticPackObjects();
  const document = await generateProductionPackObjectAuthority({
    root: ROOT,
    ...syntheticReaders(objects),
  });
  const drifted = syntheticPackObjects();
  drifted[0] = { key: drifted[0].key, bytes: Buffer.concat([drifted[0].bytes, Buffer.from('drift')]) };
  const driftedDocument = await generateProductionPackObjectAuthority({
    root: ROOT,
    ...syntheticReaders(drifted),
  });
  assert.throws(
    () => assertDocumentsMatch(
      driftedDocument,
      document,
      'live bucket differs from the committed production pack-object authority',
    ),
    /live bucket differs/i,
  );
});

test('src and gateway runtime modules do not import the production pack-object document', async () => {
  const needle = 'ks2-pack-object-authority-production';
  const files = [
    ...(await sourceFiles('src')),
    ...(await sourceFiles('gateway/src')),
  ];
  const hits = [];
  for (const path of files) {
    const text = await readFile(path, 'utf8');
    if (text.includes(needle)) hits.push(relative(ROOT, path));
  }
  assert.deepEqual(hits, []);
});

test('the committed production document covers fifteen packs with production-only identities', async () => {
  const bytes = await readFile(join(ROOT, PRODUCTION_PACK_OBJECT_AUTHORITY_RELATIVE));
  const document = assertProductionPackObjectAuthorityBytes(bytes);
  await assertProductionPackObjectAuthorityMatchesGateway(ROOT, document);
  assert.equal(document.packs.length, 15);
  assert.equal(document.packs.flatMap((pack) => pack.objects).length, 30);
  assert.deepEqual(document.packs.map((pack) => `${pack.packId}@${pack.version}`), PRODUCTION_PACK_IDS.map(
    (packId) => `${packId}@${PRODUCTION_PACK_VERSION}`,
  ));
  const serialised = bytes.toString('utf8');
  for (const forbidden of PRODUCTION_PACK_OBJECT_FORBIDDEN_SUBSTRINGS) {
    assert.equal(serialised.includes(forbidden), false, forbidden);
  }
  const sandbox = JSON.parse(
    await readFile(join(ROOT, 'config/b3-pack-object-authority.json'), 'utf8'),
  );
  for (const object of sandbox.objects) {
    assert.equal(serialised.includes(object.etag), false, object.etag);
    assert.equal(serialised.includes(object.sha256), false, object.sha256);
  }
});

test('committed archive facts agree with the authoring-report payload hashes; that is local consistency, not live proof', async () => {
  const document = assertProductionPackObjectAuthorityBytes(
    await readFile(join(ROOT, PRODUCTION_PACK_OBJECT_AUTHORITY_RELATIVE)),
  );
  const report = JSON.parse(
    await readFile(join(ROOT, 'config/packs/full-ks2-shards/authoring-report.json'), 'utf8'),
  );
  assert.equal(report.shards.length, 15);
  for (const pack of document.packs) {
    const shard = report.shards.find((row) => row.packId === pack.packId);
    const archive = pack.objects.find((object) => object.role === 'archive');
    assert.ok(shard, pack.packId);
    assert.equal(archive.bytes, shard.archiveBytes);
    assert.equal(archive.sha256, shard.archiveSha256);
    assert.equal(archive.etag, shard.archiveMd5Etag);
  }
});

test('committed manifest object facts are not the sandbox-signed downloadable-pack registry envelopes', async () => {
  const document = assertProductionPackObjectAuthorityBytes(
    await readFile(join(ROOT, PRODUCTION_PACK_OBJECT_AUTHORITY_RELATIVE)),
  );
  assert.equal(downloadableTable.packs.length, 15);
  for (const pack of document.packs) {
    const row = downloadableTable.packs.find((entry) => entry.packId === pack.packId);
    const manifest = pack.objects.find((object) => object.role === 'signed-manifest');
    assert.ok(row, pack.packId);
    assert.notEqual(manifest.etag, row.manifestEtag);
    assert.notEqual(manifest.sha256, row.manifestSha256);
    assert.notEqual(manifest.bytes, row.manifestBytes);
  }
});

test('mutating the committed production document off the closed fifteen-pack shape fails the byte and identity contracts', async () => {
  const bytes = await readFile(join(ROOT, PRODUCTION_PACK_OBJECT_AUTHORITY_RELATIVE));
  const dropped = JSON.parse(bytes.toString('utf8'));
  dropped.packs.pop();
  assert.throws(() => assertProductionPackObjectAuthority(dropped), /fifteen Full-KS2 shard packs/i);
  const extraObject = JSON.parse(bytes.toString('utf8'));
  extraObject.packs[0].objects.push(structuredClone(extraObject.packs[0].objects[0]));
  assert.throws(() => assertProductionPackObjectAuthority(extraObject), /exactly two objects/i);
  const hostile = `${bytes.toString('utf8').slice(0, -2)},\n  "note": "b3-sandbox-proof"\n}\n`;
  assert.throws(
    () => assertProductionPackObjectIdentities(hostile),
    /b3-sandbox-proof/i,
  );
});

test('a missing Cloudflare OAuth session fails as a visible re-consent gate and does not invent object facts', async () => {
  await assert.rejects(
    readCloudflareAccessToken({
      env: {},
      home: join(tmpdir(), 'ks2-no-wrangler-home'),
      readFileImpl: async () => {
        throw new Error('missing');
      },
    }),
    /Re-consent with a browser `wrangler login`/i,
  );
});
