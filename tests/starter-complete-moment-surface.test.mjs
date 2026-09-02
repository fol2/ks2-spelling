import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createServer } from 'vite';

import {
  loadFullSpellingCatalogue,
  loadStarterSpellingCatalogue,
} from '../src/domain/spelling/index.js';
import {
  remainingStarterWordCount,
  starterCompleteMomentCopy,
} from '../src/app/starter-complete-moment.js';
import { createStarterCompleteAskGrownUpHandler } from '../src/app/starter-complete-moment-runtime.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PURCHASE_LANGUAGE = /£|GBP|USD|\$\d|\bBuy\b|\bupgrade\b|\bpurchase\b|\bStoreKit\b|\bunlock\b/iu;

async function read(path) {
  return readFile(join(ROOT, path), 'utf8');
}

test('create-product-app-services source names restart and replica consume helpers', async () => {
  const source = await read('src/app/create-product-app-services.js');
  assert.match(source, /source: 'restart'/);
  assert.match(source, /source: 'replica'/);
  assert.match(source, /readAndConsumeStarterCompleteMoment/);
  assert.match(source, /createSQLiteStarterCompleteMomentStore/);
  assert.match(source, /onRemoveLearnerMetadata: deleteStarterCompleteMomentInTransaction/);
});

test('StarterCompleteMoment module source and copy helper omit purchase language', async () => {
  const files = [
    'src/app/StarterCompleteMoment.jsx',
    'src/app/starter-complete-moment.js',
    'src/app/starter-complete-moment-runtime.js',
  ];
  for (const file of files) {
    const source = await read(file);
    assert.doesNotMatch(source, PURCHASE_LANGUAGE, file);
    assert.doesNotMatch(source, /parentCommerce\.purchase|store\.purchase/u, file);
  }
});

test('SSR of StarterCompleteMoment markup has two buttons and no purchase language', async (t) => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const vite = await createServer({
    configFile: join(ROOT, 'vite.config.js'),
    server: { middlewareMode: true },
    appType: 'custom',
  });
  t.after(() => vite.close());
  const { StarterCompleteMoment } = await vite.ssrLoadModule(
    '/src/app/StarterCompleteMoment.jsx',
  );

  const remaining = remainingStarterWordCount({
    starterCatalogue: loadStarterSpellingCatalogue(),
    fullCatalogue: loadFullSpellingCatalogue(),
  });
  const html = renderToStaticMarkup(
    React.createElement(StarterCompleteMoment, {
      remainingWordCount: remaining,
      onContinue() {},
      onAskGrownUp() {},
    }),
  );

  assert.match(html, /data-starter-complete-moment="true"/);
  assert.match(html, /These words are secure/);
  assert.match(html, new RegExp(`There are ${remaining} more words waiting\\.`));
  assert.match(html, /Ask a grown-up/);
  assert.match(html, />Continue</);
  assert.match(html, /role="dialog"/);
  assert.doesNotMatch(html, PURCHASE_LANGUAGE);
  assert.equal((html.match(/<button /g) ?? []).length, 2);
});

test('ProductApp source still keeps Buy Full KS2 behind status === unlocked ParentCommerceCard', async () => {
  const product = await read('src/app/ProductApp.jsx');
  const overlay = await read('src/app/StarterCompleteMoment.jsx');
  const model = await read('src/app/starter-complete-moment.js');
  const runtime = await read('src/app/starter-complete-moment-runtime.js');
  assert.match(model, /Ask a grown-up/);
  assert.match(overlay, /copy\.grownUpAction/);
  assert.match(overlay, /starterCompleteMomentKeyDown/);
  assert.match(runtime, /planSummaryRewards/);
  assert.match(product, /planSummaryRewards/);
  assert.match(product, /acknowledgeStarterCompleteMoment/);
  assert.match(product, /createStarterCompleteAskGrownUpHandler/);
  assert.match(runtime, /await persist\(\);\s*dismiss\(\);/u);
  assert.doesNotMatch(
    product,
    /markStarterCompleteMomentPresented\?\.\(\)\s*\.catch\(\(\) => undefined\)/u,
  );
  assert.match(product, /For parents/);
  assert.match(product, /Buy Full KS2/);
  assert.match(
    product,
    /status === 'unlocked'[\s\S]*ParentCommerceCard/u,
  );
  assert.match(product, /starterCompleteLearnerIsEntitled/);
  assert.match(product, /askGrownUpIsAvailable/);
  assert.doesNotMatch(product, /hatchedCompanionAsksGrownUp/);
  assert.doesNotMatch(
    product,
    /entitled=\{services\.catalogueId === 'ks2-core:full'\}/u,
    'badge entitled must not be catalogueId-only; active-but-uninstalled is entitled',
  );
});

