import { createRuntimeItemId, normaliseSpellingTarget, parseRuntimeItemId } from './identity.js';

export const PACK_MANIFEST_SCHEMA_VERSION = 1;
export const SUPPORTED_CONTENT_SCHEMA_VERSION = 1;
export const SUPPORTED_RUNTIME_SCHEMA_VERSION = 1;
export const SUPPORTED_APP_VERSION = '1.0.0';
export const MOBILE_AUDIO_PROFILES = Object.freeze(['Iapetus', 'Sulafat']);
export const MOBILE_AUDIO_KINDS = Object.freeze(['word-natural', 'dictation-normal', 'dictation-slow']);

const MANIFEST_KEYS = new Set([
  'schemaVersion', 'packId', 'contentVersion', 'contentSchemaVersion',
  'minimumAppVersion', 'minimumSchemaVersion', 'entitlementIds', 'catalogueIds',
  'itemInventory', 'rewardTracks', 'monsterDefinitions', 'archives', 'audioAssets',
  'installedByteSize', 'stagingMetadataByteSize', 'temporaryByteSize',
  'releasedAt', 'signingKeyId',
]);
const SEMVER = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const SAFE_FILE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;
const EXECUTABLE_EXTENSION = /\.(?:js|mjs|cjs|html?|wasm|so|dylib|dll|exe|sh)$/i;
const ARCHIVE_MEMBER_MEDIA = Object.freeze({
  catalogue: 'application/json',
  audio: 'audio/mp4',
  'monster-image': 'image/webp',
});
const MONSTER_RENDERERS = new Set(['static-stage']);
const MONSTER_EFFECTS = new Set(['stage-celebration']);
const ID_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CATALOGUE_KEYS = new Set([
  'schemaVersion', 'catalogueId', 'packId', 'entitlementIds',
  'rewardTracks', 'audio', 'items',
]);
const ITEM_KEYS = new Set([
  'runtimeItemId', 'packId', 'itemId', 'legacySlug', 'target', 'accepted',
  'yearBand', 'yearLabel', 'family', 'familyWords', 'sentencePrompts',
  'explanation', 'patternIds', 'coverageTier',
]);

function isCanonicalIdSegment(value) {
  return typeof value === 'string' && ID_SEGMENT.test(value);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`Unknown ${label} key: ${key}.`);
  }
}

function positiveInteger(value, label, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new TypeError(`${label} must be a safe integer.`);
  return value;
}

function compareSemver(left, right) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function isIsoTimestamp(value) {
  const match = typeof value === 'string' ? ISO_TIMESTAMP.exec(value) : null;
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1];
}

export function validateRewardTrackV1(value) {
  const track = object(value, 'Reward track');
  exactKeys(track, new Set(['rewardTrackId', 'packId', 'monsterId', 'yearBand', 'sourceRewardTrackIds', 'thresholds', 'releaseScope']), 'reward track');
  for (const [name, identifier] of [['rewardTrackId', track.rewardTrackId], ['packId', track.packId], ['monsterId', track.monsterId]]) {
    if (!isCanonicalIdSegment(identifier)) throw new TypeError(`${name} must be canonical.`);
  }
  const thresholds = track.thresholds?.map((entry) => positiveInteger(entry, 'Reward threshold')) || [];
  if (!thresholds.length || thresholds.some((entry, index) => index > 0 && entry <= thresholds[index - 1])) {
    throw new TypeError('Reward thresholds must be non-empty and strictly increasing.');
  }
  const sourceRewardTrackIds = track.sourceRewardTrackIds === undefined ? [] : track.sourceRewardTrackIds;
  if (!Array.isArray(sourceRewardTrackIds)
      || new Set(sourceRewardTrackIds).size !== sourceRewardTrackIds.length
      || sourceRewardTrackIds.some((identifier) => !isCanonicalIdSegment(identifier) || identifier === track.rewardTrackId)) {
    throw new TypeError('sourceRewardTrackIds must be unique canonical IDs and cannot self-reference.');
  }
  return structuredClone({
    ...track,
    thresholds,
    ...(track.sourceRewardTrackIds === undefined ? {} : { sourceRewardTrackIds }),
  });
}

