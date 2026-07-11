const ID_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function requireSegment(name, value) {
  if (typeof value !== 'string' || !ID_SEGMENT.test(value)) {
    throw new TypeError(`${name} must be one canonical lower-case kebab identifier.`);
  }
  return value;
}

export function createRuntimeItemId(packId, itemId) {
  return `${requireSegment('packId', packId)}:${requireSegment('itemId', itemId)}`;
}

export function parseRuntimeItemId(value) {
  if (typeof value !== 'string' || value.split(':').length !== 2) {
    throw new TypeError('A runtime item identity must contain exactly one colon.');
  }
  const [packId, itemId] = value.split(':');
  if (!ID_SEGMENT.test(packId) || !ID_SEGMENT.test(itemId)) {
    throw new TypeError('A runtime item identity must be canonical.');
  }
  const runtimeItemId = createRuntimeItemId(packId, itemId);
  if (runtimeItemId !== value) {
    throw new TypeError('A runtime item identity must be canonical.');
  }
  return Object.freeze({ packId, itemId, runtimeItemId });
}

export function normaliseSpellingTarget(value) {
  const target = typeof value === 'string'
    ? value.normalize('NFKC').trim().toLocaleLowerCase('en-GB').replaceAll('’', "'")
    : '';
  if (!target) throw new TypeError('A spelling target must be a non-empty string.');
  return target;
}

export function createRuntimeItemReference({ packId, itemId, legacySlug } = {}) {
  const runtimeItemId = createRuntimeItemId(packId, itemId);
  if (typeof legacySlug !== 'string' || !legacySlug.trim()) {
    throw new TypeError('legacySlug must be non-empty compatibility metadata.');
  }
  return Object.freeze({ packId, itemId, runtimeItemId, legacySlug: legacySlug.trim() });
}
