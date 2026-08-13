// Rebuilds the e3-toy pack fixture: catalogue, audio authority, source audio,
// encoded payload and audio evidence.
//
// The payload is encoded from frame-aligned PCM without the silence-trim stage
// of the reviewed authoring chain. That is deliberate: FFmpeg 8.1.2 decodes an
// AAC stream to whole 1024-sample frames while later releases trim to the
// container-declared duration, so only a frame-aligned payload decodes to the
// same PCM — and therefore to the same committed evidence — on both. The
// committed .mp3 sources carry the same audio in the upstream source format.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPackAudioAuthority } from './lib/pack-audio-authority.mjs';
import {
  analysePcm16le,
  createAudioSourceKey,
} from './lib/starter-audio-evidence.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = resolve(ROOT, 'tests/fixtures/e3-toy-pack');
const AUTHORITY = 'config/packs/e3-toy.audio.json';
const SAMPLE_RATE = 22050;
const FRAME = 1024;
// Frame counts chosen so every duration sits inside the reviewed bounds and the
// slow variant lands at 1.30x its normal prompt (bounds are 1.05x-1.65x).
const FRAMES = Object.freeze({
  'word-natural': [14, 16],
  'dictation-normal': [100, 108],
  'dictation-slow': [130, 140],
});
const TONE_HZ = Object.freeze({ Iapetus: 220, Sulafat: 330 });
// Every asset must carry distinct bytes, so a swapped voice or item cannot pass
// unnoticed: tone separates the voices, and a per-item offset separates the
// words within one voice.
const ITEM_TONE_STEP = 37;

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function run(command, arguments_) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', rejectPromise);
    child.once('close', (code) => {
      if (code === 0) resolvePromise(Buffer.concat(stdout));
      else rejectPromise(new Error(`${command} failed: ${Buffer.concat(stderr)}`));
    });
  });
}

function wavBytes(sampleCount, toneHz) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + sampleCount * 2, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(sampleCount * 2, 40);
  const samples = Buffer.alloc(sampleCount * 2);
  const lead = Math.round(SAMPLE_RATE * 0.08);
  const tail = sampleCount - Math.round(SAMPLE_RATE * 0.08);
  for (let index = 0; index < sampleCount; index += 1) {
    const speaking = index >= lead && index < tail;
    // A slow tremolo keeps the decoded RMS inside the reviewed level bounds.
    const envelope = speaking
      ? 0.7 + (0.3 * Math.sin((2 * Math.PI * 3 * index) / SAMPLE_RATE))
      : 0;
    samples.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * toneHz * index) / SAMPLE_RATE) * 9_000 * envelope),
      index * 2,
    );
  }
  return Buffer.concat([header, samples]);
}

async function encode(wavPath, target, extraArguments) {
  await mkdir(dirname(target), { recursive: true });
  await rm(target, { force: true });
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', wavPath,
    '-ac', '1', '-ar', String(SAMPLE_RATE), ...extraArguments,
    '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact',
    target,
  ]);
}

async function decodeAnalysis(path) {
  const pcm = await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', path,
    '-f', 's16le', '-acodec', 'pcm_s16le',
    '-ac', '1', '-ar', String(SAMPLE_RATE), '-',
  ]);
  if (pcm.byteLength % (FRAME * 2) !== 0) {
    throw new Error(`${path} decodes to a non-frame-aligned sample count`);
  }
  return analysePcm16le(pcm, { sampleRateHz: SAMPLE_RATE, label: 'Fixture' });
}

const pack = await loadPackAudioAuthority(AUTHORITY);
const inventory = pack.createInventory(pack.catalogue);
const scratch = resolve(ROOT, '.native-build/e3-toy-fixture');
await rm(scratch, { recursive: true, force: true });
await mkdir(scratch, { recursive: true });

const assets = [];
for (const asset of inventory) {
  const itemIndex = pack.catalogue.items.findIndex(
    ({ runtimeItemId }) => runtimeItemId === asset.runtimeItemId,
  );
  if (itemIndex < 0) throw new Error(`unknown item for ${asset.audioKey}`);
  const sampleCount = FRAMES[asset.audioKind][itemIndex % 2] * FRAME;
  const toneHz = TONE_HZ[asset.voiceId] + (itemIndex * ITEM_TONE_STEP);
  const wavPath = resolve(scratch, `${asset.audioKey.replace(/[^\w-]/gu, '_')}.wav`);
  await writeFile(wavPath, wavBytes(sampleCount, toneHz));
  const payloadPath = resolve(FIXTURE, 'payload', asset.assetPath);
  await encode(wavPath, payloadPath, ['-c:a', 'aac', '-b:a', '48k', '-movflags', '+faststart']);
  const payloadBytes = await readFile(payloadPath);
  const analysis = await decodeAnalysis(payloadPath);

  // Word assets are copied byte-for-byte, so the payload is its own source.
  let sourceBytes = payloadBytes;
  if (asset.sourceKind !== 'word') {
    const sourcePath = resolve(FIXTURE, 'source', asset.sourcePath);
    await encode(wavPath, sourcePath, ['-c:a', 'libmp3lame', '-b:a', '48k']);
    sourceBytes = await readFile(sourcePath);
  }
  assets.push({
    sequence: asset.sequence,
    audioKey: asset.audioKey,
    assetPath: asset.assetPath,
    sourceKind: asset.sourceKind,
    sourceKey: createAudioSourceKey(asset),
    sourcePath: asset.sourcePath,
    sourceByteSize: sourceBytes.byteLength,
    sourceSha256: digest(sourceBytes),
    tempoFactor: 1,
    inputSha256: digest(Buffer.from(asset.input)),
    generationSpecSha256: digest(Buffer.from(JSON.stringify(asset.generationSpec))),
    byteSize: payloadBytes.byteLength,
    sha256: digest(payloadBytes),
    codec: 'aac',
    sampleRateHz: SAMPLE_RATE,
    channels: 1,
    ...analysis,
  });
}

const evidence = pack.validateEvidence({
  schemaVersion: 1,
  status: 'pass',
  catalogueId: pack.catalogueId,
  ...pack.createEvidenceAuthority(pack.catalogue, { inventory }),
  assetCount: assets.length,
  format: pack.authority.encoding.format,
  assets,
}, { catalogue: pack.catalogue, inventory });
await writeFile(pack.audioEvidenceSource, jsonBytes(evidence));
await rm(scratch, { recursive: true, force: true });
process.stdout.write(`e3-toy fixture rebuilt: ${assets.length} assets.\n`);