test('SSR of ResultsScreen with a provided signpost omits purchase language', async (t) => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const vite = await createServer({
    configFile: join(ROOT, 'vite.config.js'),
    server: { middlewareMode: true },
    appType: 'custom',
  });
  t.after(() => vite.close());
  const { ResultsScreen } = await vite.ssrLoadModule('/src/app/ProductApp.jsx');
  const remaining = remainingStarterWordCount({
    starterCatalogue: loadStarterSpellingCatalogue(),
    fullCatalogue: loadFullSpellingCatalogue(),
  });
  const html = renderToStaticMarkup(
    React.createElement(ResultsScreen, {
      summary: Object.freeze({
        mode: 'smart',
        label: 'Smart review',
        message: 'Excellent work.',
        totalWords: 5,
        correct: 5,
        accuracy: 100,
        mistakes: Object.freeze([]),
      }),
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
      ]),
      onScreen() {},
      starterCompleteMoment: Object.freeze({ remainingWordCount: remaining }),
      onStarterCompleteContinue() {},
      onStarterCompleteAskGrownUp() {},
    }),
  );
  assert.match(html, /data-starter-complete-moment="true"/);
  assert.match(html, new RegExp(`There are ${remaining} more words waiting\\.`));
  assert.match(html, /Ask a grown-up/);
  assert.doesNotMatch(html, PURCHASE_LANGUAGE);
});

test('Codex keeps a re-openable Ask-a-grown-up badge after a trial hatch', async (t) => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const vite = await createServer({
    configFile: join(ROOT, 'vite.config.js'),
    server: { middlewareMode: true },
    appType: 'custom',
  });
  t.after(() => vite.close());
  const { CodexScreen } = await vite.ssrLoadModule('/src/app/ProductApp.jsx');
  const hatched = Object.freeze({
    rewardTrackId: 'spelling-core-inklet',
    packId: 'ks2-core',
    monsterId: 'inklet',
    thresholds: Object.freeze([1, 10, 30, 60, 100]),
    branch: 'b1',
    secureCount: 10,
    caught: true,
    derivedStage: 1,
    earnedStageHighWater: 1,
  });
  const remainingWordCount = 193;
  const copy = starterCompleteMomentCopy(remainingWordCount);
  const html = renderToStaticMarkup(
    React.createElement(CodexScreen, {
      monsters: [hatched],
      progress: [],
      onScreen() {},
      entitled: false,
      remainingWordCount,
      onAskGrownUp() {},
    }),
  );
  assert.match(html, /data-ask-grown-up="true"/);
  assert.equal((html.match(/data-ask-grown-up="true"/g) ?? []).length, 1);
  assert.equal(html.includes(copy.body), true);
  assert.match(html, /Ask a grown-up/);
  assert.match(html, /10 of 100/);
  assert.doesNotMatch(html, PURCHASE_LANGUAGE);

  const entitledHtml = renderToStaticMarkup(
    React.createElement(CodexScreen, {
      monsters: [hatched],
      progress: [],
      onScreen() {},
      entitled: true,
      remainingWordCount,
      onAskGrownUp() {},
    }),
  );
  assert.doesNotMatch(entitledHtml, /data-ask-grown-up="true"/);

  const eggHtml = renderToStaticMarkup(
    React.createElement(CodexScreen, {
      monsters: [{
        ...hatched,
        secureCount: 0,
        caught: false,
        derivedStage: 0,
        earnedStageHighWater: 0,
      }],
      progress: [],
      onScreen() {},
      entitled: false,
      remainingWordCount,
      onAskGrownUp() {},
    }),
  );
  assert.doesNotMatch(eggHtml, /data-ask-grown-up="true"/);
});

