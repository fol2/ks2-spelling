import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { canonicaliseRfc8785Bytes } from '../src/domain/packs/rfc8785.js';
import { PACK_SIGNING_ALGORITHM } from '../src/domain/packs/signed-manifest-contract.js';
import {
  PRODUCTION_PACK_IDS,
  PRODUCTION_PACK_VERSION,
  PRODUCTION_REQUIRED_ENTITLEMENT_ID,
  PRODUCTION_SIGNING_KEY_ID,
  PRODUCTION_VERIFICATION_INSTANT,
  archiveNameForPack,
  buildProductionPackObjectAuthorityFromLive,
  hashObjectBytes,
  readCompleteCeremonyDirectory,
} from '../scripts/lib/production-pack-object-authority.mjs';
import {
  CEREMONY_COMPLETE_TEXT,
  CEREMONY_READY_STATUS,
  main as resignManifests,
  resolveNestedAuthoringArchiveBytes,
} from '../scripts/resign-manifests-with-production-key.mjs';

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function md5(bytes) {
  return createHash('md5').update(bytes).digest('hex');
}

function generatePrivateKeyPem() {
  const { privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });
  return privateKey;
}

function shardFixture(packId, {
  archiveBytes,
  distFirst,
  distSecond,
  canonicalManifestBytes,
} = {}) {
  const archiveName = `${packId}-1.0.0.zip`;
  const bytes = archiveBytes ?? Buffer.from(`archive:${packId}`);
  return {
    packId,
    version: '1.0.0',
    archiveName,
    archiveBytes: bytes,
    canonicalManifestBytes: canonicalManifestBytes ?? Buffer.from(`{"packId":"${packId}"}`),
    writeDistFirst: distFirst === undefined ? bytes : distFirst,
    writeDistSecond: distSecond === undefined ? bytes : distSecond,
  };
}

async function writeSignerRoot(shards) {
  const root = await mkdtemp(join(tmpdir(), 'ks2-resign-root-'));
  const report = {
    schemaVersion: 1,
    status: 'pass',
    shards: shards.map((shard) => ({
      packId: shard.packId,
      version: shard.version,
      archiveName: shard.archiveName,
      canonicalManifestSha256: sha256(shard.canonicalManifestBytes),
      archiveSha256: sha256(shard.archiveBytes),
      archiveBytes: shard.archiveBytes.length,
      archiveMd5Etag: md5(shard.archiveBytes),
    })),
  };
  await mkdir(join(root, 'config/packs/full-ks2-shards'), { recursive: true });
  await writeFile(
    join(root, 'config/packs/full-ks2-shards/authoring-report.json'),
    jsonBytes(report),
  );
  for (const shard of shards) {
    const fixtureDir = join(root, 'tests/fixtures/packs/full-ks2-shards');
    await mkdir(fixtureDir, { recursive: true });
    await writeFile(
      join(fixtureDir, `${shard.packId}.signed-manifest.json`),
      jsonBytes({
        canonicalManifestBase64: shard.canonicalManifestBytes.toString('base64'),
      }),
    );
    if (shard.writeDistFirst) {
      const distFirst = join(root, '.native-build/packs', shard.packId, 'dist-first');
      await mkdir(distFirst, { recursive: true });
      await writeFile(join(distFirst, shard.archiveName), shard.writeDistFirst);
    }
    if (shard.writeDistSecond) {
      const distSecond = join(root, '.native-build/packs', shard.packId, 'dist-second');
      await mkdir(distSecond, { recursive: true });
      await writeFile(join(distSecond, shard.archiveName), shard.writeDistSecond);
    }
  }
  return root;
}

function collectWrites() {
  const writes = [];
  return {
    writes,
    writeFileImpl: async (path, bytes) => {
      writes.push({ path, text: Buffer.from(bytes).toString('utf8') });
      return writeFile(path, bytes);
    },
  };
}

function claimedReady(logs, writes) {
  return logs.some((line) => line.includes(CEREMONY_COMPLETE_TEXT))
    || writes.some((entry) => (
      entry.path.endsWith('ceremony-metadata.json')
      && entry.text.includes(`"status": "${CEREMONY_READY_STATUS}"`)
    ));
}

function canonicalShards(mutate) {
  const shards = PRODUCTION_PACK_IDS.map((packId) => shardFixture(packId));
  mutate?.(shards);
  return shards;
}

