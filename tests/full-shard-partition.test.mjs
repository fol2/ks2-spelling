import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { deriveShardPlan } from '../scripts/author-full-shards.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const NATIVE_CEILING_BYTES = 33_554_432;
const NATIVE_CEILING_FILES = 1_024;

async function readJson(relativePath) {
  return JSON.parse(await readFile(resolve(ROOT, relativePath), 'utf8'));
}

const partition = await readJson('config/full-ks2-shard-partition.json');
const evidenceBytes = await readFile(resolve(ROOT, 'reports/c2/full-audio-evidence.json'));
const evidence = JSON.parse(evidenceBytes.toString('utf8'));
const catalogue = await readJson('vendor/ks2-mastery/content/spelling.mobile-runtime-full.json');

test('the committed partition is exactly the deterministic derivation', () => {
  const plan = deriveShardPlan(evidence, catalogue);
  assert.equal(partition.shardCount, plan.length);
  assert.equal(
    partition.audioEvidenceSha256,
    createHash('sha256').update(evidenceBytes).digest('hex'),
  );
  assert.deepEqual(
    partition.shards,
    plan.map(({ assets: _assets, ...shard }) => shard),
  );
});

test('the partition covers the tracked C2 evidence exactly once', async () => {
  const seenPaths = new Set();
  const evidenceByPath = new Map(
    evidence.assets.map((asset) => [asset.assetPath, asset]),
  );
  let payloadBytes = 0;
  for (const shard of partition.shards) {
    const manifest = await readJson(
      `config/packs/full-ks2-shards/${shard.packId}.manifest.json`,
    );
    assert.equal(manifest.packId, shard.packId);
    assert.equal(manifest.assetCount, shard.assetCount);
    assert.equal(manifest.assets.length, shard.assetCount);
    for (const asset of manifest.assets) {
      assert.equal(seenPaths.has(asset.assetPath), false, asset.assetPath);
      seenPaths.add(asset.assetPath);
      const tracked = evidenceByPath.get(asset.assetPath);
      // Bit-exact provenance: every shard member is pinned to the tracked C2
      // evidence record, byte size and SHA-256 both.
      assert.ok(tracked, asset.assetPath);
      assert.equal(asset.byteSize, tracked.byteSize, asset.assetPath);
      assert.equal(asset.sha256, tracked.sha256, asset.assetPath);
      payloadBytes += asset.byteSize;
    }
  }
  assert.equal(seenPaths.size, evidence.assetCount);
  assert.equal(payloadBytes, partition.payloadBytes);
});

test('every shard stays inside the attested native ceilings', async () => {
  for (const shard of partition.shards) {
    assert.ok(shard.payloadBytes < NATIVE_CEILING_BYTES, shard.packId);
    assert.ok(shard.fileCount <= NATIVE_CEILING_FILES, shard.packId);
    assert.equal(shard.fileCount, shard.assetCount + 1, shard.packId);
    const authority = await readJson(`config/packs/${shard.packId}.json`);
    assert.equal(authority.packId, shard.packId);
    assert.equal(authority.version, shard.version);
    assert.equal(authority.archiveName, shard.archiveName);
    assert.equal(authority.requiredEntitlementId, 'full-ks2');
    assert.equal(authority.catalogueId, 'ks2-core:full');
    assert.deepEqual(authority.ceilings, {
      fileCount: shard.fileCount,
      compressedBytes: NATIVE_CEILING_BYTES,
      extractedBytes: NATIVE_CEILING_BYTES,
    });
    assert.equal(
      authority.catalogueSource,
      `config/packs/full-ks2-shards/${shard.packId}.manifest.json`,
    );
    assert.equal(authority.audioEvidenceSource, authority.catalogueSource);
  }
});

test('the authoring report pins every shard artifact within its bounds', async () => {
  const report = await readJson('config/packs/full-ks2-shards/authoring-report.json');
  assert.equal(report.status, 'pass');
  assert.equal(report.audioEvidenceSha256 ?? report.provenance.audioEvidenceSha256,
    partition.audioEvidenceSha256);
  assert.equal(report.shardCount, partition.shardCount);
  assert.equal(report.assetCount, partition.assetCount);
  assert.deepEqual(
    report.shards.map(({ packId }) => packId),
    partition.shards.map(({ packId }) => packId),
  );
  for (const shard of report.shards) {
    assert.match(shard.archiveSha256, /^[a-f0-9]{64}$/u, shard.packId);
    assert.match(shard.archiveMd5Etag, /^[a-f0-9]{32}$/u, shard.packId);
    assert.ok(shard.archiveBytes <= NATIVE_CEILING_BYTES, shard.packId);
    // The per-shard canonical manifest must clear the 1 MiB signed-envelope
    // bound that the single-catalogue manifest exceeded (the split's reason).
    assert.ok(shard.canonicalManifestBytes < 1_048_576, shard.packId);
  }
});
