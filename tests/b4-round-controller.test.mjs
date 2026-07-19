import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  loadStarterSpellingCatalogue,
  validateSpellingCommandSnapshotV1,
} from '../src/domain/spelling/index.js';
import {
  B4_AUDIO_AUTHORITY,
  B4_COMMAND_TRACE,
  B4_PRODUCT_IDENTIFIER,
  B4_RUNTIME_ITEM_IDS,
  B4_SEED,
  B4_START_TIMESTAMP,
  B4_SENTENCE_PROMPTS,
  B4_SUMMARY,
  characteriseB4Round,
  createB4AudioInventory,
} from '../src/app/b4-round-contract.js';
import { createB4AppServices } from '../src/app/create-b4-app-services.js';
import { createB4LearnerAction } from '../src/app/b4-learner-action.js';
import { createB4RoundController } from '../src/app/b4-round-controller.js';
import { randomFrom } from './fixtures/b2-command-scenarios.mjs';
import { createNodeSqliteConnection } from './helpers/node-sqlite-connection.mjs';

function createLifecycle() {
  const listeners = { pause: new Set(), resume: new Set(), state: new Set() };
  function subscribe(kind, listener) {
    listeners[kind].add(listener);
    return Object.freeze({ async remove() { listeners[kind].delete(listener); } });
  }
  return Object.freeze({
    onPause: (listener) => subscribe('pause', listener),
    onResume: (listener) => subscribe('resume', listener),
    onStateChange: (listener) => subscribe('state', listener),
    getState: () => Object.freeze({ canonicalState: 'test', diagnosticStateChanges: [] }),
    async dispose() { for (const set of Object.values(listeners)) set.clear(); },
  });
}

function freshSnapshot(autoSpeak) {
  return validateSpellingCommandSnapshotV1({
    schemaVersion: 1,
    learnerId: 'learner-a',
    revision: 0,
    packId: 'ks2-core',
    catalogueId: 'ks2-core:starter',
    grantedEntitlementIds: [],
    subjectState: {
      ui: {},
      data: {
        prefs: { autoSpeak },
        progress: {},
        guardianMap: {},
        pattern: { wobblingByRuntimeItemId: {} },
        postMega: null,
        achievements: {},
        persistenceWarning: null,
      },
    },
    practiceSession: null,
    eventLog: [],
    monsterStateByRewardTrackId: {},
    campStateByPackId: {},
  }, loadStarterSpellingCatalogue());
}

function commit(snapshot, plan) {
  return validateSpellingCommandSnapshotV1({
    ...structuredClone(snapshot),
    revision: plan.nextRevision,
    subjectState: plan.nextSubjectState,
    practiceSession: plan.nextPracticeSession,
    eventLog: plan.nextEventLog,
    monsterStateByRewardTrackId: plan.nextMonsterStateByRewardTrackId,
    campStateByPackId: plan.nextCampStateByPackId,
  }, loadStarterSpellingCatalogue());
}

function placeholderManifest() {
  return {
    schemaVersion: 1,
    productIdentifier: B4_PRODUCT_IDENTIFIER,
    authority: B4_AUDIO_AUTHORITY,
    authoritySha256: '1'.repeat(64),
    traceSha256: '2'.repeat(64),
    assetCount: 25,
    assets: createB4AudioInventory().map((asset) => ({
      ...asset,
      byteSize: 1,
      inputSha256: '3'.repeat(64),
      generationSpecSha256: '4'.repeat(64),
      assetSha256: '5'.repeat(64),
    })),
  };
}

function silentPlayer(calls = []) {
  const play = async (path) => {
    calls.push(path);
    return { status: 'playing', path };
  };
  play.stop = () => calls.push('stop');
  play.dispose = () => calls.push('dispose');
  return play;
}

test('frozen B4 characterisation is the genuine deterministic A3 clean round', () => {
  assert.equal(B4_SEED, 42);
  assert.deepEqual(B4_RUNTIME_ITEM_IDS, [
    'ks2-core:answer',
    'ks2-core:appear',
    'ks2-core:arrive',
    'ks2-core:bicycle',
    'ks2-core:build',
  ]);
  const characterised = characteriseB4Round({ randomFrom });
  assert.deepEqual(characterised.commandTrace, B4_COMMAND_TRACE);
  assert.deepEqual(characterised.sentencePrompts, B4_SENTENCE_PROMPTS);
  assert.deepEqual(characterised.summary, B4_SUMMARY);
  assert.equal(B4_COMMAND_TRACE.length, 21);
  assert.equal(B4_COMMAND_TRACE.filter(({ type }) => type === 'submit-answer').length, 10);
});

