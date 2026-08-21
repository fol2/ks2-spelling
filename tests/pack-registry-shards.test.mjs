import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import downloadableTable from '../config/downloadable-pack-authorities.json' with { type: 'json' };
import {
  B3_PACK_REGISTRY,
  findB3PackAuthority,
} from '../src/domain/packs/b3-pack-registry.js';
import {
  PACK_REGISTRY,
  findPackAuthority,
  readDownloadablePackRows,
} from '../src/domain/packs/pack-registry.js';

const ROOT = resolve(import.meta.dirname, '..');

const FIXTURE_ROW = Object.freeze({
  packId: 'full-ks2-shard-01',
  version: '1.0.0',
  requiredEntitlementId: 'full-ks2',
  archiveName: 'full-ks2-shard-01-1.0.0.zip',
  allowedExtensions: ['.json', '.m4a'],
  ceilings: {
    fileCount: 547,
    compressedBytes: 33_554_432,
    extractedBytes: 33_554_432,
  },
  manifestSha256: 'a'.repeat(64),
  manifestBytes: 1_135,
  manifestEtag: 'b'.repeat(32),
  archiveSha256: 'c'.repeat(64),
  archiveBytes: 29_903_190,
  archiveEtag: 'd'.repeat(32),
});

test('the B3 registry resolves the proof row while the production registry rejects it', () => {
  assert.equal(findB3PackAuthority('b3-sandbox-proof').packId, 'b3-sandbox-proof');
  assert.equal(B3_PACK_REGISTRY.length, PACK_REGISTRY.length + 1);
  assert.throws(() => findPackAuthority('b3-sandbox-proof'), /is not registered/u);
  assert.throws(() => findPackAuthority('full-ks2-shard-99'), /is not registered/u);
});

test('an empty downloadable table adds no rows', () => {
  assert.deepEqual(readDownloadablePackRows({ schemaVersion: 1, packs: [] }), []);
  assert.throws(
    () => readDownloadablePackRows({ schemaVersion: 2, packs: [] }),
    /approved downloadable-pack document/u,
  );
});

test('a complete shard row is validated by the closed authority contract', () => {
  const [row] = readDownloadablePackRows({
    schemaVersion: 1,
    packs: [structuredClone(FIXTURE_ROW)],
  });
  assert.equal(row.packId, 'full-ks2-shard-01');
  assert.equal(row.requiredEntitlementId, 'full-ks2');
  for (const mutate of [
    (value) => { delete value.manifestSha256; },
    (value) => { value.manifestSha256 = 'not-a-digest'; },
    (value) => { value.archiveBytes = value.ceilings.compressedBytes + 1; },
    (value) => { value.requiredEntitlementId = null; },
    (value) => { value.extra = true; },
  ]) {
    const mutated = structuredClone(FIXTURE_ROW);
    mutate(mutated);
    assert.throws(
      () => readDownloadablePackRows({ schemaVersion: 1, packs: [mutated] }),
      TypeError,
    );
  }
});

// When the owner ceremony appends real rows, each must agree with its tracked
// build authority and the authoring report byte facts; until then this loop is
// empty and the registry carries the b3 row alone.
test('every tracked downloadable row matches its shard authoring facts', async () => {
  for (const row of downloadableTable.packs) {
    const authority = JSON.parse(
      await readFile(resolve(ROOT, `config/packs/${row.packId}.json`), 'utf8'),
    );
    const report = JSON.parse(await readFile(
      resolve(ROOT, 'config/packs/full-ks2-shards/authoring-report.json'),
      'utf8',
    ));
    const built = report.shards.find(({ packId }) => packId === row.packId);
    assert.ok(built, row.packId);
    assert.equal(row.version, authority.version);
    assert.equal(row.archiveName, authority.archiveName);
    assert.equal(row.requiredEntitlementId, authority.requiredEntitlementId);
    assert.deepEqual(row.ceilings, authority.ceilings);
    assert.equal(row.archiveSha256, built.archiveSha256);
    assert.equal(row.archiveBytes, built.archiveBytes);
    assert.equal(row.archiveEtag, built.archiveMd5Etag);
  }
  assert.equal(
    PACK_REGISTRY.length,
    downloadableTable.packs.length,
  );
});
