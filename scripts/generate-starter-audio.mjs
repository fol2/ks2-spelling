import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadStarterSpellingCatalogue } from '../src/domain/spelling/index.js';
import {
  createStarterAudioInventory,
} from '../src/domain/spelling/starter-audio-contract.js';
import {
  STARTER_AUDIO_AUTHORING_AUTHORITY as STARTER_AUDIO_AUTHORITY,
} from './lib/starter-audio-authoring-authority.mjs';
import {
  analysePcm16le,
  createStarterAudioEvidenceAuthority,
  validateStarterAudioEvidence,
} from './lib/starter-audio-evidence.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = resolve(ROOT, '.native-build/c1/authoring');
const SOURCE_ROOT = resolve(ROOT, 'content/starter-pack');
const AUDIO_TARGET = resolve(SOURCE_ROOT, 'audio');
const REPORT_TARGET = resolve(ROOT, 'reports/c1/starter-audio-evidence.json');
const OBSERVATION_TARGET = resolve(
  ROOT,
  '.native-build/c1/last-starter-audio-observation.json',
);
const PYTHON_HELPER = resolve(ROOT, 'scripts/lib/generate-starter-audio.py');
const MAX_MODEL_BYTES = 128 * 1_024 * 1_024;
const MAX_CONFIG_BYTES = 64 * 1_024;
const MAX_AUDIO_BYTES = 2 * 1_024 * 1_024;
const PROCESS_ERROR_BYTES = 64 * 1_024;
const ENCODE_CONCURRENCY = 8;

function generationError(detail, options) {
  return new Error(`Starter audio generation ${detail}.`, options);
}

function fail(detail, options) {
  throw generationError(detail, options);
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function readBoundedRegular(path, maximumBytes) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximumBytes) {
    fail('encountered an unsafe or oversized file');
  }
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (
    bytes.byteLength !== before.size ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs
  ) {
    fail('encountered a file that changed while it was read');
  }
  return bytes;
}

function runProcess(command, arguments_, {
  timeoutMs = 60_000,
  maximumOutputBytes = 1 * 1_024 * 1_024,
} = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const overflow = () => {
      child.kill('SIGKILL');
      finish(generationError('subprocess output exceeded its bound'));
    };
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maximumOutputBytes) overflow();
      else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > PROCESS_ERROR_BYTES) overflow();
      else stderr.push(chunk);
    });
    child.once('error', (cause) => {
      finish(generationError('could not start an authoring subprocess', { cause }));
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      const result = {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      };
      if (code === 0 && signal === null) finish(null, result);
      else finish(generationError(`subprocess failed with exit ${code ?? signal}`));
    });
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(generationError('subprocess exceeded its deadline'));
    }, timeoutMs);
  });
}

async function ensureAuthoringFile({
  url,
  expectedSha256,
  target,
  maximumBytes,
}) {
  if (await exists(target)) {
    const bytes = await readBoundedRegular(target, maximumBytes);
    if (digest(bytes) !== expectedSha256) {
      fail('cached authoring authority hash drifted');
    }
    return target;
  }
  const response = await fetch(url, { redirect: 'follow' });
  const contentLength = Number(response.headers.get('content-length'));
  if (
    !response.ok ||
    (Number.isFinite(contentLength) && contentLength > maximumBytes)
  ) {
    fail(`authoring authority download failed (${response.status})`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > maximumBytes ||
    digest(bytes) !== expectedSha256
  ) {
    fail('downloaded authoring authority hash drifted');
  }
  await writeFile(target, bytes, { flag: 'wx' });
  return target;
}

async function authoringPaths(profile) {
  await mkdir(CACHE, { recursive: true });
  const model = resolve(CACHE, `${profile.model}.onnx`);
  const config = resolve(CACHE, `${profile.model}.onnx.json`);
  await Promise.all([
    ensureAuthoringFile({
      url: profile.modelUrl,
      expectedSha256: profile.modelSha256,
      target: model,
      maximumBytes: MAX_MODEL_BYTES,
    }),
    ensureAuthoringFile({
      url: profile.configUrl,
      expectedSha256: profile.configSha256,
      target: config,
      maximumBytes: MAX_CONFIG_BYTES,
    }),
  ]);
  return { model, config };
}

async function assertFfmpegAuthority() {
  const { stdout } = await runProcess('ffmpeg', ['-version']);
  const firstLine = stdout.toString('utf8').split('\n')[0];
  if (
    !firstLine.startsWith(
      `ffmpeg version ${STARTER_AUDIO_AUTHORITY.encoding.version} `,
    )
  ) {
    fail('requires the exact reviewed FFmpeg version');
  }
}

async function generateWavAuthorities(inventory, temporaryRoot) {
  const wavRoot = resolve(temporaryRoot, 'wav');
  await mkdir(wavRoot);
  await Promise.all(STARTER_AUDIO_AUTHORITY.profiles.map(async (profile) => {
    const paths = await authoringPaths(profile);
    const jobs = inventory
      .filter(({ voiceId }) => voiceId === profile.voiceId)
      .map((asset) => ({
        input: asset.input,
        path: asset.assetPath.replace(/\.m4a$/u, '.wav'),
        lengthScale: asset.generationSpec.lengthScale,
      }));
    const jobsPath = resolve(temporaryRoot, `${profile.voiceId}-jobs.json`);
    await writeFile(jobsPath, jsonBytes(jobs), { flag: 'wx' });
    await runProcess('uvx', [
      '--from',
      `piper-tts==${STARTER_AUDIO_AUTHORITY.engine.version}`,
      'python',
      PYTHON_HELPER,
      '--model',
      paths.model,
      '--config',
      paths.config,
      '--jobs',
      jobsPath,
      '--output',
      wavRoot,
    ], {
      timeoutMs: 15 * 60_000,
    });
  }));
  return wavRoot;
}

async function mapConcurrent(values, concurrency, operation) {
  const output = Array.from({ length: values.length });
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        output[index] = await operation(values[index], index);
      }
    },
  );
  await Promise.all(workers);
  return output;
}