export function createAudioKeyV1({ runtimeItemId, sentenceId, voiceId, pace, audioKind } = {}) {
  parseRuntimeItemId(runtimeItemId);
  if (!MOBILE_AUDIO_PROFILES.includes(voiceId)) throw new TypeError('voiceId is not approved.');
  if (!['natural', 'normal', 'slow'].includes(pace)) throw new TypeError('pace is not approved.');
  if (!MOBILE_AUDIO_KINDS.includes(audioKind)) throw new TypeError('audioKind is not approved.');
  const expectedPace = audioKind === 'dictation-slow' ? 'slow' : audioKind === 'dictation-normal' ? 'normal' : 'natural';
  if (pace !== expectedPace) throw new TypeError('pace does not match audioKind.');
  const expectedSentenceId = audioKind === 'word-natural'
    ? sentenceId === 'word'
    : /^sentence-[1-9]\d*$/.test(sentenceId);
  if (!expectedSentenceId) throw new TypeError('sentenceId does not match audioKind.');
  return [runtimeItemId, sentenceId, voiceId, pace, audioKind].join('|');
}

export function validatePackManifestV1(value) {
  const manifest = object(value, 'Pack manifest');
  exactKeys(manifest, MANIFEST_KEYS, 'manifest');
  if (manifest.schemaVersion !== PACK_MANIFEST_SCHEMA_VERSION) throw new TypeError('Unsupported pack manifest schema version.');
  if (!isCanonicalIdSegment(manifest.packId) || !isCanonicalIdSegment(manifest.signingKeyId)) throw new TypeError('Pack and signing key IDs must be canonical.');
  if (!SEMVER.test(manifest.contentVersion) || !SEMVER.test(manifest.minimumAppVersion)) throw new TypeError('Pack versions must use semantic versioning.');
  positiveInteger(manifest.contentSchemaVersion, 'contentSchemaVersion');
  positiveInteger(manifest.minimumSchemaVersion, 'minimumSchemaVersion');
  if (manifest.contentSchemaVersion !== SUPPORTED_CONTENT_SCHEMA_VERSION
      || manifest.minimumSchemaVersion > SUPPORTED_RUNTIME_SCHEMA_VERSION
      || compareSemver(manifest.minimumAppVersion, SUPPORTED_APP_VERSION) > 0) {
    throw new TypeError('Pack requires an unsupported content, runtime or application schema version.');
  }
  for (const name of ['entitlementIds', 'catalogueIds']) {
    if (!Array.isArray(manifest[name]) || new Set(manifest[name]).size !== manifest[name].length) {
      throw new TypeError(`${name} must be a unique array.`);
    }
  }
  if (manifest.entitlementIds.some((identifier) => !isCanonicalIdSegment(identifier))) throw new TypeError('Entitlement IDs must be canonical.');
  if (manifest.catalogueIds.some((identifier) => parseRuntimeItemId(identifier).packId !== manifest.packId)) {
    throw new TypeError('Catalogue IDs must use the manifest pack namespace.');
  }
  if (!Array.isArray(manifest.itemInventory) || !manifest.itemInventory.length) throw new TypeError('Item inventory must be non-empty.');
  const itemInventory = manifest.itemInventory.map((entry) => {
    exactKeys(object(entry, 'Item inventory entry'), new Set(['runtimeItemId', 'sentenceIds']), 'item inventory');
    const identity = parseRuntimeItemId(entry.runtimeItemId);
    if (identity.packId !== manifest.packId
        || !Array.isArray(entry.sentenceIds) || !entry.sentenceIds.length
        || new Set(entry.sentenceIds).size !== entry.sentenceIds.length
        || entry.sentenceIds.some((sentenceId, index) => sentenceId !== `sentence-${index + 1}`)) {
      throw new TypeError('Item inventory identity and sentence IDs must be canonical.');
    }
    return { runtimeItemId: entry.runtimeItemId, sentenceIds: [...entry.sentenceIds] };
  });
  const inventoryIds = new Set(itemInventory.map(({ runtimeItemId }) => runtimeItemId));
  if (inventoryIds.size !== itemInventory.length) throw new TypeError('Item inventory IDs must be unique.');
  if (!Array.isArray(manifest.rewardTracks) || !manifest.rewardTracks.length) throw new TypeError('Pack reward tracks must be non-empty.');
  const rewardTracks = manifest.rewardTracks.map(validateRewardTrackV1);
  if (rewardTracks.some((track) => track.packId !== manifest.packId)) throw new TypeError('Reward tracks must use the manifest pack namespace.');
  const rewardTrackIds = new Set(rewardTracks.map(({ rewardTrackId }) => rewardTrackId));
  if (rewardTrackIds.size !== rewardTracks.length
      || rewardTracks.some((track) => track.sourceRewardTrackIds?.some((identifier) => !rewardTrackIds.has(identifier)))) {
    throw new TypeError('Reward track IDs must be unique and aggregate source tracks must exist in the same manifest.');
  }
  if (!Array.isArray(manifest.monsterDefinitions) || !manifest.monsterDefinitions.length) throw new TypeError('Pack monster definitions must be non-empty.');
  const monsterDefinitions = manifest.monsterDefinitions.map((definition) => {
    const monster = object(definition, 'Monster definition');
    exactKeys(monster, new Set(['monsterId', 'rewardTrackIds', 'name', 'blurb', 'colours', 'rendererId', 'effectId', 'stages']), 'monster definition');
    if (!isCanonicalIdSegment(monster.monsterId)
        || !MONSTER_RENDERERS.has(monster.rendererId)
        || !MONSTER_EFFECTS.has(monster.effectId)
        || typeof monster.name !== 'string' || !monster.name.trim()
        || typeof monster.blurb !== 'string' || !monster.blurb.trim()) {
      throw new TypeError('Monster identity, copy, renderer and effect must be declarative and allow-listed.');
    }
    exactKeys(object(monster.colours, 'Monster colours'), new Set(['accent', 'secondary', 'pale']), 'monster colours');
    if (Object.values(monster.colours).some((colour) => !/^#[A-F0-9]{6}$/i.test(colour))) throw new TypeError('Monster colours must be six-digit hex values.');
    if (!Array.isArray(monster.rewardTrackIds) || !monster.rewardTrackIds.length
        || new Set(monster.rewardTrackIds).size !== monster.rewardTrackIds.length
        || monster.rewardTrackIds.some((identifier) => {
          const track = rewardTracks.find(({ rewardTrackId }) => rewardTrackId === identifier);
          return !track || track.monsterId !== monster.monsterId;
        })) {
      throw new TypeError('Monster reward-track references must exist in the same manifest.');
    }
    if (!Array.isArray(monster.stages) || !monster.stages.length) throw new TypeError('Monster stages must be non-empty.');
    const stages = monster.stages.map((stage, index) => {
      exactKeys(object(stage, 'Monster stage'), new Set(['stageId', 'name', 'assetPath']), 'monster stage');
      if (stage.stageId !== `stage-${index}` || typeof stage.name !== 'string' || !stage.name.trim()
          || !SAFE_FILE.test(stage.assetPath) || !stage.assetPath.endsWith('.webp')) {
        throw new TypeError('Monster stages must be ordered declarative WebP assets.');
      }
      return { ...stage };
    });
    if (monster.rewardTrackIds.some((identifier) => rewardTracks.find(({ rewardTrackId }) => rewardTrackId === identifier)?.thresholds.length !== stages.length)) {
      throw new TypeError('Monster stage count must match every referenced reward track.');
    }
    return structuredClone({ ...monster, stages });
  });
  if (new Set(monsterDefinitions.map(({ monsterId }) => monsterId)).size !== monsterDefinitions.length
      || rewardTracks.some((track) => !monsterDefinitions.some((monster) => monster.monsterId === track.monsterId))) {
    throw new TypeError('Every reward track must reference one unique manifest monster.');
  }
  const assignedRewardTrackIds = monsterDefinitions.flatMap(({ rewardTrackIds }) => rewardTrackIds);
  if (new Set(assignedRewardTrackIds).size !== assignedRewardTrackIds.length
      || assignedRewardTrackIds.length !== rewardTracks.length
      || rewardTracks.some(({ rewardTrackId }) => !assignedRewardTrackIds.includes(rewardTrackId))) {
    throw new TypeError('Every reward track must appear exactly once in its matching monster definition.');
  }
  if (!Array.isArray(manifest.archives) || !manifest.archives.length) throw new TypeError('Pack archives must be non-empty.');
  const archives = manifest.archives.map((archive) => {
    exactKeys(object(archive, 'Archive'), new Set(['archiveName', 'byteSize', 'extractedByteSize', 'sha256', 'members']), 'archive');
    if (!SAFE_FILE.test(archive.archiveName) || EXECUTABLE_EXTENSION.test(archive.archiveName)) throw new TypeError('Archive path is unsafe or executable.');
    positiveInteger(archive.byteSize, 'archive byteSize');
    positiveInteger(archive.extractedByteSize, 'archive extractedByteSize');
    if (!SHA256.test(archive.sha256)) throw new TypeError('Archive SHA-256 must be lower-case hexadecimal.');
    if (!Array.isArray(archive.members) || !archive.members.length) throw new TypeError('Archive members must be non-empty.');
    const members = archive.members.map((member) => {
      exactKeys(object(member, 'Archive member'), new Set(['path', 'kind', 'mediaType', 'byteSize', 'sha256']), 'archive member');
      if (!Object.hasOwn(ARCHIVE_MEMBER_MEDIA, member.kind)
          || ARCHIVE_MEMBER_MEDIA[member.kind] !== member.mediaType
          || !SAFE_FILE.test(member.path) || EXECUTABLE_EXTENSION.test(member.path)) {
        throw new TypeError('Archive member violates the data-only allow-list.');
      }
      positiveInteger(member.byteSize, 'archive member byteSize');
      if (!SHA256.test(member.sha256)) throw new TypeError('Archive member SHA-256 must be lower-case hexadecimal.');
      return { ...member };
    });
    if (new Set(members.map(({ path }) => path)).size !== members.length) throw new TypeError('Archive member paths must be unique.');
    if (members.reduce((total, member) => total + member.byteSize, 0) !== archive.extractedByteSize) throw new TypeError('Archive extractedByteSize must equal its member inventory.');
    return { ...archive, members };
  });
  if (new Set(archives.map(({ archiveName }) => archiveName)).size !== archives.length) throw new TypeError('Archive names must be unique.');
  const audioKeys = new Set();
  const allArchiveMembers = archives.flatMap(({ members }) => members);
  const archiveMembersByPath = new Map(allArchiveMembers.map((member) => [member.path, member]));
  if (archiveMembersByPath.size !== allArchiveMembers.length) throw new TypeError('Archive member paths must be globally unique.');
  const audioAssets = manifest.audioAssets.map((asset) => {
    exactKeys(object(asset, 'Audio asset'), new Set(['audioKey', 'assetPath', 'byteSize', 'sha256']), 'audio asset');
    const [runtimeItemId, sentenceId, voiceId, pace, audioKind, ...extra] = String(asset.audioKey).split('|');
    if (extra.length || createAudioKeyV1({ runtimeItemId, sentenceId, voiceId, pace, audioKind }) !== asset.audioKey) {
      throw new TypeError('Audio asset key must be canonical.');
    }
    if (!inventoryIds.has(runtimeItemId)) throw new TypeError('Audio asset references an item outside the manifest inventory.');
    if (!SAFE_FILE.test(asset.assetPath) || EXECUTABLE_EXTENSION.test(asset.assetPath)) throw new TypeError('Audio asset path is unsafe or executable.');
    positiveInteger(asset.byteSize, 'audio asset byteSize');
    if (!SHA256.test(asset.sha256)) throw new TypeError('Audio asset SHA-256 must be lower-case hexadecimal.');
    if (audioKeys.has(asset.audioKey)) throw new TypeError('Audio asset keys must be unique.');
    audioKeys.add(asset.audioKey);
    const member = archiveMembersByPath.get(asset.assetPath);
    if (!member || member.kind !== 'audio' || member.byteSize !== asset.byteSize || member.sha256 !== asset.sha256) {
      throw new TypeError('Audio asset must match one digest-bearing archive member.');
    }
    return { ...asset };
  });
  const expectedAudioKeys = new Set(itemInventory.flatMap(({ runtimeItemId, sentenceIds }) =>
    MOBILE_AUDIO_PROFILES.flatMap((voiceId) => [
      createAudioKeyV1({ runtimeItemId, sentenceId: 'word', voiceId, pace: 'natural', audioKind: 'word-natural' }),
      ...sentenceIds.flatMap((sentenceId) => [
        createAudioKeyV1({ runtimeItemId, sentenceId, voiceId, pace: 'normal', audioKind: 'dictation-normal' }),
        createAudioKeyV1({ runtimeItemId, sentenceId, voiceId, pace: 'slow', audioKind: 'dictation-slow' }),
      ]),
    ])));
  if (audioKeys.size !== expectedAudioKeys.size || [...expectedAudioKeys].some((key) => !audioKeys.has(key))) {
    throw new TypeError('Pack manifest must contain the complete audio matrix.');
  }
  for (const monster of monsterDefinitions) {
    for (const stage of monster.stages) {
      if (archiveMembersByPath.get(stage.assetPath)?.kind !== 'monster-image') throw new TypeError('Monster stage asset must exist in the archive inventory.');
    }
  }
  positiveInteger(manifest.installedByteSize, 'installedByteSize');
  positiveInteger(manifest.stagingMetadataByteSize, 'stagingMetadataByteSize', { allowZero: true });
  positiveInteger(manifest.temporaryByteSize, 'temporaryByteSize');
  const compressedByteSize = archives.reduce((total, archive) => total + archive.byteSize, 0);
  const extractedByteSize = archives.reduce((total, archive) => total + archive.extractedByteSize, 0);
  const preflightBaseByteSize = compressedByteSize + extractedByteSize + manifest.stagingMetadataByteSize;
  const requiredTemporaryByteSize = preflightBaseByteSize + Math.ceil(preflightBaseByteSize * 0.1);
  if (manifest.installedByteSize !== extractedByteSize
      || manifest.temporaryByteSize !== requiredTemporaryByteSize) {
    throw new TypeError('Installed and temporary byte requirements must use compressed plus extracted plus staging bytes and 10% overhead.');
  }
  if (!isIsoTimestamp(manifest.releasedAt)) throw new TypeError('releasedAt must be ISO-compatible.');
  return structuredClone({ ...manifest, itemInventory, rewardTracks, monsterDefinitions, archives, audioAssets });
}

export function validateCatalogueV1(value) {
  const catalogue = object(value, 'Catalogue');
  exactKeys(catalogue, CATALOGUE_KEYS, 'catalogue');
  if (catalogue.schemaVersion !== 1) throw new TypeError('Unsupported catalogue schema version.');
  const catalogueIdentity = parseRuntimeItemId(catalogue.catalogueId);
  if (catalogueIdentity.packId !== catalogue.packId) throw new TypeError('catalogueId pack namespace must match packId.');
  if (!Array.isArray(catalogue.entitlementIds) || new Set(catalogue.entitlementIds).size !== catalogue.entitlementIds.length) {
    throw new TypeError('entitlementIds must be a unique array.');
  }
  const rewardTracks = catalogue.rewardTracks.map(validateRewardTrackV1);
  if (rewardTracks.some((track) => track.packId !== catalogue.packId)) throw new TypeError('Reward track packId must match its catalogue.');
  const rewardTrackIds = new Set(rewardTracks.map(({ rewardTrackId }) => rewardTrackId));
  if (rewardTrackIds.size !== rewardTracks.length
      || rewardTracks.some((track) => track.sourceRewardTrackIds?.some((identifier) => !rewardTrackIds.has(identifier)))) {
    throw new TypeError('Catalogue reward tracks must be unique and contain their aggregate source tracks.');
  }

  const audio = object(catalogue.audio, 'Catalogue audio');
  exactKeys(audio, new Set(['profiles', 'kinds', 'fallback', 'requiredAssetCount']), 'catalogue audio');
  if (audio.fallback !== null) throw new TypeError('Scored mobile audio fallback must be null.');
  if (JSON.stringify(audio.profiles) !== JSON.stringify(MOBILE_AUDIO_PROFILES)
      || JSON.stringify(audio.kinds) !== JSON.stringify(MOBILE_AUDIO_KINDS)) {
    throw new TypeError('Catalogue audio allow-lists must be complete and ordered.');
  }
  positiveInteger(audio.requiredAssetCount, 'Catalogue audio requiredAssetCount');

  const seenItemIds = new Set();
  const seenRuntimeIds = new Set();
  const seenLegacySlugs = new Set();
  const items = catalogue.items.map((rawItem) => {
    const item = object(rawItem, 'Catalogue item');
    exactKeys(item, ITEM_KEYS, 'catalogue item');
    const expectedRuntimeItemId = createRuntimeItemId(catalogue.packId, item.itemId);
    if (item.packId !== catalogue.packId || item.runtimeItemId !== expectedRuntimeItemId) {
      throw new TypeError('Catalogue item identity does not match its pack namespace.');
    }
    if (typeof item.legacySlug !== 'string' || !item.legacySlug.trim()) throw new TypeError('legacySlug must be non-empty.');
    if (seenItemIds.has(item.itemId) || seenRuntimeIds.has(item.runtimeItemId) || seenLegacySlugs.has(item.legacySlug)) {
      throw new TypeError('Catalogue item IDs and legacy slugs must be unique.');
    }
    seenItemIds.add(item.itemId);
    seenRuntimeIds.add(item.runtimeItemId);
    seenLegacySlugs.add(item.legacySlug);
    normaliseSpellingTarget(item.target);
    if (typeof item.yearLabel !== 'string' || !item.yearLabel.trim()
        || !Array.isArray(item.familyWords) || !item.familyWords.length
        || item.familyWords.some((entry) => typeof entry !== 'string' || !entry.trim())) {
      throw new TypeError('yearLabel and familyWords must retain A1-visible content metadata.');
    }
    if (!Array.isArray(item.accepted) || !item.accepted.length) throw new TypeError('accepted must be non-empty.');
    item.accepted.forEach(normaliseSpellingTarget);
    if (!Array.isArray(item.sentencePrompts) || !item.sentencePrompts.length) throw new TypeError('sentencePrompts must be non-empty.');
    const sentenceIds = new Set();
    item.sentencePrompts.forEach((prompt, index) => {
      exactKeys(object(prompt, 'Sentence prompt'), new Set(['sentenceId', 'text']), 'sentence prompt');
      if (prompt.sentenceId !== `sentence-${index + 1}` || sentenceIds.has(prompt.sentenceId) || typeof prompt.text !== 'string' || !prompt.text.trim()) {
        throw new TypeError('Sentence prompts must have unique sequential IDs and non-empty text.');
      }
      sentenceIds.add(prompt.sentenceId);
    });
    return structuredClone(item);
  });
  const expectedAudioAssetCount = items.reduce(
    (total, item) => total + (MOBILE_AUDIO_PROFILES.length
      * (1 + (item.sentencePrompts.length * 2))),
    0,
  );
  if (audio.requiredAssetCount !== expectedAudioAssetCount) {
    throw new TypeError(`Catalogue audio requires exactly ${expectedAudioAssetCount} assets.`);
  }
  assertNoDuplicateActiveTargets([{ ...catalogue, items }]);
  return structuredClone({ ...catalogue, rewardTracks, audio, items });
}

export function assertNoDuplicateActiveTargets(catalogues) {
  const ownerByTarget = new Map();
  for (const catalogue of catalogues) {
    for (const item of catalogue.items || []) {
      const target = normaliseSpellingTarget(item.target);
      const previous = ownerByTarget.get(target);
      if (previous && previous !== item.runtimeItemId) {
        throw new TypeError(`Duplicate active spelling target: ${previous} and ${item.runtimeItemId}.`);
      }
      ownerByTarget.set(target, item.runtimeItemId);
    }
  }
  return true;
}
