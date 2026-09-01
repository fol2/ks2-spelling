import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createParentCommerceController,
} from '../src/app/parent-commerce-controller.js';

function snapshot(overrides = {}) {
  return Object.freeze({
    displayPrice: '£4.99',
    entitlementState: 'active',
    packState: 'installed',
    syncFailed: false,
    ...overrides,
  });
}

test('Parent commerce preserves verified access and installed data through external failure', async () => {
  const results = [
    snapshot(),
    snapshot({ displayPrice: '', syncFailed: true }),
    snapshot({
      displayPrice: '',
      entitlementState: 'revoked',
      packState: 'locked',
    }),
  ];
  const workflow = {
    async start() { return results.shift(); },
    async refresh() { return results.shift(); },
    async purchase() { throw new Error('not used'); },
    async restore() { throw new Error('not used'); },
    async download() { throw new Error('not used'); },
    async recover() { throw new Error('not used'); },
    async dispose() {},
  };
  const controller = createParentCommerceController({ workflow });

  await controller.start();
  assert.deepEqual(controller.getState(), {
    status: 'ready',
    displayPrice: '£4.99',
    entitlementState: 'active',
    packState: 'installed',
    action: null,
    actionError: null,
    actionErrorDetail: null,
    downloadProgress: null,
  });

  await controller.refresh();
  assert.deepEqual(controller.getState(), {
    status: 'offline',
    displayPrice: '',
    entitlementState: 'active',
    packState: 'installed',
    action: null,
    actionError: null,
    actionErrorDetail: null,
    downloadProgress: null,
  });

  await controller.refresh();
  assert.deepEqual(controller.getState(), {
    status: 'ready',
    displayPrice: '',
    entitlementState: 'revoked',
    packState: 'locked',
    action: null,
    actionError: null,
    actionErrorDetail: null,
    downloadProgress: null,
  });
  await controller.dispose();
});

test('Parent commerce serialises explicit purchase, restore, download and recovery actions', async () => {
  const calls = [];
  const workflow = {
    async start() {
      calls.push('start');
      return snapshot({ entitlementState: 'none', packState: 'missing' });
    },
    async refresh() {
      calls.push('refresh');
      return snapshot();
    },
    async purchase() {
      calls.push('purchase');
      return snapshot({ packState: 'missing' });
    },
    async restore() {
      calls.push('restore');
      return snapshot({ packState: 'missing' });
    },
    async download() {
      calls.push('download');
      return snapshot();
    },
    async recover() {
      calls.push('recover');
      return snapshot();
    },
    async dispose() {
      calls.push('dispose');
    },
  };
  const controller = createParentCommerceController({ workflow });

  await controller.start();
  await controller.purchase();
  await controller.restore();
  await controller.download();
  await controller.recover();

  assert.deepEqual(calls, [
    'start',
    'purchase',
    'restore',
    'download',
    'recover',
  ]);
  assert.equal(controller.getState().status, 'ready');
  assert.equal(controller.getState().packState, 'installed');
  await controller.dispose();
  assert.equal(calls.at(-1), 'dispose');
});

test('Parent commerce publishes each shard the install starts and clears it when the run ends', async () => {
  const published = [];
  let emit = null;
  const workflow = {
    async start() { return snapshot({ packState: 'queued' }); },
    async refresh() { return snapshot(); },
    async purchase() { throw new Error('not used'); },
    async restore() { throw new Error('not used'); },
    async download(onProgress) {
      emit = onProgress;
      onProgress({ completedShards: 0, totalShards: 15 });
      onProgress({ completedShards: 1, totalShards: 15 });
      return snapshot();
    },
    async recover() { throw new Error('not used'); },
    async dispose() {},
  };
  const controller = createParentCommerceController({ workflow });
  controller.subscribe((state) => published.push(state));

  await controller.start();
  await controller.download();

  // Every published state during the run, in order: the action starting, then
  // one per shard, then the snapshot it resolved into.
  assert.deepEqual(
    published.slice(-4).map(({ status, action, downloadProgress }) =>
      ({ status, action, downloadProgress })),
    [
      { status: 'working', action: 'download', downloadProgress: null },
      {
        status: 'working',
        action: 'download',
        downloadProgress: { completedShards: 0, totalShards: 15 },
      },
      {
        status: 'working',
        action: 'download',
        downloadProgress: { completedShards: 1, totalShards: 15 },
      },
      { status: 'ready', action: null, downloadProgress: null },
    ],
  );
  // The record is closed and frozen like every other state the card reads.
  const midRun = published.at(-2);
  assert.ok(Object.isFrozen(midRun.downloadProgress));
  assert.deepEqual(Object.keys(midRun.downloadProgress), [
    'completedShards',
    'totalShards',
  ]);
  assert.equal(typeof emit, 'function');
  await controller.dispose();
});

