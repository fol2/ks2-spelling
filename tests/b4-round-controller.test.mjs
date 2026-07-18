import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  B4_COMMAND_TRACE,
  B4_RUNTIME_ITEM_IDS,
  B4_SEED,
  B4_SENTENCE_PROMPTS,
  B4_SUMMARY,
  characteriseB4Round,
} from '../src/app/b4-round-contract.js';
import { createB4AppServices } from '../src/app/create-b4-app-services.js';
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
