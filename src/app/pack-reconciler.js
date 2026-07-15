const IDENTITY = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const ENTITLEMENT_ID = 'full-ks2';
const PACK_ID = 'b3-sandbox-proof';

function reconciliationError(code) {
  return Object.assign(new Error(code), { code });
}

function exactRecord(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== keys.length ||
      Reflect.ownKeys(value).some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return typeof key !== 'string' || !keys.includes(key) ||
          !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value');
      })) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function requireIdentity(value, label) {
  if (typeof value !== 'string' || !IDENTITY.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function validateDependencies(value) {
  const keys = ['packTransfer', 'packRepository', 'activeEntitlementProjection', 'clock'];
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== keys.length ||
      Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key))) {
    throw new TypeError('Pack reconciler dependencies are invalid.');
  }
  const repositoryMethods = [
    'getActiveVersion', 'listDownloadJobs',
    'listInstalledVersions', 'registerAndFlipActiveVersion',
    'retireInstalledVersion', 'updateDownloadJob',
  ];
  if (typeof value.packTransfer?.inventoryInstalledVersions !== 'function' ||
      typeof value.packTransfer?.removeOwnedTemporaryState !== 'function' ||
      repositoryMethods.some((method) => typeof value.packRepository?.[method] !== 'function') ||
      typeof value.activeEntitlementProjection !== 'function' || typeof value.clock !== 'function') {
    throw new TypeError('Pack reconciler dependencies are invalid.');
  }
  return value;
}

function sameAuthority(inventory, row) {
  return inventory.packId === row.packId && inventory.version === row.version &&
    inventory.manifestSha256 === row.manifestSha256 &&
    inventory.installedPathToken === row.pathToken &&
    inventory.activationMarkerSha256 === row.activationMarkerSha256;
}

function requireReadonlyEntitlementSet(value) {
  const expected = new Set([
    'size', 'has', 'values', 'keys', 'entries', 'forEach', Symbol.iterator,
  ]);
  const keys = value && typeof value === 'object' ? Reflect.ownKeys(value) : [];
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(value, key)]));
  const methods = ['has', 'values', 'keys', 'entries', 'forEach', Symbol.iterator];
  if (!value || Object.getPrototypeOf(value) !== null || !Object.isFrozen(value) ||
      keys.length !== expected.size || keys.some((key) => !expected.has(key)) ||
      [...descriptors.values()].some((descriptor) =>
        !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) ||
      !Number.isSafeInteger(descriptors.get('size')?.value) ||
      descriptors.get('size').value < 0 || methods.some((key) =>
        typeof descriptors.get(key)?.value !== 'function')) {
    throw new TypeError('Active entitlement projection is invalid.');
  }
  return value;
}