async function resignAgainstShards(shards, {
  outputPrefix = 'ks2-resign-',
  readFileImpl,
} = {}) {
  const root = await writeSignerRoot(shards);
  const output = await mkdtemp(join(tmpdir(), outputPrefix));
  const keyPath = join(root, 'test-key.pem');
  const logs = [];
  const { writes, writeFileImpl } = collectWrites();
  await writeFile(keyPath, generatePrivateKeyPem());
  const run = () => resignManifests({
    root,
    env: {
      CEREMONY_PRIVATE_KEY_PATH: keyPath,
      CEREMONY_OUTPUT_DIR: output,
      CEREMONY_KEY_ID: PRODUCTION_SIGNING_KEY_ID,
    },
    writeFileImpl,
    readFileImpl,
    log: (line) => logs.push(line),
    now: () => new Date('2026-08-21T00:00:00.000Z'),
  });
  return { root, output, logs, writes, run };
}

async function assertResignRejectsWithoutReady(shards, pattern, options = {}) {
  const { root, output, logs, writes, run } = await resignAgainstShards(shards, options);
  try {
    await assert.rejects(run(), pattern);
    assert.equal(claimedReady(logs, writes), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
}

test('nested author-full-shards dist-first and dist-second archives with a matching hash resolve', async () => {
  const root = await writeSignerRoot([shardFixture('full-ks2-shard-01')]);
  try {
    const bytes = await resolveNestedAuthoringArchiveBytes({
      root,
      packId: 'full-ks2-shard-01',
      archiveName: 'full-ks2-shard-01-1.0.0.zip',
      archiveSha256: sha256(Buffer.from('archive:full-ks2-shard-01')),
    });
    assert.equal(bytes.toString(), 'archive:full-ks2-shard-01');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('nested signer success stages all fifteen dist-first|dist-second archives and writes ceremony ready', async () => {
  const { root, output, logs, writes, run } = await resignAgainstShards(canonicalShards(), {
    outputPrefix: 'ks2-resign-out-',
  });
  try {
    const metadata = await run();
    assert.equal(metadata.status, CEREMONY_READY_STATUS);
    assert.equal(metadata.manifests.length, 15);
    assert.equal(logs.some((line) => line.includes(CEREMONY_COMPLETE_TEXT)), true);
    assert.equal(metadata.objectDirectory, resolve(output, 'objects'));
    const archive = await readFile(
      join(metadata.objectDirectory, 'packs/full-ks2-shard-01/1.0.0/full-ks2-shard-01-1.0.0.zip'),
    );
    assert.equal(archive.toString(), 'archive:full-ks2-shard-01');
    const envelope = JSON.parse(
      await readFile(
        join(metadata.objectDirectory, 'packs/full-ks2-shard-15/1.0.0/signed-manifest.json'),
        'utf8',
      ),
    );
    assert.equal(envelope.keyId, PRODUCTION_SIGNING_KEY_ID);
    assert.equal(writes.some((entry) => entry.path.endsWith('ceremony-metadata.json')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
});

test('a two-shard subset authoring report must not write ready or claim Ceremony complete', async () => {
  await assertResignRejectsWithoutReady(
    [shardFixture('full-ks2-shard-01'), shardFixture('full-ks2-shard-02')],
    /exactly 15 shards|canonical/i,
    { outputPrefix: 'ks2-resign-subset-' },
  );
});

test('a duplicate canonical packId in the authoring report must not write ready', async () => {
  await assertResignRejectsWithoutReady(
    canonicalShards((shards) => {
      shards[1] = shardFixture('full-ks2-shard-01');
    }),
    /duplicate|does not match|canonical/i,
    { outputPrefix: 'ks2-resign-duplicate-' },
  );
});

test('an extra non-canonical shard in the authoring report must not write ready', async () => {
  await assertResignRejectsWithoutReady(
    [...canonicalShards(), shardFixture('full-ks2-shard-16')],
    /exactly 15 shards|extra|canonical/i,
    { outputPrefix: 'ks2-resign-extra-' },
  );
});

test('a reordered canonical shard list must not write ready', async () => {
  const reordered = canonicalShards();
  [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  await assertResignRejectsWithoutReady(
    reordered,
    /does not match|order|canonical/i,
    { outputPrefix: 'ks2-resign-reorder-' },
  );
});

test('a substituted archive name for an otherwise fifteen-shard report must not write ready', async () => {
  await assertResignRejectsWithoutReady(
    canonicalShards((shards) => {
      shards[1] = {
        ...shards[1],
        archiveName: 'full-ks2-shard-99-1.0.0.zip',
      };
    }),
    /archiveName|does not match|canonical/i,
    { outputPrefix: 'ks2-resign-substituted-' },
  );
});

test('missing nested dist-first|dist-second archives fail and must not claim or write ready', async () => {
  await assertResignRejectsWithoutReady(
    canonicalShards((shards) => {
      shards[14] = shardFixture('full-ks2-shard-15', { distFirst: null, distSecond: null });
    }),
    /missing nested authoring archive/i,
    { outputPrefix: 'ks2-resign-missing-' },
  );
});

test('ambiguous dist-first and dist-second nested archives fail and must not claim or write ready', async () => {
  await assertResignRejectsWithoutReady(
    canonicalShards((shards) => {
      shards[0] = shardFixture('full-ks2-shard-01', {
        distFirst: Buffer.from('archive:full-ks2-shard-01'),
        distSecond: Buffer.from('different-second-build'),
      });
    }),
    /ambiguous nested authoring archives/i,
    { outputPrefix: 'ks2-resign-ambiguous-' },
  );
});

test('nested authoring archive hash mismatch fails and must not claim or write ready', async () => {
  await assertResignRejectsWithoutReady(
    canonicalShards((shards) => {
      shards[0] = shardFixture('full-ks2-shard-01', {
        archiveBytes: Buffer.from('expected-bytes'),
        distFirst: Buffer.from('wrong-bytes'),
        distSecond: Buffer.from('wrong-bytes'),
      });
    }),
    /nested authoring archive hash mismatch/i,
    { outputPrefix: 'ks2-resign-hash-' },
  );
});

test('producer output is a complete ceremony that the object-tree reader and live verifier accept without deleting metadata', async () => {
  const pair = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const shards = PRODUCTION_PACK_IDS.map((packId) => {
    const archiveBytes = Buffer.from(`archive:${packId}`);
    const hashed = hashObjectBytes(archiveBytes);
    return shardFixture(packId, {
      archiveBytes,
      canonicalManifestBytes: Buffer.from(canonicaliseRfc8785Bytes({
        allowedExtensions: ['.json', '.m4a'],
        archive: {
          bytes: hashed.bytes,
          name: archiveNameForPack(packId),
          sha256: hashed.sha256,
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
        requiredEntitlementId: PRODUCTION_REQUIRED_ENTITLEMENT_ID,
        schemaVersion: 1,
        version: PRODUCTION_PACK_VERSION,
      })),
    });
  });
  const root = await writeSignerRoot(shards);
  const output = await mkdtemp(join(tmpdir(), 'ks2-resign-e2e-'));
  const keyPath = join(root, 'test-key.pem');
  try {
    await writeFile(keyPath, pair.privateKey);
    const metadata = await resignManifests({
      root,
      env: {
        CEREMONY_PRIVATE_KEY_PATH: keyPath,
        CEREMONY_OUTPUT_DIR: output,
        CEREMONY_KEY_ID: PRODUCTION_SIGNING_KEY_ID,
      },
      log: () => {},
      now: () => new Date('2026-08-21T00:00:00.000Z'),
    });
    await access(join(output, 'ceremony-metadata.json'));
    const objectDirectory = metadata.objectDirectory;
    assert.equal(objectDirectory, resolve(output, 'objects'));
    const inventory = await readCompleteCeremonyDirectory({ ceremonyDir: objectDirectory });
    assert.equal(inventory.size, 30);
    await writeFile(join(objectDirectory, 'unexpected.txt'), 'nope');
    await assert.rejects(
      readCompleteCeremonyDirectory({ ceremonyDir: objectDirectory }),
      /extra unexpected\.txt/i,
    );
    await unlink(join(objectDirectory, 'unexpected.txt'));
    const inventoryAfter = await readCompleteCeremonyDirectory({ ceremonyDir: objectDirectory });
    assert.equal(inventoryAfter.size, 30);
    const objects = [];
    for (const packId of PRODUCTION_PACK_IDS) {
      objects.push({
        key: `packs/${packId}/${PRODUCTION_PACK_VERSION}/${archiveNameForPack(packId)}`,
        bytes: inventory.get(`packs/${packId}/${PRODUCTION_PACK_VERSION}/${archiveNameForPack(packId)}`),
      });
      objects.push({
        key: `packs/${packId}/${PRODUCTION_PACK_VERSION}/signed-manifest.json`,
        bytes: inventory.get(`packs/${packId}/${PRODUCTION_PACK_VERSION}/signed-manifest.json`),
      });
    }
    const keyring = {
      schemaVersion: 1,
      keys: [{
        keyId: PRODUCTION_SIGNING_KEY_ID,
        algorithm: PACK_SIGNING_ALGORITHM,
        publicKeySpkiDerBase64: pair.publicKey.toString('base64'),
        publicKeySpkiSha256: sha256(pair.publicKey),
        testOnly: false,
        notBefore: '2026-08-17T00:00:00Z',
        notAfter: '2036-08-16T00:00:00Z',
        allowedEnvironments: ['production'],
        allowedPackIds: [...PRODUCTION_PACK_IDS],
      }],
    };
    const byKey = new Map(objects.map((object) => [object.key, object.bytes]));
    const document = await buildProductionPackObjectAuthorityFromLive({
      listObjects: async () => objects.map((object) => {
        const hashed = hashObjectBytes(object.bytes);
        return { key: object.key, size: hashed.bytes, etag: hashed.etag, custom_metadata: {} };
      }),
      getObject: async (key) => byKey.get(key),
      ceremonyBytesByKey: inventory,
      keyring,
      clock: () => new Date(PRODUCTION_VERIFICATION_INSTANT),
    });
    assert.equal(document.packs.length, 15);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
});

test('a failed rerun removes stale ready metadata and is not accepted as a complete ceremony', async () => {
  const shards = PRODUCTION_PACK_IDS.map((packId) => shardFixture(packId));
  const root = await writeSignerRoot(shards);
  const output = await mkdtemp(join(tmpdir(), 'ks2-resign-stale-'));
  const keyPath = join(root, 'test-key.pem');
  try {
    await writeFile(keyPath, generatePrivateKeyPem());
    await resignManifests({
      root,
      env: {
        CEREMONY_PRIVATE_KEY_PATH: keyPath,
        CEREMONY_OUTPUT_DIR: output,
        CEREMONY_KEY_ID: PRODUCTION_SIGNING_KEY_ID,
      },
      log: () => {},
    });
    await access(join(output, 'ceremony-metadata.json'));
    await rm(join(root, '.native-build/packs/full-ks2-shard-15'), { recursive: true, force: true });
    await assert.rejects(
      resignManifests({
        root,
        env: {
          CEREMONY_PRIVATE_KEY_PATH: keyPath,
          CEREMONY_OUTPUT_DIR: output,
          CEREMONY_KEY_ID: PRODUCTION_SIGNING_KEY_ID,
        },
        log: () => {},
      }),
      /missing nested authoring archive/i,
    );
    await assert.rejects(access(join(output, 'ceremony-metadata.json')));
    await assert.rejects(
      readCompleteCeremonyDirectory({ ceremonyDir: resolve(output, 'objects') }),
      /missing|exactly 15 archives|cannot read ceremony directory/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
});

test('an EACCES read of a nested authoring archive fails and is not mapped to ready', async () => {
  const shards = canonicalShards();
  const { root, output, logs, writes } = await resignAgainstShards(shards, {
    outputPrefix: 'ks2-resign-eacces-',
  });
  const denied = resolve(root, '.native-build/packs/full-ks2-shard-01/dist-first/full-ks2-shard-01-1.0.0.zip');
  try {
    await assert.rejects(
      resignManifests({
        root,
        env: {
          CEREMONY_PRIVATE_KEY_PATH: join(root, 'test-key.pem'),
          CEREMONY_OUTPUT_DIR: output,
          CEREMONY_KEY_ID: PRODUCTION_SIGNING_KEY_ID,
        },
        readFileImpl: async (path, encoding) => {
          if (path === denied) {
            const error = new Error('EACCES: permission denied');
            error.code = 'EACCES';
            throw error;
          }
          return readFile(path, encoding);
        },
        writeFileImpl: async (path, bytes) => {
          writes.push({ path, text: Buffer.from(bytes).toString('utf8') });
          return writeFile(path, bytes);
        },
        log: (line) => logs.push(line),
      }),
      /cannot read nested authoring archive/i,
    );
    assert.equal(claimedReady(logs, writes), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
});
