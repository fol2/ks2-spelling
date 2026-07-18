import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  B4_AUDIO_AUTHORITY,
  B4_RUNTIME_ITEM_IDS,
} from '../src/app/b4-round-contract.js';
import { createB4LearnerAction } from '../src/app/b4-learner-action.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function activeState(overrides = {}) {
  return Object.freeze({
    phase: 'session',
    revision: 1,
    sessionId: 'session-test',
    currentRuntimeItemId: 'ks2-core:answer',
    currentSentence: 'The answer matched the question exactly.',
    answerPhase: 'question',
    awaitingAdvance: false,
    completedRuntimeItemIds: Object.freeze([]),
    completedCards: 0,
    totalCards: 5,
    feedback: null,
    summary: null,
    audio: Object.freeze({ status: 'idle', error: null }),
    ...overrides,
  });
}

test('button and Enter use one guarded learner action and busy blocks double-submit', async () => {
  let resolveSubmit;
  const calls = [];
  const busy = [];
  const controller = {
    submit(typed) {
      calls.push(['submit', typed]);
      return new Promise((resolve) => { resolveSubmit = resolve; });
    },
    async continue() { calls.push(['continue']); return activeState(); },
    async freshRound() { calls.push(['fresh']); return activeState(); },
  };
  const event = () => ({ preventDefault() { calls.push(['prevent-default']); } });
  const action = createB4LearnerAction({
    controller,
    readState: () => activeState(),
    readAnswer: () => '  typed spelling  ',
    onState: () => {},
    onAnswer: () => {},
    onBusy: (value) => busy.push(value),
    onError: assert.fail,
  });

  const buttonPromise = action.submit(event());
  const enterPromise = action.submit(event());
  assert.deepEqual(calls, [
    ['prevent-default'],
    ['submit', 'typed spelling'],
    ['prevent-default'],
  ]);
  assert.deepEqual(busy, [true]);
  resolveSubmit(activeState({ revision: 2 }));
  await Promise.all([buttonPromise, enterPromise]);
  assert.deepEqual(busy, [true, false]);
});

test('learner action chooses retry submission, durable continuation and fresh round by domain state', async () => {
  let state = activeState({ answerPhase: 'retry' });
  const calls = [];
  const controller = {
    async submit(typed) { calls.push(['submit', typed]); return activeState({ awaitingAdvance: true }); },
    async continue() { calls.push(['continue']); return activeState(); },
    async freshRound() { calls.push(['fresh']); return activeState(); },
  };
  const action = createB4LearnerAction({
    controller,
    readState: () => state,
    readAnswer: () => 'memory',
    onState: (next) => { state = next; },
    onAnswer: () => {},
    onBusy: () => {},
    onError: assert.fail,
  });

  await action.submit({ preventDefault() {} });
  state = activeState({ awaitingAdvance: true });
  await action.submit({ preventDefault() {} });
  state = activeState({ phase: 'summary', summary: {} });
  await action.submit({ preventDefault() {} });
  assert.deepEqual(calls, [['submit', 'memory'], ['continue'], ['fresh']]);
});

test('learner action fails closed before the durable round is ready', async () => {
  const calls = [];
  const action = createB4LearnerAction({
    controller: {
      async submit() { calls.push('submit'); },
      async continue() { calls.push('continue'); },
      async freshRound() { calls.push('fresh'); },
    },
    readState: () => activeState({ phase: 'ready' }),
    readAnswer: () => 'answer',
    onState: () => calls.push('state'),
    onAnswer: () => calls.push('answer'),
    onBusy: () => {},
    onError: (error) => calls.push(error.code),
  });
  await action.submit({ preventDefault() {} });
  assert.deepEqual(calls, ['b4_round_not_ready']);
});

