import { applySpellingCommand } from '../domain/spelling/index.js';
import {
  B4_COMMAND_TRACE,
  B4_RUNTIME_ITEM_IDS,
  B4_START_COMMAND,
  randomAtB4Command,
} from './b4-round-contract.js';
import { resolveB4AudioPath } from './b4-local-audio.js';
import { markB4, measureB4 } from './b4-performance-marks.js';

const LEARNER_ID = 'learner-a';

function requirePort(owner, method, label) {
  if (!owner || typeof owner !== 'object' || typeof owner[method] !== 'function') {
    throw new TypeError(`${label}.${method} must be a function.`);
  }
}

function controllerError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function cloneFeedback(feedback) {
  if (!feedback) return null;
  return structuredClone(feedback);
}

function viewState(snapshot, audio) {
  const ui = snapshot.subjectState.ui;
  const session = ui.session;
  const durableSession = session ?? snapshot.practiceSession?.state?.session;
  const completedRuntimeItemIds = Object.entries(
    durableSession?.statusByRuntimeItemId ?? {},
  )
    .filter(([, status]) => status.done === true)
    .map(([runtimeItemId]) => runtimeItemId);
  return Object.freeze({
    phase: ui.phase ?? 'ready',
    revision: snapshot.revision,
    sessionId: session?.id ?? ui.summary?.sessionId ?? null,
    currentRuntimeItemId: session?.currentRuntimeItemId ?? null,
    currentSentence: session?.currentPrompt?.sentence ?? null,
    answerPhase: session?.phase ?? null,
    awaitingAdvance: ui.awaitingAdvance === true,
    completedRuntimeItemIds: Object.freeze(completedRuntimeItemIds),
    completedCards: completedRuntimeItemIds.length,
    totalCards: B4_RUNTIME_ITEM_IDS.length,
    feedback: cloneFeedback(ui.feedback),
    summary: ui.summary ? structuredClone(ui.summary) : null,
    audio: Object.freeze({ ...audio }),
  });
}

function readyState(audio) {
  return Object.freeze({
    phase: 'ready',
    revision: 0,
    sessionId: null,
    currentRuntimeItemId: null,
    currentSentence: null,
    answerPhase: null,
    awaitingAdvance: false,
    completedRuntimeItemIds: Object.freeze([]),
    completedCards: 0,
    totalCards: B4_RUNTIME_ITEM_IDS.length,
    feedback: null,
    summary: null,
    audio: Object.freeze({ ...audio }),
  });
}

