import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const EXPECTED_DIRECT_VERSIONS = Object.freeze({
  '@capacitor-community/sqlite': '8.1.0',
  '@capacitor/android': '8.4.1',
  '@capacitor/app': '8.1.0',
  '@capacitor/cli': '8.4.1',
  '@capacitor/core': '8.4.1',
  '@capacitor/ios': '8.4.1',
  '@vitejs/plugin-react': '6.0.3',
  oxlint: '1.71.0',
  react: '19.2.7',
  'react-dom': '19.2.7',
  vite: '8.1.4',
});

test('direct application dependencies are exactly pinned', async () => {
  const packageJson = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(
    await readFile(join(ROOT, 'package-lock.json'), 'utf8'),
  );
  assert.deepEqual(
    { ...packageJson.dependencies, ...packageJson.devDependencies },
    EXPECTED_DIRECT_VERSIONS,
  );
  assert.equal(packageJson.engines.node, '24.18.0');
  assert.equal(packageJson.packageManager, 'npm@11.16.0');
  assert.deepEqual(
    {
      ...packageLock.packages[''].dependencies,
      ...packageLock.packages[''].devDependencies,
    },
    EXPECTED_DIRECT_VERSIONS,
  );
  for (const [name, version] of Object.entries(EXPECTED_DIRECT_VERSIONS)) {
    assert.equal(packageLock.packages[`node_modules/${name}`].version, version);
  }
  for (const version of Object.values(EXPECTED_DIRECT_VERSIONS)) {
    assert.match(version, /^\d+\.\d+\.\d+$/);
  }
});

test('the local prototype shell renders its honest B1 capability boundary', async (t) => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createServer } = await import('vite');
  const { createAppServices } = await import('../src/app/create-app-services.js');
  const vite = await createServer({
    configFile: join(ROOT, 'vite.config.js'),
    server: { middlewareMode: true },
    appType: 'custom',
  });
  t.after(() => vite.close());
  const { default: App } = await vite.ssrLoadModule('/src/app/App.jsx');
  const services = createAppServices();
  const html = renderToStaticMarkup(React.createElement(App, { services }));

  assert.match(html, /KS2 Spelling/);
  assert.match(html, /Local prototype/);
  assert.match(html, /Starter content: 20 words/);
  assert.match(html, /Database \/ purchases \/ downloads: not enabled in B1/);
  assert.doesNotMatch(html, /learner progress/i);
  assert.doesNotMatch(html, /<button\b/i);
  assert.doesNotMatch(html, /monster|camp|production ready/i);
  assert.equal(services.native.capabilities.mode, 'prototype-only');
  const { loadStarterSpellingCatalogue } = await import(
    '../src/domain/spelling/index.js'
  );
  assert.equal(
    services.starterContentCount,
    loadStarterSpellingCatalogue().items.length,
    'the rendered count must come from the certified catalogue façade',
  );
});