test('headless B4 services commit, rehydrate mid-round and complete five cards', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-b4-round-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'round.sqlite');
  const options = {
    connectionFactory: () => createNodeSqliteConnection(databasePath),
    lifecycleFactory: createLifecycle,
    audioManifest: placeholderManifest(),
    playAudio: silentPlayer(),
  };

  let services = await createB4AppServices(options);
  assert.equal(services.mode, 'b4-starter-product');
  let state = await services.controller.start();
  assert.equal(state.revision, 1);
  while (state.revision < 9) state = await services.controller.advance();
  const sessionId = state.sessionId;
  const runtimeItemId = state.currentRuntimeItemId;
  await services.dispose();

  services = await createB4AppServices(options);
  t.after(() => services.dispose());
  state = await services.controller.rehydrate();
  assert.equal(state.revision, 9);
  assert.equal(state.sessionId, sessionId);
  assert.equal(state.currentRuntimeItemId, runtimeItemId);
  while (state.phase !== 'summary') state = await services.controller.advance();

  assert.equal(state.revision, B4_COMMAND_TRACE.length);
  assert.deepEqual(state.summary, B4_SUMMARY);
  assert.deepEqual(
    [...state.completedRuntimeItemIds].sort(),
    [...B4_RUNTIME_ITEM_IDS].sort(),
  );
  const durable = await services.snapshotStore.read('learner-a');
  assert.equal(durable.revision, B4_COMMAND_TRACE.length);
  assert.deepEqual(durable.subjectState.ui.summary, B4_SUMMARY);
});

test('concurrent React start effects share one durable session start', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-b4-concurrent-start-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const services = await createB4AppServices({
    connectionFactory: () => createNodeSqliteConnection(join(directory, 'round.sqlite')),
    lifecycleFactory: createLifecycle,
    audioManifest: placeholderManifest(),
    playAudio: silentPlayer(),
  });
  t.after(() => services.dispose());

  const [first, second] = await Promise.all([
    services.controller.start(),
    services.controller.start(),
  ]);
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 1);
  assert.equal((await services.snapshotStore.read('learner-a')).revision, 1);
});

test('real typed answers follow durable retry feedback and continue the committed card', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-b4-real-answer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'round.sqlite');
  const options = {
    connectionFactory: () => createNodeSqliteConnection(databasePath),
    lifecycleFactory: createLifecycle,
    audioManifest: placeholderManifest(),
    playAudio: silentPlayer(),
  };
  let services = await createB4AppServices(options);
  let state = await services.controller.start();
  const committedRuntimeItemId = state.currentRuntimeItemId;
  const target = loadStarterSpellingCatalogue().items.find(
    ({ runtimeItemId }) => runtimeItemId === committedRuntimeItemId,
  ).target;

  state = await services.controller.submit('definitely-wrong');
  assert.equal(state.currentRuntimeItemId, committedRuntimeItemId);
  assert.equal(state.answerPhase, 'retry');
  assert.equal(state.awaitingAdvance, false);
  assert.equal(state.feedback.kind, 'error');
  assert.match(state.feedback.headline, /not quite/i);

  state = await services.controller.submit(target);
  assert.equal(state.currentRuntimeItemId, committedRuntimeItemId);
  assert.equal(state.awaitingAdvance, true);
  assert.notEqual(state.feedback.kind, 'error');
  const revision = state.revision;
  await services.dispose();

  services = await createB4AppServices(options);
  t.after(() => services.dispose());
  state = await services.controller.rehydrate();
  assert.equal(state.revision, revision);
  assert.equal(state.currentRuntimeItemId, committedRuntimeItemId);
  assert.equal(state.awaitingAdvance, true);

  state = await services.controller.continue();
  assert.equal(state.revision, revision + 1);
  assert.equal(state.awaitingAdvance, false);
});

test('the learner form action completes the genuine five-card domain round', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-b4-form-round-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const services = await createB4AppServices({
    connectionFactory: () => createNodeSqliteConnection(join(directory, 'round.sqlite')),
    lifecycleFactory: createLifecycle,
    audioManifest: placeholderManifest(),
    playAudio: silentPlayer(),
  });
  t.after(() => services.dispose());
  const catalogue = loadStarterSpellingCatalogue();
  let state = await services.controller.start();
  let answer = '';
  const errors = [];
  const action = createB4LearnerAction({
    controller: services.controller,
    readState: () => state,
    readAnswer: () => answer,
    onState: (next) => { state = next; },
    onAnswer: (next) => { answer = next; },
    onBusy: () => {},
    onError: (error) => errors.push(error.code),
  });

  while (state.phase !== 'summary') {
    if (!state.awaitingAdvance) {
      answer = catalogue.items.find(
        ({ runtimeItemId }) => runtimeItemId === state.currentRuntimeItemId,
      ).target;
    }
    await action.submit({ preventDefault() {} });
  }

  assert.deepEqual(errors, []);
  assert.equal(state.revision, B4_COMMAND_TRACE.length);
  assert.deepEqual(state.summary, B4_SUMMARY);
  assert.equal(answer, '');
});

