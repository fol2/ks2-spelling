import {
  assertB3CaptureResumeAuthority,
  createB3CaptureCheckpoint,
  readB3CaptureCheckpoint,
  writeB3CaptureCheckpoint,
} from './b3-device-observation.mjs';
import { readB3PhysicalObservationJournal } from './b3-physical-observation-journal.mjs';

const SCENARIOS = Object.freeze({
  ios: Object.freeze([
    'product-query', 'cancel', 'ask-to-buy-pending', 'normal-purchase',
    'unfinished-relaunch', 'pack-install', 'restore-after-reinstall',
    'redownload', 'refund-revoke',
  ]),
  android: Object.freeze([
    'product-query', 'cancel', 'slow-card-pending-decline',
    'slow-card-pending-approve', 'unacknowledged-relaunch', 'pack-install',
    'restore-after-reinstall', 'redownload', 'refund-revoke',
  ]),
});

function stateError(message) {
  return Object.assign(new Error(message), { code: 'b3_host_capture_state_invalid' });
}

function completedScenarioCount(platform, observation) {
  if (['TERMINAL_CAPTURE', 'MANUAL_ATTESTATION', 'COMPLETE'].includes(observation.phase)) {
    return SCENARIOS[platform].length;
  }
  if (observation.phase === 'SCENARIO_COMPLETE') return observation.scenarioIndex + 1;
  if (platform === 'ios' && observation.scenario === 'normal-purchase' &&
      observation.phase === 'HOLD_REACHED') return observation.scenarioIndex + 1;
  return observation.scenarioIndex;
}

function checkpointFromTail({ platform, buildAuthority, observation, revision }) {
  const completedCount = completedScenarioCount(platform, observation);
  return createB3CaptureCheckpoint({
    schemaVersion: 2,
    platform,
    captureId: observation.captureId,
    testedApplicationCommit: buildAuthority.testedApplicationCommit,
    applicationFingerprint: buildAuthority.applicationFingerprint,
    installationId: observation.installationId,
    nextScenarioIndex: completedCount,
    nextObservationSequence: observation.sequence + 1,
    state: observation.phase,
    completedScenarios: SCENARIOS[platform].slice(0, completedCount),
    previousObservationSha256: observation.observationSha256,
    checkpointRevision: revision,
  });
}

export async function reconcileB3CaptureCheckpointFromJournal({
  root,
  platform,
  buildAuthority,
}) {
  if (!Object.hasOwn(SCENARIOS, platform)) {
    throw stateError('B3 host capture checkpoint platform is invalid');
  }
  const records = await readB3PhysicalObservationJournal({
    root,
    platform,
    buildAuthority,
  });
  if (records.length === 0) return null;
  let current = null;
  try {
    current = await readB3CaptureCheckpoint({ root, platform });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (current === null) {
    if (records.length !== 1) {
      throw stateError('B3 host capture journal is too far ahead of its absent checkpoint');
    }
    const initial = checkpointFromTail({
      platform,
      buildAuthority,
      observation: records[0].observation,
      revision: 0,
    });
    await writeB3CaptureCheckpoint({
      root,
      platform,
      expectedRevision: null,
      value: initial,
    });
    return initial;
  }
  const checkpointedRecordCount = current.nextObservationSequence - 1;
  if (checkpointedRecordCount < 1 || checkpointedRecordCount > records.length ||
      records[checkpointedRecordCount - 1].observation.observationSha256 !==
        current.previousObservationSha256) {
    throw stateError('B3 host capture checkpoint tail differs from its retained journal');
  }
  const derivedCurrent = checkpointFromTail({
    platform,
    buildAuthority,
    observation: records[checkpointedRecordCount - 1].observation,
    revision: current.checkpointRevision,
  });
  if (derivedCurrent.checkpointSha256 !== current.checkpointSha256) {
    throw stateError('B3 host capture checkpoint state or progress is not derived from its journal tail');
  }
  assertB3CaptureResumeAuthority(current, {
    testedApplicationCommit: buildAuthority.testedApplicationCommit,
    applicationFingerprint: buildAuthority.applicationFingerprint,
    captureId: records[0].observation.captureId,
    platform,
    previousObservationSha256: current.previousObservationSha256,
  });
  if (records.length === checkpointedRecordCount) return current;
  if (records.length !== checkpointedRecordCount + 1) {
    throw stateError('B3 host capture journal is more than one record ahead of its checkpoint');
  }
  const recovered = checkpointFromTail({
    platform,
    buildAuthority,
    observation: records.at(-1).observation,
    revision: current.checkpointRevision + 1,
  });
  await writeB3CaptureCheckpoint({
    root,
    platform,
    expectedRevision: current.checkpointRevision,
    value: recovered,
  });
  return recovered;
}
