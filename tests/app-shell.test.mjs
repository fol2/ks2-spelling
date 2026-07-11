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

test('Capacitor and the built shell remain local-only', async () => {
  const { build } = await import('vite');
  const capacitorConfig = JSON.parse(
    await readFile(join(ROOT, 'capacitor.config.json'), 'utf8'),
  );
  assert.deepEqual(capacitorConfig, {
    appId: 'uk.eugnel.ks2spelling',
    appName: 'KS2 Spelling',
    webDir: 'dist',
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
