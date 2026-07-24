const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const AUDIO_PATH =
  /^audio\/(?:iapetus|sulafat)\/[a-z0-9][a-z0-9._-]{0,63}\/(?:word|sentence-[0-9]{2}-(?:normal|slow))\.m4a$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const MAXIMUM_AUDIO_BYTES = 131_072;

function installedAudioError() {
  const error = new Error('Installed audio is unavailable.');
  error.code = 'installed_audio_unavailable';
  return error;
}

function requireClosedRecord(value, keys, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new TypeError(`${label} is not a closed installed audio record.`);
  }
  return value;
}

function requireString(value, pattern, label) {
  if (
    typeof value !== 'string' ||
    new TextEncoder().encode(value).length === 0 ||
    !pattern.test(value)
  ) {
    throw new TypeError(`${label} is invalid installed audio data.`);
  }
  return value;
}

function validateRequest(value) {
  requireClosedRecord(
    value,
    ['packId', 'version', 'assetPath', 'sha256', 'byteSize'],
    'Installed audio request',
  );
  if (
    !Number.isSafeInteger(value.byteSize) ||
    value.byteSize < 1 ||
    value.byteSize > MAXIMUM_AUDIO_BYTES
  ) {
    throw new TypeError('Installed audio byte size is invalid.');
  }
  return Object.freeze({
    packId: requireString(value.packId, SAFE_ID, 'Pack identifier'),
    version: requireString(value.version, SAFE_ID, 'Pack version'),
    assetPath: requireString(value.assetPath, AUDIO_PATH, 'Audio asset path'),
    sha256: requireString(value.sha256, SHA256, 'Audio SHA-256'),
    byteSize: value.byteSize,
  });
}

function decodedBase64Bytes(value) {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function validateResult(value, expectedBytes) {
  requireClosedRecord(value, ['base64'], 'Installed audio result');
  if (
    typeof value.base64 !== 'string' ||
    value.base64.length === 0 ||
    value.base64.length > Math.ceil(MAXIMUM_AUDIO_BYTES / 3) * 4 ||
    !BASE64.test(value.base64) ||
    decodedBase64Bytes(value.base64) !== expectedBytes
  ) {
    throw new TypeError('Installed audio result contains invalid base64.');
  }
  return Object.freeze({ base64: value.base64 });
}

function createNativeFacade(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('InstalledAudio plugin must be an object.');
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 0 &&
    (keys.length !== 1 || keys[0] !== 'readInstalledAudio')
  ) {
    throw new TypeError('InstalledAudio plugin must expose one method.');
  }
  let method;
  try {
    method = value.readInstalledAudio;
  } catch {
    throw new TypeError('InstalledAudio.readInstalledAudio must be available.');
  }
  if (typeof method !== 'function') {
    throw new TypeError('InstalledAudio.readInstalledAudio must be a function.');
  }
  return (request) => Reflect.apply(method, value, [request]);
}

export function createCapacitorInstalledAudio({ InstalledAudio } = {}) {
  const readNative = createNativeFacade(InstalledAudio);
  return Object.freeze({
    async readInstalledAudio(request) {
      const input = validateRequest(request);
      let pending;
      try {
        pending = readNative(input);
      } catch {
        throw installedAudioError();
      }
      if (!(pending instanceof Promise)) {
        throw new TypeError('InstalledAudio.readInstalledAudio must return a Promise.');
      }
      let result;
      try {
        result = await pending;
      } catch {
        throw installedAudioError();
      }
      return validateResult(result, input.byteSize);
    },
  });
}
