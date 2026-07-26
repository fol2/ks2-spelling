import { canonicalGuardianDay } from '../domain/spelling/index.js';

const SECURE_STAGE = 4;
const HIGHEST_RUNG = 5;

export const WORD_BANK_FILTERS = Object.freeze([
  Object.freeze({ id: 'all', label: 'All' }),
  Object.freeze({ id: 'due', label: 'Due' }),
  Object.freeze({ id: 'trouble', label: 'Trouble' }),
  Object.freeze({ id: 'learning', label: 'Learning' }),
  Object.freeze({ id: 'secure', label: 'Secure' }),
]);

// Secure, due and trouble follow the frozen a3 parent projection so the word
// bank and the Parent area can never disagree about a word.
function classify(item, todayDay) {
  const secure = item.stage >= SECURE_STAGE;
  return {
    secure,
    due: item.attempts > 0 && item.dueDay <= todayDay && !secure,
    trouble: item.wrong > 0
      && (item.wrong >= item.correct || item.dueDay <= todayDay),
  };
}

function statusOf(marks) {
  if (marks.trouble) return 'trouble';
  if (marks.secure) return 'secure';
  return 'learning';
}

function noteFor(item, marks) {
  if (item.attempts === 0) return 'Not met yet';
  const revisits = item.wrong === 1 ? '1 to revisit' : `${item.wrong} to revisit`;
  const correct = item.correct === 1 ? '1 correct' : `${item.correct} correct`;
  const tail = item.wrong === 0 ? 'never missed' : revisits;
  return marks.due ? `Due today · ${correct} · ${tail}` : `${correct} · ${tail}`;
}

function matches(filterId, marks, status) {
  if (filterId === 'all') return true;
  if (filterId === 'due') return marks.due;
  if (filterId === 'trouble') return marks.trouble;
  if (filterId === 'secure') return marks.secure;
  return status === filterId;
}

/**
 * Project the complete published catalogue into the word bank. Unseen words
 * carry zero attempts, while saved per-word progress fills the same rows.
 */
export function buildWordBank({
  progress = [],
  filter = 'all',
  now = Date.now(),
} = {}) {
  const todayDay = canonicalGuardianDay(now);
  const words = progress.map((item) => {
    const marks = classify(item, todayDay);
    const status = statusOf(marks);
    return {
      runtimeItemId: item.runtimeItemId,
      word: item.target,
      status,
      due: marks.due,
      note: noteFor(item, marks),
      rungs: Array.from({ length: HIGHEST_RUNG }, (_, index) => index < item.stage),
      marks,
    };
  });
  const rows = words.filter((word) => matches(filter, word.marks, word.status));
  const active = WORD_BANK_FILTERS.find(({ id }) => id === filter)
    ?? WORD_BANK_FILTERS[0];
  return {
    rows,
    filters: WORD_BANK_FILTERS.map(({ id, label }) => ({
      id,
      label,
      count: words.filter((word) => matches(id, word.marks, word.status)).length,
      selected: id === filter,
    })),
    total: words.length,
    countLabel: filter === 'all'
      ? `${words.length} ${words.length === 1 ? 'word' : 'words'}`
      : `${rows.length} of ${words.length}`,
    empty: rows.length === 0,
    emptyHeading: words.length === 0
      ? 'Your word bank is ready'
      : `No ${active.label.toLowerCase()} words right now`,
    emptyBody: words.length === 0
      ? 'Walk a round and every word you meet is kept here, on this device.'
      : `Nothing in the bank is marked ${active.label.toLowerCase()} today. Progress is safe — this set just has nothing waiting.`,
  };
}
