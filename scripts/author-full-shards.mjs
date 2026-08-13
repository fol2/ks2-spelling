import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE_SOURCE = 'reports/c2/full-audio-evidence.json';
const CATALOGUE_SOURCE = 'vendor/ks2-mastery/content/spelling.mobile-runtime-full.json';
const PARTITION_TARGET = 'config/full-ks2-shard-partition.json';
const SHARD_DOCUMENT_ROOT = 'config/packs/full-ks2-shards';
const AUTHORING_REPORT_TARGET = `${SHARD_DOCUMENT_ROOT}/authoring-report.json`;
const CATALOGUE_ID = 'ks2-core:full';
const ENTITLEMENT_ID = 'full-ks2';
const SHARD_VERSION = '1.0.0';
// Native pack ceilings are 32 MiB / 1024 files (CI-attested). The payload
// budget leaves headroom for the shard manifest member and ZIP headers.
const NATIVE_CEILING_BYTES = 33_554_432;
const NATIVE_CEILING_FILES = 1_024;
const PAYLOAD_BUDGET_BYTES = 31_457_280;

function fail(detail) {
  throw new Error(`Full shard authoring ${detail}.`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function md5(bytes) {
  return createHash('md5').update(bytes).digest('hex');
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(resolve(ROOT, relativePath), 'utf8'));
}

function shardPackId(index) {
  return `full-ks2-shard-${String(index + 1).padStart(2, '0')}`;
}

// Deterministic item-granular partition: walk the catalogue in its frozen
// order and close a shard when the next item would exceed the payload budget.
// Item granularity keeps every voice/pace variant of one word in one shard.
export function deriveShardPlan(evidence, catalogue) {
  if (
    evidence?.catalogueId !== CATALOGUE_ID ||
    catalogue?.catalogueId !== CATALOGUE_ID ||
    !Array.isArray(evidence.assets) ||
    evidence.assets.length !== evidence.assetCount
  ) {
    fail('requires the tracked Full evidence and catalogue');
  }
  const assetsByItem = new Map();
  for (const asset of evidence.assets) {
    const segments = asset.assetPath.split('/');
    if (segments.length !== 4 || segments[0] !== 'audio') {
      fail(`found an unexpected asset path ${asset.assetPath}`);
    }
    const itemId = segments[2];
    if (!assetsByItem.has(itemId)) assetsByItem.set(itemId, []);
    assetsByItem.get(itemId).push({
      assetPath: asset.assetPath,
      byteSize: asset.byteSize,
      sha256: asset.sha256,
    });
  }
  const catalogueItemIds = catalogue.items.map(({ itemId }) => itemId);
  if (
    catalogueItemIds.length !== assetsByItem.size ||
    catalogueItemIds.some((itemId) => !assetsByItem.has(itemId))
  ) {
    fail('evidence items do not cover the catalogue exactly');
  }
  const shards = [];
  let current = null;
  const close = () => {
    if (current) shards.push(current);
    current = null;
  };
  for (const itemId of catalogueItemIds) {
    const assets = assetsByItem.get(itemId);
    const bytes = assets.reduce((total, { byteSize }) => total + byteSize, 0);
    if (current && current.payloadBytes + bytes > PAYLOAD_BUDGET_BYTES) close();
    current ??= { items: [], assets: [], payloadBytes: 0 };
    current.items.push(itemId);
    current.assets.push(...assets);
    current.payloadBytes += bytes;
  }
  close();
  return shards.map((shard, index) => {
    const packId = shardPackId(index);
    if (
      shard.payloadBytes > PAYLOAD_BUDGET_BYTES ||
      shard.assets.length + 1 > NATIVE_CEILING_FILES
    ) {
      fail(`derived ${packId} outside the native ceilings`);
    }
    return Object.freeze({
      packId,
      version: SHARD_VERSION,
      archiveName: `${packId}-${SHARD_VERSION}.zip`,
      fileCount: shard.assets.length + 1,
      assetCount: shard.assets.length,
      payloadBytes: shard.payloadBytes,
      items: Object.freeze(shard.items),
      assets: Object.freeze(shard.assets),
    });
  });
}

function partitionDocument(plan, evidenceSha256) {
  return {
    schemaVersion: 1,
    catalogueId: CATALOGUE_ID,
    requiredEntitlementId: ENTITLEMENT_ID,
    audioEvidenceSource: EVIDENCE_SOURCE,
    audioEvidenceSha256: evidenceSha256,
    algorithm:
      'catalogue-order greedy item fill; a shard closes when the next item would exceed the payload budget',
    payloadBudgetBytes: PAYLOAD_BUDGET_BYTES,
    nativeCeilings: {
      fileCount: NATIVE_CEILING_FILES,
      compressedBytes: NATIVE_CEILING_BYTES,
      extractedBytes: NATIVE_CEILING_BYTES,
    },
    shardCount: plan.length,
    assetCount: plan.reduce((total, shard) => total + shard.assetCount, 0),
    payloadBytes: plan.reduce((total, shard) => total + shard.payloadBytes, 0),
    shards: plan.map(({ assets: _assets, ...shard }) => shard),
  };
}

function shardManifestDocument(shard, index, shardCount) {
  return {
    schemaVersion: 1,
    status: 'pass',
    catalogueId: CATALOGUE_ID,
    packId: shard.packId,
    version: shard.version,
    shardIndex: index + 1,
    shardCount,
    assetCount: shard.assetCount,
    assets: shard.assets,
  };
}

function shardBuildAuthorityDocument(shard) {
  const manifestSource = `${SHARD_DOCUMENT_ROOT}/${shard.packId}.manifest.json`;
  return {
    schemaVersion: 1,
    packId: shard.packId,
    catalogueId: CATALOGUE_ID,
    version: shard.version,
    archiveName: shard.archiveName,
    requiredEntitlementId: ENTITLEMENT_ID,
    signingState: 'deferred-to-final-visible-owner-gate',
    allowedExtensions: ['.json', '.m4a'],
    ceilings: {
      fileCount: shard.fileCount,
      compressedBytes: NATIVE_CEILING_BYTES,
      extractedBytes: NATIVE_CEILING_BYTES,
    },
    catalogueSource: manifestSource,
    audioSourceRoot: `.native-build/packs/${shard.packId}/payload`,
    audioEvidenceSource: manifestSource,
  };
}

function plannedDocuments(plan, evidenceSha256) {
  const documents = new Map();
  documents.set(PARTITION_TARGET, jsonBytes(partitionDocument(plan, evidenceSha256)));
  for (const [index, shard] of plan.entries()) {
    documents.set(
      `${SHARD_DOCUMENT_ROOT}/${shard.packId}.manifest.json`,
      jsonBytes(shardManifestDocument(shard, index, plan.length)),
    );
    documents.set(
      `config/packs/${shard.packId}.json`,
      jsonBytes(shardBuildAuthorityDocument(shard)),
    );
  }
  return documents;
}

async function derivePlan() {
  const evidenceBytes = await readFile(resolve(ROOT, EVIDENCE_SOURCE));
  const evidence = JSON.parse(evidenceBytes.toString('utf8'));
  const catalogue = await readJson(CATALOGUE_SOURCE);
  const plan = deriveShardPlan(evidence, catalogue);
  return { plan, evidenceSha256: sha256(evidenceBytes) };
}

async function writePlanDocuments() {
  const { plan, evidenceSha256 } = await derivePlan();
  for (const [target, bytes] of plannedDocuments(plan, evidenceSha256)) {
    await mkdir(dirname(resolve(ROOT, target)), { recursive: true });
    await writeFile(resolve(ROOT, target), bytes, { flag: 'wx' });
  }
  process.stdout.write(
    `Planned ${plan.length} shards over ${plan.reduce((t, s) => t + s.assetCount, 0)} assets.\n`,
  );
}

async function checkPlanDocuments() {
  const { plan, evidenceSha256 } = await derivePlan();
  for (const [target, bytes] of plannedDocuments(plan, evidenceSha256)) {
    const tracked = await readFile(resolve(ROOT, target)).catch(() => null);
    if (!tracked || !tracked.equals(bytes)) {
      fail(`tracked ${target} differs from the derived partition`);
    }
  }
  const seen = new Set();
  for (const shard of plan) {
    for (const { assetPath } of shard.assets) {
      if (seen.has(assetPath)) fail(`partition duplicates ${assetPath}`);
      seen.add(assetPath);
    }
  }
  process.stdout.write(`Shard partition documents verified: ${plan.length} shards.\n`);
  return plan;
}

async function stageShardPayloads(plan) {
  for (const shard of plan) {
    const payloadRoot = resolve(ROOT, '.native-build/packs', shard.packId, 'payload');
    await rm(payloadRoot, { recursive: true, force: true });
    for (const asset of shard.assets) {
      const source = resolve(ROOT, 'content/full-pack', asset.assetPath);
      const target = resolve(payloadRoot, asset.assetPath);
      const stats = await lstat(source);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        fail(`rejected unsafe source ${asset.assetPath}`);
      }
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
      const bytes = await readFile(target);
      if (bytes.byteLength !== asset.byteSize || sha256(bytes) !== asset.sha256) {
        fail(`staged payload drifted from the tracked evidence at ${asset.assetPath}`);
      }
    }
    process.stdout.write(`${shard.packId}: staged ${shard.assetCount} assets bit-exact.\n`);
  }
}

