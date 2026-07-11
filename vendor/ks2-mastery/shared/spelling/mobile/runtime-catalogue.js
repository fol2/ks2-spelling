import { validateCatalogueV1 } from './pack-contracts.js';

export function createLegacyEngineContentSnapshot(value) {
  const catalogue = validateCatalogueV1(value);
  const words = catalogue.items.map((item) => ({
    slug: item.legacySlug,
    legacySlug: item.legacySlug,
    runtimeItemId: item.runtimeItemId,
    itemId: item.itemId,
    packId: item.packId,
    word: item.target,
    accepted: [...item.accepted],
    year: item.yearBand,
    family: item.family,
    familyWords: [...item.familyWords],
    yearLabel: item.yearLabel,
    sentence: item.sentencePrompts[0].text,
    sentences: item.sentencePrompts.map(({ text }) => text),
    explanation: item.explanation,
    patternIds: [...item.patternIds],
    coverageTier: item.coverageTier,
    spellingPool: 'core',
  }));
  return {
    words,
    wordBySlug: Object.fromEntries(words.map((word) => [word.slug, word])),
  };
}
