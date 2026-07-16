import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { canonicaliseB3ProofValue } from '../../src/app/b3-live-proof-protocol.js';
import { B3_CAPTURE_STATE_REPOSITORY_ROOT } from './b3-capture-state-location.mjs';

const HASH = '[0-9a-f]{64}';
const UUID_V4 =
  '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const LENGTH = '[1-9][0-9]{0,5}';

export const B3_CAPTURE_BUNDLE_LIMITS = Object.freeze({
  maximumMemberBytes: 128 * 1024,
  maximumObservationFinals: 512,
  maximumCheckpointFinals: 512,
  maximumTemporaries: 32,
});

export const B3_CAPTURE_BUNDLE_ERROR_CODES = Object.freeze({
  invalidBundle: 'b3_capture_bundle_invalid',
  memberConflict: 'b3_capture_member_conflict',
  drift: 'b3_capture_bundle_drift',
});

const FINAL_GRAMMARS = Object.freeze({
  observations: /^(?<sequence>[0-9]{8})\.json$/u,
  checkpoint: /^revision-(?<revision>[0-9]{8})\.json$/u,
  derived: /^cloudflare-device-smoke\.json$/u,
});

const TEMPORARY_GRAMMARS = Object.freeze({
  observations: new RegExp(
    `^\\.(?<final>(?<sequence>[0-9]{8})\\.json)\\.(?<length>${LENGTH})\\.` +
    `(?<hash>${HASH})\\.(?<uuid>${UUID_V4})\\.member\\.tmp$`,
    'u',
  ),
  checkpoint: new RegExp(
    `^\\.(?<final>revision-(?<revision>[0-9]{8})\\.json)\\.(?<length>${LENGTH})\\.` +
    `(?<hash>${HASH})\\.(?<uuid>${UUID_V4})\\.member\\.tmp$`,
    'u',
  ),
  derived: new RegExp(
    `^\\.(?<final>cloudflare-device-smoke\\.json)\\.(?<length>${LENGTH})\\.` +
    `(?<hash>${HASH})\\.(?<uuid>${UUID_V4})\\.member\\.tmp$`,
    'u',
  ),
});

const ROOT_STATE_AUTHORITIES = new WeakMap();

function memberError(message) {
  return Object.assign(new Error(message), {
    code: B3_CAPTURE_BUNDLE_ERROR_CODES.memberConflict,
  });
}

function bundleError(message) {
  return Object.assign(new Error(message), {
    code: B3_CAPTURE_BUNDLE_ERROR_CODES.invalidBundle,
  });
}

function assertPlatformAndKind(platform, memberKind) {
  if (!['ios', 'android'].includes(platform) ||
      !Object.hasOwn(FINAL_GRAMMARS, memberKind) ||
      (platform === 'android' && memberKind === 'derived')) {
    throw memberError('B3 capture bundle member platform or kind is invalid');
  }
}

function indexedMember(memberKind, groups) {
  if (memberKind === 'observations') {
    const sequence = Number(groups.sequence);
    if (sequence < 1 || sequence > 99_999_999) {
      throw memberError('B3 capture bundle observation name is invalid');
    }
    return { sequence };
  }
  if (memberKind === 'checkpoint') {
    const revision = Number(groups.revision);
    if (revision > 99_999_999) {
      throw memberError('B3 capture bundle checkpoint name is invalid');
    }
    return { revision };
  }
  return {};
}

export function parseB3CaptureMemberName({ platform, memberKind, name } = {}) {
  assertPlatformAndKind(platform, memberKind);
  if (typeof name !== 'string') {
    throw memberError('B3 capture bundle member name is invalid');
  }
  const final = FINAL_GRAMMARS[memberKind].exec(name);
  if (final) {
    return Object.freeze({
      kind: 'final',
      memberKind,
      finalName: name,
      ...indexedMember(memberKind, final.groups ?? {}),
    });
  }
  const temporary = TEMPORARY_GRAMMARS[memberKind].exec(name);
  if (!temporary) {
    throw memberError('B3 capture bundle member name is not closed');
  }
  const expectedLength = Number(temporary.groups.length);
  if (String(expectedLength) !== temporary.groups.length ||
      expectedLength < 1 || expectedLength > B3_CAPTURE_BUNDLE_LIMITS.maximumMemberBytes) {
    throw memberError('B3 capture bundle temporary length is invalid');
  }
  return Object.freeze({
    kind: 'temporary',
    memberKind,
    finalName: temporary.groups.final,
    ...indexedMember(memberKind, temporary.groups),
    expectedLength,
    expectedSha256: temporary.groups.hash,
    temporaryId: temporary.groups.uuid,
  });
}

function exactDirectory(path, label, expectedParent = null, expectedDevice = null) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw bundleError(`B3 capture bundle ${label} directory is absent`);
    }
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
      (metadata.mode & 0o7777) !== 0o700 ||
      (expectedDevice !== null && metadata.dev !== expectedDevice)) {
    throw bundleError(`B3 capture bundle ${label} directory policy is invalid`);
  }
  const canonical = realpathSync(path);
  if (expectedParent !== null && dirname(canonical) !== expectedParent) {
    throw bundleError(`B3 capture bundle ${label} parent is invalid`);
  }
  return Object.freeze({ canonical, metadata });
}

