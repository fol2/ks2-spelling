import fullCatalogue from '../../../vendor/ks2-mastery/content/spelling.mobile-runtime-full.json' with { type: 'json' };
import starterCatalogue from '../../../vendor/ks2-mastery/content/spelling.mobile-runtime-starter.json' with { type: 'json' };

export * from '../../../vendor/ks2-mastery/shared/spelling/mobile/a3/index.js';

function freezeCatalogue(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeCatalogue(child);
    Object.freeze(value);
  }
  return value;
}

const READ_ONLY_STARTER_CATALOGUE = freezeCatalogue(starterCatalogue);
const READ_ONLY_FULL_CATALOGUE = freezeCatalogue(fullCatalogue);

export function loadStarterSpellingCatalogue() {
  return READ_ONLY_STARTER_CATALOGUE;
}

export function loadFullSpellingCatalogue() {
  return READ_ONLY_FULL_CATALOGUE;
}
