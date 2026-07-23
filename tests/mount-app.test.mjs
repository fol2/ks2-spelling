import assert from 'node:assert/strict';
import test from 'node:test';

import { mountApp } from '../src/app/mount-app.js';

function deferred() {
  let resolve;
  const promise = new Promise((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

test('mountApp paints the loading shell before services finish initialising', async () => {
  const renders = [];
  const servicesReady = deferred();
  const root = { id: 'root' };
  let disposed = false;
  const services = Object.freeze({
    mode: 'b4-starter-product',
    async dispose() { disposed = true; },
  });
  let pageHide = null;

  const mountPromise = mountApp({
    root,
    createRoot(target) {
      assert.equal(target, root);
      return {
        render(node) { renders.push(node); },
      };
    },
    createServices: async () => {
      assert.equal(renders.length, 1, 'loading shell must render before createServices resolves');
      return servicesReady.promise;
    },
    renderLoading: () => 'loading-shell',
    renderApp: (next) => ({ app: next }),
    onPageHide(listener) { pageHide = listener; },
  });

  assert.deepEqual(renders, ['loading-shell']);

  servicesReady.resolve(services);
  await mountPromise;

  assert.deepEqual(renders, ['loading-shell', { app: services }]);
  assert.equal(typeof pageHide, 'function');
  pageHide();
  await Promise.resolve();
  assert.equal(disposed, true);
});

test('mountApp replaces the loading shell with failure services when initialisation fails', async () => {
  const renders = [];
  const failure = Object.freeze({ mode: 'failure' });
  await mountApp({
    root: {},
    createRoot: () => ({ render(node) { renders.push(node); } }),
    createServices: async () => {
      throw new Error('native_unavailable');
    },
    createFailureServices: () => failure,
    renderLoading: () => 'loading-shell',
    renderApp: (services) => ({ app: services }),
    onPageHide() {},
  });
  assert.deepEqual(renders, ['loading-shell', { app: failure }]);
});
