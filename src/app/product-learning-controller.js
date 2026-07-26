import {
  applySpellingCommand,
  validateCatalogueV1,
  validateSpellingCommandSnapshotV1,
} from '../domain/spelling/index.js';
import { earlyRoundSummary } from './practice-feel.js';

const LEARNER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
// The vendored contract's own buffered-voice identifiers; the bundled
// listening pack ships exactly these two.
const VOICE_IDS = Object.freeze(['Iapetus', 'Sulafat']);
const SCREENS = Object.freeze([
  'home',
  'setup',
  'practice',
  'summary',
  'progress',
  'monster',
  'camp',
]);
const ROUND_LENGTHS = Object.freeze([5, 10, 20]);
const WORKSHOP_MODES = Object.freeze(['smart', 'trouble', 'test']);
const ROUND_OPTION_KEYS = Object.freeze(['mode', 'length', 'yearFilter']);

function controllerError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireMethod(value, method, label) {
  if (!value || typeof value !== 'object' || typeof value[method] !== 'function') {
    throw new TypeError(`${label}.${method} must be a function.`);
  }
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function cloneFrozen(value) {
  return freezeDeep(structuredClone(value));
}

function parseRoundOptions(value) {
  try {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return null;
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== ROUND_OPTION_KEYS.length ||
      keys.some((key) =>
        typeof key !== 'string' || !ROUND_OPTION_KEYS.includes(key)
      )
    ) {
      return null;
    }
    const options = {};
    for (const key of ROUND_OPTION_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        return null;
      }
      options[key] = descriptor.value;
    }
    return options;
  } catch {
    return null;
  }
}

function nextSnapshot(snapshot, plan) {
  return {
    ...structuredClone(snapshot),
    revision: plan.nextRevision,
    subjectState: structuredClone(plan.nextSubjectState),
    practiceSession: structuredClone(plan.nextPracticeSession),
    eventLog: structuredClone(plan.nextEventLog),
    monsterStateByRewardTrackId: structuredClone(
      plan.nextMonsterStateByRewardTrackId,
    ),
    campStateByPackId: structuredClone(plan.nextCampStateByPackId),
  };
}

function initialScreen(snapshot) {
  return snapshot?.subjectState?.ui?.phase === 'session'
    ? 'practice'
    : snapshot ? 'home' : 'profiles';
}

function practiceProjection(snapshot, catalogue) {
  const ui = snapshot?.subjectState?.ui;
  const session = ui?.phase === 'session' ? ui.session : null;
  if (!session) return null;
  return {
    sessionId: session.id,
    label: session.label,
    mode: session.mode,
    fallbackToSmart: session.fallbackToSmart === true,
    phase: session.phase,
    runtimeItemId: session.currentRuntimeItemId,
    // The year band this word belongs to, for the card's metadata chip.
    yearLabel: catalogue?.items?.find(
      ({ runtimeItemId }) => runtimeItemId === session.currentRuntimeItemId,
    )?.yearLabel ?? '',
    sentence: session.currentPrompt?.sentence ?? '',
    cloze: session.currentPrompt?.cloze ?? '',
    explanation: session.currentPrompt?.explanation ?? '',
    progress: structuredClone(session.progress),
    awaitingAdvance: ui.awaitingAdvance === true,
    feedback: ui.feedback === null ? null : structuredClone(ui.feedback),
  };
}

function progressProjection(snapshot, catalogue) {
  const saved = snapshot?.subjectState?.data?.progress ?? {};
  return catalogue.items
    .filter(({ runtimeItemId }) => Object.hasOwn(saved, runtimeItemId))
    .map(({ runtimeItemId, target }) => {
      const progress = saved[runtimeItemId];
      return {
        runtimeItemId,
        target,
        stage: progress.stage,
        attempts: progress.attempts,
        correct: progress.correct,
        wrong: progress.wrong,
        dueDay: progress.dueDay,
        lastResult: progress.lastResult,
      };
    });
}

function vocabularySetsProjection(catalogue) {
  const core = catalogue.items.filter(
    ({ coverageTier }) => coverageTier === 'statutory-core',
  );
  return [
    { id: 'core', label: 'All', count: core.length },
    {
      id: 'y3-4',
      label: 'Y3–4',
      count: core.filter(({ yearBand }) => yearBand === '3-4').length,
    },
    {
      id: 'y5-6',
      label: 'Y5–6',
      count: core.filter(({ yearBand }) => yearBand === '5-6').length,
    },
  ].filter(({ count }) => count > 0);
}

function monsterProjection(snapshot, catalogue) {
  const saved = snapshot?.monsterStateByRewardTrackId ?? {};
  return catalogue.rewardTracks.map((track) => {
    const state = saved[track.rewardTrackId];
    return {
      rewardTrackId: track.rewardTrackId,
      packId: track.packId,
      monsterId: track.monsterId,
      thresholds: structuredClone(track.thresholds),
      branch: state?.branch ?? null,
      secureCount: state?.secureCount ?? 0,
      caught: state?.caught ?? false,
      derivedStage: state?.derivedStage ?? 0,
      earnedStageHighWater: state?.earnedStageHighWater ?? 0,
    };
  });
}