test('trial Codex roster shows the unhatched Phaeton track without a hatch paywall badge', async (t) => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const vite = await createServer({
    configFile: join(ROOT, 'vite.config.js'),
    server: { middlewareMode: true },
    appType: 'custom',
  });
  t.after(() => vite.close());
  const { CodexScreen } = await vite.ssrLoadModule('/src/app/ProductApp.jsx');
  const track = ({
    monsterId,
    rewardTrackId,
    thresholds,
    secureCount = 0,
    derivedStage = 0,
    caught = false,
  }) => Object.freeze({
    rewardTrackId,
    packId: 'ks2-core',
    monsterId,
    thresholds: Object.freeze(thresholds),
    branch: 'b1',
    secureCount,
    caught,
    derivedStage,
    earnedStageHighWater: derivedStage,
  });
  const html = renderToStaticMarkup(
    React.createElement(CodexScreen, {
      monsters: [
        track({
          monsterId: 'inklet',
          rewardTrackId: 'spelling-core-inklet',
          thresholds: [1, 10, 30, 60, 100],
        }),
        track({
          monsterId: 'glimmerbug',
          rewardTrackId: 'spelling-core-glimmerbug',
          thresholds: [1, 10, 30, 60, 100],
        }),
        track({
          monsterId: 'phaeton',
          rewardTrackId: 'spelling-core-phaeton',
          thresholds: [3, 25, 95, 145, 213],
          secureCount: 20,
          caught: true,
        }),
      ],
      progress: [],
      onScreen() {},
      entitled: false,
      onAskGrownUp() {},
    }),
  );
  assert.match(html, /Stardrop Egg/);
  assert.match(html, /20 of 213/);
  assert.match(html, /5 more to Aetherwisp/);
  assert.doesNotMatch(html, />Aetherwisp</);
  assert.doesNotMatch(html, /data-ask-grown-up="true"/);
});

function store(state) {
  return Object.freeze({
    getState: () => state,
    subscribe: () => Object.freeze({ remove() {} }),
  });
}

const HATCHED_INKLET = Object.freeze({
  rewardTrackId: 'spelling-core-inklet',
  packId: 'ks2-core',
  monsterId: 'inklet',
  thresholds: Object.freeze([1, 10, 30, 60, 100]),
  branch: 'b1',
  secureCount: 10,
  caught: true,
  derivedStage: 1,
  earnedStageHighWater: 1,
});

function productAppServices({
  catalogueId = 'ks2-core:starter',
  entitlementState = 'none',
  packState = 'missing',
  screen = 'monster',
  remainingWordCount = 193,
  monsters = [HATCHED_INKLET],
  practice = null,
  summary = null,
} = {}) {
  const profileState = Object.freeze({
    status: 'ready',
    profiles: Object.freeze([{
      learnerId: 'learner-a',
      nickname: 'Ada',
      yearGroup: 'Y4',
      goal: 10,
      colour: '#1f6f77',
      createdAt: 1,
      updatedAt: 1,
    }]),
    selectedLearnerId: 'learner-a',
    actionError: null,
  });
  const learningState = Object.freeze({
    status: 'ready',
    screen,
    learnerId: 'learner-a',
    practice,
    prefs: Object.freeze({ voiceId: 'Iapetus', showCloze: true, autoSpeak: true }),
    summary,
    progress: Object.freeze([]),
    vocabularySets: Object.freeze([]),
    monsters: Object.freeze(monsters),
    packSize: 213,
    revisionMission: null,
    camp: Object.freeze({
      packId: 'ks2-core',
      campHighWater: 0,
      lastCreditedGuardianDay: null,
      canEarnToday: false,
    }),
    actionError: null,
  });
  return Object.freeze({
    mode: 'product',
    catalogueId,
    remainingWordCount,
    controller: store(profileState),
    learning: Object.freeze({
      ...store(learningState),
      showScreen() {},
    }),
    audioAvailability: Object.freeze({
      ...store(Object.freeze({
        status: 'ready',
        activeVersion: '1.0.0',
        actionError: null,
      })),
      async recover() {},
    }),
    parent: store(Object.freeze({
      status: 'locked',
      biometric: Object.freeze({ available: false, type: 'none', enabled: false }),
      attemptsRemaining: 5,
      lockedUntil: 0,
      actionError: null,
    })),
    parentProgress: Object.freeze({
      ...store(Object.freeze({
        status: 'ready',
        learners: Object.freeze([]),
        actionError: null,
      })),
      async refresh() {},
    }),
    parentCommerce: Object.freeze({
      ...store(Object.freeze({
        status: 'ready',
        displayPrice: '£9.99',
        entitlementState,
        packState,
        action: null,
        actionError: null,
        downloadProgress: null,
      })),
      async recover() {},
    }),
    parentAdministration: Object.freeze({ async resetLearning() {} }),
    audio: Object.freeze({ async play() {} }),
    haptics: Object.freeze({ uiTick() {} }),
    sfx: Object.freeze({ play() {}, isEnabled: () => true }),
  });
}

