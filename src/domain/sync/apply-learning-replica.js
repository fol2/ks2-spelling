import { mergeSnapshots } from './merge-learning-replica.js';

const STARTER_CATALOGUE_ID = 'ks2-core:starter';
const FULL_CATALOGUE_ID = 'ks2-core:full';
const FULL_ENTITLEMENT_ID = 'full-ks2';

export function deriveDeviceLearningGrant({ entitled } = {}) {
  if (entitled === true) {
    return {
      catalogueId: FULL_CATALOGUE_ID,
      grantedEntitlementIds: [FULL_ENTITLEMENT_ID],
    };
  }
  return {
    catalogueId: STARTER_CATALOGUE_ID,
    grantedEntitlementIds: [],
  };
}

export function isRemoteFull(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  if (snapshot.catalogueId === FULL_CATALOGUE_ID) return true;
  return Array.isArray(snapshot.grantedEntitlementIds)
    && snapshot.grantedEntitlementIds.includes(FULL_ENTITLEMENT_ID);
}

function applyDeviceGrant(snapshot, grant) {
  return {
    ...snapshot,
    catalogueId: grant.catalogueId,
    grantedEntitlementIds: [...grant.grantedEntitlementIds],
  };
}

export function applyReplicaSnapshot({
  localSnapshot,
  remoteSnapshot,
  entitled,
  earned,
} = {}) {
  void earned;
  if (!remoteSnapshot || typeof remoteSnapshot !== 'object') {
    throw new TypeError('Remote snapshot is required.');
  }
  const grant = deriveDeviceLearningGrant({ entitled: entitled === true });
  const merged = mergeSnapshots(localSnapshot ?? null, remoteSnapshot);
  const working = applyDeviceGrant(merged, grant);

  // Imported Full must never become the working catalogue on a never-entitled
  // device. Park the Full payload and keep the merged working copy on Starter.
  if (isRemoteFull(remoteSnapshot) && entitled !== true) {
    return { action: 'park-full', working, preserved: structuredClone(remoteSnapshot) };
  }

  return {
    action: 'apply',
    working,
    preserved: null,
  };
}
