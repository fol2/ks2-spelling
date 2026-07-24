import {
  applySpellingCommand,
  validateCatalogueV1,
  validateSpellingCommandSnapshotV1,
} from '../domain/spelling/index.js';

const LEARNER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
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

function practiceProjection(snapshot) {
  const ui = snapshot?.subjectState?.ui;
  const session = ui?.phase === 'session' ? ui.session : null;
  if (!session) return null;
  return {
    sessionId: session.id,
    label: session.label,
    phase: session.phase,
    runtimeItemId: session.currentRuntimeItemId,
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
}) {
  const ui = snapshot?.subjectState?.ui;
  return cloneFrozen({
    status,
    screen,
    learnerId: snapshot?.learnerId ?? null,
    practice: practiceProjection(snapshot),
    summary: ui?.summary ? structuredClone(ui.summary) : null,
    progress: progressProjection(snapshot, catalogue),
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

  function runCommand(command) {
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
          screen: phase === 'summary'
            ? 'summary'
            : phase === 'session' ? 'practice' : 'home',
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
    startSmartRound(options) {
      if (
        !options ||
        typeof options !== 'object' ||
        Array.isArray(options) ||
        Reflect.ownKeys(options).length !== 1 ||
        !Object.hasOwn(options, 'length') ||
        !ROUND_LENGTHS.includes(options.length)
      ) {
        return Promise.reject(
          new TypeError('Smart Review length must be exactly 5, 10 or 20.'),
        );
      }
      return runCommand({
        type: 'start-session',
        payload: {
          mode: 'smart',
          yearFilter: 'y3-4',
          length: options.length,
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
            'Type the spelling before checking it.',
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
    endRound() {
      return runCommand({
        type: 'end-session',
        payload: {},
      });
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await queue;
      listeners.clear();
    },
  });
}
