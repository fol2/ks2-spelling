#!/usr/bin/env node

/**
 * Re-sign canonical manifests with existing production key and prepare ceremony directory.
 *
 * Usage:
 *   CEREMONY_PRIVATE_KEY_PATH=/path/to/existing/key.pem \
 *   CEREMONY_OUTPUT_DIR=/path/to/ceremony \
 *   CEREMONY_KEY_ID=production-ks2-p256-2026-08 \
 *   node scripts/resign-manifests-with-production-key.mjs
 *
 * Writes the exact object tree at CEREMONY_OUTPUT_DIR/objects/packs/... and
 * operational ceremony-metadata.json beside that subdirectory. Pass
 * --ceremony-dir "$CEREMONY_OUTPUT_DIR/objects". Removes stale ready metadata
 * and the objects/ tree as soon as CEREMONY_OUTPUT_DIR identifies that bounded
 * cleanup target, then validates remaining environment and authoring input.
 * Preflights nested dist-first|dist-second archives and canonical manifests,
 * writes objects to a staging tree, writes ready metadata, then promotes the
 * staging tree. Any failure after that clear, including a final metadata write
 * failure, removes ready metadata and both staging and accepted object trees.
 */

import { createHash, createPrivateKey, sign } from 'node:crypto';
import { mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PACK_SIGNING_ALGORITHM,
  assertCanonicalP256Der,
  createPackSigningInput,
} from '../src/domain/packs/signed-manifest-contract.js';
import {
  CEREMONY_OBJECT_DIRECTORY_RELATIVE,
  CEREMONY_OPERATIONAL_METADATA_RELATIVE,
  PRODUCTION_PACK_IDS,
  PRODUCTION_PACK_VERSION,
  archiveNameForPack,
} from './lib/production-pack-object-authority.mjs';
import { isMain } from './lib/run-command.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
export const CEREMONY_COMPLETE_TEXT = 'Ceremony complete';
export const CEREMONY_READY_STATUS = 'ready';

function fail(detail) {
  throw new Error(`Re-sign manifests ${detail}.`);
}

function digest(bytes, algorithm = 'sha256') {
  return createHash(algorithm).update(bytes).digest('hex');
}

