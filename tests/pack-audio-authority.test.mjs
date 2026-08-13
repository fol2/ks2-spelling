import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';

import { loadPackAudioAuthority } from '../scripts/lib/pack-audio-authority.mjs';
import {
  FULL_AUDIO_AUTHORING_AUTHORITY,
  STARTER_AUDIO_AUTHORING_AUTHORITY,
} from '../scripts/lib/starter-audio-authoring-authority.mjs';
import {
  loadFullSpellingCatalogue,
  loadStarterSpellingCatalogue,
} from '../src/domain/spelling/index.js';
import {
  createFullAudioInventory,
  createStarterAudioInventory,
} from '../src/domain/spelling/starter-audio-contract.js';

const ROOT = resolve(import.meta.dirname, '..');
const TOY_AUDIO_AUTHORITY = 'config/packs/e3-toy.audio.json';

const plain = (value) => JSON.parse(JSON.stringify(value));

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// The two reviewed lanes must reduce to exactly what the frozen exports and the
// tracked evidence already record: the authority pair replaces how the lane is
// selected, never what it produces.
for (const lane of [
  {
    name: 'Starter',
    document: 'config/packs/ks2-core.audio.json',
    authority: STARTER_AUDIO_AUTHORING_AUTHORITY,
    catalogue: loadStarterSpellingCatalogue(),
    createInventory: createStarterAudioInventory,
    report: 'reports/c1/starter-audio-evidence.json',
    assetCount: 840,
    runtimeManifestTarget: null,
  },
  {
    name: 'Full',
    document: 'config/packs/ks2-core-full.audio.json',
    authority: FULL_AUDIO_AUTHORING_AUTHORITY,
    catalogue: loadFullSpellingCatalogue(),
    createInventory: createFullAudioInventory,
    report: 'reports/c2/full-audio-evidence.json',
    assetCount: 8_946,
    runtimeManifestTarget: resolve(ROOT, 'config/full-audio-manifest.json'),
  },
]) {
  test(`${lane.name} authority pair reproduces its frozen lane exactly`, async () => {
    const pack = await loadPackAudioAuthority(lane.document);
    const inventory = pack.createInventory(pack.catalogue);

    assert.equal(pack.label, lane.name);
    assert.equal(pack.runtimeManifestTarget, lane.runtimeManifestTarget);
    assert.deepEqual(plain(pack.authority), plain(lane.authority));
    assert.deepEqual(pack.catalogue, plain(lane.catalogue));
    assert.deepEqual(
      plain(inventory),
      plain(lane.createInventory(lane.catalogue)),
    );
    assert.equal(inventory.length, lane.assetCount);

    const tracked = JSON.parse(await readFile(resolve(ROOT, lane.report), 'utf8'));
    const derived = pack.createEvidenceAuthority(pack.catalogue, { inventory });
    assert.equal(derived.authoritySha256, tracked.authoritySha256);
    assert.equal(derived.catalogueSha256, tracked.catalogueSha256);
    assert.equal(derived.inventorySha256, tracked.inventorySha256);
    assert.deepEqual(
      pack.validateEvidence(tracked, { catalogue: pack.catalogue, inventory }),
      tracked,
    );
  });
}

test('every pack authority pair names the same catalogue and payload', async () => {
  for (const [buildDocument, audioDocument] of [
    ['config/packs/ks2-core.json', 'config/packs/ks2-core.audio.json'],
    ['config/packs/e3-toy.json', TOY_AUDIO_AUTHORITY],
  ]) {
    const build = JSON.parse(await readFile(resolve(ROOT, buildDocument), 'utf8'));
    const audio = JSON.parse(await readFile(resolve(ROOT, audioDocument), 'utf8'));
    assert.equal(build.catalogueId, audio.catalogueId, buildDocument);
    assert.equal(build.catalogueSource, audio.catalogueSource, buildDocument);
    assert.equal(build.audioSourceRoot, audio.audioSourceRoot, buildDocument);
    assert.equal(
      build.audioEvidenceSource,
      audio.audioEvidenceSource,
      buildDocument,
    );
  }
});

