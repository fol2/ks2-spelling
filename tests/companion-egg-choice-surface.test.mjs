import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createServer } from 'vite';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PURCHASE_LANGUAGE = /£|GBP|USD|\$\d|\bBuy\b|\bupgrade\b|\bpurchase\b|\bStoreKit\b|\bunlock\b/iu;

async function read(path) {
  return readFile(join(ROOT, path), 'utf8');
}

test('egg-choice sources omit purchase language', async () => {
  const files = [
    'src/app/EggChoiceMoment.jsx',
    'src/app/egg-choice-moment.js',
    'src/app/egg-choice-moment-runtime.js',
    'src/app/companion-branch-command.js',
  ];
  for (const file of files) {
    const source = await read(file);
    assert.doesNotMatch(source, PURCHASE_LANGUAGE, file);
    assert.doesNotMatch(source, /parentCommerce\.purchase|store\.purchase/u, file);
    assert.doesNotMatch(source, /\bversion\b|\bskin\b|\bA\/B\b/iu, file);
  }
});

test('egg-choice CSS declares 44px targets and a visible focus ring', async () => {
  const css = await read('src/app/app.css');
  assert.match(css, /\.egg-choice-egg\s*\{[^}]*min-height:\s*2\.75rem/u);
  assert.match(css, /\.egg-choice-egg\s*\{[^}]*min-width:\s*2\.75rem/u);
  assert.match(css, /\.egg-choice-egg:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--focus\)/u);
  assert.match(css, /\.egg-choice-dismiss\s*\{[^}]*min-height:\s*2\.75rem/u);
  assert.match(css, /\.codex-other-egg\s*\{[^}]*min-height:\s*2\.75rem/u);
  assert.match(css, /@media \(min-width: 24\.5625rem\)/u);
});

test('egg-choice paper card scrolls inside the overlay on short viewports', async () => {
  const css = await read('src/app/app.css');
  assert.match(css, /\.egg-choice-moment\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)/u);
  const card = css.match(/\.egg-choice-moment\s*>\s*div\s*\{([^}]*)\}/u);
  assert.ok(card, 'expected .egg-choice-moment > div paper card');
  assert.match(card[1], /max-height:\s*100%/u);
  assert.match(card[1], /min-height:\s*0/u);
  assert.match(card[1], /overflow-y:\s*auto/u);
  const heading = css.match(/\.egg-choice-moment\s+h1\s*\{([^}]*)\}/u);
  assert.ok(heading, 'expected .egg-choice-moment h1');
  assert.doesNotMatch(heading[1], /overflow:\s*hidden/u);
  assert.match(css, /\.egg-choice-egg\s*\{[^}]*min-height:\s*2\.75rem/u);
  assert.match(css, /\.egg-choice-egg\s*\{[^}]*min-width:\s*2\.75rem/u);
});

test('ProductApp keeps the learning screen mounted when the egg-choice overlay opens', async () => {
  const product = await read('src/app/ProductApp.jsx');
  assert.doesNotMatch(product, /if\s*\(\s*!overlay\s*\)\s*return\s*node/u);
  assert.doesNotMatch(
    product,
    /<div aria-hidden="true" inert>\{node\}<\/div>/u,
  );
});

test('Codex other-egg switch uses the overlay recoverable save-failed path', async () => {
  const product = await read('src/app/ProductApp.jsx');
  assert.match(product, /eggChoiceSaveFailedVisible/u);
  assert.match(product, /data-codex-switch-save-failed/u);
  assert.match(product, /copy\.saveFailed/u);
  assert.doesNotMatch(
    product,
    /void choose\(\{ rewardTrackId, branch \}\)\.then\(\s*\(\) => setSkippedEggChoiceTrackIds\(\[\]\),\s*\(\) => undefined/u,
  );
  assert.match(
    product,
    /return choose\(\{\s*rewardTrackId,\s*branch\s*\}\)/u,
  );
});

test('SSR of EggChoiceMoment is a dialog with two egg actions', async (t) => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const vite = await createServer({
    configFile: join(ROOT, 'vite.config.js'),
    server: { middlewareMode: true },
    appType: 'custom',
  });
  t.after(() => vite.close());
  const { EggChoiceMoment } = await vite.ssrLoadModule(
    '/src/app/EggChoiceMoment.jsx',
  );
  const html = renderToStaticMarkup(
    React.createElement(EggChoiceMoment, {
      monster: { monsterId: 'inklet', rewardTrackId: 'spelling-core-inklet' },
      onChoose() {},
    }),
  );
  assert.match(html, /data-egg-choice-moment="true"/);
  assert.match(html, /Which egg is yours\?/);
  assert.match(html, /Tap one\./);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /<h1 id="egg-choice-title">/);
  assert.equal((html.match(/<button /g) ?? []).length, 2);
  assert.match(html, /data-branch="b1"/);
  assert.match(html, /data-branch="b2"/);
  assert.match(html, /inklet-b1-0\.640\.webp/);
  assert.match(html, /inklet-b2-0\.640\.webp/);
  assert.equal((html.match(/This egg/g) ?? []).length, 2);
  assert.doesNotMatch(html, PURCHASE_LANGUAGE);
  assert.doesNotMatch(html, /Confirm|Skip|Buy|unlock/i);
});