function digestMd5(bytes) {
  return createHash('md5').update(bytes).digest('hex');
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(path, readFileImpl = readFile) {
  return JSON.parse(await readFileImpl(path, 'utf8'));
}

async function ensureEnv(name, env = process.env) {
  const value = env[name];
  if (!value) {
    fail(`requires environment variable ${name}`);
  }
  return value;
}

/**
 * Load canonical manifest bytes and packId from authoring report.
 */
function assertCanonicalAuthoringShards(shards) {
  if (!Array.isArray(shards) || shards.length !== PRODUCTION_PACK_IDS.length) {
    fail(
      `authoring report must list exactly ${PRODUCTION_PACK_IDS.length} canonical shards, ` +
        `not ${Array.isArray(shards) ? shards.length : typeof shards}`,
    );
  }
  PRODUCTION_PACK_IDS.forEach((packId, index) => {
    const shard = shards[index];
    const expectedArchive = archiveNameForPack(packId);
    if (shard?.packId !== packId) {
      fail(
        `authoring report shard ${index} packId ${shard?.packId ?? 'missing'} does not match canonical ${packId}`,
      );
    }
    if (shard.version !== PRODUCTION_PACK_VERSION) {
      fail(
        `authoring report shard ${packId} version ${shard.version} does not match ${PRODUCTION_PACK_VERSION}`,
      );
    }
    if (shard.archiveName !== expectedArchive) {
      fail(
        `authoring report shard ${packId} archiveName ${shard.archiveName} does not match ${expectedArchive}`,
      );
    }
  });
}

async function loadShardsToSign(root, readFileImpl = readFile) {
  const report = await readJson(
    resolve(root, 'config/packs/full-ks2-shards/authoring-report.json'),
    readFileImpl,
  );
  if (report.status !== 'pass') {
    fail('authoring report is not pass status');
  }
  assertCanonicalAuthoringShards(report.shards);
  return report.shards.map((shard) => ({
    packId: shard.packId,
    version: shard.version,
    archiveName: shard.archiveName,
    canonicalManifestSha256: shard.canonicalManifestSha256,
    canonicalManifestBytes: shard.canonicalManifestBytes,
    archiveSha256: shard.archiveSha256,
    archiveBytes: shard.archiveBytes,
    archiveMd5Etag: shard.archiveMd5Etag,
  }));
}

export function nestedAuthoringArchiveCandidates(root, packId, archiveName) {
  return Object.freeze([
    resolve(root, '.native-build/packs', packId, 'dist-first', archiveName),
    resolve(root, '.native-build/packs', packId, 'dist-second', archiveName),
  ]);
}

export function nestedAuthoringCanonicalManifestCandidates(root, packId) {
  return Object.freeze([
    resolve(root, '.native-build/packs', packId, 'dist-first', 'unsigned-canonical-manifest.json'),
    resolve(root, '.native-build/packs', packId, 'dist-second', 'unsigned-canonical-manifest.json'),
  ]);
}

export async function resolveNestedAuthoringCanonicalManifestBytes({
  root,
  packId,
  canonicalManifestSha256,
  canonicalManifestBytes,
  readFileImpl = readFile,
}) {
  const candidates = nestedAuthoringCanonicalManifestCandidates(root, packId);
  const readable = [];
  for (const path of candidates) {
    try {
      const bytes = await readFileImpl(path);
      readable.push({ path, bytes: Buffer.from(bytes) });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      fail(`cannot read nested authoring canonical manifest ${path}: ${error.message}`);
    }
  }
  if (readable.length === 0) {
    fail(
      `missing nested authoring canonical manifest for ${packId} at ` +
        `${packId}/dist-first|dist-second/unsigned-canonical-manifest.json`,
    );
  }
  const hashes = readable.map(({ bytes }) => digest(bytes));
  if (new Set(hashes).size !== 1) {
    fail(`ambiguous nested authoring canonical manifests for ${packId}: dist-first and dist-second differ`);
  }
  if (hashes[0] !== canonicalManifestSha256) {
    fail(
      `nested authoring canonical manifest hash mismatch for ${packId}: ` +
        `expected ${canonicalManifestSha256}, got ${hashes[0]}`,
    );
  }
  if (readable[0].bytes.length !== canonicalManifestBytes) {
    fail(
      `nested authoring canonical manifest byte count mismatch for ${packId}: ` +
        `expected ${canonicalManifestBytes}, got ${readable[0].bytes.length}`,
    );
  }
  return readable[0].bytes;
}

export async function resolveNestedAuthoringArchiveBytes({
  root,
  packId,
  archiveName,
  archiveSha256,
  readFileImpl = readFile,
}) {
  const candidates = nestedAuthoringArchiveCandidates(root, packId, archiveName);
  const readable = [];
  for (const path of candidates) {
    try {
      const bytes = await readFileImpl(path);
      readable.push({ path, bytes: Buffer.from(bytes) });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      fail(`cannot read nested authoring archive ${path}: ${error.message}`);
    }
  }
  if (readable.length === 0) {
    fail(
      `missing nested authoring archive for ${packId} at ` +
        `${packId}/dist-first|dist-second/${archiveName}`,
    );
  }
  const hashes = readable.map(({ bytes }) => digest(bytes));
  if (new Set(hashes).size !== 1) {
    fail(`ambiguous nested authoring archives for ${packId}: dist-first and dist-second differ`);
  }
  if (hashes[0] !== archiveSha256) {
    fail(
      `nested authoring archive hash mismatch for ${packId}: ` +
        `expected ${archiveSha256}, got ${hashes[0]}`,
    );
  }
  return readable[0].bytes;
}

/**
 * Read canonical manifest and create signed envelope.
 */
async function signManifest(
  canonicalManifestBytes,
  canonicalManifestSha256,
  shard,
  privateKeyPem,
  keyId,
) {
  // Verify canonical manifest hash
  const actualHash = digest(canonicalManifestBytes);
  if (actualHash !== canonicalManifestSha256) {
    fail(`canonical manifest hash mismatch for ${shard.packId}: expected ${canonicalManifestSha256}, got ${actualHash}`);
  }

  // Create signing input: domain preamble + canonical bytes
  const signingInput = createPackSigningInput(canonicalManifestBytes);

  // Sign with private key
  const privateKey = createPrivateKey(privateKeyPem);
  const signatureDer = sign('sha256', signingInput, privateKey);
  assertCanonicalP256Der(signatureDer);

  // Create signed envelope
  const envelope = {
    schemaVersion: 1,
    algorithm: PACK_SIGNING_ALGORITHM,
    keyId,
    payloadEncoding: 'RFC8785_UTF8',
    domain: 'ks2-spelling-pack-manifest-v1',
    canonicalManifestBase64: canonicalManifestBytes.toString('base64'),
    signatureDerBase64: signatureDer.toString('base64'),
  };

  const envelopeBytes = jsonBytes(envelope);

  return {
    envelopeSha256: digest(envelopeBytes),
    envelopeBytes,
    envelopeByteCount: envelopeBytes.length,
    envelopeMd5Etag: digestMd5(envelopeBytes),
  };
}

async function ignoreEnoent(operation) {
  try {
    await operation();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export async function main({
  root = ROOT,
  env = process.env,
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  mkdirImpl = mkdir,
  unlinkImpl = unlink,
  rmImpl = rm,
  renameImpl = rename,
  log = (line) => console.log(line),
  now = () => new Date(),
} = {}) {
  const ceremonyOutputDir = await ensureEnv('CEREMONY_OUTPUT_DIR', env);
  const objectDirectory = resolve(ceremonyOutputDir, CEREMONY_OBJECT_DIRECTORY_RELATIVE);
  const stagingDirectory = resolve(
    ceremonyOutputDir,
    `${CEREMONY_OBJECT_DIRECTORY_RELATIVE}.staging`,
  );
  const metadataPath = resolve(ceremonyOutputDir, CEREMONY_OPERATIONAL_METADATA_RELATIVE);
  const clearCeremonyOutputs = async () => {
    await ignoreEnoent(() => unlinkImpl(metadataPath));
    await ignoreEnoent(() => rmImpl(objectDirectory, { recursive: true, force: true }));
    await ignoreEnoent(() => rmImpl(stagingDirectory, { recursive: true, force: true }));
  };
  await clearCeremonyOutputs();

  try {
    const privateKeyPath = await ensureEnv('CEREMONY_PRIVATE_KEY_PATH', env);
    const keyId = await ensureEnv('CEREMONY_KEY_ID', env);

    await mkdirImpl(ceremonyOutputDir, { recursive: true });

    const privateKeyPem = await readFileImpl(privateKeyPath, 'utf8');
    const shards = await loadShardsToSign(root, readFileImpl);
    log(`✓ Loaded ${shards.length} shards to re-sign with key ${keyId}`);

    const staged = [];
    for (const shard of shards) {
      const archiveBytes = await resolveNestedAuthoringArchiveBytes({
        root,
        packId: shard.packId,
        archiveName: shard.archiveName,
        archiveSha256: shard.archiveSha256,
        readFileImpl,
      });
      const canonicalManifestBytes = await resolveNestedAuthoringCanonicalManifestBytes({
        root,
        packId: shard.packId,
        canonicalManifestSha256: shard.canonicalManifestSha256,
        canonicalManifestBytes: shard.canonicalManifestBytes,
        readFileImpl,
      });
      staged.push({
        shard,
        canonicalManifestBytes,
        archiveBytes,
      });
    }

    const records = [];
    for (const { shard, canonicalManifestBytes, archiveBytes } of staged) {
      const ceremonyPackPath = `packs/${shard.packId}/${shard.version}`;
      const archiveKey = `${ceremonyPackPath}/${shard.archiveName}`;
      const manifestKey = `${ceremonyPackPath}/signed-manifest.json`;

      const signed = await signManifest(
        canonicalManifestBytes,
        shard.canonicalManifestSha256,
        shard,
        privateKeyPem,
        keyId,
      );

      const manifestOutputDir = resolve(stagingDirectory, ceremonyPackPath);
      await mkdirImpl(manifestOutputDir, { recursive: true });
      await writeFileImpl(
        resolve(manifestOutputDir, 'signed-manifest.json'),
        signed.envelopeBytes,
      );
      await writeFileImpl(resolve(stagingDirectory, archiveKey), archiveBytes);

      records.push({
        packId: shard.packId,
        version: shard.version,
        archiveName: shard.archiveName,
        archiveKey,
        manifestKey,
        archiveSha256: shard.archiveSha256,
        archiveBytes: shard.archiveBytes,
        archiveMd5Etag: shard.archiveMd5Etag,
        envelopeSha256: signed.envelopeSha256,
        envelopeByteCount: signed.envelopeByteCount,
        envelopeMd5Etag: signed.envelopeMd5Etag,
      });

      log(`✓ Signed and staged ${shard.packId}: envelope ${signed.envelopeSha256.substring(0, 8)}…`);
    }

    const ceremonyMetadata = {
      schemaVersion: 1,
      status: CEREMONY_READY_STATUS,
      keyId,
      producedAt: now().toISOString(),
      objectDirectory,
      manifests: records,
    };

    await writeFileImpl(metadataPath, jsonBytes(ceremonyMetadata));
    await renameImpl(stagingDirectory, objectDirectory);

    log(`\n✓ ${CEREMONY_COMPLETE_TEXT}`);
    log(`  Exact object directory (--ceremony-dir): ${objectDirectory}`);
    log(`  Signed manifests and archives count: ${records.length}`);
    return ceremonyMetadata;
  } catch (error) {
    await clearCeremonyOutputs();
    throw error;
  }
}

if (isMain(import.meta.url)) {
  await main().catch((error) => {
    console.error(`\n✗ ${error.message}`);
    process.exit(1);
  });
}
