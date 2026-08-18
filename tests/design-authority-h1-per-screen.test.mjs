/* Design authority h1-per-screen check — Layer 2 automated.
   
   Each screen must render with exactly one <h1> element.
   Known violations are listed in docs/compliance/baseline.md as todo.
   This check is baseline-aware: new violations beyond baseline cause failure.
*/

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createServer } from 'vite';

import { buildWordBank, buildWordDetail } from '../src/app/word-bank-model.js';
import { loadStarterSpellingCatalogue } from '../src/domain/spelling/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/* Screens that are known to violate the h1 floor (per baseline.md).

   These are component names in `src/app/ProductApp.jsx`, not files: every
   product screen lives in that module. The two paths this check used to try —
   `src/app/learner-switch/LearnerSwitchSheet.jsx` and
   `src/app/first-run/FirstRunScene.jsx` — have never existed on any branch, so
   both screens were silently skipped by the `catch` that loaded them and the
   baseline recorded two violations nothing measured. */
const KNOWN_VIOLATIONS = new Set([
  'SwitchScreen',
]);

function progressRow(runtimeItemId, overrides = {}) {
  const item = loadStarterSpellingCatalogue().items.find(
    (candidate) => candidate.runtimeItemId === runtimeItemId,
  );
  assert.ok(item, `the starter catalogue must publish ${runtimeItemId}`);
  return {
    runtimeItemId,
    target: item.target,
    yearBand: item.yearBand,
    coverageTier: item.coverageTier,
    stage: 0,
    attempts: 0,
    correct: 0,
    wrong: 0,
    dueDay: null,
    lastResult: null,
    ...overrides,
  };
}

function detailFor(runtimeItemId, overrides = {}) {
  const material = loadStarterSpellingCatalogue().items.find(
    (candidate) => candidate.runtimeItemId === runtimeItemId,
  );
  const bank = buildWordBank({
    now: 0,
    progress: [progressRow(runtimeItemId, overrides)],
  });
  return buildWordDetail({ material, row: bank.rows[0] });
}

function createFixtures() {
  const summary = Object.freeze({
    mode: 'smart',
    label: 'Smart Review',
    message: 'Well done.',
    cards: Object.freeze([]),
    totalWords: 6,
    correct: 6,
    accuracy: 100,
    mistakes: Object.freeze([]),
  });
  const camp = Object.freeze({
    packId: 'ks2-core',
    campHighWater: 1,
    lastCreditedGuardianDay: null,
    canEarnToday: true,
  });
  const audioState = Object.freeze({
    status: 'ready',
    activeVersion: '1.0.0',
    actionError: null,
  });
  const audio = Object.freeze({ async play() {} });
  const noop = () => {};
  const emptyProfileState = Object.freeze({
    status: 'ready',
    profiles: Object.freeze([]),
    selectedLearnerId: null,
    actionError: null,
  });

  return Object.freeze({
    profiles: Object.freeze([]),
    switchScreen: Object.freeze({
      profileState: Object.freeze({
        ...emptyProfileState,
        profiles: Object.freeze([Object.freeze({
          learnerId: 'learner-a',
          nickname: 'Ada',
          yearGroup: 'Y4',
          goal: 10,
          colour: '#1f6f77',
        })]),
        selectedLearnerId: 'learner-a',
      }),
      audioState,
      onChoose: noop,
      onCreate: async () => {},
      onOpenParent: noop,
      onRecoverAudio: noop,
      onDismiss: undefined,
    }),
    firstRunScene: Object.freeze({
      profileState: emptyProfileState,
      audioState,
      onCreate: async () => {},
      onOpenParent: noop,
      onRecoverAudio: noop,
    }),
    progressState: Object.freeze({
      status: 'ready',
      learners: Object.freeze([]),
      actionError: null,
    }),
    commerceState: Object.freeze({
      status: 'ready',
      displayPrice: '£4.99',
      entitlementState: 'none',
      packState: 'missing',
      action: null,
      actionError: null,
    }),
    parentArea: Object.freeze({
      state: Object.freeze({
        status: 'setup-required',
        biometric: Object.freeze({ available: false, type: 'none', enabled: false }),
      }),
      profiles: Object.freeze([]),
      progressState: Object.freeze({
        status: 'ready',
        learners: Object.freeze([]),
        actionError: null,
      }),
      commerceState: Object.freeze({
        status: 'ready',
        displayPrice: '£4.99',
        entitlementState: 'none',
        packState: 'missing',
        action: null,
        actionError: null,
      }),
      onClose: noop,
      onSetPin: async () => {},
      onResetPin: async () => {},
      onUnlockPin: async () => {},
      onUnlockBiometrics: async () => {},
      onSetBiometricsEnabled: async () => {},
      onEditProfile: async () => {},
      onRemoveProfile: async () => {},
      onResetLearning: async () => {},
      onRefreshProgress: async () => {},
      onPurchase: async () => {},
      onRestore: async () => {},
      onDownload: async () => {},
      onRecoverCommerce: async () => {},
    }),
    resultsScreen: Object.freeze({
      summary,
      monsters: Object.freeze([]),
      camp,
      onScreen: noop,
    }),
    wordBankScreen: Object.freeze({
      progress: Object.freeze([
        progressRow('ks2-core:busy', { stage: 4, attempts: 5, correct: 5 }),
      ]),
      vocabularySets: Object.freeze([{ id: 'core', label: 'Core', count: 1 }]),
      onScreen: noop,
      onStart: noop,
      wordMaterial: () => null,
      onPractise: async () => {},
      audio,
      audioState,
      voiceId: 'Iapetus',
      busy: false,
      onPlaybackFailure: noop,
    }),
    wordDetailScreen: Object.freeze({
      detail: detailFor('ks2-core:busy', {
        stage: 2,
        attempts: 4,
        correct: 3,
        wrong: 1,
      }),
      audioState,
      audio,
      voiceId: 'Iapetus',
      busy: false,
      onBack: noop,
      onScreen: noop,
      onPractise: async () => {},
      onPlaybackFailure: noop,
    }),
  });
}