export function createPackReconciler(rawDependencies) {
  const {
    packTransfer, packRepository, activeEntitlementProjection, clock,
  } = validateDependencies(rawDependencies);
  let tail = Promise.resolve();
  let lastTimestamp = -1;

  function timestamp() {
    const sampled = clock();
    const milliseconds = sampled instanceof Date ? sampled.getTime() : sampled;
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new TypeError('Pack reconciliation clock is invalid.');
    }
    lastTimestamp = Math.max(milliseconds, lastTimestamp + 1);
    if (!Number.isSafeInteger(lastTimestamp)) {
      throw new TypeError('Pack reconciliation timestamp overflowed.');
    }
    return lastTimestamp;
  }

  function absorbTimestampFloor(...values) {
    for (const value of values) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw reconciliationError('PACK_RECONCILIATION_DURABLE_TIMESTAMP_INVALID');
      }
      lastTimestamp = Math.max(lastTimestamp, value);
    }
  }

  function serialise(operation) {
    const run = tail.then(operation, operation);
    tail = run.catch(() => {});
    return run;
  }

  async function failAndRemoveOrphan(job) {
    let failed = job;
    if (job.state === 'downloaded' || job.state === 'extracting') {
      failed = await packRepository.updateDownloadJob({
        jobId: job.jobId,
        expectedState: job.state,
        state: 'failed',
        etag: job.etag,
        updatedAt: timestamp(),
      });
    }
    if (failed.state !== 'failed') return false;
    await packTransfer.removeOwnedTemporaryState({
      packId: failed.packId,
      version: failed.version,
    });
    return true;
  }

  async function reconcileAtStartup() {
    if (arguments.length !== 0) {
      throw new TypeError('reconcileAtStartup does not accept input.');
    }
    return serialise(async () => {
      const [inventory, jobs, entitlements] = await Promise.all([
        packTransfer.inventoryInstalledVersions(),
        packRepository.listDownloadJobs(),
        activeEntitlementProjection(),
      ]);
      requireReadonlyEntitlementSet(entitlements);
      let accessLocked = !entitlements.has(ENTITLEMENT_ID);
      if (
        inventory.some((record) => record.packId !== PACK_ID) ||
        jobs.some((job) => job.packId !== PACK_ID)
      ) {
        throw reconciliationError('PACK_RECONCILIATION_PACK_AUTHORITY_MISMATCH');
      }
      absorbTimestampFloor(...jobs.map((job) => job.updatedAt));
      const identities = new Set();
      for (const record of inventory) {
        const identity = `${record.packId}\u0000${record.version}`;
        if (identities.has(identity)) {
          throw reconciliationError('PACK_RECONCILIATION_INVENTORY_AMBIGUOUS');
        }
        identities.add(identity);
      }

      const recovered = [];
      const removedTemporary = [];
      const readiness = [];

      for (const packId of [PACK_ID]) {
        let installedRows = await packRepository.listInstalledVersions({ packId });
        let active = await packRepository.getActiveVersion({ packId });
        absorbTimestampFloor(
          ...installedRows.map((row) => row.installedAt),
          ...(active ? [active.activatedAt] : []),
        );
        const nativeForPack = inventory.filter((record) => record.packId === packId);

        const recoverableJobs = jobs.filter((job) =>
          job.packId === packId && ['extracting', 'ready'].includes(job.state));
        const unregisteredRecoverable = recoverableJobs.filter((job) =>
          !installedRows.some((row) => row.version === job.version) &&
          nativeForPack.some((record) =>
            record.version === job.version && record.manifestSha256 === job.manifestSha256));
        for (const job of recoverableJobs) {
          const native = nativeForPack.find((record) =>
            record.version === job.version && record.manifestSha256 === job.manifestSha256);
          const registered = installedRows.find((row) => row.version === job.version);
          if (!native || (registered && !sameAuthority(native, registered))) continue;
          let registrationCompleted = false;
          if (!registered && !accessLocked && unregisteredRecoverable.length === 1) {
            const registration = {
              requiredEntitlementId: ENTITLEMENT_ID,
              installedVersion: {
                packId,
                version: native.version,
                manifestSha256: native.manifestSha256,
                pathToken: native.installedPathToken,
                activationMarkerSha256: native.activationMarkerSha256,
                state: 'ready',
                installedAt: timestamp(),
              },
              activeVersion: {
                packId,
                version: native.version,
                manifestSha256: native.manifestSha256,
                pathToken: native.installedPathToken,
                activatedAt: timestamp(),
              },
            };
            try {
              active = await packRepository.registerAndFlipActiveVersion(registration);
              installedRows = await packRepository.listInstalledVersions({ packId });
              recovered.push(`${packId}.${native.version}`);
              registrationCompleted = true;
            } catch (error) {
              if (error?.code !== 'sqlite_pack_entitlement_inactive') throw error;
              accessLocked = true;
            }
          }
          if (job.state === 'extracting' && (registered || registrationCompleted)) {
            await packRepository.updateDownloadJob({
              jobId: job.jobId,
              expectedState: 'extracting',
              state: 'ready',
              etag: job.etag,
              updatedAt: timestamp(),
            });
          }
        }

        let activeReady = false;
        if (active) {
          const activeInstalled = installedRows.find((row) =>
            row.version === active.version && row.state === 'ready' &&
            row.manifestSha256 === active.manifestSha256 && row.pathToken === active.pathToken);
          const activeNative = nativeForPack.find((record) =>
            activeInstalled && sameAuthority(record, activeInstalled));
          activeReady = Boolean(activeInstalled && activeNative);
        }

        if (!activeReady && !accessLocked) {
          const candidates = installedRows
            .filter((row) => row.state === 'ready' && nativeForPack.some((record) =>
              sameAuthority(record, row)))
            .toSorted((left, right) => right.installedAt - left.installedAt);
          const unambiguous = candidates.length === 1 ||
            (candidates.length > 1 && candidates[0].installedAt > candidates[1].installedAt);
          if (candidates.length > 0 && unambiguous) {
            const previous = candidates[0];
            const registration = {
              requiredEntitlementId: ENTITLEMENT_ID,
              installedVersion: previous,
              activeVersion: {
                packId,
                version: previous.version,
                manifestSha256: previous.manifestSha256,
                pathToken: previous.pathToken,
                activatedAt: timestamp(),
              },
            };
            try {
              active = await packRepository.registerAndFlipActiveVersion(registration);
              activeReady = true;
              recovered.push(`${packId}.${previous.version}`);
            } catch (error) {
              if (error?.code !== 'sqlite_pack_entitlement_inactive') throw error;
              accessLocked = true;
            }
          }
        }

        readiness.push(Object.freeze({
          packId,
          version: activeReady ? active.version : null,
          ready: activeReady && !accessLocked,
          accessLocked,
        }));
      }

      for (const job of jobs) {
        const native = inventory.find((record) =>
          record.packId === job.packId && record.version === job.version &&
          record.manifestSha256 === job.manifestSha256);
        if (!native && ['extracting', 'failed'].includes(job.state)) {
          if (await failAndRemoveOrphan(job)) removedTemporary.push(job.jobId);
        }
      }

      return Object.freeze({
        accessLocked,
        readiness: Object.freeze(readiness),
        recovered: Object.freeze(recovered),
        removedTemporary: Object.freeze(removedTemporary),
      });
    });
  }

  async function retireOldVersions(input) {
    if (arguments.length !== 1) throw new TypeError('retireOldVersions requires one input.');
    const value = exactRecord(input, ['packId', 'keepVersions'], 'Pack retirement input');
    const packId = requireIdentity(value.packId, 'Pack identifier');
    if (packId !== PACK_ID) {
      throw reconciliationError('PACK_RECONCILIATION_PACK_AUTHORITY_MISMATCH');
    }
    if (!Number.isSafeInteger(value.keepVersions) || value.keepVersions !== 2) {
      throw new TypeError('Pack retention count is invalid.');
    }
    return serialise(async () => {
      const [inventory, installed, active] = await Promise.all([
        packTransfer.inventoryInstalledVersions(),
        packRepository.listInstalledVersions({ packId }),
        packRepository.getActiveVersion({ packId }),
      ]);
      const identities = new Set();
      const authorityInvalid = inventory.some((native) => {
        const identity = `${native.packId}\u0000${native.version}`;
        if (identities.has(identity)) return true;
        identities.add(identity);
        const row = installed.find((candidate) => candidate.version === native.version);
        return native.packId !== PACK_ID || !row || !sameAuthority(native, row);
      }) || installed.some((row) =>
        row.packId !== PACK_ID ||
        (row.state === 'ready' && !inventory.some((native) => sameAuthority(native, row)))) ||
        !active || active.packId !== PACK_ID;
      const activeInstalled = active && installed.find((row) =>
        row.version === active.version && row.state === 'ready' &&
        row.manifestSha256 === active.manifestSha256 && row.pathToken === active.pathToken);
      if (
        authorityInvalid ||
        !activeInstalled ||
        !inventory.some((native) => sameAuthority(native, activeInstalled))
      ) {
        throw reconciliationError('PACK_RECONCILIATION_RETIREMENT_AUTHORITY_MISMATCH');
      }
      const ready = installed.filter((row) => row.state === 'ready')
        .toSorted((left, right) => right.installedAt - left.installedAt);
      const previous = ready.filter((row) => row.version !== active.version);
      if (previous.length > 1 && previous[0].installedAt === previous[1].installedAt) {
        throw reconciliationError('PACK_RECONCILIATION_RETIREMENT_AUTHORITY_MISMATCH');
      }
      const keep = new Set([active.version]);
      if (previous[0]) keep.add(previous[0].version);
      const retired = [];
      for (const row of ready) {
        if (!keep.has(row.version)) {
          await packRepository.retireInstalledVersion({ packId, version: row.version });
          retired.push(row.version);
        }
      }
      return Object.freeze({ packId, retired: Object.freeze(retired) });
    });
  }

  return Object.freeze({ reconcileAtStartup, retireOldVersions });
}
