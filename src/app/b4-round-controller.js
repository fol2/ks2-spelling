import { applySpellingCommand } from '../domain/spelling/index.js';
import {
  B4_COMMAND_TRACE,
  B4_RANDOM_DRAWS_BEFORE_COMMAND,
  B4_SEED,
  randomFrom,
} from './b4-round-contract.js';
import { resolveB4AudioPath } from './b4-local-audio.js';

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
    awaitingAdvance: ui.awaitingAdvance === true,
    completedRuntimeItemIds: Object.freeze(completedRuntimeItemIds),
    summary: ui.summary ? structuredClone(ui.summary) : null,
    audio: Object.freeze({ ...audio }),
  });
}

function randomAtCommand(index) {
  const random = randomFrom(B4_SEED);
  for (let draw = 0; draw < B4_RANDOM_DRAWS_BEFORE_COMMAND[index]; draw += 1) random();
  return random;
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

  function stopPlayback() {
    playbackGeneration += 1;
    playAudio.stop();
    audio = { status: 'idle', error: null };
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

  const pauseHandle = lifecycle?.onPause?.(() => stopPlayback()) ?? null;

  async function read() {
    if (disposed) throw controllerError('b4_round_controller_disposed');
    const snapshot = await snapshotStore.read(LEARNER_ID);
    if (snapshot.revision > B4_COMMAND_TRACE.length) {
      throw controllerError('b4_round_contract_revision_invalid');
    }
    return snapshot;
  }

  async function advance() {
    const before = await read();
    if (before.subjectState.ui.phase === 'summary') return viewState(before, audio);
    const command = B4_COMMAND_TRACE[before.revision];
    if (!command) throw controllerError('b4_round_contract_exhausted');
    const plan = await repository.runCommandTransaction(LEARNER_ID, (fresh, context) => {
      if (fresh.revision !== before.revision) {
        throw controllerError('b4_round_revision_changed');
      }
      return applySpellingCommand({
        snapshot: fresh,
        command,
        contentSnapshot: catalogue,
        now: () => context.nowMs,
        random: randomAtCommand(fresh.revision),
      });
    });
    const committed = await read();
    if (committed.revision !== before.revision + 1) {
      throw controllerError('b4_round_commit_missing');
    }
    const effect = plan.transientEffects.find(({ type }) => type === 'audio-cue');
    if (effect) await playCue(effect.payload);
    return viewState(committed, audio);
  }

  return Object.freeze({
    async start() {
      const snapshot = await read();
      return snapshot.revision === 0 ? advance() : viewState(snapshot, audio);
    },
    advance,
    async replay() {
      const snapshot = await read();
      const prompt = snapshot.subjectState.ui.session?.currentPrompt;
      await playCue({
        runtimeItemId: prompt?.runtimeItemId ?? null,
        sentence: prompt?.sentence ?? null,
        slow: false,
      });
      return viewState(snapshot, audio);
    },
    async slowReplay() {
      const snapshot = await read();
      const prompt = snapshot.subjectState.ui.session?.currentPrompt;
      await playCue({
        runtimeItemId: prompt?.runtimeItemId ?? null,
        sentence: prompt?.sentence ?? null,
        slow: true,
      });
      return viewState(snapshot, audio);
    },
    async rehydrate() {
      stopPlayback();
      return viewState(await read(), audio);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      stopPlayback();
      playAudio.dispose?.();
      await pauseHandle?.remove?.();
    },
  });
}
