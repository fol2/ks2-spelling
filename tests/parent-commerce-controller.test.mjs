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
  });

  await controller.refresh();
  assert.deepEqual(controller.getState(), {
    status: 'offline',
    displayPrice: '',
    entitlementState: 'active',
    packState: 'installed',
    action: null,
    actionError: null,
  });

  await controller.refresh();
  assert.deepEqual(controller.getState(), {
    status: 'ready',
    displayPrice: '',
    entitlementState: 'revoked',
    packState: 'locked',
    action: null,
    actionError: null,
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

test('an installed pack that this session did not compose tells the family to reopen the app', async (t) => {
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

  const render = (fullCatalogueActive) => renderToStaticMarkup(React.createElement(
    ParentCommerceCard,
    {
      state: Object.freeze({
        status: 'ready',
        displayPrice: '£4.99',
        entitlementState: 'active',
        packState: 'installed',
        actionError: null,
      }),
      fullCatalogueActive,
      async onPurchase() {},
      async onRestore() {},
      async onDownload() {},
      async onRecover() {},
    },
  ));

  // The learning catalogue is chosen at startup, so an install that finished
  // while the app was open is installed but not yet in front of the child.
  assert.match(render(false), /Close and reopen the app/u);
  assert.doesNotMatch(render(true), /Close and reopen the app/u);
  assert.match(render(true), /full word list is available offline/u);
});
