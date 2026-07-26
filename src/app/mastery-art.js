// Painted expedition art, bundled from the repository copy of the frozen
// ks2-mastery authority recorded in provenance/ks2-mastery-art.json. Every URL
// resolves through Vite so the built app carries the bytes locally and never
// reaches for a remote asset.
// No import query is used: Vite already resolves a .webp default export to its
// bundled URL, and a query suffix would leave the dependency-audit module graph
// pointing at a path that does not exist on disk.
const MONSTER_MODULES = import.meta.glob(
  '../../content/mastery-art/monsters/*/b1/*.640.webp',
  { eager: true, import: 'default' },
);
const REGION_MODULES = import.meta.glob(
  '../../content/mastery-art/regions/*/*.1280.webp',
  { eager: true, import: 'default' },
);

const MONSTER_FILE = /\/monsters\/([^/]+)\/b1\/[^/]+-b1-(\d)\.640\.webp$/u;
const REGION_FILE = /\/regions\/([^/]+)\/[^/]+-([a-z]\d)\.1280\.webp$/u;

function indexBy(modules, pattern) {
  const index = new Map();
  for (const [path, url] of Object.entries(modules)) {
    const match = pattern.exec(path);
    if (match) index.set(`${match[1]}:${match[2]}`, url);
  }
  return index;
}

const MONSTER_ART = indexBy(MONSTER_MODULES, MONSTER_FILE);
const REGION_ART = indexBy(REGION_MODULES, REGION_FILE);

export const HIGHEST_MONSTER_STAGE = 4;

/**
 * Resolve the painted art for one companion stage. Stages clamp to the
 * published range so an unexpected stage still renders the creature rather
 * than an empty frame.
 */
export function monsterArt(monsterId, stage = 0) {
  const bounded = Math.max(0, Math.min(HIGHEST_MONSTER_STAGE, Math.trunc(stage) || 0));
  return MONSTER_ART.get(`${monsterId}:${bounded}`) ?? null;
}

/** Resolve one region plate, for example ('the-scribe-downs', 'a1'). */
export function regionArt(regionId, plate) {
  return REGION_ART.get(`${regionId}:${plate}`) ?? null;
}

/** CSS `url(...)` wrapper that stays inert when the plate is absent. */
export function artUrl(source) {
  return source ? `url("${source}")` : 'none';
}
