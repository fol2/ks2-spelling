import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  B4_AUDIO_AUTHORITY,
  B4_COMMAND_TRACE,
  B4_PRODUCT_IDENTIFIER,
  B4_RUNTIME_ITEM_IDS,
  B4_SENTENCE_PROMPTS,
  createB4AudioInventory,
  validateB4AudioManifest,
} from '../src/app/b4-round-contract.js';

const MAX_WAV_BYTES = 16 * 1_024 * 1_024;
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const audioTarget = join(repoRoot, 'public', 'audio', 'b4');
const manifestTarget = join(repoRoot, 'config', 'b4-audio-manifest.json');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function download(url, expectedSha256, target) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`B4 Piper authority download failed (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0 || sha256(bytes) !== expectedSha256) {
    throw new Error('B4 Piper authority download hash drifted.');
  }
  await writeFile(target, bytes, { flag: 'wx' });
}

function validateDirectWav(bytes) {
  if (bytes.byteLength < 44 || bytes.byteLength > MAX_WAV_BYTES ||
      bytes.toString('ascii', 0, 4) !== 'RIFF' ||
      bytes.toString('ascii', 8, 12) !== 'WAVE' ||
      bytes.readUInt32LE(4) + 8 !== bytes.byteLength) {
    throw new Error('B4 Piper output is not a bounded direct WAV file.');
  }
  let offset = 12;
  let formatFound = false;
  let dataBytes = 0;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = bytes.toString('ascii', offset, offset + 4);
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkStart + chunkSize > bytes.byteLength) {
      throw new Error('B4 Piper WAV chunk is truncated.');
    }
    if (chunkId === 'fmt ') {
      formatFound = chunkSize >= 16 &&
        bytes.readUInt16LE(chunkStart) === 1 &&
        bytes.readUInt16LE(chunkStart + 2) === 1 &&
        bytes.readUInt32LE(chunkStart + 4) === B4_AUDIO_AUTHORITY.sampleRateHz &&
        bytes.readUInt32LE(chunkStart + 8) === B4_AUDIO_AUTHORITY.sampleRateHz * 2 &&
        bytes.readUInt16LE(chunkStart + 12) === 2 &&
        bytes.readUInt16LE(chunkStart + 14) === 16;
    }
    if (chunkId === 'data') dataBytes = chunkSize;
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }
  if (!formatFound || dataBytes === 0) {
    throw new Error('B4 Piper WAV format drifted from PCM 16-bit mono 22050 Hz.');
  }
}

function runPiper({ asset, modelPath, configPath, outputPath }) {
  const spec = asset.generationSpec;
  const args = [
    '--from', `piper-tts==${spec.engineVersion}`,
    'piper',
    '--model', modelPath,
    '--config', configPath,
    '--output_file', outputPath,
    '--noise-scale', String(spec.noiseScale),
    '--noise-w-scale', String(spec.noiseWScale),
    '--length-scale', String(spec.lengthScale),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('uvx', args, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.once('error', () => reject(new Error('B4 pinned Piper process could not start.')));
    child.once('exit', (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new Error('B4 pinned Piper process failed.'));
    });
    child.stdin.end(Buffer.from(asset.input));
  });
}

async function generateAsset(asset, paths) {
  const outputPath = join(paths.audio, `${asset.assetId}.wav`);
  await runPiper({
    asset,
    modelPath: paths.model,
    configPath: paths.config,
    outputPath,
  });
  const bytes = await readFile(outputPath);
  validateDirectWav(bytes);
  return {
    assetId: asset.assetId,
    runtimeItemId: asset.runtimeItemId,
    sentence: asset.sentence,
    kind: asset.kind,
    path: asset.path,
    byteSize: bytes.byteLength,
    input: asset.input,
    inputSha256: sha256(Buffer.from(asset.input)),
    generationSpecSha256: sha256(JSON.stringify(asset.generationSpec)),
    generationSpec: asset.generationSpec,
    assetSha256: sha256(bytes),
  };
}

async function main() {
  if (await pathExists(audioTarget) || await pathExists(manifestTarget)) {
    throw new Error('B4 audio output already exists; generation is create-only.');
  }
  const inventory = createB4AudioInventory();
  const tempRoot = await mkdtemp(join(repoRoot, '.b4-audio-'));
  const paths = {
    audio: join(tempRoot, 'b4'),
    model: join(tempRoot, 'en_GB-cori-medium.onnx'),
    config: join(tempRoot, 'en_GB-cori-medium.onnx.json'),
  };
  const stagedManifest = join(tempRoot, 'b4-audio-manifest.json');
  let publishedAudio = false;
  try {
    await mkdir(paths.audio);
    await download(B4_AUDIO_AUTHORITY.modelUrl, B4_AUDIO_AUTHORITY.modelSha256, paths.model);
    await download(B4_AUDIO_AUTHORITY.configUrl, B4_AUDIO_AUTHORITY.configSha256, paths.config);
    const assets = [];
    for (const asset of inventory) assets.push(await generateAsset(asset, paths));
    const manifest = validateB4AudioManifest({
      schemaVersion: 1,
      productIdentifier: B4_PRODUCT_IDENTIFIER,
      authority: B4_AUDIO_AUTHORITY,
      authoritySha256: sha256(JSON.stringify(B4_AUDIO_AUTHORITY)),
      traceSha256: sha256(JSON.stringify({
        runtimeItemIds: B4_RUNTIME_ITEM_IDS,
        commandTrace: B4_COMMAND_TRACE,
        sentencePrompts: B4_SENTENCE_PROMPTS,
      })),
      assetCount: assets.length,
      assets,
    });
    await writeFile(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    for (const asset of manifest.assets) {
      const bytes = await readFile(join(paths.audio, `${asset.assetId}.wav`));
      validateDirectWav(bytes);
      if (bytes.byteLength !== asset.byteSize || sha256(bytes) !== asset.assetSha256) {
        throw new Error('B4 staged audio verification drifted.');
      }
    }
    if (await pathExists(audioTarget) || await pathExists(manifestTarget)) {
      throw new Error('B4 audio output appeared during generation; refusing publication.');
    }
    await mkdir(dirname(audioTarget), { recursive: true });
    await rename(paths.audio, audioTarget);
    publishedAudio = true;
    try {
      await rename(stagedManifest, manifestTarget);
    } catch (error) {
      await rm(audioTarget, { recursive: true, force: true });
      publishedAudio = false;
      throw error;
    }
  } finally {
    if (publishedAudio && !(await pathExists(manifestTarget))) {
      await rm(audioTarget, { recursive: true, force: true });
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
