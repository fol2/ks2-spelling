import { parseRuntimeItemId, validateRewardTrackV1 } from '../index.js';

const ID_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function validateInputs({ learnerId, progress, rewardTracks, items, currentState, random }) {
  if (typeof learnerId !== 'string' || !ID_SEGMENT.test(learnerId)) {
    throw new TypeError('Monster projection learnerId must be canonical.');
  }
  const progressMap = record(progress, 'Monster projection progress');
  const state = record(currentState, 'Monster projection currentState');
  if (!Array.isArray(rewardTracks) || !rewardTracks.length) {
    throw new TypeError('Monster projection rewardTracks must be a non-empty array.');
  }
  if (!Array.isArray(items)) throw new TypeError('Monster projection items must be an array.');
  if (typeof random !== 'function') throw new TypeError('Monster projection requires random().');

  const tracks = rewardTracks.map(validateRewardTrackV1);
  const trackIds = tracks.map(({ rewardTrackId }) => rewardTrackId);
  if (new Set(trackIds).size !== trackIds.length) throw new TypeError('Monster projection has a duplicate reward track.');
  const packIds = new Set(tracks.map(({ packId }) => packId));
  if (packIds.size !== 1) throw new TypeError('Monster projection reward tracks must share the same pack.');
  const [packId] = packIds;
  const trackById = new Map(tracks.map((track) => [track.rewardTrackId, track]));
  for (const track of tracks) {
    const sources = track.sourceRewardTrackIds || [];
    if (sources.length === 0 && (typeof track.yearBand !== 'string' || !track.yearBand)) {
      throw new TypeError(`Direct reward track ${track.rewardTrackId} is missing yearBand.`);
    }
    if (sources.length > 0 && track.yearBand !== undefined) {
      throw new TypeError(`Aggregate reward track ${track.rewardTrackId} cannot declare yearBand.`);
    }
    for (const sourceId of sources) {
      if (!trackById.has(sourceId)) {
        throw new TypeError(`Reward track ${track.rewardTrackId} has missing source reward track ${sourceId}.`);
      }
    }
  }

  for (const rewardTrackId of Object.keys(state)) {
    if (!trackById.has(rewardTrackId)) {
      throw new TypeError(`Monster projection currentState contains undeclared reward track ${rewardTrackId}.`);
    }
  }
  const runtimeIds = new Set();
  const canonicalItems = items.map((rawItem) => {
    const item = record(rawItem, 'Monster projection catalogue item');
    let identity;
    try {
      identity = parseRuntimeItemId(item.runtimeItemId);
    } catch {
      throw new TypeError('Monster projection catalogue item runtime identity is malformed.');
    }
    if (item.packId !== packId || identity.packId !== packId) {
      throw new TypeError('Monster projection catalogue item pack does not match its reward tracks.');
    }
    if (typeof item.itemId !== 'string' || identity.itemId !== item.itemId) {
      throw new TypeError('Monster projection catalogue item identity is inconsistent.');
    }
    if (typeof item.yearBand !== 'string' || !ID_SEGMENT.test(item.yearBand)) {
      throw new TypeError('Monster projection catalogue item yearBand must be canonical.');
    }
    if (runtimeIds.has(item.runtimeItemId)) throw new TypeError(`Duplicate catalogue item evidence: ${item.runtimeItemId}.`);
    runtimeIds.add(item.runtimeItemId);
    return item;
  });
  return { progressMap, state, tracks, trackById, items: canonicalItems };
}

function validateGraph(tracks, trackById) {
  const visiting = new Set();
  const visited = new Set();
  function visit(trackId) {
    if (visiting.has(trackId)) throw new TypeError(`Monster reward-track source cycle at ${trackId}.`);
    if (visited.has(trackId)) return;
    visiting.add(trackId);
    for (const sourceId of trackById.get(trackId).sourceRewardTrackIds || []) visit(sourceId);
    visiting.delete(trackId);
    visited.add(trackId);
  }
  tracks.forEach(({ rewardTrackId }) => visit(rewardTrackId));
}

function validateCurrentEntry(entry, track) {
  if (entry === undefined) return null;
  const current = record(entry, `Current Monster ${track.rewardTrackId}`);
  if (current.rewardTrackId !== track.rewardTrackId
      || current.packId !== track.packId
      || current.monsterId !== track.monsterId) {
    throw new TypeError(`Current Monster ${track.rewardTrackId} identity does not match its reward track.`);
  }
  if (!['b1', 'b2'].includes(current.branch)) {
    throw new TypeError(`Current Monster ${track.rewardTrackId} branch must be b1 or b2.`);
  }
  if (!Number.isSafeInteger(current.earnedStageHighWater)
      || current.earnedStageHighWater < 0
      || current.earnedStageHighWater > 4) {
    throw new TypeError(`Current Monster ${track.rewardTrackId} earnedStageHighWater must be from 0 to 4.`);
  }
  if (typeof current.caught !== 'boolean') {
    throw new TypeError(`Current Monster ${track.rewardTrackId} caught must be boolean.`);
  }
  return current;
}

function selectBranch(random, rewardTrackId) {
  const value = random();
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) {
    throw new TypeError(`Monster ${rewardTrackId} random branch value must be from zero inclusive to one exclusive.`);
  }
  return value < 0.5 ? 'b1' : 'b2';
}

function derivedStage(secureCount, thresholds) {
  for (let index = Math.min(4, thresholds.length - 1); index >= 1; index -= 1) {
    if (secureCount >= thresholds[index]) return index;
  }
  return 0;
}

export function projectSpellingMonsters({
  learnerId,
  progress,
  rewardTracks,
  items,
  currentState = {},
  random,
} = {}) {
  const inputs = validateInputs({ learnerId, progress, rewardTracks, items, currentState, random });
  validateGraph(inputs.tracks, inputs.trackById);

  const evidenceByTrackId = new Map();
  function evidenceFor(trackId) {
    if (evidenceByTrackId.has(trackId)) return evidenceByTrackId.get(trackId);
    const track = inputs.trackById.get(trackId);
    const sources = track.sourceRewardTrackIds || [];
    const evidence = sources.length === 0
      ? new Set(inputs.items
        .filter((item) => item.yearBand === track.yearBand && inputs.progressMap[item.runtimeItemId]?.stage === 4)
        .map((item) => item.runtimeItemId))
      : new Set(sources.flatMap((sourceId) => [...evidenceFor(sourceId)]));
    evidenceByTrackId.set(trackId, evidence);
    return evidence;
  }

  return inputs.tracks.map((track) => {
    const current = validateCurrentEntry(inputs.state[track.rewardTrackId], track);
    const secureCount = evidenceFor(track.rewardTrackId).size;
    const stage = derivedStage(secureCount, track.thresholds);
    const earnedStageHighWater = Math.max(stage, current?.earnedStageHighWater || 0);
    return {
      rewardTrackId: track.rewardTrackId,
      packId: track.packId,
      monsterId: track.monsterId,
      branch: current?.branch || selectBranch(random, track.rewardTrackId),
      secureCount,
      caught: secureCount >= track.thresholds[0] || current?.caught === true || earnedStageHighWater > 0,
      derivedStage: stage,
      earnedStageHighWater,
    };
  });
}
