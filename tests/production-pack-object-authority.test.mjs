import assert from 'node:assert/strict';
import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';

import downloadableTable from '../config/downloadable-pack-authorities.json' with { type: 'json' };
import productionKeyring from '../config/production/pack-signing-public-keys.json' with { type: 'json' };
import { canonicaliseRfc8785Bytes } from '../src/domain/packs/rfc8785.js';
import {
  PACK_SIGNING_ALGORITHM,
  assertCanonicalP256Der,
  createPackSigningInput,
} from '../src/domain/packs/signed-manifest-contract.js';
import {
  PRODUCTION_PACK_IDS,
  PRODUCTION_PACK_OBJECT_AUTHORITY_RELATIVE,
  PRODUCTION_PACK_OBJECT_BUCKET,
  PRODUCTION_PACK_OBJECT_FORBIDDEN_SUBSTRINGS,
  PRODUCTION_PACK_OBJECT_ROLES,
  PRODUCTION_PACK_VERSION,
  PRODUCTION_REQUIRED_ENTITLEMENT_ID,
  PRODUCTION_SIGNING_KEY_ID,
  PRODUCTION_VERIFICATION_INSTANT,
  archiveNameForPack,
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
  readCompleteCeremonyDirectory,
  serialiseProductionPackObjectAuthority,
  verifyProductionSignedManifestEnvelope,
} from '../scripts/lib/production-pack-object-authority.mjs';
import {
  generateProductionPackObjectAuthority,
  main as generateProductionPackObjectAuthorityMain,
  readCloudflareAccessToken,
} from '../scripts/generate-production-pack-object-authority.mjs';
import { EXIT_CODES } from '../scripts/lib/run-command.mjs';

const ROOT = join(import.meta.dirname, '..');

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function closedProductionManifest({
  packId,
  version = PRODUCTION_PACK_VERSION,
  archiveBytes,
  archiveName = archiveNameForPack(packId, version),
  archiveSha256,
  archiveByteCount,
  requiredEntitlementId = PRODUCTION_REQUIRED_ENTITLEMENT_ID,
}) {
  const hashed = hashObjectBytes(archiveBytes);
  return {
    allowedExtensions: ['.json', '.m4a'],
    archive: {
      bytes: archiveByteCount ?? hashed.bytes,
      name: archiveName,
      sha256: archiveSha256 ?? hashed.sha256,
    },
    ceilings: {
      compressedBytes: 33_554_432,
      extractedBytes: 33_554_432,
      fileCount: 1_024,
    },
    files: [{
      bytes: 1,
      path: 'catalogue.json',
      sha256: 'a'.repeat(64),
    }],
    packId,
    requiredEntitlementId,
    schemaVersion: 1,
    version,
  };
}

function createSyntheticProductionSigner({
  notBefore = '2026-08-17T00:00:00Z',
  notAfter = '2036-08-16T00:00:00Z',
} = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const keyring = {
    schemaVersion: 1,
    keys: [{
      keyId: PRODUCTION_SIGNING_KEY_ID,
      algorithm: PACK_SIGNING_ALGORITHM,
      publicKeySpkiDerBase64: publicKey.toString('base64'),
      publicKeySpkiSha256: createHash('sha256').update(publicKey).digest('hex'),
      testOnly: false,
      notBefore,
      notAfter,
      allowedEnvironments: ['production'],
      allowedPackIds: [...PRODUCTION_PACK_IDS],
    }],
  };
  function signPack(packId, {
    keyId = PRODUCTION_SIGNING_KEY_ID,
    version = PRODUCTION_PACK_VERSION,
    archiveBytes = Buffer.from(`archive-bytes:${packId}`),
    archiveName = archiveNameForPack(packId, version),
    omitArchive = false,
    incompleteArchiveOnly = false,
    archiveSha256,
    archiveByteCount,
    requiredEntitlementId,
    payload,
  } = {}) {
    const hashed = hashObjectBytes(archiveBytes);
    let body = payload;
    if (!body && omitArchive) {
      body = { packId, version };
    } else if (!body && incompleteArchiveOnly) {
      body = {
        packId,
        version,
        archive: {
          bytes: archiveByteCount ?? hashed.bytes,
          name: archiveName,
          sha256: archiveSha256 ?? hashed.sha256,
        },
      };
    } else if (!body) {
      body = closedProductionManifest({
        packId,
        version,
        archiveBytes,
        archiveName,
        archiveSha256,
        archiveByteCount,
        requiredEntitlementId,
      });
    }
    const canonical = canonicaliseRfc8785Bytes(body);
    const signatureDer = sign('sha256', createPackSigningInput(canonical), createPrivateKey(privateKey));
    assertCanonicalP256Der(signatureDer);
    return jsonBytes({
      schemaVersion: 1,
      algorithm: PACK_SIGNING_ALGORITHM,
      keyId,
      payloadEncoding: 'RFC8785_UTF8',
      domain: 'ks2-spelling-pack-manifest-v1',
      canonicalManifestBase64: Buffer.from(canonical).toString('base64'),
      signatureDerBase64: Buffer.from(signatureDer).toString('base64'),
    });
  }
  return { keyring, signPack, privateKeyPem: privateKey };
}