test('ProductApp hides the Ask-a-grown-up badge while Full access is active but the pack is not installed', async (t) => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const vite = await createServer({
    configFile: join(ROOT, 'vite.config.js'),
    server: { middlewareMode: true },
    appType: 'custom',
  });
  t.after(() => vite.close());
  const { default: ProductApp } = await vite.ssrLoadModule('/src/app/ProductApp.jsx');
  const render = (services) => renderToStaticMarkup(
    React.createElement(ProductApp, { services }),
  );

  const trial = render(productAppServices());
  assert.match(trial, /data-ask-grown-up="true"/);
  assert.match(trial, /10 of 100/);
  assert.doesNotMatch(trial, PURCHASE_LANGUAGE);

  for (const packState of ['queued', 'downloading', 'failed']) {
    const html = render(productAppServices({
      catalogueId: 'ks2-core:starter',
      entitlementState: 'active',
      packState,
    }));
    assert.equal(
      html.includes('data-ask-grown-up="true"'),
      false,
      `active/${packState} must not show the child Ask-a-grown-up badge`,
    );
    assert.match(html, /10 of 100/);
    assert.doesNotMatch(html, PURCHASE_LANGUAGE);
  }

  const installed = render(productAppServices({
    catalogueId: 'ks2-core:full',
    entitlementState: 'active',
    packState: 'installed',
  }));
  assert.equal(installed.includes('data-ask-grown-up="true"'), false);
  assert.doesNotMatch(installed, PURCHASE_LANGUAGE);

  for (const packState of ['queued', 'downloading', 'failed', 'installed']) {
    const html = render(productAppServices({
      catalogueId: packState === 'installed' ? 'ks2-core:full' : 'ks2-core:starter',
      entitlementState: 'active',
      packState,
      screen: 'progress',
    }));
    assert.equal(
      html.includes('data-ask-grown-up="true"'),
      false,
      `Word Bank active/${packState} must not show Ask-a-grown-up`,
    );
    assert.doesNotMatch(html, PURCHASE_LANGUAGE);
  }
});

test('locked ParentArea SSR markup has no Buy control after the Ask handler factory runs', async (t) => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const vite = await createServer({
    configFile: join(ROOT, 'vite.config.js'),
    server: { middlewareMode: true },
    appType: 'custom',
  });
  t.after(() => vite.close());
  const { ParentArea } = await vite.ssrLoadModule('/src/app/ProductApp.jsx');

  let persisted = false;
  let parentOpen = false;
  const ask = createStarterCompleteAskGrownUpHandler({
    async persist() { persisted = true; return true; },
    openParent() { parentOpen = true; },
  });
  await ask();
  assert.equal(persisted, true);
  assert.equal(parentOpen, true);

  const html = renderToStaticMarkup(
    React.createElement(ParentArea, {
      state: Object.freeze({
        status: 'locked',
        biometric: Object.freeze({
          available: false,
          type: 'none',
          enabled: false,
        }),
        attemptsRemaining: 5,
        lockedUntil: 0,
        actionError: null,
      }),
      profiles: Object.freeze([]),
      progressState: Object.freeze({
        status: 'ready',
        learners: Object.freeze([]),
        actionError: null,
      }),
      commerceState: Object.freeze({
        status: 'ready',
        displayPrice: '£9.99',
        entitlementState: 'none',
        packState: 'missing',
        action: null,
        actionError: null,
      }),
      onClose() {},
      async onSetPin() {},
      async onResetPin() {},
      async onUnlockPin() {},
      async onUnlockBiometrics() {},
      async onSetBiometricsEnabled() {},
      async onEditProfile() {},
      async onRemoveProfile() {},
      async onResetLearning() {},
      async onRefreshProgress() {},
      async onPurchase() {},
      async onRestore() {},
      async onDownload() {},
      async onRecoverCommerce() {},
    }),
  );
  assert.match(html, /Enter Parent PIN/);
  assert.match(html, /Grown-ups only/);
  assert.doesNotMatch(html, /Buy Full KS2|Restore purchases/i);
});

