export const SPELLING_COVERAGE_TIERS = Object.freeze([
  'statutory-core',
  'secure-extension',
  'enrichment-extra',
]);

export const SPELLING_COVERAGE_TIER = Object.freeze({
  STATUTORY_CORE: 'statutory-core',
  SECURE_EXTENSION: 'secure-extension',
  ENRICHMENT_EXTRA: 'enrichment-extra',
});

const VALID_COVERAGE_TIERS = new Set(SPELLING_COVERAGE_TIERS);

export function coverageTierFromSpellingPool(spellingPool) {
  return spellingPool === 'extra'
    ? SPELLING_COVERAGE_TIER.ENRICHMENT_EXTRA
    : SPELLING_COVERAGE_TIER.STATUTORY_CORE;
}

export function normaliseCoverageTier(value, { spellingPool = 'core', fallback = '' } = {}) {
  const candidate = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (VALID_COVERAGE_TIERS.has(candidate)) return candidate;
  if (
    candidate === 'secure'
    || candidate === 'secure_extension'
    || candidate === 'secure-extension-candidate'
    || candidate === 'secure_extension_candidate'
  ) {
    return SPELLING_COVERAGE_TIER.SECURE_EXTENSION;
  }
  if (
    candidate === 'extra'
    || candidate === 'enrichment'
    || candidate === 'current_extra'
    || candidate === 'enrichment_extra'
  ) {
    return SPELLING_COVERAGE_TIER.ENRICHMENT_EXTRA;
  }
  if (
    candidate === 'core'
    || candidate === 'statutory'
    || candidate === 'current_statutory_core'
    || candidate === 'statutory_core'
  ) {
    return SPELLING_COVERAGE_TIER.STATUTORY_CORE;
  }
  const fallbackCandidate = typeof fallback === 'string' ? fallback.trim().toLowerCase() : '';
  if (VALID_COVERAGE_TIERS.has(fallbackCandidate)) return fallbackCandidate;
  return coverageTierFromSpellingPool(spellingPool);
}

export function coverageTierForWord(word) {
  if (!word || typeof word !== 'object' || Array.isArray(word)) {
    return SPELLING_COVERAGE_TIER.STATUTORY_CORE;
  }
  return normaliseCoverageTier(word.coverageTier, { spellingPool: word.spellingPool });
}

export function isStatutoryCoreWord(word) {
  return coverageTierForWord(word) === SPELLING_COVERAGE_TIER.STATUTORY_CORE;
}

export function isSecureExtensionWord(word) {
  return coverageTierForWord(word) === SPELLING_COVERAGE_TIER.SECURE_EXTENSION;
}

export function isEnrichmentExtraWord(word) {
  return coverageTierForWord(word) === SPELLING_COVERAGE_TIER.ENRICHMENT_EXTRA;
}

export function coverageTierLabel(value) {
  const tier = normaliseCoverageTier(value);
  if (tier === SPELLING_COVERAGE_TIER.SECURE_EXTENSION) return 'Secure vocabulary';
  if (tier === SPELLING_COVERAGE_TIER.ENRICHMENT_EXTRA) return 'Extra spelling';
  return 'Official statutory spelling';
}

export function coverageTierCounts(words) {
  const counts = {
    statutoryCore: 0,
    secureExtension: 0,
    enrichmentExtra: 0,
    total: 0,
  };
  for (const word of Array.isArray(words) ? words : []) {
    counts.total += 1;
    const tier = coverageTierForWord(word);
    if (tier === SPELLING_COVERAGE_TIER.SECURE_EXTENSION) {
      counts.secureExtension += 1;
    } else if (tier === SPELLING_COVERAGE_TIER.ENRICHMENT_EXTRA) {
      counts.enrichmentExtra += 1;
    } else {
      counts.statutoryCore += 1;
    }
  }
  return counts;
}
