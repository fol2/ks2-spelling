#!/usr/bin/env python3
from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    source = file.read_text()
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one replacement, found {count}")
    file.write_text(source.replace(old, new, 1))


replace_once(
    "src/app/product-learning-controller.js",
    """    .map(({ runtimeItemId, target, yearBand }) => {
      const progress = saved[runtimeItemId];
      return {
        runtimeItemId,
        target,
        yearBand: yearBand ?? null,
""",
    """    .map(({ runtimeItemId, target, yearBand, coverageTier }) => {
      const progress = saved[runtimeItemId];
      return {
        runtimeItemId,
        target,
        yearBand: yearBand ?? null,
        coverageTier: coverageTier ?? null,
""",
)
replace_once(
    "tests/product-learning-controller.test.mjs",
    """  return catalogue.items.map(({ runtimeItemId, target, yearBand }) => ({
    runtimeItemId,
    target,
    yearBand: yearBand ?? null,
""",
    """  return catalogue.items.map(({ runtimeItemId, target, yearBand, coverageTier }) => ({
    runtimeItemId,
    target,
    yearBand: yearBand ?? null,
    coverageTier: coverageTier ?? null,
""",
)

replace_once(
    "src/app/ProductApp.jsx",
    "function WordBankScreen({ progress, onScreen, onStart }) {",
    "function WordBankScreen({ progress, vocabularySets, onScreen, onStart }) {",
)
replace_once(
    "src/app/ProductApp.jsx",
    """  const bank = useMemo(
    () => buildWordBank({ progress, filter, vocabSet, query }),
    [progress, filter, vocabSet, query],
  );
""",
    """  const bank = useMemo(
    () => buildWordBank({
      progress,
      filter,
      vocabSet,
      vocabularySets,
      query,
    }),
    [progress, filter, vocabSet, vocabularySets, query],
  );
""",
)
replace_once(
    "src/app/ProductApp.jsx",
    "            <span className=\"figure\">{bank.countLabel}</span>",
    """            <span
              id="bank-result-count"
              className="figure"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {bank.countLabel}
            </span>""",
)
replace_once(
    "src/app/ProductApp.jsx",
    """              enterKeyHint="search"
              onChange={(event) => setQuery(event.target.value)}
""",
    """              enterKeyHint="search"
              maxLength={64}
              aria-describedby="bank-result-count"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && query) {
                  event.preventDefault();
                  setQuery('');
                }
              }}
""",
)
replace_once(
    "src/app/ProductApp.jsx",
    """                aria-pressed={option.selected}
                onClick={() => setVocabSet(option.id)}
""",
    """                aria-pressed={option.selected}
                aria-label={`${option.label}, ${option.count} ${option.count === 1 ? 'word' : 'words'}`}
                onClick={() => setVocabSet(option.id)}
""",
)
replace_once(
    "src/app/ProductApp.jsx",
    """                aria-pressed={option.selected}
                onClick={() => setFilter(option.id)}
""",
    """                aria-pressed={option.selected}
                aria-label={`${option.label}, ${option.count} ${option.count === 1 ? 'word' : 'words'}`}
                onClick={() => setFilter(option.id)}
""",
)
replace_once(
    "src/app/ProductApp.jsx",
    """      <WordBankScreen
        progress={learningState.progress}
        onScreen={showScreen}
""",
    """      <WordBankScreen
        progress={learningState.progress}
        vocabularySets={learningState.vocabularySets}
        onScreen={showScreen}
""",
)

replace_once(
    "tests/app-shell.test.mjs",
    """  assert.match(emptyProgressHtml, /id="bank-search-input"/);
  assert.match(emptyProgressHtml, /placeholder="Search spellings"/);
  assert.match(emptyProgressHtml, /aria-label="Vocabulary set"/);
  assert.match(emptyProgressHtml, /aria-label="Filter words"/);
  for (const set of ['Core', 'Y3–4', 'Y5–6']) {
    assert.match(emptyProgressHtml, new RegExp(`>${set}<`));
  }
""",
    """  assert.match(emptyProgressHtml, /id="bank-search-input"/);
  assert.match(emptyProgressHtml, /placeholder="Search spellings"/);
  assert.match(emptyProgressHtml, /maxLength="64"/);
  assert.match(emptyProgressHtml, /aria-describedby="bank-result-count"/);
  assert.match(emptyProgressHtml, /id="bank-result-count"[^>]*role="status"/);
  assert.match(emptyProgressHtml, /aria-label="Vocabulary set"/);
  assert.match(emptyProgressHtml, /aria-label="Filter words"/);
  for (const set of ['Core', 'Y3–4']) {
    assert.match(emptyProgressHtml, new RegExp(`>${set}<`));
  }
  assert.doesNotMatch(emptyProgressHtml, />Y5–6</);
  assert.match(productSource, /vocabularySets=\{learningState\.vocabularySets\}/u);
  assert.match(productSource, /event\.key === 'Escape'/u);
""",
)