test('the B2 shell renders exact persistence diagnostics and sanitises failures', async (t) => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: join(ROOT, 'vite.config.js'),
    server: { middlewareMode: true },
    appType: 'custom',
  });
  t.after(() => vite.close());
  const { default: App } = await vite.ssrLoadModule('/src/app/App.jsx');
  const controller = Object.freeze({
    getState() {
      return Object.freeze({
        learnerIsolation: 'verified',
        status: 'B2 proof complete',
      });
    },
    subscribe() {
      return Object.freeze({ remove() {} });
    },
    async start() {},
  });
  const services = Object.freeze({
    mode: 'b2-native-proof',
    controller,
    databaseName: 'ks2-spelling',
    platformRequirement: 'Native local data',
    schemaVersion: 1,
  });
  const html = renderToStaticMarkup(React.createElement(App, { services }));

  assert.match(html, /KS2 Spelling/);
  assert.match(html, /B2 persistence proof/);
  assert.match(html, /Database: ks2-spelling/);
  assert.match(html, /SQLite schema: 1/);
  assert.match(html, /Learner isolation: verified/);
  assert.match(html, /Lifecycle: pause, resume and relaunch verified/);
  assert.match(html, /B2 proof complete/);
  assert.doesNotMatch(html, /monster|parent|purchase|commerce/i);

  const failureHtml = renderToStaticMarkup(
    React.createElement(App, {
      services: Object.freeze({
        ...services,
        controller: Object.freeze({
          ...controller,
          getState() {
            return Object.freeze({
              learnerIsolation: 'not verified',
              status: 'B2 proof needs attention',
            });
          },
        }),
      }),
    }),
  );
  assert.match(failureHtml, /B2 proof needs attention/);
  assert.doesNotMatch(failureHtml, /wrong|answer|subjectState|practiceSession/);

  const browserFailureHtml = renderToStaticMarkup(
    React.createElement(App, {
      services: Object.freeze({
        ...services,
        platformRequirement: 'Native platform required',
        controller: Object.freeze({
          ...controller,
          getState() {
            return Object.freeze({
              learnerIsolation: 'not verified',
              status: 'B2 proof needs attention',
            });
          },
        }),
      }),
    }),
  );
  assert.match(browserFailureHtml, /Native platform required/);
  assert.match(browserFailureHtml, /Learner isolation: not verified/);
});

test('the production shell renders local profiles without proof or commerce controls', async (t) => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: join(ROOT, 'vite.config.js'),
    server: { middlewareMode: true },
    appType: 'custom',
  });
  t.after(() => vite.close());
  const { default: App } = await vite.ssrLoadModule('/src/app/App.jsx');
  const state = Object.freeze({
    status: 'ready',
    profiles: Object.freeze([Object.freeze({
      learnerId: 'learner-a',
      nickname: 'Ada',
      yearGroup: 'Y3',
      goal: 10,
      colour: '#2E7D8A',
      createdAt: 100,
      updatedAt: 100,
    })]),
    selectedLearnerId: 'learner-a',
    actionError: null,
  });
  const controller = Object.freeze({
    getState: () => state,
    subscribe: () => Object.freeze({ remove() {} }),
    async createProfile() {},
    async editProfile() {},
    async selectProfile() {},
    async removeProfile() {},
    async dispose() {},
  });
  const html = renderToStaticMarkup(
    React.createElement(App, {
      services: Object.freeze({ mode: 'product', controller }),
    }),
  );

  assert.match(html, /Who is practising\?/);
  assert.match(html, /Ada/);
  assert.match(html, /Year 3/);
  assert.match(html, /Selected/);
  assert.match(html, /Add a learner/);
  assert.doesNotMatch(
    html,
    /B1|B2|B3|B4|proof|diagnostic|buy|restore|price|commerce|remove|delete/i,
  );
});

