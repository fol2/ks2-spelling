/* Pre-release learner-journey gate.

   Composes the kid/parent product path that previously lived in scattered
   surface tests, so CI fails when the whole Starter (and distinct Full)
   journey regresses. Specialist files named at the end remain the authority
   for their own contracts; this file is the coherent walk.
*/
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createServer } from 'vite';

import { createParentSecurityController } from '../src/app/parent-security-controller.js';
import { createProductLearningController } from '../src/app/product-learning-controller.js';
import {
  askGrownUpIsAvailable,
  remainingStarterWordCount,
  starterCompleteMomentCopy,
  starterCompleteMomentDecision,
} from '../src/app/starter-complete-moment.js';
import { buildCodex } from '../src/app/codex-model.js';
import { eggChoiceShouldShow } from '../src/app/egg-choice-moment.js';
import {
  choosableRewardTrackIdsFromCatalogue,
  pendingEggChoice,
} from '../src/app/monster-progress-model.js';
import {
  loadFullSpellingCatalogue,
  loadStarterSpellingCatalogue,
  validateSpellingCommandSnapshotV1,
} from '../src/domain/spelling/index.js';
import {
  expectedB2Snapshot,
  snapshotAfterPlan,
} from './helpers/b2-database-harness.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOW_MS = 1_768_478_400_000;
const PURCHASE_LANGUAGE =
  /£|GBP|USD|\$\d|\bBuy\b|\bupgrade\b|\bpurchase\b|\bStoreKit\b|\bunlock\b/iu;
const LOCK_SHACKLE = 'M8.2 10.5V7.8a3.8 3.8 0 0 1 7.6 0v2.7';
const ADA = Object.freeze({
  learnerId: 'learner-a',
  nickname: 'Ada',
  yearGroup: 'Y4',
  goal: 10,
  colour: '#1f6f77',
  createdAt: 1,
  updatedAt: 1,
});
const BEA = Object.freeze({
  learnerId: 'learner-b',
  nickname: 'Bea',
  yearGroup: 'Y5',
  goal: 10,
  colour: '#8A5A2E',
  createdAt: 2,
  updatedAt: 2,
});
const REQUIRED_GATES = Object.freeze([
  'tests/first-run-composition.test.mjs',
  'tests/round-feedback-order.test.mjs',
  'tests/kid-practice-mute-control.test.mjs',
  'tests/companion-egg-choice-surface.test.mjs',
  'tests/starter-complete-moment-surface.test.mjs',
  'tests/design-authority-h1-per-screen.test.mjs',
  'tests/app-boot-surface.test.mjs',
  'tests/app-shell.test.mjs',
  'tests/parent-pin-contract.test.mjs',
]);

function store(state) {
  return Object.freeze({
    getState: () => state,
    subscribe: () => Object.freeze({ remove() {} }),
  });
}

function progressFor(items) {
  return Object.fromEntries(items.map(({ runtimeItemId }) => [
    runtimeItemId,
    { stage: 4 },
  ]));
}

function snapshotWithProgress(catalogue, items, learnerId = 'learner-a') {
  const snapshot = structuredClone(expectedB2Snapshot(learnerId));
  snapshot.catalogueId = catalogue.catalogueId;
  snapshot.grantedEntitlementIds = [...catalogue.entitlementIds];
  snapshot.subjectState.data.progress = progressFor(items);
  return validateSpellingCommandSnapshotV1(snapshot, catalogue);
}

function createLearningWorld(
  initialSnapshots = [expectedB2Snapshot('learner-a')],
  catalogue = loadStarterSpellingCatalogue(),
  publishedCatalogue = loadFullSpellingCatalogue(),
) {
  const snapshots = new Map(
    initialSnapshots.map((snapshot) => [
      snapshot.learnerId,
      structuredClone(snapshot),
    ]),
  );
  let tick = 0;
  const snapshotStore = Object.freeze({
    async read(learnerId) {
      const snapshot = snapshots.get(learnerId);
      if (!snapshot) throw new Error('unknown_test_learner');
      return structuredClone(snapshot);
    },
  });
  const repository = Object.freeze({
    async runCommandTransaction(learnerId, planner) {
      const snapshot = snapshots.get(learnerId);
      if (!snapshot) throw new Error('unknown_test_learner');
      const nowMs = NOW_MS + tick;
      tick += 1;
      const plan = await planner(
        structuredClone(snapshot),
        Object.freeze({ nowMs, todayGuardianDay: 20_468 }),
      );
      snapshots.set(learnerId, snapshotAfterPlan(snapshot, plan));
      return structuredClone(plan);
    },
  });
  return Object.freeze({
    catalogue,
    publishedCatalogue,
    snapshots,
    createController(initialSnapshot = initialSnapshots[0] ?? null, options = {}) {
      return createProductLearningController({
        repository,
        snapshotStore,
        catalogue,
        publishedCatalogue,
        initialSnapshot,
        random: () => 0.25,
        now: () => NOW_MS,
        ...options,
      });
    },
  });
}