test('ProductApp still plans starter-complete through the untouched runtime', async () => {
  const [product, runtime, overlay] = await Promise.all([
    read('src/app/ProductApp.jsx'),
    read('src/app/starter-complete-moment-runtime.js'),
    read('src/app/StarterCompleteMoment.jsx'),
  ]);
  assert.match(product, /planSummaryRewards/);
  assert.match(product, /StarterCompleteMoment/);
  assert.match(product, /celebrationEvents,/);
  assert.match(product, /eggChoicePending:/);
  assert.match(product, /choosableRewardTrackIds:/);
  assert.match(product, /skippedEggChoiceTrackIds/);
  assert.match(product, /nextSkippedEggChoiceTrackIds/);
  assert.match(product, /planEggChoiceDismiss/);
  assert.doesNotMatch(product, /eggChoiceDismissedTrackId/);
  const overlayMoment = await read('src/app/EggChoiceMoment.jsx');
  assert.match(overlayMoment, /eggChoiceSaveFailedVisible/);
  assert.match(runtime, /starterCompleteMomentDecision/);
  assert.match(overlay, /data-starter-complete-moment="true"/);
});

function store(state) {
  return Object.freeze({
    getState: () => state,
    subscribe: () => Object.freeze({ remove() {} }),
  });
}

test('egg-choice overlay is a sibling layer over the live Codex screen', async (t) => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const vite = await createServer({
    configFile: join(ROOT, 'vite.config.js'),
    server: { middlewareMode: true },
    appType: 'custom',
  });
  t.after(() => vite.close());
  const { default: ProductApp } = await vite.ssrLoadModule('/src/app/ProductApp.jsx');
  const foundEgg = Object.freeze({
    rewardTrackId: 'spelling-core-inklet',
    packId: 'ks2-core',
    monsterId: 'inklet',
    thresholds: Object.freeze([1, 10, 30, 60, 100]),
    branch: null,
    secureCount: 1,
    caught: true,
    derivedStage: 0,
    earnedStageHighWater: 0,
  });
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
    monsters: Object.freeze([foundEgg]),
    choosableRewardTrackIds: Object.freeze(['spelling-core-inklet']),
    packSize: 20,
    revisionMission: null,
    camp: Object.freeze({
      packId: 'ks2-core',
      campHighWater: 0,
      lastCreditedGuardianDay: null,
      canEarnToday: false,
    }),
    actionError: null,
  });
  const html = renderToStaticMarkup(React.createElement(ProductApp, {
    services: Object.freeze({
      mode: 'product',
      catalogueId: 'ks2-core:starter',
      remainingWordCount: 193,
      controller: store(profileState),
      learning: Object.freeze({
        ...store(learningState),
        showScreen() {},
        async chooseCompanionBranch() {
          throw new Error('persist_failed');
        },
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
          entitlementState: 'none',
          packState: 'missing',
          action: null,
          actionError: null,
        })),
        async recover() {},
      }),
      parentAdministration: Object.freeze({ async resetLearning() {} }),
      audio: Object.freeze({ async play() {} }),
      haptics: Object.freeze({ uiTick() {} }),
      sfx: Object.freeze({ play() {}, isEnabled: () => true }),
    }),
  }));
  assert.match(html, /data-egg-choice-moment="true"/);
  assert.match(html, /<main class="product-app"[^>]*aria-labelledby="codex-title"/);
  assert.doesNotMatch(html, /<div[^>]*inert[^>]*>\s*<main class="product-app"/u);
  const mainAt = html.indexOf('<main class="product-app"');
  const overlayAt = html.indexOf('data-egg-choice-moment="true"');
  assert.ok(mainAt >= 0 && overlayAt > mainAt);
});