export function createB4RoundController({
  catalogue,
  repository,
  snapshotStore,
  audioManifest,
  playAudio,
  lifecycle = null,
} = {}) {
  if (!catalogue || !Array.isArray(catalogue.items)) {
    throw new TypeError('catalogue must contain items.');
  }
  requirePort(repository, 'runCommandTransaction', 'repository');
  requirePort(snapshotStore, 'read', 'snapshotStore');
  if (typeof playAudio !== 'function' || typeof playAudio.stop !== 'function') {
    throw new TypeError('playAudio and playAudio.stop must be functions.');
  }
  let disposed = false;
  let playbackGeneration = 0;
  let audio = { status: 'idle', error: null };
  let currentState = readyState(audio);
  let startPromise = null;
  const listeners = new Set();

  function warmCurrentPrompt(state) {
    if (disposed || !state.currentRuntimeItemId) return;
    if (typeof playAudio.warm !== 'function') return;
    try {
      const { currentRuntimeItemId: runtimeItemId, currentSentence: sentence } = state;
      const paths = [resolveB4AudioPath(audioManifest, { runtimeItemId, sentence: null })];
      if (sentence != null) {
        paths.push(
          resolveB4AudioPath(audioManifest, { runtimeItemId, sentence, slow: false }),
          resolveB4AudioPath(audioManifest, { runtimeItemId, sentence, slow: true }),
        );
      }
      playAudio.warm(paths);
    } catch {
      // Warming is best-effort and must not break the round.
    }
  }

  function publish(state) {
    currentState = state;
    for (const listener of listeners) listener(state);
    warmCurrentPrompt(state);
    return state;
  }

  function stopPlayback() {
    playbackGeneration += 1;
    playAudio.stop();
    // Backgrounding can purge WebKit media buffers, leaving pooled elements
    // unable to reach the playing state; a paused/rehydrated session must
    // start from fresh elements (the next publish re-warms the pool).
    playAudio.flush?.();
    audio = { status: 'idle', error: null };
    publish(Object.freeze({
      ...currentState,
      audio: Object.freeze({ ...audio }),
    }));
  }

  async function playCue(cue) {
    const token = ++playbackGeneration;
    try {
      const path = resolveB4AudioPath(audioManifest, cue);
      const result = await playAudio(path);
      if (token === playbackGeneration) audio = { status: result.status, error: null };
    } catch (error) {
      if (token === playbackGeneration) {
        audio = { status: 'error', error: error?.code ?? 'b4_audio_play_failed' };
      }
    }
  }

  async function replayCurrentPrompt(slow) {
    await playCue({
      runtimeItemId: currentState.currentRuntimeItemId,
      sentence: currentState.currentSentence,
      slow,
    });
    return publish(Object.freeze({
      ...currentState,
      audio: Object.freeze({ ...audio }),
    }));
  }

  const pauseHandle = lifecycle?.onPause?.(() => stopPlayback()) ?? null;

  async function read() {
    if (disposed) throw controllerError('b4_round_controller_disposed');
    return snapshotStore.read(LEARNER_ID);
  }

  async function runCommand(command) {
    markB4('b4:commit-start');
    const before = await read();
    const plan = await repository.runCommandTransaction(LEARNER_ID, (fresh, context) => {
      if (fresh.revision !== before.revision) {
        throw controllerError('b4_round_revision_changed');
      }
      return applySpellingCommand({
        snapshot: fresh,
        command,
        contentSnapshot: catalogue,
        now: () => context.nowMs,
        random: randomAtB4Command(fresh.revision),
      });
    });
    if (plan.nextRevision !== before.revision + 1) {
      throw controllerError('b4_round_commit_missing');
    }
    // The repository has already verified the committed rows match this
    // validated plan, so the committed view derives from the plan without a
    // second full snapshot read over the storage bridge.
    const committed = {
      revision: plan.nextRevision,
      subjectState: plan.nextSubjectState,
      practiceSession: plan.nextPracticeSession,
    };
    measureB4('b4:commit', 'b4:commit-start');
    const state = publish(viewState(committed, audio));
    markB4('b4:state-published');
    measureB4('b4:action-to-publish', 'b4:action-start');
    const effect = plan.transientEffects.find(({ type }) => type === 'audio-cue');
    if (!effect) return state;
    await playCue(effect.payload);
    return publish(viewState(committed, audio));
  }

  async function advance() {
    const before = await read();
    if (before.subjectState.ui.phase === 'summary') {
      return publish(viewState(before, audio));
    }
    const command = B4_COMMAND_TRACE[before.revision];
    if (!command) throw controllerError('b4_round_contract_exhausted');
    return runCommand(command);
  }

  return Object.freeze({
    getState() {
      return currentState;
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function.');
      listeners.add(listener);
      return Object.freeze({ remove() { listeners.delete(listener); } });
    },
    start() {
      startPromise ??= (async () => {
        const snapshot = await read();
        return snapshot.revision === 0
          ? runCommand(B4_START_COMMAND)
          : publish(viewState(snapshot, audio));
      })().finally(() => {
        startPromise = null;
      });
      return startPromise;
    },
    advance,
    async submit(typed) {
      if (typeof typed !== 'string' || typed.trim() === '') {
        throw controllerError('b4_round_answer_required');
      }
      return runCommand({ type: 'submit-answer', payload: { typed: typed.trim() } });
    },
    async continue() {
      return runCommand({ type: 'continue-session', payload: {} });
    },
    async freshRound() {
      const snapshot = await read();
      if (snapshot.subjectState.ui.phase !== 'summary') {
        throw controllerError('b4_round_not_complete');
      }
      return runCommand(B4_START_COMMAND);
    },
    replay() {
      return replayCurrentPrompt(false);
    },
    slowReplay() {
      return replayCurrentPrompt(true);
    },
    async rehydrate() {
      stopPlayback();
      return publish(viewState(await read(), audio));
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      stopPlayback();
      playAudio.dispose?.();
      await pauseHandle?.remove?.();
    },
  });
}
