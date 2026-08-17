import { mergeProfiles } from '../domain/sync/merge-learning-replica.js';
import { assertLearningReplicaPort } from '../platform/sync/learning-replica-port.js';

function requireFunction(value, label) {
  if (typeof value !== 'function') {
    throw new TypeError(`${label} must be a function.`);
  }
  return value;
}

async function readLocalSnapshot(readSnapshot, learnerId) {
  try {
    return await readSnapshot(learnerId);
  } catch {
    return null;
  }
}

async function publishAll({ replica, listProfiles, readSnapshot }) {
  const profiles = await listProfiles();
  const snapshots = [];
  for (const profile of profiles) {
    const payload = await readLocalSnapshot(readSnapshot, profile.learnerId);
    if (payload) snapshots.push({ learnerId: profile.learnerId, payload });
  }
  await replica.publish({ profiles, snapshots });
}

export function startICloudLearningReplica({
  replica,
  listProfiles,
  readSnapshot,
  writeProfile,
  applyIncoming,
  entitled,
  earned,
} = {}) {
  assertLearningReplicaPort(replica);
  requireFunction(listProfiles, 'listProfiles');
  requireFunction(readSnapshot, 'readSnapshot');
  requireFunction(writeProfile, 'writeProfile');
  requireFunction(applyIncoming, 'applyIncoming');
  if (typeof entitled !== 'boolean') {
    throw new TypeError('Replica start requires an entitled boolean.');
  }
  if (typeof earned !== 'boolean') {
    throw new TypeError('Replica start requires an earned boolean.');
  }

  let available = false;

  async function publishLearner(learnerId) {
    if (available !== true) return;
    try {
      const profiles = (await listProfiles()).filter(
        (profile) => profile.learnerId === learnerId,
      );
      if (profiles.length === 0) return;
      const payload = await readLocalSnapshot(readSnapshot, learnerId);
      const snapshots = payload ? [{ learnerId, payload }] : [];
      await replica.publish({ profiles, snapshots });
    } catch {
      // Best-effort replica publish; local SQLite remains the source of truth.
    }
  }

  async function start() {
    let status;
    try {
      status = await replica.getStatus();
    } catch {
      return Object.freeze({ publishLearner, dispose() {} });
    }
    if (status?.available !== true) {
      return Object.freeze({ publishLearner, dispose() {} });
    }
    available = true;
    try {
      const pulled = await replica.pull();
      const locals = await listProfiles();
      const localsById = new Map(locals.map((profile) => [profile.learnerId, profile]));
      for (const remote of pulled.profiles) {
        const merged = mergeProfiles(localsById.get(remote.learnerId) ?? null, remote);
        await writeProfile(merged);
      }
      for (const item of pulled.snapshots) {
        const localSnapshot = await readLocalSnapshot(readSnapshot, item.learnerId);
        await applyIncoming({
          localSnapshot,
          remoteSnapshot: item.payload,
          entitled,
          earned,
        });
      }
      await publishAll({ replica, listProfiles, readSnapshot });
    } catch {
      // Unavailable or a replica fault stays local-only. Never surface a
      // child-facing sign-in nag.
    }
    return Object.freeze({ publishLearner, dispose() {} });
  }

  return start();
}