/**
 * Round preferences live in the A3 snapshot's own prefs bag, so the listening
 * voice, the sentence hint and auto-play all persist per learner with no new
 * storage. `bufferedGeminiVoice` is the contract's existing voice preference.
 *
 * A new learner's seeded bag carries `autoSpeak: false`, which is an engine
 * setting rather than a learner choice — it stops the planner emitting audio
 * cues the app never consumes, because the app drives its own playback. So
 * auto-play only reads as chosen once the learner has actually saved
 * preferences, which the engine's own normaliser marks by writing the full
 * record — `ttsProvider` included. Until then it starts on, as on the web.
 */
function prefsProjection(snapshot) {
  const prefs = snapshot?.subjectState?.data?.prefs ?? {};
  const chosen = Object.hasOwn(prefs, 'ttsProvider');
  return {
    voiceId: VOICE_IDS.includes(prefs.bufferedGeminiVoice)
      ? prefs.bufferedGeminiVoice
      : VOICE_IDS[0],
    showCloze: prefs.showCloze !== false,
    autoSpeak: chosen ? prefs.autoSpeak !== false : true,
  };
}

function campProjection(snapshot) {
  if (!snapshot) return null;
  const saved = snapshot.campStateByPackId[snapshot.packId];
  return {
    packId: snapshot.packId,
    campHighWater: saved?.campHighWater ?? 0,
    lastCreditedGuardianDay: saved?.lastCreditedGuardianDay ?? null,
  };
}

function createState({
  snapshot,
  catalogue,
  status = 'ready',
  screen = initialScreen(snapshot),
  actionError = null,
  summary = null,
}) {
  const ui = snapshot?.subjectState?.ui;
  return cloneFrozen({
    status,
    screen,
    learnerId: snapshot?.learnerId ?? null,
    practice: practiceProjection(snapshot, catalogue),
    prefs: prefsProjection(snapshot),
    summary: summary ?? (ui?.summary ? structuredClone(ui.summary) : null),
    progress: progressProjection(snapshot, catalogue),
    // How many words the active pack holds, so the setup panel can say how
    // much of it the learner has still to meet. The controller owns the
    // catalogue; the view should not have to reach for it.
    packSize: catalogue.items.length,
    vocabularySets: vocabularySetsProjection(catalogue),
    monsters: monsterProjection(snapshot, catalogue),
    camp: campProjection(snapshot),
    actionError,
  });
}

function validateInitialSnapshot(snapshot, catalogue) {
  if (snapshot === null || snapshot === undefined) return null;
  return validateSpellingCommandSnapshotV1(snapshot, catalogue);
}

