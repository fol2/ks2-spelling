import {
  applySpellingCommand,
  canonicalGuardianDay,
  projectSpellingRevisionMission,
  validateCatalogueV1,
  validateSpellingCommandSnapshotV1,
} from '../domain/spelling/index.js';
import { setupExpeditionCompanion } from './codex-model.js';
import { earlyRoundSummary, spellingOnly } from './practice-feel.js';
import { achievementChips } from './records-model.js';

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

const EMPTY_RECORDS = freezeDeep({ milestones: [] });

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
    .map(({ runtimeItemId, target, yearBand, coverageTier }) => {
      const progress = saved[runtimeItemId];
      return {
        runtimeItemId,
        target,
        yearBand: yearBand ?? null,
        coverageTier: coverageTier ?? null,
        stage: progress?.stage ?? 0,
        attempts: progress?.attempts ?? 0,
        correct: progress?.correct ?? 0,
        wrong: progress?.wrong ?? 0,
        dueDay: progress?.dueDay ?? null,
        lastResult: progress?.lastResult ?? null,
      };
    });
}

function vocabularySetsProjection(catalogue) {
  const core = catalogue.items.filter(
    ({ coverageTier }) =>
      coverageTier == null || coverageTier === 'statutory-core',
  );
  return [
    { id: 'core', label: 'Core', count: core.length },
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

function withRoundYearFilter(practice, roundBaseline) {
  if (!practice) return null;
  return {
    ...practice,
    yearFilter: roundBaseline?.yearFilter ?? null,
  };
}

function adoptRoundBaseline(candidate, snapshot) {
  if (
    !candidate ||
    snapshot?.subjectState?.ui?.phase !== 'session' ||
    candidate.sessionId !== snapshot.subjectState.ui.session.id
  ) {
    return null;
  }
  return {
    sessionId: candidate.sessionId,
    companionRewardTrackId:
      typeof candidate.companionRewardTrackId === 'string' && candidate.companionRewardTrackId.length > 0
        ? candidate.companionRewardTrackId
        : null,
    yearFilter: typeof candidate.yearFilter === 'string' && candidate.yearFilter.length > 0
      ? candidate.yearFilter
      : null,
    achievementIds: Array.isArray(candidate.achievementIds)
      ? candidate.achievementIds.filter(
        (id) => typeof id === 'string' && id.length > 0,
      )
      : [],
    monsters: candidate.monsters,
    camp: candidate.camp ?? null,
  };
}

function createState({
  snapshot,
  catalogue,
  status = 'ready',
  screen = initialScreen(snapshot),
  actionError = null,
  summary = null,
  roundBaseline = null,
  revisionMission = null,
  achievements = [],
  records = EMPTY_RECORDS,
}) {
  const ui = snapshot?.subjectState?.ui;
  const camp = campProjection(snapshot);
  // Achievements and records stay outside cloneFrozen so same-revision
  // publishes keep the memoised identities their views and tests rely on.
  return Object.freeze({
    ...cloneFrozen({
      status,
      screen,
      learnerId: snapshot?.learnerId ?? null,
      practice: withRoundYearFilter(
        practiceProjection(snapshot, catalogue),
        roundBaseline,
      ),
      prefs: prefsProjection(snapshot),
      summary: summary ?? (ui?.summary ? structuredClone(ui.summary) : null),
      progress: progressProjection(snapshot, catalogue),
      // How many words the active pack holds, so the setup panel can say how
      // much of it the learner has still to meet. The controller owns the
      // catalogue; the view should not have to reach for it.
      packSize: catalogue.items.length,
      vocabularySets: vocabularySetsProjection(catalogue),
      monsters: monsterProjection(snapshot, catalogue),
      revisionMission,
      camp: camp === null ? null : {
        ...camp,
        canEarnToday: revisionMission?.canStartRewardBearing ?? false,
      },
      roundBaseline,
      actionError,
    }),
    achievements,
    records,
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
  roundBaselineStore = null,
  initialRoundBaseline = null,
  random,
  now = Date.now,
} = {}) {
  requireMethod(repository, 'runCommandTransaction', 'repository');
  requireMethod(snapshotStore, 'read', 'snapshotStore');
  if (typeof random !== 'function') {
    throw new TypeError('Product learning controller requires random().');
  }
  if (typeof now !== 'function') {
    throw new TypeError('Product learning controller now must be a function.');
  }
  if (
    roundBaselineStore !== null &&
    (typeof roundBaselineStore !== 'object' ||
      typeof roundBaselineStore.read !== 'function' ||
      typeof roundBaselineStore.write !== 'function')
  ) {
    throw new TypeError('roundBaselineStore must expose read() and write().');
  }
  const catalogue = validateCatalogueV1(candidateCatalogue);
  let snapshot = validateInitialSnapshot(initialSnapshot, catalogue);
  let revisionMissionCache = null;
  let achievementsCache = null;
  let recordsCache = null;
  const emptyAchievements = Object.freeze([]);

  function revisionMissionProjection() {
    if (!snapshot) return null;
    const nowMs = now();
    const todayGuardianDay = canonicalGuardianDay(nowMs);
    if (
      revisionMissionCache?.revision === snapshot.revision &&
      revisionMissionCache.todayGuardianDay === todayGuardianDay
    ) {
      return revisionMissionCache.value;
    }
    const value = projectSpellingRevisionMission({
      snapshot,
      contentSnapshot: catalogue,
      nowMs,
    });
    revisionMissionCache = { revision: snapshot.revision, todayGuardianDay, value };
    return value;
  }

  function achievementsProjection() {
    if (!snapshot) return emptyAchievements;
    if (achievementsCache?.revision === snapshot.revision) {
      return achievementsCache.value;
    }
    const value = freezeDeep(achievementChips(
      snapshot.subjectState?.data?.achievements ?? {},
    ));
    achievementsCache = { revision: snapshot.revision, value };
    return value;
  }

  function recordsProjection() {
    if (!snapshot) return EMPTY_RECORDS;
    if (recordsCache?.revision === snapshot.revision) {
      return recordsCache.value;
    }
    const value = freezeDeep({
      milestones: snapshot.eventLog
        .filter(
          (record) =>
            record.type === 'spelling.mastery-milestone'
            && Number.isSafeInteger(record.milestone),
        )
        .map(({ milestone, sessionId, createdAt }) => ({
          milestone,
          sessionId,
          createdAt,
        })),
    });
    recordsCache = { revision: snapshot.revision, value };
    return value;
  }

  // Round-start roster, kept so summary celebrations survive relaunch mid-round.
  let roundBaseline = adoptRoundBaseline(initialRoundBaseline, snapshot);
  let state = createState({
    snapshot,
    catalogue,
    roundBaseline,
    revisionMission: revisionMissionProjection(),
    achievements: achievementsProjection(),
    records: recordsProjection(),
  });
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
      roundBaseline,
      revisionMission: revisionMissionProjection(),
      achievements: achievementsProjection(),
      records: recordsProjection(),
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
        if (options.captureBaseline === true && phase === 'session') {
          const monsters = monsterProjection(snapshot, catalogue);
          roundBaseline = {
            sessionId: snapshot.subjectState.ui.session.id,
            companionRewardTrackId: setupExpeditionCompanion(
              monsters,
              options.companionYearFilter ?? null,
            )?.rewardTrackId ?? null,
            yearFilter: options.companionYearFilter ?? null,
            achievementIds: achievementChips(
              snapshot.subjectState?.data?.achievements ?? {},
            ).map((chip) => chip.id),
            monsters,
            camp: campProjection(snapshot),
          };
          if (roundBaselineStore) {
            void roundBaselineStore.write(snapshot.learnerId, {
              schemaVersion: 1,
              learnerId: snapshot.learnerId,
              ...roundBaseline,
            }).catch(() => undefined);
          }
        }
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
          revisionMissionCache = null;
          achievementsCache = null;
          recordsCache = null;
          roundBaseline = null;
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
          revisionMissionCache = null;
          achievementsCache = null;
          recordsCache = null;
          roundBaseline = null;
          if (
            roundBaselineStore &&
            snapshot.subjectState?.ui?.phase === 'session'
          ) {
            const stored = await roundBaselineStore.read(learnerId).catch(
              () => null,
            );
            roundBaseline = adoptRoundBaseline(stored, snapshot);
          }
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
    // The controller owns the catalogue, so the Word Bank detail asks it what
    // the pack says about one word rather than reaching for a pack of its own
    // — which is also the only way the detail can never disagree with the
    // round about the word a learner is looking at. The reply is a frozen
    // copy: content to read, never a handle on the loaded catalogue.
    wordMaterial(runtimeItemId) {
      const item = catalogue.items.find(
        (candidate) => candidate.runtimeItemId === runtimeItemId,
      );
      return item ? cloneFrozen(item) : null;
    },
    // Practising one word from the Word Bank is the engine's own single-word
    // drill: `words` names the item, and `practiceOnly` is what upstream calls
    // "Word bank practice" — a rehearsal that moves neither the review
    // schedule, the companions nor Camp. The baseline is captured all the
    // same, because the summary this round ends on reads the round-start
    // roster, and a stale one would replay the last round's celebrations.
    practiseWord(runtimeItemId) {
      if (!catalogue.items.some((item) => item.runtimeItemId === runtimeItemId)) {
        return Promise.reject(
          new TypeError('Word bank practice requires a word this pack publishes.'),
        );
      }
      return runCommand({
        type: 'start-session',
        payload: {
          mode: 'single',
          words: [runtimeItemId],
          practiceOnly: true,
        },
      }, { captureBaseline: true });
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
      }, { captureBaseline: true, companionYearFilter: parsed.yearFilter });
    },
    startGuardianMission(options = {}) {
      const intent = options?.intent;
      if (
        intent !== undefined &&
        intent !== 'reward-bearing' &&
        intent !== 'unrewarded'
      ) {
        return Promise.reject(
          new TypeError(
            'Guardian Mission intent must be reward-bearing or unrewarded.',
          ),
        );
      }
      if (!snapshot) {
        return Promise.reject(controllerError('product_learning_learner_required'));
      }
      const mission = projectSpellingRevisionMission({
        snapshot,
        contentSnapshot: catalogue,
        nowMs: now(),
      });
      const available = intent === 'unrewarded'
        ? mission.canContinueUnrewarded
        : mission.canStartRewardBearing;
      if (!available) {
        return Promise.reject(controllerError('guardian_mission_unavailable'));
      }
      const previousScreen = state.screen;
      const payload = intent === 'unrewarded'
        ? { mode: 'guardian', revisionIntent: 'unrewarded' }
        : { mode: 'guardian' };
      return runCommand(
        { type: 'start-session', payload },
        { captureBaseline: true },
      ).then((plan) => {
        if (plan.changed !== false) return plan;
        publishFromSnapshot({
          screen: previousScreen,
          actionError: 'guardian_mission_unavailable',
        });
        throw controllerError('guardian_mission_unavailable');
      });
    },
    submitAnswer(typed) {
      const spelling = spellingOnly(typed);
      if (spelling === '') {
        return Promise.reject(
          controllerError(
            'product_answer_required',
            'Type the spelling before you submit it.',
          ),
        );
      }
      return runCommand({
        type: 'submit-answer',
        payload: { typed: spelling },
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
