import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  B4_AUDIO_AUTHORITY,
  B4_COMMAND_TRACE,
  B4_PRODUCT_IDENTIFIER,
  B4_RUNTIME_ITEM_IDS,
  B4_SENTENCE_PROMPTS,
  createB4AudioInventory,
  validateB4AudioManifest,
} from '../src/app/b4-round-contract.js';
import { resolveB4AudioPath } from '../src/app/b4-local-audio.js';

const root = new URL('..', import.meta.url);
const manifestUrl = new URL('../config/b4-audio-manifest.json', import.meta.url);
const execFileAsync = promisify(execFile);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function traceBytes() {
  return JSON.stringify({
    runtimeItemIds: B4_RUNTIME_ITEM_IDS,
    commandTrace: B4_COMMAND_TRACE,
    sentencePrompts: B4_SENTENCE_PROMPTS,
  });
}

async function loadManifest() {
  return JSON.parse(await readFile(manifestUrl, 'utf8'));
}

async function verifyBundle(manifestValue, {
  directoryEntries = null,
  inspectAsset = lstat,
} = {}) {
  const manifest = validateB4AudioManifest(manifestValue);
  const inventory = createB4AudioInventory();
  assert.equal(manifest.authoritySha256, sha256(JSON.stringify(B4_AUDIO_AUTHORITY)));
  assert.equal(manifest.traceSha256, sha256(traceBytes()));
  const directory = new URL('../public/audio/b4/', import.meta.url);
  assert.deepEqual(
    (directoryEntries ?? await readdir(directory)).sort(),
    inventory.map(({ assetId }) => `${assetId}.wav`).sort(),
  );
  for (const [index, asset] of manifest.assets.entries()) {
    const expected = inventory[index];
    assert.equal(asset.inputSha256, sha256(expected.input));
    assert.equal(asset.generationSpecSha256, sha256(JSON.stringify(expected.generationSpec)));
    const url = new URL(`../public/${asset.path}`, import.meta.url);
    const stat = await inspectAsset(url);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
    const bytes = await readFile(url);
    assert.equal(bytes.byteLength, asset.byteSize);
    assert.equal(sha256(bytes), asset.assetSha256);
  }
  return manifest;
}

test('generated manifest binds the exact public-domain authority, trace, specs and 25 real WAV files', async () => {
  const manifest = await verifyBundle(await loadManifest());
  const inventory = createB4AudioInventory();
  assert.equal(manifest.productIdentifier, B4_PRODUCT_IDENTIFIER);
  assert.equal(manifest.authoritySha256, sha256(JSON.stringify(B4_AUDIO_AUTHORITY)));
  assert.equal(manifest.traceSha256, sha256(traceBytes()));
  assert.equal(manifest.assetCount, 25);
  assert.deepEqual(
    inventory.filter(({ kind }) => kind === 'word-natural').map(({ input }) => input),
    ['answer.', 'appear.', 'arrive.', 'bicycle.', 'build.'],
  );
  assert.equal(inventory.find(({ assetId }) => assetId === 'b4-11').input,
    'We will... arrive before lunch.');

  for (const [index, asset] of manifest.assets.entries()) {
    const expected = inventory[index];
    assert.equal(asset.inputSha256, sha256(expected.input));
    assert.equal(asset.generationSpecSha256, sha256(JSON.stringify(expected.generationSpec)));
    const url = new URL(`../public/${asset.path}`, import.meta.url);
    const stat = await lstat(url);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
    const bytes = await readFile(url);
    assert.equal(bytes.byteLength, asset.byteSize);
    assert.equal(sha256(bytes), asset.assetSha256);
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
    assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
    assert.equal(bytes.readUInt16LE(20), 1, 'PCM');
    assert.equal(bytes.readUInt16LE(22), 1, 'mono');
    assert.equal(bytes.readUInt32LE(24), 22_050);
    assert.equal(bytes.readUInt16LE(34), 16);
  }
});

test('manifest validation rejects missing, extra, path, request, authority and hash drift', async () => {
  const manifest = await loadManifest();
  const mutations = [
    (value) => { value.assets.pop(); value.assetCount -= 1; },
    (value) => { value.extra = true; },
    (value) => { value.assets[0].path = 'https://example.test/a.wav'; },
    (value) => { value.assets[0].generationSpec.voice = 'other'; },
    (value) => { value.authority.engine = 'other'; },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(manifest);
    mutate(candidate);
    assert.throws(
      () => validateB4AudioManifest(candidate),
      (error) => error?.code === 'b4_audio_authority_incomplete',
    );
  }
  const hashDrift = structuredClone(manifest);
  hashDrift.assets[0].assetSha256 = '0'.repeat(64);
  await assert.rejects(verifyBundle(hashDrift), assert.AssertionError);
  await assert.rejects(verifyBundle(manifest, {
    directoryEntries: [
      ...createB4AudioInventory().map(({ assetId }) => `${assetId}.wav`),
      'extra.wav',
    ],
  }), assert.AssertionError);
  await assert.rejects(verifyBundle(manifest, {
    inspectAsset: async () => ({ isFile: () => true, isSymbolicLink: () => true }),
  }), assert.AssertionError);
});

