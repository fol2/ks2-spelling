import {
  clampCompanionStage,
  HIGHEST_COMPANION_STAGE,
} from './companion-stage-contract.js';

// Painted expedition art, bundled from the repository copy of the frozen
// ks2-mastery authority recorded in provenance/ks2-mastery-art.json. Every URL
// resolves through Vite so the built app carries the bytes locally and never
// reaches for a remote asset.
// No import query is used: Vite already resolves a .webp default export to its
// bundled URL, and a query suffix would leave the dependency-audit module graph
// pointing at a path that does not exist on disk.
const MONSTER_MODULES = import.meta.glob(
  '../../content/mastery-art/monsters/*/*/*.640.webp',
  { eager: true, import: 'default' },
);
const REGION_MODULES = import.meta.glob(
  '../../content/mastery-art/regions/*/*.1280.webp',
  { eager: true, import: 'default' },
);

const MONSTER_FILE = /\/monsters\/([^/]+)\/(b[12])\/[^/]+-(b[12])-(\d)\.640\.webp$/u;
const REGION_FILE = /\/regions\/([^/]+)\/[^/]+-([a-z]\d)\.1280\.webp$/u;

function indexBy(modules, pattern, keyForMatch) {
  const index = new Map();
  for (const [path, url] of Object.entries(modules)) {
    const match = pattern.exec(path);
    if (!match) continue;
    const key = keyForMatch(match);
    if (key) index.set(key, url);
  }
  return index;
}

const MONSTER_ART = indexBy(
  MONSTER_MODULES,
  MONSTER_FILE,
  (match) => match[2] === match[3]
    ? `${match[1]}:${match[2]}:${match[4]}`
    : '',
);
const REGION_ART = indexBy(
  REGION_MODULES,
  REGION_FILE,
  (match) => `${match[1]}:${match[2]}`,
);

export const HIGHEST_MONSTER_STAGE = HIGHEST_COMPANION_STAGE;

/**
 * Resolve the painted art for one companion branch and stage. Stages clamp to
 * the published range and an unknown branch falls back to b1, matching the
 * Monster Stage island's public path contract.
 */
export function monsterArt(monsterId, stage = 0, branch = 'b1') {
  const bounded = clampCompanionStage(stage);
  const resolvedBranch = branch === 'b2' ? 'b2' : 'b1';
  return MONSTER_ART.get(`${monsterId}:${resolvedBranch}:${bounded}`) ?? null;
}

/** Resolve one region plate, for example ('the-scribe-downs', 'a1'). */
export function regionArt(regionId, plate) {
  return REGION_ART.get(`${regionId}:${plate}`) ?? null;
}

/** CSS `url(...)` wrapper that stays inert when the plate is absent. */
export function artUrl(source) {
  return source ? `url("${source}")` : 'none';
}
