// "Where you stand" — the six-cell standing panel ks2-mastery shows beside
// its round setup (`.ss-stat-grid`). Every figure is derived from the saved
// progress projection, so this stays a pure read: no clock, no storage, no
// engine call. `todayDay` is passed in because the caller owns the clock —
// the deterministic proofs must be able to pin it.
//
// `stage` mirrors the engine's ladder, where SECURE_STAGE is 4: a word is
// secure once it has climbed that far, and due once its `dueDay` has come
// round. "Unseen" is the rest of the pack the learner has not met yet.

const SECURE_STAGE = 4;

function count(rows, predicate) {
  let total = 0;
  for (const row of rows) if (predicate(row)) total += 1;
  return total;
}

export function whereYouStand(progress, packSize, todayDay) {
  const rows = Array.isArray(progress) ? progress : [];
  const size = Number.isFinite(packSize) ? Math.max(0, Math.trunc(packSize)) : 0;
  const day = Number.isFinite(todayDay) ? Math.trunc(todayDay) : 0;

  const attempts = rows.reduce((sum, row) => sum + (row.attempts ?? 0), 0);
  const correct = rows.reduce((sum, row) => sum + (row.correct ?? 0), 0);

  return Object.freeze([
    Object.freeze({ label: 'Total spellings', value: rows.length }),
    Object.freeze({
      label: 'Secure',
      value: count(rows, (row) => (row.stage ?? 0) >= SECURE_STAGE),
    }),
    Object.freeze({
      label: 'Due today',
      value: count(rows, (row) => (row.dueDay ?? 0) <= day),
      warn: true,
    }),
    Object.freeze({
      label: 'Weak spots',
      value: count(rows, (row) => row.lastResult === 'wrong'),
    }),
    Object.freeze({
      label: 'Unseen',
      value: Math.max(0, size - rows.length),
    }),
    Object.freeze({
      // A learner who has not answered anything yet has no accuracy, which
      // reads better as an em dash than as a confident 0%.
      label: 'Accuracy',
      value: attempts === 0 ? '—' : `${Math.round((correct / attempts) * 100)}%`,
    }),
  ]);
}