test('runtime lookup resolves only an exact manifest-listed local cue', async () => {
  const manifest = await loadManifest();
  assert.equal(resolveB4AudioPath(manifest, {
    runtimeItemId: 'ks2-core:arrive',
    sentence: 'The parcel should arrive tomorrow.',
  }), 'audio/b4/b4-06.wav');
  assert.equal(resolveB4AudioPath(manifest, {
    runtimeItemId: 'ks2-core:arrive',
    sentence: 'The parcel should arrive tomorrow.',
    slow: true,
  }), 'audio/b4/b4-07.wav');
  assert.equal(resolveB4AudioPath(manifest, {
    runtimeItemId: 'ks2-core:arrive',
  }), 'audio/b4/b4-03.wav');
  assert.throws(
    () => resolveB4AudioPath(manifest, { runtimeItemId: 'ks2-core:foreign' }),
    (error) => error?.code === 'b4_audio_asset_missing',
  );
});

test('B4 product paths contain no runtime fetch, provider or client TTS implementation', async () => {
  const paths = [
    'src/app/App.jsx',
    'src/app/b4-local-audio.js',
    'src/app/b4-round-contract.js',
    'src/app/b4-round-controller.js',
    'src/app/create-app-services.js',
    'src/app/create-b4-app-services.js',
  ];
  const source = (await Promise.all(paths.map((path) => readFile(join(root.pathname, path), 'utf8')))).join('\n');
  assert.doesNotMatch(source, /\bfetch\s*\(/u);
  assert.doesNotMatch(source, /speechSynthesis|SpeechSynthesisUtterance|AVSpeechSynthesizer|TextToSpeech/u);
  assert.doesNotMatch(source, /\bspawn\s*\(|\buvx\b|\bpiper\b|OPENAI_API_KEY|\/v1\/audio\/speech/u);
  assert.match(source, /Audio is unavailable just now\. You can still continue\./u);
});

test('authoring generator pins public-domain Piper, exact deterministic settings and no secret route', async () => {
  const source = await readFile(new URL('../scripts/generate-b4-audio.mjs', import.meta.url), 'utf8');
  assert.match(source, /createB4AudioInventory\(\)/u);
  assert.match(source, /for \(const asset of inventory\)/u);
  assert.match(source, /flag: 'wx'/u);
  assert.match(source, /spawn\('uvx'/u);
  for (const flag of ['--from', '--noise-scale', '--noise-w-scale', '--length-scale']) {
    assert.ok(source.includes(`'${flag}'`), flag);
  }
  assert.equal(B4_AUDIO_AUTHORITY.modelCommit, '5b44ec7bab7c5822cfec48fbd5aa99db71a823d6');
  assert.equal(B4_AUDIO_AUTHORITY.modelSha256, '1899f98e5fb8310154f3c2973f4b8a929ba7245e722b3d3a85680b833d95f10d');
  assert.equal(B4_AUDIO_AUTHORITY.configSha256, 'e262c16d7f192f69d4edd6b4ef8a5915379e67495fcc402f1ab15eeb33da3d36');
  assert.equal(B4_AUDIO_AUTHORITY.voiceRightsUrl, 'https://brycebeattie.com/files/tts/');
  assert.match(B4_AUDIO_AUTHORITY.modelCardUrl, /5b44ec7bab7c5822cfec48fbd5aa99db71a823d6/u);
  assert.doesNotMatch(source, /api\.openai|OPENAI_API_KEY|Authorization|Bearer|process\.env|ffmpeg|retry|setTimeout|speechSynthesis/u);
  assert.doesNotMatch(source, /console\./u);
});

test('B4 Vite build contains all 25 exact WAV bytes and bound manifest authority', async () => {
  const manifest = await loadManifest();
  await execFileAsync('npm', ['run', 'build:b4-development'], {
    cwd: root,
    env: process.env,
  });
  for (const asset of manifest.assets) {
    const [source, built] = await Promise.all([
      readFile(new URL(`../public/${asset.path}`, import.meta.url)),
      readFile(new URL(`../dist/${asset.path}`, import.meta.url)),
    ]);
    assert.deepEqual(built, source, asset.path);
  }
  const builtEntries = await readdir(
    new URL('../dist/assets/', import.meta.url),
    { withFileTypes: true },
  );
  const builtScripts = await Promise.all(
    builtEntries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
      .map((entry) => readFile(
        new URL(`../dist/assets/${entry.name}`, import.meta.url),
        'utf8',
      )),
  );
  const source = builtScripts.join('\n');
  assert.match(source, new RegExp(manifest.authoritySha256, 'u'));
  assert.match(source, /en_GB-cori-medium/u);
  assert.match(source, /public domain; permitted for any legal and ethical purpose/u);
  assert.match(source, /bundled-development-proof/u);
});
