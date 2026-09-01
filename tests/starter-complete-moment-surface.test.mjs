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
import { remainingStarterWordCount } from '../src/app/starter-complete-moment.js';
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
  const html = renderToStaticMarkup(
    React.createElement(CodexScreen, {
      monsters: [hatched],
      progress: [],
      onScreen() {},
      entitled: false,
      onAskGrownUp() {},
    }),
  );
  assert.match(html, /data-ask-grown-up="true"/);
  assert.match(html, /Ask a grown-up/);
  assert.match(html, /10 of 100/);
  assert.doesNotMatch(html, PURCHASE_LANGUAGE);

  const entitledHtml = renderToStaticMarkup(
    React.createElement(CodexScreen, {
      monsters: [hatched],
      progress: [],
      onScreen() {},
      entitled: true,
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
    screen: 'monster',
    learnerId: 'learner-a',
    practice: null,
    prefs: Object.freeze({ voiceId: 'Iapetus', showCloze: true, autoSpeak: true }),
    summary: null,
    progress: Object.freeze([]),
    vocabularySets: Object.freeze([]),
    monsters: Object.freeze([HATCHED_INKLET]),
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
    remainingWordCount: 193,
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
