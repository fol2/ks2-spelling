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
  '@capacitor/keyboard': '8.0.5',
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
    EndRoundDialog,
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
    prefs: Object.freeze({
      voiceId: 'Iapetus',
      showCloze: true,
      autoSpeak: true,
    }),
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
    async startRound() {},
    async submitAnswer() {},
    async continueRound() {},
    async skipWord() {},
    async savePrefs() {},
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
  // The device's saved selection says who was open here, never that they
  // practised: the picker has no answer data to make that claim from.
  assert.match(html, /Last opened/);
  assert.doesNotMatch(html, /Last practised/);
  assert.match(html, /Add a learner/);
  // A name is set in the display serif at headline size and carries its own
  // colour as a spine. The letter-in-a-square avatar is gone: it pushed the
  // name down to a caption to make room for itself.
  assert.match(html, /class="learner-name"/);
  assert.doesNotMatch(html, /learner-avatar/);
  assert.match(html, /--learner-colour/);
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
  // The home hero is world-first: the art is behind the whole page and the
  // mission block names the learner and the place.
  assert.match(homeHtml, /class="hero-backdrop"/);
  assert.match(homeHtml, /data-hero-tone="1"/);
  assert.match(homeHtml, /The Scribe Downs/);
  assert.match(homeHtml, /Hi Ada — ready for a short round\?/);
  assert.match(homeHtml, /Today&#x27;s words are <em>waiting\.<\/em>/);
  assert.match(homeHtml, /Start a Smart Review/);
  assert.match(homeHtml, /Your first companion/);
  assert.match(homeHtml, /Finish a round/);
  assert.doesNotMatch(homeHtml, /buy|restore|price|commerce/i);

  // The screen reads in the order the job runs in. `dueCopy` is today's status
  // and used to be glued onto the headline as its second line, where "words are
  // waiting" and "nothing due today" contradicted each other inside one
  // sentence. Both strings are still there; only one of them is the headline.
  assert.match(homeHtml, /<h1 id="home-title">Today&#x27;s words are <em>waiting\.<\/em><\/h1>/);
  assert.match(homeHtml, /class="hero-due" data-due="none">Nothing due today/);
  assert.ok(
    homeHtml.indexOf('hero-due') < homeHtml.indexOf('Start a Smart Review'),
    'the day\'s status comes before the action it explains',
  );
  assert.ok(
    homeHtml.indexOf('Start a Smart Review') < homeHtml.indexOf('companions-title'),
    'the action outranks the collection strip it used to sit below',
  );

  // A device-status panel is on a child's home screen only when something is
  // wrong with it: working audio was taking a full row to say so.
  assert.match(homeHtml, /Listening pack needs setup/);

  // The four sections are a persistent strip, not rows on the home screen, so
  // every one of them is reachable from every one of the others. Order is part
  // of the contract: a tab strip that reorders itself is a different app each
  // time it is opened.
  assert.match(homeHtml, /<nav class="trail-tabs" aria-label="Sections">/);
  assert.deepEqual(
    [...homeHtml.matchAll(/<span>(Trail|Words|Codex|Camp)<\/span>/gu)]
      .map(([, label]) => label),
    ['Trail', 'Words', 'Codex', 'Camp'],
  );
  // Exactly one tab is current, and on the home screen it is the first.
  assert.equal(homeHtml.match(/aria-current="page"/gu)?.length, 1);
  assert.match(
    homeHtml,
    /class="trail-tab" aria-current="page">.*?<span>Trail<\/span>/su,
  );
  // The bar carries who is practising rather than the app's own name, and the
  // page declares which bars it has so the CSS can reserve their space.
  assert.match(homeHtml, /data-chrome="bar tabs"/);
  assert.match(
    homeHtml,
    /class="learner-chip"[^>]*aria-label="Switch learner — Ada is practising"/,
  );
  assert.doesNotMatch(homeHtml, /KS2 Spelling/);

  learningState = Object.freeze({
    ...learningState,
    screen: 'home',
    monsters: Object.freeze([Object.freeze({
      rewardTrackId: 'spelling-core-inklet',
      packId: 'ks2-core',
      monsterId: 'inklet',
      thresholds: Object.freeze([1, 10, 30, 60, 100]),
      branch: 'b1',
      secureCount: 1,
      caught: true,
      derivedStage: 0,
      earnedStageHighWater: 0,
    })]),
  });
  const meadowHtml = render();
  assert.match(meadowHtml, /monster-meadow/);
  assert.match(meadowHtml, /Inklet/);
  assert.match(meadowHtml, /Glimmerbug locked/);
  assert.match(meadowHtml, /Phaeton locked/);
  assert.doesNotMatch(meadowHtml, /buy|restore|price|commerce/i);

  learningState = Object.freeze({
    ...learningState,
    screen: 'monster',
  });
  const codexHtml = render();
  assert.match(codexHtml, /Your companions/);
  assert.match(codexHtml, /Not found yet/);
  assert.match(codexHtml, /Meet Inklet/);
  assert.match(codexHtml, /codex-card is-locked/);
  assert.doesNotMatch(codexHtml, /Buy Full KS2|buy|restore|price|commerce/i);
  // One word for one thing. This screen called them monsters in the eyebrow,
  // creatures in the heading and companions in the body, while the home screen
  // called them companions and the tab calls the place the Codex. Asserted over
  // the visible words only — `monster-stage` is a class name, not copy.
  const codexWords = codexHtml.replace(/<[^>]*>/gu, ' ');
  assert.doesNotMatch(codexWords, /roster|creature|monster/iu);
  // The sentence ruling out a child-facing purchase was written for a reviewer,
  // and took four lines of a child's screen to say so.
  assert.doesNotMatch(codexWords, /child-facing|purchase/iu);
  // An uncaught entry shows an empty slot rather than the stage-0 art of the
  // creature turned to a grey lump: two locked entries, two empty slots, and
  // painted art only for the one that has actually been caught.
  assert.equal((codexHtml.match(/codex-card is-locked/gu) ?? []).length, 2);
  assert.equal((codexHtml.match(/codex-card-empty/gu) ?? []).length, 2);
  assert.equal((codexHtml.match(/class="codex-card-art"/gu) ?? []).length, 1);

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

  // Starting the round is pinned, not appended: it used to be the last node in
  // the scrolling card, behind six stat cells, three round types, three length
  // chips, two voices, two toggles and a status panel.
  assert.match(failedSetupHtml, /<div class="page-action"><button[^>]*class="button-primary button-large"/);
  assert.match(failedSetupHtml, /data-chrome="bar action"/);
  assert.ok(
    failedSetupHtml.indexOf('class="setup-card"')
      < failedSetupHtml.indexOf('class="page-action"'),
    'the action bar is a sibling of the scrolling card, not inside it',
  );

  // Folded, not hidden: the summary line names the settings currently in force,
  // so a round's shape can be read without opening anything.
  assert.match(failedSetupHtml, /class="setup-more-value">5 words · Iapetus</);

  // Every group is named in words a learner reads, not in words from inside
  // the app. "Options" in particular named nothing at all.
  for (const legend of [
    'Round type',
    'How many words',
    'Reading voice',
    'Help during the round',
  ]) {
    assert.match(failedSetupHtml, new RegExp(`<legend>${legend}</legend>`, 'u'));
  }
  for (const jargon of ['Workshop mode', 'Round length', '<legend>Options<']) {
    assert.doesNotMatch(failedSetupHtml, new RegExp(jargon, 'u'));
  }

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
  // The dot strip is the whole round head: it counts what has been banked,
  // never a card position, so a learner working through a retry does not see
  // the same card number against three different words. The sentence that
  // used to spell the same count out in words is gone — the strip's label is
  // what a screen reader reads, and it is a live region.
  assert.match(practiceHtml, /aria-label="0 of 5 words secured"/);
  assert.match(practiceHtml, /aria-live="polite"[^>]*aria-label="0 of 5 words secured"/);
  assert.doesNotMatch(practiceHtml, /Card \d+ of \d+/);
  assert.doesNotMatch(practiceHtml, /You have answered/);
  assert.doesNotMatch(practiceHtml, /left in this round/);
  // No chrome over a round: the brand mark and the mode name cost height the
  // card needs once the keyboard is up.
  assert.doesNotMatch(practiceHtml, /class="product-topbar"/);
  assert.doesNotMatch(practiceHtml, /class="brand-mark"/);
  // The answer line takes a spelling keyboard: British English, a submit key
  // rather than a dismiss key, and none of the aids that would give the
  // answer away.
  assert.match(practiceHtml, /lang="en-GB"/);
  assert.match(practiceHtml, /enterkeyhint="go"/i);
  assert.match(practiceHtml, /autocorrect="off"/i);
  assert.match(practiceHtml, /spellcheck="false"/i);
  assert.match(practiceHtml, /writingsuggestions="false"/i);
  // The listening controls are icon-only, as they are on the web card: the
  // name lives in aria-label so the row stays quiet beside the sentence.
  // Two listening controls, both the sentence: KS2 spelling is dictated in
  // context, so a bare word is not a cue this test gives.
  const sentenceCue = practiceHtml.indexOf('aria-label="Replay the sentence"');
  const slowCue = practiceHtml.indexOf('aria-label="Replay the sentence slowly"');
  assert.ok(sentenceCue > -1 && slowCue > -1);
  assert.ok(sentenceCue < slowCue);
  assert.equal((practiceHtml.match(/class="btn-icon"/g) ?? []).length, 2);
  assert.doesNotMatch(practiceHtml, /Replay the word on its own/);
  assert.doesNotMatch(practiceHtml, />\s*Hear word\s*</);
  // The card leads with a quiet instruction, never a headline.
  assert.match(practiceHtml, /Spell the word you hear\./);
  assert.doesNotMatch(practiceHtml, /Hear the word, then spell it/);
  assert.match(practiceHtml, /AI-generated dictation voice/);
  assert.match(practiceHtml, /Skip for now/);
  // The gap is drawn as a rule rather than printed as underscores.
  assert.match(practiceHtml, /class="cloze-blank"/);
  assert.match(practiceHtml, /model cars with my brother/);
  // Upstream's submit is "Submit →"; the round's housekeeping — the voice
  // note and leaving early — sits in a footer outside the card.
  assert.match(practiceHtml, /Submit/);
  assert.match(practiceHtml, /class="session-footer"/);
  assert.match(practiceHtml, /End round early/);
  assert.doesNotMatch(practiceHtml, /Check spelling/);
  assert.doesNotMatch(practiceHtml, />build</i);

  // Skip is offered exactly where the engine will accept it. `skipCurrent` in
  // the vendored legacy engine returns null unless the session is a learning
  // one on phase 'question', so any other phase must not show a control that
  // would come back refused — a learner part-way through a teach loop is being
  // taught this word, not being asked whether they want it.
  const skipCases = [
    { patch: { phase: 'retry' }, offered: false },
    { patch: { phase: 'correction' }, offered: false },
    { patch: { phase: 'question', awaitingAdvance: true }, offered: false },
    { patch: { phase: 'question', mode: 'test' }, offered: false },
    { patch: { phase: 'question' }, offered: true },
  ];
  const questionPractice = learningState.practice;
  for (const { patch, offered } of skipCases) {
    learningState = Object.freeze({
      ...learningState,
      practice: Object.freeze({ ...questionPractice, ...patch }),
    });
    const html = render();
    const label = JSON.stringify(patch);
    if (offered) {
      assert.match(html, /Skip for now/, `skip must be offered for ${label}`);
    } else {
      assert.doesNotMatch(html, /Skip for now/, `skip must be hidden for ${label}`);
    }
  }
  // A wrong answer names the spelling being taught and quotes what the learner
  // wrote in the sentence about it. The attempt used to be displayed beside the
  // headline and struck through whenever the engine gave no target, which reads
  // as the app crossing out the correct answer — under the line "Your answer — "
  // whose second half came from a body the engine had not filled, so it read
  // "Your answer — No answer shown yet." while showing one.
  const wrongFeedback = Object.freeze({
    kind: 'error',
    headline: 'Not yet',
    attemptedAnswer: 'bild',
    answer: 'build',
    body: 'Look at the letters, then type it again.',
  });
  learningState = Object.freeze({
    ...learningState,
    practice: Object.freeze({
      ...questionPractice,
      phase: 'retry',
      feedback: wrongFeedback,
    }),
  });
  const wrongHtml = render();
  assert.match(wrongHtml, /class="feedback-word">“build”/);
  assert.match(wrongHtml, /You wrote “bild”\. Look at the letters/);
  assert.doesNotMatch(wrongHtml, /is-attempt/);
  assert.doesNotMatch(wrongHtml, /Your answer/);
  assert.doesNotMatch(
    wrongHtml,
    /class="feedback-word[^"]*">“bild”/,
    'the learner\'s own spelling is never the word beside the headline',
  );

  // A test round says up front that answers come at the end, so it can report
  // neither the spelling nor a tone — a red cross is the result said without
  // words.
  learningState = Object.freeze({
    ...learningState,
    practice: Object.freeze({
      ...questionPractice,
      mode: 'test',
      feedback: wrongFeedback,
    }),
  });
  const testModeHtml = render();
  assert.match(testModeHtml, /class="answer-recorded"[^>]*>Answer saved\./);
  assert.doesNotMatch(testModeHtml, /answer-feedback/);
  assert.doesNotMatch(testModeHtml, /build/);
  assert.doesNotMatch(testModeHtml, /Not yet/);

  learningState = Object.freeze({
    ...learningState,
    practice: questionPractice,
  });

  const endRoundHtml = renderToStaticMarkup(
    React.createElement(EndRoundDialog, {
      onKeep() {},
      onLeave() {},
    }),
  );
  assert.match(endRoundHtml, /role="alertdialog"/);
  assert.match(endRoundHtml, /aria-modal="true"/);
  assert.match(endRoundHtml, /aria-labelledby="end-round-title"/);
  assert.match(endRoundHtml, /Keep practising/);
  assert.match(endRoundHtml, /End round/);
  assert.match(endRoundHtml, /Every word you have answered is saved/);

  const failedEndRoundHtml = renderToStaticMarkup(
    React.createElement(EndRoundDialog, {
      error: 'This round could not be saved as unfinished. Please try again or keep practising.',
      leaving: false,
      onKeep() {},
      onLeave() {},
    }),
  );
  assert.match(failedEndRoundHtml, /id="end-round-error"/);
  assert.match(failedEndRoundHtml, /role="alert"/);
  assert.match(
    failedEndRoundHtml,
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
  // A clean round names nothing: the drill only appears when it has words.
  assert.doesNotMatch(summaryHtml, /Words that slipped today/);

  // The engine already names the words that needed a correction, so the
  // summary lists them rather than only counting them.
  learningState = Object.freeze({
    ...learningState,
    summary: Object.freeze({
      ...learningState.summary,
      mistakes: Object.freeze([
        Object.freeze({ slug: 'famous', word: 'famous' }),
        Object.freeze({ slug: 'busy', word: 'busy' }),
      ]),
    }),
  });
  const slippedHtml = render();
  assert.match(slippedHtml, /Words that slipped today/);
  assert.match(slippedHtml, /<li[^>]*>famous<\/li>/);
  assert.match(slippedHtml, /<li[^>]*>busy<\/li>/);

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
  // Both bars are fixed and own their safe area, so neither can scroll into
  // the status bar or the home indicator.
  assert.match(
    productCss,
    /\.product-topbar\s*\{[^}]*position:\s*fixed;[^}]*height:\s*calc\(var\(--safe-top\) \+ var\(--bar-h\)\);[^}]*padding:\s*var\(--safe-top\)/su,
  );
  assert.match(
    productCss,
    /\.trail-tabs\s*\{[^}]*position:\s*fixed;[^}]*height:\s*calc\(var\(--safe-bottom\) \+ var\(--tabs-h\)\);/su,
  );

  // The inset the page reserves has to name the same heights the bars are
  // built from. Reserving a literal instead is how a bar and its clearance
  // drift apart, and the symptom is content sitting under the chrome.
  assert.match(
    productCss,
    /\.product-app\[data-chrome~='bar'\]\s*\{\s*padding-top:\s*calc\(var\(--safe-top\) \+ var\(--bar-h\)/su,
  );
  assert.match(
    productCss,
    /\.product-app\[data-chrome~='tabs'\]\s*\{\s*padding-bottom:\s*calc\(var\(--safe-bottom\) \+ var\(--tabs-h\)/su,
  );

  // A fixed bar cannot grow, so its title truncates rather than wrapping: at
  // an accessibility text size a wrapping title used to push the bar taller
  // than the space the page had reserved for it.
  assert.match(
    productCss,
    /\.product-topbar p\s*\{[^}]*white-space:\s*nowrap;[^}]*text-overflow:\s*ellipsis;/su,
  );

  // The round card is theme-locked glass: it re-points the palette tokens so
  // the art tints what is behind it rather than the glass itself. Every token it
  // reads has to exist in the default scheme too. Declared only inside the
  // dark-scheme block, each `var(--theme-*)` was guaranteed-invalid in light
  // mode — and an invalid var in a border shorthand takes the whole declaration
  // with it, so in light mode that card had no writing line under the answer,
  // no border on either listening control and no hairline of its own.
  const baseTokens = productCss.match(/^\.product-app \{\n(.*?)^\}/msu);
  assert.ok(baseTokens, 'the base token block must be findable');
  const themeTokensRead = new Set(
    [...productCss.matchAll(/var\((--theme-[a-z0-9-]+)\)/gu)].map(([, name]) => name),
  );
  assert.ok(themeTokensRead.size > 0);
  for (const token of themeTokensRead) {
    assert.match(
      baseTokens[1],
      new RegExp(`^\\s*${token}:\\s*\\S`, 'mu'),
      `${token} is read but never declared for the default colour scheme`,
    );
  }

  // Re-pointing the tokens is not enough on its own: `color` still inherits the
  // page's tone ink, so headings took the theme while plain paragraphs in the
  // same card stayed the region's cream.
  assert.match(
    productCss,
    /\.practice-card \{[^}]*--brand-soft: var\(--theme-brand-soft\);[^}]*color: var\(--ink\);/su,
  );

  // On a regular-width screen the strip is a rail down the leading edge, and
  // the page is inset from the side instead of from the bottom.
  assert.match(
    productCss,
    /@media \(min-width: 45rem\) \{[^@]*\.trail-tabs\s*\{[^}]*flex-direction:\s*column;/su,
  );
  assert.match(
    productCss,
    /@media \(min-width: 45rem\) \{\s*\.product-app\[data-chrome~='tabs'\]\s*\{[^}]*padding-left:\s*calc\(var\(--rail-w\)/su,
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
      // No Keyboard entry: the plugin's accessory-bar and resize-mode calls are
      // made at runtime from `src/platform/keyboard/capacitor-keyboard.js`, so
      // this file stays byte-identical to its sealed B2 policy hash.
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
