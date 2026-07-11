import {
  isEnrichmentExtraWord,
  isSecureExtensionWord,
  isStatutoryCoreWord,
} from './content/taxonomy.js';

// Generated from legacy/spelling-engine.source.js.
// This is the preserved English Spelling engine, wrapped as a factory so hosts
// can inject content, storage, audio, clock and random ports explicitly.

export function createLegacySpellingEngine({ words, storage, audio, now, random } = {}) {
  if (typeof now !== 'function') {
    throw new TypeError('Spelling core requires now().');
  }
  if (typeof random !== 'function') {
    throw new TypeError('Spelling core requires random().');
  }
  const runtime = {
    KS2_WORDS_ENRICHED: words || [],
  };
  const storagePort = storage || {
    getItem() { return null; },
    setItem() {},
    removeItem() {},
  };
  // Spelling engine — verbatim port of the scientific selection/scoring/grading
  // pipeline from legacy preview.html. The engine owns pure logic only;
  // rendering lives in spelling-dashboard.jsx / spelling-game.jsx / spelling-summary.jsx.
  //
  // Legacy line refs (line numbers map to /Users/jamesto/Coding/ks2-mastery-legacy/preview.html):
  //   Constants + default progress ......... 786-950
  //   Filters, scoring, bucket selection ... 2119-2279
  //   Sentence shuffling ................... 2004-2068
  //   Session creation + phase flow ........ 2424-2827
  //   enqueueLater / queue weighting ....... 2498-2581
  //   Outcome application .................. 2689-2711, 2871-2891
  //   Summary finalisation ................. 2665-2686, 2911-2930
  //
  // Depends on injected spelling words, metadata, storage and audio ports.

  (function (runtime, storagePort, audio) {
    // ----- constants (verbatim, legacy 788-791) -------------------------------

    var DAY_MS = 24 * 60 * 60 * 1000;
    var STAGE_INTERVALS = [0, 1, 3, 7, 14, 30, 60];
    var SECURE_STAGE = 4;
    var MODES = Object.freeze({ SMART: "smart", TROUBLE: "trouble", TEST: "test", SINGLE: "single" });

    // ----- word list (enriched) -----------------------------------------------

    var WORDS = Array.isArray(runtime.KS2_WORDS_ENRICHED) ? runtime.KS2_WORDS_ENRICHED.slice() : [];
    var WORD_BY_SLUG = Object.create(null);
    for (var i = 0; i < WORDS.length; i++) WORD_BY_SLUG[WORDS[i].slug] = WORDS[i];

    function normaliseFilter(yearFilter) {
      if (yearFilter === "extra") return "extra";
      if (yearFilter === "secure-extension") return "secure-extension";
      if (yearFilter === "y3-4") return "y3-4";
      if (yearFilter === "y5-6") return "y5-6";
      return "core";
    }

    // Runtime pools drive filtering. The y3-4/y5-6 pools stay core-only.
    var POOLS = {
      core: WORDS.filter(function (w) { return isStatutoryCoreWord(w); }),
      "y3-4": WORDS.filter(function (w) { return isStatutoryCoreWord(w) && w.year === "3-4"; }),
      "y5-6": WORDS.filter(function (w) { return isStatutoryCoreWord(w) && w.year === "5-6"; }),
      "secure-extension": WORDS.filter(function (w) { return isSecureExtensionWord(w); }),
      extra: WORDS.filter(function (w) { return isEnrichmentExtraWord(w); }),
    };

    // ----- helpers ------------------------------------------------------------

    function todayDay() { return Math.floor(now() / DAY_MS); }

    function defaultProgress() {
      // Legacy 941-951.
      return {
        stage: 0,
        attempts: 0,
        correct: 0,
        wrong: 0,
        dueDay: todayDay(),
        lastDay: null,
        lastResult: null,
      };
    }

    function normalize(value) { return String(value || "").trim().toLowerCase(); }

    function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

    function buildCloze(sentence, word) {
      var blanks = "_".repeat(Math.max(word.length, 5));
      var pattern = new RegExp("\\b" + escapeRegExp(word) + "\\b", "i");
      return String(sentence || "").replace(pattern, blanks);
    }

    function shuffleInPlace(array) {
      for (var i = array.length - 1; i > 0; i--) {
        var j = Math.floor(random() * (i + 1));
        var tmp = array[i]; array[i] = array[j]; array[j] = tmp;
      }
      return array;
    }

    function stageLabel(stage) {
      if (stage >= SECURE_STAGE) return "Secure";
      if (stage <= 0) return "New / due today";
      var interval = STAGE_INTERVALS[Math.min(stage, STAGE_INTERVALS.length - 1)];
      return "Next review in " + interval + " day" + (interval === 1 ? "" : "s");
    }

    function promptAccepted(value, fallback) {
      var accepted = Array.isArray(value) && value.length ? value.slice() : [fallback];
      return accepted.map(function (entry) { return normalize(entry); }).filter(Boolean);
    }

    function basePromptForm(word) {
      return {
        slug: word.slug,
        promptKey: word.slug,
        word: word.word,
        accepted: promptAccepted(word.accepted, word.slug),
        sentence: word.sentence,
        sentences: Array.isArray(word.sentences) ? word.sentences.slice() : [],
        explanation: word.explanation || "",
      };
    }

    function promptFormsForWord(word) {
      var forms = [basePromptForm(word)];
      if (!isEnrichmentExtraWord(word)) return forms;
      if (!Array.isArray(word.variants)) return forms;
      for (var i = 0; i < word.variants.length; i++) {
        var variant = word.variants[i];
        if (!variant || !variant.word) continue;
        forms.push({
          slug: word.slug,
          promptKey: word.slug + "::" + normalize(variant.word),
          word: variant.word,
          accepted: promptAccepted(variant.accepted, variant.word),
          sentence: variant.sentence,
          sentences: Array.isArray(variant.sentences) ? variant.sentences.slice() : [],
          explanation: variant.explanation || word.explanation || "",
        });
      }
      return forms;
    }

    function choosePromptForm(session, word) {
      if (!session || !session.extraWordFamilies) return basePromptForm(word);
      var forms = promptFormsForWord(word);
      if (forms.length <= 1) return forms[0];
      return forms[Math.floor(random() * forms.length)] || forms[0];
    }

    function wordForCurrentPrompt(session) {
      var word = WORD_BY_SLUG[session && session.currentSlug];
      if (!word) return null;
      var prompt = session.currentPrompt || {};
      if (!prompt.word) return word;
      return Object.assign({}, word, {
        word: prompt.word,
        accepted: promptAccepted(prompt.accepted, prompt.word),
        sentence: prompt.sentence || word.sentence,
        sentences: prompt.sentence ? [prompt.sentence] : word.sentences,
        explanation: prompt.explanation || word.explanation || "",
      });
    }

    // ----- progress persistence (profile-scoped per plan) ---------------------

    var PROGRESS_KEY_PREFIX = "ks2-spell-progress-";

    function progressKey(profileId) { return PROGRESS_KEY_PREFIX + (profileId || "default"); }

    function loadProgress(profileId) {
      try {
        var raw = storagePort.getItem(progressKey(profileId));
        var parsed = raw ? JSON.parse(raw) : {};
        if (!parsed || typeof parsed !== "object") return {};
        // Migration: older records may lack dueDay / lastDay / lastResult.
        // Fill in today so the scheduler treats them as due for review now.
        var today = todayDay();
        for (var slug in parsed) {
          if (!Object.prototype.hasOwnProperty.call(parsed, slug)) continue;
          var record = parsed[slug] || {};
          if (typeof record.dueDay !== "number") record.dueDay = today;
          if (!("lastDay" in record)) record.lastDay = null;
          if (!("lastResult" in record)) record.lastResult = null;
          if (typeof record.stage !== "number") record.stage = 0;
          if (typeof record.attempts !== "number") record.attempts = 0;
          if (typeof record.correct !== "number") record.correct = 0;
          if (typeof record.wrong !== "number") record.wrong = 0;
          parsed[slug] = record;
        }
        return parsed;
      } catch (err) { return {}; }
    }

    function saveProgress(profileId, store) {
      try { storagePort.setItem(progressKey(profileId), JSON.stringify(store)); }
      catch (err) { /* quota/private-mode; ignore */ }
    }

    function progressForSlug(store, slug) {
      var existing = store && store[slug];
      return Object.assign({}, defaultProgress(), existing || {});
    }

    function getProgressFromStore(profileId, slug, progressStore) {
      return progressForSlug(progressStore || loadProgress(profileId), slug);
    }

    function getProgress(profileId, slug) {
      return getProgressFromStore(profileId, slug);
    }

    function setProgress(profileId, slug, record) {
      var store = loadProgress(profileId);
      store[slug] = Object.assign({}, defaultProgress(), record);
      saveProgress(profileId, store);
    }

    function progressFor(profileId) { return loadProgress(profileId); }

    // ----- selection (verbatim legacy 2119-2279) ------------------------------

    function filteredWords(yearFilter) {
      var value = normaliseFilter(yearFilter);
      if (value === "y3-4") return POOLS["y3-4"].slice();
      if (value === "y5-6") return POOLS["y5-6"].slice();
      if (value === "secure-extension") return POOLS["secure-extension"].slice();
      if (value === "extra") return POOLS.extra.slice();
      return POOLS.core.slice();
    }

    function scoreForSmart(profileId, word, progressStore) {
      var p = getProgressFromStore(profileId, word.slug, progressStore);
      var today = todayDay();
      var total = p.correct + p.wrong;
      var score = 0;
      if (p.attempts === 0) score += 65;
      if (p.attempts > 0 && p.dueDay <= today) score += 140 + (today - p.dueDay) * 4;
      if (p.wrong > 0) score += p.wrong * 18;
      if (total > 0) score += (p.wrong / total) * 22;
      score += Math.max(0, 3 - p.stage) * 6;
      score += random();
      return score;
    }

    function scoreForTrouble(profileId, word, progressStore) {
      var p = getProgressFromStore(profileId, word.slug, progressStore);
      var total = p.correct + p.wrong;
      var score = 10;
      if (p.wrong > 0) score += p.wrong * 24;
      if (p.attempts > 0 && p.dueDay <= todayDay()) score += 40 + (todayDay() - p.dueDay) * 3;
      if (p.stage < SECURE_STAGE) score += (SECURE_STAGE - p.stage) * 10;
      if (total > 0) score += (p.wrong / total) * 28;
      score += random();
      return score;
    }

    function smartBucket(profileId, word, progressStore) {
      // Any historical `wrong > 0` routes to fragile before due/new/secure — legacy priority restored by PR #145 (reverts #87).
      var p = getProgressFromStore(profileId, word.slug, progressStore);
      var today = todayDay();
      if (p.wrong > 0 && p.dueDay <= today) return "urgent";
      if (p.wrong > 0) return "fragile";
      if (p.attempts > 0 && p.dueDay <= today) return "due";
      if (p.attempts === 0) return "new";
      if (p.stage < SECURE_STAGE) return "growing";
      return "secure";
    }

    function isTroubleProgress(progress, today) {
      var current = progress || defaultProgress();
      var currentDay = typeof today === "number" ? today : todayDay();
      return current.wrong > 0 && (current.wrong >= current.correct || current.dueDay <= currentDay);
    }

    function weightedPick(items, weightFn) {
      if (!items.length) return null;
      var weights = items.map(function (item) { return Math.max(0, Number(weightFn(item)) || 0); });
      var total = weights.reduce(function (sum, value) { return sum + value; }, 0);
      if (total <= 0) return items[Math.floor(random() * items.length)];
      var roll = random() * total;
      for (var i = 0; i < items.length; i++) {
        roll -= weights[i];
        if (roll <= 0) return items[i];
      }
      return items[items.length - 1];
    }

    function selectionWeight(word, selected, baseScore) {
      var weight = Math.max(0.4, baseScore);
      var last = selected[selected.length - 1];
      var secondLast = selected[selected.length - 2];
      var familyCount = selected.filter(function (item) { return item.family === word.family; }).length;
      var yearCount = selected.filter(function (item) { return item.year === word.year; }).length;
      if (last && last.family === word.family) weight *= 0.16;
      if (last && secondLast && last.year === word.year && secondLast.year === word.year) weight *= 0.72;
      if (familyCount > 0) weight *= Math.max(0.28, 1 / (familyCount + 1));
      if (selected.length >= 4 && (yearCount / selected.length) > 0.75) weight *= 0.78;
      return weight;
    }

    function chooseSmartWords(profileId, opts, progressStore) {
      opts = opts || {};
      var available = filteredWords(opts.yearFilter).slice();
      var store = progressStore || loadProgress(profileId);
      var length = typeof opts.length === "number" ? opts.length : Infinity;
      var target = Math.min(length, available.length);
      var bucketWeights = { urgent: 7, fragile: 5, due: 4, new: 3, growing: 2, secure: 0.7 };
      var selected = [];

      var completionTail = available.filter(function (word) {
        var p = getProgressFromStore(profileId, word.slug, store);
        return p.attempts > 0 && p.stage > 0 && p.stage < SECURE_STAGE;
      });
      if (completionTail.length && completionTail.length <= target) {
        completionTail.sort(function (a, b) {
          var aProgress = getProgressFromStore(profileId, a.slug, store);
          var bProgress = getProgressFromStore(profileId, b.slug, store);
          if (aProgress.stage !== bProgress.stage) return aProgress.stage - bProgress.stage;
          if (aProgress.dueDay !== bProgress.dueDay) return aProgress.dueDay - bProgress.dueDay;
          return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
        });
        for (var tailIndex = 0; tailIndex < completionTail.length; tailIndex++) {
          selected.push(completionTail[tailIndex]);
        }
        var completionTailSlugs = Object.create(null);
        for (var slugIndex = 0; slugIndex < completionTail.length; slugIndex++) {
          completionTailSlugs[completionTail[slugIndex].slug] = true;
        }
        available = available.filter(function (word) { return !completionTailSlugs[word.slug]; });
      }

      while (selected.length < target && available.length) {
        var bucketChoices = Object.keys(bucketWeights).map(function (name) {
          var baseWeight = bucketWeights[name];
          var words = available.filter(function (word) { return smartBucket(profileId, word, store) === name; });
          if (!words.length) return null;
          var recentBuckets = selected.slice(-3).map(function (item) { return smartBucket(profileId, item, store); });
          var repeatPenalty = recentBuckets.filter(function (bucket) { return bucket === name; }).length >= 2 ? 0.5 : 1;
          return { name: name, words: words, weight: baseWeight * repeatPenalty };
        }).filter(Boolean);

        var chosenBucket = weightedPick(bucketChoices, function (bucket) { return bucket.weight; });
        if (!chosenBucket) break;
        var chosenWord = weightedPick(chosenBucket.words, function (word) { return selectionWeight(word, selected, scoreForSmart(profileId, word, store)); });
        if (!chosenWord) break;
        selected.push(chosenWord);
        var idx = available.findIndex(function (word) { return word.slug === chosenWord.slug; });
        if (idx >= 0) available.splice(idx, 1);
      }
      return selected;
    }

    function chooseTroubleWords(profileId, opts, progressStore) {
      opts = opts || {};
      var today = todayDay();
      var store = progressStore || loadProgress(profileId);
      var candidates = filteredWords(opts.yearFilter).filter(function (word) {
        var p = getProgressFromStore(profileId, word.slug, store);
        return isTroubleProgress(p, today);
      });

      if (!candidates.length) {
        return { words: chooseSmartWords(profileId, opts, store), fallback: true };
      }

      var length = typeof opts.length === "number" ? opts.length : Infinity;
      var target = Math.min(length, candidates.length);
      var available = candidates.slice();
      var selected = [];
      while (selected.length < target && available.length) {
        var chosenWord = weightedPick(available, function (word) { return selectionWeight(word, selected, scoreForTrouble(profileId, word, store)); });
        if (!chosenWord) break;
        selected.push(chosenWord);
        var idx = available.findIndex(function (word) { return word.slug === chosenWord.slug; });
        if (idx >= 0) available.splice(idx, 1);
      }
      return { words: selected, fallback: false };
    }

    function chooseTestWords(profileId, opts) {
      opts = opts || {};
      var pool = shuffleInPlace(filteredWords(opts.yearFilter).slice());
      var length = typeof opts.length === "number" ? opts.length : 20;
      return pool.slice(0, Math.min(length, pool.length));
    }

    // ----- sentence shuffling (verbatim legacy 2004-2068) ---------------------

    function shuffledSentenceOrder(length, lastIndex) {
      var order = Array.from({ length: length }, function (_, idx) { return idx; });
      shuffleInPlace(order);
      if (lastIndex !== null && order.length > 1 && order[0] === lastIndex) {
        var swapIndex = 1 + Math.floor(random() * (order.length - 1));
        var tmp = order[0]; order[0] = order[swapIndex]; order[swapIndex] = tmp;
      }
      return order;
    }

    function getOrCreateSentenceHistory(session, word) {
      var sentences = (word.sentences && word.sentences.length) ? word.sentences : [word.sentence].filter(Boolean);
      if (!session || !session.sentenceHistory || !sentences.length) return null;

      var historyKey = word.promptKey || word.slug;
      var history = session.sentenceHistory[historyKey];
      if (!history || !Array.isArray(history.remaining) || !history.remaining.length) {
        var lastIndex = (history && Number.isInteger(history.lastIndex)) ? history.lastIndex : null;
        history = {
          remaining: shuffledSentenceOrder(sentences.length, lastIndex),
          lastIndex: lastIndex,
        };
        session.sentenceHistory[historyKey] = history;
      }
      return history;
    }

    function choosePromptSentence(session, word) {
      var sentences = (word.sentences && word.sentences.length) ? word.sentences : [word.sentence].filter(Boolean);
      if (!sentences.length) return "";
      if (sentences.length === 1) {
        if (session && session.sentenceHistory) session.sentenceHistory[word.slug] = { remaining: [0], lastIndex: 0 };
        return sentences[0];
      }
      if (!session || !session.sentenceHistory) return sentences[Math.floor(random() * sentences.length)];
      var history = getOrCreateSentenceHistory(session, word);
      var nextIndex = history.remaining.shift();
      history.lastIndex = nextIndex;
      session.sentenceHistory[word.promptKey || word.slug] = history;
      return sentences[nextIndex];
    }

    function peekPromptSentenceForSlug(session, slug) {
      var word = WORD_BY_SLUG[slug];
      if (!word) return "";
      var sentences = (word.sentences && word.sentences.length) ? word.sentences : [word.sentence].filter(Boolean);
      if (!sentences.length) return "";
      if (!session || !session.sentenceHistory) return sentences[0];
      var history = getOrCreateSentenceHistory(session, word);
      if (!history || !history.remaining.length) return sentences[0];
      var nextIndex = history.remaining[0];
      return sentences[nextIndex] || sentences[0];
    }

    // ----- session creation + queue management --------------------------------

    function makeSessionId() {
      return "sess-" + now() + "-" + random().toString(16).slice(2);
    }

    function createSession(options) {
      options = options || {};
      var profileId = options.profileId || "default";
      var mode = options.mode || MODES.SMART;
      var yearFilter = mode === MODES.TEST ? "core" : normaliseFilter(options.yearFilter);
      var length = typeof options.length === "number" ? options.length : 20;
      var progressStore = mode === MODES.TEST ? null : loadProgress(profileId);

      var selected = [];
      var actualMode = mode;
      var fallback = false;

      if (Array.isArray(options.words) && options.words.length) {
        selected = options.words.slice();
        actualMode = options.mode || MODES.SINGLE;
      } else if (mode === MODES.TROUBLE) {
        var choice = chooseTroubleWords(profileId, { yearFilter: yearFilter, length: length }, progressStore);
        selected = choice.words;
        fallback = choice.fallback;
        if (fallback) actualMode = MODES.SMART;
      } else if (mode === MODES.TEST) {
        selected = chooseTestWords(profileId, { yearFilter: yearFilter, length: length });
      } else {
        selected = chooseSmartWords(profileId, { yearFilter: yearFilter, length: length }, progressStore);
      }

      if (!selected.length) {
        return { ok: false, reason: "No words were available for that session.", session: null, fallback: fallback };
      }

      var status = Object.create(null);
      if (actualMode !== MODES.TEST) {
        for (var k = 0; k < selected.length; k++) {
          var word = selected[k];
          var progress = getProgressFromStore(profileId, word.slug, progressStore);
          status[word.slug] = {
            attempts: 0,
            successes: 0,
            needed: progress.attempts === 0 ? 2 : 1,
            hadWrong: false,
            wrongAnswers: [],
            done: false,
            applied: false,
          };
        }
      }

      var practiceOnly = Boolean(options.practiceOnly && actualMode !== MODES.TEST);
      var extraWordFamilies = Boolean(options.extraWordFamilies && actualMode !== MODES.TEST && yearFilter === "extra");

      var session = {
        id: makeSessionId(),
        type: actualMode === MODES.TEST ? "test" : "learning",
        mode: actualMode,
        label: practiceOnly ? "Word bank practice"
            : actualMode === MODES.TROUBLE ? "Trouble drill"
            : actualMode === MODES.SINGLE ? "Single-word drill"
            : actualMode === MODES.TEST ? "SATs 20 test"
            : "Smart review",
        practiceOnly: practiceOnly,
        fallbackToSmart: fallback,
        extraWordFamilies: extraWordFamilies,
        profileId: profileId,
        uniqueWords: selected.map(function (w) { return w.slug; }),
        queue: selected.map(function (w) { return w.slug; }),
        status: status,
        results: [], // test mode only
        sentenceHistory: {},
        currentSlug: null,
        currentPrompt: null,
        phase: "question",
        promptCount: 0,
        lastFamily: null,
        lastYear: null,
        startedAt: now(),
      };

      return { ok: true, session: session, fallback: fallback, progressStore: progressStore };
    }

    function candidateWeightForQueueSlug(session, profileId, slug, index, progressStore) {
      var word = WORD_BY_SLUG[slug];
      var progress = getProgressFromStore(profileId, slug, progressStore);
      var info = session.status[slug];
      var weight = Math.max(1, 10 - index);
      if (progress.dueDay <= todayDay()) weight += 14;
      if (progress.wrong > 0) weight += 8;
      if (progress.attempts === 0) weight += 4;
      if (info && info.hadWrong) weight += 12;
      if (session.lastFamily && session.lastFamily === word.family) weight *= 0.18;
      if (session.lastYear && session.lastYear === word.year) weight *= 0.76;
      return Math.max(0.2, weight);
    }

    function chooseNextQueueSlug(session, profileId, progressStore) {
      if (!session || !session.queue.length) return null;
      var windowSize = Math.min(8, session.queue.length);
      var candidates = session.queue.slice(0, windowSize).map(function (slug, index) {
        return { slug: slug, index: index, weight: candidateWeightForQueueSlug(session, profileId, slug, index, progressStore) };
      });
      var picked = weightedPick(candidates, function (item) { return item.weight; });
      if (!picked) return session.queue.shift();
      session.queue.splice(picked.index, 1);
      return picked.slug;
    }

    function enqueueLater(session, slug, gap) {
      if (!session) return;
      gap = typeof gap === "number" ? gap : 2;
      session.queue = session.queue.filter(function (item) { return item !== slug; });
      var word = WORD_BY_SLUG[slug];
      var minPos = Math.min(gap, session.queue.length);
      var maxPos = Math.min(session.queue.length, minPos + 3);
      var position = minPos + Math.floor(random() * (Math.max(0, maxPos - minPos) + 1));
      while (position < session.queue.length
        && WORD_BY_SLUG[session.queue[position]]
        && WORD_BY_SLUG[session.queue[position]].family === word.family) {
        position += 1;
      }
      session.queue.splice(Math.min(position, session.queue.length), 0, slug);
    }

    function setCurrentPrompt(session, slug) {
      if (!session) return null;
      var word = WORD_BY_SLUG[slug];
      if (!word) return null;
      var promptWord = choosePromptForm(session, word);
      var sentence = choosePromptSentence(session, promptWord);
      session.currentSlug = slug;
      session.currentPrompt = {
        slug: slug,
        word: promptWord.word,
        accepted: promptWord.accepted.slice(),
        explanation: promptWord.explanation || word.explanation || "",
        sentence: sentence,
        cloze: buildCloze(sentence, promptWord.word),
      };
      session.lastFamily = word.family;
      session.lastYear = word.year;
      return session.currentPrompt;
    }

    // Mutates session: picks next queue slug, sets current prompt. Returns
    // { done: false, word, prompt } if a card is ready; or { done: true } if
    // the queue is exhausted. Only valid while phase === 'question' (the caller
    // should not call this during retry/correction).
    function advanceCard(session, profileId, progressStore) {
      if (!session) return { done: true };
      if (session.type === "test") {
        if (!session.queue.length) return { done: true };
        var slug = session.queue.shift();
        setCurrentPrompt(session, slug);
        return { done: false, slug: slug, word: wordForCurrentPrompt(session), prompt: session.currentPrompt };
      }

      while (session.queue.length) {
        var nextSlug = chooseNextQueueSlug(session, profileId, progressStore);
        if (!nextSlug) break;
        if (!session.status[nextSlug].done) {
          setCurrentPrompt(session, nextSlug);
          return {
            done: false,
            slug: nextSlug,
            word: wordForCurrentPrompt(session),
            prompt: session.currentPrompt,
          };
        }
      }
      return { done: true };
    }

    // ----- grading ------------------------------------------------------------

    function gradeWord(word, typed) {
      var normalized = normalize(typed);
      var accepted = Array.isArray(word.accepted) ? word.accepted : [word.slug];
      var correct = accepted.indexOf(normalized) >= 0;
      return { correct: correct, typed: String(typed || ""), normalized: normalized };
    }

    // Apply stage/dueDay shift when a learning-mode word concludes (done=true).
    // Returns { prevStage, newStage, justMastered, dueDay }.
    function applyLearningOutcome(profileId, slug, info) {
      if (info && info.applied) return null;
      var progress = getProgress(profileId, slug);
      var prevStage = progress.stage;

      progress.attempts += 1;
      progress.lastDay = todayDay();

      if (info && info.hadWrong) {
        progress.wrong += 1;
        progress.stage = Math.max(0, progress.stage - 1);
        progress.dueDay = todayDay();
        progress.lastResult = "wrong";
      } else {
        progress.correct += 1;
        progress.stage = Math.min(progress.stage + 1, STAGE_INTERVALS.length - 1);
        progress.dueDay = todayDay() + STAGE_INTERVALS[progress.stage];
        progress.lastResult = "correct";
      }

      setProgress(profileId, slug, progress);
      if (info) info.applied = true;

      return {
        prevStage: prevStage,
        newStage: progress.stage,
        justMastered: prevStage < SECURE_STAGE && progress.stage >= SECURE_STAGE,
        dueDay: progress.dueDay,
      };
    }

    function applyTestOutcome(profileId, slug, correct) {
      var progress = getProgress(profileId, slug);
      var prevStage = progress.stage;
      progress.attempts += 1;
      progress.lastDay = todayDay();
      if (correct) {
        progress.correct += 1;
        progress.stage = Math.min(progress.stage + 1, STAGE_INTERVALS.length - 1);
        progress.dueDay = todayDay() + STAGE_INTERVALS[progress.stage];
        progress.lastResult = "correct";
      } else {
        progress.wrong += 1;
        progress.stage = Math.max(0, progress.stage - 1);
        progress.dueDay = todayDay();
        progress.lastResult = "wrong";
      }
      setProgress(profileId, slug, progress);
      return {
        prevStage: prevStage,
        newStage: progress.stage,
        justMastered: prevStage < SECURE_STAGE && progress.stage >= SECURE_STAGE,
        dueDay: progress.dueDay,
      };
    }

    // Resolve a submission in learning mode. Mutates session.phase, queue,
    // status, promptCount. Returns a structured feedback payload for the UI.
    //
    // Legacy parity: preview.html handleLearningSubmit (2713-2827).
    function submitLearning(session, profileId, typed) {
      if (!session || session.type !== "learning") return null;
      var word = wordForCurrentPrompt(session);
      if (!word) return null;
      var info = session.status[word.slug];
      var typedRaw = String(typed == null ? "" : typed).trim();
      if (!typedRaw) return { empty: true };

      var grade = gradeWord(word, typedRaw);
      var correct = grade.correct;

      // ---- Correction phase -------------------------------------------------
      if (session.phase === "correction") {
        if (correct) {
          session.phase = "question";
          session.correctionAttempt = 0;
          enqueueLater(session, word.slug, 2);
          return {
            correct: true,
            phase: "question",
            feedback: {
              kind: "info",
              headline: "Locked in.",
              answer: word.word,
              body: "Good. This word will come back once later for a clean blind check.",
            },
            nextAction: "advance",
          };
        }
        session.correctionAttempt = (session.correctionAttempt || 0) + 1;
        return {
          correct: false,
          phase: "correction",
          feedback: {
            kind: "error",
            headline: "Try again.",
            answer: word.word,
            body: "Type the correct spelling exactly once before moving on.",
          },
          nextAction: "retype",
        };
      }

      session.promptCount += 1;
      info.attempts += 1;

      // ---- Retry phase ------------------------------------------------------
      if (session.phase === "retry") {
        if (correct) {
          session.phase = "question";
          enqueueLater(session, word.slug, 3);
          return {
            correct: true,
            phase: "question",
            feedback: {
              kind: "info",
              headline: "Good recovery.",
              answer: word.word,
              body: "You pulled it back from memory. This word will return later for one clean check.",
            },
            nextAction: "advance",
          };
        }
        info.wrongAnswers.push(typedRaw);
        session.phase = "correction";
        return {
          correct: false,
          phase: "correction",
          feedback: {
            kind: "error",
            headline: "Still not quite.",
            answer: word.word,
            body: "Type it once correctly, then it will come back again later in this round.",
            familyWords: word.familyWords.length > 1 ? word.familyWords.slice() : [],
          },
          nextAction: "retype",
        };
      }

      // ---- Question phase ---------------------------------------------------
      if (correct) {
        info.successes += 1;
        if (info.successes >= info.needed) {
          info.done = true;
          var outcome = null;
          if (session.practiceOnly) {
            info.applied = true;
          } else {
            outcome = applyLearningOutcome(profileId, word.slug, info);
          }
          return {
            correct: true,
            phase: "question",
            feedback: {
              kind: info.hadWrong ? "info" : "success",
              headline: info.hadWrong ? "Correct now." : "Correct.",
              answer: word.word,
              body: session.practiceOnly
                ? "Practice complete. Learner progress was not changed."
                : info.hadWrong
                ? "This word is fixed for this round and will stay due for future review."
                : "This word is secure for today.",
            },
            outcome: outcome,
            nextAction: "advance",
          };
        }
        enqueueLater(session, word.slug, 3);
        return {
          correct: true,
          phase: "question",
          feedback: {
            kind: "info",
            headline: "Good first hit.",
            answer: word.word,
            body: "This word is new for this learner, so it will come back once more in this round.",
          },
          nextAction: "advance",
        };
      }

      // Wrong in the question phase → transition into retry.
      info.hadWrong = true;
      info.successes = 0;
      info.needed = 1;
      info.wrongAnswers.push(typedRaw);
      session.phase = "retry";
      return {
        correct: false,
        phase: "retry",
        feedback: {
          kind: "error",
          headline: "Not quite.",
          body: "No answer shown yet. Hear it again and try once more from memory.",
          footer: "If it is still wrong next time, the correct spelling will appear and the word will come back later for one clean check.",
        },
        nextAction: "retype",
      };
    }

    // Legacy handleTestSubmit (2893-2909). Test mode is single-attempt,
    // no phases, results recorded straight into session.results.
    function submitTest(session, profileId, typed) {
      if (!session || session.type !== "test") return null;
      var word = wordForCurrentPrompt(session);
      if (!word) return null;
      var typedRaw = String(typed == null ? "" : typed).trim();
      var grade = gradeWord(word, typedRaw);
      session.results.push({ slug: word.slug, answer: typedRaw, correct: grade.correct });
      var outcome = applyTestOutcome(profileId, word.slug, grade.correct);
      return {
        correct: grade.correct,
        outcome: outcome,
        feedback: { kind: "info", headline: "Saved.", body: "Moving to the next word." },
        nextAction: "advance",
      };
    }

    function skipCurrent(session) {
      // Legacy "Skip for now" pushes the word 5 positions ahead; no outcome
      // application because the user hasn't attempted it yet (preview.html 3177-3180).
      if (!session || session.type !== "learning") return null;
      if (session.phase !== "question") return null;
      var slug = session.currentSlug;
      if (!slug) return null;
      enqueueLater(session, slug, 5);
      return { nextAction: "advance" };
    }

    // ----- summaries ----------------------------------------------------------

    function learningSummary(session) {
      var entries = Object.keys(session.status).map(function (slug) { return [slug, session.status[slug]]; });
      var total = entries.length;
      var firstTime = entries.filter(function (pair) { return !pair[1].hadWrong; }).length;
      var mistakes = entries
        .filter(function (pair) { return pair[1].hadWrong; })
        .map(function (pair) { return WORD_BY_SLUG[pair[0]]; })
        .filter(Boolean);
      return {
        mode: session.mode,
        label: session.label,
        cards: [
          { label: session.practiceOnly ? "Practice words" : "Words in round", value: total, sub: "Unique words selected" },
          { label: "Clean first attempts", value: firstTime, sub: session.practiceOnly ? "Practice result only" : "Strong on the first go" },
          { label: "Needed correction", value: mistakes.length, sub: "These words came back again" },
          { label: "Prompts heard", value: session.promptCount, sub: "Includes repeats of weak words" },
        ],
        message: session.practiceOnly
          ? "Practice complete. Learner progress was not changed."
          : mistakes.length
          ? "Good. The weak words were caught quickly and are now marked due again for this learner."
          : "Excellent. Every selected word was correct without needing a correction step.",
        mistakes: mistakes,
        elapsedMs: now() - session.startedAt,
      };
    }

    function testSummary(session) {
      var total = session.results.length;
      var correct = session.results.filter(function (r) { return r.correct; }).length;
      var mistakes = session.results
        .filter(function (r) { return !r.correct; })
        .map(function (r) { return WORD_BY_SLUG[r.slug]; })
        .filter(Boolean);
      return {
        mode: session.mode,
        label: session.label,
        cards: [
          { label: "Score", value: correct + "/" + total, sub: "Correct spellings" },
          { label: "Accuracy", value: total ? (Math.round((correct / total) * 100) + "%") : "—", sub: "Single attempt per word" },
          { label: "Correct", value: correct, sub: "Strong on the day" },
          { label: "Needs more work", value: mistakes.length, sub: "Marked due again today" },
        ],
        message: mistakes.length
          ? "The missed words have been pushed back into the learner's due queue, ready for another review today."
          : "Excellent. This learner scored full marks on this SATs-style round.",
        mistakes: mistakes,
        elapsedMs: now() - session.startedAt,
      };
    }

    function finalise(session) {
      if (!session) return null;
      return session.type === "test" ? testSummary(session) : learningSummary(session);
    }

    // ----- aggregate stats ----------------------------------------------------

    function lifetimeStats(profileId, yearFilter, progressStore) {
      var words = filteredWords(yearFilter);
      var today = todayDay();
      var store = progressStore || loadProgress(profileId);
      var secure = 0, due = 0, fresh = 0, trouble = 0, attempts = 0, correct = 0;
      for (var i = 0; i < words.length; i++) {
        var word = words[i];
        var p = progressForSlug(store, word.slug);
        attempts += p.attempts;
        correct += p.correct;
        if (p.attempts === 0) fresh += 1;
        if (p.stage >= SECURE_STAGE) secure += 1;
        if (p.attempts > 0 && p.dueDay <= today) due += 1;
        if (isTroubleProgress(p, today)) trouble += 1;
      }
      return {
        total: words.length,
        secure: secure,
        due: due,
        fresh: fresh,
        trouble: trouble,
        attempts: attempts,
        correct: correct,
        accuracy: attempts ? Math.round((correct / attempts) * 100) : null,
      };
    }

    function statusForWord(profileId, word, progressStore) {
      var p = progressStore ? progressForSlug(progressStore, word.slug) : getProgress(profileId, word.slug);
      var today = todayDay();
      if (p.attempts === 0) return "new";
      if (isTroubleProgress(p, today)) return "trouble";
      if (p.dueDay <= today) return "due";
      if (p.stage >= SECURE_STAGE) return "secure";
      return "learning";
    }

    function countMastered(profileId, wordList, progressStore) {
      var list = Array.isArray(wordList) ? wordList : WORDS;
      var store = progressStore || loadProgress(profileId);
      var count = 0;
      for (var i = 0; i < list.length; i++) {
        var word = list[i];
        var p = progressForSlug(store, word.slug);
        if (p.stage >= SECURE_STAGE) count += 1;
      }
      return count;
    }

    // ----- audio passthrough --------------------------------------------------

    function speak(opts) {
      if (audio && typeof audio.speak === "function") {
        return audio.speak(opts);
      }
      return Promise.resolve();
    }

    function warmup(opts) {
      if (audio && typeof audio.warmup === "function") {
        audio.warmup(opts);
      }
    }

    // ----- public surface -----------------------------------------------------

    runtime.SpellingEngine = {
      // constants
      STAGE_INTERVALS: STAGE_INTERVALS.slice(),
      SECURE_STAGE: SECURE_STAGE,
      MODES: MODES,
      POOLS: POOLS,
      DEFAULT_SET: WORDS.slice(),

      // lookups
      wordBySlug: function (slug) { return WORD_BY_SLUG[slug] || null; },
      allWords: function () { return WORDS.slice(); },
      filteredWords: filteredWords,
      stageLabel: stageLabel,
      statusForWord: statusForWord,

      // session lifecycle
      createSession: createSession,
      advanceCard: advanceCard,
      submitLearning: submitLearning,
      submitTest: submitTest,
      skipCurrent: skipCurrent,
      finalise: finalise,
      enqueueLater: enqueueLater,

      // sentence helpers (for warmup peeking)
      peekPromptSentence: peekPromptSentenceForSlug,

      // grading / progress
      grade: gradeWord,
      normalize: normalize,
      progressFor: progressFor,
      progressForSlug: progressForSlug,
      getProgress: function (profileId, slug) { return getProgress(profileId, slug); },
      resetProgress: function (profileId) { saveProgress(profileId, {}); },
      lifetimeStats: lifetimeStats,
      countMastered: countMastered,

      // audio passthrough
      speak: speak,
      warmup: warmup,

      // diagnostics (helpful in the browser console during dev)
      todayDay: todayDay,
    };
  })(runtime, storagePort, audio);

  return runtime.SpellingEngine;
}