function assertCaptureId(captureId) {
  if (typeof captureId !== 'string' ||
      !new RegExp(`^${UUID_V4}$`, 'u').test(captureId)) {
    throw bundleError('B3 capture bundle capture ID is invalid');
  }
  return captureId;
}

function snapshotSha256(value) {
  return createHash('sha256')
    .update(Buffer.from('ks2-spelling:b3-capture-bundle-snapshot:v1\0', 'utf8'))
    .update(Buffer.from(canonicaliseB3ProofValue(value), 'utf8'))
    .digest('hex');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalPathSha256(repositoryRoot, canonicalPath, role) {
  if (canonicalPath !== repositoryRoot &&
      !canonicalPath.startsWith(`${repositoryRoot}/`)) {
    throw bundleError('B3 capture bundle canonical identity escaped the repository');
  }
  const relativePath = canonicalPath === repositoryRoot
    ? '.'
    : canonicalPath.slice(repositoryRoot.length + 1);
  return createHash('sha256')
    .update(Buffer.from(`ks2-spelling:b3-capture-bundle-${role}:v1\0`, 'utf8'))
    .update(Buffer.from(relativePath, 'utf8'))
    .digest('hex');
}

function directorySnapshotIdentity(directory, parent, repositoryRoot) {
  return Object.freeze({
    dev: directory.metadata.dev,
    ino: directory.metadata.ino,
    mode: directory.metadata.mode & 0o7777,
    nlink: directory.metadata.nlink,
    size: directory.metadata.size,
    canonicalPathSha256: canonicalPathSha256(
      repositoryRoot, directory.canonical, 'canonical-path',
    ),
    parentPathSha256: canonicalPathSha256(
      repositoryRoot, parent, 'canonical-parent',
    ),
  });
}

function isExactPlainRecord(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).every((key) => typeof key === 'string') &&
    Reflect.ownKeys(value).sort().join(',') === [...keys].sort().join(',');
}

function assertHash(value, label) {
  if (typeof value !== 'string' || !new RegExp(`^${HASH}$`, 'u').test(value)) {
    throw bundleError(`B3 capture bundle ${label} hash is invalid`);
  }
  return value;
}

function assertMemberLength(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 ||
      value > B3_CAPTURE_BUNDLE_LIMITS.maximumMemberBytes) {
    throw bundleError(`B3 capture bundle ${label} length is invalid`);
  }
  return value;
}

function finalNameFor(memberKind, index) {
  if (memberKind === 'observations') return `${String(index).padStart(8, '0')}.json`;
  if (memberKind === 'checkpoint') {
    return `revision-${String(index).padStart(8, '0')}.json`;
  }
  return 'cloudflare-device-smoke.json';
}

