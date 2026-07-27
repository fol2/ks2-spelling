import {
  clampCompanionStage,
  HIGHEST_COMPANION_STAGE,
} from './companion-stage-contract.js';

export { HIGHEST_COMPANION_STAGE } from './companion-stage-contract.js';

const DEFAULT_PRESENTATION = Object.freeze({
  name: 'Companion',
  band: 'Trail',
  accent: '#3e6fa8',
  secondary: '#9fc1e8',
  pale: '#e8f0fa',
  blurb: 'Grows as spellings become secure.',
  hint: 'Secure one spelling to wake it',
  legendary: false,
  stages: Object.freeze([
    'Companion Egg',
    'Companion',
    'Growing companion',
    'Strong companion',
    'Grand companion',
  ]),
});

const COMPANION_PRESENTATION = Object.freeze({
  inklet: Object.freeze({
    name: 'Inklet',
    band: 'Years 3–4',
    accent: '#3e6fa8',
    secondary: '#9fc1e8',
    pale: '#e8f0fa',
    blurb: 'Grows as Year 3–4 spellings become secure.',
    hint: 'Secure one Year 3–4 spelling to wake it',
    legendary: false,
    stages: Object.freeze([
      'Inklet Egg',
      'Inklet',
      'Scribbla',
      'Quillorn',
      'Mega Quillorn',
    ]),
  }),
  glimmerbug: Object.freeze({
    name: 'Glimmerbug',
    band: 'Years 5–6',
    accent: '#b43cd9',
    secondary: '#eab3d7',
    pale: '#f8e7f1',
    blurb: 'Appears as Year 5–6 spellings settle into memory.',
    hint: 'Secure one Year 5–6 spelling to wake it',
    legendary: false,
    stages: Object.freeze([
      'Glimmer Egg',
      'Glimmerbug',
      'Lumisprite',
      'Lanternwing',
      'Mega Lanternwing',
    ]),
  }),
  vellhorn: Object.freeze({
    name: 'Vellhorn',
    band: 'Extra',
    accent: '#2e8479',
    secondary: '#8fd6c7',
    pale: '#e5f3ef',
    blurb: 'Appears as Extra spellings stretch beyond the statutory pools.',
    hint: 'Secure one Extra spelling to wake it',
    legendary: false,
    stages: Object.freeze([
      'Vellhorn Egg',
      'Vellhorn',
      'Mossvell',
      'Cresthorn',
      'Mega Cresthorn',
    ]),
  }),
  phaeton: Object.freeze({
    name: 'Phaeton',
    band: 'Legendary',
    accent: '#d08a2c',
    secondary: '#e8c45a',
    pale: '#f6eed7',
    blurb: 'Rises only when both spelling pools grow strong.',
    hint: 'Keep both pools growing to find it',
    legendary: true,
    stages: Object.freeze([
      'Stardrop Egg',
      'Aetherwisp',
      'Cometwing',
      'Starquill Owl',
      'Phaeton',
    ]),
  }),
});

/** One immutable visual/copy authority shared by Trail, Codex and celebrations. */
export function companionPresentation(monsterId) {
  return COMPANION_PRESENTATION[monsterId] ?? DEFAULT_PRESENTATION;
}

export function companionStageName(monsterId, stage = 0) {
  const presentation = companionPresentation(monsterId);
  const bounded = clampCompanionStage(stage);
  return presentation.stages[bounded]
    ?? `${presentation.name} stage ${bounded}`;
}

export function companionPalette(monsterId) {
  const presentation = companionPresentation(monsterId);
  return Object.freeze({
    primary: presentation.accent,
    secondary: presentation.secondary,
    pale: presentation.pale,
  });
}

export function isKnownCompanion(monsterId) {
  return Object.hasOwn(COMPANION_PRESENTATION, monsterId);
}

// Keep the imported stage ceiling live in this module so tree-shaking cannot
// accidentally separate the presentation table from its authored range.
void HIGHEST_COMPANION_STAGE;
