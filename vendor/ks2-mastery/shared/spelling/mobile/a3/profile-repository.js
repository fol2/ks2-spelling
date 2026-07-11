const PROFILE_KEYS = Object.freeze([
  'learnerId', 'nickname', 'yearGroup', 'goal', 'colour', 'createdAt', 'updatedAt',
]);
const PROFILE_KEY_SET = new Set(PROFILE_KEYS);
const REPOSITORY_KEYS = Object.freeze([
  'listProfiles', 'readProfile', 'writeProfile', 'removeProfile',
]);
const REPOSITORY_KEY_SET = new Set(REPOSITORY_KEYS);
const CANONICAL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const YEAR_GROUPS = new Set(['Y3', 'Y4', 'Y5', 'Y6']);
const HEX_COLOUR = /^#[0-9A-F]{6}$/i;

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  return value;
}

function canonicalLearnerId(value) {
  if (typeof value !== 'string' || !CANONICAL_ID.test(value)) {
    throw new TypeError('Profile learnerId must be a canonical lower-case kebab identifier.');
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite non-negative timestamp.`);
  }
  return value;
}

function exactDataProperties(value, keys, allowed, label) {
  const ownKeys = Reflect.ownKeys(value);
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new TypeError(`Unknown ${label} key: ${String(key)}.`);
    }
  }
  if (ownKeys.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} must contain exactly ${keys.join(', ')}.`);
  }
  const output = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw new TypeError(`${label} ${key} must be an enumerable data property, not an accessor or hidden field.`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function compareCanonicalIds(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function validateSpellingProfile(value) {
  const candidate = record(value, 'Spelling profile');
  const fields = exactDataProperties(candidate, PROFILE_KEYS, PROFILE_KEY_SET, 'Spelling profile');
  const learnerId = canonicalLearnerId(fields.learnerId);
  if (typeof fields.nickname !== 'string' || !fields.nickname
      || fields.nickname.trim() !== fields.nickname) {
    throw new TypeError('Profile nickname must be a non-empty trimmed string.');
  }
  if (!YEAR_GROUPS.has(fields.yearGroup)) {
    throw new TypeError('Profile yearGroup must be Y3, Y4, Y5 or Y6.');
  }
  if (!Number.isSafeInteger(fields.goal) || fields.goal <= 0) {
    throw new TypeError('Profile goal must be a positive safe integer.');
  }
  if (typeof fields.colour !== 'string' || !HEX_COLOUR.test(fields.colour)) {
    throw new TypeError('Profile colour must be a six-digit hexadecimal colour.');
  }
  const createdAt = timestamp(fields.createdAt, 'Profile createdAt');
  const updatedAt = timestamp(fields.updatedAt, 'Profile updatedAt');
  if (updatedAt < createdAt) {
    throw new TypeError('Profile updatedAt must not precede createdAt.');
  }
  return {
    learnerId,
    nickname: fields.nickname,
    yearGroup: fields.yearGroup,
    goal: fields.goal,
    colour: fields.colour,
    createdAt,
    updatedAt,
  };
}

export function validateSpellingProfileRepository(candidate) {
  const repository = record(candidate, 'Spelling profile repository');
  const methods = exactDataProperties(
    repository, REPOSITORY_KEYS, REPOSITORY_KEY_SET, 'Spelling profile repository',
  );
  for (const key of REPOSITORY_KEYS) {
    if (typeof methods[key] !== 'function') {
      throw new TypeError(`Spelling profile repository ${key} must be a method.`);
    }
  }
  return repository;
}

export function createInMemorySpellingProfileRepository({ profiles = [], now } = {}) {
  if (!Array.isArray(profiles)) throw new TypeError('profiles must be an array.');
  if (typeof now !== 'function') throw new TypeError('Profile repository requires an injected now() clock.');

  const committed = new Map();
  for (const candidate of profiles) {
    const profile = validateSpellingProfile(candidate);
    if (committed.has(profile.learnerId)) {
      throw new TypeError(`Duplicate Spelling profile: ${profile.learnerId}.`);
    }
    committed.set(profile.learnerId, profile);
  }

  function sampleClock() {
    return timestamp(now(), 'Profile clock');
  }

  function listProfiles() {
    return [...committed.values()]
      .sort((left, right) => compareCanonicalIds(left.learnerId, right.learnerId))
      .map((profile) => structuredClone(profile));
  }

  function readProfile(learnerId) {
    canonicalLearnerId(learnerId);
    const profile = committed.get(learnerId);
    return profile ? structuredClone(profile) : null;
  }

  function writeProfile(candidate) {
    const supplied = validateSpellingProfile(candidate);
    const sampledAt = sampleClock();
    const existing = committed.get(supplied.learnerId);
    const profile = validateSpellingProfile({
      ...supplied,
      createdAt: existing?.createdAt ?? sampledAt,
      updatedAt: sampledAt,
    });
    committed.set(profile.learnerId, profile);
    return structuredClone(profile);
  }

  function removeProfile(learnerId) {
    canonicalLearnerId(learnerId);
    sampleClock();
    return committed.delete(learnerId);
  }

  return validateSpellingProfileRepository({
    listProfiles,
    readProfile,
    writeProfile,
    removeProfile,
  });
}