function countH1Elements(html) {
  return (html.match(/<h1[^>]*>/gi) || []).length;
}

test('Design authority: One h1 per screen (SSR)', async (t) => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  
  const vite = await createServer({
    configFile: join(ROOT, 'vite.config.js'),
    server: { middlewareMode: true },
    appType: 'custom',
  });
  t.after(() => vite.close());

  const baseline = await readFile(join(ROOT, 'docs/compliance/baseline.md'), 'utf8');
  
  let ParentArea;
  let ResultsScreen;
  let WordBankScreen;
  let WordDetailScreen;
  let SwitchScreen;
  let FirstRunScene;

  try {
    const module = await vite.ssrLoadModule('/src/app/ProductApp.jsx');
    ParentArea = module.ParentArea;
    ResultsScreen = module.ResultsScreen;
    WordBankScreen = module.WordBankScreen;
    WordDetailScreen = module.WordDetailScreen;
    SwitchScreen = module.SwitchScreen;
    FirstRunScene = module.FirstRunScene;
  } catch (error) {
    throw new Error(`Failed to load ProductApp: ${error.message}`);
  }

  /* Every screen this check names must be reachable. A component that cannot
     be loaded used to be skipped, which is how two entries sat in the baseline
     for screens nothing rendered. */
  for (const [name, component] of Object.entries({
    ParentArea,
    ResultsScreen,
    WordBankScreen,
    WordDetailScreen,
    SwitchScreen,
    FirstRunScene,
  })) {
    assert.equal(
      typeof component,
      'function',
      `${name} must be exported from ProductApp.jsx for the h1 check to measure it`,
    );
  }

  const fixtures = createFixtures();

  const screensToTest = [
    { name: 'ParentArea', component: ParentArea, props: fixtures.parentArea },
    { name: 'ResultsScreen', component: ResultsScreen, props: fixtures.resultsScreen },
    { name: 'WordBankScreen', component: WordBankScreen, props: fixtures.wordBankScreen },
    { name: 'WordDetailScreen', component: WordDetailScreen, props: fixtures.wordDetailScreen },
    { name: 'SwitchScreen', component: SwitchScreen, props: fixtures.switchScreen },
    { name: 'FirstRunScene', component: FirstRunScene, props: fixtures.firstRunScene },
  ];

  for (const { name, component, props } of screensToTest) {
    let html;
    try {
      html = renderToStaticMarkup(React.createElement(component, props));
    } catch {
      assert.fail(`${name} must SSR-render for the h1 check`);
    }

    const h1Count = countH1Elements(html);
    const isKnownViolation = KNOWN_VIOLATIONS.has(name);
    
    if (isKnownViolation) {
      assert.ok(
        h1Count !== 1 || baseline.includes(name),
        `${name}: if now passing, remove from baseline.md`,
      );
    } else {
      assert.equal(
        h1Count,
        1,
        `${name} must render with exactly one <h1> (found: ${h1Count})`,
      );
    }
  }
});