function snapshotCompositeAuthority(platform, captureId, databaseState, retainedDomain) {
  if (!isExactPlainRecord(databaseState, ['kind', 'captureId', 'activeCommand']) ||
      databaseState.kind !== 'ready-initial' || databaseState.captureId !== captureId ||
      !isExactPlainRecord(retainedDomain, [
        'observations', 'checkpoints', 'pendingCheckpoint', 'gatewaySmoke',
      ]) || !Array.isArray(retainedDomain.observations) ||
      !Array.isArray(retainedDomain.checkpoints)) {
    throw bundleError('B3 capture bundle composite authority is invalid');
  }
  const observations = retainedDomain.observations.map((slot, index) => {
    if (!isExactPlainRecord(slot, [
      'sequence', 'expectedLength', 'expectedSha256', 'observationSha256',
      'gatewaySmokeAuthority',
    ]) || slot.sequence !== index + 1 || typeof slot.gatewaySmokeAuthority !== 'boolean') {
      throw memberError('B3 capture bundle observation domain slots are not contiguous');
    }
    return Object.freeze({
      memberKind: 'observations',
      finalName: finalNameFor('observations', slot.sequence),
      sequence: slot.sequence,
      expectedLength: assertMemberLength(slot.expectedLength, 'observation slot'),
      expectedSha256: assertHash(slot.expectedSha256, 'observation slot'),
      observationSha256: assertHash(slot.observationSha256, 'observation domain'),
      gatewaySmokeAuthority: slot.gatewaySmokeAuthority,
    });
  });
  const checkpoints = retainedDomain.checkpoints.map((slot, index) => {
    if (!isExactPlainRecord(slot, [
      'revision', 'expectedLength', 'expectedSha256', 'observationSha256',
    ]) || slot.revision !== index) {
      throw memberError('B3 capture bundle checkpoint domain slots are not contiguous');
    }
    const observation = observations[index];
    if (!observation || observation.observationSha256 !== slot.observationSha256) {
      throw memberError('B3 capture bundle checkpoint domain slot is not paired');
    }
    return Object.freeze({
      memberKind: 'checkpoint',
      finalName: finalNameFor('checkpoint', slot.revision),
      revision: slot.revision,
      expectedLength: assertMemberLength(slot.expectedLength, 'checkpoint slot'),
      expectedSha256: assertHash(slot.expectedSha256, 'checkpoint slot'),
      observationSha256: slot.observationSha256,
    });
  });
  if (observations.length > B3_CAPTURE_BUNDLE_LIMITS.maximumObservationFinals ||
      checkpoints.length > B3_CAPTURE_BUNDLE_LIMITS.maximumCheckpointFinals ||
      ![observations.length, observations.length - 1].includes(checkpoints.length)) {
    throw memberError('B3 capture bundle retained domain counts are invalid');
  }

  let pendingCheckpoint = null;
  if (retainedDomain.pendingCheckpoint !== null) {
    const slot = retainedDomain.pendingCheckpoint;
    const observation = observations[checkpoints.length];
    if (!isExactPlainRecord(slot, [
      'revision', 'expectedLength', 'expectedSha256', 'observationSha256',
    ]) || checkpoints.length !== observations.length - 1 ||
        slot.revision !== checkpoints.length || !observation ||
        slot.observationSha256 !== observation.observationSha256) {
      throw memberError('B3 capture bundle pending checkpoint slot is not derivable');
    }
    pendingCheckpoint = Object.freeze({
      memberKind: 'checkpoint',
      finalName: finalNameFor('checkpoint', slot.revision),
      revision: slot.revision,
      expectedLength: assertMemberLength(slot.expectedLength, 'pending checkpoint slot'),
      expectedSha256: assertHash(slot.expectedSha256, 'pending checkpoint slot'),
      observationSha256: slot.observationSha256,
      candidate: true,
    });
  } else if (checkpoints.length !== observations.length) {
    throw memberError('B3 capture bundle one-behind checkpoint has no derivable slot');
  }

  const smokeAuthorities = observations.filter((slot) => slot.gatewaySmokeAuthority);
  if (smokeAuthorities.length > 1 ||
      (platform === 'android' && smokeAuthorities.length !== 0)) {
    throw memberError('B3 capture bundle gateway smoke authority is not unique');
  }
  let gatewaySmoke = null;
  let pendingGatewaySmoke = null;
  if (retainedDomain.gatewaySmoke !== null) {
    const slot = retainedDomain.gatewaySmoke;
    if (platform !== 'ios' || !isExactPlainRecord(slot, [
      'expectedLength', 'expectedSha256', 'observationSha256',
    ]) || smokeAuthorities.length !== 1 ||
        smokeAuthorities[0].observationSha256 !== slot.observationSha256) {
      throw memberError('B3 capture bundle gateway smoke slot is not uniquely paired');
    }
    gatewaySmoke = Object.freeze({
      memberKind: 'derived',
      finalName: finalNameFor('derived'),
      expectedLength: assertMemberLength(slot.expectedLength, 'gateway smoke slot'),
      expectedSha256: assertHash(slot.expectedSha256, 'gateway smoke slot'),
      observationSha256: slot.observationSha256,
    });
  } else if (platform === 'ios' && smokeAuthorities.length === 1) {
    pendingGatewaySmoke = Object.freeze({
      memberKind: 'derived',
      finalName: finalNameFor('derived'),
      observationSha256: smokeAuthorities[0].observationSha256,
      candidate: true,
    });
  }

  let activeObservation = null;
  if (databaseState.activeCommand !== null) {
    const active = databaseState.activeCommand;
    if (!isExactPlainRecord(active, [
      'captureId', 'expectedSequence', 'previousObservationSha256',
    ]) || active.captureId !== captureId ||
        !Number.isSafeInteger(active.expectedSequence) || active.expectedSequence < 1 ||
        active.expectedSequence > B3_CAPTURE_BUNDLE_LIMITS.maximumObservationFinals) {
      throw bundleError('B3 capture bundle active command slot is invalid');
    }
    if (active.expectedSequence !== observations.length + 1) {
      throw memberError('B3 capture bundle active command sequence is not current');
    }
    const previousIndex = active.expectedSequence - 2;
    const expectedPrevious = previousIndex < 0
      ? '0'.repeat(64)
      : observations[previousIndex]?.observationSha256;
    if (active.previousObservationSha256 !== expectedPrevious) {
      throw memberError('B3 capture bundle active command tail is not retained');
    }
    activeObservation = Object.freeze({
      memberKind: 'observations',
      finalName: finalNameFor('observations', active.expectedSequence),
      sequence: active.expectedSequence,
      candidate: true,
    });
  }

  const slots = [...observations, ...checkpoints];
  if (pendingCheckpoint) slots.push(pendingCheckpoint);
  if (gatewaySmoke) slots.push(gatewaySmoke);
  if (pendingGatewaySmoke) slots.push(pendingGatewaySmoke);
  const byTarget = new Map(slots.map((slot) => [
    `${slot.memberKind}/${slot.finalName}`, slot,
  ]));
  if (activeObservation && !byTarget.has(
    `${activeObservation.memberKind}/${activeObservation.finalName}`,
  )) {
    byTarget.set(
      `${activeObservation.memberKind}/${activeObservation.finalName}`,
      activeObservation,
    );
  }
  return Object.freeze({
    observations: Object.freeze(observations),
    checkpoints: Object.freeze(checkpoints),
    pendingCheckpoint,
    gatewaySmoke,
    pendingGatewaySmoke,
    activeObservation,
    byTarget,
  });
}

function assertStableDirectory(directory, label) {
  const current = lstatSync(directory.canonical);
  const retained = directory.metadata;
  if (!current.isDirectory() || current.isSymbolicLink() ||
      current.dev !== retained.dev || current.ino !== retained.ino ||
      current.mode !== retained.mode || current.nlink !== retained.nlink ||
      current.size !== retained.size || current.mtimeMs !== retained.mtimeMs ||
      current.ctimeMs !== retained.ctimeMs ||
      realpathSync(directory.canonical) !== directory.canonical) {
    throw bundleError(`B3 capture bundle ${label} directory changed during inventory`);
  }
}

