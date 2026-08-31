import fullAudioManifest from '../../config/full-audio-manifest.json' with { type: 'json' };
import { loadFullSpellingCatalogue } from '../domain/spelling/index.js';
import { createInstalledShardAudio } from './installed-shard-audio.js';
import { createProductAudioPlayer } from './product-audio-player.js';

// Entitled composition: the Full catalogue player served entirely from
// installed shard packs. The bundled Full audio and its unconditional grant
// were removed in E2.5; a device without the installed shards keeps the
// Starter-only player from create-product-app-services. The E2.7 composition
// slice owns switching between the two when the entitlement state changes.
export function createFullProductAudioPlayer({
  installedAudio,
  audioFactory,
  partition,
  onSpeechStarted,
  onSpeechEnded,
} = {}) {
  const shardAudio = createInstalledShardAudio({
    installedAudio,
    ...(partition ? { partition } : {}),
  });
  const player = createProductAudioPlayer({
    catalogue: loadFullSpellingCatalogue(),
    installedAudio: shardAudio,
    ...(audioFactory ? { audioFactory } : {}),
    ...(typeof onSpeechStarted === 'function' ? { onSpeechStarted } : {}),
    ...(typeof onSpeechEnded === 'function' ? { onSpeechEnded } : {}),
    audioEvidence: fullAudioManifest,
  });
  return Object.freeze({
    ...player,
    requiredPacks: shardAudio.requiredPacks,
  });
}
