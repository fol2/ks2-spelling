import { applySpellingCommand } from '../domain/spelling/index.js';
import {
  B4_COMMAND_TRACE,
  B4_RANDOM_DRAWS_BEFORE_COMMAND,
  B4_SEED,
  randomFrom,
} from './b4-round-contract.js';

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

function viewState(snapshot) {
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
  });
}

function randomAtCommand(index) {
  const random = randomFrom(B4_SEED);
  for (let draw = 0; draw < B4_RANDOM_DRAWS_BEFORE_COMMAND[index]; draw += 1) random();
  return random;
}

export function createB4RoundController({ catalogue, repository, snapshotStore } = {}) {
  if (!catalogue || !Array.isArray(catalogue.items)) {
    throw new TypeError('catalogue must contain items.');
  }
  requirePort(repository, 'runCommandTransaction', 'repository');
  requirePort(snapshotStore, 'read', 'snapshotStore');
  let disposed = false;

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
    if (before.subjectState.ui.phase === 'summary') return viewState(before);
    const command = B4_COMMAND_TRACE[before.revision];
    if (!command) throw controllerError('b4_round_contract_exhausted');
    await repository.runCommandTransaction(LEARNER_ID, (fresh, context) => {
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
    return viewState(committed);
  }

  return Object.freeze({
    async start() {
      const snapshot = await read();
      return snapshot.revision === 0 ? advance() : viewState(snapshot);
    },
    advance,
    async rehydrate() { return viewState(await read()); },
    async dispose() { disposed = true; },
  });
}
