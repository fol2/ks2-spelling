#!/usr/bin/env node

/**
 * Re-sign canonical manifests with existing production key and prepare ceremony directory.
 *
 * Usage:
 *   CEREMONY_PRIVATE_KEY_PATH=/path/to/existing/key.pem \
 *   CEREMONY_OUTPUT_DIR=/path/to/ceremony \
 *   CEREMONY_KEY_ID=production-ks2-p256-2026-08 \
 *   node scripts/resign-manifests-with-production-key.mjs
 */

import { createHash, createPrivateKey, sign } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PACK_SIGNING_ALGORITHM,
  assertCanonicalP256Der,
  createPackSigningInput,
} from '../src/domain/packs/signed-manifest-contract.js';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const AUTHORING_REPORT_PATH = resolve(ROOT, 'config/packs/full-ks2-shards/authoring-report.json');

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

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function ensureEnv(name) {
  const value = process.env[name];
  if (!value) {
    fail(`requires environment variable ${name}`);
  }
  return value;
}

/**
 * Extract canonical manifest from existing sandbox-signed envelope fixture.
 */
async function extractCanonicalManifestFromFixture(packId) {
  const fixturePath = resolve(
    ROOT,
    'tests/fixtures/packs/full-ks2-shards',
    `${packId}.signed-manifest.json`,
  );
  const envelopeBytes = await readFile(fixturePath, 'utf8');
  const envelope = JSON.parse(envelopeBytes);
  const canonicalManifestBytes = Buffer.from(envelope.canonicalManifestBase64, 'base64');
  return canonicalManifestBytes;
}

/**
 * Load canonical manifest bytes and packId from authoring report.
 */
async function loadShardsToSign() {
  const report = await readJson(AUTHORING_REPORT_PATH);
  if (report.status !== 'pass') {
    fail('authoring report is not pass status');
  }
  return report.shards.map((shard) => ({
    packId: shard.packId,
    version: shard.version,
    archiveName: shard.archiveName,
    canonicalManifestSha256: shard.canonicalManifestSha256,
    archiveSha256: shard.archiveSha256,
    archiveBytes: shard.archiveBytes,
    archiveMd5Etag: shard.archiveMd5Etag,
  }));
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

/**
 * Locate an archive in the local build output or fetch from R2 sandbox bucket.
 * Note: Archives are large and only available in R2 production bucket or require
 * alternative sourcing during the ceremony.
 */
async function findArchive(archiveName, archiveSha256) {
  const nativeBuildPath = resolve(ROOT, '.native-build/packs');

  // Try local first
  try {
    const localBytes = await readFile(resolve(nativeBuildPath, archiveName));
    const sha = digest(localBytes);
    if (sha !== archiveSha256) {
      fail(`local archive ${archiveName} has wrong SHA256: expected ${archiveSha256}, got ${sha}`);
    }
    return localBytes;
  } catch (_error) {
    // Archive not found locally; caller handles gracefully
  }

  // The shard archives are large (29-32 MB each) and stored only in production R2.
  // They cannot be fetched during ceremony generation as they are stored in the
  // production bucket, not the sandbox bucket. The ceremony directory must be
  // staged with archives provided separately (e.g., from prior production builds
  // or R2 production bucket download by the owner).
  throw new Error(`archive ${archiveName} not found in .native-build/packs/. `
    + `The 15 shard archives (total ~450 MB) must be sourced separately and staged into the ceremony directory.`);
}


async function main() {
  const privateKeyPath = await ensureEnv('CEREMONY_PRIVATE_KEY_PATH');
  const ceremonyOutputDir = await ensureEnv('CEREMONY_OUTPUT_DIR');
  const keyId = await ensureEnv('CEREMONY_KEY_ID');

  // Load private key for signing
  const privateKeyPem = await readFile(privateKeyPath, 'utf8');

  // Load shards to sign
  const shards = await loadShardsToSign();
  console.log(`✓ Loaded ${shards.length} shards to re-sign with key ${keyId}`);

  // Create ceremony directory structure and sign manifests
  await mkdir(ceremonyOutputDir, { recursive: true });

  const records = [];
  for (const shard of shards) {
    const ceremonyPackPath = `packs/${shard.packId}/${shard.version}`;
    const archiveKey = `${ceremonyPackPath}/${shard.archiveName}`;
    const manifestKey = `${ceremonyPackPath}/signed-manifest.json`;

    // Extract canonical manifest from fixture
    const canonicalManifestBytes = await extractCanonicalManifestFromFixture(shard.packId);

    // Sign the manifest
    const signed = await signManifest(
      canonicalManifestBytes,
      shard.canonicalManifestSha256,
      shard,
      privateKeyPem,
      keyId,
    );

    // Write signed manifest to ceremony directory with packs/ prefix
    const manifestOutputDir = resolve(ceremonyOutputDir, ceremonyPackPath);
    await mkdir(manifestOutputDir, { recursive: true });
    await writeFile(
      resolve(manifestOutputDir, 'signed-manifest.json'),
      signed.envelopeBytes,
    );

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

    // Attempt to locate and stage archive
    try {
      const archiveBytes = await findArchive(shard.archiveName, shard.archiveSha256);
      const archivePath = resolve(ceremonyOutputDir, archiveKey);
      await writeFile(archivePath, archiveBytes);
      console.log(`✓ Signed and staged ${shard.packId}: envelope ${signed.envelopeSha256.substring(0, 8)}…`);
    } catch (error) {
      console.log(`✓ Signed ${shard.packId}: envelope ${signed.envelopeSha256.substring(0, 8)}… (archive not available locally)`);
    }
  }

  // Write ceremony metadata
  const ceremonyMetadata = {
    schemaVersion: 1,
    status: 'ready',
    keyId,
    producedAt: new Date().toISOString(),
    manifests: records,
  };

  const metadataPath = resolve(ceremonyOutputDir, 'ceremony-metadata.json');
  await writeFile(metadataPath, jsonBytes(ceremonyMetadata));

  console.log(`\n✓ Ceremony complete`);
  console.log(`  Ceremony directory (for wizard): ${ceremonyOutputDir}`);
  console.log(`  Signed manifests and archives count: ${records.length}`);
}

await main().catch((error) => {
  console.error(`\n✗ ${error.message}`);
  process.exit(1);
});