async function encodeAssets(inventory, wavRoot, outputRoot) {
  await mapConcurrent(inventory, ENCODE_CONCURRENCY, async (asset) => {
    const wav = resolve(
      wavRoot,
      asset.assetPath.replace(/\.m4a$/u, '.wav'),
    );
    const target = resolve(outputRoot, asset.assetPath);
    await mkdir(dirname(target), { recursive: true });
    await runProcess('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-n',
      '-i',
      wav,
      '-af',
      'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.08:stop_periods=-1:stop_threshold=-50dB:stop_silence=0.12,volume=-6dB',
      '-ac',
      String(STARTER_AUDIO_AUTHORITY.encoding.channels),
      '-ar',
      String(STARTER_AUDIO_AUTHORITY.encoding.sampleRateHz),
      '-c:a',
      'aac',
      '-b:a',
      `${STARTER_AUDIO_AUTHORITY.encoding.bitrateKbps}k`,
      '-movflags',
      '+faststart',
      '-map_metadata',
      '-1',
      '-fflags',
      '+bitexact',
      '-flags:a',
      '+bitexact',
      target,
    ]);
  });
}

async function inspectAsset(asset, sourceRoot) {
  const path = resolve(sourceRoot, asset.assetPath);
  const bytes = await readBoundedRegular(path, MAX_AUDIO_BYTES);
  const probeResult = await runProcess('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-show_entries',
    'stream=codec_name,sample_rate,channels',
    '-of',
    'json',
    path,
  ]);
  let probe;
  try {
    probe = JSON.parse(probeResult.stdout.toString('utf8'));
  } catch (cause) {
    fail('could not parse the audio format evidence', { cause });
  }
  if (
    !Array.isArray(probe.streams) ||
    probe.streams.length !== 1 ||
    probe.streams[0]?.codec_name !== 'aac' ||
    Number(probe.streams[0]?.sample_rate) !==
      STARTER_AUDIO_AUTHORITY.encoding.sampleRateHz ||
    probe.streams[0]?.channels !== STARTER_AUDIO_AUTHORITY.encoding.channels
  ) {
    fail('audio format drifted from the reviewed M4A authority');
  }
  const decoded = await runProcess('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-i',
    path,
    '-f',
    's16le',
    '-acodec',
    'pcm_s16le',
    '-ac',
    String(STARTER_AUDIO_AUTHORITY.encoding.channels),
    '-ar',
    String(STARTER_AUDIO_AUTHORITY.encoding.sampleRateHz),
    '-',
  ], {
    maximumOutputBytes: 2 * MAX_AUDIO_BYTES,
  });
  const analysis = analysePcm16le(decoded.stdout, {
    sampleRateHz: STARTER_AUDIO_AUTHORITY.encoding.sampleRateHz,
  });
  return {
    sequence: asset.sequence,
    audioKey: asset.audioKey,
    assetPath: asset.assetPath,
    inputSha256: digest(Buffer.from(asset.input)),
    generationSpecSha256: digest(
      Buffer.from(JSON.stringify(asset.generationSpec)),
    ),
    byteSize: bytes.byteLength,
    sha256: digest(bytes),
    codec: 'aac',
    sampleRateHz: STARTER_AUDIO_AUTHORITY.encoding.sampleRateHz,
    channels: STARTER_AUDIO_AUTHORITY.encoding.channels,
    ...analysis,
  };
}