function fixedEvidenceHierarchy() {
  let repositoryMetadata;
  try {
    repositoryMetadata = lstatSync(B3_CAPTURE_STATE_REPOSITORY_ROOT);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw bundleError('B3 capture bundle repository root is absent');
    }
    throw error;
  }
  const repositoryRoot = realpathSync(B3_CAPTURE_STATE_REPOSITORY_ROOT);
  if (!repositoryMetadata.isDirectory() || repositoryMetadata.isSymbolicLink() ||
      repositoryRoot !== B3_CAPTURE_STATE_REPOSITORY_ROOT) {
    throw bundleError('B3 capture bundle repository root is not canonical');
  }
  const repository = Object.freeze({
    canonical: repositoryRoot,
    metadata: repositoryMetadata,
  });
  const ancestors = [{ directory: repository, label: 'repository root' }];
  let parent = repository;
  for (const [component, label] of [
    ['.native-build', 'native build'],
    ['b3', 'B3'],
    ['evidence', 'evidence'],
  ]) {
    const literalPath = resolve(parent.canonical, component);
    const directory = exactDirectory(
      literalPath,
      label,
      parent.canonical,
      repositoryMetadata.dev,
    );
    if (directory.canonical !== literalPath) {
      throw bundleError(`B3 capture bundle ${label} directory is redirected`);
    }
    ancestors.push({ directory, label });
    parent = directory;
  }
  const hierarchy = Object.freeze({
    repositoryRoot,
    evidence: parent,
    ancestors: Object.freeze(ancestors.map((ancestor) => Object.freeze(ancestor))),
  });
  assertStableFixedEvidenceHierarchy(hierarchy);
  return hierarchy;
}

function assertStableFixedEvidenceHierarchy(hierarchy) {
  for (let index = hierarchy.ancestors.length - 1; index >= 0; index -= 1) {
    const { directory, label } = hierarchy.ancestors[index];
    assertStableDirectory(directory, label);
  }
}

function freezeRootState(value, authority) {
  const frozen = Object.freeze(value);
  ROOT_STATE_AUTHORITIES.set(frozen, Object.freeze(authority));
  return frozen;
}

function sameDirectoryIdentity(left, right) {
  const leftMetadata = left.metadata;
  const rightMetadata = right.metadata;
  return left.canonical === right.canonical &&
    leftMetadata.dev === rightMetadata.dev &&
    leftMetadata.ino === rightMetadata.ino &&
    leftMetadata.mode === rightMetadata.mode &&
    leftMetadata.nlink === rightMetadata.nlink &&
    leftMetadata.size === rightMetadata.size &&
    leftMetadata.mtimeMs === rightMetadata.mtimeMs &&
    leftMetadata.ctimeMs === rightMetadata.ctimeMs;
}

function assertSameRootStateAuthority(retained, observed) {
  if (!retained || !observed || retained.rootPath !== observed.rootPath ||
      retained.hierarchy.ancestors.length !== observed.hierarchy.ancestors.length ||
      Boolean(retained.bundles) !== Boolean(observed.bundles) ||
      Boolean(retained.working) !== Boolean(observed.working) ||
      retained.children.length !== observed.children.length) {
    throw bundleError('B3 capture bundle retained root authority changed');
  }
  for (let index = 0; index < retained.hierarchy.ancestors.length; index += 1) {
    const retainedAncestor = retained.hierarchy.ancestors[index];
    const observedAncestor = observed.hierarchy.ancestors[index];
    assertStableDirectory(retainedAncestor.directory, retainedAncestor.label);
    if (retainedAncestor.label !== observedAncestor.label ||
        !sameDirectoryIdentity(retainedAncestor.directory, observedAncestor.directory)) {
      throw bundleError('B3 capture bundle retained hierarchy identity changed');
    }
  }
  for (const [label, retainedDirectory, observedDirectory] of [
    ['root', retained.bundles, observed.bundles],
    ['working', retained.working, observed.working],
  ]) {
    if (!retainedDirectory) continue;
    assertStableDirectory(retainedDirectory, label);
    if (!sameDirectoryIdentity(retainedDirectory, observedDirectory)) {
      throw bundleError(`B3 capture bundle retained ${label} identity changed`);
    }
  }
  for (let index = 0; index < retained.children.length; index += 1) {
    const retainedChild = retained.children[index];
    const observedChild = observed.children[index];
    assertStableDirectory(retainedChild.directory, retainedChild.name);
    if (retainedChild.name !== observedChild.name ||
        !sameDirectoryIdentity(retainedChild.directory, observedChild.directory)) {
      throw bundleError('B3 capture bundle retained child identity changed');
    }
  }
}

function rootStateAuthority({
  hierarchy,
  rootPath,
  bundles = null,
  working = null,
  children = [],
}) {
  return Object.freeze({
    hierarchy,
    rootPath,
    bundles,
    working,
    children: Object.freeze(children.map((child) => Object.freeze(child))),
  });
}