export function createProductLearningController({
  repository,
  snapshotStore,
  catalogue: candidateCatalogue,
  initialSnapshot = null,
  random,
} = {}) {
  requireMethod(repository, 'runCommandTransaction', 'repository');
  requireMethod(snapshotStore, 'read', 'snapshotStore');
  if (typeof random !== 'function') {
    throw new TypeError('Product learning controller requires random().');
  }
  const catalogue = validateCatalogueV1(candidateCatalogue);
  let snapshot = validateInitialSnapshot(initialSnapshot, catalogue);
  let state = createState({ snapshot, catalogue });
  let queue = Promise.resolve();
  let disposed = false;
  const listeners = new Set();

  function publish(next) {
    state = next;
    for (const listener of listeners) listener(state);
  }

  function publishFromSnapshot(options = {}) {
    publish(createState({
      snapshot,
      catalogue,
      ...options,
    }));
  }

  function enqueue(operation) {
    if (disposed) {
      return Promise.reject(controllerError('product_learning_controller_disposed'));
    }
    const result = queue.then(operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function runCommand(command, options = {}) {
    return enqueue(async () => {
      if (!snapshot) {
        throw controllerError('product_learning_learner_required');
      }
      const previousScreen = state.screen;
      publishFromSnapshot({
        status: 'saving',
        screen: previousScreen,
      });
      try {
        const plan = await repository.runCommandTransaction(
          snapshot.learnerId,
          (fresh, context) => applySpellingCommand({
            snapshot: fresh,
            command,
            contentSnapshot: catalogue,
            now: () => context.nowMs,
            random,
          }),
        );
        snapshot = validateSpellingCommandSnapshotV1(
          nextSnapshot(snapshot, plan),
          catalogue,
        );
        const phase = plan.result.state?.phase;
        publishFromSnapshot({
          // A command that leaves the round phase alone — saving a preference
          // — must leave the learner where they were standing.
          screen: options.keepScreen
            ? previousScreen
            : options.summary || phase === 'summary'
              ? 'summary'
              : phase === 'session' ? 'practice' : 'home',
          summary: options.summary ?? null,
        });
        return plan;
      } catch (error) {
        publishFromSnapshot({
          screen: previousScreen,
          actionError: 'learning_action_failed',
        });
        throw error;
      }
    });
  }

  return Object.freeze({
    getState() {
      return state;
    },
    subscribe(listener) {
      if (typeof listener !== 'function') {
        throw new TypeError('Product learning listener must be a function.');
      }
      if (disposed) throw controllerError('product_learning_controller_disposed');
      listeners.add(listener);
      listener(state);
      let removed = false;
      return Object.freeze({
        remove() {
          if (removed) return;
          removed = true;
          listeners.delete(listener);
        },
      });
    },
    selectLearner(learnerId) {
      if (
        learnerId !== null &&
        (typeof learnerId !== 'string' || !LEARNER_ID.test(learnerId))
      ) {
        return Promise.reject(
          new TypeError('Product learnerId must be null or a canonical identifier.'),
        );
      }
      return enqueue(async () => {
        if (learnerId === null) {
          snapshot = null;
          publishFromSnapshot({ screen: 'profiles' });
          return null;
        }
        const previousScreen = state.screen;
        publishFromSnapshot({
          status: 'loading',
          screen: previousScreen,
        });
        try {
          snapshot = validateSpellingCommandSnapshotV1(
            await snapshotStore.read(learnerId),
            catalogue,
          );
          publishFromSnapshot({ screen: initialScreen(snapshot) });
          return learnerId;
        } catch (error) {
          publishFromSnapshot({
            screen: previousScreen,
            actionError: 'learning_load_failed',
          });
          throw error;
        }
      });
    },
    showScreen(screen) {
      if (!SCREENS.includes(screen)) {
        throw new TypeError('Product learning screen is unsupported.');
      }
      if (!snapshot) throw controllerError('product_learning_learner_required');
      if (state.status === 'saving' || state.status === 'loading') {
        throw controllerError('product_learning_busy');
      }
      publishFromSnapshot({ screen });
      return state;
    },
    startRound(options) {
      const parsed = parseRoundOptions(options);
      if (
        !parsed ||
        !WORKSHOP_MODES.includes(parsed.mode) ||
        !ROUND_LENGTHS.includes(parsed.length) ||
        !state.vocabularySets.some(({ id }) => id === parsed.yearFilter) ||
        (
          parsed.mode === 'test' &&
          (parsed.length !== 20 || parsed.yearFilter !== 'core')
        )
      ) {
        return Promise.reject(
          new TypeError(
            'Workshop round requires a published vocabulary set, mode smart|trouble|test and length 5, 10 or 20; test requires core and 20.',
          ),
        );
      }
      return runCommand({
        type: 'start-session',
        payload: {
          mode: parsed.mode,
          yearFilter: parsed.yearFilter,
          length: parsed.length,
          practiceOnly: false,
          words: [],
        },
      });
    },
    submitAnswer(typed) {
      if (typeof typed !== 'string' || typed.trim() === '') {
        return Promise.reject(
          controllerError(
            'product_answer_required',
            'Type the spelling before you submit it.',
          ),
        );
      }
      return runCommand({
        type: 'submit-answer',
        payload: { typed: typed.trim() },
      });
    },
    continueRound() {
      return runCommand({
        type: 'continue-session',
        payload: {},
      });
    },
    skipWord() {
      return runCommand({
        type: 'skip-word',
        payload: {},
      });
    },
    savePrefs(patch) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return Promise.reject(
          new TypeError('Round preferences must be an object.'),
        );
      }
      if (
        Object.hasOwn(patch, 'voiceId') && !VOICE_IDS.includes(patch.voiceId)
      ) {
        return Promise.reject(
          new TypeError('Listening voice must be a bundled voice.'),
        );
      }
      for (const key of ['showCloze', 'autoSpeak']) {
        if (Object.hasOwn(patch, key) && typeof patch[key] !== 'boolean') {
          return Promise.reject(
            new TypeError(`Round preference ${key} must be boolean.`),
          );
        }
      }
      // The whole visible set goes every time. A partial save would merge over
      // the seeded bag and silently adopt its engine-level auto-play value as
      // the learner's own choice.
      const next = { ...state.prefs, ...patch };
      return runCommand(
        {
          type: 'save-prefs',
          payload: {
            prefs: {
              bufferedGeminiVoice: next.voiceId,
              showCloze: next.showCloze,
              autoSpeak: next.autoSpeak,
            },
          },
        },
        { keepScreen: true },
      );
    },
    endRound() {
      // Ending early is still `end-session` — the contract has no
      // finalise-now command — but the learner lands on a summary of the
      // words they did reach instead of losing the round to a bare discard.
      const summary = earlyRoundSummary(state.practice);
      return runCommand(
        { type: 'end-session', payload: {} },
        summary ? { summary } : {},
      );
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await queue;
      listeners.clear();
    },
  });
}
