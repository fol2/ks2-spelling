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

test('the production shell keeps Parent progress and commerce behind the local gate', async (t) => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createServer } = await import('vite');
  const productSource = await readFile(
    join(ROOT, 'src/app/ProductApp.jsx'),
    'utf8',
  );
  const vite = await createServer({
    configFile: join(ROOT, 'vite.config.js'),
    server: { middlewareMode: true },
    appType: 'custom',
  });
  t.after(() => vite.close());
  const { default: App } = await vite.ssrLoadModule('/src/app/App.jsx');
  const {
    LeaveRoundDialog,
    ParentArea,
  } = await vite.ssrLoadModule('/src/app/ProductApp.jsx');
  const { createProductFailureServices } = await vite.ssrLoadModule(
    '/src/app/product-failure-services.js',
  );
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
  const audioState = Object.freeze({
    status: 'missing',
    activeVersion: null,
    actionError: null,
  });
  const audioAvailability = Object.freeze({
    getState: () => audioState,
    subscribe: () => Object.freeze({ remove() {} }),
    async refresh() {},
    async recover() {},
    reportPlaybackFailure() {},
    async dispose() {},
  });
  const parentState = Object.freeze({
    status: 'locked',
    biometric: Object.freeze({
      available: true,
      type: 'face',
      enabled: true,
    }),
    attemptsRemaining: 5,
    lockedUntil: 0,
    actionError: null,
  });
  const parent = Object.freeze({
    getState: () => parentState,
    subscribe: () => Object.freeze({ remove() {} }),
    async setPin() {},
    async unlockWithPin() {},
    async unlockWithBiometrics() {},
    async setBiometricsEnabled() {},
    lock() {},
  });
  const parentAdministration = Object.freeze({
    async resetLearning() {},
  });
  const parentBackup = Object.freeze({
    async exportBackup() {
      return Object.freeze({ presented: true });
    },
    async importBackup() {
      return Object.freeze({ cancelled: true });
    },
  });
  const parentProgressState = Object.freeze({
    status: 'ready',
    learners: Object.freeze([Object.freeze({
      learnerId: 'learner-a',
      nickname: 'Ada',
      yearGroup: 'Y3',
      colour: '#2E7D8A',
      publishedItemCount: 20,
      secureItemCount: 1,
      dueItemCount: 2,
      troubleItemCount: 1,
      correctCount: 5,
      wrongCount: 1,
      accuracyPercent: 83,
      guardianDueCount: 0,
      wobblingDueCount: 0,
      nextGuardianReviewDay: null,
      recentRevisionSessions: Object.freeze([]),
    })]),
    actionError: null,
  });
  const parentProgress = Object.freeze({
    getState: () => parentProgressState,
    subscribe: () => Object.freeze({ remove() {} }),
    async refresh() {},
    async dispose() {},
  });
  const parentCommerceState = Object.freeze({
    status: 'ready',
    displayPrice: '£4.99',
    entitlementState: 'none',
    packState: 'missing',
    action: null,
    actionError: null,
  });
  const parentCommerce = Object.freeze({
    getState: () => parentCommerceState,
    subscribe: () => Object.freeze({ remove() {} }),
    async start() {},
    async refresh() {},
    async purchase() {},
    async restore() {},
    async download() {},
    async recover() {},
    async dispose() {},
  });
  let learningState = Object.freeze({
    status: 'ready',
    screen: 'profiles',
    learnerId: 'learner-a',
    practice: null,
    summary: null,
    progress: [],
    monsters: Object.freeze([Object.freeze({
      rewardTrackId: 'spelling-core-inklet',
      packId: 'ks2-core',
      monsterId: 'inklet',
      thresholds: Object.freeze([1, 10, 30, 60, 100]),
      branch: null,
      secureCount: 0,
      caught: false,
      derivedStage: 0,
      earnedStageHighWater: 0,
    })]),
    camp: Object.freeze({
      packId: 'ks2-core',
      campHighWater: 0,
      lastCreditedGuardianDay: null,
    }),
    actionError: null,
  });
  const learning = Object.freeze({
    getState: () => learningState,
    subscribe: () => Object.freeze({ remove() {} }),
    async selectLearner() {},
    showScreen() {},
    async startSmartRound() {},
    async submitAnswer() {},
    async continueRound() {},
    async endRound() {},
    async dispose() {},
  });
  const services = Object.freeze({
    mode: 'product',
    controller,
    learning,
    audioAvailability,
    parent,
    parentProgress,
    parentCommerce,
    parentAdministration,
    parentBackup,
    audio: Object.freeze({ async play() {} }),
  });
  const render = () => renderToStaticMarkup(
    React.createElement(App, { services }),
  );
  const html = render();

  const failureHtml = renderToStaticMarkup(
    React.createElement(App, {
      services: createProductFailureServices(),
    }),
  );
  assert.match(failureHtml, /Your saved learning could not open/);
  assert.match(failureHtml, /Your local data has not been replaced/);
  assert.match(failureHtml, /Try opening again/);

  assert.match(html, /Who is practising\?/);
  assert.match(html, /Ada/);
  assert.match(html, /Year 3/);
  assert.match(html, /Selected/);
  assert.match(html, /Add a learner/);
  assert.match(html, /Listening pack needs setup/);
  assert.match(html, /pre-recorded audio/i);
  assert.match(html, /Check again/);
  assert.match(html, /For parents/);
  assert.doesNotMatch(html, /speech synthesis|text.to.speech|network speech/i);
  assert.doesNotMatch(
    html,
    /B1|B2|B3|B4|proof|diagnostic|buy|restore|price|commerce|remove|delete|Manage learners/i,
  );

  const lockedParentHtml = renderToStaticMarkup(
    React.createElement(ParentArea, {
      state: parentState,
      profiles: state.profiles,
      progressState: parentProgressState,
      commerceState: parentCommerceState,
      onClose() {},
      async onSetPin() {},
      async onUnlockPin() {},
      async onUnlockBiometrics() {},
      async onSetBiometricsEnabled() {},
      async onEditProfile() {},
      async onRemoveProfile() {},
      async onResetLearning() {},
      async onExportBackup() {},
      async onImportBackup() {},
      async onRefreshProgress() {},
      async onPurchase() {},
      async onRestore() {},
      async onDownload() {},
      async onRecoverCommerce() {},
    }),
  );
  assert.match(lockedParentHtml, /Parent access/);
  assert.match(lockedParentHtml, /Enter Parent PIN/);
  assert.match(lockedParentHtml, /Use Face ID/);
  assert.doesNotMatch(
    lockedParentHtml,
    /Manage learners|Delete learner|Reset learning|learning backup|Restore purchase|Buy/i,
  );

  const unlockedParentHtml = renderToStaticMarkup(
    React.createElement(ParentArea, {
      state: Object.freeze({
        ...parentState,
        status: 'unlocked',
      }),
      profiles: state.profiles,
      progressState: parentProgressState,
      commerceState: parentCommerceState,
      onClose() {},
      async onSetPin() {},
      async onUnlockPin() {},
      async onUnlockBiometrics() {},
      async onSetBiometricsEnabled() {},
      async onEditProfile() {},
      async onRemoveProfile() {},
      async onResetLearning() {},
      async onExportBackup() {},
      async onImportBackup() {},
      async onRefreshProgress() {},
      async onPurchase() {},
      async onRestore() {},
      async onDownload() {},
      async onRecoverCommerce() {},
    }),
  );
  assert.match(unlockedParentHtml, /Parent area/);
  assert.match(unlockedParentHtml, /Manage learners/);
  assert.match(unlockedParentHtml, /Ada/);
  assert.match(unlockedParentHtml, /Edit Ada/);
  assert.match(unlockedParentHtml, /Delete learner/);
  assert.match(unlockedParentHtml, /Reset learning/);
  assert.match(unlockedParentHtml, /Export learning backup/);
  assert.match(unlockedParentHtml, /Import learning backup/);
  assert.match(unlockedParentHtml, /replaces every learner/i);
  assert.match(unlockedParentHtml, /Face ID is on/);
  assert.match(unlockedParentHtml, /Spelling progress/);
  assert.match(unlockedParentHtml, /5 of 6 attempts correct/);
  assert.match(unlockedParentHtml, /1 secure · 2 due/);
  assert.match(unlockedParentHtml, /Full KS2 spelling/);
  assert.match(unlockedParentHtml, /£4\.99/);
  assert.match(unlockedParentHtml, /Buy Full KS2/);
  assert.match(unlockedParentHtml, /Restore purchases/);
  assert.match(unlockedParentHtml, /Privacy &amp; app information/);
  assert.match(unlockedParentHtml, /No advertising, analytics or tracking/);
  assert.match(unlockedParentHtml, /Third-party notices/);

  learningState = Object.freeze({
    ...learningState,
    screen: 'home',
  });
  const homeHtml = render();
  assert.match(homeHtml, /Ada&#x27;s spelling trail/);
  assert.match(homeHtml, /Start a Smart Review/);
  assert.match(homeHtml, /Inklet/);
  assert.match(homeHtml, /Listening pack needs setup/);
  assert.match(homeHtml, /Progress/);
  assert.match(homeHtml, /Camp/);
  assert.doesNotMatch(homeHtml, /buy|restore|price|commerce/i);

  learningState = Object.freeze({
    ...learningState,
    screen: 'progress',
    progress: Object.freeze([]),
  });
  const emptyProgressHtml = render();
  assert.match(emptyProgressHtml, /Your trail is ready/);
  assert.match(emptyProgressHtml, /Start a Smart Review/);

  learningState = Object.freeze({
    ...learningState,
    screen: 'setup',
    actionError: 'learning_action_failed',
  });
  const failedSetupHtml = render();
  assert.match(failedSetupHtml, /That trail could not start\. Please try again\./);

  learningState = Object.freeze({
    ...learningState,
    screen: 'practice',
    actionError: null,
    practice: Object.freeze({
      sessionId: 'session-a',
      label: 'Smart review',
      phase: 'question',
      runtimeItemId: 'ks2-core:build',
      sentence: 'I build model cars with my brother.',
      cloze: 'I _____ model cars with my brother.',
      explanation: 'To build means to make something.',
      progress: Object.freeze({
        total: 5,
        checked: 0,
        done: 0,
        wrongCount: 0,
      }),
      awaitingAdvance: false,
      feedback: null,
    }),
  });
  const practiceHtml = render();
  assert.match(practiceHtml, /Card 1 of 5/);
  assert.match(practiceHtml, /Hear word/);
  assert.match(practiceHtml, /Hear sentence/);
  assert.match(practiceHtml, /Slow sentence/);
  assert.match(practiceHtml, /I _____ model cars with my brother\./);
  assert.match(practiceHtml, /Check spelling/);
  assert.doesNotMatch(practiceHtml, />build</i);

  const leaveRoundHtml = renderToStaticMarkup(
    React.createElement(LeaveRoundDialog, {
      onKeep() {},
      onLeave() {},
    }),
  );
  assert.match(leaveRoundHtml, /role="alertdialog"/);
  assert.match(leaveRoundHtml, /aria-modal="true"/);
  assert.match(leaveRoundHtml, /aria-labelledby="leave-round-title"/);
  assert.match(leaveRoundHtml, /Keep practising/);
  assert.match(leaveRoundHtml, /Leave round/);

  const failedLeaveRoundHtml = renderToStaticMarkup(
    React.createElement(LeaveRoundDialog, {
      error: 'This round could not be saved as unfinished. Please try again or keep practising.',
      leaving: false,
      onKeep() {},
      onLeave() {},
    }),
  );
  assert.match(failedLeaveRoundHtml, /id="leave-round-error"/);
  assert.match(failedLeaveRoundHtml, /role="alert"/);
  assert.match(
    failedLeaveRoundHtml,
    /This round could not be saved as unfinished\. Please try again or keep practising\./,
  );
  assert.match(productSource, /await onEnd\(\)/);
  assert.match(productSource, /setExitError\(/);
  assert.doesNotMatch(
    productSource,
    /void services\.learning\.endRound\(\)\.catch\(\(\) => undefined\)/,
  );

  learningState = Object.freeze({
    ...learningState,
    screen: 'summary',
    practice: null,
    summary: Object.freeze({
      mode: 'smart',
      label: 'Smart review',
      message: 'Excellent work.',
      cards: Object.freeze([
        Object.freeze({
          label: 'Words in round',
          value: 5,
          sub: 'Unique words selected',
        }),
      ]),
      totalWords: 5,
      correct: 5,
      accuracy: 100,
      mistakes: Object.freeze([]),
    }),
  });
  const summaryHtml = render();
  assert.match(summaryHtml, /Trail complete/);
  assert.match(summaryHtml, /Excellent work\./);
  assert.match(summaryHtml, /100%/);
  assert.match(summaryHtml, /Back to trail/);

  const productCss = await readFile(join(ROOT, 'src/app/app.css'), 'utf8');
  assert.match(productCss, /@media\s*\(forced-colors:\s*active\)/);
  assert.match(productCss, /@media\s*\(prefers-contrast:\s*more\)/);
});