test('a download that fails leaves no shard count behind it', async () => {
  const workflow = {
    async start() { return snapshot({ packState: 'queued' }); },
    async refresh() { return snapshot(); },
    async purchase() { throw new Error('not used'); },
    async restore() { throw new Error('not used'); },
    async download(onProgress) {
      onProgress({ completedShards: 6, totalShards: 15 });
      throw new Error('shard 7 failed');
    },
    async recover() { throw new Error('not used'); },
    async dispose() {},
  };
  const controller = createParentCommerceController({ workflow });

  await controller.start();
  await assert.rejects(controller.download());
  // A failure message beside "installing pack 7 of 15" is two stories at once.
  assert.deepEqual(controller.getState(), {
    status: 'failed',
    displayPrice: '£4.99',
    entitlementState: 'active',
    packState: 'queued',
    action: null,
    actionError: 'parent_commerce_action_failed',
    actionErrorDetail: 'shard 7 failed',
    downloadProgress: null,
  });
  await controller.dispose();
});

test('the Parent card can start a purchased download and resume an interrupted one', async () => {
  const { downloadActionLabel } = await import('../src/app/parent-commerce-controller.js');
  // A purchase leaves the shard jobs queued; an interrupted install leaves
  // them downloading. Both were unreachable before E2.7's fix round, which
  // stranded a paying family with no way to obtain the content.
  assert.equal(downloadActionLabel({ entitlementState: 'active', packState: 'queued' }), 'Download pack');
  assert.equal(downloadActionLabel({ entitlementState: 'active', packState: 'downloading' }), 'Resume download');
  assert.equal(downloadActionLabel({ entitlementState: 'active', packState: 'missing' }), 'Download pack');
  assert.equal(downloadActionLabel({ entitlementState: 'active', packState: 'failed' }), 'Retry download');
  // Nothing to do, or no right to do it.
  assert.equal(downloadActionLabel({ entitlementState: 'active', packState: 'installed' }), null);
  assert.equal(downloadActionLabel({ entitlementState: 'revoked', packState: 'locked' }), null);
  assert.equal(downloadActionLabel({ entitlementState: 'none', packState: 'missing' }), null);
  assert.equal(downloadActionLabel(), null);
});

test('the Parent card really renders that download button, enabled and wired', async (t) => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: new URL('../vite.config.js', import.meta.url).pathname,
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
  });
  t.after(() => vite.close());
  const { ParentCommerceCard } = await vite.ssrLoadModule('/src/app/ProductApp.jsx');

  const commerceState = (packState) => Object.freeze({
    status: 'ready',
    displayPrice: '£4.99',
    entitlementState: 'active',
    packState,
    actionError: null,
    actionErrorDetail: null,
  });
  const props = (packState, onDownload) => ({
    state: commerceState(packState),
    async onPurchase() {},
    async onRestore() {},
    onDownload,
    async onRecover() {},
  });

  for (const [packState, label] of [['queued', 'Download pack'], ['downloading', 'Resume download']]) {
    const downloads = [];
    const html = renderToStaticMarkup(React.createElement(
      ParentCommerceCard,
      props(packState, async () => { downloads.push(packState); }),
    ));
    // Exists, carries the right words, and is not disabled — a `disabled`
    // button would render the attribute.
    const button = new RegExp(`<button[^>]*>${label}</button>`, 'u').exec(html);
    assert.ok(button, `no enabled ${label} button rendered for packState ${packState}: ${html}`);
    assert.doesNotMatch(button[0], /disabled/u);

    // Wired: the card is a plain function component, so its element tree can
    // be walked and the button's own onClick invoked.
    const tree = ParentCommerceCard(props(packState, async () => { downloads.push(`click:${packState}`); }));
    const buttons = [];
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      if (node.type === 'button') buttons.push(node);
      walk(node.props?.children);
    };
    walk(tree);
    const downloadButton = buttons.find((node) => node.props.children === label);
    assert.ok(downloadButton, `the ${label} button is not in the rendered tree`);
    assert.equal(downloadButton.props.disabled, false);
    downloadButton.props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(downloads, [`click:${packState}`]);
  }

  // Installed and unentitled states render no download button at all.
  for (const state of [
    { entitlementState: 'active', packState: 'installed' },
    { entitlementState: 'none', packState: 'missing' },
  ]) {
    const html = renderToStaticMarkup(React.createElement(ParentCommerceCard, {
      ...props('missing', async () => {}),
      state: Object.freeze({ ...commerceState('missing'), ...state }),
    }));
    assert.doesNotMatch(html, /Download pack|Resume download|Retry download/u);
  }

  // The selector is the single authority for that decision.
  const source = await readFile(new URL('../src/app/ProductApp.jsx', import.meta.url), 'utf8');
  assert.match(source, /downloadActionLabel\(state\)/u);
});

