import starterCatalogue from '../../../vendor/ks2-mastery/content/spelling.mobile-runtime-starter.json' with { type: 'json' };

export * from '../../../vendor/ks2-mastery/shared/spelling/mobile/a3/index.js';
export {
  validateSpellingProfile,
} from '../../../vendor/ks2-mastery/shared/spelling/mobile/a3/profile-repository.js';

function freezeCatalogue(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeCatalogue(child);
    Object.freeze(value);
  }
  return value;
}

const READ_ONLY_STARTER_CATALOGUE = freezeCatalogue(starterCatalogue);
let readOnlyFullCataloguePromise = null;

export function loadStarterSpellingCatalogue() {
  return READ_ONLY_STARTER_CATALOGUE;
}

export function loadFullSpellingCatalogue() {
  // The full catalogue (371 KB) has no launch-path consumer; loading it
  // lazily keeps its parse and deep-freeze cost off cold launch.
  readOnlyFullCataloguePromise ??= import(
    '../../../vendor/ks2-mastery/content/spelling.mobile-runtime-full.json',
    { with: { type: 'json' } }
  ).then((module) => freezeCatalogue(module.default));
  return readOnlyFullCataloguePromise;
}