export function classifyB3CaptureBundleRootState(input = {}) {
  if (!isExactPlainRecord(input, ['platform']) ||
      !['ios', 'android'].includes(input.platform)) {
    throw bundleError('B3 capture bundle root classification authority is invalid');
  }
  const { platform } = input;
  const hierarchy = fixedEvidenceHierarchy();
  const { evidence } = hierarchy;
  const rootPath = resolve(evidence.canonical, `${platform}-capture-bundles`);
  try {
    lstatSync(rootPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      assertStableFixedEvidenceHierarchy(hierarchy);
      return freezeRootState(
        { schemaVersion: 1, platform, kind: 'absent' },
        rootStateAuthority({ hierarchy, rootPath }),
      );
    }
    throw error;
  }
  const bundles = exactDirectory(
    rootPath, 'root', evidence.canonical, evidence.metadata.dev,
  );
  const rootEntries = readdirSync(bundles.canonical, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  assertStableDirectory(bundles, 'root');
  if (rootEntries.length === 0) {
    assertStableFixedEvidenceHierarchy(hierarchy);
    return freezeRootState(
      { schemaVersion: 1, platform, kind: 'empty' },
      rootStateAuthority({ hierarchy, rootPath, bundles }),
    );
  }
  const match = rootEntries.length === 1
    ? new RegExp(`^(?<captureId>${UUID_V4})\\.working$`, 'u').exec(rootEntries[0].name)
    : null;
  if (!match || !rootEntries[0].isDirectory()) {
    throw bundleError('B3 capture bundle root inventory is not structurally closed');
  }
  const captureId = assertCaptureId(match.groups.captureId);
  const working = exactDirectory(
    resolve(bundles.canonical, rootEntries[0].name),
    'working', bundles.canonical, bundles.metadata.dev,
  );
  const childNames = ['checkpoint', 'derived', 'observations'];
  const childEntries = readdirSync(working.canonical, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  assertStableDirectory(working, 'working');
  if (childEntries.some((entry) =>
    !childNames.includes(entry.name) || !entry.isDirectory())) {
    throw bundleError('B3 capture bundle child inventory is not structurally closed');
  }
  let isExactEmpty = true;
  const children = [];
  for (const entry of childEntries) {
    const child = exactDirectory(
      resolve(working.canonical, entry.name),
      entry.name, working.canonical, working.metadata.dev,
    );
    if (readdirSync(child.canonical).length !== 0) isExactEmpty = false;
    assertStableDirectory(child, entry.name);
    children.push({ name: entry.name, directory: child });
  }
  assertStableDirectory(working, 'working');
  assertStableDirectory(bundles, 'root');
  assertStableFixedEvidenceHierarchy(hierarchy);
  const presentChildren = Object.freeze(childEntries.map((entry) => entry.name));
  return freezeRootState(
    {
      schemaVersion: 1,
      platform,
      kind: presentChildren.length === childNames.length ? 'working' : 'partial-working',
      captureId,
      presentChildren,
      isExactEmpty,
    },
    rootStateAuthority({ hierarchy, rootPath, bundles, working, children }),
  );
}

export function validateB3CaptureBundleComposite(input = {}) {
  if (!isExactPlainRecord(input, ['databaseState', 'rootState']) ||
      !ROOT_STATE_AUTHORITIES.has(input.rootState)) {
    throw bundleError('B3 capture bundle composite validation authority is invalid');
  }
  const { databaseState, rootState } = input;
  if (!databaseState || typeof databaseState !== 'object' || Array.isArray(databaseState)) {
    throw bundleError('B3 capture bundle database state is invalid');
  }
  if (databaseState.kind === 'empty') {
    if (databaseState.startIntent !== null ||
        !['absent', 'empty'].includes(rootState.kind)) {
      throw bundleError('B3 capture bundle empty database pairing is invalid');
    }
    return Object.freeze({ kind: 'empty', platform: rootState.platform });
  }
  if (databaseState.kind === 'pending-initial') {
    const captureId = databaseState.startIntent?.captureId;
    assertCaptureId(captureId);
    if (['absent', 'empty'].includes(rootState.kind)) {
      return Object.freeze({
        kind: 'pending-empty',
        platform: rootState.platform,
        captureId,
        bundleState: rootState.kind,
      });
    }
    if (!['partial-working', 'working'].includes(rootState.kind) ||
        rootState.captureId !== captureId || !rootState.isExactEmpty) {
      throw bundleError('B3 capture bundle pending database pairing is invalid');
    }
    return Object.freeze({
      kind: 'pending-empty',
      platform: rootState.platform,
      captureId,
      bundleState: rootState.kind,
    });
  }
  if (databaseState.kind === 'ready-initial') {
    const captureId = databaseState.capture?.capture_id;
    assertCaptureId(captureId);
    if (rootState.kind !== 'working' || rootState.captureId !== captureId ||
        !rootState.isExactEmpty) {
      throw bundleError('B3 capture bundle ready database pairing is invalid');
    }
    return Object.freeze({
      kind: 'ready-empty',
      platform: rootState.platform,
      captureId,
    });
  }
  throw bundleError('B3 capture bundle database state is unsupported');
}

function fsyncExactDirectory(directory, label) {
  assertStableDirectory(directory, label);
  let descriptor;
  try {
    descriptor = openSync(
      directory.canonical,
      fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) |
        (fsConstants.O_NOFOLLOW ?? 0),
    );
    const opened = fstatSync(descriptor);
    if (!opened.isDirectory() || opened.dev !== directory.metadata.dev ||
        opened.ino !== directory.metadata.ino || opened.mode !== directory.metadata.mode) {
      throw bundleError(`B3 capture bundle ${label} sync authority differs`);
    }
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  assertStableDirectory(directory, label);
}

function refreshDirectoryAfterOwnedChildCreation(directory, label) {
  const refreshed = exactDirectory(
    directory.canonical,
    label,
    dirname(directory.canonical),
    directory.metadata.dev,
  );
  if (refreshed.canonical !== directory.canonical ||
      refreshed.metadata.ino !== directory.metadata.ino ||
      refreshed.metadata.mode !== directory.metadata.mode) {
    throw bundleError(
      `B3 capture bundle ${label} directory changed during owned child creation`,
    );
  }
  return refreshed;
}

function mkdirExactDirectory(path, label, parent, device) {
  const previousMask = process.umask(0o077);
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch {
    throw bundleError(`B3 capture bundle ${label} creation did not own an absent path`);
  } finally {
    process.umask(previousMask);
  }
  return exactDirectory(path, label, parent, device);
}

export function materialiseB3EmptyWorkingBundle(input = {}) {
  if (!isExactPlainRecord(input, ['platform', 'captureId', 'rootState']) ||
      !['ios', 'android'].includes(input.platform) ||
      !ROOT_STATE_AUTHORITIES.has(input.rootState)) {
    throw bundleError('B3 capture bundle materialisation authority is invalid');
  }
  const { platform, captureId: rawCaptureId, rootState } = input;
  const captureId = assertCaptureId(rawCaptureId);
  if (rootState.platform !== platform) {
    throw bundleError('B3 capture bundle materialisation platform differs');
  }
  const retainedAuthority = ROOT_STATE_AUTHORITIES.get(rootState);
  const current = classifyB3CaptureBundleRootState({ platform });
  if (!isDeepStrictEqual(current, rootState)) {
    throw bundleError('B3 capture bundle materialisation root state drifted');
  }
  const currentAuthority = ROOT_STATE_AUTHORITIES.get(current);
  assertSameRootStateAuthority(retainedAuthority, currentAuthority);
  if (!['absent', 'empty', 'partial-working', 'working'].includes(current.kind) ||
      (['partial-working', 'working'].includes(current.kind) &&
        (current.captureId !== captureId || !current.isExactEmpty))) {
    throw bundleError('B3 capture bundle materialisation state is invalid');
  }

  const hierarchy = retainedAuthority.hierarchy;
  let { evidence } = hierarchy;
  const bundlesPath = retainedAuthority.rootPath;
  let bundles = current.kind === 'absent'
    ? mkdirExactDirectory(
        bundlesPath, 'root', evidence.canonical, evidence.metadata.dev,
      )
    : retainedAuthority.bundles;
  if (current.kind === 'absent') {
    fsyncExactDirectory(bundles, 'root');
    evidence = refreshDirectoryAfterOwnedChildCreation(evidence, 'evidence');
    fsyncExactDirectory(evidence, 'evidence');
  }

  const workingPath = resolve(bundles.canonical, `${captureId}.working`);
  const hasWorking = ['partial-working', 'working'].includes(current.kind);
  let working = hasWorking
    ? retainedAuthority.working
    : mkdirExactDirectory(
        workingPath, 'working', bundles.canonical, bundles.metadata.dev,
      );
  if (!hasWorking) {
    fsyncExactDirectory(working, 'working');
    bundles = refreshDirectoryAfterOwnedChildCreation(bundles, 'root');
    fsyncExactDirectory(bundles, 'root');
  }

  const children = new Map(
    retainedAuthority.children.map((child) => [child.name, child.directory]),
  );
  for (const name of ['observations', 'checkpoint', 'derived']) {
    if (children.has(name)) {
      assertStableDirectory(children.get(name), name);
      continue;
    }
    const child = mkdirExactDirectory(
      resolve(working.canonical, name),
      name,
      working.canonical,
      working.metadata.dev,
    );
    children.set(name, child);
    fsyncExactDirectory(child, name);
    working = refreshDirectoryAfterOwnedChildCreation(working, 'working');
    fsyncExactDirectory(working, 'working');
  }
  for (const [name, child] of children) assertStableDirectory(child, name);
  fsyncExactDirectory(working, 'working');
  fsyncExactDirectory(bundles, 'root');
  for (const ancestor of hierarchy.ancestors.slice(0, -1)) {
    assertStableDirectory(ancestor.directory, ancestor.label);
  }
  assertStableDirectory(evidence, 'evidence');

  const materialised = classifyB3CaptureBundleRootState({ platform });
  if (materialised.kind !== 'working' || materialised.captureId !== captureId ||
      !materialised.isExactEmpty || !isDeepStrictEqual(
        materialised.presentChildren,
        Object.freeze(['checkpoint', 'derived', 'observations']),
      )) {
    throw bundleError('B3 capture bundle materialisation did not converge');
  }
  const expectedHierarchy = {
    ...hierarchy,
    evidence,
    ancestors: [
      ...hierarchy.ancestors.slice(0, -1),
      { directory: evidence, label: 'evidence' },
    ],
  };
  const expectedAuthority = rootStateAuthority({
    hierarchy: expectedHierarchy,
    rootPath: bundlesPath,
    bundles,
    working,
    children: ['checkpoint', 'derived', 'observations'].map((name) => ({
      name,
      directory: children.get(name),
    })),
  });
  assertSameRootStateAuthority(
    expectedAuthority,
    ROOT_STATE_AUTHORITIES.get(materialised),
  );
  return materialised;
}

function readSecureMember(path, parent, expectedDevice, { allowEmpty = false } = {}) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (['ELOOP', 'ENOENT'].includes(error?.code)) {
      throw memberError('B3 capture bundle member link or file is invalid');
    }
    throw error;
  }
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 ||
        (before.mode & 0o7777) !== 0o600 || before.dev !== expectedDevice ||
        before.size < (allowEmpty ? 0 : 1) ||
        before.size > B3_CAPTURE_BUNDLE_LIMITS.maximumMemberBytes) {
      throw memberError('B3 capture bundle member file policy is invalid');
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw memberError('B3 capture bundle member read was incomplete');
      offset += count;
    }
    const after = fstatSync(descriptor);
    let pathname;
    try {
      pathname = lstatSync(path);
    } catch {
      throw memberError('B3 capture bundle member pathname changed while being read');
    }
    const canonicalPath = realpathSync(path);
    if (!after.isFile() || after.nlink !== before.nlink || after.mode !== before.mode ||
        after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        !pathname.isFile() || pathname.isSymbolicLink() ||
        pathname.dev !== after.dev || pathname.ino !== after.ino ||
        pathname.mode !== after.mode || pathname.nlink !== after.nlink ||
        pathname.size !== after.size || pathname.mtimeMs !== after.mtimeMs ||
        pathname.ctimeMs !== after.ctimeMs || dirname(canonicalPath) !== parent) {
      throw memberError('B3 capture bundle member changed while being read');
    }
    return Object.freeze({
      bytes,
      metadata: before,
      sha256: sha256(bytes),
      canonicalPath,
    });
  } finally {
    closeSync(descriptor);
  }
}