const EGG_GLIMMERBUG = Object.freeze({
  rewardTrackId: 'spelling-core-glimmerbug',
  packId: 'ks2-core',
  monsterId: 'glimmerbug',
  thresholds: Object.freeze([1, 10, 30, 60, 100]),
  branch: 'b1',
  secureCount: 0,
  caught: false,
  derivedStage: 0,
  earnedStageHighWater: 0,
});

const EGG_INKLET = Object.freeze({
  ...HATCHED_INKLET,
  secureCount: 0,
  caught: false,
  derivedStage: 0,
  earnedStageHighWater: 0,
});

const HIGH_WATER_INKLET = Object.freeze({
  ...HATCHED_INKLET,
  derivedStage: 0,
  earnedStageHighWater: 1,
});

const PRACTICE = Object.freeze({
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
});

const SUMMARY = Object.freeze({
  mode: 'smart',
  label: 'Smart review',
  message: 'Excellent work.',
  totalWords: 5,
  correct: 5,
  accuracy: 100,
  mistakes: Object.freeze([]),
});

function askCount(html) {
  return (html.match(/data-ask-grown-up="true"/g) ?? []).length;
}

function askBlock(html) {
  return html.match(/<div class="ask-grown-up">[\s\S]*?<\/div>/u)?.[0] ?? '';
}

function askButtonHtml(html) {
  return html.match(
    /<button[^>]*data-ask-grown-up="true"[^>]*>[\s\S]*?<\/button>/u,
  )?.[0] ?? '';
}

