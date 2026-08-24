/**
 * Verifies public/sfx WAV bytes against in-memory re-synthesis and provenance.
 * Stronger than stored-hash-only: regenerates every cue and byte-compares.
 *
 * Usage: node scripts/verify-product-sfx.mjs
 */

import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PRODUCT_SFX_GENERATOR_VERSION,
  PRODUCT_SFX_MAX_FILE_BYTES,
  PRODUCT_SFX_MAX_TOTAL_BYTES,
  PRODUCT_SFX_NAMES,
  PRODUCT_SFX_SAMPLE_RATE_HZ,
  buildProductSfxProvenance,
  loadAuthoredProductSfxBytes,
  renderProductSfxBytes,
  sha256Hex,
} from './lib/product-sfx-synthesis.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sfxDir = join(repoRoot, 'public', 'sfx');
const provenancePath = join(repoRoot, 'provenance', 'product-sfx.json');

const PROVENANCE_KEYS = Object.freeze([
  'generatorVersion',
  'sampleRateHz',
  'synthesisParameterDigest',
  'totalBytes',
  'files',
]);
const FILE_KEYS = Object.freeze(['name', 'path', 'sha256', 'byteSize']);
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

function recordIssue(issues, message) {
  issues.push(message);
}

function hasExactKeys(value, expectedKeys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function buffersEqual(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

async function readRegularFile(path, label, issues) {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      recordIssue(issues, `${label} is not a regular file: ${path}`);
      return null;
    }
    return await readFile(path);
  } catch (error) {
    recordIssue(issues, `missing ${label}: ${path} (${error.code ?? error.message})`);
    return null;
  }
}

function validateProvenanceShape(provenance, issues) {
  if (!provenance) return null;
  if (!hasExactKeys(provenance, PROVENANCE_KEYS)) {
    recordIssue(issues, 'product-sfx provenance does not contain exactly the reviewed fields');
    return null;
  }
  if (provenance.generatorVersion !== PRODUCT_SFX_GENERATOR_VERSION) {
    recordIssue(issues, `generatorVersion drifted: ${provenance.generatorVersion}`);
  }
  if (provenance.sampleRateHz !== PRODUCT_SFX_SAMPLE_RATE_HZ) {
    recordIssue(issues, `sampleRateHz drifted: ${provenance.sampleRateHz}`);
  }
  if (!HASH_PATTERN.test(provenance.synthesisParameterDigest)) {
    recordIssue(issues, 'synthesisParameterDigest is not a sha256 hex digest');
  }
  if (
    !Number.isSafeInteger(provenance.totalBytes) ||
    provenance.totalBytes < 1 ||
    provenance.totalBytes > PRODUCT_SFX_MAX_TOTAL_BYTES
  ) {
    recordIssue(issues, `totalBytes out of budget: ${provenance.totalBytes}`);
  }
  if (!Array.isArray(provenance.files) || provenance.files.length !== PRODUCT_SFX_NAMES.length) {
    recordIssue(issues, 'provenance files length does not match the cue set');
    return provenance;
  }
  for (const record of provenance.files) {
    if (!hasExactKeys(record, FILE_KEYS)) {
      recordIssue(issues, `provenance file record keys invalid: ${record?.name ?? '?'}`);
      continue;
    }
    if (!PRODUCT_SFX_NAMES.includes(record.name)) {
      recordIssue(issues, `unexpected cue name in provenance: ${record.name}`);
    }
    if (record.path !== `public/sfx/${record.name}.wav`) {
      recordIssue(issues, `provenance path drifted for ${record.name}`);
    }
    if (!HASH_PATTERN.test(record.sha256)) {
      recordIssue(issues, `sha256 invalid for ${record.name}`);
    }
    if (
      !Number.isSafeInteger(record.byteSize) ||
      record.byteSize < 1 ||
      record.byteSize > PRODUCT_SFX_MAX_FILE_BYTES
    ) {
      recordIssue(issues, `byteSize out of range for ${record.name}`);
    }
  }
  return provenance;
}

async function verifyProductSfx() {
  const issues = [];
  const authoredBytes = await loadAuthoredProductSfxBytes(repoRoot);
  const rendered = renderProductSfxBytes(authoredBytes);
  const expectedProvenance = buildProductSfxProvenance(rendered);

  const provenanceBytes = await readRegularFile(provenancePath, 'provenance', issues);
  let provenance = null;
  if (provenanceBytes) {
    try {
      provenance = JSON.parse(provenanceBytes.toString('utf8'));
    } catch (error) {
      recordIssue(issues, `invalid JSON in provenance: ${error.message}`);
    }
  }
  provenance = validateProvenanceShape(provenance, issues);

  if (provenance) {
    if (provenance.synthesisParameterDigest !== expectedProvenance.synthesisParameterDigest) {
      recordIssue(issues, 'synthesisParameterDigest does not match re-synthesis');
    }
    if (provenance.totalBytes !== expectedProvenance.totalBytes) {
      recordIssue(issues, 'provenance totalBytes does not match re-synthesis');
    }
    for (const expected of expectedProvenance.files) {
      const actual = provenance.files.find((entry) => entry.name === expected.name);
      if (!actual) {
        recordIssue(issues, `provenance missing cue: ${expected.name}`);
        continue;
      }
      if (actual.sha256 !== expected.sha256 || actual.byteSize !== expected.byteSize) {
        recordIssue(issues, `provenance hash/size mismatch for ${expected.name}`);
      }
    }
  }

  let onDiskTotal = 0;
  for (const name of PRODUCT_SFX_NAMES) {
    const path = join(sfxDir, `${name}.wav`);
    const onDisk = await readRegularFile(path, `sfx/${name}.wav`, issues);
    const synthesised = rendered.files[name];
    if (!onDisk) continue;
    onDiskTotal += onDisk.byteLength;
    if (!buffersEqual(onDisk, synthesised)) {
      recordIssue(
        issues,
        `public/sfx/${name}.wav bytes differ from re-synthesis ` +
          `(disk=${sha256Hex(onDisk)} synth=${sha256Hex(synthesised)})`,
      );
    }
    if (provenance) {
      const record = provenance.files.find((entry) => entry.name === name);
      if (record && sha256Hex(onDisk) !== record.sha256) {
        recordIssue(issues, `on-disk hash does not match provenance for ${name}`);
      }
      if (record && onDisk.byteLength !== record.byteSize) {
        recordIssue(issues, `on-disk size does not match provenance for ${name}`);
      }
    }
  }

  if (onDiskTotal > PRODUCT_SFX_MAX_TOTAL_BYTES) {
    recordIssue(issues, `on-disk total ${onDiskTotal} exceeds budget`);
  }

  // Provenance file itself must be the canonical pretty-printed form.
  if (provenanceBytes) {
    const canonical = `${JSON.stringify(expectedProvenance, null, 2)}\n`;
    if (provenanceBytes.toString('utf8') !== canonical) {
      // Still allow semantically equal JSON if shape validated above; prefer exact.
      const diskDigest = createHash('sha256').update(provenanceBytes).digest('hex');
      const expectedDigest = createHash('sha256').update(canonical).digest('hex');
      if (diskDigest !== expectedDigest) {
        recordIssue(issues, 'provenance/product-sfx.json is not the canonical serialisation');
      }
    }
  }

  return issues;
}

const issues = await verifyProductSfx();
if (issues.length > 0) {
  process.stderr.write(`verify:product-sfx failed:\n${issues.map((i) => `  - ${i}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('verify:product-sfx ok\n');
}