const SYNTHETIC_SIGNER = createSyntheticProductionSigner();

function syntheticPackObjects(signer = SYNTHETIC_SIGNER) {
  const objects = [];
  for (const packId of PRODUCTION_PACK_IDS) {
    objects.push({
      key: expectedObjectKey(packId, 'archive'),
      bytes: Buffer.from(`archive-bytes:${packId}`),
    });
    objects.push({
      key: expectedObjectKey(packId, 'signed-manifest'),
      bytes: signer.signPack(packId),
    });
  }
  return objects;
}

async function writeCanonicalCeremony(directory, objects) {
  for (const object of objects) {
    await mkdir(join(directory, dirname(object.key)), { recursive: true });
    await writeFile(join(directory, object.key), object.bytes);
  }
}

function ceremonyMap(objects) {
  return new Map(objects.map((object) => [object.key, object.bytes]));
}

function liveOptions(objects, extra = {}) {
  return {
    ...syntheticReaders(objects),
    ceremonyBytesByKey: extra.ceremonyBytesByKey,
    keyring: extra.keyring ?? SYNTHETIC_SIGNER.keyring,
    clock: extra.clock ?? (() => new Date(PRODUCTION_VERIFICATION_INSTANT)),
  };
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
  return buildProductionPackObjectAuthorityFromLive(liveOptions(syntheticPackObjects()));
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

test('synthetic listing drift in unique count, extra keys or etag mismatch fails closed', async () => {
  const objects = syntheticPackObjects();
  await assert.rejects(
    buildProductionPackObjectAuthorityFromLive(liveOptions(objects.slice(0, 29))),
    /exactly 30 objects, not 29/i,
  );
  await assert.rejects(
    buildProductionPackObjectAuthorityFromLive(liveOptions([
      ...objects,
      { key: 'packs/extra/1.0.0/extra.zip', bytes: Buffer.from('extra') },
    ])),
    /exactly 30 objects, not 31/i,
  );
  await assert.rejects(
    buildProductionPackObjectAuthorityFromLive({
      ...liveOptions(objects),
      ...syntheticReaders(objects, {
        listingMutate: (entry) => {
          if (entry.key.endsWith('signed-manifest.json')) entry.etag = 'a'.repeat(32);
        },
      }),
    }),
    /differs from the single-part listing etag/i,
  );
  await assert.rejects(
    buildProductionPackObjectAuthorityFromLive({
      ...liveOptions(objects),
      ...syntheticReaders(objects, {
        getMutate: (key, bytes) => (key.includes('shard-01') && key.endsWith('.zip')
          ? Buffer.concat([bytes, Buffer.from('x')])
          : bytes),
      }),
    }),
    /differs from the listing/i,
  );
});

test('a synthetic listing that duplicates one canonical key fails closed', async () => {
  const objects = syntheticPackObjects();
  await assert.rejects(
    buildProductionPackObjectAuthorityFromLive(liveOptions([...objects, objects[0]])),
    /exactly 30 objects, not 31|duplicate object packs\/full-ks2-shard-01\//i,
  );
  const duplicatedThirty = objects.map((object, index) => (index === objects.length - 1 ? objects[0] : object));
  await assert.rejects(
    buildProductionPackObjectAuthorityFromLive(liveOptions(duplicatedThirty)),
    /duplicate object packs\/full-ks2-shard-01\//i,
  );
});

test('a synthetic signed-manifest that names the sandbox test key is rejected', async () => {
  const objects = syntheticPackObjects();
  objects[1] = {
    key: objects[1].key,
    bytes: SYNTHETIC_SIGNER.signPack(PRODUCTION_PACK_IDS[0], { keyId: 'b3-test-p256-2026-07' }),
  };
  await assert.rejects(
    buildProductionPackObjectAuthorityFromLive(liveOptions(objects)),
    /b3-test-p256-2026-07|must not contain sandbox identity/i,
  );
});

test('a synthetic complete canonical ceremony directory matching live bytes is accepted', async () => {
  const objects = syntheticPackObjects();
  const hashed = hashObjectBytes(objects[0].bytes);
  assert.equal(
    crossCheckLocalCeremonyBytes({
      key: objects[0].key,
      localBytes: objects[0].bytes,
      liveBytes: hashed.bytes,
      liveSha256: hashed.sha256,
      liveEtag: hashed.etag,
    }),
    true,
  );
  const document = await buildProductionPackObjectAuthorityFromLive(
    liveOptions(objects, { ceremonyBytesByKey: ceremonyMap(objects) }),
  );
  assert.equal(document.packs[0].objects[0].etag, hashed.etag);
});

test('crossCheckLocalCeremonyBytes fails closed when local bytes are null rather than skipping', () => {
  const objects = syntheticPackObjects();
  const hashed = hashObjectBytes(objects[0].bytes);
  assert.throws(
    () => crossCheckLocalCeremonyBytes({
      key: objects[0].key,
      localBytes: null,
      liveBytes: hashed.bytes,
      liveSha256: hashed.sha256,
      liveEtag: hashed.etag,
    }),
    /ceremony is missing/i,
  );
});

test('deleting one ceremony archive from an otherwise complete synthetic tree fails closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-ceremony-missing-archive-'));
  const objects = syntheticPackObjects();
  try {
    await writeCanonicalCeremony(directory, objects);
    await unlink(join(directory, objects[0].key));
    await assert.rejects(
      readCompleteCeremonyDirectory({ ceremonyDir: directory }),
      /missing packs\/full-ks2-shard-01\/1\.0\.0\/full-ks2-shard-01-1\.0\.0\.zip/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('deleting one ceremony signed-manifest from an otherwise complete synthetic tree fails closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-ceremony-missing-manifest-'));
  const objects = syntheticPackObjects();
  try {
    await writeCanonicalCeremony(directory, objects);
    await unlink(join(directory, objects[1].key));
    await assert.rejects(
      readCompleteCeremonyDirectory({ ceremonyDir: directory }),
      /missing packs\/full-ks2-shard-01\/1\.0\.0\/signed-manifest\.json/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an unexpected extra ceremony file fails the complete synthetic tree contract', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-ceremony-extra-'));
  const objects = syntheticPackObjects();
  try {
    await writeCanonicalCeremony(directory, objects);
    await writeFile(join(directory, 'unexpected.txt'), 'nope');
    await assert.rejects(
      readCompleteCeremonyDirectory({ ceremonyDir: directory }),
      /extra unexpected\.txt/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ceremony-metadata.json inside the supplied object directory is an extra file and fails closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-ceremony-metadata-in-objects-'));
  const objects = syntheticPackObjects();
  try {
    await writeCanonicalCeremony(directory, objects);
    await writeFile(join(directory, 'ceremony-metadata.json'), jsonBytes({
      schemaVersion: 1,
      status: 'ready',
    }));
    await assert.rejects(
      readCompleteCeremonyDirectory({ ceremonyDir: directory }),
      /extra ceremony-metadata\.json/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ceremony-metadata.json inside packs/ is an extra object and fails closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-ceremony-metadata-packs-'));
  const objects = syntheticPackObjects();
  try {
    await writeCanonicalCeremony(directory, objects);
    await writeFile(join(directory, 'packs/ceremony-metadata.json'), jsonBytes({ status: 'ready' }));
    await assert.rejects(
      readCompleteCeremonyDirectory({ ceremonyDir: directory }),
      /extra packs\/ceremony-metadata\.json/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an unprefixed ceremony tree is not a complete canonical packs/ layout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-ceremony-unprefixed-'));
  const objects = syntheticPackObjects();
  try {
    for (const object of objects) {
      const relativeKey = object.key.replace(/^packs\//u, '');
      await mkdir(join(directory, dirname(relativeKey)), { recursive: true });
      await writeFile(join(directory, relativeKey), object.bytes);
    }
    await assert.rejects(
      readCompleteCeremonyDirectory({ ceremonyDir: directory }),
      /canonical packs\/<packId>\/<version>\/ layout/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a ceremony object whose injected readFile rejects with EACCES fails closed and is not mapped to skip', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-ceremony-unreadable-'));
  const objects = syntheticPackObjects();
  try {
    await writeCanonicalCeremony(directory, objects);
    const denied = join(directory, objects[0].key);
    await assert.rejects(
      readCompleteCeremonyDirectory({
        ceremonyDir: directory,
        readFileImpl: async (path, encoding) => {
          if (path === denied) {
            const error = new Error('EACCES: permission denied');
            error.code = 'EACCES';
            throw error;
          }
          return readFile(path, encoding);
        },
      }),
      /cannot read ceremony object packs\/full-ks2-shard-01\/1\.0\.0\/full-ks2-shard-01-1\.0\.0\.zip/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a synthetic ceremony archive whose bytes differ from the live GET fails closed', async () => {
  const objects = syntheticPackObjects();
  const drifted = objects.map((object, index) => (
    index === 0
      ? { key: object.key, bytes: Buffer.concat([object.bytes, Buffer.from('x')]) }
      : object
  ));
  await assert.rejects(
    buildProductionPackObjectAuthorityFromLive(
      liveOptions(objects, { ceremonyBytesByKey: ceremonyMap(drifted) }),
    ),
    /local ceremony MD5|local ceremony bytes/i,
  );
});

test('a synthetic ceremony signed-manifest whose hash differs from live GET bytes fails closed', async () => {
  const objects = syntheticPackObjects();
  const drifted = objects.map((object, index) => (
    index === 1
      ? { key: object.key, bytes: Buffer.concat([object.bytes, Buffer.from('\n')]) }
      : object
  ));
  await assert.rejects(
    buildProductionPackObjectAuthorityFromLive(
      liveOptions(objects, { ceremonyBytesByKey: ceremonyMap(drifted) }),
    ),
    /local ceremony MD5|local ceremony bytes/i,
  );
});

test('a synthetic live signed-manifest that is not valid JSON fails closed as a malformed envelope', async () => {
  const objects = syntheticPackObjects();
  objects[1] = { key: objects[1].key, bytes: Buffer.from('{not-json') };
  await assert.rejects(
    buildProductionPackObjectAuthorityFromLive(liveOptions(objects)),
    /closed signed-manifest envelope|malformed|JSON/i,
  );
});

test('a synthetic ceremony signed-manifest with a corrupt signature fails verifySignedPackManifest', async () => {
  const objects = syntheticPackObjects();
  const envelope = JSON.parse(objects[1].bytes.toString('utf8'));
  const signature = Buffer.from(envelope.signatureDerBase64, 'base64');
  signature[signature.length - 1] ^= 0xff;
  envelope.signatureDerBase64 = signature.toString('base64');
  objects[1] = { key: objects[1].key, bytes: jsonBytes(envelope) };
  await assert.rejects(
    buildProductionPackObjectAuthorityFromLive(liveOptions(objects)),
    /verifySignedPackManifest|signature verification failed/i,
  );
});

test('verifySignedPackManifest against the committed production keyring rejects a synthetic envelope that was not signed by that key', async () => {
  const archiveBytes = Buffer.from(`archive-bytes:${PRODUCTION_PACK_IDS[0]}`);
  const hashed = hashObjectBytes(archiveBytes);
  const envelope = SYNTHETIC_SIGNER.signPack(PRODUCTION_PACK_IDS[0], { archiveBytes });
  await assert.rejects(
    verifyProductionSignedManifestEnvelope({
      envelopeBytes: envelope,
      key: expectedObjectKey(PRODUCTION_PACK_IDS[0], 'signed-manifest'),
      packId: PRODUCTION_PACK_IDS[0],
      version: PRODUCTION_PACK_VERSION,
      archiveName: archiveNameForPack(PRODUCTION_PACK_IDS[0]),
      archiveBytes: hashed.bytes,
      archiveSha256: hashed.sha256,
      keyring: productionKeyring,
    }),
    /verifySignedPackManifest|signature verification failed/i,
  );
});

test('a valid production-signed minimal payload {packId,version} is rejected as an incomplete production manifest', async () => {
  const objects = syntheticPackObjects();
  objects[1] = {
    key: objects[1].key,
    bytes: SYNTHETIC_SIGNER.signPack(PRODUCTION_PACK_IDS[0], { omitArchive: true }),
  };
  await assert.rejects(
    buildProductionPackObjectAuthorityFromLive(liveOptions(objects)),
    /closed production manifest fields|archive identity/i,
  );
});

test('a signed-but-incomplete {packId,version,archive} payload is rejected as an incomplete production manifest', async () => {
  const objects = syntheticPackObjects();
  objects[1] = {
    key: objects[1].key,
    bytes: SYNTHETIC_SIGNER.signPack(PRODUCTION_PACK_IDS[0], {
      incompleteArchiveOnly: true,
      archiveBytes: objects[0].bytes,
    }),
  };
  await assert.rejects(
    buildProductionPackObjectAuthorityFromLive(liveOptions(objects)),
    /closed production manifest fields/i,
  );
});

test('a valid production-signed envelope with a non-production entitlement is rejected', async () => {
  const objects = syntheticPackObjects();
  objects[1] = {
    key: objects[1].key,
    bytes: SYNTHETIC_SIGNER.signPack(PRODUCTION_PACK_IDS[0], {
      archiveBytes: objects[0].bytes,
      requiredEntitlementId: 'b3-sandbox-proof',
    }),
  };
  await assert.rejects(
    buildProductionPackObjectAuthorityFromLive(liveOptions(objects)),
    /requiredEntitlementId|full-ks2|b3-sandbox-proof/i,
  );
});

test('a valid production-signed envelope for the wrong packId is rejected', async () => {
  const objects = syntheticPackObjects();
  objects[1] = {
    key: objects[1].key,
    bytes: SYNTHETIC_SIGNER.signPack(PRODUCTION_PACK_IDS[1], {
      archiveBytes: objects[0].bytes,
    }),
  };
  await assert.rejects(
    buildProductionPackObjectAuthorityFromLive(liveOptions(objects)),
    /packId|full-ks2-shard-02|does not match/i,
  );
});

test('a valid production-signed envelope with the wrong version is rejected', async () => {
  const objects = syntheticPackObjects();
  objects[1] = {
    key: objects[1].key,
    bytes: SYNTHETIC_SIGNER.signPack(PRODUCTION_PACK_IDS[0], {
      version: '9.9.9',
      archiveBytes: objects[0].bytes,
    }),
  };
  await assert.rejects(
    buildProductionPackObjectAuthorityFromLive(liveOptions(objects)),
    /version|9\.9\.9/i,
  );
});

test('a valid production-signed envelope with the wrong archive name is rejected', async () => {
  const objects = syntheticPackObjects();
  objects[1] = {
    key: objects[1].key,
    bytes: SYNTHETIC_SIGNER.signPack(PRODUCTION_PACK_IDS[0], {
      archiveBytes: objects[0].bytes,
      archiveName: 'other-pack.zip',
    }),
  };
  await assert.rejects(
    buildProductionPackObjectAuthorityFromLive(liveOptions(objects)),
    /archive name|other-pack\.zip/i,
  );
});

test('a valid production-signed envelope whose archive bytes or SHA-256 differ from the paired live GET is rejected', async () => {
  const objects = syntheticPackObjects();
  const other = Buffer.from('different-archive-bytes');
  objects[1] = {
    key: objects[1].key,
    bytes: SYNTHETIC_SIGNER.signPack(PRODUCTION_PACK_IDS[0], {
      archiveBytes: other,
    }),
  };
  await assert.rejects(
    buildProductionPackObjectAuthorityFromLive(liveOptions(objects)),
    /archive SHA-256|archive byte|paired live/i,
  );
  objects[1] = {
    key: objects[1].key,
    bytes: SYNTHETIC_SIGNER.signPack(PRODUCTION_PACK_IDS[0], {
      archiveBytes: objects[0].bytes,
      archiveByteCount: objects[0].bytes.length + 1,
    }),
  };
  await assert.rejects(
    buildProductionPackObjectAuthorityFromLive(liveOptions(objects)),
    /archive byte/i,
  );
});

test('replacing shard-02 live envelope bytes with a valid production-signed shard-01 envelope is rejected', async () => {
  const objects = syntheticPackObjects();
  const shard01Manifest = objects.find((object) => (
    object.key === expectedObjectKey('full-ks2-shard-01', 'signed-manifest')
  ));
  const shard02Index = objects.findIndex((object) => (
    object.key === expectedObjectKey('full-ks2-shard-02', 'signed-manifest')
  ));
  objects[shard02Index] = { key: objects[shard02Index].key, bytes: shard01Manifest.bytes };
  await assert.rejects(
    buildProductionPackObjectAuthorityFromLive(liveOptions(objects)),
    /full-ks2-shard-01|packId|does not match/i,
  );
});

test('a locally re-signed synthetic envelope is not accepted in place of the live production bytes', async () => {
  const objects = syntheticPackObjects();
  const resigned = SYNTHETIC_SIGNER.signPack(PRODUCTION_PACK_IDS[0]);
  if (resigned.equals(objects[1].bytes)) {
    resigned[resigned.length - 2] ^= 0x01;
  }
  const ceremony = objects.map((object, index) => (
    index === 1 ? { key: object.key, bytes: resigned } : object
  ));
  await assert.rejects(
    buildProductionPackObjectAuthorityFromLive(
      liveOptions(objects, { ceremonyBytesByKey: ceremonyMap(ceremony) }),
    ),
    /local ceremony MD5|local ceremony bytes/i,
  );
});

test('default and injected-current clocks reject a production key that is expired or not yet valid', async () => {
  const expiredAtInstant = createSyntheticProductionSigner({
    notBefore: '2026-08-21T00:00:00Z',
    notAfter: '2026-08-21T00:00:00Z',
  });
  const expiredObjects = syntheticPackObjects(expiredAtInstant);
  await buildProductionPackObjectAuthorityFromLive(liveOptions(expiredObjects, {
    keyring: expiredAtInstant.keyring,
    clock: () => new Date(PRODUCTION_VERIFICATION_INSTANT),
  }));
  await assert.rejects(
    buildProductionPackObjectAuthorityFromLive({
      ...syntheticReaders(expiredObjects),
      keyring: expiredAtInstant.keyring,
    }),
    /expired|validity window/i,
  );
  await assert.rejects(
    buildProductionPackObjectAuthorityFromLive({
      ...syntheticReaders(expiredObjects),
      keyring: expiredAtInstant.keyring,
      clock: () => new Date(),
    }),
    /expired|validity window/i,
  );
  const notYetValid = createSyntheticProductionSigner({
    notBefore: '2030-01-01T00:00:00Z',
    notAfter: '2036-01-01T00:00:00Z',
  });
  await assert.rejects(
    buildProductionPackObjectAuthorityFromLive({
      ...syntheticReaders(syntheticPackObjects(notYetValid)),
      keyring: notYetValid.keyring,
      clock: () => new Date(),
    }),
    /not yet valid|validity window/i,
  );
});

test('two synthetic pack-object documents fail comparison when one hashed object drifts', async () => {
  const objects = syntheticPackObjects();
  const document = await generateProductionPackObjectAuthority({
    root: ROOT,
    keyring: SYNTHETIC_SIGNER.keyring,
    clock: () => new Date(PRODUCTION_VERIFICATION_INSTANT),
    ...syntheticReaders(objects),
  });
  const drifted = syntheticPackObjects();
  const driftedArchive = Buffer.concat([drifted[0].bytes, Buffer.from('drift')]);
  drifted[0] = { key: drifted[0].key, bytes: driftedArchive };
  drifted[1] = {
    key: drifted[1].key,
    bytes: SYNTHETIC_SIGNER.signPack(PRODUCTION_PACK_IDS[0], { archiveBytes: driftedArchive }),
  };
  const driftedDocument = await generateProductionPackObjectAuthority({
    root: ROOT,
    keyring: SYNTHETIC_SIGNER.keyring,
    clock: () => new Date(PRODUCTION_VERIFICATION_INSTANT),
    ...syntheticReaders(drifted),
  });
  assert.throws(
    () => assertDocumentsMatch(
      driftedDocument,
      document,
      'synthetic pack-object documents differ',
    ),
    /synthetic pack-object documents differ/i,
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

function fakeR2Fetch(objects) {
  const byKey = new Map(objects.map((object) => [object.key, object.bytes]));
  const listing = listingFromObjects(objects);
  return async (url) => {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    const marker = '/objects/';
    const objectsIndex = parsed.pathname.indexOf(marker);
    if (objectsIndex !== -1 && objectsIndex + marker.length < parsed.pathname.length) {
      const key = decodeURIComponent(parsed.pathname.slice(objectsIndex + marker.length));
      const bytes = byKey.get(key);
      if (!bytes) {
        return {
          ok: false,
          status: 404,
          text: async () => '',
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => '',
        arrayBuffer: async () => bytes,
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true, result: listing, result_info: {} }),
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
}

async function writeSyntheticCheckRoot(objects, keyring) {
  const root = await mkdtemp(join(tmpdir(), 'ks2-pack-object-root-'));
  const document = await generateProductionPackObjectAuthority({
    root: ROOT,
    keyring,
    clock: () => new Date(PRODUCTION_VERIFICATION_INSTANT),
    ...syntheticReaders(objects),
  });
  await mkdir(join(root, 'config/production'), { recursive: true });
  await writeFile(
    join(root, 'config/ks2-pack-object-authority-production.json'),
    serialiseProductionPackObjectAuthority(document),
  );
  await writeFile(
    join(root, 'config/ks2-gateway-authority-production.json'),
    jsonBytes({ privateR2BucketName: PRODUCTION_PACK_OBJECT_BUCKET }),
  );
  await writeFile(
    join(root, 'config/production/pack-signing-public-keys.json'),
    jsonBytes(keyring),
  );
  return { root, document };
}

test('generator --check --ceremony-dir against a complete synthetic tree matching injected live GET succeeds', async () => {
  const objects = syntheticPackObjects();
  const { root } = await writeSyntheticCheckRoot(objects, SYNTHETIC_SIGNER.keyring);
  const ceremonyDir = await mkdtemp(join(tmpdir(), 'ks2-ceremony-complete-'));
  try {
    await writeCanonicalCeremony(ceremonyDir, objects);
    const code = await generateProductionPackObjectAuthorityMain(
      ['--check', '--ceremony-dir', ceremonyDir],
      {
        root,
        env: { CLOUDFLARE_API_TOKEN: 'synthetic-test-token' },
        fetchImpl: fakeR2Fetch(objects),
        log: () => {},
      },
    );
    assert.equal(code, EXIT_CODES.success);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(ceremonyDir, { recursive: true, force: true });
  }
});

test('generator --check --ceremony-dir fails closed when one synthetic archive is deleted', async () => {
  const objects = syntheticPackObjects();
  const { root } = await writeSyntheticCheckRoot(objects, SYNTHETIC_SIGNER.keyring);
  const ceremonyDir = await mkdtemp(join(tmpdir(), 'ks2-ceremony-cli-missing-'));
  try {
    await writeCanonicalCeremony(ceremonyDir, objects);
    await unlink(join(ceremonyDir, objects[0].key));
    const code = await generateProductionPackObjectAuthorityMain(
      ['--check', '--ceremony-dir', ceremonyDir],
      {
        root,
        env: { CLOUDFLARE_API_TOKEN: 'synthetic-test-token' },
        fetchImpl: fakeR2Fetch(objects),
        log: () => {},
      },
    );
    assert.equal(code, EXIT_CODES.commandFailed);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(ceremonyDir, { recursive: true, force: true });
  }
});
