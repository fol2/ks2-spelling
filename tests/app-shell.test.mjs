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
  '@capacitor/haptics': '8.0.2',
  '@capacitor/ios': '8.4.1',
  '@vitejs/plugin-react': '6.0.3',
  oxlint: '1.71.0',
  phaser: '4.1.0',
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
    learners: Object.freeze([
      Object.freeze({
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
      }),
      Object.freeze({
        learnerId: 'learner-b',
        nickname: 'Bea',
        yearGroup: 'Y4',
        colour: '#8A5A2E',
        publishedItemCount: 0,
        secureItemCount: 0,
        dueItemCount: 0,
        troubleItemCount: 0,
        correctCount: 0,
        wrongCount: 0,
        accuracyPercent: null,
        guardianDueCount: 0,
        wobblingDueCount: 0,
        nextGuardianReviewDay: null,
        recentRevisionSessions: Object.freeze([]),
      }),
    ]),
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
    vocabularySets: Object.freeze([
      Object.freeze({ id: 'core', label: 'Core', count: 20 }),
      Object.freeze({ id: 'y3-4', label: 'Y3–4', count: 20 }),
    ]),
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
    packSize: 213,
    // Guardian is the endgame: the default fixture is a learner who has not
    // reached it, which is the state every other assertion in this test
    // renders against.
    revisionMission: null,
    camp: Object.freeze({
      packId: 'ks2-core',
      campHighWater: 0,
      lastCreditedGuardianDay: null,
      canEarnToday: false,
    }),
    actionError: null,
  });
  const learning = Object.freeze({
    getState: () => learningState,
    subscribe: () => Object.freeze({ remove() {} }),
    async selectLearner() {},
    showScreen() {},
    async startRound() {},
    async startGuardianMission() {},
    async submitAnswer() {},
    async continueRound() {},
    async skipWord() {},
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
    haptics: Object.freeze({
      answerCorrect() {},
      celebrationStart() {},
      uiTick() {},
    }),
    sfx: Object.freeze({
      play() {},
      noteSpeechStarted() {},
      setEnabled() {},
      isEnabled() { return true; },
      attachGestureUnlock() {},
      dispose() {},
    }),
    setSfxEnabled() {},
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
  assert.doesNotMatch(failureHtml, /<code>/);

  const detailedFailureHtml = renderToStaticMarkup(
    React.createElement(App, {
      services: createProductFailureServices({
        cause: new Error('sqlite_profile_catalogue_alignment_failed'),
      }),
    }),
  );
  assert.match(
    detailedFailureHtml,
    /<code>sqlite_profile_catalogue_alignment_failed<\/code>/,
  );

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
  assert.match(unlockedParentHtml, /No spelling attempts saved yet\./);
  assert.doesNotMatch(unlockedParentHtml, /saved yet\.0 secure/);
  assert.doesNotMatch(unlockedParentHtml, /0 secure · 0 due · 0 needing support/);
  assert.match(unlockedParentHtml, /Full KS2 spelling/);
  assert.match(unlockedParentHtml, /£4\.99/);
  assert.match(unlockedParentHtml, /Buy Full KS2/);
  assert.match(unlockedParentHtml, /Restore purchases/);
  assert.match(unlockedParentHtml, /KS2 Spelling privacy notice/);
  assert.match(unlockedParentHtml, /no advertising, analytics or tracking/);
  assert.match(unlockedParentHtml, /Nothing is retained off the device/);
  assert.match(unlockedParentHtml, /An IP address necessarily reaches the entitlement gateway/);
  assert.match(unlockedParentHtml, /Third-party notices/);
  assert.doesNotMatch(unlockedParentHtml, /href\s*=/i);

  learningState = Object.freeze({
    ...learningState,
    screen: 'home',
  });
  const homeHtml = render();
  assert.match(homeHtml, /Ada&#x27;s spelling trail/);
  assert.match(homeHtml, /The Scribe Downs/);
  assert.match(homeHtml, /Set off/);
  assert.match(homeHtml, /words due today/);
  assert.match(homeHtml, /Listening pack needs setup/);
  for (const waypoint of ['Trail', 'Words', 'Codex', 'Camp']) {
    assert.match(homeHtml, new RegExp(`<span>${waypoint}</span>`));
  }
  assert.doesNotMatch(homeHtml, /buy|restore|price|commerce/i);
  // Unfound companions stay off the Trail meadow — empty habitat, no creature art.
  assert.match(homeHtml, /class="trail-meadow"/);
  assert.match(homeHtml, /aria-label="The trail is waiting for its first companion"/);
  assert.match(homeHtml, /class="trail-meadow-empty"/);
  assert.match(homeHtml, /Your trail is quiet/);
  assert.match(homeHtml, /Secure a spelling to wake your first companion\./);
  assert.doesNotMatch(homeHtml, /class="trail-companion /);
  assert.doesNotMatch(homeHtml, /Inklet/);

  learningState = Object.freeze({
    ...learningState,
    monsters: Object.freeze([Object.freeze({
      ...learningState.monsters[0],
      caught: true,
      secureCount: 1,
      derivedStage: 0,
      branch: 'b1',
    })]),
  });
  const trailFoundHtml = render();
  assert.match(trailFoundHtml, /class="trail-companion /);
  assert.match(
    trailFoundHtml,
    /aria-label="Inklet, Inklet Egg, Stage 0 of 4, resting in a nest"/,
  );
  assert.equal((trailFoundHtml.match(/class="trail-companion /g) ?? []).length, 1);

  learningState = Object.freeze({
    ...learningState,
    screen: 'progress',
    progress: Object.freeze([]),
  });
  const emptyProgressHtml = render();
  assert.match(emptyProgressHtml, /Word bank/);
  assert.match(emptyProgressHtml, /Your word bank is ready/);
  assert.match(emptyProgressHtml, /Set off on a round/);
  assert.match(emptyProgressHtml, /id="bank-search-input"/);
  assert.match(emptyProgressHtml, /placeholder="Search spellings"/);
  assert.match(emptyProgressHtml, /maxLength="64"/);
  assert.match(emptyProgressHtml, /aria-describedby="bank-result-count"/);
  assert.match(emptyProgressHtml, /id="bank-result-count"[^>]*role="status"/);
  assert.match(emptyProgressHtml, /aria-label="Vocabulary set"/);
  assert.match(emptyProgressHtml, /aria-label="Filter words"/);
  for (const set of ['Core', 'Y3–4']) {
    assert.match(emptyProgressHtml, new RegExp(`>${set}<`));
  }
  assert.doesNotMatch(emptyProgressHtml, />Y5–6</);
  assert.match(productSource, /vocabularySets=\{learningState\.vocabularySets\}/u);
  assert.match(productSource, /event\.key === 'Escape'/u);

  learningState = Object.freeze({
    ...learningState,
    progress: Object.freeze([Object.freeze({
      runtimeItemId: 'ks2-core:museum',
      target: 'museum',
      yearBand: '3-4',
      stage: 5,
      attempts: 9,
      correct: 9,
      wrong: 0,
      dueDay: 99_999,
      lastResult: 'correct',
    })]),
  });
  const wordBankHtml = render();
  assert.match(wordBankHtml, /data-status="secure"/);
  assert.match(wordBankHtml, /museum/);
  assert.match(wordBankHtml, /9 correct · never missed/);
  assert.match(wordBankHtml, /aria-pressed="true"[^>]*>Core</);

  learningState = Object.freeze({ ...learningState, screen: 'monster' });
  const codexHtml = render();
  assert.match(codexHtml, /Companions/);
  assert.match(codexHtml, /Growth line/);
  assert.match(codexHtml, /Roster/);
  // The roster only ever holds reward tracks this learner's content publishes.
  assert.match(codexHtml, /Left to find/);
  assert.equal((codexHtml.match(/class="codex-roster-no"/g) ?? []).length, 1);
  // The milestone ladder is about secure words, so it renders beside the stats
  // whether or not a companion is on the card.
  assert.match(codexHtml, /class="codex-ladder"/);
  // The ladder counts the engine's way — secure stage or beyond — so the
  // stage-5 word above still lights its first rung even though the companion
  // evidence (exactly at the secure stage) holds none.
  assert.match(codexHtml, /data-reached="true"/);
  // One secure word of the ten this companion's next stage wants: the hero card
  // is a long way from leaning forward.
  assert.match(codexHtml, /data-near="false"/);
  // This fixture's hero is found, so the closer-look affordance is present —
  // the unfound case below must discriminate against that baseline.
  assert.match(codexHtml, /data-found="true"/);
  assert.match(codexHtml, /Look closer at/);

  const foundCodexMonsters = learningState.monsters;
  learningState = Object.freeze({
    ...learningState,
    monsters: Object.freeze([Object.freeze({
      ...learningState.monsters[0],
      caught: false,
      secureCount: 0,
      derivedStage: 0,
      earnedStageHighWater: 0,
      branch: null,
    })]),
  });
  const unfoundCodexHtml = render();
  assert.match(unfoundCodexHtml, /data-found="false"/);
  assert.doesNotMatch(unfoundCodexHtml, /Look closer at/);
  learningState = Object.freeze({
    ...learningState,
    monsters: foundCodexMonsters,
  });

  learningState = Object.freeze({
    ...learningState,
    screen: 'setup',
    actionError: 'learning_action_failed',
  });
  const failedSetupHtml = render();
  assert.match(failedSetupHtml, /That trail could not start\. Please try again\./);
  assert.match(failedSetupHtml, /Vocabulary set/);
  assert.match(failedSetupHtml, />Core</);
  assert.match(failedSetupHtml, /Y3–4/);
  assert.doesNotMatch(failedSetupHtml, />All</);
  assert.match(failedSetupHtml, />20 words</);
  assert.match(failedSetupHtml, />Trouble</);
  assert.match(failedSetupHtml, />SATs</);
  assert.match(failedSetupHtml, /Sound effects/);
  assert.match(failedSetupHtml, /role="switch"/);
  assert.match(failedSetupHtml, /aria-label="Places on the trail"/);
  for (const waypoint of ['Trail', 'Words', 'Codex', 'Camp']) {
    assert.match(failedSetupHtml, new RegExp(`<span>${waypoint}</span>`));
  }
  assert.match(failedSetupHtml, /aria-current="page"[^>]*>[\s\S]*?<span>Trail<\/span>/);
  assert.doesNotMatch(failedSetupHtml, /Listening voice|Iapetus|Sulafat/);
  // No revision mission at all reads exactly like no access: the fourth quest
  // is painted, locked and named, and it says so under the row.
  assert.match(failedSetupHtml, /data-locked="true"/);
  assert.match(failedSetupHtml, /Not on this trail yet/);
  assert.match(failedSetupHtml, />Guardian</);
  assert.match(failedSetupHtml, />Daily</);
  // Owned egg progress paints; a hard-coded adult Inklet must not.
  assert.match(failedSetupHtml, /inklet-b1-0\.640\.webp/);
  assert.doesNotMatch(failedSetupHtml, /inklet-b1-3\.640\.webp/);

  learningState = Object.freeze({
    ...learningState,
    monsters: Object.freeze([
      Object.freeze({
        rewardTrackId: 'spelling-core-inklet',
        packId: 'ks2-core',
        monsterId: 'inklet',
        thresholds: Object.freeze([1, 10, 30, 60, 100]),
        branch: 'b1',
        secureCount: 10,
        caught: true,
        derivedStage: 1,
        earnedStageHighWater: 1,
      }),
      Object.freeze({
        rewardTrackId: 'spelling-core-glimmerbug',
        packId: 'ks2-core',
        monsterId: 'glimmerbug',
        thresholds: Object.freeze([1, 5, 15, 40, 80]),
        branch: 'b1',
        secureCount: 40,
        caught: true,
        derivedStage: 2,
        earnedStageHighWater: 2,
      }),
    ]),
  });
  const ownedSetupHtml = render();
  assert.match(ownedSetupHtml, /glimmerbug-b1-2\.640\.webp/);
  assert.doesNotMatch(ownedSetupHtml, /inklet-b1-3\.640\.webp/);
  assert.match(ownedSetupHtml, /aria-label="Places on the trail"/);

  const ownedMonsters = learningState.monsters;
  learningState = Object.freeze({
    ...learningState,
    vocabularySets: Object.freeze([
      Object.freeze({ id: 'y5-6', label: 'Y5–6', count: 104 }),
      ...learningState.vocabularySets,
    ]),
    monsters: Object.freeze(learningState.monsters.map((entry) => Object.freeze(
      entry.monsterId === 'inklet'
        ? {
          ...entry,
          secureCount: 100,
          derivedStage: 4,
          earnedStageHighWater: 4,
        }
        : entry,
    ))),
  });
  const yearFiveSixSetupHtml = render();
  assert.match(yearFiveSixSetupHtml, /glimmerbug-b1-2\.640\.webp/);
  assert.doesNotMatch(yearFiveSixSetupHtml, /inklet-b1-4\.640\.webp/);
  learningState = Object.freeze({
    ...learningState,
    monsters: ownedMonsters,
  });

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
  assert.match(practiceHtml, /aria-label="Card 1 of 5"/);
  assert.match(practiceHtml, /Spell the word you hear/);
  assert.match(practiceHtml, /Hear it again/);
  assert.match(practiceHtml, /aria-label="Replay slowly"/);
  assert.match(practiceHtml, />0\.5×</);
  const listeningControls = practiceHtml.match(
    /<div class="listen-row"[^>]*>(.*?)<\/div>/u,
  )?.[1] ?? '';
  assert.equal((listeningControls.match(/<button\b/gu) ?? []).length, 2);
  assert.doesNotMatch(listeningControls, />Sentence<|Slow sentence/);
  // The cloze keeps the sentence either side of a ruled blank, never the word.
  assert.match(practiceHtml, /<span>I<\/span>/);
  assert.match(practiceHtml, /<span>model cars with my brother\.<\/span>/);
  assert.match(practiceHtml, /class="cloze-blank"/);
  assert.match(practiceHtml, />Submit</);
  assert.match(practiceHtml, />End round</);
  assert.match(practiceHtml, />Skip for now</);
  assert.match(practiceHtml, /Answered 0 of 5/);
  assert.doesNotMatch(practiceHtml, />build</i);

  assert.match(productSource, /void play\('sentence'\)/u);
  assert.doesNotMatch(productSource, /play\('word'\)/u);
  assert.match(productSource, /yearFilter:\s*effectiveYearFilter/u);

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
  assert.match(summaryHtml, /Expedition logged/);
  assert.match(summaryHtml, /Field record/);
  assert.match(summaryHtml, /Clean sweep/);
  assert.match(summaryHtml, /Excellent work\./);
  assert.match(summaryHtml, /<span class="figure">100<\/span><small>percent<\/small>/);
  assert.match(summaryHtml, /Every word held on the first try\./);
  assert.match(summaryHtml, /record-growth/);
  assert.match(summaryHtml, /Glimmerbug/);
  assert.match(summaryHtml, /glimmerbug-b1-2\.640\.webp/);
  assert.match(summaryHtml, />Walk again</);
  assert.match(summaryHtml, />Trail</);

  // With no companion found yet, Field Record keeps the expedition sheet but
  // paints no creature art — same empty rule as the Trail meadow.
  learningState = Object.freeze({
    ...learningState,
    monsters: Object.freeze([
      Object.freeze({
        rewardTrackId: 'spelling-core-inklet',
        packId: 'ks2-core',
        monsterId: 'inklet',
        thresholds: Object.freeze([1, 10, 30, 60, 100]),
        branch: null,
        secureCount: 0,
        caught: false,
        derivedStage: 0,
        earnedStageHighWater: 0,
      }),
      Object.freeze({
        rewardTrackId: 'spelling-core-glimmerbug',
        packId: 'ks2-core',
        monsterId: 'glimmerbug',
        thresholds: Object.freeze([1, 5, 15, 40, 80]),
        branch: null,
        secureCount: 0,
        caught: false,
        derivedStage: 0,
        earnedStageHighWater: 0,
      }),
    ]),
  });
  const emptyFieldRecordHtml = render();
  assert.match(emptyFieldRecordHtml, /Field record/);
  assert.match(emptyFieldRecordHtml, /Clean sweep/);
  assert.doesNotMatch(emptyFieldRecordHtml, /record-growth/);
  assert.doesNotMatch(emptyFieldRecordHtml, /Inklet|Glimmerbug/);
  assert.doesNotMatch(emptyFieldRecordHtml, /results-halo[\s\S]*<img/u);

  // --- Guardian ------------------------------------------------------------
  // Guardian is locked until every core word is Mega, so Setup and Camp have
  // to read one projection the same way through five states.
  const TODAY_GUARDIAN_DAY = 4200;
  const guardianMission = (patch) => Object.freeze({
    missionState: 'locked',
    eligibleMissionKind: null,
    guardianDueCount: 0,
    wobblingDueCount: 0,
    nextGuardianDueDay: null,
    todayGuardianDay: TODAY_GUARDIAN_DAY,
    canStartRewardBearing: false,
    canContinueUnrewarded: false,
    campCreditState: 'available',
    ...patch,
  });
  // A pack-sized progress table with an exact Mega count, so the meter reads a
  // real figure rather than a fixture constant.
  const guardianProgress = (mega) => Object.freeze(
    Array.from({ length: 213 }, (unused, index) => Object.freeze({
      runtimeItemId: `ks2-core:word-${index}`,
      target: `word${index}`,
      yearBand: '3-4',
      stage: index < mega ? 5 : 1,
      attempts: 4,
      correct: 3,
      wrong: 1,
      dueDay: 99_999,
      lastResult: 'correct',
    })),
  );

  learningState = Object.freeze({
    ...learningState,
    screen: 'setup',
    summary: null,
    progress: guardianProgress(34),
    revisionMission: guardianMission({ campCreditState: 'unavailable' }),
  });
  const noAccessSetupHtml = render();
  assert.match(noAccessSetupHtml, /data-locked="true"/);
  assert.match(noAccessSetupHtml, /Not on this trail yet/);

  learningState = Object.freeze({
    ...learningState,
    revisionMission: guardianMission({}),
  });
  const teaserSetupHtml = render();
  // Access, but not a single word guarded yet: the tile is a destination the
  // learner can open, never a locked plate.
  assert.doesNotMatch(teaserSetupHtml, /data-locked="true"/);
  assert.doesNotMatch(teaserSetupHtml, /Not on this trail yet/);
  assert.match(teaserSetupHtml, />Guardian</);
  // A walk is still the selected quest, so the walking rails stay put.
  assert.match(teaserSetupHtml, /Round length/);

  learningState = Object.freeze({
    ...learningState,
    progress: guardianProgress(213),
    revisionMission: guardianMission({
      missionState: 'first-patrol',
      eligibleMissionKind: 'first-patrol',
      guardianDueCount: 6,
      wobblingDueCount: 2,
      nextGuardianDueDay: TODAY_GUARDIAN_DAY,
      canStartRewardBearing: true,
    }),
    camp: Object.freeze({
      packId: 'ks2-core',
      campHighWater: 3,
      lastCreditedGuardianDay: null,
      canEarnToday: true,
    }),
  });
  const dueSetupHtml = render();
  // A waiting mission is today's quest, so Setup opens on it.
  assert.match(dueSetupHtml, /Guardian Mission/);
  assert.match(dueSetupHtml, /6 due · 2 wobbling/);
  assert.match(dueSetupHtml, /Begin the patrol/);
  assert.match(dueSetupHtml, /Guardian chooses its own words/);
  // A Guardian mission has no options at all, so neither rail is offered.
  assert.doesNotMatch(dueSetupHtml, /Round length/);
  assert.doesNotMatch(dueSetupHtml, /Vocabulary set/);
  assert.doesNotMatch(dueSetupHtml, /Not on this trail yet/);

  learningState = Object.freeze({
    ...learningState,
    progress: guardianProgress(213),
    revisionMission: guardianMission({
      missionState: 'first-patrol',
      eligibleMissionKind: 'first-patrol',
      guardianDueCount: 0,
      wobblingDueCount: 0,
      nextGuardianDueDay: TODAY_GUARDIAN_DAY,
      canStartRewardBearing: true,
    }),
    camp: Object.freeze({
      packId: 'ks2-core',
      campHighWater: 0,
      lastCreditedGuardianDay: null,
      canEarnToday: true,
    }),
  });
  const firstPatrolSetupHtml = render();
  assert.match(firstPatrolSetupHtml, /First patrol/);
  assert.doesNotMatch(firstPatrolSetupHtml, /0 due/);

  learningState = Object.freeze({
    ...learningState,
    revisionMission: guardianMission({
      missionState: 'due',
      eligibleMissionKind: 'due',
      guardianDueCount: 4,
      nextGuardianDueDay: TODAY_GUARDIAN_DAY,
      canContinueUnrewarded: true,
      campCreditState: 'complete-for-today',
    }),
    camp: Object.freeze({
      packId: 'ks2-core',
      campHighWater: 7,
      lastCreditedGuardianDay: TODAY_GUARDIAN_DAY,
      canEarnToday: false,
    }),
  });
  const doneSetupHtml = render();
  // Credited today: the walk takes the button back, and the extra patrol is
  // offered quietly with what it no longer carries said out loud.
  assert.match(doneSetupHtml, /Round length/);
  assert.doesNotMatch(doneSetupHtml, /Begin the patrol/);
  assert.doesNotMatch(doneSetupHtml, /data-locked="true"/);

  learningState = Object.freeze({
    ...learningState,
    screen: 'camp',
    progress: guardianProgress(34),
    revisionMission: null,
    camp: Object.freeze({
      packId: 'ks2-core',
      campHighWater: 0,
      lastCreditedGuardianDay: null,
      canEarnToday: false,
    }),
  });
  const preUnlockCampHtml = render();
  assert.match(preUnlockCampHtml, /Guardian sleeps here/);
  assert.match(preUnlockCampHtml, /Guardian wakes when every core word is Mega/);
  assert.match(preUnlockCampHtml, /<span class="figure">34<\/span>/);
  assert.match(preUnlockCampHtml, /of 213/);
  assert.match(preUnlockCampHtml, /aria-label="34 of 213 words at Mega"/);
  assert.match(preUnlockCampHtml, /still to reach Mega/);
  assert.match(preUnlockCampHtml, /Set off on a round/);
  // No fake ring and no camp level at zero before the fire is ever lit.
  assert.doesNotMatch(preUnlockCampHtml, /camp-ring/);
  assert.doesNotMatch(preUnlockCampHtml, /Camp level/);
  assert.doesNotMatch(preUnlockCampHtml, /revisits|waiting to return/i);
  assert.doesNotMatch(preUnlockCampHtml, /Records of the watch/);

  learningState = Object.freeze({
    ...learningState,
    achievements: Object.freeze([
      Object.freeze({
        id: 'GUARDIAN_7_DAY',
        title: 'Guardian 7-day Maintainer',
        body: 'Kept Guardian Missions going on 7 different days.',
        unlockedAt: 1,
      }),
    ]),
  });
  const recordsCampHtml = render();
  assert.match(recordsCampHtml, /Records of the watch/);
  assert.match(recordsCampHtml, /aria-label="Records of the watch"/);
  assert.match(recordsCampHtml, /camp-record-chip/);
  assert.match(recordsCampHtml, /Guardian 7-day Maintainer/);
  learningState = Object.freeze({
    ...learningState,
    achievements: Object.freeze([]),
  });

  learningState = Object.freeze({
    ...learningState,
    revisionMission: guardianMission({ campCreditState: 'unavailable' }),
  });
  const noAccessCampHtml = render();
  assert.match(noAccessCampHtml, /Guardian sleeps here/);
  assert.doesNotMatch(noAccessCampHtml, /camp-ring/);
  assert.doesNotMatch(noAccessCampHtml, /Records of the watch/);

  learningState = Object.freeze({
    ...learningState,
    progress: guardianProgress(213),
    revisionMission: guardianMission({
      missionState: 'first-patrol',
      eligibleMissionKind: 'first-patrol',
      guardianDueCount: 6,
      wobblingDueCount: 2,
      nextGuardianDueDay: TODAY_GUARDIAN_DAY,
      canStartRewardBearing: true,
    }),
    camp: Object.freeze({
      packId: 'ks2-core',
      campHighWater: 3,
      lastCreditedGuardianDay: null,
      canEarnToday: true,
    }),
  });
  const dueCampHtml = render();
  assert.match(dueCampHtml, /6 words due for guarding today/);
  assert.match(dueCampHtml, /Begin the patrol/);
  assert.match(dueCampHtml, /camp-ring/);
  assert.match(dueCampHtml, /Camp level/);
  // The ring reads the run to the next banner, not the whole climb.
  assert.match(dueCampHtml, /7<\/span> to the next\s+banner/);
  // Guardian needs the listening pack exactly as a walk does, and this
  // fixture has none, so Begin cannot be pressed and says why.
  assert.match(dueCampHtml, /Listening pack needs setup/);
  assert.match(
    dueCampHtml,
    /<button type="button" class="button-primary press" disabled=""[\s\S]*?Begin the patrol/u,
  );

  learningState = Object.freeze({
    ...learningState,
    progress: guardianProgress(213),
    revisionMission: guardianMission({
      missionState: 'first-patrol',
      eligibleMissionKind: 'first-patrol',
      guardianDueCount: 0,
      wobblingDueCount: 0,
      nextGuardianDueDay: TODAY_GUARDIAN_DAY,
      canStartRewardBearing: true,
    }),
    camp: Object.freeze({
      packId: 'ks2-core',
      campHighWater: 0,
      lastCreditedGuardianDay: null,
      canEarnToday: true,
    }),
  });
  const firstPatrolCampHtml = render();
  assert.match(firstPatrolCampHtml, /The first patrol awaits/);
  assert.match(firstPatrolCampHtml, /camp fire is lit/);
  assert.doesNotMatch(firstPatrolCampHtml, /0 words due/);
  assert.match(firstPatrolCampHtml, /Begin the patrol/);

  learningState = Object.freeze({
    ...learningState,
    revisionMission: guardianMission({
      missionState: 'rested',
      nextGuardianDueDay: TODAY_GUARDIAN_DAY + 3,
    }),
    camp: Object.freeze({
      packId: 'ks2-core',
      campHighWater: 5,
      lastCreditedGuardianDay: null,
      canEarnToday: false,
    }),
  });
  const restedCampHtml = render();
  assert.match(restedCampHtml, /All guarded/);
  assert.match(restedCampHtml, /Next mission in 3 days\./);
  assert.doesNotMatch(restedCampHtml, /Begin the patrol/);
  // The Guardian day turns at 01:00 BST, so Camp counts days and never
  // promises a clock time.
  assert.doesNotMatch(
    restedCampHtml,
    /midnight|tonight|\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b/i,
  );

  learningState = Object.freeze({
    ...learningState,
    revisionMission: guardianMission({
      missionState: 'rested',
      nextGuardianDueDay: TODAY_GUARDIAN_DAY + 1,
    }),
  });
  assert.match(render(), /Next mission tomorrow\./);

  learningState = Object.freeze({
    ...learningState,
    revisionMission: guardianMission({
      missionState: 'due',
      eligibleMissionKind: 'due',
      guardianDueCount: 4,
      nextGuardianDueDay: TODAY_GUARDIAN_DAY,
      canContinueUnrewarded: true,
      campCreditState: 'complete-for-today',
    }),
    camp: Object.freeze({
      packId: 'ks2-core',
      campHighWater: 7,
      lastCreditedGuardianDay: TODAY_GUARDIAN_DAY,
      canEarnToday: false,
    }),
  });
  const doneCampHtml = render();
  assert.match(doneCampHtml, /Done today/);
  assert.match(doneCampHtml, /Patrol again — no Camp credit/);
  assert.match(doneCampHtml, /3<\/span> to the next\s+banner/);
  assert.doesNotMatch(doneCampHtml, /Begin the patrol/);

  // A Guardian round names its errand and asks for honesty rather than a skip.
  learningState = Object.freeze({
    ...learningState,
    screen: 'practice',
    practice: Object.freeze({
      sessionId: 'session-guardian',
      label: 'Guardian Mission',
      mode: 'guardian',
      phase: 'question',
      runtimeItemId: 'ks2-core:build',
      sentence: 'I build model cars with my brother.',
      cloze: 'I _____ model cars with my brother.',
      explanation: '',
      progress: Object.freeze({ total: 6, checked: 0, done: 0, wrongCount: 0 }),
      awaitingAdvance: false,
      feedback: null,
    }),
  });
  const guardianRoundHtml = render();
  assert.match(guardianRoundHtml, /class="round-mission"/);
  assert.match(guardianRoundHtml, /Guardian Mission/);
  assert.match(guardianRoundHtml, /I don’t know/);
  assert.doesNotMatch(guardianRoundHtml, /Skip for now/);
  assert.match(guardianRoundHtml, /Spell the word you hear/);
  assert.match(guardianRoundHtml, /id="product-spelling-input"/);

  const productCss = await readFile(join(ROOT, 'src/app/app.css'), 'utf8');
  assert.match(productCss, /@media\s*\(forced-colors:\s*active\)/);
  assert.match(productCss, /@media\s*\(prefers-contrast:\s*more\)/);
});

test('Results credits Camp only against the round-start baseline', async () => {
  const productSource = await readFile(
    join(ROOT, 'src/app/ProductApp.jsx'),
    'utf8',
  );
  // The camp gain is a difference, measured once on the way into the summary
  // against the camp the round started on, exactly as the monster roster is.
  assert.match(
    productSource,
    /setCampGain\(\s*\(next\.camp\?\.campHighWater \?\? 0\)\s*-\s*\(next\.roundBaseline\?\.camp\?\.campHighWater\s*\?\? next\.camp\?\.campHighWater\s*\?\? 0\),\s*\);/u,
  );
  assert.match(productSource, /campGain=\{campGain\}/u);
  assert.match(productSource, /The camp fire rises — Camp level \{camp\?\.campHighWater \?\? 0\}/u);
});

test('Results tells a Guardian wobble it returns tomorrow', async (t) => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: join(ROOT, 'vite.config.js'),
    server: { middlewareMode: true },
    appType: 'custom',
  });
  t.after(() => vite.close());
  const { ResultsScreen } = await vite.ssrLoadModule('/src/app/ProductApp.jsx');
  const summary = Object.freeze({
    mode: 'guardian',
    label: 'Guardian Mission',
    message: 'Guarded.',
    cards: Object.freeze([]),
    totalWords: 6,
    correct: 5,
    accuracy: 83,
    mistakes: Object.freeze([Object.freeze({ slug: 'rhythm', word: 'rhythm' })]),
  });
  const camp = Object.freeze({
    packId: 'ks2-core',
    campHighWater: 4,
    lastCreditedGuardianDay: 4200,
    canEarnToday: false,
  });
  const guardianHtml = renderToStaticMarkup(
    React.createElement(ResultsScreen, {
      summary,
      monsters: [],
      camp,
      campGain: 1,
      onScreen() {},
    }),
  );
  assert.match(guardianHtml, /The camp fire rises — Camp level 4/);
  assert.match(guardianHtml, /comes back tomorrow/);
  assert.match(guardianHtml, /Back tomorrow/);

  const walkHtml = renderToStaticMarkup(
    React.createElement(ResultsScreen, {
      summary: Object.freeze({ ...summary, mode: 'smart', label: 'Smart Review' }),
      monsters: [],
      camp,
      campGain: 0,
      onScreen() {},
    }),
  );
  // A walk cannot raise Camp, so the strip stays away and nothing is promised
  // for tomorrow.
  assert.doesNotMatch(walkHtml, /camp fire rises/);
  assert.doesNotMatch(walkHtml, /comes back tomorrow/);
  assert.match(walkHtml, /comes back/);
  assert.match(walkHtml, /Coming back/);
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
  // Setup quest clips upward overflow without hiding the right-edge art bleed.
  assert.match(
    productCss,
    /\.setup-quest\s*\{[^}]*overflow:\s*visible clip;/su,
  );
  // The Setup companion is the one place a learner meets art for a creature
  // they have not found, so it shares the Codex silhouette declaration rather
  // than carrying a weaker treatment of its own.
  assert.match(
    productCss,
    /\.setup-quest img\.companion-asleep[^{]*\{[^}]*filter:\s*brightness\(0\)\s*invert\(1\)\s*opacity\(0\.15\);/su,
  );
  assert.doesNotMatch(
    productCss,
    /\.setup-quest img\.companion-asleep\s*\{[^}]*grayscale/su,
  );
});

test('the product shell keeps the waypoint foot on the viewport while Words scroll', async () => {
  const productCss = await readFile(join(ROOT, 'src/app/app.css'), 'utf8');

  assert.match(
    productCss,
    /\.product-app\s*\{[^}]*height:\s*100dvh;[^}]*max-height:\s*100dvh;[^}]*overflow:\s*hidden;/su,
  );
  // Shell height must not chase --keyboard-inset; that loop dismisses iOS keys.
  assert.doesNotMatch(
    productCss,
    /\.product-app\s*\{[^}]*height:\s*calc\([^)]*--keyboard-inset/su,
  );
  assert.match(
    productCss,
    /\.bank-search\s+input\s*\{[^}]*font-size:\s*16px;/su,
  );
  assert.match(
    productCss,
    /\.product-scene\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/su,
  );
  assert.match(
    productCss,
    /\.scene-scroll\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/su,
  );
  // Scene owns the foot in normal flex flow — no absolute overlay or clearance tokens.
  assert.match(
    productCss,
    /\.waypoint-bar\s*\{[^}]*position:\s*relative;[^}]*flex:\s*none;/su,
  );
  assert.doesNotMatch(productCss, /--waypoint-clearance/);
  assert.doesNotMatch(
    productCss,
    /\.waypoint-bar\s*\{[^}]*position:\s*absolute;/su,
  );
  assert.match(
    productCss,
    /\.bank-list\s*\{[^}]*padding-bottom:\s*1\.5rem;/su,
  );
  assert.match(
    productCss,
    // Bar, spelling, rungs, and the chevron that says the row opens.
    /\.bank-row\s*\{[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\) auto auto;[^}]*min-width:\s*0;/su,
  );
  assert.match(
    productCss,
    /\.bank-row strong\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;/su,
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
  assert.match(main, /createProductFailureServices\(\{ cause: error \}\)/);
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
  // Since the E2.7 live-commerce composition the product bundle legitimately
  // carries the sandbox commerce runtime: the sandbox gateway authority
  // (b3-gateway.eugnel.uk — the only gateway until the E2.10 production
  // ceremony), the public sandbox signing keyring (b3-test-p256-2026-07) and
  // the pack registry, whose b3 row keeps the b3-sandbox-proof identifier.
  // Proof-lane mode and product identifiers stay excluded.
  for (const forbiddenProofAuthority of [
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

  const bundledCss = (
    await Promise.all(
      (await readdir(join(ROOT, 'dist/assets')))
        .filter((name) => name.endsWith('.css'))
        .map((name) => readFile(join(ROOT, 'dist/assets', name), 'utf8')),
    )
  ).join('\n');
  assert.match(bundledCss, /\.product-app/);
  assert.doesNotMatch(bundledCss, /\.b4-learner-shell/);
  assert.doesNotMatch(bundledCss, /\.status-pill/);
});