test('learner-level Ask-a-grown-up is one Codex gauge and one Word Bank caption', async (t) => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const vite = await createServer({
    configFile: join(ROOT, 'vite.config.js'),
    server: { middlewareMode: true },
    appType: 'custom',
  });
  t.after(() => vite.close());
  const {
    CodexScreen,
    WordBankScreen,
    TrailScreen,
    SetupScreen,
    RoundScreen,
    ResultsScreen,
    CampScreen,
    default: ProductApp,
  } = await vite.ssrLoadModule('/src/app/ProductApp.jsx');

  const remainingWordCount = 193;
  const copy = starterCompleteMomentCopy(remainingWordCount);
  const audioState = Object.freeze({
    status: 'ready',
    activeVersion: '1.0.0',
    actionError: null,
  });
  const renderApp = (options) => renderToStaticMarkup(
    React.createElement(ProductApp, { services: productAppServices(options) }),
  );
  const bankProps = {
    progress: Object.freeze([{
      runtimeItemId: 'ks2-core:museum',
      target: 'museum',
      yearBand: '3-4',
      stage: 5,
      attempts: 9,
      correct: 9,
      wrong: 0,
      dueDay: 99_999,
      lastResult: 'correct',
    }]),
    vocabularySets: Object.freeze([{ id: 'core', label: 'Core', count: 1 }]),
    onScreen() {},
    onStart() {},
    wordMaterial() { return null; },
    onPractise() {},
    audio: Object.freeze({ async play() {} }),
    audioState,
    voiceId: 'Iapetus',
    busy: false,
    onPlaybackFailure() {},
  };

  await t.test('all stage 0 shows no ask and no overlay', () => {
    const eggs = [EGG_INKLET, EGG_GLIMMERBUG];
    const screens = [
      renderApp({ monsters: eggs, screen: 'monster' }),
      renderApp({ monsters: eggs, screen: 'progress' }),
      renderApp({ monsters: eggs, screen: 'home' }),
      renderApp({ monsters: eggs, screen: 'setup' }),
      renderApp({ monsters: eggs, screen: 'practice', practice: PRACTICE }),
      renderApp({ monsters: eggs, screen: 'summary', summary: SUMMARY }),
      renderApp({ monsters: eggs, screen: 'camp' }),
    ];
    for (const html of screens) {
      assert.equal(askCount(html), 0);
      assert.doesNotMatch(html, /data-starter-complete-moment="true"/);
      assert.doesNotMatch(html, PURCHASE_LANGUAGE);
    }
  });

  await t.test('Inklet stage 1 is one ask on Codex and Word Bank only', () => {
    const hatched = [HATCHED_INKLET];
    const codex = renderApp({ monsters: hatched, screen: 'monster' });
    const bank = renderToStaticMarkup(React.createElement(WordBankScreen, {
      ...bankProps,
      monsters: hatched,
      entitled: false,
      remainingWordCount,
      onAskGrownUp() {},
    }));
    const trail = renderApp({ monsters: hatched, screen: 'home' });
    const setup = renderApp({ monsters: hatched, screen: 'setup' });
    const round = renderApp({
      monsters: hatched,
      screen: 'practice',
      practice: PRACTICE,
    });
    const results = renderApp({
      monsters: hatched,
      screen: 'summary',
      summary: SUMMARY,
    });
    const camp = renderToStaticMarkup(React.createElement(CampScreen, {
      camp: Object.freeze({
        packId: 'ks2-core',
        campHighWater: 0,
        lastCreditedGuardianDay: null,
        canEarnToday: false,
      }),
      audioState,
      onScreen() {},
      onStartGuardian() {},
      onRecoverAudio() {},
    }));
    const trailDirect = renderToStaticMarkup(React.createElement(TrailScreen, {
      profile: Object.freeze({
        learnerId: 'learner-a',
        nickname: 'Ada',
        yearGroup: 'Y4',
        colour: '#1f6f77',
      }),
      learningState: Object.freeze({
        learnerId: 'learner-a',
        screen: 'home',
        monsters: hatched,
      }),
      audioState,
      dueCount: 0,
      onScreen() {},
      onSwitchLearner() {},
      onOpenParent() {},
      onRecoverAudio() {},
    }));
    const setupDirect = renderToStaticMarkup(React.createElement(SetupScreen, {
      audioState,
      actionError: null,
      onStart() {},
      onBack() {},
      onScreen() {},
      onRecoverAudio() {},
      busy: false,
      dueCount: 0,
      troubleCount: 0,
      bankTotal: 1,
      monsters: hatched,
      entitled: false,
      remainingWordCount,
      onAskGrownUp() {},
    }));
    const roundDirect = renderToStaticMarkup(React.createElement(RoundScreen, {
      state: Object.freeze({
        status: 'ready',
        actionError: null,
        prefs: Object.freeze({ voiceId: 'Iapetus' }),
        monsters: hatched,
        practice: PRACTICE,
      }),
      audioState,
      audio: Object.freeze({ async play() {} }),
      onSubmit() {},
      onContinue() {},
      onSkip() {},
      onEnd() {},
      onPlaybackFailure() {},
      entitlementState: 'none',
    }));
    const resultsDirect = renderToStaticMarkup(React.createElement(ResultsScreen, {
      summary: SUMMARY,
      monsters: hatched,
      onScreen() {},
    }));

    assert.equal(askCount(codex), 1);
    assert.equal(askCount(bank), 1);
    assert.equal(askCount(trail), 0);
    assert.equal(askCount(setup), 0);
    assert.equal(askCount(round), 0);
    assert.equal(askCount(results), 0);
    assert.equal(askCount(camp), 0);
    assert.equal(askCount(trailDirect), 0);
    assert.equal(askCount(setupDirect), 0);
    assert.equal(askCount(roundDirect), 0);
    assert.equal(askCount(resultsDirect), 0);
    assert.doesNotMatch(results, /data-starter-complete-moment="true"/);
    assert.doesNotMatch(resultsDirect, /data-starter-complete-moment="true"/);
    for (const html of [codex, bank, trail, setup, round, results, camp]) {
      assert.doesNotMatch(html, PURCHASE_LANGUAGE);
    }

    const bankBlock = askBlock(bank);
    assert.equal(bankBlock.includes(copy.body), true, 'Word Bank caption uses copy.body');
    assert.equal(askButtonHtml(bank).includes(copy.grownUpAction), true);
    assert.doesNotMatch(askButtonHtml(bank), /M8\.2 10\.5V7\.8/);
    assert.doesNotMatch(bank, /There is 1 more word waiting\./);
    const codexBlock = askBlock(codex);
    assert.equal(codexBlock.includes(copy.body), true);
    assert.equal(askButtonHtml(codex).includes(copy.grownUpAction), true);
    assert.doesNotMatch(askButtonHtml(codex), /M8\.2 10\.5V7\.8/);
  });

  await t.test('Codex keeps the ask when a stage-0 companion is selected', () => {
    const html = renderToStaticMarkup(React.createElement(CodexScreen, {
      monsters: [HATCHED_INKLET, EGG_GLIMMERBUG],
      progress: [],
      onScreen() {},
      entitled: false,
      remainingWordCount,
      selectedRewardTrackId: EGG_GLIMMERBUG.rewardTrackId,
      onAskGrownUp() {},
    }));
    assert.equal(askCount(html), 1);
    assert.match(html, /data-found="false"/);
    assert.doesNotMatch(html, PURCHASE_LANGUAGE);
    assert.equal(askBlock(html).includes(copy.body), true);
    assert.equal(askButtonHtml(html).includes(copy.grownUpAction), true);
  });

  await t.test('earnedStageHighWater of 1 still shows the ask', () => {
    const html = renderToStaticMarkup(React.createElement(CodexScreen, {
      monsters: [HIGH_WATER_INKLET],
      progress: [],
      onScreen() {},
      entitled: false,
      remainingWordCount,
      onAskGrownUp() {},
    }));
    assert.equal(askCount(html), 1);
    assert.doesNotMatch(html, PURCHASE_LANGUAGE);
  });

  await t.test('remainingWordCount 0 hides the ask everywhere', () => {
    const screens = [
      renderApp({ remainingWordCount: 0, screen: 'monster' }),
      renderApp({ remainingWordCount: 0, screen: 'progress' }),
      renderApp({ remainingWordCount: 0, screen: 'home' }),
      renderApp({ remainingWordCount: 0, screen: 'setup' }),
      renderApp({ remainingWordCount: 0, screen: 'practice', practice: PRACTICE }),
      renderApp({ remainingWordCount: 0, screen: 'summary', summary: SUMMARY }),
      renderToStaticMarkup(React.createElement(WordBankScreen, {
        ...bankProps,
        monsters: [HATCHED_INKLET],
        entitled: false,
        remainingWordCount: 0,
        onAskGrownUp() {},
      })),
      renderToStaticMarkup(React.createElement(CodexScreen, {
        monsters: [HATCHED_INKLET],
        progress: [],
        onScreen() {},
        entitled: false,
        remainingWordCount: 0,
        onAskGrownUp() {},
      })),
    ];
    for (const html of screens) {
      assert.equal(askCount(html), 0);
      assert.doesNotMatch(html, /data-starter-complete-moment="true"/);
      assert.doesNotMatch(html, PURCHASE_LANGUAGE);
    }
  });

  await t.test('Codex re-render keeps the ask and Results never returns the overlay', () => {
    const first = renderToStaticMarkup(React.createElement(CodexScreen, {
      monsters: [HATCHED_INKLET],
      progress: [],
      onScreen() {},
      entitled: false,
      remainingWordCount,
      onAskGrownUp() {},
    }));
    const second = renderToStaticMarkup(React.createElement(CodexScreen, {
      monsters: [HATCHED_INKLET],
      progress: [],
      onScreen() {},
      entitled: false,
      remainingWordCount,
      onAskGrownUp() {},
    }));
    assert.equal(askCount(first), 1);
    assert.equal(askCount(second), 1);
    const results = renderToStaticMarkup(React.createElement(ResultsScreen, {
      summary: SUMMARY,
      monsters: [HATCHED_INKLET],
      onScreen() {},
    }));
    const resultsAgain = renderToStaticMarkup(React.createElement(ResultsScreen, {
      summary: SUMMARY,
      monsters: [HATCHED_INKLET],
      onScreen() {},
    }));
    assert.doesNotMatch(results, /data-starter-complete-moment="true"/);
    assert.doesNotMatch(resultsAgain, /data-starter-complete-moment="true"/);
    assert.equal(askCount(results), 0);
    assert.equal(askCount(resultsAgain), 0);
  });
});