test('the product shell consumes native safe-area insets', async () => {
  const [indexHtml, productCss] = await Promise.all([
    readFile(join(ROOT, 'index.html'), 'utf8'),
    readFile(join(ROOT, 'src/app/app.css'), 'utf8'),
  ]);
  const viewport = indexHtml.match(
    /<meta\s+name="viewport"\s+content="([^"]+)"/u,
  );
  assert.ok(viewport, 'the app must declare a viewport');
  assert.match(viewport[1], /(?:^|,\s*)viewport-fit=cover(?:,|$)/u);
  for (const side of ['top', 'right', 'bottom', 'left']) {
    assert.match(
      productCss,
      new RegExp(
        `var\\(--safe-area-inset-${side},\\s*env\\(safe-area-inset-${side},\\s*0px\\)\\)`,
        'u',
      ),
    );
  }
  assert.match(
    productCss,
    /\.product-topbar\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;/su,
  );
  assert.match(
    productCss,
    /\.product-topbar p\s*\{[^}]*min-width:\s*0;[^}]*flex:\s*1 1 8rem;/su,
  );
  assert.match(
    productCss,
    /\.topbar-action\s*\{[^}]*max-width:\s*100%;[^}]*overflow-wrap:\s*anywhere;/su,
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
  assert.match(main, /createProductFailureServices\(\)/);
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
  for (const forbiddenProofAuthority of [
    'b3-gateway.eugnel.uk',
    'b3-test-p256-2026-07',
    'b3-sandbox-proof',
    'b4-starter-product',
    'B3DeterministicTest',
    'B4Development',
  ]) {
    assert.equal(
      bundledJavaScript.includes(forbiddenProofAuthority),
      false,
      `production JavaScript must exclude ${forbiddenProofAuthority}`,
    );
  }
});