test('fresh round starts deterministically from a genuine committed summary', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ks2-b4-fresh-round-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  async function completeAndRestart(filename) {
    const playedPaths = [];
    const services = await createB4AppServices({
      connectionFactory: () => createNodeSqliteConnection(join(directory, filename)),
      lifecycleFactory: createLifecycle,
      audioManifest: placeholderManifest(),
      playAudio: silentPlayer(playedPaths),
    });
    try {
      let state = await services.controller.start();
      while (state.phase !== 'summary') state = await services.controller.advance();
      const summaryRevision = state.revision;
      state = await services.controller.freshRound();
      const freshState = state;
      const audioStates = [];
      const catalogue = loadStarterSpellingCatalogue();
      while (state.phase !== 'summary') {
        audioStates.push(await services.controller.replay());
        audioStates.push(await services.controller.slowReplay());
        const target = catalogue.items.find(
          ({ runtimeItemId }) => runtimeItemId === state.currentRuntimeItemId,
        ).target;
        state = await services.controller.submit(target);
        if (state.awaitingAdvance) state = await services.controller.continue();
      }
      return { state: freshState, summaryRevision, freshSummary: state, audioStates, playedPaths };
    } finally {
      await services.dispose();
    }
  }

  const first = await completeAndRestart('first.sqlite');
  const second = await completeAndRestart('second.sqlite');
  assert.equal(first.state.phase, 'session');
  assert.equal(first.state.revision, first.summaryRevision + 1);
  assert.equal(first.state.completedRuntimeItemIds.length, 0);
  assert.ok(B4_RUNTIME_ITEM_IDS.includes(first.state.currentRuntimeItemId));
  assert.equal(first.state.totalCards, 5);
  assert.equal(first.state.currentRuntimeItemId, second.state.currentRuntimeItemId);
  assert.equal(first.state.currentSentence, second.state.currentSentence);
  assert.equal(first.freshSummary.phase, 'summary');
  assert.ok(first.audioStates.length >= 10);
  assert.ok(first.audioStates.every(({ audio }) => audio.status === 'playing'));
  assert.ok(first.audioStates.every(({ audio }) => audio.error === null));
  const replayPaths = first.playedPaths.filter((path) => path.startsWith('audio/b4/'));
  assert.match(replayPaths.at(-2), /^audio\/b4\/b4-\d{2}\.wav$/u);
  assert.match(replayPaths.at(-1), /^audio\/b4\/b4-\d{2}\.wav$/u);
});

test('genuine A3 audio effects run post-commit while replay stays independent of durable storage', async () => {
  let snapshot = freshSnapshot(true);
  let committed = false;
  let storageReadable = true;
  const paths = [];
  let rejectPlayback = false;
  const playAudio = async (path) => {
    assert.equal(committed, true, 'audio cannot run before the repository commit returns');
    paths.push(path);
    if (rejectPlayback) {
      const error = new Error('blocked');
      error.code = 'b4_audio_play_failed';
      throw error;
    }
    return { status: 'playing', path };
  };
  playAudio.stop = () => paths.push('stop');
  playAudio.dispose = () => paths.push('dispose');
  const repository = {
    async runCommandTransaction(_learnerId, planner) {
      committed = false;
      const plan = planner(snapshot, { nowMs: B4_START_TIMESTAMP });
      assert.deepEqual(plan.transientEffects, [{
        type: 'audio-cue',
        payload: {
          runtimeItemId: 'ks2-core:arrive',
          sentence: 'The parcel should arrive tomorrow.',
          slow: false,
        },
      }]);
      snapshot = commit(snapshot, plan);
      committed = true;
      return plan;
    },
  };
  let pauseListener = () => {};
  const lifecycle = {
    onPause(listener) {
      pauseListener = listener;
      return { async remove() { pauseListener = () => {}; } };
    },
  };
  const controller = createB4RoundController({
    catalogue: loadStarterSpellingCatalogue(),
    repository,
    snapshotStore: {
      async read() {
        if (!storageReadable) throw new Error('storage resuming');
        return structuredClone(snapshot);
      },
    },
    audioManifest: placeholderManifest(),
    playAudio,
    lifecycle,
  });

  let state = await controller.start();
  assert.equal(state.revision, 1);
  assert.equal(state.audio.status, 'playing');
  assert.equal(paths.at(-1), 'audio/b4/b4-06.wav');
  const durableBeforeReplay = structuredClone(snapshot);

  storageReadable = false;
  state = await controller.slowReplay();
  assert.equal(state.audio.status, 'playing');
  assert.equal(paths.at(-1), 'audio/b4/b4-07.wav');
  assert.deepEqual(snapshot, durableBeforeReplay);

  rejectPlayback = true;
  state = await controller.replay();
  assert.deepEqual(state.audio, { status: 'error', error: 'b4_audio_play_failed' });
  assert.deepEqual(snapshot, durableBeforeReplay);
  pauseListener();
  assert.equal(paths.at(-1), 'stop');
  assert.deepEqual(controller.getState().audio, { status: 'idle', error: null });
  storageReadable = true;
  await controller.rehydrate();
  assert.equal(paths.at(-1), 'stop');
  await controller.dispose();
  assert.deepEqual(paths.slice(-2), ['stop', 'dispose']);
});

