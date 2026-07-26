/* Home hero copy contract, ported from ks2-mastery
 * `src/platform/ui/hero-copy.js` (heroWelcomeLine) and
 * `src/surfaces/home/data.js` (dueCopy).
 *
 * Both strings are byte-for-byte the upstream ones, em-dashes (U+2014)
 * included — the web hero and the port must read as the same voice.
 *
 * `dueCopy` upstream takes a due-today count from the scheduler. The port
 * has no due projection yet (C7.5 lands "where you stand"), so ChildHome
 * feeds it the words that wobbled last time — the same signal the setup
 * screen already uses for Trouble Drill. A learner who has never practised
 * therefore reads "Nothing due today", exactly as a fresh web demo learner
 * does.
 */

export function heroWelcomeLine(name) {
  if (typeof name !== 'string') return '';
  const trimmed = name.trim();
  if (trimmed === '') return '';
  return `Hi ${trimmed} — ready for a short round?`;
}

export function dueCopy(due) {
  const n = Number(due) || 0;
  if (n === 0) return 'Nothing due today — explore for fun.';
  if (n === 1) return 'One word due — one careful try.';
  return `${n} due — you can do this.`;
}

/**
 * "1 secure words" reads as a bug to anyone old enough to be using this, and
 * this app is read by children learning to write English. One helper so the
 * three places that count secure words agree.
 */
export function countWords(count) {
  const n = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  return `${n} ${n === 1 ? 'word' : 'words'}`;
}
