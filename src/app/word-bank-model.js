import { canonicalGuardianDay } from '../domain/spelling/index.js';

const SECURE_STAGE = 4;
const HIGHEST_RUNG = 5;
const MAXIMUM_QUERY_LENGTH = 64;

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

const VOCAB_SET_BY_ID = new Map(
  WORD_BANK_VOCAB_SETS.map((definition) => [definition.id, definition]),
);

// Secure, due and trouble follow the frozen a3 parent projection so the word
// bank and the Parent area can never disagree about a word.
function classify(item, todayDay) {
  const secure = item.stage >= SECURE_STAGE;
  const dueDay = Number.isSafeInteger(item.dueDay) ? item.dueDay : null;
  const dueToday = dueDay !== null && dueDay <= todayDay;
  return {
    secure,
    due: item.attempts > 0 && dueToday && !secure,
    trouble: item.wrong > 0
      && (item.wrong >= item.correct || dueToday),
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
  return false;
}

function inferredVocabSets(words) {
  if (words.length === 0) return WORD_BANK_VOCAB_SETS;
  const ids = new Set(['core']);
  for (const { yearBand } of words) {
    if (yearBand === '3-4') ids.add('y3-4');
    if (yearBand === '5-6') ids.add('y5-6');
  }
  return WORD_BANK_VOCAB_SETS.filter(({ id }) => ids.has(id));
}

// Explicit controller metadata is authoritative when supplied. The Word Bank
// can also stand alone in tests and previews: because progress projects every
// catalogue item, its year bands are a complete and honest fallback authority.
function publishedVocabSets(value, words) {
  const candidates = Array.isArray(value) ? value : inferredVocabSets(words);
  const seen = new Set();
  const published = [];
  for (const candidate of candidates) {
    const definition = VOCAB_SET_BY_ID.get(candidate?.id);
    if (!definition || seen.has(definition.id)) continue;
    seen.add(definition.id);
    published.push({
      id: definition.id,
      label: typeof candidate?.label === 'string' && candidate.label.trim()
        ? candidate.label.trim()
        : definition.label,
    });
  }
  return published.length > 0 ? published : [WORD_BANK_VOCAB_SETS[0]];
}

function searchKey(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-GB')
    .replace(/[‘’]/gu, "'")
    .replace(/[‐‑‒–—―]/gu, '-');
}

function normaliseQuery(query) {
  return searchKey(query).trim().slice(0, MAXIMUM_QUERY_LENGTH);
}

function matchesQuery(word, query) {
  if (!query) return true;
  return searchKey(word).includes(query);
}

function wordCount(value) {
  return `${value} ${value === 1 ? 'word' : 'words'}`;
}

/**
 * Project the complete published catalogue into the word bank. Unseen words
 * carry zero attempts, while saved per-word progress fills the same rows.
 */
export function buildWordBank({
  progress = [],
  filter = 'all',
  vocabSet = 'core',
  vocabularySets,
  query = '',
  now = Date.now(),
} = {}) {
  const todayDay = canonicalGuardianDay(now);
  const needle = normaliseQuery(query);
  const activeFilter = WORD_BANK_FILTERS.find(({ id }) => id === filter)
    ?? WORD_BANK_FILTERS[0];

  const words = progress.map((item) => {
    const marks = classify(item, todayDay);
    const status = statusOf(marks);
    return {
      runtimeItemId: item.runtimeItemId,
      word: item.target,
      yearBand: item.yearBand ?? null,
      status,
      due: marks.due,
      note: noteFor(item, marks),
      rungs: Array.from({ length: HIGHEST_RUNG }, (_, index) => index < item.stage),
      marks,
    };
  });

  const availableVocabSets = publishedVocabSets(vocabularySets, words);
  const activeVocab = availableVocabSets.find(({ id }) => id === vocabSet)
    ?? availableVocabSets[0];
  const inSet = words.filter((entry) => matchesVocabSet(activeVocab.id, entry.yearBand));
  const searched = inSet.filter((entry) => matchesQuery(entry.word, needle));
  const rows = searched.filter((entry) => (
    matchesFilter(activeFilter.id, entry.marks, entry.status)
  ));
  const unfilteredSelection = activeFilter.id === 'all' && !needle;

  return {
    rows,
    vocabSets: availableVocabSets.map(({ id, label }) => ({
      id,
      label,
      count: words.filter((entry) => matchesVocabSet(id, entry.yearBand)).length,
      selected: id === activeVocab.id,
    })),
    filters: WORD_BANK_FILTERS.map(({ id, label }) => ({
      id,
      label,
      count: searched.filter((entry) => matchesFilter(id, entry.marks, entry.status)).length,
      selected: id === activeFilter.id,
    })),
    total: words.length,
    setTotal: inSet.length,
    visibleTotal: searched.length,
    countLabel: unfilteredSelection
      ? wordCount(inSet.length)
      : `${rows.length} of ${inSet.length}`,
    empty: rows.length === 0,
    emptyHeading: words.length === 0
      ? 'Your word bank is ready'
      : inSet.length === 0
        ? `No ${activeVocab.label} words in this catalogue`
        : needle && searched.length === 0
          ? 'No matching words'
          : `No ${activeFilter.label.toLowerCase()} words right now`,
    emptyBody: words.length === 0
      ? 'Walk a round and every word you meet is kept here, on this device.'
      : inSet.length === 0
        ? `This installed catalogue does not publish a ${activeVocab.label} word set.`
        : needle && searched.length === 0
          ? 'Try another spelling, or clear the search to see the full bank.'
          : `Nothing in the bank is marked ${activeFilter.label.toLowerCase()} today. Progress is safe — this set just has nothing waiting.`,
  };
}