test('an installed pack that this session did not compose offers the restart itself', async (t) => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: new URL('../vite.config.js', import.meta.url).pathname,
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
  });
  t.after(() => vite.close());
  const { ParentCommerceCard } = await vite.ssrLoadModule('/src/app/ProductApp.jsx');

  const props = (fullCatalogueActive, extra = {}) => ({
    state: Object.freeze({
      status: 'ready',
      displayPrice: '£4.99',
      entitlementState: 'active',
      packState: 'installed',
      action: null,
      actionError: null,
      actionErrorDetail: null,
      downloadProgress: null,
    }),
    fullCatalogueActive,
    async onPurchase() {},
    async onRestore() {},
    async onDownload() {},
    async onRecover() {},
    ...extra,
  });
  const render = (fullCatalogueActive) => renderToStaticMarkup(
    React.createElement(ParentCommerceCard, props(fullCatalogueActive)),
  );

  // The learning catalogue is chosen at startup, so an install that finished
  // while the app was open is installed but not yet in front of the child.
  // Telling the family to close and reopen the app made them do by hand what
  // the button below does for them.
  assert.match(render(false), /Use the full word list now/u);
  assert.doesNotMatch(render(false), /[Cc]lose and reopen/u);
  assert.doesNotMatch(render(true), /Use the full word list now/u);
  assert.match(render(true), /full word list is available offline/u);

  // Wired: the button's own onClick reaches the handler.
  const activations = [];
  const buttons = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (node.type === 'button') buttons.push(node);
    walk(node.props?.children);
  };
  walk(ParentCommerceCard(props(false, {
    onActivateFullCatalogue: () => activations.push('activate'),
  })));
  const activate = buttons.find(
    (node) => node.props.children === 'Use the full word list now',
  );
  assert.ok(activate, 'the full-catalogue button is not in the rendered tree');
  assert.equal(activate.props.disabled, false);
  activate.props.onClick();
  assert.deepEqual(activations, ['activate']);

  // And its default is the real restart: the same reload the boot-failure
  // recovery button performs, which re-runs the whole startup composition.
  const location = globalThis.location;
  const reloads = [];
  globalThis.location = { reload: () => reloads.push('reload') };
  t.after(() => { globalThis.location = location; });
  buttons.length = 0;
  walk(ParentCommerceCard(props(false)));
  buttons.find(
    (node) => node.props.children === 'Use the full word list now',
  ).props.onClick();
  assert.deepEqual(reloads, ['reload']);
});

test('an install in flight shows the shard it is on, never the resume copy', async (t) => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: new URL('../vite.config.js', import.meta.url).pathname,
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
  });
  t.after(() => vite.close());
  const { ParentCommerceCard } = await vite.ssrLoadModule('/src/app/ProductApp.jsx');

  const render = (state) => renderToStaticMarkup(React.createElement(
    ParentCommerceCard,
    {
      state: Object.freeze({
        displayPrice: '£4.99',
        entitlementState: 'active',
        packState: 'downloading',
        actionError: null,
        actionErrorDetail: null,
        downloadProgress: null,
        ...state,
      }),
      async onPurchase() {},
      async onRestore() {},
      async onDownload() {},
      async onRecover() {},
    },
  ));

  const running = render({
    status: 'working',
    action: 'download',
    downloadProgress: { completedShards: 2, totalShards: 15 },
  });
  // The device report: fifteen shards downloading and the card said nothing,
  // under the copy for a download that had stopped.
  assert.match(running, /Installing word pack 3 of 15/u);
  assert.doesNotMatch(running, /did not finish|Resume it/u);
  assert.match(running, /Installing…<\/button>/u);
  // One step per shard, two of them behind the one in flight, and the meter is
  // decoration: the count above it is the text equivalent and the live region.
  const steps = running.match(/data-state="(done|here|todo)"/gu) ?? [];
  assert.equal(steps.length, 15);
  assert.equal(steps.filter((step) => step.includes('done')).length, 2);
  assert.equal(steps.filter((step) => step.includes('here')).length, 1);
  assert.match(running, /<span class="parent-commerce-steps" aria-hidden="true">/u);
  assert.match(running, /<p aria-live="polite">Installing word pack 3 of 15\.<\/p>/u);

  // Before the first shard reports, and after the run ends.
  const starting = render({ status: 'working', action: 'download' });
  assert.match(starting, /Starting the word pack download/u);
  assert.doesNotMatch(starting, /data-state=/u);
  const interrupted = render({ status: 'ready', action: null });
  assert.match(interrupted, /did not finish\. Resume it to install the rest/u);
  assert.doesNotMatch(interrupted, /data-state=|Installing/u);
});

test('verified access with a failed pack download does not pretend IAP is the offline hop', async (t) => {
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: new URL('../vite.config.js', import.meta.url).pathname,
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
  });
  t.after(() => vite.close());
  const { commerceMessage } = await vite.ssrLoadModule('/src/app/ProductApp.jsx');

  const offline = (packState) => Object.freeze({
    status: 'offline',
    displayPrice: '',
    entitlementState: 'active',
    packState,
    action: null,
    actionError: null,
    actionErrorDetail: null,
    downloadProgress: null,
  });

  assert.equal(
    commerceMessage(offline('missing'), false),
    'Access is verified. The pack download service is unavailable. Last verified access and installed data remain unchanged.',
  );
  assert.equal(
    commerceMessage(offline('installed'), true),
    'The store is unavailable. Last verified access and installed data remain unchanged.',
  );
  assert.equal(
    commerceMessage({
      ...offline('missing'),
      entitlementState: 'none',
      packState: 'missing',
    }, false),
    'The store is unavailable. No local purchase has been changed.',
  );
});