function runBuilder(authority, outputDirectory) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      [
        'scripts/build-starter-pack.mjs',
        `--authority=${authority}`,
        `--output-directory=${outputDirectory}`,
      ],
      { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] },
    );
    child.once('error', rejectPromise);
    child.once('close', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`Full shard authoring builder exited ${code}.`));
    });
  });
}

async function buildShards(plan) {
  const results = [];
  for (const shard of plan) {
    const outputs = [];
    // Two clean builds per shard; byte-identical outputs prove determinism.
    for (const attempt of ['first', 'second']) {
      const outputDirectory = resolve(
        ROOT, '.native-build/packs', shard.packId, `dist-${attempt}`,
      );
      await rm(outputDirectory, { recursive: true, force: true });
      await runBuilder(`config/packs/${shard.packId}.json`, outputDirectory);
      const [archive, manifest, report] = await Promise.all([
        readFile(resolve(outputDirectory, shard.archiveName)),
        readFile(resolve(outputDirectory, 'unsigned-canonical-manifest.json')),
        readFile(resolve(outputDirectory, 'pack-build.json')),
      ]);
      outputs.push({ archive, manifest, report });
    }
    if (
      !outputs[0].archive.equals(outputs[1].archive) ||
      !outputs[0].manifest.equals(outputs[1].manifest) ||
      !outputs[0].report.equals(outputs[1].report)
    ) {
      fail(`repeated ${shard.packId} builds differ`);
    }
    const report = JSON.parse(outputs[0].report.toString('utf8'));
    if (report.status !== 'pass' || report.packId !== shard.packId) {
      fail(`${shard.packId} build report did not pass`);
    }
    results.push({
      packId: shard.packId,
      version: shard.version,
      archiveName: shard.archiveName,
      fileCount: report.archive.fileCount,
      archiveSha256: report.archive.sha256,
      archiveBytes: report.archive.bytes,
      archiveMd5Etag: md5(outputs[0].archive),
      canonicalManifestSha256: report.canonicalManifest.sha256,
      canonicalManifestBytes: report.canonicalManifest.bytes,
    });
    process.stdout.write(
      `${shard.packId}: built ${report.archive.bytes} bytes, ` +
      `manifest ${report.canonicalManifest.bytes} bytes, deterministic.\n`,
    );
  }
  return results;
}