test('B4 surface renders native learner controls without target leakage or commerce', async (t) => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: join(ROOT, 'vite.config.js'),
    server: { middlewareMode: true, hmr: { port: 24_679 } },
    appType: 'custom',
  });
  t.after(() => vite.close());
  const { default: App } = await vite.ssrLoadModule('/src/app/App.jsx');
  const state = activeState();
  const controller = Object.freeze({
    getState: () => state,
    subscribe: () => Object.freeze({ remove() {} }),
    async start() { return state; },
    async submit() { return state; },
    async continue() { return state; },
    async freshRound() { return state; },
    async replay() { return state; },
    async slowReplay() { return state; },
  });
  const html = renderToStaticMarkup(React.createElement(App, {
    services: Object.freeze({ mode: 'b4-starter-product', controller }),
  }));

  assert.match(html, /Card 1 of 5/);
  assert.match(html, /<form\b/);
  assert.match(
    html,
    /<input[^>]+autocomplete="off"[^>]+autocapitalize="none"[^>]+autocorrect="off"[^>]+spellcheck="false"/i,
  );
  assert.match(html, /<button type="submit">Submit<\/button>/);
  assert.match(html, />Replay<\/button>/);
  assert.match(html, />Slow replay<\/button>/);
  assert.match(html, new RegExp(B4_AUDIO_AUTHORITY.futureDisclosure));
  for (const runtimeItemId of B4_RUNTIME_ITEM_IDS) {
    const target = runtimeItemId.split(':').at(-1);
    assert.doesNotMatch(html, new RegExp(`\\b${target}\\b`, 'iu'));
  }
  assert.doesNotMatch(html, /buy|restore|redownload|price|commerce|store sheet/iu);

  const readyHtml = renderToStaticMarkup(React.createElement(App, {
    services: Object.freeze({
      mode: 'b4-starter-product',
      controller: Object.freeze({
        ...controller,
        getState: () => activeState({ phase: 'ready' }),
      }),
    }),
  }));
  assert.match(readyHtml, /Preparing your round/);
  assert.match(readyHtml, /<input[^>]+disabled=""/i);
  assert.match(readyHtml, /<button type="submit" disabled="">Preparing/);

  const awaitingState = activeState({
    awaitingAdvance: true,
    completedCards: 1,
    completedRuntimeItemIds: Object.freeze([B4_RUNTIME_ITEM_IDS[0]]),
    audio: Object.freeze({ status: 'playing', error: null }),
  });
  const awaitingHtml = renderToStaticMarkup(React.createElement(App, {
    services: Object.freeze({
      mode: 'b4-starter-product',
      controller: Object.freeze({ ...controller, getState: () => awaitingState }),
    }),
  }));
  assert.match(awaitingHtml, /Card 1 of 5/);
  assert.match(awaitingHtml, /Audio playing/);
  assert.doesNotMatch(awaitingHtml, /Card 2 of 5/);

  const completeState = activeState({
    phase: 'summary',
    completedCards: 5,
    completedRuntimeItemIds: B4_RUNTIME_ITEM_IDS,
    summary: Object.freeze({ message: 'Your five-card round is complete.' }),
  });
  const completeHtml = renderToStaticMarkup(React.createElement(App, {
    services: Object.freeze({
      mode: 'b4-starter-product',
      controller: Object.freeze({ ...controller, getState: () => completeState }),
    }),
  }));
  assert.match(completeHtml, /Round complete/);
  assert.match(completeHtml, /Your five-card round is complete\./);
  assert.match(completeHtml, />Start a fresh round<\/button>/);
  assert.doesNotMatch(completeHtml, />Replay<|>Slow replay<|>Submit</);
});

test('B4 child surface cannot import or call B3 commerce services', async () => {
  const source = await readFile(join(ROOT, 'src/app/App.jsx'), 'utf8');
  const b4Start = source.indexOf('function B4App');
  const b4End = source.indexOf('function B3App', b4Start);
  const b4Source = source.slice(b4Start, b4End);
  assert.ok(b4Start >= 0 && b4End > b4Start);
  assert.doesNotMatch(b4Source, /\b(?:buy|restore|redownload|purchase|commerce)\b/iu);
});