export function inspectB3CaptureBundleInventory(input = {}) {
  if (!isExactPlainRecord(input, [
    'platform', 'captureId', 'databaseState', 'retainedDomain',
  ])) {
    throw bundleError('B3 capture bundle inventory authority is invalid');
  }
  const { platform, captureId: rawCaptureId, databaseState, retainedDomain } = input;
  if (!['ios', 'android'].includes(platform)) {
    throw bundleError('B3 capture bundle inventory authority is invalid');
  }
  const captureId = assertCaptureId(rawCaptureId);
  const composite = snapshotCompositeAuthority(
    platform, captureId, databaseState, retainedDomain,
  );
  const authorityByTarget = composite.byTarget;
  const hierarchy = fixedEvidenceHierarchy();
  const { repositoryRoot, evidence } = hierarchy;
  const bundles = exactDirectory(
    resolve(evidence.canonical, `${platform}-capture-bundles`),
    'root',
    evidence.canonical,
    evidence.metadata.dev,
  );
  const rootEntries = readdirSync(bundles.canonical, { withFileTypes: true });
  assertStableDirectory(bundles, 'root');
  const expectedWorkingName = `${captureId}.working`;
  if (rootEntries.length !== 1 || rootEntries[0].name !== expectedWorkingName ||
      !rootEntries[0].isDirectory()) {
    throw bundleError('B3 capture bundle root inventory is invalid');
  }
  const working = exactDirectory(
    resolve(bundles.canonical, expectedWorkingName),
    'working',
    bundles.canonical,
    bundles.metadata.dev,
  );
  const childEntries = readdirSync(working.canonical, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  assertStableDirectory(working, 'working');
  const childNames = ['checkpoint', 'derived', 'observations'];
  if (childEntries.length !== childNames.length || childEntries.some((entry, index) =>
    entry.name !== childNames[index] || !entry.isDirectory())) {
    throw bundleError('B3 capture bundle child inventory is invalid');
  }
  const namespace = Object.freeze({
    bundlesRoot: directorySnapshotIdentity(bundles, evidence.canonical, repositoryRoot),
    working: directorySnapshotIdentity(working, bundles.canonical, repositoryRoot),
  });
  const entries = [{
    relativePath: '.',
    type: 'directory',
    ...namespace.working,
  }];
  const retainedMembers = [];
  const childDirectories = [];
  for (const name of childNames) {
    const child = exactDirectory(
      resolve(working.canonical, name),
      name,
      working.canonical,
      working.metadata.dev,
    );
    const childMembers = readdirSync(child.canonical, { withFileTypes: true });
    assertStableDirectory(child, name);
    if (childMembers.some((entry) => !entry.isFile())) {
      throw memberError('B3 capture bundle member type is invalid');
    }
    entries.push({
      relativePath: name,
      type: 'directory',
      ...directorySnapshotIdentity(child, working.canonical, repositoryRoot),
    });
    childDirectories.push(Object.freeze({ name, directory: child }));
    for (const member of childMembers) {
      retainedMembers.push(Object.freeze({
        memberKind: name,
        name: member.name,
        parent: child.canonical,
        device: child.metadata.dev,
      }));
    }
  }
  const parsedMembers = retainedMembers.map((member) => Object.freeze({
    ...member,
    parsed: parseB3CaptureMemberName({
      platform,
      memberKind: member.memberKind,
      name: member.name,
    }),
    relativePath: `${member.memberKind}/${member.name}`,
  }));
  const temporaries = parsedMembers.filter(({ parsed }) => parsed.kind === 'temporary');
  if (temporaries.length > B3_CAPTURE_BUNDLE_LIMITS.maximumTemporaries) {
    throw memberError('B3 capture bundle temporary bound is exceeded');
  }
  const temporaryTargets = new Set();
  for (const { parsed } of temporaries) {
    const key = `${parsed.memberKind}/${parsed.finalName}`;
    if (temporaryTargets.has(key)) {
      throw memberError('B3 capture bundle target has multiple temporaries');
    }
    temporaryTargets.add(key);
  }
  const finalByTarget = new Map(parsedMembers
    .filter(({ parsed }) => parsed.kind === 'final')
    .map((member) => [`${member.parsed.memberKind}/${member.parsed.finalName}`, member]));
  const retainedFinalTargets = new Set([
    ...composite.observations,
    ...composite.checkpoints,
    ...(composite.gatewaySmoke ? [composite.gatewaySmoke] : []),
  ].map((slot) => `${slot.memberKind}/${slot.finalName}`));
  if (finalByTarget.size !== retainedFinalTargets.size ||
      [...retainedFinalTargets].some((target) => !finalByTarget.has(target))) {
    throw memberError('B3 capture bundle retained domain is not exactly materialised');
  }
  const actions = [];
  for (const member of parsedMembers.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath))) {
    const targetKey = `${member.parsed.memberKind}/${member.parsed.finalName}`;
    const authority = authorityByTarget.get(targetKey);
    const retainedAuthority = authority?.expectedLength !== undefined;
    if (!authority || (member.parsed.kind === 'temporary' && retainedAuthority && (
      member.parsed.expectedLength !== authority.expectedLength ||
      member.parsed.expectedSha256 !== authority.expectedSha256
    )) || (member.parsed.kind === 'final' && !retainedAuthority)) {
      throw memberError('B3 capture bundle member has no retained domain authority');
    }
    const retained = readSecureMember(
      resolve(member.parent, member.name),
      member.parent,
      member.device,
      { allowEmpty: member.parsed.kind === 'temporary' },
    );
    if (member.parsed.kind === 'final') {
      if (retained.bytes.length !== authority.expectedLength ||
          retained.sha256 !== authority.expectedSha256) {
        throw memberError('B3 capture bundle final member conflicts');
      }
    } else {
      const expectedLength = retainedAuthority
        ? authority.expectedLength
        : member.parsed.expectedLength;
      const expectedSha256 = retainedAuthority
        ? authority.expectedSha256
        : member.parsed.expectedSha256;
      if (retained.bytes.length > expectedLength ||
          (retained.bytes.length === expectedLength &&
            retained.sha256 !== expectedSha256)) {
        throw memberError('B3 capture bundle temporary bytes conflict');
      }
      const final = finalByTarget.get(targetKey);
      actions.push(Object.freeze({
        kind: final
          ? (retained.bytes.length === expectedLength
              ? 'remove-redundant-temporary'
              : 'remove-incomplete-temporary')
          : (!retainedAuthority && retained.bytes.length === expectedLength
              ? 'validate-complete-temporary'
              : (retained.bytes.length < expectedLength
                  ? 'remove-incomplete-temporary'
                  : 'adopt-complete-temporary')),
        memberKind: member.parsed.memberKind,
        temporaryRelativePath: member.relativePath,
        finalRelativePath: `${member.parsed.memberKind}/${member.parsed.finalName}`,
        expectedLength,
        expectedSha256,
      }));
    }
    entries.push(Object.freeze({
      relativePath: member.relativePath,
      type: 'file',
      mode: 0o600,
      nlink: 1,
      dev: retained.metadata.dev,
      ino: retained.metadata.ino,
      size: retained.bytes.length,
      sha256: retained.sha256,
      canonicalPathSha256: canonicalPathSha256(
        repositoryRoot, retained.canonicalPath, 'canonical-path',
      ),
      parentPathSha256: canonicalPathSha256(
        repositoryRoot, member.parent, 'canonical-parent',
      ),
    }));
  }
  const observationFinals = parsedMembers.filter(({ parsed }) =>
    parsed.kind === 'final' && parsed.memberKind === 'observations')
    .sort((left, right) => left.parsed.sequence - right.parsed.sequence);
  const checkpointFinals = parsedMembers.filter(({ parsed }) =>
    parsed.kind === 'final' && parsed.memberKind === 'checkpoint')
    .sort((left, right) => left.parsed.revision - right.parsed.revision);
  if (observationFinals.length > B3_CAPTURE_BUNDLE_LIMITS.maximumObservationFinals ||
      checkpointFinals.length > B3_CAPTURE_BUNDLE_LIMITS.maximumCheckpointFinals ||
      observationFinals.some(({ parsed }, index) => parsed.sequence !== index + 1) ||
      checkpointFinals.some(({ parsed }, index) => parsed.revision !== index) ||
      ![observationFinals.length, observationFinals.length - 1]
        .includes(checkpointFinals.length)) {
    throw memberError('B3 capture bundle final member bound is exceeded');
  }
  for (const { name, directory } of childDirectories) {
    assertStableDirectory(directory, name);
  }
  assertStableDirectory(working, 'working');
  assertStableDirectory(bundles, 'root');
  assertStableFixedEvidenceHierarchy(hierarchy);
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const unsigned = Object.freeze({
    schemaVersion: 1,
    platform,
    captureId,
    bundleState: 'working',
    sameDevice: true,
    sameParent: true,
    namespace,
    entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
  });
  return Object.freeze({
    ...unsigned,
    snapshotSha256: snapshotSha256(unsigned),
    actions: Object.freeze(actions),
  });
}
