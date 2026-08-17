#!/usr/bin/env node

/**
 * Mint production ECDSA P-256 signing key, re-sign canonical manifests, and
 * prepare ceremony directory.
 *
 * Usage:
 *   CEREMONY_PRIVATE_KEY_PATH=/path/outside/repo \
 *   CEREMONY_OUTPUT_DIR=/path/to/ceremony \
 *   node scripts/mint-production-signing-key.mjs
 *
 * This script:
 * - Generates production key pair (P-256)
 * - Writes private key to untracked location (mode 0600)
 * - Derives public key entry for keyring
 * - Re-signs all 15 canonical manifests from authoring output
 * - Creates ceremony-dir ready for validateCeremonyDirectory
 * - Records envelope hashes and metadata
 */

import { createHash, generateKeyPairSync, createPrivateKey, sign } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PACK_SIGNING_ALGORITHM,
  assertCanonicalP256Der,
  createPackSigningInput,
} from '../src/domain/packs/signed-manifest-contract.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AUTHORING_REPORT_PATH = resolve(ROOT, 'config/packs/full-ks2-shards/authoring-report.json');

function fail(detail) {
  throw new Error(`Mint production signing key ${detail}.`);
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
 * Generate production key pair and format public key entry for keyring.
 * Private key is written to untracked path; public key is returned.
 */
async function generateProductionKeyEntry(privateKeyPath, keyId) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // Write private key to untracked location, mode 0600
  const privateKeyDir = dirname(privateKeyPath);
  await mkdir(privateKeyDir, { recursive: true, mode: 0o700 });
  await writeFile(privateKeyPath, privateKey, { mode: 0o600 });

  const publicKeySpkiDerBase64 = publicKey.toString('base64');
  const publicKeySpkiSha256 = digest(publicKey);

  // Calculate notAfter as 10 years from now
  const now = new Date();
  const notAfter = new Date(now.getFullYear() + 10, now.getMonth(), now.getDate());
  notAfter.setUTCHours(0, 0, 0, 0);

  return {
    keyId,
    algorithm: PACK_SIGNING_ALGORITHM,
    publicKeySpkiDerBase64,
    publicKeySpkiSha256,
    testOnly: false,
    notBefore: new Date().toISOString().split('T')[0] + 'T00:00:00Z',
    notAfter: notAfter.toISOString().split('T')[0] + 'T00:00:00Z',
    allowedEnvironments: ['production'],
    allowedPackIds: [
      'full-ks2-shard-01',
      'full-ks2-shard-02',
      'full-ks2-shard-03',
      'full-ks2-shard-04',
      'full-ks2-shard-05',
      'full-ks2-shard-06',
      'full-ks2-shard-07',
      'full-ks2-shard-08',
      'full-ks2-shard-09',
      'full-ks2-shard-10',
      'full-ks2-shard-11',
      'full-ks2-shard-12',
      'full-ks2-shard-13',
      'full-ks2-shard-14',
      'full-ks2-shard-15',
    ],
  };
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
 * Read canonical manifest and create signed envelope.
 */
async function signManifest(
  canonicalManifestBytes,
  canonicalManifestSha256,
  shard,
  privateKeyPem,
  keyEntry,
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
    keyId: keyEntry.keyId,
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

async function main() {
  const privateKeyPath = await ensureEnv('CEREMONY_PRIVATE_KEY_PATH');
  const ceremonyOutputDir = await ensureEnv('CEREMONY_OUTPUT_DIR');
  const keyId = 'production-ks2-p256-2026-08';

  console.log('Generating production ECDSA P-256 key pair…');
  const keyEntry = await generateProductionKeyEntry(privateKeyPath, keyId);
  console.log(
    `✓ Private key written to: ${privateKeyPath} (mode 0600)`,
  );
  console.log(`✓ Public key SHA-256: ${keyEntry.publicKeySpkiSha256}`);

  // Load private key for signing
  const privateKeyPem = await readFile(privateKeyPath, 'utf8');

  // Load shards to sign
  const shards = await loadShardsToSign();
  console.log(`✓ Loaded ${shards.length} shards to re-sign`);

  // Create ceremony directory structure and sign manifests
  await mkdir(ceremonyOutputDir, { recursive: true });

  const records = [];
  for (const shard of shards) {
    const manifestPath = `${shard.packId}/${shard.version}`;
    const archiveKey = `packs/${manifestPath}/${shard.archiveName}`;
    const manifestKey = `packs/${manifestPath}/signed-manifest.json`;

    // Extract canonical manifest from fixture
    const canonicalManifestBytes = await extractCanonicalManifestFromFixture(shard.packId);

    // Sign the manifest
    const signed = await signManifest(
      canonicalManifestBytes,
      shard.canonicalManifestSha256,
      shard,
      privateKeyPem,
      keyEntry,
    );

    // Write signed manifest to ceremony directory
    const manifestOutputDir = resolve(ceremonyOutputDir, manifestPath);
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

    console.log(`✓ Signed ${shard.packId}: envelope ${signed.envelopeSha256.substring(0, 8)}…`);
  }

  // Write ceremony metadata
  const ceremonyMetadata = {
    schemaVersion: 1,
    status: 'ready',
    keyId: keyEntry.keyId,
    producedAt: new Date().toISOString(),
    publicKeyEntry: keyEntry,
    manifests: records,
  };

  const metadataPath = resolve(ceremonyOutputDir, 'ceremony-metadata.json');
  await writeFile(metadataPath, jsonBytes(ceremonyMetadata));

  console.log(`\n✓ Ceremony complete`);
  console.log(`  Private key (NEVER commit): ${privateKeyPath}`);
  console.log(`  Ceremony directory (for wizard): ${ceremonyOutputDir}`);
  console.log(`  Keyring entry for landing: ${keyEntry.keyId}`);
  console.log(`  Signed manifests count: ${records.length}`);
}

await main().catch((error) => {
  console.error(`\n✗ ${error.message}`);
  process.exit(1);
});
