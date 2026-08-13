import shardPartition from '../../config/full-ks2-shard-partition.json' with { type: 'json' };

const IDENTITY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_VERSION = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

function shardAudioError() {
  const error = new Error('Installed shard audio is unavailable.');
  error.code = 'installed_shard_audio_unavailable';
  return error;
}

function requireShardTable(partition) {
  if (
    partition?.schemaVersion !== 1 ||
    partition.catalogueId !== 'ks2-core:full' ||
    !Array.isArray(partition.shards) ||
    partition.shards.length !== partition.shardCount ||
    partition.shardCount < 1
  ) {
    throw new TypeError('Full shard partition document is invalid.');
  }
  const shardByItemId = new Map();
  const requiredPacks = [];
  for (const shard of partition.shards) {
    if (
      typeof shard?.packId !== 'string' ||
      !IDENTITY.test(shard.packId) ||
      typeof shard.version !== 'string' ||
      !SAFE_VERSION.test(shard.version) ||
      !Array.isArray(shard.items) ||
      shard.items.length === 0
    ) {
      throw new TypeError('Full shard partition names an invalid shard.');
    }
    requiredPacks.push(Object.freeze({
      packId: shard.packId,
      version: shard.version,
    }));
    for (const itemId of shard.items) {
      if (typeof itemId !== 'string' || shardByItemId.has(itemId)) {
        throw new TypeError('Full shard partition items must be unique strings.');
      }
      shardByItemId.set(itemId, requiredPacks[requiredPacks.length - 1]);
    }
  }
  return { shardByItemId, requiredPacks: Object.freeze(requiredPacks) };
}

// Routes the player's installed-audio requests to the shard pack that owns the
// asset. The request shape is exactly the bundled source's; only the pack
// identity is rewritten, because the player addresses the catalogue
// ('ks2-core') while payloads install as full-ks2-shard-NN packs.
export function createInstalledShardAudio({
  installedAudio,
  partition = shardPartition,
} = {}) {
  if (typeof installedAudio?.readInstalledAudio !== 'function') {
    throw new TypeError('installedAudio.readInstalledAudio must be a function.');
  }
  const { shardByItemId, requiredPacks } = requireShardTable(partition);
  return Object.freeze({
    requiredPacks,
    async readInstalledAudio(request) {
      const segments = typeof request?.assetPath === 'string'
        ? request.assetPath.split('/')
        : [];
      const shard = segments.length === 4 && segments[0] === 'audio'
        ? shardByItemId.get(segments[2]) ?? null
        : null;
      if (!shard) throw shardAudioError();
      return installedAudio.readInstalledAudio({
        packId: shard.packId,
        version: shard.version,
        assetPath: request.assetPath,
        sha256: request.sha256,
        byteSize: request.byteSize,
      });
    },
  });
}