test('the B3 shell is a Parent-only diagnostic with sanitised commerce and pack evidence', async (t) => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: join(ROOT, 'vite.config.js'),
    server: { middlewareMode: true },
    appType: 'custom',
  });
  t.after(() => vite.close());
  const { default: App } = await vite.ssrLoadModule('/src/app/App.jsx');
  const state = Object.freeze({
    status: 'ready',
    message: 'Ready for a Parent to test the sandbox purchase.',
    displayPrice: '£4.99',
    packReady: false,
    digests: Object.freeze({
      manifest: 'a'.repeat(64),
      archive: 'b'.repeat(64),
      install: null,
    }),
  });
  const controller = Object.freeze({
    getState: () => state,
    subscribe: () => Object.freeze({ remove() {} }),
    async start() {},
    async buy() {},
    async restore() {},
    async redownload() {},
  });
  const html = renderToStaticMarkup(
    React.createElement(App, {
      services: Object.freeze({ mode: 'b3-parent-proof', controller }),
    }),
  );

  assert.match(html, /B3 sandbox proof/);
  assert.match(html, /Parent-only diagnostic/);
  assert.match(html, /£4\.99/);
  assert.match(html, />Buy</);
  assert.match(html, />Restore</);
  assert.match(html, />Redownload</);
  assert.match(html, /Manifest digest/);
  assert.match(html, /Archive digest/);
  assert.match(html, /Install digest/);
  assert.match(html, /Not installed/);
  assert.match(html, /Ready for a Parent to test the sandbox purchase\./);
  assert.doesNotMatch(
    html,
    /opaque|proof-token|refresh-handle|https?:|full_ks2|learner|nickname|monster|camp/i,
  );

  const productOfflineHtml = renderToStaticMarkup(
    React.createElement(App, {
      services: Object.freeze({
        mode: 'b3-parent-proof',
        controller: Object.freeze({
          ...controller,
          getState: () => Object.freeze({
            ...state,
            status: 'failed',
            displayPrice: '',
          }),
        }),
      }),
    }),
  );
  assert.match(productOfflineHtml, /<button type="button" disabled="">Buy<\/button>/);
  assert.match(productOfflineHtml, /<button type="button">Restore<\/button>/);
  assert.match(productOfflineHtml, /<button type="button">Redownload<\/button>/);
});

test('main selects compile-time product and proof compositions without a web SQLite fallback', async () => {
  const main = await readFile(join(ROOT, 'src/main.jsx'), 'utf8');
  assert.match(main, /Capacitor\.isNativePlatform\(\)/);
  assert.match(main, /createB2AppServices/);
  assert.match(main, /createSelectedAppServices/);
  assert.match(main, /buildMode:\s*import\.meta\.env\.MODE/);
  assert.match(main, /composition\.serviceMode === 'product'/);
  assert.match(main, /productFailureServices\(\)/);
  assert.match(
    main,
    /\?\? failureServices\('Native platform required'\)/,
  );
  assert.match(main, /Native platform required/);
  assert.doesNotMatch(main, /indexeddb|jeep-sqlite|wasm/i);
});

test('Capacitor and the built shell remain local-only', async () => {
  const { build } = await import('vite');
  const capacitorConfig = JSON.parse(
    await readFile(join(ROOT, 'capacitor.config.json'), 'utf8'),
  );
  assert.deepEqual(capacitorConfig, {
    appId: 'uk.eugnel.ks2spelling',
    appName: 'KS2 Spelling',
    webDir: 'dist',
    loggingBehavior: 'none',
    plugins: {
      CapacitorSQLite: {
        iosDatabaseLocation: 'Library/CapacitorDatabase',
        iosIsEncryption: false,
        iosBiometric: { biometricAuth: false },
        androidIsEncryption: false,
        androidBiometric: { biometricAuth: false },
      },
    },
  });
  assert.equal(Object.hasOwn(capacitorConfig, 'server'), false);

  await build({ root: ROOT, logLevel: 'silent' });
  const builtHtml = await readFile(join(ROOT, 'dist/index.html'), 'utf8');
  assert.doesNotMatch(builtHtml, /<script[^>]+src=["'](?:https?:)?\/\//i);
  assert.doesNotMatch(
    builtHtml,
    /<link[^>]+rel=["']stylesheet["'][^>]+href=["'](?:https?:)?\/\//i,
  );
  assert.doesNotMatch(builtHtml, /server\.url/i);

  const starter = JSON.parse(
    await readFile(
      join(
        ROOT,
        'vendor/ks2-mastery/content/spelling.mobile-runtime-starter.json',
      ),
      'utf8',
    ),
  );
  const bundledJavaScript = (
    await Promise.all(
      (await readdir(join(ROOT, 'dist/assets')))
        .filter((name) => name.endsWith('.js'))
        .map((name) => readFile(join(ROOT, 'dist/assets', name), 'utf8')),
    )
  ).join('\n');
  assert.ok(
    bundledJavaScript.includes(starter.items[0].target),
    'the certified Starter catalogue must be included in the Vite bundle',
  );
});
