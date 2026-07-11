import { validateCatalogueV1 } from './pack-contracts.js';

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value, label, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (!isRecord(value)) throw new TypeError(`${label} must be an object${nullable ? ' or null' : ''}.`);
  return value;
}

function without(value, keys) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

function buildIndexes(catalogue) {
  const validated = validateCatalogueV1(catalogue);
  const byRuntimeItemId = new Map();
  const byLegacySlug = new Map();
  for (const item of validated.items) {
    if (byRuntimeItemId.has(item.runtimeItemId) || byLegacySlug.has(item.legacySlug)) {
      throw new TypeError('Runtime catalogue contains ambiguous item identity.');
    }
    byRuntimeItemId.set(item.runtimeItemId, item);
    byLegacySlug.set(item.legacySlug, item);
  }
  if ([...byLegacySlug.keys()].some((legacySlug) => byRuntimeItemId.has(legacySlug))) {
    throw new TypeError('Runtime catalogue contains ambiguous item identity.');
  }
  return { byRuntimeItemId, byLegacySlug };
}

function resolveItem(value, indexes) {
  const candidate = typeof value === 'string' ? value : '';
  const runtimeItem = indexes.byRuntimeItemId.get(candidate);
  const legacyItem = indexes.byLegacySlug.get(candidate);
  if (runtimeItem && legacyItem && runtimeItem.runtimeItemId !== legacyItem.runtimeItemId) {
    throw new TypeError(`Ambiguous legacy slug or runtime item identity: ${candidate}.`);
  }
  const item = runtimeItem || legacyItem;
  if (!item) throw new TypeError(`Unknown legacy slug or runtime item identity: ${candidate}.`);
  return item;
}

function chooseItem(legacyValue, runtimeValue, indexes, label) {
  if (legacyValue == null && runtimeValue == null) return null;
  const legacyItem = legacyValue == null ? null : resolveItem(legacyValue, indexes);
  const runtimeItem = runtimeValue == null ? null : resolveItem(runtimeValue, indexes);
  if (legacyItem && runtimeItem && legacyItem.runtimeItemId !== runtimeItem.runtimeItemId) {
    throw new TypeError(`${label} has conflicting legacy and runtime identities.`);
  }
  return runtimeItem || legacyItem;
}

function canonicalIds(legacyValue, runtimeValue, indexes, label) {
  if (legacyValue !== undefined && !Array.isArray(legacyValue)) throw new TypeError(`${label} legacy value must be an array.`);
  if (runtimeValue !== undefined && !Array.isArray(runtimeValue)) throw new TypeError(`${label} runtime value must be an array.`);
  const legacyItems = legacyValue?.map((value) => resolveItem(value, indexes)) || null;
  const runtimeItems = runtimeValue?.map((value) => resolveItem(value, indexes)) || null;
  const legacyIds = legacyItems?.map(({ runtimeItemId }) => runtimeItemId) || null;
  const runtimeIds = runtimeItems?.map(({ runtimeItemId }) => runtimeItemId) || null;
  if (legacyIds && runtimeIds && JSON.stringify(legacyIds) !== JSON.stringify(runtimeIds)) {
    throw new TypeError(`${label} has conflicting legacy and runtime identities.`);
  }
  return runtimeIds || legacyIds || [];
}

