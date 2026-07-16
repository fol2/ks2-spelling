import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  B3_CAPTURE_BUNDLE_ERROR_CODES,
  B3_CAPTURE_BUNDLE_LIMITS,
  parseB3CaptureMemberName,
} from '../scripts/lib/b3-capture-bundle-store.mjs';

const HASH = 'a'.repeat(64);
const UUID = '018f1d7b-97e8-4a52-8cf2-783e5089c099';
const SECOND_UUID = '118f1d7b-97e8-4a52-8cf2-783e5089c098';
const execFileAsync = promisify(execFile);

async function fixture(t, label) {
  const root = await mkdtemp(join(tmpdir(), `b3-capture-bundle-${label}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, '.native-build', 'b3', 'evidence');
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  for (const path of [
    join(root, '.native-build'),
    join(root, '.native-build', 'b3'),
    evidence,
  ]) await chmod(path, 0o700);
  return root;
}

async function inspectInChild(root, input) {
  const child = new URL('./helpers/b3-capture-bundle-store-child.mjs', import.meta.url);
  const encoded = Buffer.from(JSON.stringify(input), 'utf8').toString('base64url');
  const { stdout } = await execFileAsync(process.execPath, [
    '--experimental-test-module-mocks', child.pathname, encoded,
  ], { cwd: root });
  return JSON.parse(stdout);
}

async function createEmptyWorkingBundle(root, platform = 'ios', captureId = UUID) {
  const working = join(
    root, '.native-build', 'b3', 'evidence', `${platform}-capture-bundles`,
    `${captureId}.working`,
  );
  for (const path of [
    join(root, '.native-build', 'b3', 'evidence', `${platform}-capture-bundles`),
    working,
    join(working, 'observations'),
    join(working, 'checkpoint'),
    join(working, 'derived'),
  ]) {
    await mkdir(path, { mode: 0o700 });
    await chmod(path, 0o700);
  }
  return working;
}

async function createWorkingSubset(root, children, captureId = UUID) {
  const working = join(
    root, '.native-build', 'b3', 'evidence', 'ios-capture-bundles',
    `${captureId}.working`,
  );
  await mkdir(working, { recursive: true, mode: 0o700 });
  for (const name of children) await mkdir(join(working, name), { mode: 0o700 });
  for (const path of [
    join(root, '.native-build', 'b3', 'evidence', 'ios-capture-bundles'),
    working,
    ...children.map((name) => join(working, name)),
  ]) await chmod(path, 0o700);
  return working;
}

async function namespaceSnapshot(path) {
  const rows = [];
  async function visit(current, relativePath) {
    const metadata = await lstat(current);
    const row = {
      relativePath,
      mode: metadata.mode,
      nlink: metadata.nlink,
      size: metadata.size,
      type: metadata.isDirectory()
        ? 'directory'
        : (metadata.isSymbolicLink() ? 'symlink' : 'file'),
    };
    if (metadata.isSymbolicLink()) row.target = await readlink(current);
    if (metadata.isFile()) row.sha256 = sha256(await readFile(current));
    rows.push(row);
    if (metadata.isDirectory()) {
      const names = (await readdir(current)).sort();
      for (const name of names) await visit(join(current, name),
        relativePath === '.' ? name : `${relativePath}/${name}`);
    }
  }
  await visit(path, '.');
  return rows;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function compositeAuthority({
  activeCommand = null,
  observations = [],
  checkpoints = [],
  pendingCheckpoint = null,
  gatewaySmoke = null,
} = {}) {
  return {
    databaseState: {
      kind: 'ready-initial',
      captureId: UUID,
      activeCommand,
    },
    retainedDomain: { observations, checkpoints, pendingCheckpoint, gatewaySmoke },
  };
}

function fixedNamespaceMetadata(device) {
  const prefix = join(
    '.native-build', 'b3', 'evidence', 'ios-capture-bundles',
    `${UUID}.working`,
  );
  return {
    device,
    identityByRelativePath: {
      [join('.native-build', 'b3', 'evidence')]: { ino: 100, nlink: 3, size: 96 },
      [join('.native-build', 'b3', 'evidence', 'ios-capture-bundles')]: {
        ino: 101, nlink: 3, size: 96,
      },
      [prefix]: { ino: 102, nlink: 5, size: 160 },
      [join(prefix, 'checkpoint')]: { ino: 103, nlink: 2, size: 64 },
      [join(prefix, 'derived')]: { ino: 104, nlink: 2, size: 64 },
      [join(prefix, 'observations')]: { ino: 105, nlink: 2, size: 64 },
    },
  };
}

test('closed bundle member grammars freeze canonical lengths and platform kinds', () => {
  assert.deepEqual(B3_CAPTURE_BUNDLE_LIMITS, {
    maximumMemberBytes: 131_072,
    maximumObservationFinals: 512,
    maximumCheckpointFinals: 512,
    maximumTemporaries: 32,
  });
  assert.deepEqual(B3_CAPTURE_BUNDLE_ERROR_CODES, {
    invalidBundle: 'b3_capture_bundle_invalid',
    memberConflict: 'b3_capture_member_conflict',
    drift: 'b3_capture_bundle_drift',
  });

  assert.deepEqual(parseB3CaptureMemberName({
    platform: 'ios',
    memberKind: 'observations',
    name: '00000001.json',
  }), {
    kind: 'final',
    memberKind: 'observations',
    finalName: '00000001.json',
    sequence: 1,
  });
  assert.deepEqual(parseB3CaptureMemberName({
    platform: 'ios',
    memberKind: 'observations',
    name: `.00000001.json.12.${HASH}.${UUID}.member.tmp`,
  }), {
    kind: 'temporary',
    memberKind: 'observations',
    finalName: '00000001.json',
    sequence: 1,
    expectedLength: 12,
    expectedSha256: HASH,
    temporaryId: UUID,
  });
  assert.deepEqual(parseB3CaptureMemberName({
    platform: 'ios',
    memberKind: 'checkpoint',
    name: `.revision-00000000.json.131072.${HASH}.${UUID}.member.tmp`,
  }), {
    kind: 'temporary',
    memberKind: 'checkpoint',
    finalName: 'revision-00000000.json',
    revision: 0,
    expectedLength: 131_072,
    expectedSha256: HASH,
    temporaryId: UUID,
  });
  assert.deepEqual(parseB3CaptureMemberName({
    platform: 'ios',
    memberKind: 'derived',
    name: 'cloudflare-device-smoke.json',
  }), {
    kind: 'final',
    memberKind: 'derived',
    finalName: 'cloudflare-device-smoke.json',
  });

  for (const name of [
    `.00000001.json.0.${HASH}.${UUID}.member.tmp`,
    `.00000001.json.01.${HASH}.${UUID}.member.tmp`,
    `.00000001.json.131073.${HASH}.${UUID}.member.tmp`,
    `.00000001.json.12.${'A'.repeat(64)}.${UUID}.member.tmp`,
  ]) {
    assert.throws(() => parseB3CaptureMemberName({
      platform: 'ios', memberKind: 'observations', name,
    }), { code: 'b3_capture_member_conflict' });
  }
  assert.throws(() => parseB3CaptureMemberName({
    platform: 'android',
    memberKind: 'derived',
    name: 'cloudflare-device-smoke.json',
  }), { code: 'b3_capture_member_conflict' });
});

test('fixed-root empty working bundle has one sorted literal snapshot and no actions',
  async (t) => {
    const root = await fixture(t, 'empty-snapshot');
    await createEmptyWorkingBundle(root);

    const inspected = await inspectInChild(root, {
      platform: 'ios',
      captureId: UUID,
      __testMetadata: fixedNamespaceMetadata(7),
      ...compositeAuthority(),
    });

    assert.equal(inspected.ok, true, inspected.message);
    assert.deepEqual(inspected.result, {
      schemaVersion: 1,
      platform: 'ios',
      captureId: UUID,
      bundleState: 'working',
      sameDevice: true,
      sameParent: true,
      namespace: {
        bundlesRoot: {
          dev: 7,
          ino: 101,
          mode: 0o700,
          nlink: 3,
          size: 96,
          canonicalPathSha256: 'abde65cca626f3a551d53651ac8ce5a4b27bac725334130c10c65592aebc0599',
          parentPathSha256: '005cc4ad23a029653ac122054aaea60ed11eb7cb6f6772724bdc5544fbfb6e95',
        },
        working: {
          dev: 7,
          ino: 102,
          mode: 0o700,
          nlink: 5,
          size: 160,
          canonicalPathSha256: '474b7cb95552fe3ee3169ff07f082a9df624b74f9a1117c04124fd2ef55abb65',
          parentPathSha256: '7b1f52fe159a94beee2288b594978173b9764aed6ffba8ec006a221e23a32303',
        },
      },
      entries: [
        {
          relativePath: '.', type: 'directory', dev: 7, ino: 102, mode: 0o700,
          nlink: 5, size: 160,
          canonicalPathSha256: '474b7cb95552fe3ee3169ff07f082a9df624b74f9a1117c04124fd2ef55abb65',
          parentPathSha256: '7b1f52fe159a94beee2288b594978173b9764aed6ffba8ec006a221e23a32303',
        },
        {
          relativePath: 'checkpoint', type: 'directory', dev: 7, ino: 103,
          mode: 0o700, nlink: 2, size: 64,
          canonicalPathSha256: '55c9433cc6106351f5fc952c6d63f7c0a7de782cf41aa2666208b95237219751',
          parentPathSha256: 'a06897f4832827306e504f00148f6ad67ea0a8eb25c366ed5b0a38ff704825a4',
        },
        {
          relativePath: 'derived', type: 'directory', dev: 7, ino: 104,
          mode: 0o700, nlink: 2, size: 64,
          canonicalPathSha256: '22a19675647efb321cabe6a6439a4744cc289db4dc666d66bd2e4e0547fcb287',
          parentPathSha256: 'a06897f4832827306e504f00148f6ad67ea0a8eb25c366ed5b0a38ff704825a4',
        },
        {
          relativePath: 'observations', type: 'directory', dev: 7, ino: 105,
          mode: 0o700, nlink: 2, size: 64,
          canonicalPathSha256: '9141a696759d237ded60d6bd8c2d40e4e483c4e6f7ba5cf7fd17718cad866ed7',
          parentPathSha256: 'a06897f4832827306e504f00148f6ad67ea0a8eb25c366ed5b0a38ff704825a4',
        },
      ],
      snapshotSha256: '538551737f4887dfbaae30167a00aaf8bf868bcf9296000d146b8ca44cbe5eaf',
      actions: [],
    });
  });

test('snapshot authority changes after whole working namespace replacement', async (t) => {
  const root = await fixture(t, 'working-replacement-snapshot');
  const working = await createEmptyWorkingBundle(root);
  const input = { platform: 'ios', captureId: UUID, ...compositeAuthority() };
  const before = await inspectInChild(root, input);
  assert.equal(before.ok, true, before.message);

  await rm(working, { recursive: true });
  for (const path of [
    working,
    join(working, 'observations'),
    join(working, 'checkpoint'),
    join(working, 'derived'),
  ]) await mkdir(path, { mode: 0o700 });
  const after = await inspectInChild(root, input);
  assert.equal(after.ok, true, after.message);

  assert.notEqual(after.result.snapshotSha256, before.result.snapshotSha256);
});

test('snapshot authority changes for an otherwise identical different-device namespace',
  async (t) => {
    const root = await fixture(t, 'different-device-snapshot');
    await createEmptyWorkingBundle(root);
    const input = { platform: 'ios', captureId: UUID, ...compositeAuthority() };
    const first = await inspectInChild(root, {
      ...input, __testMetadata: fixedNamespaceMetadata(7),
    });
    const second = await inspectInChild(root, {
      ...input, __testMetadata: fixedNamespaceMetadata(8),
    });
    assert.equal(first.ok, true, first.message);
    assert.equal(second.ok, true, second.message);
    assert.notEqual(second.result.snapshotSha256, first.result.snapshotSha256);
  });

test('pass one plans authorised incomplete cleanup and exact adoption without mutation',
  async (t) => {
    const root = await fixture(t, 'action-plan');
    const working = await createEmptyWorkingBundle(root);
    const observationBytes = Buffer.from('test', 'utf8');
    const checkpointBytes = Buffer.from('checkpoint', 'utf8');
    const observationHash = sha256(observationBytes);
    const checkpointHash = sha256(checkpointBytes);
    const observationDomainSha256 = 'b'.repeat(64);
    const observationTemporary =
      `.00000002.json.4.${observationHash}.${UUID}.member.tmp`;
    const checkpointTemporary =
      `.revision-00000000.json.10.${checkpointHash}.${UUID}.member.tmp`;
    const observationPath = join(working, 'observations', observationTemporary);
    const checkpointPath = join(working, 'checkpoint', checkpointTemporary);
    await writeFile(
      join(working, 'observations', '00000001.json'),
      observationBytes,
      { mode: 0o600 },
    );
    await writeFile(observationPath, observationBytes.subarray(0, 2), { mode: 0o600 });
    await writeFile(checkpointPath, checkpointBytes, { mode: 0o600 });

    const inspected = await inspectInChild(root, {
      platform: 'ios',
      captureId: UUID,
      ...compositeAuthority({
        activeCommand: {
          captureId: UUID,
          expectedSequence: 2,
          previousObservationSha256: observationDomainSha256,
        },
        observations: [{
          sequence: 1,
          expectedLength: observationBytes.length,
          expectedSha256: observationHash,
          observationSha256: observationDomainSha256,
          gatewaySmokeAuthority: false,
        }],
        pendingCheckpoint: {
          revision: 0,
          expectedLength: checkpointBytes.length,
          expectedSha256: checkpointHash,
          observationSha256: observationDomainSha256,
        },
      }),
    });

    assert.equal(inspected.ok, true, inspected.message);
    assert.deepEqual(inspected.result.actions, [{
      kind: 'adopt-complete-temporary',
      memberKind: 'checkpoint',
      temporaryRelativePath: `checkpoint/${checkpointTemporary}`,
      finalRelativePath: 'checkpoint/revision-00000000.json',
      expectedLength: checkpointBytes.length,
      expectedSha256: checkpointHash,
    }, {
      kind: 'remove-incomplete-temporary',
      memberKind: 'observations',
      temporaryRelativePath: `observations/${observationTemporary}`,
      finalRelativePath: 'observations/00000002.json',
      expectedLength: observationBytes.length,
      expectedSha256: observationHash,
    }]);
    assert.equal((await readFile(observationPath)).toString('utf8'), 'te');
    assert.equal((await readFile(checkpointPath)).toString('utf8'), 'checkpoint');
  });

test('final member sequences are contiguous and rejected inventories remain unchanged',
  async (t) => {
    const root = await fixture(t, 'final-gap');
    const working = await createEmptyWorkingBundle(root);
    const bytes = Buffer.from('retained', 'utf8');
    const hash = sha256(bytes);
    const path = join(working, 'observations', '00000002.json');
    await writeFile(path, bytes, { mode: 0o600 });

    const inspected = await inspectInChild(root, {
      platform: 'ios',
      captureId: UUID,
      ...compositeAuthority({
        observations: [{
          sequence: 2,
          expectedLength: bytes.length,
          expectedSha256: hash,
          observationSha256: 'c'.repeat(64),
          gatewaySmokeAuthority: false,
        }],
      }),
    });

    assert.equal(inspected.ok, false);
    assert.equal(inspected.code, 'b3_capture_member_conflict');
    assert.equal((await readFile(path)).toString('utf8'), 'retained');
  });

test('a caller proposal cannot authorise stale or future temporary debris', async (t) => {
  const root = await fixture(t, 'proposal-independent');
  const working = await createEmptyWorkingBundle(root);
  const bytes = Buffer.from('future', 'utf8');
  const hash = sha256(bytes);
  const temporary = `.00000005.json.6.${hash}.${UUID}.member.tmp`;
  const path = join(working, 'observations', temporary);
  await writeFile(path, bytes.subarray(0, 2), { mode: 0o600 });

  const inspected = await inspectInChild(root, {
    platform: 'ios',
    captureId: UUID,
    ...compositeAuthority({
      activeCommand: {
        captureId: UUID,
        expectedSequence: 1,
        previousObservationSha256: '0'.repeat(64),
      },
    }),
    memberAuthority: [{
      memberKind: 'observations',
      finalName: '00000005.json',
      expectedLength: bytes.length,
      expectedSha256: hash,
    }],
  });

  assert.equal(inspected.ok, false);
  assert.equal(inspected.code, 'b3_capture_bundle_invalid');
  assert.equal((await readFile(path)).toString('utf8'), 'fu');
});

test('retained domain slots must be exactly materialised as final files', async (t) => {
  const root = await fixture(t, 'unmaterialised-domain');
  await createEmptyWorkingBundle(root);
  const bytes = Buffer.from('claimed', 'utf8');

  const inspected = await inspectInChild(root, {
    platform: 'ios', captureId: UUID,
    ...compositeAuthority({
      observations: [{
        sequence: 1,
        expectedLength: bytes.length,
        expectedSha256: sha256(bytes),
        observationSha256: 'e'.repeat(64),
        gatewaySmokeAuthority: false,
      }],
      pendingCheckpoint: {
        revision: 0,
        expectedLength: bytes.length,
        expectedSha256: sha256(bytes),
        observationSha256: 'e'.repeat(64),
      },
    }),
  });

  assert.equal(inspected.ok, false);
  assert.equal(inspected.code, 'b3_capture_member_conflict');
});

test('an exact temporary beside its exact final is classified as redundant', async (t) => {
  const root = await fixture(t, 'redundant-temporary');
  const working = await createEmptyWorkingBundle(root);
  const bytes = Buffer.from('ok', 'utf8');
  const hash = sha256(bytes);
  const temporary = `.00000001.json.2.${hash}.${UUID}.member.tmp`;
  const finalPath = join(working, 'observations', '00000001.json');
  const temporaryPath = join(working, 'observations', temporary);
  await writeFile(finalPath, bytes, { mode: 0o600 });
  await writeFile(temporaryPath, bytes, { mode: 0o600 });

  const inspected = await inspectInChild(root, {
    platform: 'ios',
    captureId: UUID,
    ...compositeAuthority({
      observations: [{
        sequence: 1,
        expectedLength: bytes.length,
        expectedSha256: hash,
        observationSha256: 'd'.repeat(64),
        gatewaySmokeAuthority: false,
      }],
      pendingCheckpoint: {
        revision: 0,
        expectedLength: bytes.length,
        expectedSha256: hash,
        observationSha256: 'd'.repeat(64),
      },
    }),
  });

  assert.equal(inspected.ok, true, inspected.message);
  assert.deepEqual(inspected.result.actions, [{
    kind: 'remove-redundant-temporary',
    memberKind: 'observations',
    temporaryRelativePath: `observations/${temporary}`,
    finalRelativePath: 'observations/00000001.json',
    expectedLength: bytes.length,
    expectedSha256: hash,
  }]);
  assert.deepEqual(await readFile(finalPath), bytes);
  assert.deepEqual(await readFile(temporaryPath), bytes);
});

test('the global temporary limit accepts 32 and rejects 33 without mutation', async (t) => {
  async function materialise(root, count) {
    const working = await createEmptyWorkingBundle(root);
    const finalBytes = Buffer.from('ok', 'utf8');
    const temporaryBytes = finalBytes.subarray(0, 1);
    const finalHash = sha256(finalBytes);
    const observations = [];
    const checkpoints = [];
    const temporaryPaths = [];
    for (let sequence = 1; sequence <= count; sequence += 1) {
      const observationSha256 = sequence.toString(16).padStart(64, '0');
      observations.push({
        sequence,
        expectedLength: finalBytes.length,
        expectedSha256: finalHash,
        observationSha256,
        gatewaySmokeAuthority: false,
      });
      const finalName = `${String(sequence).padStart(8, '0')}.json`;
      const temporaryName = `.${finalName}.2.${finalHash}.${UUID}.member.tmp`;
      await writeFile(join(working, 'observations', finalName), finalBytes, { mode: 0o600 });
      const temporaryPath = join(working, 'observations', temporaryName);
      await writeFile(temporaryPath, temporaryBytes, { mode: 0o600 });
      temporaryPaths.push(temporaryPath);
      if (sequence < count) {
        checkpoints.push({
          revision: sequence - 1,
          expectedLength: finalBytes.length,
          expectedSha256: finalHash,
          observationSha256,
        });
        await writeFile(
          join(working, 'checkpoint',
            `revision-${String(sequence - 1).padStart(8, '0')}.json`),
          finalBytes,
          { mode: 0o600 },
        );
      }
    }
    return {
      observations,
      checkpoints,
      pendingCheckpoint: {
        revision: count - 1,
        expectedLength: finalBytes.length,
        expectedSha256: finalHash,
        observationSha256: observations.at(-1).observationSha256,
      },
      temporaryPaths,
    };
  }

  const acceptedRoot = await fixture(t, 'temporary-32');
  const accepted = await materialise(acceptedRoot, 32);
  const acceptedResult = await inspectInChild(acceptedRoot, {
    platform: 'ios', captureId: UUID,
    ...compositeAuthority(accepted),
  });
  assert.equal(acceptedResult.ok, true, acceptedResult.message);
  assert.equal(acceptedResult.result.actions.length, 32);

  const rejectedRoot = await fixture(t, 'temporary-33');
  const rejected = await materialise(rejectedRoot, 33);
  const before = await Promise.all(rejected.temporaryPaths.map((path) => readFile(path)));
  const rejectedResult = await inspectInChild(rejectedRoot, {
    platform: 'ios', captureId: UUID,
    ...compositeAuthority(rejected),
  });
  assert.equal(rejectedResult.ok, false);
  assert.equal(rejectedResult.code, 'b3_capture_member_conflict');
  const after = await Promise.all(rejected.temporaryPaths.map((path) => readFile(path)));
  assert.deepEqual(after, before);
});

test('a second temporary for one durable slot rejects without cleanup', async (t) => {
  const root = await fixture(t, 'second-temporary');
  const working = await createEmptyWorkingBundle(root);
  const bytes = Buffer.from('ok', 'utf8');
  const hash = sha256(bytes);
  const names = [UUID, SECOND_UUID].map((id) =>
    `.00000001.json.2.${hash}.${id}.member.tmp`);
  const paths = names.map((name) => join(working, 'observations', name));
  await Promise.all(paths.map((path) => writeFile(path, bytes.subarray(0, 1), {
    mode: 0o600,
  })));

  const inspected = await inspectInChild(root, {
    platform: 'ios', captureId: UUID,
    ...compositeAuthority({
      activeCommand: {
        captureId: UUID,
        expectedSequence: 1,
        previousObservationSha256: '0'.repeat(64),
      },
    }),
  });

  assert.equal(inspected.ok, false);
  assert.equal(inspected.code, 'b3_capture_member_conflict');
  assert.deepEqual(await Promise.all(paths.map((path) => readFile(path))), [
    bytes.subarray(0, 1), bytes.subarray(0, 1),
  ]);
});

test('an exact complete active temporary is retained for later semantic validation',
  async (t) => {
    const root = await fixture(t, 'active-complete-candidate');
    const working = await createEmptyWorkingBundle(root);
    const bytes = Buffer.from('candidate', 'utf8');
    const hash = sha256(bytes);
    const temporary = `.00000001.json.9.${hash}.${UUID}.member.tmp`;
    const path = join(working, 'observations', temporary);
    await writeFile(path, bytes, { mode: 0o600 });

    const inspected = await inspectInChild(root, {
      platform: 'ios', captureId: UUID,
      ...compositeAuthority({
        activeCommand: {
          captureId: UUID,
          expectedSequence: 1,
          previousObservationSha256: '0'.repeat(64),
        },
      }),
    });

    assert.equal(inspected.ok, true, inspected.message);
    assert.deepEqual(inspected.result.actions, [{
      kind: 'validate-complete-temporary',
      memberKind: 'observations',
      temporaryRelativePath: `observations/${temporary}`,
      finalRelativePath: 'observations/00000001.json',
      expectedLength: bytes.length,
      expectedSha256: hash,
    }]);
    assert.deepEqual(await readFile(path), bytes);
  });

test('fixed-root structural classification closes absent empty partial and working states',
  async (t) => {
    const absentRoot = await fixture(t, 'root-absent');
    assert.deepEqual(await inspectInChild(absentRoot, {
      __testOperation: 'root-state', platform: 'ios',
    }), {
      ok: true,
      result: { schemaVersion: 1, platform: 'ios', kind: 'absent' },
    });

    const emptyRoot = await fixture(t, 'root-empty');
    const bundles = join(emptyRoot, '.native-build', 'b3', 'evidence',
      'ios-capture-bundles');
    await mkdir(bundles, { mode: 0o700 });
    assert.deepEqual(await inspectInChild(emptyRoot, {
      __testOperation: 'root-state', platform: 'ios',
    }), {
      ok: true,
      result: { schemaVersion: 1, platform: 'ios', kind: 'empty' },
    });

    const partialRoot = await fixture(t, 'root-partial');
    const partialWorking = join(
      partialRoot, '.native-build', 'b3', 'evidence', 'ios-capture-bundles',
      `${UUID}.working`,
    );
    await mkdir(join(partialWorking, 'observations'), { recursive: true, mode: 0o700 });
    for (const path of [
      join(partialRoot, '.native-build', 'b3', 'evidence', 'ios-capture-bundles'),
      partialWorking,
      join(partialWorking, 'observations'),
    ]) await chmod(path, 0o700);
    assert.deepEqual(await inspectInChild(partialRoot, {
      __testOperation: 'root-state', platform: 'ios',
    }), {
      ok: true,
      result: {
        schemaVersion: 1,
        platform: 'ios',
        kind: 'partial-working',
        captureId: UUID,
        presentChildren: ['observations'],
        isExactEmpty: true,
      },
    });

    const workingRoot = await fixture(t, 'root-working');
    await createEmptyWorkingBundle(workingRoot);
    assert.deepEqual(await inspectInChild(workingRoot, {
      __testOperation: 'root-state', platform: 'ios',
    }), {
      ok: true,
      result: {
        schemaVersion: 1,
        platform: 'ios',
        kind: 'working',
        captureId: UUID,
        presentChildren: ['checkpoint', 'derived', 'observations'],
        isExactEmpty: true,
      },
    });
  });

test('private composite validator accepts only matching empty pending and ready pairings',
  async (t) => {
    const emptyRoot = await fixture(t, 'composite-empty');
    const empty = await inspectInChild(emptyRoot, {
      __testOperation: 'composite',
      platform: 'ios',
      databaseState: { kind: 'empty', startIntent: null },
    });
    assert.deepEqual(empty, {
      ok: true,
      result: { kind: 'empty', platform: 'ios' },
    });

    const pendingRoot = await fixture(t, 'composite-pending');
    const partialWorking = join(
      pendingRoot, '.native-build', 'b3', 'evidence', 'ios-capture-bundles',
      `${UUID}.working`,
    );
    await mkdir(join(partialWorking, 'observations'), { recursive: true, mode: 0o700 });
    for (const path of [
      join(pendingRoot, '.native-build', 'b3', 'evidence', 'ios-capture-bundles'),
      partialWorking,
      join(partialWorking, 'observations'),
    ]) await chmod(path, 0o700);
    const pending = await inspectInChild(pendingRoot, {
      __testOperation: 'composite',
      platform: 'ios',
      databaseState: { kind: 'pending-initial', startIntent: { captureId: UUID } },
    });
    assert.deepEqual(pending, {
      ok: true,
      result: {
        kind: 'pending-empty',
        platform: 'ios',
        captureId: UUID,
        bundleState: 'partial-working',
      },
    });

    const readyRoot = await fixture(t, 'composite-ready');
    await createEmptyWorkingBundle(readyRoot);
    const ready = await inspectInChild(readyRoot, {
      __testOperation: 'composite',
      platform: 'ios',
      databaseState: {
        kind: 'ready-initial',
        capture: { capture_id: UUID },
      },
    });
    assert.deepEqual(ready, {
      ok: true,
      result: {
        kind: 'ready-empty',
        platform: 'ios',
        captureId: UUID,
      },
    });

    const conflict = await inspectInChild(readyRoot, {
      __testOperation: 'composite',
      platform: 'ios',
      databaseState: { kind: 'empty', startIntent: null },
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'b3_capture_bundle_invalid');
  });

test('pending composite accepts absent empty and all eight exact empty child subsets',
  async (t) => {
    const childNames = ['checkpoint', 'derived', 'observations'];
    const cases = [
      { label: 'absent', children: null, expected: 'absent' },
      { label: 'empty-root', children: 'empty-root', expected: 'empty' },
      ...Array.from({ length: 8 }, (_, mask) => ({
        label: `subset-${mask}`,
        children: childNames.filter((_, index) => (mask & (1 << index)) !== 0),
        expected: mask === 7 ? 'working' : 'partial-working',
      })),
    ];
    for (const current of cases) {
      const root = await fixture(t, `pending-${current.label}`);
      if (current.children === 'empty-root') {
        const bundles = join(root, '.native-build', 'b3', 'evidence',
          'ios-capture-bundles');
        await mkdir(bundles, { mode: 0o700 });
      } else if (Array.isArray(current.children)) {
        await createWorkingSubset(root, current.children);
      }
      const before = await namespaceSnapshot(root);
      const inspected = await inspectInChild(root, {
        __testOperation: 'composite',
        platform: 'ios',
        databaseState: { kind: 'pending-initial', startIntent: { captureId: UUID } },
      });
      assert.deepEqual(inspected, {
        ok: true,
        result: {
          kind: 'pending-empty',
          platform: 'ios',
          captureId: UUID,
          bundleState: current.expected,
        },
      });
      assert.deepEqual(await namespaceSnapshot(root), before);
    }
  });

test('structurally valid non-empty working root is deferred to retained composite validation',
  async (t) => {
    const root = await fixture(t, 'structural-nonempty');
    const working = await createEmptyWorkingBundle(root);
    await writeFile(join(working, 'observations', '00000001.json'),
      Buffer.from('retained', 'utf8'), { mode: 0o600 });
    const before = await namespaceSnapshot(root);

    const inspected = await inspectInChild(root, {
      __testOperation: 'root-state', platform: 'ios',
    });

    assert.deepEqual(inspected, {
      ok: true,
      result: {
        schemaVersion: 1,
        platform: 'ios',
        kind: 'working',
        captureId: UUID,
        presentChildren: ['checkpoint', 'derived', 'observations'],
        isExactEmpty: false,
      },
    });
    assert.deepEqual(await namespaceSnapshot(root), before);
  });

test('hostile root and pending bundle states reject with byte-identical namespace',
  async (t) => {
    const cases = [{
      label: 'wrong-capture',
      setup: (root) => createWorkingSubset(root, [], UUID),
      databaseCaptureId: SECOND_UUID,
    }, {
      label: 'extra-root-file',
      setup: async (root) => {
        const bundles = join(root, '.native-build', 'b3', 'evidence',
          'ios-capture-bundles');
        await mkdir(bundles, { mode: 0o700 });
        await writeFile(join(bundles, 'unexpected'), Buffer.from('x'), { mode: 0o600 });
      },
    }, {
      label: 'abandoned-root',
      setup: async (root) => {
        const bundles = join(root, '.native-build', 'b3', 'evidence',
          'ios-capture-bundles');
        await mkdir(join(bundles, `${UUID}.abandoned`), { recursive: true, mode: 0o700 });
        await chmod(bundles, 0o700);
      },
    }, {
      label: 'second-capture',
      setup: async (root) => {
        await createWorkingSubset(root, [], UUID);
        await createWorkingSubset(root, [], SECOND_UUID);
      },
    }, {
      label: 'final-member',
      setup: async (root) => {
        const working = await createEmptyWorkingBundle(root);
        await writeFile(join(working, 'observations', '00000001.json'),
          Buffer.from('x'), { mode: 0o600 });
      },
    }, {
      label: 'temporary-member',
      setup: async (root) => {
        const working = await createEmptyWorkingBundle(root);
        const bytes = Buffer.from('x');
        await writeFile(join(working, 'observations',
          `.00000001.json.1.${sha256(bytes)}.${UUID}.member.tmp`),
        bytes, { mode: 0o600 });
      },
    }, {
      label: 'wrong-mode',
      setup: async (root) => {
        const working = await createWorkingSubset(root, []);
        await chmod(working, 0o755);
      },
    }, {
      label: 'symbolic-link-child',
      setup: async (root) => {
        const working = await createWorkingSubset(root, []);
        const target = join(root, 'outside-observations');
        await mkdir(target, { mode: 0o700 });
        await symlink(target, join(working, 'observations'));
      },
    }, {
      label: 'hard-link-member',
      setup: async (root) => {
        const working = await createEmptyWorkingBundle(root);
        const source = join(root, 'linked-source');
        await writeFile(source, Buffer.from('x'), { mode: 0o600 });
        await link(source, join(working, 'observations', '00000001.json'));
      },
    }];

    for (const current of cases) {
      const root = await fixture(t, `hostile-${current.label}`);
      await current.setup(root);
      const before = await namespaceSnapshot(root);
      const inspected = await inspectInChild(root, {
        __testOperation: 'composite',
        platform: 'ios',
        databaseState: {
          kind: 'pending-initial',
          startIntent: { captureId: current.databaseCaptureId ?? UUID },
        },
      });
      assert.equal(inspected.ok, false, current.label);
      assert.equal(inspected.code, 'b3_capture_bundle_invalid', current.label);
      assert.deepEqual(await namespaceSnapshot(root), before, current.label);
    }
  });

test('empty and ready database mismatches reject with byte-identical namespace',
  async (t) => {
    const cases = [{
      label: 'empty-with-working',
      setup: (root) => createEmptyWorkingBundle(root),
      databaseState: { kind: 'empty', startIntent: null },
    }, {
      label: 'pending-with-nonempty',
      setup: async (root) => {
        const working = await createEmptyWorkingBundle(root);
        await writeFile(join(working, 'observations', '00000001.json'),
          Buffer.from('x'), { mode: 0o600 });
      },
      databaseState: { kind: 'pending-initial', startIntent: { captureId: UUID } },
    }, {
      label: 'ready-missing',
      setup: async () => {},
      databaseState: { kind: 'ready-initial', capture: { capture_id: UUID } },
    }, {
      label: 'ready-partial',
      setup: (root) => createWorkingSubset(root, ['observations']),
      databaseState: { kind: 'ready-initial', capture: { capture_id: UUID } },
    }, {
      label: 'ready-wrong-capture',
      setup: (root) => createEmptyWorkingBundle(root),
      databaseState: { kind: 'ready-initial', capture: { capture_id: SECOND_UUID } },
    }];

    for (const current of cases) {
      const root = await fixture(t, current.label);
      await current.setup(root);
      const before = await namespaceSnapshot(root);
      const inspected = await inspectInChild(root, {
        __testOperation: 'composite',
        platform: 'ios',
        databaseState: current.databaseState,
      });
      assert.equal(inspected.ok, false, current.label);
      assert.equal(inspected.code, 'b3_capture_bundle_invalid', current.label);
      assert.deepEqual(await namespaceSnapshot(root), before, current.label);
    }
  });

test('member pathname replacement after fd read is rejected by exact inode identity',
  async (t) => {
    const root = await fixture(t, 'member-identity');
    const working = await createEmptyWorkingBundle(root);
    const bytes = Buffer.from('stable', 'utf8');
    const hash = sha256(bytes);
    const relativePath = join(
      '.native-build', 'b3', 'evidence', 'ios-capture-bundles',
      `${UUID}.working`, 'observations', '00000001.json',
    );
    await writeFile(join(root, relativePath), bytes, { mode: 0o600 });

    const inspected = await inspectInChild(root, {
      platform: 'ios', captureId: UUID,
      __testFault: { kind: 'replace-member-before-pathname-check', relativePath },
      ...compositeAuthority({
        observations: [{
          sequence: 1,
          expectedLength: bytes.length,
          expectedSha256: hash,
          observationSha256: 'f'.repeat(64),
          gatewaySmokeAuthority: false,
        }],
        pendingCheckpoint: {
          revision: 0,
          expectedLength: bytes.length,
          expectedSha256: hash,
          observationSha256: 'f'.repeat(64),
        },
      }),
    });

    assert.equal(inspected.ok, false);
    assert.equal(inspected.code, 'b3_capture_member_conflict');
    assert.deepEqual(await readFile(join(root, relativePath)), bytes);
    assert.deepEqual(await readFile(`${join(root, relativePath)}.replaced`), bytes);
    assert.equal(working.endsWith(`${UUID}.working`), true);
  });

test('directory replacement after readdir is rejected by stable namespace identity',
  async (t) => {
    const root = await fixture(t, 'directory-identity');
    await createEmptyWorkingBundle(root);
    const relativePath = join(
      '.native-build', 'b3', 'evidence', 'ios-capture-bundles',
      `${UUID}.working`, 'observations',
    );

    const inspected = await inspectInChild(root, {
      platform: 'ios', captureId: UUID,
      __testFault: { kind: 'replace-directory-after-readdir', relativePath },
      ...compositeAuthority(),
    });

    assert.equal(inspected.ok, false);
    assert.equal(inspected.code, 'b3_capture_bundle_invalid');
    assert.deepEqual(await readdir(join(root, relativePath)), []);
    assert.deepEqual(await readdir(`${join(root, relativePath)}.replaced`), []);
  });

test('pre-smoke authority is optional but never duplicate or Android-derived', async (t) => {
  async function materialise(root, platform, duplicated) {
    const working = await createEmptyWorkingBundle(root, platform);
    const bytes = Buffer.from('ok');
    const hash = sha256(bytes);
    const count = duplicated ? 2 : 1;
    const observations = [];
    const checkpoints = [];
    for (let sequence = 1; sequence <= count; sequence += 1) {
      const observationSha256 = String(sequence).repeat(64);
      observations.push({
        sequence,
        expectedLength: bytes.length,
        expectedSha256: hash,
        observationSha256,
        gatewaySmokeAuthority: true,
      });
      await writeFile(join(working, 'observations',
        `${String(sequence).padStart(8, '0')}.json`), bytes, { mode: 0o600 });
      if (sequence < count) {
        checkpoints.push({
          revision: sequence - 1,
          expectedLength: bytes.length,
          expectedSha256: hash,
          observationSha256,
        });
        await writeFile(join(working, 'checkpoint',
          `revision-${String(sequence - 1).padStart(8, '0')}.json`),
        bytes, { mode: 0o600 });
      }
    }
    return {
      bytes,
      hash,
      observations,
      checkpoints,
      pendingCheckpoint: {
        revision: count - 1,
        expectedLength: bytes.length,
        expectedSha256: hash,
        observationSha256: observations.at(-1).observationSha256,
      },
    };
  }

  const validRoot = await fixture(t, 'pre-smoke-valid');
  const valid = await materialise(validRoot, 'ios', false);
  const accepted = await inspectInChild(validRoot, {
    platform: 'ios', captureId: UUID,
    ...compositeAuthority(valid),
  });
  assert.equal(accepted.ok, true, accepted.message);

  const duplicateRoot = await fixture(t, 'pre-smoke-duplicate');
  const duplicate = await materialise(duplicateRoot, 'ios', true);
  const rejectedDuplicate = await inspectInChild(duplicateRoot, {
    platform: 'ios', captureId: UUID,
    ...compositeAuthority(duplicate),
  });
  assert.equal(rejectedDuplicate.ok, false);
  assert.equal(rejectedDuplicate.code, 'b3_capture_member_conflict');

  const androidRoot = await fixture(t, 'pre-smoke-android');
  const android = await materialise(androidRoot, 'android', false);
  const rejectedAndroid = await inspectInChild(androidRoot, {
    platform: 'android', captureId: UUID,
    ...compositeAuthority(android),
  });
  assert.equal(rejectedAndroid.ok, false);
  assert.equal(rejectedAndroid.code, 'b3_capture_member_conflict');
});

test('pending iOS gateway smoke has a proposal-independent crash candidate matrix',
  async (t) => {
    async function base(root) {
      const working = await createEmptyWorkingBundle(root);
      const observationBytes = Buffer.from('observation');
      const observationHash = sha256(observationBytes);
      const observationSha256 = '9'.repeat(64);
      await writeFile(join(working, 'observations', '00000001.json'),
        observationBytes, { mode: 0o600 });
      return {
        working,
        authority: compositeAuthority({
          observations: [{
            sequence: 1,
            expectedLength: observationBytes.length,
            expectedSha256: observationHash,
            observationSha256,
            gatewaySmokeAuthority: true,
          }],
          pendingCheckpoint: {
            revision: 0,
            expectedLength: observationBytes.length,
            expectedSha256: observationHash,
            observationSha256,
          },
        }),
      };
    }

    const smokeBytes = Buffer.from('smoke');
    const smokeHash = sha256(smokeBytes);
    const temporary = `.cloudflare-device-smoke.json.5.${smokeHash}.${UUID}.member.tmp`;

    const absentRoot = await fixture(t, 'smoke-candidate-absent');
    const absent = await base(absentRoot);
    const absentResult = await inspectInChild(absentRoot, {
      platform: 'ios', captureId: UUID, ...absent.authority,
    });
    assert.equal(absentResult.ok, true, absentResult.message);
    assert.deepEqual(absentResult.result.actions, []);

    const incompleteRoot = await fixture(t, 'smoke-candidate-incomplete');
    const incomplete = await base(incompleteRoot);
    const incompletePath = join(incomplete.working, 'derived', temporary);
    await writeFile(incompletePath, smokeBytes.subarray(0, 2), { mode: 0o600 });
    const incompleteResult = await inspectInChild(incompleteRoot, {
      platform: 'ios', captureId: UUID, ...incomplete.authority,
    });
    assert.equal(incompleteResult.ok, true, incompleteResult.message);
    assert.deepEqual(incompleteResult.result.actions, [{
      kind: 'remove-incomplete-temporary',
      memberKind: 'derived',
      temporaryRelativePath: `derived/${temporary}`,
      finalRelativePath: 'derived/cloudflare-device-smoke.json',
      expectedLength: smokeBytes.length,
      expectedSha256: smokeHash,
    }]);
    assert.deepEqual(await readFile(incompletePath), smokeBytes.subarray(0, 2));

    const completeRoot = await fixture(t, 'smoke-candidate-complete');
    const complete = await base(completeRoot);
    const completePath = join(complete.working, 'derived', temporary);
    await writeFile(completePath, smokeBytes, { mode: 0o600 });
    const completeResult = await inspectInChild(completeRoot, {
      platform: 'ios', captureId: UUID, ...complete.authority,
    });
    assert.equal(completeResult.ok, true, completeResult.message);
    assert.deepEqual(completeResult.result.actions, [{
      kind: 'validate-complete-temporary',
      memberKind: 'derived',
      temporaryRelativePath: `derived/${temporary}`,
      finalRelativePath: 'derived/cloudflare-device-smoke.json',
      expectedLength: smokeBytes.length,
      expectedSha256: smokeHash,
    }]);
    assert.deepEqual(await readFile(completePath), smokeBytes);

    const retainedRoot = await fixture(t, 'smoke-retained-redundant');
    const retained = await base(retainedRoot);
    const retainedPath = join(retained.working, 'derived',
      'cloudflare-device-smoke.json');
    const retainedTemporaryPath = join(retained.working, 'derived', temporary);
    await writeFile(retainedPath, smokeBytes, { mode: 0o600 });
    await writeFile(retainedTemporaryPath, smokeBytes, { mode: 0o600 });
    retained.authority.retainedDomain.gatewaySmoke = {
      expectedLength: smokeBytes.length,
      expectedSha256: smokeHash,
      observationSha256: '9'.repeat(64),
    };
    const retainedResult = await inspectInChild(retainedRoot, {
      platform: 'ios', captureId: UUID, ...retained.authority,
    });
    assert.equal(retainedResult.ok, true, retainedResult.message);
    assert.deepEqual(retainedResult.result.actions, [{
      kind: 'remove-redundant-temporary',
      memberKind: 'derived',
      temporaryRelativePath: `derived/${temporary}`,
      finalRelativePath: 'derived/cloudflare-device-smoke.json',
      expectedLength: smokeBytes.length,
      expectedSha256: smokeHash,
    }]);
  });

test('an ancestor symlink cannot move the fixed evidence root outside the repository',
  async (t) => {
    const root = await fixture(t, 'evidence-escape');
    const outside = await mkdtemp(join(tmpdir(), 'b3-capture-bundle-outside-'));
    t.after(() => rm(outside, { recursive: true, force: true }));
    await rm(join(root, '.native-build'), { recursive: true });
    await mkdir(join(outside, 'b3', 'evidence'), { recursive: true, mode: 0o700 });
    for (const path of [outside, join(outside, 'b3'), join(outside, 'b3', 'evidence')]) {
      await chmod(path, 0o700);
    }
    await symlink(outside, join(root, '.native-build'));

    const inspected = await inspectInChild(root, {
      __testOperation: 'root-state', platform: 'ios',
    });

    assert.equal(inspected.ok, false);
    assert.equal(inspected.code, 'b3_capture_bundle_invalid');
  });

test('root classification rejects an in-repository redirect of the fixed evidence root',
  async (t) => {
    const root = await fixture(t, 'fixed-root-classification-redirect');
    const redirected = join(root, 'redirected');
    await rm(join(root, '.native-build'), { recursive: true });
    await mkdir(join(redirected, 'b3', 'evidence'), {
      recursive: true,
      mode: 0o700,
    });
    for (const path of [
      redirected,
      join(redirected, 'b3'),
      join(redirected, 'b3', 'evidence'),
    ]) await chmod(path, 0o700);
    await symlink('redirected', join(root, '.native-build'));

    const inspected = await inspectInChild(root, {
      __testOperation: 'root-state', platform: 'ios',
    });

    assert.equal(inspected.ok, false);
    assert.equal(inspected.code, 'b3_capture_bundle_invalid');
  });

test('full inventory rejects an in-repository redirect of the fixed evidence root',
  async (t) => {
    const root = await fixture(t, 'fixed-root-inventory-redirect');
    const redirected = join(root, 'redirected');
    await rm(join(root, '.native-build'), { recursive: true });
    await mkdir(join(redirected, 'b3', 'evidence'), {
      recursive: true,
      mode: 0o700,
    });
    for (const path of [
      redirected,
      join(redirected, 'b3'),
      join(redirected, 'b3', 'evidence'),
    ]) await chmod(path, 0o700);
    await symlink('redirected', join(root, '.native-build'));
    await createEmptyWorkingBundle(root);

    const inspected = await inspectInChild(root, {
      platform: 'ios',
      captureId: UUID,
      ...compositeAuthority(),
    });

    assert.equal(inspected.ok, false);
    assert.equal(inspected.code, 'b3_capture_bundle_invalid');
  });