test('the fixture pack validates its committed evidence without an encoder', async () => {
  const pack = await loadPackAudioAuthority(TOY_AUDIO_AUTHORITY);
  const inventory = pack.createInventory(pack.catalogue);
  assert.equal(pack.label, 'Fixture');
  assert.equal(inventory.length, 12);
  assert.equal(pack.requiresExternalSource, true);

  const evidence = JSON.parse(await readFile(pack.audioEvidenceSource, 'utf8'));
  assert.deepEqual(
    pack.validateEvidence(evidence, { catalogue: pack.catalogue, inventory }),
    evidence,
  );
  // Every payload member must be the exact bytes the evidence records, and must
  // decode to a whole number of 1024-sample AAC frames. FFmpeg 8.1.2 emits
  // whole frames while later releases trim to the declared duration, so only a
  // frame-aligned payload measures the same on both and lets this committed
  // evidence verify wherever the fixture is checked.
  for (const record of evidence.assets) {
    const bytes = await readFile(resolve(pack.audioSourceRoot, record.assetPath));
    assert.equal(bytes.byteLength, record.byteSize, record.assetPath);
    assert.equal(sha256(bytes), record.sha256, record.assetPath);
    const samples = Math.round((record.durationMs * record.sampleRateHz) / 1_000);
    assert.equal(samples % 1_024, 0, `${record.assetPath} is not frame-aligned`);
  }
  // Distinct bytes per asset, so a swapped voice or item cannot pass unnoticed.
  assert.equal(
    new Set(evidence.assets.map(({ sha256 }) => sha256)).size,
    evidence.assets.length,
  );
});

test('the fixture pack builds its artifact from the same authority pair', async (t) => {
  const output = await mkdtemp(join(tmpdir(), 'ks2-e3-author-'));
  t.after(() => rm(output, { recursive: true, force: true }));

  const result = spawnSync(
    process.execPath,
    [
      'scripts/build-starter-pack.mjs',
      '--authority=config/packs/e3-toy.json',
      `--output-directory=${output}`,
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const manifest = JSON.parse(
    await readFile(join(output, 'unsigned-canonical-manifest.json'), 'utf8'),
  );
  const archive = await readFile(join(output, 'e3-toy-1.0.0.zip'));
  assert.equal(manifest.packId, 'e3-toy');
  assert.equal(manifest.archive.sha256, sha256(archive));
  // One catalogue plus the twelve verified audio members.
  assert.equal(manifest.files.length, 13);
  assert.equal(manifest.files[0].path, 'catalogue.json');

  const evidence = JSON.parse(
    await readFile(resolve(ROOT, 'tests/fixtures/e3-toy-pack/audio-evidence.json'), 'utf8'),
  );
  assert.deepEqual(
    manifest.files.slice(1).map(({ path }) => path),
    evidence.assets.map(({ assetPath }) => assetPath),
  );
});

test('a pack audio authority fails closed on schema and identity drift', async (t) => {
  await mkdir(join(ROOT, '.native-build'), { recursive: true });
  const scratch = await mkdtemp(join(ROOT, '.native-build', 'e3-audio-authority-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));

  const original = JSON.parse(
    await readFile(resolve(ROOT, TOY_AUDIO_AUTHORITY), 'utf8'),
  );
  const write = async (name, value) => {
    const path = join(scratch, name);
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
    return relative(ROOT, path);
  };

  await assert.rejects(
    loadPackAudioAuthority(
      await write('extra.json', { ...original, extraField: true }),
    ),
    /exactly the reviewed fields/u,
  );
  await assert.rejects(
    loadPackAudioAuthority(
      await write('escaped.json', { ...original, audioSourceRoot: '../outside' }),
    ),
    /identity or source paths drifted/u,
  );
  await assert.rejects(
    loadPackAudioAuthority(
      await write('mismatched.json', {
        ...original,
        audioAuthoritySource: 'config/starter-audio-authority.json',
      }),
    ),
    /different catalogue/u,
  );
});