function canonicalKeyed(value, indexes, label, { attachLegacySlug = true } = {}) {
  const record = value === undefined ? {} : requireRecord(value, label);
  const entries = new Map();
  for (const [key, rawEntry] of Object.entries(record)) {
    const item = resolveItem(key, indexes);
    if (entries.has(item.runtimeItemId)) throw new TypeError(`Colliding ${label} identity: ${item.runtimeItemId}.`);
    const cloned = structuredClone(rawEntry);
    if (attachLegacySlug) {
      if (cloned?.legacySlug !== undefined && cloned.legacySlug !== item.legacySlug) {
        throw new TypeError(`${label} legacySlug metadata mismatch.`);
      }
      entries.set(item.runtimeItemId, {
        ...structuredClone(requireRecord(cloned, `${label} entry`)),
        legacySlug: item.legacySlug,
      });
    } else {
      entries.set(item.runtimeItemId, cloned);
    }
  }
  return Object.fromEntries([...entries.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

function chooseCanonicalKeyed(legacyValue, runtimeValue, indexes, label, options) {
  if (legacyValue !== undefined && runtimeValue !== undefined) {
    const legacy = canonicalKeyed(legacyValue, indexes, label, options);
    const runtime = canonicalKeyed(runtimeValue, indexes, label, options);
    if (JSON.stringify(legacy) !== JSON.stringify(runtime)) throw new TypeError(`${label} has conflicting legacy and runtime maps.`);
    return runtime;
  }
  return canonicalKeyed(runtimeValue ?? legacyValue, indexes, label, options);
}

function canonicalItemObject(value, fallbackItem, indexes, label) {
  if (value === null || value === undefined) return null;
  const record = requireRecord(value, label);
  const explicitItem = chooseItem(record.slug, record.runtimeItemId, indexes, label);
  if (fallbackItem && explicitItem && fallbackItem.runtimeItemId !== explicitItem.runtimeItemId) {
    throw new TypeError(`${label} conflicts with its containing item identity.`);
  }
  const item = explicitItem || fallbackItem;
  if (!item) throw new TypeError(`${label} is missing item identity.`);
  if (record.legacySlug !== undefined && record.legacySlug !== item.legacySlug) {
    throw new TypeError(`${label} legacySlug metadata mismatch.`);
  }
  return {
    ...structuredClone(without(record, ['slug', 'runtimeItemId', 'legacySlug'])),
    runtimeItemId: item.runtimeItemId,
    legacySlug: item.legacySlug,
  };
}

function canonicalCurrentCard(value, fallbackItem, indexes) {
  if (value === null || value === undefined) return null;
  const raw = requireRecord(value, 'session current card');
  const outer = canonicalItemObject(raw, fallbackItem, indexes, 'session current card');
  const item = resolveItem(outer.runtimeItemId, indexes);
  return {
    ...outer,
    word: canonicalItemObject(raw.word, item, indexes, 'session current card word'),
    prompt: canonicalItemObject(raw.prompt, item, indexes, 'session current card prompt'),
  };
}

function canonicalItemObjects(value, indexes, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value.map((entry, index) => canonicalItemObject(entry, null, indexes, `${label}[${index}]`));
}

function explicitItemObject(value, indexes, label) {
  if (value === null || value === undefined) return null;
  const record = requireRecord(value, label);
  return chooseItem(record.slug, record.runtimeItemId, indexes, label);
}

function normaliseSession(rawValue, indexes) {
  const raw = requireRecord(rawValue, 'session', { nullable: true });
  if (!raw) return null;
  const primaryItem = chooseItem(raw.currentSlug, raw.currentRuntimeItemId, indexes, 'session current item');
  const promptItem = explicitItemObject(raw.currentPrompt, indexes, 'session current prompt');
  const cardItem = explicitItemObject(raw.currentCard, indexes, 'session current card');
  const currentItems = [primaryItem, promptItem, cardItem].filter(Boolean);
  if (currentItems.some((item) => item.runtimeItemId !== currentItems[0].runtimeItemId)) {
    throw new TypeError('session current items conflict with their containing item identity.');
  }
  const currentItem = currentItems[0] || null;
  const identityKeys = [
    'uniqueWords', 'uniqueItemIds', 'queue', 'queueItemIds', 'status', 'statusByRuntimeItemId',
    'sentenceHistory', 'sentenceHistoryByRuntimeItemId', 'guardianResults', 'guardianResultsByRuntimeItemId',
    'patternQuestWobbledSlugs', 'patternQuestWobbledRuntimeItemIds', 'patternQuestSeedSlugs',
    'patternQuestSeedRuntimeItemIds', 'currentSlug', 'currentRuntimeItemId', 'currentPrompt', 'currentCard',
    'results', 'patternQuestCards', 'patternQuestResults', 'patternQuestCard',
  ];
  return {
    ...structuredClone(without(raw, identityKeys)),
    uniqueItemIds: canonicalIds(raw.uniqueWords, raw.uniqueItemIds, indexes, 'session unique items'),
    queueItemIds: canonicalIds(raw.queue, raw.queueItemIds, indexes, 'session queue'),
    statusByRuntimeItemId: chooseCanonicalKeyed(raw.status, raw.statusByRuntimeItemId, indexes, 'session status'),
    sentenceHistoryByRuntimeItemId: chooseCanonicalKeyed(raw.sentenceHistory, raw.sentenceHistoryByRuntimeItemId, indexes, 'session sentence history'),
    results: canonicalItemObjects(raw.results, indexes, 'session results'),
    guardianResultsByRuntimeItemId: chooseCanonicalKeyed(raw.guardianResults, raw.guardianResultsByRuntimeItemId, indexes, 'session Guardian results', { attachLegacySlug: false }),
    patternQuestCards: canonicalItemObjects(raw.patternQuestCards, indexes, 'session Pattern Quest cards'),
    patternQuestResults: canonicalItemObjects(raw.patternQuestResults, indexes, 'session Pattern Quest results'),
    patternQuestWobbledRuntimeItemIds: canonicalIds(raw.patternQuestWobbledSlugs, raw.patternQuestWobbledRuntimeItemIds, indexes, 'session Pattern Quest wobbles'),
    patternQuestSeedRuntimeItemIds: canonicalIds(raw.patternQuestSeedSlugs, raw.patternQuestSeedRuntimeItemIds, indexes, 'session Pattern Quest seeds'),
    currentRuntimeItemId: currentItem?.runtimeItemId || null,
    currentPrompt: canonicalItemObject(raw.currentPrompt, currentItem, indexes, 'session current prompt'),
    currentCard: canonicalCurrentCard(raw.currentCard, currentItem, indexes),
    patternQuestCard: canonicalItemObject(raw.patternQuestCard, null, indexes, 'session Pattern Quest card'),
  };
}

function normaliseSummary(rawValue, indexes) {
  const raw = requireRecord(rawValue, 'summary', { nullable: true });
  if (!raw) return null;
  return {
    ...structuredClone(without(raw, ['mistakes'])),
    mistakes: canonicalItemObjects(raw.mistakes, indexes, 'summary mistakes'),
  };
}

function normaliseEvent(rawValue, indexes, index) {
  const raw = requireRecord(rawValue, `events[${index}]`);
  const item = chooseItem(raw.wordSlug, raw.runtimeItemId, indexes, `events[${index}] item`);
  if (raw.legacySlug !== undefined) {
    if (!item) throw new TypeError(`events[${index}] legacySlug metadata requires item identity.`);
    if (raw.legacySlug !== item.legacySlug) throw new TypeError(`events[${index}] legacySlug metadata mismatch.`);
  }
  const output = structuredClone(without(raw, [
    'wordSlug', 'runtimeItemId', 'legacySlug', 'slugs', 'runtimeItemIds',
    'wobbledSlugs', 'wobbledRuntimeItemIds', 'seedSlugs', 'seedRuntimeItemIds',
  ]));
  if (item) {
    output.runtimeItemId = item.runtimeItemId;
    output.legacySlug = item.legacySlug;
  }
  if (raw.slugs !== undefined || raw.runtimeItemIds !== undefined) output.runtimeItemIds = canonicalIds(raw.slugs, raw.runtimeItemIds, indexes, `events[${index}] items`);
  if (raw.wobbledSlugs !== undefined || raw.wobbledRuntimeItemIds !== undefined) output.wobbledRuntimeItemIds = canonicalIds(raw.wobbledSlugs, raw.wobbledRuntimeItemIds, indexes, `events[${index}] wobbles`);
  if (raw.seedSlugs !== undefined || raw.seedRuntimeItemIds !== undefined) output.seedRuntimeItemIds = canonicalIds(raw.seedSlugs, raw.seedRuntimeItemIds, indexes, `events[${index}] seeds`);
  return output;
}

export function normaliseMobileRuntimeSnapshot(rawValue, catalogue) {
  const raw = requireRecord(rawValue, 'Mobile runtime snapshot');
  const indexes = buildIndexes(catalogue);
  if (raw.events !== undefined && !Array.isArray(raw.events)) throw new TypeError('events must be an array.');
  const pattern = raw.pattern === undefined ? {} : requireRecord(raw.pattern, 'pattern');
  return {
    ...structuredClone(without(raw, ['schemaVersion', 'progress', 'guardianMap', 'pattern', 'session', 'summary', 'events'])),
    schemaVersion: 1,
    progress: canonicalKeyed(raw.progress, indexes, 'progress'),
    guardianMap: canonicalKeyed(raw.guardianMap, indexes, 'Guardian map'),
    pattern: {
      ...structuredClone(without(pattern, ['wobbling', 'wobblingByRuntimeItemId'])),
      wobblingByRuntimeItemId: chooseCanonicalKeyed(pattern.wobbling, pattern.wobblingByRuntimeItemId, indexes, 'Pattern wobbling'),
    },
    session: normaliseSession(raw.session, indexes),
    summary: normaliseSummary(raw.summary, indexes),
    events: (raw.events || []).map((event, index) => normaliseEvent(event, indexes, index)),
  };
}

function legacyIds(runtimeIds, indexes) {
  return runtimeIds.map((runtimeItemId) => resolveItem(runtimeItemId, indexes).legacySlug);
}

function legacyKeyed(value, indexes, label, { hasLegacySlug = true } = {}) {
  const output = {};
  for (const [runtimeItemId, rawEntry] of Object.entries(value)) {
    const item = resolveItem(runtimeItemId, indexes);
    if (hasLegacySlug) {
      const entry = requireRecord(rawEntry, `${label} entry`);
      if (entry.legacySlug !== item.legacySlug) throw new TypeError(`${label} legacySlug metadata mismatch.`);
      output[item.legacySlug] = structuredClone(without(entry, ['legacySlug']));
    } else {
      output[item.legacySlug] = structuredClone(rawEntry);
    }
  }
  return output;
}

function legacyItemObject(value, indexes, label) {
  if (value === null) return null;
  const record = requireRecord(value, label);
  const item = resolveItem(record.runtimeItemId, indexes);
  if (record.legacySlug !== item.legacySlug) throw new TypeError(`${label} legacySlug metadata mismatch.`);
  return { ...structuredClone(without(record, ['runtimeItemId', 'legacySlug'])), slug: item.legacySlug };
}

function legacyCurrentCard(value, indexes) {
  if (value === null) return null;
  const raw = requireRecord(value, 'session current card');
  return {
    ...legacyItemObject(raw, indexes, 'session current card'),
    word: legacyItemObject(raw.word, indexes, 'session current card word'),
    prompt: legacyItemObject(raw.prompt, indexes, 'session current card prompt'),
  };
}

function legacySession(value, indexes) {
  if (value === null) return null;
  const raw = requireRecord(value, 'session');
  const keys = [
    'uniqueItemIds', 'queueItemIds', 'statusByRuntimeItemId', 'sentenceHistoryByRuntimeItemId',
    'guardianResultsByRuntimeItemId', 'patternQuestWobbledRuntimeItemIds',
    'patternQuestSeedRuntimeItemIds', 'currentRuntimeItemId', 'currentPrompt', 'currentCard',
    'results', 'patternQuestCards', 'patternQuestResults', 'patternQuestCard',
  ];
  return {
    ...structuredClone(without(raw, keys)),
    uniqueWords: legacyIds(raw.uniqueItemIds, indexes),
    queue: legacyIds(raw.queueItemIds, indexes),
    status: legacyKeyed(raw.statusByRuntimeItemId, indexes, 'session status'),
    sentenceHistory: legacyKeyed(raw.sentenceHistoryByRuntimeItemId, indexes, 'session sentence history'),
    results: raw.results.map((entry) => legacyItemObject(entry, indexes, 'session result')),
    guardianResults: legacyKeyed(raw.guardianResultsByRuntimeItemId, indexes, 'session Guardian results', { hasLegacySlug: false }),
    patternQuestCards: raw.patternQuestCards.map((entry) => legacyItemObject(entry, indexes, 'Pattern Quest card')),
    patternQuestResults: raw.patternQuestResults.map((entry) => legacyItemObject(entry, indexes, 'Pattern Quest result')),
    patternQuestWobbledSlugs: legacyIds(raw.patternQuestWobbledRuntimeItemIds, indexes),
    patternQuestSeedSlugs: legacyIds(raw.patternQuestSeedRuntimeItemIds, indexes),
    currentSlug: raw.currentRuntimeItemId ? resolveItem(raw.currentRuntimeItemId, indexes).legacySlug : null,
    currentPrompt: legacyItemObject(raw.currentPrompt, indexes, 'session current prompt'),
    currentCard: legacyCurrentCard(raw.currentCard, indexes),
    patternQuestCard: legacyItemObject(raw.patternQuestCard, indexes, 'session Pattern Quest card'),
  };
}

function legacyEvent(raw, indexes, index) {
  const output = structuredClone(without(raw, [
    'runtimeItemId', 'legacySlug', 'runtimeItemIds', 'wobbledRuntimeItemIds', 'seedRuntimeItemIds',
  ]));
  if (raw.runtimeItemId) output.wordSlug = resolveItem(raw.runtimeItemId, indexes).legacySlug;
  if (raw.runtimeItemIds) output.slugs = legacyIds(raw.runtimeItemIds, indexes);
  if (raw.wobbledRuntimeItemIds) output.wobbledSlugs = legacyIds(raw.wobbledRuntimeItemIds, indexes);
  if (raw.seedRuntimeItemIds) output.seedSlugs = legacyIds(raw.seedRuntimeItemIds, indexes);
  return requireRecord(output, `events[${index}]`);
}

export function toLegacyEngineSnapshot(rawValue, catalogue) {
  const canonical = normaliseMobileRuntimeSnapshot(rawValue, catalogue);
  const indexes = buildIndexes(catalogue);
  return {
    ...structuredClone(without(canonical, ['schemaVersion', 'progress', 'guardianMap', 'pattern', 'session', 'summary', 'events'])),
    schemaVersion: 0,
    progress: legacyKeyed(canonical.progress, indexes, 'progress'),
    guardianMap: legacyKeyed(canonical.guardianMap, indexes, 'Guardian map'),
    pattern: {
      ...structuredClone(without(canonical.pattern, ['wobblingByRuntimeItemId'])),
      wobbling: legacyKeyed(canonical.pattern.wobblingByRuntimeItemId, indexes, 'Pattern wobbling'),
    },
    session: legacySession(canonical.session, indexes),
    summary: canonical.summary === null ? null : {
      ...structuredClone(without(canonical.summary, ['mistakes'])),
      mistakes: canonical.summary.mistakes.map((entry) => legacyItemObject(entry, indexes, 'summary mistake')),
    },
    events: canonical.events.map((event, index) => legacyEvent(event, indexes, index)),
  };
}

export function fromLegacyEngineSnapshot(legacySnapshot, catalogue) {
  return normaliseMobileRuntimeSnapshot(legacySnapshot, catalogue);
}
