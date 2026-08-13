import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const AUDIO_AUTHORITY = 'config/packs/e3-toy.audio.json';
const BUILD_AUTHORITY = 'config/packs/e3-toy.json';
const EVIDENCE = 'tests/fixtures/e3-toy-pack/audio-evidence.json';

function run(script, extraArguments) {
  return spawnSync(process.execPath, [script, ...extraArguments], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

// The evidence lane decodes every payload member, so it needs an FFmpeg on the
// host. The encode lane is not exercised here at all: the fixture ships
// pre-made payload audio precisely because the reviewed encoder (8.1.2) is not
// available everywhere.
function decoderAvailable() {
  return ['ffmpeg', 'ffprobe'].every(
    (binary) => spawnSync(binary, ['-version'], { encoding: 'utf8' }).status === 0,
  );
}

test('the documented author sequence verifies and builds the fixture pack', async (t) => {
  if (!decoderAvailable()) {
    t.skip('FFmpeg and ffprobe are not installed on this host');
    return;
  }
  const output = await mkdtemp(join(tmpdir(), 'ks2-e3-sequence-'));
  t.after(() => rm(output, { recursive: true, force: true }));

  const before = await readFile(resolve(ROOT, EVIDENCE));

  // Step one of the runbook: verify the tracked audio evidence.
  const verified = run('scripts/generate-starter-audio.mjs', [
    `--authority=${AUDIO_AUTHORITY}`,
    '--check',
  ]);
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  assert.match(verified.stdout, /Fixture audio evidence current: 12 assets\./u);

  // Step two: build the artifact from the paired build authority.
  const built = run('scripts/build-starter-pack.mjs', [
    `--authority=${BUILD_AUTHORITY}`,
    `--output-directory=${output}`,
  ]);
  assert.equal(built.status, 0, built.stderr || built.stdout);
  assert.match(built.stdout, /e3-toy pack payload verified: 13 files/u);

  const report = JSON.parse(await readFile(join(output, 'pack-build.json'), 'utf8'));
  assert.equal(report.status, 'pass');
  assert.equal(report.catalogueId, 'e3-toy:fixture');
  assert.equal(report.archive.fileCount, 13);
  assert.equal(report.source.audioEvidence.assetCount, 12);
  assert.equal(
    report.archive.sha256,
    createHash('sha256')
      .update(await readFile(join(output, 'e3-toy-1.0.0.zip')))
      .digest('hex'),
  );

  // Re-verifying after a build must still reproduce the tracked evidence byte
  // for byte, and must not have rewritten it.
  const reverified = run('scripts/generate-starter-audio.mjs', [
    `--authority=${AUDIO_AUTHORITY}`,
    '--check',
  ]);
  assert.equal(reverified.status, 0, reverified.stderr || reverified.stdout);
  assert.deepEqual(await readFile(resolve(ROOT, EVIDENCE)), before);
});

test('the author command refuses to overwrite verified evidence', async (t) => {
  if (!decoderAvailable()) {
    t.skip('FFmpeg and ffprobe are not installed on this host');
    return;
  }
  const created = run('scripts/generate-starter-audio.mjs', [
    `--authority=${AUDIO_AUTHORITY}`,
    `--source=${resolve(ROOT, 'tests/fixtures/e3-toy-pack/source')}`,
  ]);
  assert.notEqual(created.status, 0);
  assert.match(created.stderr, /create-only/u);
});

test('the author command rejects unsupported and conflicting options', () => {
  for (const argumentList of [
    ['--catalogue=full'],
    ['--check', '--runtime-manifest-only'],
    [`--authority=${AUDIO_AUTHORITY}`, '--check', '--source=/tmp/somewhere'],
    [`--authority=${AUDIO_AUTHORITY}`, '--source=relative/path'],
  ]) {
    const result = run('scripts/generate-starter-audio.mjs', argumentList);
    assert.notEqual(result.status, 0, argumentList.join(' '));
    assert.match(result.stderr, /requires --authority=/u, argumentList.join(' '));
  }
});

test('creating an externally sourced catalogue demands an absolute source', () => {
  const result = run('scripts/generate-starter-audio.mjs', [
    `--authority=${AUDIO_AUTHORITY}`,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /externally sourced catalogue/u);
});