function targetItem(controller, catalogue) {
  const runtimeItemId = controller.getState().practice?.runtimeItemId;
  return catalogue.items.find((item) => item.runtimeItemId === runtimeItemId);
}

function clozeShowsTarget(cloze, target) {
  const match = /_{2,}/u.exec(cloze ?? '');
  if (!match) return true;
  const visible = `${cloze.slice(0, match.index)} ${cloze.slice(match.index + match[0].length)}`;
  return visible.toLowerCase().includes(String(target).toLowerCase());
}

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `${startMarker} must exist`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `${endMarker} must follow ${startMarker}`);
  return source.slice(start, end);
}

function productServices({
  profiles = [ADA],
  selectedLearnerId = profiles[0]?.learnerId ?? null,
  learning,
  learningState,
  parentStatus = 'locked',
  parentProgressLearners = Object.freeze([]),
  entitlementState = 'none',
  packState = 'missing',
  remainingWordCount = remainingStarterWordCount({
    starterCatalogue: loadStarterSpellingCatalogue(),
    fullCatalogue: loadFullSpellingCatalogue(),
  }),
  catalogueId = 'ks2-core:starter',
  chooseCompanionBranch,
} = {}) {
  const profileState = Object.freeze({
    status: 'ready',
    profiles: Object.freeze(profiles),
    selectedLearnerId,
    actionError: null,
  });
  const audioState = Object.freeze({
    status: 'ready',
    activeVersion: '1.0.0',
    actionError: null,
  });
  const live = learning ?? Object.freeze({
    ...store(learningState),
    showScreen() {},
    async chooseCompanionBranch(request) {
      if (typeof chooseCompanionBranch === 'function') {
        return chooseCompanionBranch(request);
      }
    },
  });
  return Object.freeze({
    mode: 'product',
    catalogueId,
    remainingWordCount,
    controller: Object.freeze({
      ...store(profileState),
      async createProfile() {},
      async selectProfile() {},
    }),
    learning: live,
    audioAvailability: Object.freeze({
      ...store(audioState),
      async recover() {},
      reportPlaybackFailure() {},
    }),
    parent: store(Object.freeze({
      status: parentStatus,
      biometric: Object.freeze({ available: false, type: 'none', enabled: false }),
      attemptsRemaining: 5,
      lockedUntil: 0,
      actionError: null,
    })),
    parentProgress: Object.freeze({
      ...store(Object.freeze({
        status: 'ready',
        learners: parentProgressLearners,
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

function askButtons(html) {
  return html.match(
    /<button[^>]*data-ask-grown-up="true"[^>]*>[\s\S]*?<\/button>/gu,
  ) ?? [];
}

function assertKidSafe(html, label) {
  assert.doesNotMatch(html, PURCHASE_LANGUAGE, `${label} must omit purchase language`);
  assert.doesNotMatch(html, /aria-label="Mute"|Sound effects|setup-sfx/iu, `${label} must omit mute`);
  for (const button of askButtons(html)) {
    assert.equal(
      button.includes(LOCK_SHACKLE),
      false,
      `${label} Ask-a-grown-up must not carry a lock icon`,
    );
  }
}

async function readSource(relativePath) {
  return readFile(join(ROOT, relativePath), 'utf8');
}

test('pre-release child surfaces keep mute off the round and omit purchase copy', async () => {
  const productApp = await readSource('src/app/ProductApp.jsx');
  const roundScreen = sliceBetween(
    productApp,
    'function RoundScreen({',
    '\nfunction ResultsScreen({',
  );
  assert.match(roundScreen, /void play\('sentence'\)/u);
  assert.match(
    roundScreen,
    /useEffect\(\(\) => \{\s*if \(!audioRequest \|\| audioState\.status !== 'ready'\) return;\s*void play\('sentence'\);/u,
  );
  assert.match(roundScreen, /Hear it again/u);
  assert.doesNotMatch(roundScreen, /role="switch"/u);
  assert.doesNotMatch(roundScreen, /aria-label="Mute"/iu);
  assert.doesNotMatch(roundScreen, /Sound effects|setup-sfx|onSetSfxEnabled/u);
  assert.doesNotMatch(roundScreen, PURCHASE_LANGUAGE);
  assert.match(
    roundScreen,
    /const skipAvailable = !answered\s*&& practice\?\.phase === 'question'\s*&& practice\?\.mode !== 'test';/u,
  );
  assert.match(
    roundScreen,
    /Ask a grown-up to restore the full word list\./u,
  );

  const setupScreen = sliceBetween(
    productApp,
    'function SetupScreen({',
    '\nfunction RoundScreen({',
  );
  assert.doesNotMatch(setupScreen, /data-ask-grown-up/u);
  assert.doesNotMatch(setupScreen, /Ask a grown-up/u);
  assert.doesNotMatch(setupScreen, PURCHASE_LANGUAGE);

  for (const file of REQUIRED_GATES) {
    const source = await readSource(file);
    assert.match(source, /\btest\(/u, `${file} must remain a live gate`);
  }
});

test('pre-release learner journey walks first-run through paywall', async (t) => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const vite = await createServer({
    configFile: join(ROOT, 'vite.config.js'),
    server: { middlewareMode: true, hmr: { port: 27_101 } },
    appType: 'custom',
  });
  t.after(() => vite.close());
  const productModule = await vite.ssrLoadModule('/src/app/ProductApp.jsx');
  const ProductApp = productModule.default;
  const {
    ParentArea,
    CodexScreen,
    WordBankScreen,
    CampScreen,
  } = productModule;
  const { EggChoiceMoment } = await vite.ssrLoadModule('/src/app/EggChoiceMoment.jsx');
  const renderApp = (services) => renderToStaticMarkup(
    React.createElement(ProductApp, { services }),
  );
  const starter = loadStarterSpellingCatalogue();
  const full = loadFullSpellingCatalogue();
  const remaining = remainingStarterWordCount({
    starterCatalogue: starter,
    fullCatalogue: full,
  });
  const y34 = starter.items.filter((item) => item.yearBand === '3-4');
  const y56 = starter.items.filter((item) => item.yearBand === '5-6');
  assert.equal(y34.length, 10);
  assert.equal(y56.length, 10);
  assert.equal(remaining, 193);

  await t.test('1 first run / year band / Trail', () => {
    const firstRun = renderApp(productServices({
      profiles: [],
      selectedLearnerId: null,
      learningState: Object.freeze({
        status: 'ready',
        screen: 'profiles',
        learnerId: null,
        practice: null,
        summary: null,
        progress: Object.freeze([]),
        vocabularySets: Object.freeze([]),
        monsters: Object.freeze([]),
        packSize: 20,
        revisionMission: null,
        camp: null,
        actionError: null,
      }),
    }));
    assert.match(firstRun, /first-run-scene/u);
    assert.match(firstRun, /<h1 id="first-run-title">Spelling Camp<\/h1>/u);
    assert.match(firstRun, /Add the first learner/u);
    assert.match(firstRun, /name="yearGroup"/u);
    assert.match(firstRun, />Year 3</u);
    assert.match(firstRun, />Year 6</u);
    assert.match(firstRun, />Add learner</u);
    assert.doesNotMatch(firstRun, /Who is practising\?/u);
    assertKidSafe(firstRun, 'first run');
    assert.equal((firstRun.match(/<h1\b/g) ?? []).length, 1);

    const trail = renderApp(productServices({
      learningState: Object.freeze({
        status: 'ready',
        screen: 'home',
        learnerId: ADA.learnerId,
        practice: null,
        prefs: Object.freeze({ voiceId: 'Iapetus', showCloze: true, autoSpeak: true }),
        summary: null,
        progress: Object.freeze([]),
        vocabularySets: Object.freeze([
          Object.freeze({ id: 'core', label: 'Core', count: 20 }),
        ]),
        monsters: Object.freeze([]),
        packSize: 20,
        revisionMission: null,
        camp: Object.freeze({
          packId: 'ks2-core',
          campHighWater: 0,
          lastCreditedGuardianDay: null,
          canEarnToday: false,
        }),
        actionError: null,
      }),
    }));
    assert.match(trail, /Year 4/u);
    assert.match(trail, /Ada/u);
    assert.match(trail, /id="home-title"/u);
    assert.match(trail, /The Scribe Downs/u);
    assertKidSafe(trail, 'Trail');
  });

  const world = createLearningWorld();
  const controller = world.createController();
  t.after(() => controller.dispose());
  await controller.startRound({ mode: 'smart', length: 5, yearFilter: 'core' });
  const questionItem = targetItem(controller, starter);
  assert.ok(questionItem, 'smart round must project a catalogue item');
  const questionState = controller.getState();

  await t.test('2 practice speak-then-word-shows, mute not pressable, auto speech', () => {
    assert.equal(questionState.screen, 'practice');
    assert.equal(questionState.practice.phase, 'question');
    assert.equal(questionState.practice.awaitingAdvance, false);
    assert.equal(Object.hasOwn(questionState.practice, 'target'), false);
    assert.equal(
      clozeShowsTarget(questionState.practice.cloze, questionItem.target),
      false,
      'cloze must blank the target before it is shown as feedback',
    );
    const html = renderApp(productServices({ learning: controller }));
    assert.match(html, /Spell the word you hear/u);
    assert.match(html, /cloze-blank/u);
    assert.match(html, /Hear it again/u);
    assert.match(html, /aria-label="Replay slowly"/u);
    assert.match(html, />Submit</u);
    assert.match(html, />Skip for now</u);
    assert.doesNotMatch(html, /role="switch"/u);
    assert.doesNotMatch(
      html,
      new RegExp(`\\b${questionItem.target}\\b`, 'iu'),
      'question markup must not leak the target spelling',
    );
    assert.doesNotMatch(html, new RegExp(questionState.practice.sentence.replace(
      /[.*+?^${}()|[\]\\]/gu,
      '\\$&',
    ), 'u'));
    assertKidSafe(html, 'practice question');
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  });

  await t.test('starter test round blanks every spoken target and has no Skip', async () => {
    const leakWorld = createLearningWorld();
    const leakController = leakWorld.createController();
    t.after(() => leakController.dispose());
    await leakController.startRound({ mode: 'test', length: 20, yearFilter: 'core' });
    const testQuestion = renderApp(productServices({ learning: leakController }));
    assert.doesNotMatch(testQuestion, />Skip for now</u);
    await assert.rejects(
      leakController.skipWord(),
      (error) => error?.code === 'product_skip_unavailable',
    );
    const seen = new Set();
    for (let index = 0; index < 20; index += 1) {
      const practice = leakController.getState().practice;
      assert.ok(practice, `card ${index + 1} must still be in session`);
      assert.equal(practice.mode, 'test');
      const item = targetItem(leakController, starter);
      assert.ok(item, `card ${index + 1} must resolve a starter item`);
      seen.add(item.runtimeItemId);
      assert.match(practice.cloze, /_{2,}/u, `${item.target} must be cloze-blanked`);
      assert.equal(
        clozeShowsTarget(practice.cloze, item.target),
        false,
        `${item.target} must not appear in the cloze frame`,
      );
      if (index < 19) {
        await leakController.submitAnswer('zzzzzz');
        await leakController.continueRound();
      }
    }
    assert.equal(seen.size, 20);
  });

  await controller.submitAnswer('zzzzzz');
  const firstMiss = controller.getState();

  await t.test('3 first miss shows You wrote without the target', () => {
    assert.equal(firstMiss.practice.phase, 'retry');
    assert.equal(firstMiss.practice.feedback?.headline, 'Not quite.');
    assert.equal(firstMiss.practice.feedback?.attemptedAnswer, 'zzzzzz');
    assert.equal(firstMiss.practice.feedback?.answer, '');
    const html = renderApp(productServices({ learning: controller }));
    assert.match(html, /<span>You wrote<\/span><strong>zzzzzz<\/strong>/u);
    assert.doesNotMatch(html, /Correct spelling/u);
    assert.doesNotMatch(html, />Skip for now</u);
    assert.doesNotMatch(
      html,
      new RegExp(`\\b${questionItem.target}\\b`, 'iu'),
    );
    assertKidSafe(html, 'first miss');
  });

  await t.test('skip during retry does not throw through the planner', async () => {
    await assert.rejects(
      controller.skipWord(),
      (error) => error?.code === 'product_skip_unavailable',
    );
    assert.equal(controller.getState().practice.phase, 'retry');
  });

  await controller.submitAnswer('zzzzzz');
  const correction = controller.getState();

  await t.test('4 retry then correction reveals the spelling to copy', () => {
    assert.equal(correction.practice.phase, 'correction');
    assert.equal(correction.practice.feedback?.headline, 'Still not quite.');
    assert.equal(correction.practice.feedback?.answer, questionItem.target);
    const html = renderApp(productServices({ learning: controller }));
    assert.match(html, /<span>You wrote<\/span><strong>zzzzzz<\/strong>/u);
    assert.match(
      html,
      new RegExp(
        `<span>Correct spelling</span><strong>${questionItem.target}</strong>`,
        'u',
      ),
    );
    assertKidSafe(html, 'correction');
  });

  await controller.submitAnswer(questionItem.target);
  const lockedIn = controller.getState();

  await t.test('3b correct recovery is success-toned without You wrote', () => {
    assert.equal(lockedIn.practice.awaitingAdvance, true);
    assert.equal(lockedIn.practice.feedback?.kind, 'info');
    assert.equal(lockedIn.practice.feedback?.headline, 'Locked in.');
    const html = renderApp(productServices({ learning: controller }));
    assert.match(html, /data-kind="success"/u);
    assert.match(html, /Locked in\./u);
    assert.doesNotMatch(html, /You wrote/u);
    assert.match(html, />Continue</u);
    assertKidSafe(html, 'correct recovery');
  });

  await controller.continueRound();
  const nextItem = targetItem(controller, starter);
  await controller.submitAnswer(nextItem.target);
  const firstHit = controller.getState();

  await t.test('3c first-time correct is success-toned without You wrote', () => {
    assert.match(firstHit.practice.feedback?.headline ?? '', /Good first hit\.|Correct\./u);
    const html = renderApp(productServices({ learning: controller }));
    assert.match(html, /data-kind="success"/u);
    assert.doesNotMatch(html, /You wrote/u);
    assertKidSafe(html, 'first-time correct');
  });

  await controller.continueRound();
  await controller.endRound();
  const summary = controller.getState();

  await t.test('5 Results / Field Record', () => {
    assert.equal(summary.screen, 'summary');
    assert.ok(summary.summary);
    const html = renderApp(productServices({ learning: controller }));
    assert.match(html, /Field record/u);
    assert.match(html, /id="summary-title"/u);
    assert.match(html, /words walked/u);
    assertKidSafe(html, 'Field Record');
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  });

  const foundWorld = createLearningWorld([snapshotWithProgress(starter, y34.slice(0, 1))]);
  const foundController = foundWorld.createController();
  t.after(() => foundController.dispose());
  const foundState = foundController.getState();
  const inklet = foundState.monsters.find((row) => row.monsterId === 'inklet');
  const phaeton = foundState.monsters.find((row) => row.monsterId === 'phaeton');

  await t.test('6–8 egg choice, hatch limits, Phaeton teaser', () => {
    assert.equal(inklet?.caught, true);
    assert.equal(inklet?.branch, null);
    assert.equal(phaeton?.caught, false);
    assert.equal(
      foundState.choosableRewardTrackIds.includes('spelling-core-phaeton'),
      false,
    );
    assert.equal(pendingEggChoice(foundState.monsters, foundState.choosableRewardTrackIds)?.monsterId, 'inklet');
    assert.equal(
      eggChoiceShouldShow({
        monsters: foundState.monsters,
        screen: 'monster',
        choosableRewardTrackIds: foundState.choosableRewardTrackIds,
      }),
      true,
    );
    assert.equal(
      eggChoiceShouldShow({
        monsters: foundState.monsters,
        screen: 'practice',
        choosableRewardTrackIds: foundState.choosableRewardTrackIds,
      }),
      false,
    );
    const overlay = renderApp(productServices({
      learning: foundController,
      chooseCompanionBranch() {
        throw new Error('persist_failed');
      },
    }));
    assert.match(overlay, /data-egg-choice-moment="true"/u);
    assert.match(overlay, /Which egg is yours\?/u);
    assert.match(overlay, /data-branch="b1"/u);
    assert.match(overlay, /data-branch="b2"/u);
    assert.doesNotMatch(overlay, /Phaeton/u);
    assertKidSafe(overlay, 'egg choice');

    const dialog = renderToStaticMarkup(
      React.createElement(EggChoiceMoment, {
        monster: inklet,
        onChoose() {},
        onDismiss() {},
      }),
    );
    assert.match(dialog, /data-egg-choice-moment="true"/u);
    assert.doesNotMatch(dialog, /data-egg-choice-save-failed/u);
    assertKidSafe(dialog, 'egg dialog');

    const roster = buildCodex(foundState.monsters).roster;
    assert.equal(roster.length, 3);
    const phaetonEntry = roster.find((row) => row.monsterId === 'phaeton');
    assert.equal(phaetonEntry.found, false);
    assert.match(phaetonEntry.next, /Secure 3 spellings/u);
    const teaser = renderToStaticMarkup(React.createElement(CodexScreen, {
      monsters: foundState.monsters,
      progress: foundState.progress,
      onScreen() {},
      entitled: false,
      remainingWordCount: remaining,
      selectedRewardTrackId: phaeton.rewardTrackId,
      onAskGrownUp() {},
    }));
    assert.match(teaser, /\/monsters\/phaeton\//u);
    assert.match(teaser, />Undiscovered</u);
    assert.match(teaser, /Secure 3 spellings/u);
    assert.doesNotMatch(teaser, /Choose the other egg/u);
    assertKidSafe(teaser, 'Phaeton teaser');
  });

  const hatchedSnapshot = snapshotWithProgress(starter, y34);
  hatchedSnapshot.monsterStateByRewardTrackId = {
    'spelling-core-inklet': {
      rewardTrackId: 'spelling-core-inklet',
      packId: 'ks2-core',
      monsterId: 'inklet',
      branch: 'b1',
      secureCount: 10,
      caught: true,
      derivedStage: 1,
      earnedStageHighWater: 1,
    },
  };
  const hatchedWorld = createLearningWorld([
    validateSpellingCommandSnapshotV1(hatchedSnapshot, starter),
  ]);
  const hatchedController = hatchedWorld.createController();
  t.after(() => hatchedController.dispose());
  hatchedController.showScreen('monster');

  await t.test('7, 9 Camp / Codex roster and Ask-a-grown-up after hatch', () => {
    const state = hatchedController.getState();
    const hatchedInklet = state.monsters.find((row) => row.monsterId === 'inklet');
    assert.ok(hatchedInklet.derivedStage >= 1);
    assert.equal(hatchedInklet.branch, 'b1');
    assert.equal(
      askGrownUpIsAvailable({
        monsters: state.monsters,
        entitled: false,
        remainingWordCount: remaining,
      }),
      true,
    );
    const codex = renderApp(productServices({ learning: hatchedController }));
    assert.match(codex, /The Codex/u);
    assert.match(codex, /data-ask-grown-up="true"/u);
    assert.match(codex, /Ask a grown-up/u);
    assert.equal(askButtons(codex).length, 1);
    assertKidSafe(codex, 'Codex after hatch');
    const phaetonRow = buildCodex(state.monsters).roster.find(
      (row) => row.monsterId === 'phaeton',
    );
    assert.equal(phaetonRow.found, false);
    assert.doesNotMatch(codex, /data-egg-choice-moment="true"/u);

    hatchedController.showScreen('progress');
    const bank = renderApp(productServices({ learning: hatchedController }));
    assert.match(bank, /data-ask-grown-up="true"/u);
    assert.match(bank, /Your words/u);
    assertKidSafe(bank, 'Word Bank after hatch');

    hatchedController.showScreen('setup');
    const setup = renderApp(productServices({ learning: hatchedController }));
    assert.doesNotMatch(setup, /data-ask-grown-up="true"/u);
    assert.doesNotMatch(setup, /Ask a grown-up/u);
    assertKidSafe(setup, 'Setup after hatch');

    hatchedController.showScreen('home');
    const trail = renderApp(productServices({ learning: hatchedController }));
    assert.doesNotMatch(trail, /data-ask-grown-up="true"/u);
    assertKidSafe(trail, 'Trail after hatch');

    hatchedController.showScreen('camp');
    const camp = renderApp(productServices({ learning: hatchedController }));
    assert.doesNotMatch(camp, /data-ask-grown-up="true"/u);
    assertKidSafe(camp, 'Camp after hatch');

    const entitledCodex = renderToStaticMarkup(React.createElement(CodexScreen, {
      monsters: state.monsters,
      progress: state.progress,
      onScreen() {},
      entitled: true,
      remainingWordCount: remaining,
      onAskGrownUp() {},
    }));
    assert.doesNotMatch(entitledCodex, /data-ask-grown-up="true"/u);

    const bankDirect = renderToStaticMarkup(React.createElement(WordBankScreen, {
      progress: state.progress,
      vocabularySets: state.vocabularySets,
      onScreen() {},
      onStart() {},
      wordMaterial() { return null; },
      onPractise() {},
      audio: Object.freeze({ async play() {} }),
      audioState: Object.freeze({ status: 'ready', activeVersion: '1.0.0', actionError: null }),
      voiceId: 'Iapetus',
      busy: false,
      onPlaybackFailure() {},
      monsters: state.monsters,
      entitled: false,
      remainingWordCount: remaining,
      onAskGrownUp() {},
    }));
    assert.match(bankDirect, /data-ask-grown-up="true"/u);
    assertKidSafe(bankDirect, 'Word Bank footer');
  });

  await t.test('8 Full Phaeton is choosable; trial is not', () => {
    const fullY34 = full.items.filter((item) => item.yearBand === '3-4').slice(0, 2);
    const fullY56 = full.items.filter((item) => item.yearBand === '5-6').slice(0, 1);
    const fullSnap = snapshotWithProgress(full, [...fullY34, ...fullY56]);
    const fullWorld = createLearningWorld([fullSnap], full, full);
    const fullController = fullWorld.createController();
    const monsters = fullController.getState().monsters;
    const choosable = choosableRewardTrackIdsFromCatalogue(full);
    assert.equal(choosable.includes('spelling-core-phaeton'), true);
    assert.equal(
      monsters.find((row) => row.monsterId === 'phaeton')?.caught,
      true,
    );
    assert.equal(
      starter.rewardTracks.some((track) => track.monsterId === 'phaeton'),
      false,
    );
    void fullController.dispose();
  });

  await t.test('10 Starter-complete moment when a band is secure', () => {
    const copy = starterCompleteMomentCopy(remaining);
    assert.equal(copy.grownUpAction, 'Ask a grown-up');
    assert.doesNotMatch(JSON.stringify(copy), PURCHASE_LANGUAGE);
    const before = [{
      rewardTrackId: 'spelling-core-inklet',
      monsterId: 'inklet',
      secureCount: 9,
    }];
    const after = [{
      rewardTrackId: 'spelling-core-inklet',
      monsterId: 'inklet',
      secureCount: 10,
    }];
    const live = starterCompleteMomentDecision({
      beforeMonsters: before,
      afterMonsters: after,
      starterCatalogue: starter,
      remainingWordCount: remaining,
      source: 'round',
    });
    assert.equal(live.show, true);
    const restart = starterCompleteMomentDecision({
      beforeMonsters: after,
      afterMonsters: after,
      starterCatalogue: starter,
      remainingWordCount: remaining,
      source: 'restart',
    });
    assert.equal(restart.show, false);
    assert.equal(restart.persist, true);
  });

  await t.test('11 Parent PIN gate + progress smoke', async () => {
    const locked = renderToStaticMarkup(React.createElement(ParentArea, {
      state: Object.freeze({
        status: 'locked',
        biometric: Object.freeze({ available: false, type: 'none', enabled: false }),
        attemptsRemaining: 5,
        lockedUntil: 0,
        actionError: null,
      }),
      profiles: [ADA],
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
      onSetPin() {},
      onResetPin() {},
      onUnlockPin() {},
      onUnlockBiometrics() {},
      onSetBiometricsEnabled() {},
      onEditProfile() {},
      onRemoveProfile() {},
      onResetLearning() {},
      onRefreshProgress() {},
      onPurchase() {},
      onRestore() {},
      onDownload() {},
      onRecoverCommerce() {},
    }));
    assert.match(locked, /Enter Parent PIN/u);
    assert.match(locked, /Grown-ups only/u);
    assert.match(locked, /id="parent-pin"/u);
    assert.doesNotMatch(locked, /Buy Full KS2/u);

    const unlocked = renderToStaticMarkup(React.createElement(ParentArea, {
      state: Object.freeze({
        status: 'unlocked',
        biometric: Object.freeze({ available: false, type: 'none', enabled: false }),
        attemptsRemaining: 5,
        lockedUntil: 0,
        actionError: null,
      }),
      profiles: [ADA, BEA],
      progressState: Object.freeze({
        status: 'ready',
        learners: Object.freeze([
          Object.freeze({
            learnerId: ADA.learnerId,
            nickname: ADA.nickname,
            yearGroup: ADA.yearGroup,
            colour: ADA.colour,
            publishedItemCount: 20,
            secureItemCount: 10,
            dueItemCount: 0,
            troubleItemCount: 0,
            correctCount: 10,
            wrongCount: 0,
            accuracyPercent: 100,
            guardianDueCount: 0,
            wobblingDueCount: 0,
            nextGuardianReviewDay: null,
            recentRevisionSessions: Object.freeze([]),
          }),
          Object.freeze({
            learnerId: BEA.learnerId,
            nickname: BEA.nickname,
            yearGroup: BEA.yearGroup,
            colour: BEA.colour,
            publishedItemCount: 20,
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
      onSetPin() {},
      onResetPin() {},
      onUnlockPin() {},
      onUnlockBiometrics() {},
      onSetBiometricsEnabled() {},
      onEditProfile() {},
      onRemoveProfile() {},
      onResetLearning() {},
      onRefreshProgress() {},
      onPurchase() {},
      onRestore() {},
      onDownload() {},
      onRecoverCommerce() {},
    }));
    assert.match(unlocked, /Manage learners/u);
    assert.match(unlocked, /Ada/u);
    assert.match(unlocked, /Bea/u);
    assert.match(unlocked, /10 secure/u);
    assert.match(unlocked, /Buy Full KS2/u);

    let record = null;
    const parent = await createParentSecurityController({
      repository: Object.freeze({
        async read() {
          return record === null ? null : structuredClone(record);
        },
        async write(next) {
          record = structuredClone(next);
          return structuredClone(next);
        },
      }),
      biometrics: Object.freeze({
        async getAvailability() {
          return Object.freeze({ available: false, type: 'none' });
        },
        async authenticate() {
          return Object.freeze({ authenticated: false });
        },
      }),
      deviceAuthentication: Object.freeze({
        async getAvailability() {
          return Object.freeze({ available: true });
        },
        async authenticate() {
          return Object.freeze({ authenticated: true });
        },
      }),
      pinCrypto: Object.freeze({
        async create(pin) {
          return Object.freeze({
            algorithm: 'PBKDF2-SHA-256',
            iterations: 210_000,
            saltBase64: 'MTIzNDU2Nzg5MDEyMzQ1Ng==',
            verifierBase64: Buffer.from(pin.padEnd(32, '.')).toString('base64'),
          });
        },
        async verify(pin, candidate) {
          return candidate.verifierBase64
            === Buffer.from(pin.padEnd(32, '.')).toString('base64');
        },
      }),
      lifecycle: Object.freeze({
        onPause() {
          return Object.freeze({ async remove() {} });
        },
      }),
      now: () => NOW_MS,
    });
    await parent.setPin({ pin: '739251', confirmation: '739251' });
    assert.equal(parent.getState().status, 'unlocked');
    parent.lock();
    assert.equal(parent.getState().status, 'locked');
    await parent.unlockWithPin('739251');
    assert.equal(parent.getState().status, 'unlocked');
    parent.lock();
    await assert.rejects(
      parent.unlockWithPin('852963'),
      (error) => error?.code === 'parent_pin_incorrect',
    );
    await parent.dispose();
  });

  await t.test('12 two-learner isolation smoke', async () => {
    const isolated = createLearningWorld([
      snapshotWithProgress(starter, y34, 'learner-a'),
      expectedB2Snapshot('learner-b'),
    ]);
    const dual = isolated.createController(
      isolated.snapshots.get('learner-a'),
    );
    t.after(() => dual.dispose());
    const adaMonsters = dual.getState().monsters;
    assert.equal(
      adaMonsters.find((row) => row.monsterId === 'inklet')?.secureCount,
      10,
    );
    await dual.selectLearner('learner-b');
    const bea = dual.getState();
    assert.equal(bea.learnerId, 'learner-b');
    assert.equal(
      bea.monsters.find((row) => row.monsterId === 'inklet')?.secureCount,
      0,
    );
    assert.equal(
      bea.progress.every((row) => (row.stage ?? 0) === 0),
      true,
    );
    const beaTrail = renderApp(productServices({
      profiles: [ADA, BEA],
      selectedLearnerId: BEA.learnerId,
      learning: dual,
    }));
    assert.match(beaTrail, /Bea/u);
    assert.doesNotMatch(beaTrail, />Ada</u);
    assertKidSafe(beaTrail, 'second learner Trail');
  });

  await t.test('13 reduce-motion contracts stay in the product stylesheet', async () => {
    const css = await readSource('src/app/app.css');
    const reduce = css.lastIndexOf('@media (prefers-reduced-motion: reduce)');
    assert.ok(reduce > 0, 'product CSS must still a reduced-motion kill switch');
    const block = css.slice(reduce, reduce + 2_400);
    assert.match(block, /animation:\s*none\s*!important/u);
    assert.match(block, /\.app-boot \*,/u);
  });

  await t.test('14 Camp first-patrol copy still exists for the empty camp', () => {
    const html = renderToStaticMarkup(React.createElement(CampScreen, {
      camp: Object.freeze({
        packId: 'ks2-core',
        campHighWater: 0,
        lastCreditedGuardianDay: null,
        canEarnToday: false,
      }),
      revisionMission: Object.freeze({
        phase: 'asleep',
        guardianDueCount: 0,
        canStartRewardBearing: false,
        canContinueUnrewarded: false,
      }),
      megaWords: 0,
      packSize: 20,
      audioState: Object.freeze({ status: 'ready', activeVersion: '1.0.0', actionError: null }),
      onScreen() {},
      onStartGuardian() {},
      onRecoverAudio() {},
    }));
    assert.match(html, /id="camp-title"/u);
    assert.match(html, /Guardian sleeps here/u);
    assertKidSafe(html, 'Camp empty');
  });
});
