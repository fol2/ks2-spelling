const IDENTITY = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const REQUIRED_ENTITLEMENT_ID = 'full-ks2';

function activationError(code) {
  return Object.assign(new Error(code), { code });
}

function exactRecord(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} is invalid.`);
  }
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) =>
    typeof key !== 'string' || !keys.includes(key) ||
    !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
    !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) {
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

function decodeEnvelope(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_048_576 ||
      !BASE64.test(value)) {
    throw activationError('PACK_ACTIVATION_ENVELOPE_INVALID');
  }
  const binary = globalThis.atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.length === 0 || globalThis.btoa(binary) !== value) {
    throw activationError('PACK_ACTIVATION_ENVELOPE_INVALID');
  }
  return bytes;
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function validateDependencies(value) {
  const required = [
    'packTransfer', 'packRepository', 'manifestVerifier', 'keyring',
    'environment', 'clock',
  ];
  const allowed = [...required, 'crashInjector'];
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      required.some((key) => !Object.hasOwn(value, key)) ||
      Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.includes(key))) {
    throw new TypeError('Pack activation coordinator dependencies are invalid.');
  }
  const transferMethods = ['inspectAndExtract', 'sealAndInstall', 'inventoryInstalledVersions'];
  const repositoryMethods = [
    'getActiveVersion', 'getDownloadJob', 'listInstalledVersions',
    'registerAndFlipActiveVersion', 'updateDownloadJob',
  ];
  if (transferMethods.some((method) => typeof value.packTransfer?.[method] !== 'function') ||
      repositoryMethods.some((method) => typeof value.packRepository?.[method] !== 'function') ||
      typeof value.manifestVerifier !== 'function' || typeof value.clock !== 'function' ||
      typeof value.environment !== 'string' || value.environment.length === 0 ||
      (value.crashInjector !== undefined && typeof value.crashInjector !== 'function')) {
    throw new TypeError('Pack activation coordinator dependencies are invalid.');
  }
  return value;
}

function sampleMilliseconds(clock) {
  const sampled = clock();
  const milliseconds = sampled instanceof Date ? sampled.getTime() : sampled;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new TypeError('Pack activation clock is invalid.');
  }
  return milliseconds;
}

function readTimestamp(clock, floor) {
  const milliseconds = sampleMilliseconds(clock);
  const value = Math.max(milliseconds, floor + 1);
  if (!Number.isSafeInteger(value)) throw new TypeError('Pack activation timestamp overflowed.');
  return value;
}

function requireVerifiedManifest(result, packId, version) {
  const manifest = result?.manifest;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
      manifest.packId !== packId || manifest.version !== version ||
      manifest.requiredEntitlementId !== REQUIRED_ENTITLEMENT_ID ||
      !manifest.archive || typeof manifest.archive.name !== 'string' ||
      typeof manifest.archive.sha256 !== 'string' ||
      !Number.isSafeInteger(manifest.archive.bytes) || manifest.archive.bytes <= 0 ||
      !Array.isArray(manifest.files) || manifest.files.length === 0 ||
      manifest.files.some((file) => !Number.isSafeInteger(file?.bytes) || file.bytes < 0)) {
    throw activationError('PACK_ACTIVATION_MANIFEST_AUTHORITY_MISMATCH');
  }
  const extractedBytes = manifest.files.reduce((total, file) => total + file.bytes, 0);
  if (!Number.isSafeInteger(extractedBytes)) {
    throw activationError('PACK_ACTIVATION_MANIFEST_AUTHORITY_MISMATCH');
  }
  return { manifest, extractedBytes, fileCount: manifest.files.length };
}

function sameInventory(record, { packId, version, manifestSha256 }) {
  return record.packId === packId && record.version === version &&
    record.manifestSha256 === manifestSha256;
}

export function createPackActivationCoordinator(rawDependencies) {
  const dependencies = validateDependencies(rawDependencies);
  const {
    packTransfer, packRepository, manifestVerifier, keyring, environment, clock,
    crashInjector = () => {},
  } = dependencies;
  let tail = Promise.resolve();
  let lastTimestamp = -1;

  function checkpoint(name) {
    return crashInjector(name);
  }

  function timestamp() {
    lastTimestamp = readTimestamp(clock, lastTimestamp);
    return lastTimestamp;
  }

  function absorbTimestampFloor(...values) {
    for (const value of values) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw activationError('PACK_ACTIVATION_DURABLE_TIMESTAMP_INVALID');
      }
      lastTimestamp = Math.max(lastTimestamp, value);
    }
  }

  function serialise(operation) {
    const run = tail.then(operation, operation);
    tail = run.catch(() => {});
    return run;
  }

  async function activate(input) {
    if (arguments.length !== 1) throw new TypeError('activate requires one input.');
    const value = exactRecord(
      input,
      ['packId', 'version', 'signedManifestEnvelope'],
      'Pack activation input',
    );
    const packId = requireIdentity(value.packId, 'Pack identifier');
    const version = requireIdentity(value.version, 'Pack version');
    const envelopeBytes = decodeEnvelope(value.signedManifestEnvelope);

    return serialise(async () => {
      await checkpoint('beforeManifestVerification');
      const verificationMilliseconds = sampleMilliseconds(clock);
      const verified = await manifestVerifier({
        envelopeBytes,
        keyring,
        environment,
        clock: () => new Date(verificationMilliseconds),
      });
      const authority = requireVerifiedManifest(verified, packId, version);
      const manifestSha256 = await sha256Hex(envelopeBytes);
      await checkpoint('afterManifestVerification');

      let job = await packRepository.getDownloadJob({ jobId: `${packId}.${version}` });
      if (!job || job.packId !== packId || job.version !== version ||
          job.manifestSha256 !== manifestSha256 ||
          !['downloaded', 'extracting', 'ready'].includes(job.state) ||
          job.archiveName !== authority.manifest.archive.name ||
          job.archiveSha256 !== authority.manifest.archive.sha256 ||
          job.expectedBytes !== authority.manifest.archive.bytes) {
        throw activationError('PACK_ACTIVATION_DOWNLOAD_AUTHORITY_MISMATCH');
      }
      absorbTimestampFloor(job.updatedAt);

      const inventory = await packTransfer.inventoryInstalledVersions();
      const identityInventory = inventory.filter((record) =>
        record.packId === packId && record.version === version);
      if (identityInventory.length > 1 ||
          (identityInventory.length === 1 && !sameInventory(identityInventory[0], {
            packId, version, manifestSha256,
          }))) {
        throw activationError('PACK_ACTIVATION_INSTALLED_AUTHORITY_MISMATCH');
      }

      const [databaseVersions, currentActive] = await Promise.all([
        packRepository.listInstalledVersions({ packId }),
        packRepository.getActiveVersion({ packId }),
      ]);
      const databaseInstalled = databaseVersions.find((record) => record.version === version) ?? null;
      absorbTimestampFloor(
        ...(databaseInstalled ? [databaseInstalled.installedAt] : []),
        ...(currentActive ? [currentActive.activatedAt] : []),
      );
      if (databaseInstalled &&
          (databaseInstalled.state !== 'ready' ||
           databaseInstalled.manifestSha256 !== manifestSha256 ||
           identityInventory.length !== 1 ||
           databaseInstalled.pathToken !== identityInventory[0].installedPathToken ||
           databaseInstalled.activationMarkerSha256 !==
             identityInventory[0].activationMarkerSha256)) {
        throw activationError('PACK_ACTIVATION_DATABASE_AUTHORITY_MISMATCH');
      }

      let installed = identityInventory[0] ?? null;
      if (!installed) {
        if (job.state === 'ready') {
          throw activationError('PACK_ACTIVATION_INSTALLED_VERSION_MISSING');
        }
        if (job.state === 'downloaded') {
          job = await packRepository.updateDownloadJob({
            jobId: job.jobId,
            expectedState: 'downloaded',
            state: 'extracting',
            etag: job.etag,
            updatedAt: timestamp(),
          });
        }
        await checkpoint('beforeExtraction');
        const inspection = await packTransfer.inspectAndExtract({
          packId,
          version,
          archiveName: authority.manifest.archive.name,
          signedManifestEnvelopeBase64: value.signedManifestEnvelope,
        });
        if (inspection.archiveSha256 !== authority.manifest.archive.sha256 ||
            inspection.manifestSha256 !== manifestSha256 ||
            inspection.extractedBytes !== authority.extractedBytes ||
            inspection.fileCount !== authority.fileCount) {
          throw activationError('PACK_ACTIVATION_EXTRACTION_AUTHORITY_MISMATCH');
        }
        await checkpoint('afterExtraction');
        await checkpoint('beforeSealAndInstall');
        const sealed = await packTransfer.sealAndInstall({ packId, version, manifestSha256 });
        await checkpoint('afterSealAndInstall');
        installed = {
          packId,
          version,
          manifestSha256,
          installedPathToken: sealed.installedPathToken,
          activationMarkerSha256: sealed.activationMarkerSha256,
        };
      }

      if (installed && job.state === 'downloaded') {
        job = await packRepository.updateDownloadJob({
          jobId: job.jobId,
          expectedState: 'downloaded',
          state: 'extracting',
          etag: job.etag,
          updatedAt: timestamp(),
        });
      }

      const installedAt = databaseInstalled?.installedAt ?? timestamp();
      const installedVersion = {
        packId,
        version,
        manifestSha256,
        pathToken: installed.installedPathToken,
        activationMarkerSha256: installed.activationMarkerSha256,
        state: 'ready',
        installedAt,
      };
      const alreadyActive = Boolean(
        databaseInstalled && currentActive && currentActive.packId === packId &&
        currentActive.version === version && currentActive.manifestSha256 === manifestSha256 &&
        currentActive.pathToken === installed.installedPathToken,
      );
      const activeVersion = alreadyActive ? currentActive : {
        packId,
        version,
        manifestSha256,
        pathToken: installed.installedPathToken,
        activatedAt: timestamp(),
      };
      let active = currentActive;
      await checkpoint('beforeDatabaseRegisterAndFlip');
      try {
        active = await packRepository.registerAndFlipActiveVersion({
          requiredEntitlementId: authority.manifest.requiredEntitlementId,
          installedVersion,
          activeVersion,
        });
      } catch (error) {
        if (error?.code !== 'sqlite_pack_entitlement_inactive') throw error;
        return Object.freeze({ state: 'access-locked', active: currentActive, job });
      }
      await checkpoint('afterDatabaseRegisterAndFlip');

      if (job.state === 'extracting') {
        job = await packRepository.updateDownloadJob({
          jobId: job.jobId,
          expectedState: 'extracting',
          state: 'ready',
          etag: job.etag,
          updatedAt: timestamp(),
        });
      }
      return Object.freeze({ state: 'ready', active, job });
    });
  }

  return Object.freeze({ activate });
}
