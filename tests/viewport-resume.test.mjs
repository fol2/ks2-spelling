import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  installViewportResume,
  readViewportSnapshot,
  resetProductViewport,
  viewportNeedsReset,
} from '../src/app/viewport-resume.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function source(path) {
  return readFile(join(root, path), 'utf8');
}

function createEnv(overrides = {}) {
  const contentWrites = [];
  const meta = {
    content: 'width=device-width, initial-scale=1.0, viewport-fit=cover',
    getAttribute(name) {
      return name === 'content' ? this.content : null;
    },
    setAttribute(name, value) {
      if (name !== 'content') return;
      this.content = value;
      contentWrites.push(value);
    },
  };
  const body = { tagName: 'BODY' };
  const listeners = new Map();
  const document = {
    visibilityState: 'visible',
    body,
    activeElement: body,
    querySelector(selector) {
      return selector === 'meta[name="viewport"]' ? meta : null;
    },
    addEventListener(type, listener) {
      const key = `document:${type}`;
      listeners.set(key, [...(listeners.get(key) ?? []), listener]);
    },
  };
  const visualViewport = {
    scale: 1,
    offsetTop: 0,
    offsetLeft: 0,
    width: 800,
    height: 1200,
  };
  const env = {
    document,
    visualViewport,
    innerWidth: 800,
    innerHeight: 1200,
    scrollX: 0,
    scrollY: 0,
    contentWrites,
    meta,
    listeners,
    scrollTo(x, y) {
      this.scrollX = x;
      this.scrollY = y;
    },
    addEventListener(type, listener) {
      const key = `window:${type}`;
      listeners.set(key, [...(listeners.get(key) ?? []), listener]);
    },
    dispatch(target, type, event) {
      for (const listener of listeners.get(`${target}:${type}`) ?? []) {
        listener(event);
      }
    },
  };
  return Object.assign(env, overrides);
}

test('a 1:1 product viewport does not need a resume reset', () => {
  assert.equal(
    viewportNeedsReset({
      scale: 1,
      offsetTop: 0,
      offsetLeft: 0,
      scrollX: 0,
      scrollY: 0,
      visualHeight: 1200,
      layoutHeight: 1200,
    }),
    false,
  );
});

test('leftover visual-viewport scale, keyboard offset or height gap need a reset', () => {
  assert.equal(viewportNeedsReset({ scale: 1.25, visualHeight: 800, layoutHeight: 800 }), true);
  assert.equal(
    viewportNeedsReset({
      scale: 1,
      offsetTop: 340,
      visualHeight: 860,
      layoutHeight: 1200,
    }),
    true,
  );
  assert.equal(
    viewportNeedsReset({
      scale: 1,
      offsetTop: 0,
      offsetLeft: 0,
      scrollX: 0,
      scrollY: 0,
      visualHeight: 720,
      layoutHeight: 1200,
    }),
    true,
    'a keyboard-shrunk visual viewport with an empty beige gap must reset',
  );
});

test('readViewportSnapshot copies visualViewport geometry without owning keyboard inset CSS', () => {
  const env = createEnv();
  env.visualViewport.scale = 1.5;
  env.visualViewport.offsetTop = 48;
  env.scrollY = 12;
  assert.deepEqual(readViewportSnapshot(env), {
    scale: 1.5,
    offsetTop: 48,
    offsetLeft: 0,
    scrollX: 0,
    scrollY: 12,
    visualWidth: 800,
    visualHeight: 1200,
    layoutWidth: 800,
    layoutHeight: 1200,
  });
});

test('resetProductViewport restores 1:1 scale then puts the authored viewport meta back', () => {
  const env = createEnv();
  env.visualViewport.scale = 1.4;
  env.scrollY = 80;
  const focused = {
    tagName: 'INPUT',
    preventScroll: false,
    focus(options) {
      this.preventScroll = options?.preventScroll === true;
    },
  };
  env.document.activeElement = focused;

  resetProductViewport(env);

  assert.equal(env.scrollX, 0);
  assert.equal(env.scrollY, 0);
  assert.ok(env.contentWrites.some((value) => /maximum-scale\s*=\s*1(?:\.0)?\b/u.test(value)));
  assert.equal(
    env.meta.content,
    'width=device-width, initial-scale=1.0, viewport-fit=cover',
  );
  assert.equal(focused.preventScroll, true);
  assert.doesNotMatch(env.meta.content, /user-scalable\s*=\s*no/u);
});

test('resetProductViewport stays idle while the document is hidden', () => {
  const env = createEnv();
  env.document.visibilityState = 'hidden';
  env.visualViewport.scale = 2;
  env.scrollY = 40;
  resetProductViewport(env);
  assert.equal(env.scrollY, 40);
  assert.equal(env.contentWrites.length, 0);
});

test('installViewportResume resets on becoming visible and on persisted pageshow', () => {
  const env = createEnv();
  env.visualViewport.scale = 1.3;
  const run = installViewportResume(env);
  assert.equal(typeof run, 'function');
  assert.equal(installViewportResume(env), run);

  env.document.visibilityState = 'visible';
  env.dispatch('document', 'visibilitychange');
  assert.equal(env.scrollY, 0);
  assert.equal(
    env.meta.content,
    'width=device-width, initial-scale=1.0, viewport-fit=cover',
  );

  env.visualViewport.scale = 1.2;
  env.scrollY = 24;
  env.dispatch('window', 'pageshow', { persisted: true });
  assert.equal(env.scrollY, 0);
});

test('a first pageshow of an already 1:1 viewport does not toggle the meta', () => {
  const env = createEnv();
  installViewportResume(env);
  env.dispatch('window', 'pageshow', { persisted: false });
  assert.equal(env.contentWrites.length, 0);
});

test('the product entry installs viewport resume without a second keyboard owner', async () => {
  const [main, productApp, indexHtml, moduleSource] = await Promise.all([
    source('src/main.jsx'),
    source('src/app/ProductApp.jsx'),
    source('index.html'),
    source('src/app/viewport-resume.js'),
  ]);

  assert.match(main, /installViewportResume\(\)/u);
  assert.match(main, /from '\.\/app\/viewport-resume\.js'/u);
  assert.doesNotMatch(productApp, /visualViewport|installViewportResume|viewport-resume/u);
  assert.doesNotMatch(moduleSource, /@capacitor\/keyboard|--keyboard-inset/u);
  assert.match(
    indexHtml,
    /content="width=device-width, initial-scale=1\.0, viewport-fit=cover"/u,
  );
  assert.doesNotMatch(indexHtml, /user-scalable\s*=\s*no|maximum-scale/u);
});
