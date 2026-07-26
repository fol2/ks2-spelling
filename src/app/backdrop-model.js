/* Pure Scribe Downs backdrop helpers.
 *
 * Ported from ks2-mastery spelling hero regions / tones / progress mapping
 * and the platform hero-bg pan constants. Dependency-free so unit tests can
 * import without React or DOM.
 */

export const HERO_PAN_SECONDS = 96;
export const HERO_TRANSITION_MS = 920;

export const HERO_ART_BASE = '/mastery-art/regions/the-scribe-downs';

const CONTRAST_DARK = 'dark';
const CONTRAST_LIGHT = 'light';

export const HERO_REGIONS = Object.freeze({
  smart: Object.freeze(['a', 'b', 'c']),
  trouble: Object.freeze(['d']),
  test: Object.freeze(['e']),
});

export const HERO_TONES = Object.freeze(['1', '2', '3']);

export const HERO_CONTRAST_BY_TONE = Object.freeze({
  1: Object.freeze({
    shell: CONTRAST_DARK,
    controls: CONTRAST_DARK,
    cards: Object.freeze([CONTRAST_DARK, CONTRAST_DARK, CONTRAST_DARK]),
  }),
  2: Object.freeze({
    shell: CONTRAST_LIGHT,
    controls: CONTRAST_LIGHT,
    cards: Object.freeze([CONTRAST_LIGHT, CONTRAST_LIGHT, CONTRAST_LIGHT]),
  }),
  3: Object.freeze({
    shell: CONTRAST_LIGHT,
    controls: CONTRAST_LIGHT,
    cards: Object.freeze([CONTRAST_LIGHT, CONTRAST_LIGHT, CONTRAST_LIGHT]),
  }),
});

export function heroArtUrl(variant) {
  return `${HERO_ART_BASE}/the-scribe-downs-${variant}.1280.webp`;
}

export function spellingHeroMode(mode) {
  if (mode === 'trouble') return 'trouble';
  if (mode === 'test') return 'test';
  return 'smart';
}

function seedIndex(seed, size) {
  const text = String(seed);
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash % size;
}

function regionForMode(mode, seed) {
  const heroMode = spellingHeroMode(mode);
  const regions = HERO_REGIONS[heroMode] || HERO_REGIONS.smart;
  if (regions.length === 1 || seed === null || seed === undefined) {
    return regions[0] || 'a';
  }
  return regions[seedIndex(seed, regions.length)];
}

export function heroBgForMode(mode, options = {}) {
  const region = regionForMode(mode, options.seed);
  const tone = HERO_TONES.includes(String(options.tone))
    ? String(options.tone)
    : '1';
  return heroArtUrl(`${region}${tone}`);
}

export function heroPreloadUrlsForMode(mode) {
  const heroMode = spellingHeroMode(mode);
  const regions = HERO_REGIONS[heroMode] || HERO_REGIONS.smart;
  return regions.flatMap((region) =>
    HERO_TONES.map((tone) => heroArtUrl(`${region}${tone}`)));
}

function progressTotal(progress) {
  const rawTotal = Number(progress?.total ?? 0);
  return Number.isFinite(rawTotal) && rawTotal > 0 ? Math.floor(rawTotal) : 1;
}

export function sessionProgressIndex(progress, options = {}) {
  const total = progressTotal(progress);
  const explicitIndex = Number(options.questionIndex);
  if (Number.isFinite(explicitIndex) && explicitIndex > 0) {
    return Math.min(total, Math.max(1, Math.floor(explicitIndex)));
  }

  const rawDone = Number(progress?.done ?? progress?.checked ?? 0);
  const done = Number.isFinite(rawDone) && rawDone > 0 ? Math.floor(rawDone) : 0;
  const current = done + (options.awaitingAdvance ? 0 : 1);
  return Math.min(total, Math.max(1, current));
}

export function heroToneForProgress(progress, options = {}) {
  if (options.complete) return '3';
  const total = progressTotal(progress);
  const current = sessionProgressIndex(progress, options);
  const firstLimit = Math.max(1, Math.floor(total / HERO_TONES.length));
  const secondLimit = Math.max(
    firstLimit + 1,
    Math.floor((total * 2) / HERO_TONES.length),
  );
  if (current <= firstLimit) return '1';
  if (current <= secondLimit) return '2';
  return '3';
}

export function heroBgStyle(url) {
  return url ? { '--hero-bg': `url('${url}')` } : {};
}

export function heroPanDelayStyle() {
  if (typeof performance === 'undefined') return {};
  const elapsed = (performance.now() / 1000) % (HERO_PAN_SECONDS * 2);
  return { '--hero-pan-delay': `-${elapsed.toFixed(3)}s` };
}
