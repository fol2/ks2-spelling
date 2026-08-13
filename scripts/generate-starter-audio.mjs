import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPackAudioAuthority } from './lib/pack-audio-authority.mjs';
import {
  analysePcm16le,
  createAudioSourceKey,
} from './lib/starter-audio-evidence.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_AUTHORITY = 'config/packs/ks2-core.audio.json';
const MAX_AUDIO_BYTES = 2 * 1_024 * 1_024;
const MAX_RUNTIME_MANIFEST_BYTES = 4 * 1_024 * 1_024;
const PROCESS_ERROR_BYTES = 64 * 1_024;
const ENCODE_CONCURRENCY = 8;

function generationError(detail, options) {
  return new Error(`Spelling audio generation ${detail}.`, options);
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

function createRuntimeManifest(evidence) {
  return {
    schemaVersion: evidence.schemaVersion,
    status: evidence.status,
    catalogueId: evidence.catalogueId,
    assetCount: evidence.assetCount,
    assets: evidence.assets.map(({ assetPath, sha256, byteSize }) => ({
      assetPath,
      sha256,
      byteSize,
    })),
  };
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

async function assertFfmpegAuthority(authority) {
  const { stdout } = await runProcess('ffmpeg', ['-version']);
  const firstLine = stdout.toString('utf8').split('\n')[0];
  if (
    !firstLine.startsWith(
      `ffmpeg version ${authority.encoding.version} `,
    )
  ) {
    fail('requires the exact reviewed FFmpeg version');
  }
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

async function encodeAsset(asset, sourceRoot, target, authority, tempoFactor = 1) {
  // Externally sourced inputs already carry -8 dB; +2 dB preserves the level a
  // tracked in-repository source (Starter) was reviewed at.
  const volumeDb =
    Object.hasOwn(authority.sources.sentence, 'assetRoot') ? 2 : -8;
  const filter = [
    'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.08:stop_periods=-1:stop_threshold=-50dB:stop_silence=0.12',
    `volume=${volumeDb}dB`,
    ...(tempoFactor === 1 ? [] : [`atempo=${tempoFactor.toFixed(8)}`]),
  ].join(',');
  await mkdir(dirname(target), { recursive: true });
  await runProcess('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-n',
      '-i',
      resolve(sourceRoot, asset.sourcePath),
      '-af',
      filter,
      '-ac',
      String(authority.encoding.channels),
      '-ar',
      String(authority.encoding.sampleRateHz),
      '-c:a',
      'aac',
      '-b:a',
      `${authority.encoding.bitrateKbps}k`,
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
}

async function decodedDurationMs(path, authority) {
  const decoded = await runProcess('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', path,
    '-f', 's16le', '-acodec', 'pcm_s16le',
    '-ac', String(authority.encoding.channels),
    '-ar', String(authority.encoding.sampleRateHz), '-',
  ], { maximumOutputBytes: 2 * MAX_AUDIO_BYTES });
  return (decoded.stdout.byteLength / 2 / authority.encoding.sampleRateHz) * 1_000;
}

async function encodeAssets(inventory, sourceRoot, outputRoot, authority) {
  await mapConcurrent(inventory, ENCODE_CONCURRENCY, async (asset) => {
    const target = resolve(outputRoot, asset.assetPath);
    if (asset.sourceKind === 'word') {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(resolve(sourceRoot, asset.sourcePath), target);
    } else {
      await encodeAsset(asset, sourceRoot, target, authority);
    }
  });
  const tempoFactors = new Map(inventory.map(({ audioKey }) => [audioKey, 1]));
  const normalByPrompt = new Map(
    inventory
      .filter(({ audioKind }) => audioKind === 'dictation-normal')
      .map((asset) => [
        `${asset.runtimeItemId}|${asset.sentenceId}|${asset.voiceId}`,
        asset,
      ]),
  );
  await mapConcurrent(
    inventory.filter(({ audioKind }) => audioKind === 'dictation-slow'),
    ENCODE_CONCURRENCY,
    async (asset) => {
      const promptKey =
        `${asset.runtimeItemId}|${asset.sentenceId}|${asset.voiceId}`;
      const normal = normalByPrompt.get(promptKey);
      if (!normal) fail('slow source has no matching normal source');
      const [normalDuration, slowDuration] = await Promise.all([
        decodedDurationMs(resolve(outputRoot, normal.assetPath), authority),
        decodedDurationMs(resolve(outputRoot, asset.assetPath), authority),
      ]);
      const ratio =
        (Math.round(slowDuration * 1_000) / 1_000) /
        (Math.round(normalDuration * 1_000) / 1_000);
      const bounds = authority.validation.slowDurationRatio;
      if (ratio < bounds.minimum || ratio > bounds.maximum) {
        const tempoFactor = slowDuration / (normalDuration * 1.25);
        if (tempoFactor < 0.5 || tempoFactor > 100) {
          fail('slow source requires an unsupported atempo adjustment');
        }
        const adjusted = `${resolve(outputRoot, asset.assetPath)}.adjusted.m4a`;
        await encodeAsset(asset, sourceRoot, adjusted, authority, tempoFactor);
        await rename(adjusted, resolve(outputRoot, asset.assetPath));
        tempoFactors.set(asset.audioKey, tempoFactor);
      }
    },
  );
  return tempoFactors;
}

async function inspectSourceAsset(asset, sourceRoot, authority) {
  const path = resolve(sourceRoot, asset.sourcePath);
  const bytes = await readBoundedRegular(path, MAX_AUDIO_BYTES);
  const sourceEncoding = authority.sourceEncoding[asset.sourceKind];
  const probeResult = await runProcess('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,sample_rate,channels',
    '-of', 'json', path,
  ]);
  let probe;
  try {
    probe = JSON.parse(probeResult.stdout.toString('utf8'));
  } catch (cause) {
    fail('could not parse the source audio format evidence', { cause });
  }
  if (
    !Array.isArray(probe.streams) ||
    probe.streams.length !== 1 ||
    probe.streams[0]?.codec_name !== sourceEncoding.codec ||
    Number(probe.streams[0]?.sample_rate) !==
      sourceEncoding.sampleRateHz ||
    probe.streams[0]?.channels !== sourceEncoding.channels
  ) {
    fail(`source ${asset.sourceKind} audio format drifted from its reviewed authority`);
  }
  return {
    sourceKind: asset.sourceKind,
    sourceKey: createAudioSourceKey(asset),
    sourcePath: asset.sourcePath,
    sourceByteSize: bytes.byteLength,
    sourceSha256: digest(bytes),
  };
}

async function inspectAsset(
  asset,
  sourceRoot,
  authority,
  label,
  provenance,
) {
  const path = resolve(sourceRoot, asset.assetPath);
  const bytes = await readBoundedRegular(path, MAX_AUDIO_BYTES);
  const outputEncoding = asset.sourceKind === 'word'
    ? authority.sourceEncoding.word
    : authority.encoding;
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
      outputEncoding.sampleRateHz ||
    probe.streams[0]?.channels !== outputEncoding.channels
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
    String(outputEncoding.channels),
    '-ar',
    String(outputEncoding.sampleRateHz),
    '-',
  ], {
    maximumOutputBytes: 2 * MAX_AUDIO_BYTES,
  });
  const analysis = analysePcm16le(decoded.stdout, {
    label,
    sampleRateHz: outputEncoding.sampleRateHz,
  });
  return {
    sequence: asset.sequence,
    audioKey: asset.audioKey,
    assetPath: asset.assetPath,
    sourceKind: provenance.sourceKind,
    sourceKey: provenance.sourceKey,
    sourcePath: provenance.sourcePath,
    sourceByteSize: provenance.sourceByteSize,
    sourceSha256: provenance.sourceSha256,
    tempoFactor: provenance.tempoFactor,
    inputSha256: digest(Buffer.from(asset.input)),
    generationSpecSha256: digest(
      Buffer.from(JSON.stringify(asset.generationSpec)),
    ),
    byteSize: bytes.byteLength,
    sha256: digest(bytes),
    codec: 'aac',
    sampleRateHz: outputEncoding.sampleRateHz,
    channels: outputEncoding.channels,
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

async function assertSourceInventoryLayout(sourceRoot, inventory, exact = true) {
  const root = await lstat(sourceRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    fail('--source must name a real directory, not a symbolic link');
  }
  if (!exact) return;
  const expectedPaths = inventory.map(({ sourcePath }) => sourcePath).sort();
  const actualPaths = await inventoryFiles(sourceRoot);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    fail('source inventory has a missing or orphaned asset');
  }
}

async function inspectSourceInventory(configuration) {
  const {
    authority,
    exactSourceInventory,
    importSourceRoot,
    inventory,
  } = configuration;
  await assertSourceInventoryLayout(
    importSourceRoot,
    inventory,
    exactSourceInventory,
  );
  return mapConcurrent(
    inventory,
    ENCODE_CONCURRENCY,
    (asset) => inspectSourceAsset(asset, importSourceRoot, authority),
  );
}

async function stageSourceInventory(configuration, stagingRoot) {
  const { exactSourceInventory, importSourceRoot, inventory } = configuration;
  await assertSourceInventoryLayout(
    importSourceRoot,
    inventory,
    exactSourceInventory,
  );
  await mapConcurrent(inventory, ENCODE_CONCURRENCY, async (asset) => {
    const bytes = await readBoundedRegular(
      resolve(importSourceRoot, asset.sourcePath),
      MAX_AUDIO_BYTES,
    );
    const target = resolve(stagingRoot, asset.sourcePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
  });
  return inspectSourceInventory({
    ...configuration,
    exactSourceInventory: true,
    importSourceRoot: stagingRoot,
  });
}

async function createEvidence(
  configuration,
  sourceRoot,
  { observationTarget = null, provenanceAssets } = {},
) {
  const {
    authority,
    catalogue,
    createEvidenceAuthority,
    inventory,
    label,
    validateEvidence,
  } = configuration;
  const expectedPaths = inventory.map(({ assetPath }) => assetPath).sort();
  const actualPaths = await inventoryFiles(sourceRoot);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    fail('source inventory has a missing or orphaned asset');
  }
  if (
    !Array.isArray(provenanceAssets) ||
    provenanceAssets.length !== inventory.length
  ) {
    fail('source provenance is incomplete');
  }
  const assets = await mapConcurrent(
    inventory,
    ENCODE_CONCURRENCY,
    (asset, index) => inspectAsset(
      asset,
      sourceRoot,
      authority,
      label,
      provenanceAssets?.[index],
    ),
  );
  const candidate = {
    schemaVersion: 1,
    status: 'pass',
    catalogueId: catalogue.catalogueId,
    ...createEvidenceAuthority(catalogue, { inventory }),
    assetCount: assets.length,
    format: authority.encoding.format,
    assets,
  };
  if (observationTarget !== null) {
    await writeFile(observationTarget, jsonBytes(candidate));
  }
  return validateEvidence(candidate, { catalogue, inventory });
}

async function generate(configuration) {
  const {
    audioTarget,
    authority,
    inventory,
    label,
    nativeRoot,
    observationTarget,
    reportTarget,
    runtimeManifestTarget,
  } = configuration;
  if (
    await exists(audioTarget) ||
    await exists(reportTarget) ||
    (runtimeManifestTarget !== null && await exists(runtimeManifestTarget))
  ) {
    fail('is create-only; use --check for an existing candidate');
  }
  await assertFfmpegAuthority(authority);
  await mkdir(nativeRoot, { recursive: true });
  const temporaryRoot = await mkdtemp(
    resolve(nativeRoot, 'generation-'),
  );
  const outputRoot = resolve(temporaryRoot, 'output');
  let publishedAudio = false;
  let publishedReport = false;
  let publishedRuntimeManifest = false;
  try {
    await mkdir(outputRoot);
    const stagedSourceRoot = resolve(temporaryRoot, 'source');
    await mkdir(stagedSourceRoot);
    const sourceProvenance = await stageSourceInventory(
      configuration,
      stagedSourceRoot,
    );
    const tempoFactors = await encodeAssets(
      inventory,
      stagedSourceRoot,
      outputRoot,
      authority,
    );
    const provenanceAssets = sourceProvenance.map((record, index) => ({
      ...record,
      tempoFactor: tempoFactors.get(inventory[index].audioKey),
    }));
    const evidence = await createEvidence(
      configuration,
      outputRoot,
      { observationTarget, provenanceAssets },
    );
    const stagedReport = resolve(temporaryRoot, `${label}-audio-evidence.json`);
    await writeFile(stagedReport, jsonBytes(evidence), { flag: 'wx' });
    const stagedRuntimeManifest = runtimeManifestTarget === null
      ? null
      : resolve(temporaryRoot, 'full-audio-manifest.json');
    if (stagedRuntimeManifest !== null) {
      await writeFile(
        stagedRuntimeManifest,
        jsonBytes(createRuntimeManifest(evidence)),
        { flag: 'wx' },
      );
    }
    await mkdir(dirname(audioTarget), { recursive: true });
    await mkdir(dirname(reportTarget), { recursive: true });
    if (runtimeManifestTarget !== null) {
      await mkdir(dirname(runtimeManifestTarget), { recursive: true });
    }
    await rename(resolve(outputRoot, 'audio'), audioTarget);
    publishedAudio = true;
    try {
      await rename(stagedReport, reportTarget);
      publishedReport = true;
      if (runtimeManifestTarget !== null) {
        await rename(stagedRuntimeManifest, runtimeManifestTarget);
        publishedRuntimeManifest = true;
      }
      await rm(observationTarget, { force: true });
    } catch (error) {
      if (publishedRuntimeManifest) {
        await rm(runtimeManifestTarget, { force: true });
        publishedRuntimeManifest = false;
      }
      if (publishedReport) {
        await rm(reportTarget, { force: true });
        publishedReport = false;
      }
      await rm(audioTarget, { recursive: true, force: true });
      publishedAudio = false;
      throw error;
    }
  } finally {
    if (
      publishedAudio &&
      (!publishedReport ||
        (runtimeManifestTarget !== null && !publishedRuntimeManifest))
    ) {
      await rm(audioTarget, { recursive: true, force: true });
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  process.stdout.write(
    `${label} audio generated and verified: ${inventory.length} assets.\n`,
  );
}

async function check(configuration) {
  const {
    catalogue,
    inventory,
    label,
    reportTarget,
    runtimeManifestTarget,
    sourceRoot,
    validateEvidence,
  } = configuration;
  const reportBytes = await readBoundedRegular(
    reportTarget,
    16 * 1_024 * 1_024,
  );
  let report;
  try {
    report = JSON.parse(reportBytes.toString('utf8'));
  } catch (cause) {
    fail('report is not valid JSON', { cause });
  }
  validateEvidence(report, { catalogue, inventory });
  if (runtimeManifestTarget !== null) {
    const manifestBytes = await readBoundedRegular(
      runtimeManifestTarget,
      MAX_RUNTIME_MANIFEST_BYTES,
    );
    if (!manifestBytes.equals(jsonBytes(createRuntimeManifest(report)))) {
      fail('runtime manifest differs from the verified authoring evidence');
    }
  }
  const current = await createEvidence(configuration, sourceRoot, {
    provenanceAssets: report.assets,
  });
  if (!jsonBytes(current).equals(reportBytes)) {
    fail('tracked report differs from the current audio candidate');
  }
  process.stdout.write(
    `${label} audio evidence current: ${inventory.length} assets.\n`,
  );
}

async function writeRuntimeManifest(configuration) {
  const {
    catalogue,
    inventory,
    reportTarget,
    runtimeManifestTarget,
    validateEvidence,
  } = configuration;
  if (runtimeManifestTarget === null || await exists(runtimeManifestTarget)) {
    fail('runtime manifest is create-only and needs a pack that declares one');
  }
  const reportBytes = await readBoundedRegular(
    reportTarget,
    16 * 1_024 * 1_024,
  );
  let report;
  try {
    report = JSON.parse(reportBytes.toString('utf8'));
  } catch (cause) {
    fail('report is not valid JSON', { cause });
  }
  validateEvidence(report, { catalogue, inventory });
  await writeFile(
    runtimeManifestTarget,
    jsonBytes(createRuntimeManifest(report)),
    { flag: 'wx' },
  );
}

async function configurationFor(authorityPath, importSourceRoot = null) {
  const pack = await loadPackAudioAuthority(authorityPath);
  return Object.freeze({
    label: pack.label,
    authority: pack.authority,
    catalogue: pack.catalogue,
    inventory: pack.createInventory(pack.catalogue),
    createEvidenceAuthority: pack.createEvidenceAuthority,
    validateEvidence: pack.validateEvidence,
    requiresExternalSource: pack.requiresExternalSource,
    sourceRoot: pack.audioSourceRoot,
    exactSourceInventory: importSourceRoot !== null,
    importSourceRoot: importSourceRoot ?? ROOT,
    audioTarget: resolve(pack.audioSourceRoot, 'audio'),
    reportTarget: pack.audioEvidenceSource,
    runtimeManifestTarget: pack.runtimeManifestTarget,
    nativeRoot: pack.workspaceRoot,
    observationTarget: pack.observationTarget,
  });
}

function readOption(arguments_, flag) {
  const prefix = `${flag}=`;
  const matches = arguments_.filter((argument) => argument.startsWith(prefix));
  if (matches.length > 1) fail(`accepts at most one ${flag}`);
  return matches.length === 0 ? null : matches[0].slice(prefix.length);
}

const arguments_ = process.argv.slice(2);
const checkOnly = arguments_.includes('--check');
const manifestOnly = arguments_.includes('--runtime-manifest-only');
const authorityValue = readOption(arguments_, '--authority');
const sourceValue = readOption(arguments_, '--source');
if (
  arguments_.some(
    (argument) =>
      !argument.startsWith('--authority=') &&
      !argument.startsWith('--source=') &&
      !['--check', '--runtime-manifest-only'].includes(argument),
  ) ||
  new Set(arguments_).size !== arguments_.length ||
  (checkOnly && manifestOnly) ||
  ((checkOnly || manifestOnly) && sourceValue !== null) ||
  authorityValue === '' ||
  sourceValue === '' ||
  (sourceValue !== null && !isAbsolute(sourceValue))
) {
  fail(
    'requires --authority=<repository-relative pack audio authority>; create takes --source=<absolute directory> when the catalogue is externally sourced; --check and --runtime-manifest-only take no source',
  );
}
const configuration = await configurationFor(
  authorityValue ?? DEFAULT_AUTHORITY,
  sourceValue,
);
if (
  !checkOnly && !manifestOnly &&
  configuration.requiresExternalSource && sourceValue === null
) {
  fail('create requires --source=<absolute directory> for an externally sourced catalogue');
}
if (manifestOnly) await writeRuntimeManifest(configuration);
else if (checkOnly) await check(configuration);
else await generate(configuration);
