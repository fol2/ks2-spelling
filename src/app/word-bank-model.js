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

export const WORD_BANK_VOCAB_SETS = Object.freeze([
  Object.freeze({ id: 'core', label: 'Core' }),
  Object.freeze({ id: 'y3-4', label: 'Y3–4' }),
  Object.freeze({ id: 'y5-6', label: 'Y5–6' }),
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

function matchesFilter(filterId, marks, status) {
  if (filterId === 'all') return true;
  if (filterId === 'due') return marks.due;
  if (filterId === 'trouble') return marks.trouble;
  if (filterId === 'secure') return marks.secure;
  return status === filterId;
}

function matchesVocabSet(vocabSetId, yearBand) {
  if (vocabSetId === 'core') return true;
  if (vocabSetId === 'y3-4') return yearBand === '3-4';
  if (vocabSetId === 'y5-6') return yearBand === '5-6';
  return true;
}

function normaliseQuery(query) {
  return typeof query === 'string' ? query.trim().toLowerCase() : '';
}

function matchesQuery(word, query) {
  if (!query) return true;
  return word.includes(query);
}

/**
 * Project the complete published catalogue into the word bank. Unseen words
 * carry zero attempts, while saved per-word progress fills the same rows.
 */
export function buildWordBank({
  progress = [],
  filter = 'all',
  vocabSet = 'core',
  query = '',
  now = Date.now(),
} = {}) {
  const todayDay = canonicalGuardianDay(now);
  const needle = normaliseQuery(query);
  const activeVocab = WORD_BANK_VOCAB_SETS.find(({ id }) => id === vocabSet)
    ?? WORD_BANK_VOCAB_SETS[0];
  const activeFilter = WORD_BANK_FILTERS.find(({ id }) => id === filter)
    ?? WORD_BANK_FILTERS[0];

  const words = progress.map((item) => {
    const marks = classify(item, todayDay);
    const status = statusOf(marks);
    const word = item.target;
    return {
      runtimeItemId: item.runtimeItemId,
      word,
      yearBand: item.yearBand ?? null,
      status,
      due: marks.due,
      note: noteFor(item, marks),
      rungs: Array.from({ length: HIGHEST_RUNG }, (_, index) => index < item.stage),
      marks,
    };
  });

  const searched = words.filter((entry) => matchesQuery(entry.word.toLowerCase(), needle));
  const inSet = searched.filter((entry) => matchesVocabSet(activeVocab.id, entry.yearBand));
  const rows = inSet.filter((entry) => (
    matchesFilter(activeFilter.id, entry.marks, entry.status)
  ));

  return {
    rows,
    vocabSets: WORD_BANK_VOCAB_SETS.map(({ id, label }) => ({
      id,
      label,
      count: searched.filter((entry) => matchesVocabSet(id, entry.yearBand)).length,
      selected: id === activeVocab.id,
    })),
    filters: WORD_BANK_FILTERS.map(({ id, label }) => ({
      id,
      label,
      count: inSet.filter((entry) => matchesFilter(id, entry.marks, entry.status)).length,
      selected: id === activeFilter.id,
    })),
    total: words.length,
    visibleTotal: inSet.length,
    countLabel: activeFilter.id === 'all' && activeVocab.id === 'core' && !needle
      ? `${words.length} ${words.length === 1 ? 'word' : 'words'}`
      : `${rows.length} of ${words.length}`,
    empty: rows.length === 0,
    emptyHeading: words.length === 0
      ? 'Your word bank is ready'
      : needle && searched.length === 0
        ? 'No matching words'
        : inSet.length === 0
          ? `No ${activeVocab.label} words right now`
          : `No ${activeFilter.label.toLowerCase()} words right now`,
    emptyBody: words.length === 0
      ? 'Walk a round and every word you meet is kept here, on this device.'
      : needle && searched.length === 0
        ? 'Try another spelling, or clear the search to see the full bank.'
        : inSet.length === 0
          ? `Nothing in ${activeVocab.label} is waiting in the bank today.`
          : `Nothing in the bank is marked ${activeFilter.label.toLowerCase()} today. Progress is safe — this set just has nothing waiting.`,
  };
}
