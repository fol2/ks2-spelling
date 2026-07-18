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

test('genuine A3 audio effects run only post-commit and replay failures never mutate durable state', async () => {
  let snapshot = freshSnapshot(true);
  let committed = false;
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
    snapshotStore: { async read() { return structuredClone(snapshot); } },
    audioManifest: placeholderManifest(),
    playAudio,
    lifecycle,
  });

  let state = await controller.start();
  assert.equal(state.revision, 1);
  assert.equal(state.audio.status, 'playing');
  assert.equal(paths.at(-1), 'audio/b4/b4-06.wav');
  const durableBeforeReplay = structuredClone(snapshot);

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
  await controller.rehydrate();
  assert.equal(paths.at(-1), 'stop');
  await controller.dispose();
  assert.deepEqual(paths.slice(-2), ['stop', 'dispose']);
});
