/* Opening a word from the Word Bank. The detail is rendered for real so its
   heading, its copy and its two controls are asserted as a learner meets them,
   and "Hear it" is played through the real product audio player so the button
   cannot quietly grow an audio path of its own. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import evidence from '../reports/c1/starter-audio-evidence.json' with { type: 'json' };
import { createProductAudioPlayer } from '../src/app/product-audio-player.js';
import { loadStarterSpellingCatalogue } from '../src/domain/spelling/index.js';
import {
  buildWordBank,
  buildWordDetail,
  hearWordRequest,
} from '../src/app/word-bank-model.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function progressRow(runtimeItemId, overrides = {}) {
  const item = loadStarterSpellingCatalogue().items.find(
    (candidate) => candidate.runtimeItemId === runtimeItemId,
  );
  assert.ok(item, `the starter catalogue must publish ${runtimeItemId}`);
  return {
    runtimeItemId,
    target: item.target,
    yearBand: item.yearBand,
    coverageTier: item.coverageTier,
    stage: 0,
    attempts: 0,
    correct: 0,
    wrong: 0,
    dueDay: null,
    lastResult: null,
    ...overrides,
  };
}

function detailFor(runtimeItemId, overrides = {}) {
  const material = loadStarterSpellingCatalogue().items.find(
    (candidate) => candidate.runtimeItemId === runtimeItemId,
  );
  const bank = buildWordBank({
    now: 0,
    progress: [progressRow(runtimeItemId, overrides)],
  });
  return buildWordDetail({ material, row: bank.rows[0] });
}

async function renderProduct(t, component, props) {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: join(ROOT, 'vite.config.js'),
    server: { middlewareMode: true },
    appType: 'custom',
  });
  t.after(() => vite.close());
  const module = await vite.ssrLoadModule('/src/app/ProductApp.jsx');
  assert.ok(module[component], `ProductApp must export ${component}`);
  return renderToStaticMarkup(React.createElement(module[component], props));
}

test('an opened word shows its meaning, one sentence, its family and both controls', async (t) => {
  const html = await renderProduct(t, 'WordDetailScreen', {
    detail: detailFor('ks2-core:busy', {
      stage: 2,
      attempts: 4,
      correct: 3,
      wrong: 1,
    }),
    audioState: { status: 'ready', activeVersion: '1.0.0', actionError: null },
    audio: { async play() {} },
    voiceId: 'Iapetus',
    busy: false,
    onBack() {},
    onScreen() {},
    onPractise: async () => {},
    onPlaybackFailure() {},
  });

  // The word is the screen's one h1, and the page is named by it.
  assert.match(html, /<h1 id="word-title">busy<\/h1>/u);
  assert.match(html, /aria-labelledby="word-title"/u);
  assert.match(html, /Years 3-4/u);
  assert.match(html, /Busy means having a lot to do or full of activity\./u);
  assert.match(html, /The shop was busy on Saturday morning\./u);
  // The family list is the other spellings only.
  assert.match(html, /Word family[\s\S]*?<li>business<\/li>/u);
  assert.doesNotMatch(html, /<li>busy<\/li>/u);
  assert.match(html, /3 correct · 1 to revisit/u);
  // Both controls are real buttons with names, and neither is disabled while
  // the listening pack is ready.
  assert.match(html, /<button type="button" class="word-listen press">/u);
  assert.match(html, /Hear it/u);
  assert.match(html, /Practise this word/u);
  assert.match(html, /Back to your words/u);
  // Child-facing surface: no price, no purchase, no way out of the app.
  assert.doesNotMatch(html, /£|Buy|purchase|Unlock/iu);
  assert.doesNotMatch(html, /<a\b/u);
});

test('a word with no listening pack cannot offer Hear it, and a saving round cannot be practised twice', async (t) => {
  const html = await renderProduct(t, 'WordDetailScreen', {
    detail: detailFor('ks2-core:answer'),
    audioState: { status: 'missing', activeVersion: '1.0.0', actionError: null },
    audio: { async play() {} },
    voiceId: 'Iapetus',
    busy: true,
    onBack() {},
    onScreen() {},
    onPractise: async () => {},
    onPlaybackFailure() {},
  });

  assert.match(html, /class="word-listen press" disabled=""/u);
  assert.match(html, /class="button-primary press" disabled=""/u);
});

test('every word bank entry is a button that opens the word', async (t) => {
  const html = await renderProduct(t, 'WordBankScreen', {
    progress: [
      progressRow('ks2-core:busy', { stage: 4, attempts: 5, correct: 5 }),
      progressRow('ks2-core:answer'),
    ],
    vocabularySets: [{ id: 'core', label: 'Core', count: 2 }],
    onScreen() {},
    onStart() {},
    wordMaterial: () => null,
    onPractise: async () => {},
    audio: { async play() {} },
    audioState: { status: 'ready', activeVersion: '1.0.0', actionError: null },
    voiceId: 'Iapetus',
    busy: false,
    onPlaybackFailure() {},
  });

  const rows = html.match(/<button type="button" class="bank-row press-soft press"/gu) ?? [];
  assert.equal(rows.length, 2, 'each listed word must be its own button');
  assert.match(html, /class="bank-row press-soft press"[\s\S]*?<strong>busy<\/strong>/u);
  assert.doesNotMatch(html, /<li class="bank-row/u);
});

test('Hear it plays the verified word recording through the round audio player', async () => {
  const reads = [];
  const player = createProductAudioPlayer({
    catalogue: loadStarterSpellingCatalogue(),
    installedAudio: {
      async readInstalledAudio(request) {
        reads.push(request);
        return { base64: Buffer.alloc(request.byteSize).toString('base64') };
      },
    },
    audioFactory: () => ({
      preload: '',
      src: '',
      pause() {},
      removeAttribute() {},
      load() {},
      async play() {},
    }),
    audioEvidence: evidence,
  });

  const result = await player.play(hearWordRequest({
    runtimeItemId: 'ks2-core:busy',
    version: '1.0.0',
    voiceId: 'Iapetus',
  }));

  // The word recording, not a dictation sentence.
  assert.equal(result.status, 'playing');
  assert.equal(result.audioKey, 'ks2-core:busy|word|Iapetus|natural|word-natural');
  assert.deepEqual(reads.map(({ assetPath }) => assetPath), [
    'audio/iapetus/busy/word.m4a',
  ]);
});

test('the Word Bank hands the detail the learning services it needs', async () => {
  const source = await readFile(join(ROOT, 'src/app/ProductApp.jsx'), 'utf8');

  // Tapping a row opens that row's word.
  assert.match(
    source,
    /onClick=\{\(\) => setOpenWordId\(row\.runtimeItemId\)\}/u,
    'a bank row must open its own word',
  );
  // The material comes from the controller that owns the catalogue, and the
  // practice CTA runs the controller's single-word drill.
  assert.match(source, /wordMaterial=\{services\.learning\.wordMaterial\}/u);
  assert.match(
    source,
    /onPractise=\{\(runtimeItemId\) =>\s*services\.learning\.practiseWord\(runtimeItemId\)\}/u,
  );
  // Playback is the round's own port and availability, never a second player.
  assert.match(source, /<WordBankScreen[\s\S]*?audio=\{services\.audio\}/u);
  assert.match(source, /<WordBankScreen[\s\S]*?audioState=\{audioState\}/u);
});