async function writeAuthoringReport(plan, built, evidenceSha256, checkOnly) {
  const report = {
    schemaVersion: 1,
    status: 'pass',
    artifactKind: 'unsigned-shard-payload-handoff',
    catalogueId: CATALOGUE_ID,
    requiredEntitlementId: ENTITLEMENT_ID,
    provenance: {
      audioEvidenceSource: EVIDENCE_SOURCE,
      audioEvidenceSha256: evidenceSha256,
      payloadTransform: 'none; payload members are bit-exact copies of the tracked content/full-pack sources',
      encoder: 'none; no re-encode was performed',
      hostFfmpeg: 'not invoked (host has ffmpeg 9.0.1; the C2 evidence was authored under the pinned 8.1.2)',
    },
    shardCount: plan.length,
    assetCount: plan.reduce((total, shard) => total + shard.assetCount, 0),
    shards: built,
  };
  const bytes = jsonBytes(report);
  const target = resolve(ROOT, AUTHORING_REPORT_TARGET);
  if (checkOnly) {
    const tracked = await readFile(target).catch(() => null);
    if (!tracked || !tracked.equals(bytes)) {
      fail(`tracked ${AUTHORING_REPORT_TARGET} differs from the rebuilt artifacts`);
    }
    process.stdout.write('Tracked authoring report reproduced byte-identically.\n');
  } else {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
    process.stdout.write(`Authoring report written to ${AUTHORING_REPORT_TARGET}.\n`);
  }
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const known = ['--plan', '--check-plan', '--check'];
  if (arguments_.some((argument) => !known.includes(argument)) || arguments_.length > 1) {
    fail('accepts exactly one of --plan, --check-plan, or --check');
  }
  if (arguments_.includes('--plan')) {
    await writePlanDocuments();
    return;
  }
  if (arguments_.includes('--check-plan')) {
    await checkPlanDocuments();
    return;
  }
  // Default and --check: verify plan documents, stage bit-exact payloads,
  // build every shard twice, then create (default) or verify (--check) the
  // tracked authoring report.
  const checkOnly = arguments_.includes('--check');
  const { evidenceSha256 } = await derivePlan();
  const plan = await checkPlanDocuments();
  await stageShardPayloads(plan);
  const built = await buildShards(plan);
  await writeAuthoringReport(plan, built, evidenceSha256, checkOnly);
}

const executedDirectly = process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (executedDirectly) await main();
