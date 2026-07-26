/* A learner's colour, derived from their name.
 *
 * Every profile created before this carried the same hardcoded teal, so the
 * mark beside a name told you nothing: two children on one device were two
 * identical squares. A colour is only worth drawing if it identifies someone.
 *
 * Derived rather than stored so it is the same colour on every device and can
 * never change under a child — a sibling being removed must not repaint them.
 * The stored `colour` field the profile contract requires is written from this
 * same function at creation, so the two always agree.
 *
 * The six are the Scribe Downs' own hue families, sampled across all five
 * region variants and pulled to ink strength: water teal, dry-grass ochre, sky
 * blue, chalk russet, moss green, dusk indigo. The land has no red and no pink,
 * so neither does this. Ordered cool, warm, cool, warm so the commonest case —
 * two learners — is most likely to land on an obvious contrast.
 */
export const LEARNER_COLOURS = Object.freeze([
  '#1f6f77',
  '#a06b22',
  '#2f6d9e',
  '#a2543a',
  '#3f6b4a',
  '#4d5a97',
]);

export function learnerColour(nickname) {
  const name = typeof nickname === 'string' ? nickname.trim().toLowerCase() : '';
  if (name === '') return LEARNER_COLOURS[0];
  // A plain sum is enough: the set is six wide, the input is a first name, and
  // the only property that matters is that it never moves for a given name.
  let total = 0;
  for (const character of name) total += character.codePointAt(0);
  return LEARNER_COLOURS[total % LEARNER_COLOURS.length];
}