async function inventoryFiles(root) {
  const paths = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) fail('source inventory contains a symbolic link');
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        paths.push(relative(root, path).split(sep).join('/'));
      } else {
        fail('source inventory contains a non-regular entry');
      }
    }
  }
  await visit(root);
  return paths.sort();
}

async function createEvidence(
  catalogue,
  inventory,
  sourceRoot,
  { observationTarget = null } = {},
) {
  const expectedPaths = inventory.map(({ assetPath }) => assetPath).sort();
  const actualPaths = await inventoryFiles(sourceRoot);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    fail('source inventory has a missing or orphaned asset');
  }
  const assets = await mapConcurrent(
    inventory,
    ENCODE_CONCURRENCY,
    (asset) => inspectAsset(asset, sourceRoot),
  );
  const candidate = {
    schemaVersion: 1,
    status: 'pass',
    catalogueId: catalogue.catalogueId,
    ...createStarterAudioEvidenceAuthority(catalogue),
    assetCount: assets.length,
    format: STARTER_AUDIO_AUTHORITY.encoding.format,
    assets,
  };
  if (observationTarget !== null) {
    await writeFile(observationTarget, jsonBytes(candidate));
  }
  return validateStarterAudioEvidence(candidate, { catalogue });
}

async function generate() {
  if (await exists(AUDIO_TARGET) || await exists(REPORT_TARGET)) {
    fail('is create-only; use --check for an existing candidate');
  }
  await assertFfmpegAuthority();
  const catalogue = loadStarterSpellingCatalogue();
  const inventory = createStarterAudioInventory(catalogue);
  await mkdir(resolve(ROOT, '.native-build/c1'), { recursive: true });
  const temporaryRoot = await mkdtemp(
    resolve(ROOT, '.native-build/c1/generation-'),
  );
  const outputRoot = resolve(temporaryRoot, 'output');
  let publishedAudio = false;
  try {
    await mkdir(outputRoot);
    const wavRoot = await generateWavAuthorities(inventory, temporaryRoot);
    await encodeAssets(inventory, wavRoot, outputRoot);
    const evidence = await createEvidence(
      catalogue,
      inventory,
      outputRoot,
      { observationTarget: OBSERVATION_TARGET },
    );
    const stagedReport = resolve(temporaryRoot, 'starter-audio-evidence.json');
    await writeFile(stagedReport, jsonBytes(evidence), { flag: 'wx' });
    await mkdir(dirname(AUDIO_TARGET), { recursive: true });
    await mkdir(dirname(REPORT_TARGET), { recursive: true });
    await rename(resolve(outputRoot, 'audio'), AUDIO_TARGET);
    publishedAudio = true;
    try {
      await rename(stagedReport, REPORT_TARGET);
      await rm(OBSERVATION_TARGET, { force: true });
    } catch (error) {
      await rm(AUDIO_TARGET, { recursive: true, force: true });
      publishedAudio = false;
      throw error;
    }
  } finally {
    if (publishedAudio && !(await exists(REPORT_TARGET))) {
      await rm(AUDIO_TARGET, { recursive: true, force: true });
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  process.stdout.write('Starter audio generated and verified: 840 assets.\\n');
}

async function check() {
  const reportBytes = await readBoundedRegular(REPORT_TARGET, 2 * 1_024 * 1_024);
  let report;
  try {
    report = JSON.parse(reportBytes.toString('utf8'));
  } catch (cause) {
    fail('report is not valid JSON', { cause });
  }
  const catalogue = loadStarterSpellingCatalogue();
  validateStarterAudioEvidence(report, { catalogue });
  const inventory = createStarterAudioInventory(catalogue);
  const current = await createEvidence(catalogue, inventory, SOURCE_ROOT);
  if (!jsonBytes(current).equals(reportBytes)) {
    fail('tracked report differs from the current audio candidate');
  }
  process.stdout.write('Starter audio evidence current: 840 assets.\\n');
}

const arguments_ = process.argv.slice(2);
if (arguments_.length === 0) {
  await generate();
} else if (arguments_.length === 1 && arguments_[0] === '--check') {
  await check();
} else {
  fail('supports only no arguments or --check');
}