function mockCommandServices({ autoSpeak, playAudio }) {
  let snapshot = freshSnapshot(autoSpeak);
  let reads = 0;
  const repository = {
    async runCommandTransaction(_learnerId, planner) {
      const plan = planner(structuredClone(snapshot), { nowMs: B4_START_TIMESTAMP + snapshot.revision });
      snapshot = commit(snapshot, plan);
      return plan;
    },
  };
  const controller = createB4RoundController({
    catalogue: loadStarterSpellingCatalogue(),
    repository,
    snapshotStore: {
      async read() {
        reads += 1;
        return structuredClone(snapshot);
      },
    },
    audioManifest: placeholderManifest(),
    playAudio,
  });
  return { controller, countReads: () => reads };
}

test('a committed command publishes from its validated plan without a second snapshot read', async () => {
  const { controller, countReads } = mockCommandServices({
    autoSpeak: false,
    playAudio: silentPlayer(),
  });
  const started = await controller.start();
  assert.equal(started.revision, 1);
  const readsBeforeSubmit = countReads();
  const state = await controller.submit('definitely-wrong');
  assert.equal(countReads() - readsBeforeSubmit, 1,
    'submit must read the snapshot once for the revision guard and never re-read after commit');
  assert.equal(state.revision, 2);
  assert.equal(state.feedback.kind, 'error');
  await controller.dispose();
});

test('start warms the current card word-natural and dictation variants', async () => {
  const warmed = [];
  const playAudio = silentPlayer();
  playAudio.warm = (paths) => {
    warmed.push(...(Array.isArray(paths) ? paths : [paths]));
  };
  const { controller } = mockCommandServices({ autoSpeak: false, playAudio });
  const state = await controller.start();
  assert.equal(state.currentRuntimeItemId, 'ks2-core:arrive');
  assert.equal(state.currentSentence, 'The parcel should arrive tomorrow.');
  assert.ok(warmed.includes('audio/b4/b4-03.wav'), 'word-natural cue must be warmed');
  assert.ok(warmed.includes('audio/b4/b4-06.wav'), 'dictation-normal variant must be warmed');
  assert.ok(warmed.includes('audio/b4/b4-07.wav'), 'dictation-slow variant must be warmed');
  await controller.dispose();
});

test('stopping playback flushes the warm pool so resumed sessions start clean', async () => {
  const calls = [];
  const playAudio = silentPlayer(calls);
  playAudio.warm = () => {};
  playAudio.flush = () => calls.push('flush');
  const { controller } = mockCommandServices({ autoSpeak: false, playAudio });
  await controller.start();
  await controller.rehydrate();
  assert.ok(calls.includes('flush'), 'pause/rehydrate must flush pooled media elements');
  await controller.dispose();
});

test('committed state publishes before the audio cue starts playing', async () => {
  let release = null;
  const play = (path) => new Promise((resolve) => {
    release = () => resolve({ status: 'playing', path });
  });
  play.stop = () => {};
  play.dispose = () => {};
  const { controller } = mockCommandServices({ autoSpeak: true, playAudio: play });
  const published = [];
  controller.subscribe((state) => published.push(state));
  const startPromise = controller.start();
  for (let waited = 0; waited < 200 && !published.some(({ revision }) => revision === 1); waited += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(published.some(({ revision }) => revision === 1), true,
    'the committed state must reach subscribers while the audio cue is still starting');
  assert.equal(typeof release, 'function');
  release();
  const final = await startPromise;
  assert.equal(final.audio.status, 'playing');
  await controller.dispose();
});
