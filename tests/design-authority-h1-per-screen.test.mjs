/* Design authority heading check — Layer 2 automated.

   The clause is "Headings follow document order and each screen has exactly
   one `h1`", so this check measures both halves: exactly one <h1>, and every
   heading below it descending without skipping a level.

   The baseline escape hatch this check used to carry is gone. It could never
   fail — `h1Count !== 1 || baseline.includes(name)` is true whether the screen
   is broken or fixed — and with #113 the last h1 violation is retired, so the
   clause is a hard gate rather than a baselined one.

   What it reaches: every `<h1 id=...>` site in `src/app/ProductApp.jsx` — all
   seventeen at #113 — each one verified by mutating it to `<h2>` and watching
   this check go red. A screen that paints a different heading per state is
   therefore listed once per state (Camp's five Guardian phases, the parent gate
   and the area behind it), because one fixture measures one heading. A new
   branch carrying its own `h1` needs its own case here, or it is unmeasured. */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createServer } from 'vite';

import { createProductFailureServices } from '../src/app/product-failure-services.js';
import { buildWordBank, buildWordDetail } from '../src/app/word-bank-model.js';
import { loadStarterSpellingCatalogue } from '../src/domain/spelling/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

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

  const profile = Object.freeze({
    learnerId: 'learner-a',
    nickname: 'Ada',
    yearGroup: 'Y4',
    goal: 10,
    colour: '#1f6f77',
  });
  const monsters = Object.freeze([
    Object.freeze({
      rewardTrackId: 'r1',
      packId: 'ks2-core',
      monsterId: 'inklet',
      thresholds: Object.freeze([1, 10, 30, 60, 100]),
      branch: 'b1',
      secureCount: 34,
      caught: true,
      derivedStage: 3,
      earnedStageHighWater: 3,
    }),
  ]);

  return Object.freeze({
    profiles: Object.freeze([]),
    trailScreen: Object.freeze({
      profile,
      learningState: Object.freeze({
        learnerId: 'learner-a',
        screen: 'home',
        monsters,
      }),
      audioState,
      dueCount: 6,
      onScreen: noop,
      onSwitchLearner: noop,
      onOpenParent: noop,
      onRecoverAudio: noop,
    }),
    setupScreen: Object.freeze({
      audioState,
      actionError: null,
      onStart: async () => {},
      onBack: noop,
      onScreen: noop,
      onRecoverAudio: noop,
      busy: false,
      dueCount: 6,
      troubleCount: 2,
      bankTotal: 20,
      vocabularySets: Object.freeze([
        Object.freeze({ id: 'core', label: 'Core', count: 20 }),
      ]),
      monsters,
      sfxEnabled: true,
      onSetSfxEnabled: noop,
      revisionMission: null,
      megaWords: 4,
      packSize: 20,
      onStartGuardian: async () => {},
    }),
    roundScreen: Object.freeze({
      state: Object.freeze({
        status: 'ready',
        actionError: null,
        prefs: Object.freeze({ voiceId: 'Iapetus' }),
        practice: Object.freeze({
          sessionId: 'session-1',
          runtimeItemId: 'ks2-core:busy',
          mode: 'smart',
          label: 'Smart Review',
          sentence: 'The shop was busy all morning.',
          cloze: 'The shop was ______ all morning.',
          awaitingAdvance: false,
          feedback: null,
          progress: Object.freeze({ total: 5, done: 1, checked: 1 }),
        }),
      }),
      audioState,
      audio,
      haptics: null,
      sfx: null,
      onSubmit: async () => {},
      onContinue: noop,
      onSkip: async () => {},
      onEnd: async () => {},
      onPlaybackFailure: noop,
      entitlementState: 'none',
    }),
    codexScreen: Object.freeze({
      monsters,
      progress: Object.freeze([
        progressRow('ks2-core:busy', { stage: 4, attempts: 5, correct: 5 }),
      ]),
      onScreen: noop,
    }),
    /* Camp paints a different h1 per Guardian phase, so one fixture measures
       one of five headings. `guardianPhase` reads only these four fields. */
    campScreen: (revisionMission) => Object.freeze({
      camp,
      revisionMission,
      megaWords: 4,
      packSize: 20,
      audioState,
      busy: false,
      onScreen: noop,
      onStartGuardian: async () => {},
      onRecoverAudio: noop,
      achievements: Object.freeze([]),
    }),
    guardianMissions: Object.freeze({
      locked: null,
      'due-none': Object.freeze({
        missionState: 'first-patrol',
        campCreditState: 'available',
        canStartRewardBearing: true,
        canContinueUnrewarded: false,
        guardianDueCount: 0,
        nextGuardianDueDay: 4200,
        todayGuardianDay: 4200,
      }),
      'due-some': Object.freeze({
        missionState: 'first-patrol',
        campCreditState: 'available',
        canStartRewardBearing: true,
        canContinueUnrewarded: false,
        guardianDueCount: 6,
        nextGuardianDueDay: 4200,
        todayGuardianDay: 4200,
      }),
      rested: Object.freeze({
        missionState: 'rested',
        campCreditState: 'available',
        canStartRewardBearing: false,
        canContinueUnrewarded: false,
        guardianDueCount: 0,
        nextGuardianDueDay: 4203,
        todayGuardianDay: 4200,
      }),
      done: Object.freeze({
        missionState: 'due',
        campCreditState: 'complete-for-today',
        canStartRewardBearing: false,
        canContinueUnrewarded: true,
        guardianDueCount: 4,
        nextGuardianDueDay: 4200,
        todayGuardianDay: 4200,
      }),
    }),
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
    /* The gate and the area behind it carry different h1s; both are screens a
       parent lands on, so both are measured. */
    parentArea: (status) => Object.freeze({
      state: Object.freeze({
        status,
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

/* Heading levels in document order. SSR markup is the measurement surface, so
   the source order the regex walks is the order a screen reader walks. */
function headingLevels(html) {
  return [...html.matchAll(/<h([1-6])[\s>]/gi)].map((match) => Number(match[1]));
}

test('Design authority: every product screen renders one h1 and skips no heading level (SSR)', async (t) => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  
  const vite = await createServer({
    configFile: join(ROOT, 'vite.config.js'),
    server: { middlewareMode: true },
    appType: 'custom',
  });
  t.after(() => vite.close());

  let ParentArea;
  let ResultsScreen;
  let WordBankScreen;
  let WordDetailScreen;
  let SwitchScreen;
  let FirstRunScene;
  let TrailScreen;
  let SetupScreen;
  let RoundScreen;
  let CodexScreen;
  let CampScreen;
  let ProductApp;

  try {
    const module = await vite.ssrLoadModule('/src/app/ProductApp.jsx');
    ParentArea = module.ParentArea;
    ResultsScreen = module.ResultsScreen;
    WordBankScreen = module.WordBankScreen;
    WordDetailScreen = module.WordDetailScreen;
    SwitchScreen = module.SwitchScreen;
    FirstRunScene = module.FirstRunScene;
    TrailScreen = module.TrailScreen;
    SetupScreen = module.SetupScreen;
    RoundScreen = module.RoundScreen;
    CodexScreen = module.CodexScreen;
    CampScreen = module.CampScreen;
    ProductApp = module.default;
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
    TrailScreen,
    SetupScreen,
    RoundScreen,
    CodexScreen,
    CampScreen,
    ProductApp,
  })) {
    assert.equal(
      typeof component,
      'function',
      `${name} must be exported from ProductApp.jsx for the h1 check to measure it`,
    );
  }

  const fixtures = createFixtures();

  const screensToTest = [
    {
      name: 'ParentArea (gate)',
      component: ParentArea,
      props: fixtures.parentArea('setup-required'),
    },
    {
      name: 'ParentArea (unlocked)',
      component: ParentArea,
      props: fixtures.parentArea('unlocked'),
    },
    { name: 'ResultsScreen', component: ResultsScreen, props: fixtures.resultsScreen },
    /* The startup-failure screen is not a screen component — it is an early
       return inside ProductApp — so it is reached through the failure services
       the app itself builds, not a hand-written stub. */
    {
      name: 'ProductApp (startup failure)',
      component: ProductApp,
      props: { services: createProductFailureServices({ cause: new Error('disk') }) },
    },
    { name: 'WordBankScreen', component: WordBankScreen, props: fixtures.wordBankScreen },
    { name: 'WordDetailScreen', component: WordDetailScreen, props: fixtures.wordDetailScreen },
    { name: 'SwitchScreen', component: SwitchScreen, props: fixtures.switchScreen },
    { name: 'FirstRunScene', component: FirstRunScene, props: fixtures.firstRunScene },
    { name: 'TrailScreen', component: TrailScreen, props: fixtures.trailScreen },
    { name: 'SetupScreen', component: SetupScreen, props: fixtures.setupScreen },
    { name: 'RoundScreen', component: RoundScreen, props: fixtures.roundScreen },
    { name: 'CodexScreen', component: CodexScreen, props: fixtures.codexScreen },
    ...Object.entries(fixtures.guardianMissions).map(([phase, mission]) => ({
      name: `CampScreen (${phase})`,
      component: CampScreen,
      props: fixtures.campScreen(mission),
    })),
  ];

  for (const { name, component, props } of screensToTest) {
    let html;
    try {
      html = renderToStaticMarkup(React.createElement(component, props));
    } catch {
      assert.fail(`${name} must SSR-render for the h1 check`);
    }

    assert.equal(
      countH1Elements(html),
      1,
      `${name} must render with exactly one <h1> (found: ${countH1Elements(html)})`,
    );

    const levels = headingLevels(html);
    assert.equal(
      levels[0],
      1,
      `${name} must open its heading order with the h1, not h${levels[0]}`,
    );
    for (let index = 1; index < levels.length; index += 1) {
      assert.ok(
        levels[index] <= levels[index - 1] + 1,
        `${name} skips a heading level: h${levels[index - 1]} is followed by `
          + `h${levels[index]} (order: ${levels.join(' ')})`,
      );
    }
  }
});
