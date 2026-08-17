/* Design harness. Dev-only — never bundled (see vite.design.config.js).
 *
 * Mounts the real ProductApp over in-memory services so every screen can be
 * walked at any viewport in a browser. The spelling engine is deliberately
 * faked: a fixed word list and a "right if you typed the target" rule is
 * enough to reach every visual state, and the real engine is out of scope for
 * design work.
 *
 * Query flags:
 *   ?screen=…                 deep-link into a ProductApp screen
 *   ?guardian=locked|teaser|first|active|rested|done
 *                             Camp / Setup Guardian projection (see below)
 *   ?empty                    empty learner / empty roster
 *   ?audio=…                  audioAvailability status
 *   ?parent=…                 parent lock status
 *   ?open=parent              click For parents after mount (screenshot capture)
 *   ?capture=parent-listing   hide admin/commerce cards for screenshot 9
 *   ?commerce=owned|installed Parent commerce: bought and waiting to download
 *                             (press Download pack to walk the 15-shard
 *                             install meter), or installed and offering the
 *                             restart onto the full word list
 *   ?mode=…                   practice / summary round mode
 *   ?unfound-companion=true   Setup: band companion asleep (silhouette + hint).
 *                             Selects the Y3–4 set so Inklet paints unfound;
 *                             vocabulary set rail stays visible.
 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ProductApp from '../src/app/ProductApp.jsx';
import AppErrorBoundary from '../src/app/AppErrorBoundary.jsx';
import AppLoadingShell from '../src/app/AppLoadingShell.jsx';
import '../src/app/app.css';
import './harness.css';

const WORDS = [
  { slug: 'business', target: 'business', sentence: 'Her family runs a small business in town.', cloze: 'Her family runs a small ______ in town.' },
  { slug: 'separate', target: 'separate', sentence: 'Please separate the recycling from the rubbish.', cloze: 'Please ______ the recycling from the rubbish.' },
  { slug: 'necessary', target: 'necessary', sentence: 'A coat is necessary on a morning like this.', cloze: 'A coat is ______ on a morning like this.' },
  { slug: 'rhythm', target: 'rhythm', sentence: 'The drummer kept a steady rhythm.', cloze: 'The drummer kept a steady ______.' },
  { slug: 'occasion', target: 'occasion', sentence: 'We saved the cake for a special occasion.', cloze: 'We saved the cake for a special ______.' },
];

const PROGRESS = [
  { runtimeItemId: 'i1', target: 'business', stage: 4, correct: 7, wrong: 1, lastResult: 'correct' },
  { runtimeItemId: 'i2', target: 'separate', stage: 2, correct: 3, wrong: 3, lastResult: 'wrong' },
  { runtimeItemId: 'i3', target: 'necessary', stage: 5, correct: 9, wrong: 0, lastResult: 'correct' },
  { runtimeItemId: 'i4', target: 'rhythm', stage: 1, correct: 1, wrong: 4, lastResult: 'wrong' },
  { runtimeItemId: 'i5', target: 'occasion', stage: 3, correct: 5, wrong: 2, lastResult: 'correct' },
  { runtimeItemId: 'i6', target: 'accommodate', stage: 2, correct: 2, wrong: 2, lastResult: 'wrong' },
  { runtimeItemId: 'i7', target: 'mischievous', stage: 3, correct: 4, wrong: 1, lastResult: 'correct' },
  { runtimeItemId: 'i8', target: 'conscience', stage: 1, correct: 0, wrong: 3, lastResult: 'wrong' },
];

/* What the installed pack says about each bank word, in the catalogue's own
   shape, so the opened word can be judged on real copy lengths. Transcribed
   from the vendored runtime catalogue; `busy/business` and `occasion(ally)`
   are the two families here that hold a second spelling. */
const WORD_MATERIAL = Object.fromEntries([
  ['i1', 'Years 3-4', 'A business is work or an organisation that sells goods or services.', 'The family business sells fresh bread.', ['busy', 'business']],
  ['i2', 'Years 3-4', 'Separate means apart, not joined together.', 'Keep the white socks separate from the dark ones.', ['separate']],
  ['i3', 'Years 5-6', 'Necessary means needed or required.', 'A helmet is necessary for safety.', ['necessary']],
  ['i4', 'Years 5-6', 'Rhythm is a regular pattern of sounds, beats or movements.', 'The drummer kept a steady rhythm.', ['rhythm']],
  ['i5', 'Years 3-4', 'An occasion is a particular time when something happens, often something special.', 'The party was a special occasion.', ['occasion', 'occasionally']],
  ['i6', 'Years 5-6', 'To accommodate means to provide space for someone or something, or to fit in with needs.', 'This hotel can accommodate fifty guests.', ['accommodate']],
  ['i7', 'Years 5-6', 'Mischievous means playful in a naughty or troublesome way.', 'The mischievous cat stole a biscuit.', ['mischievous']],
  ['i8', 'Years 5-6', 'Your conscience is the inner sense that helps you know right from wrong.', 'His conscience told him to return the lost wallet.', ['conscience']],
].map(([runtimeItemId, yearLabel, explanation, sentence, familyWords]) => [
  runtimeItemId,
  {
    runtimeItemId,
    yearLabel,
    explanation,
    sentencePrompts: [{ sentenceId: 'sentence-1', text: sentence }],
    familyWords,
  },
]));

const MONSTERS = [
  { rewardTrackId: 'r1', packId: 'ks2-core', monsterId: 'inklet', thresholds: [1, 10, 30, 60, 100], branch: 'b1', secureCount: 34, caught: true, derivedStage: 3, earnedStageHighWater: 3 },
  { rewardTrackId: 'r2', packId: 'ks2-core', monsterId: 'glimmerbug', thresholds: [1, 10, 30, 60, 100], branch: 'b1', secureCount: 12, caught: true, derivedStage: 2, earnedStageHighWater: 2 },
  { rewardTrackId: 'r3', packId: 'ks2-full', monsterId: 'vellhorn', thresholds: [1, 10, 30, 60, 100], branch: 'b2', secureCount: 0, caught: false, derivedStage: 0, earnedStageHighWater: 0 },
  { rewardTrackId: 'r4', packId: 'ks2-full', monsterId: 'phaeton', thresholds: [1, 10, 30, 60, 100], branch: 'b1', secureCount: 0, caught: false, derivedStage: 0, earnedStageHighWater: 0 },
];

/* Guardian states, walked with ?guardian=locked|teaser|first|active|rested|done on
   ?screen=camp and ?screen=setup. `locked` is the projection an unentitled
   learner gets; leaving the parameter off keeps revisionMission null, which is
   the other pre-unlock shape the screens have to survive. */
const GUARDIAN_DAY = 4200;

const GUARDIAN_STATES = {
  locked: {
    mission: {
      missionState: 'locked',
      eligibleMissionKind: null,
      guardianDueCount: 0,
      wobblingDueCount: 0,
      nextGuardianDueDay: null,
      todayGuardianDay: GUARDIAN_DAY,
      canStartRewardBearing: false,
      canContinueUnrewarded: false,
      campCreditState: 'unavailable',
    },
    mega: 12,
    campHighWater: 0,
  },
  teaser: {
    mission: {
      missionState: 'locked',
      eligibleMissionKind: null,
      guardianDueCount: 0,
      wobblingDueCount: 0,
      nextGuardianDueDay: null,
      todayGuardianDay: GUARDIAN_DAY,
      canStartRewardBearing: false,
      canContinueUnrewarded: false,
      campCreditState: 'available',
    },
    mega: 34,
    campHighWater: 0,
  },
  first: {
    mission: {
      missionState: 'first-patrol',
      eligibleMissionKind: 'first-patrol',
      guardianDueCount: 0,
      wobblingDueCount: 0,
      nextGuardianDueDay: GUARDIAN_DAY,
      todayGuardianDay: GUARDIAN_DAY,
      canStartRewardBearing: true,
      canContinueUnrewarded: false,
      campCreditState: 'available',
    },
    mega: 213,
    campHighWater: 0,
  },
  active: {
    mission: {
      missionState: 'first-patrol',
      eligibleMissionKind: 'first-patrol',
      guardianDueCount: 6,
      wobblingDueCount: 2,
      nextGuardianDueDay: GUARDIAN_DAY,
      todayGuardianDay: GUARDIAN_DAY,
      canStartRewardBearing: true,
      canContinueUnrewarded: false,
      campCreditState: 'available',
    },
    mega: 213,
    campHighWater: 3,
  },
  rested: {
    mission: {
      missionState: 'rested',
      eligibleMissionKind: null,
      guardianDueCount: 0,
      wobblingDueCount: 0,
      nextGuardianDueDay: GUARDIAN_DAY + 3,
      todayGuardianDay: GUARDIAN_DAY,
      canStartRewardBearing: false,
      canContinueUnrewarded: false,
      campCreditState: 'available',
    },
    mega: 213,
    campHighWater: 5,
  },
  done: {
    mission: {
      missionState: 'due',
      eligibleMissionKind: 'due',
      guardianDueCount: 4,
      wobblingDueCount: 0,
      nextGuardianDueDay: GUARDIAN_DAY,
      todayGuardianDay: GUARDIAN_DAY,
      canStartRewardBearing: false,
      canContinueUnrewarded: true,
      campCreditState: 'complete-for-today',
    },
    mega: 213,
    campHighWater: 7,
  },
};

const GUARDIAN_PACK_SIZE = 213;

// Realistic set rail — matches the live catalogue shape so Setup paints the
// Vocabulary set picker the real app shows once packs are published.
const VOCABULARY_SETS = [
  { id: 'core', label: 'Core', count: 213 },
  { id: 'y3-4', label: 'Y3–4', count: 109 },
  { id: 'y5-6', label: 'Y5–6', count: 104 },
];

// A pack-sized progress table with an exact Mega count, so the Camp teaser
// meter reads a real number rather than a hard-coded one.
function guardianProgress(mega) {
  return Array.from({ length: GUARDIAN_PACK_SIZE }, (_, index) => {
    const word = WORDS[index % WORDS.length];
    return {
      runtimeItemId: `guardian-${index}`,
      target: word.target,
      stage: index < mega ? 5 : index % 4,
      correct: index < mega ? 9 : 2,
      wrong: index < mega ? 0 : 3,
      lastResult: index < mega ? 'correct' : 'wrong',
    };
  });
}

const SUMMARY = {
  mode: 'smart',
  label: 'Smart Review',
  sessionId: 'session-demo',
  endedEarly: false,
  message: 'Every word in this round is saved on this device.',
  cards: [
    { label: 'Words practised', value: 5, sub: 'All the way through' },
    { label: 'Secured this round', value: 3, sub: 'Two clean recalls each' },
    { label: 'Needed correction', value: 2, sub: 'These words came back again' },
  ],
  totalWords: 5,
  correct: 3,
  accuracy: 78,
  mistakes: [{ slug: 'separate', word: 'separate' }, { slug: 'rhythm', word: 'rhythm' }],
};

function store(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
    set(patch) {
      state = { ...state, ...patch };
      for (const listener of listeners) listener(state);
    },
  };
}

function card(index, mode, extra = {}) {
  const word = WORDS[index % WORDS.length];
  return {
    sessionId: 'session-demo',
    runtimeItemId: `runtime-${index}`,
    label: mode === 'test' ? 'SATs Test'
      : mode === 'trouble' ? 'Trouble Drill'
        : mode === 'guardian' ? 'Guardian Mission' : 'Smart Review',
    mode,
    phase: 'question',
    awaitingAdvance: false,
    sentence: word.sentence,
    cloze: word.cloze,
    target: word.target,
    slug: word.slug,
    feedback: null,
    fallbackToSmart: false,
    progress: { total: 5, done: index, checked: index, wrongCount: 0 },
    ...extra,
  };
}

function makeServices(query) {
  const profiles = [
    { learnerId: 'learner-a', nickname: 'Ada', yearGroup: 'Y4', goal: 10, colour: '#1f6f77', createdAt: 1, updatedAt: 1 },
    { learnerId: 'learner-b', nickname: 'Sam', yearGroup: 'Y6', goal: 15, colour: '#a06b22', createdAt: 2, updatedAt: 2 },
  ];
  const empty = query.has('empty');
  const unfoundCompanion = query.get('unfound-companion') === 'true';
  const controller = store({
    status: 'ready',
    profiles: empty ? [] : profiles,
    selectedLearnerId: 'learner-a',
    actionError: null,
  });
  const audio = store({
    status: query.get('audio') ?? 'ready',
    activeVersion: 'starter-1',
    actionError: null,
  });
  // Unfound Setup paints a band silhouette: Inklet (Y3–4) and Glimmerbug
  // (Y5–6) sleep until their set is selected. Core still falls back to the
  // best found creature, so both band tracks are unmarked when the flag is on.
  const harnessMonsters = empty
    ? []
    : (unfoundCompanion
      ? MONSTERS.map((monster) => (
        monster.monsterId === 'inklet' || monster.monsterId === 'glimmerbug'
          ? { ...monster, caught: false, secureCount: 0, derivedStage: 0, earnedStageHighWater: 0 }
          : monster
      ))
      : MONSTERS);
  const rosterBeforeRound = harnessMonsters.map((monster) => ({
    ...monster,
    secureCount: Math.max(0, (monster.secureCount ?? 0) - 5),
  }));
  const guardian = GUARDIAN_STATES[query.get('guardian')] ?? null;
  const mode = query.get('mode') ?? (guardian ? 'guardian' : 'smart');
  const campHighWater = guardian?.campHighWater ?? 3;
  const wantsSummary = query.get('screen') === 'summary';
  const showsRound = wantsSummary || query.get('screen') === 'practice';
  const learning = store({
    status: 'ready',
    // Results reads what a round changed by comparing the ending state with
    // the round-start baseline, and only on the way in. A deep link to the
    // summary therefore starts on the round and steps forward once mounted,
    // so celebrations and the camp strip paint as they do in the app.
    screen: wantsSummary ? 'practice' : query.get('screen') ?? 'home',
    learnerId: 'learner-a',
    practice: showsRound ? card(2, mode) : null,
    summary: mode === 'guardian'
      ? { ...SUMMARY, mode: 'guardian', label: 'Guardian Mission' }
      : SUMMARY,
    progress: empty ? [] : guardian ? guardianProgress(guardian.mega) : PROGRESS,
    packSize: guardian ? GUARDIAN_PACK_SIZE : 60,
    prefs: { voiceId: 'Iapetus', showCloze: true, autoSpeak: false },
    monsters: harnessMonsters,
    vocabularySets: empty ? [] : VOCABULARY_SETS,
    revisionMission: guardian?.mission ?? null,
    roundBaseline: showsRound
      ? {
        sessionId: 'session-demo',
        monsters: rosterBeforeRound,
        // A Guardian summary is the one place Camp is allowed to rise, so the
        // baseline sits one banner behind the current level.
        camp: guardian
          ? { packId: 'ks2-core', campHighWater: Math.max(0, campHighWater - 1), lastCreditedGuardianDay: null }
          : null,
      }
      : null,
    camp: {
      packId: 'ks2-core',
      campHighWater,
      lastCreditedGuardianDay: guardian?.mission.campCreditState === 'complete-for-today'
        ? GUARDIAN_DAY
        : null,
      canEarnToday: guardian?.mission.canStartRewardBearing ?? false,
    },
    actionError: null,
  });
  const parent = store({
    status: query.get('parent') ?? 'locked',
    biometric: { available: true, type: 'face', enabled: true },
    attemptsRemaining: 5,
    lockedUntil: 0,
    actionError: null,
  });
  const parentProgress = store({
    status: 'ready',
    learners: profiles.map((profile, index) => ({
      ...profile,
      publishedItemCount: 60,
      secureItemCount: 34 - index * 20,
      dueItemCount: 6,
      troubleItemCount: 3,
      correctCount: 51,
      wrongCount: 12,
      accuracyPercent: 81,
      guardianDueCount: 2,
      wobblingDueCount: 1,
      nextGuardianReviewDay: 3,
      recentRevisionSessions: [],
    })),
    actionError: null,
  });
  const commerce = query.get('commerce');
  const parentCommerce = store({
    status: 'ready',
    displayPrice: '£4.99',
    entitlementState: commerce ? 'active' : 'none',
    packState: commerce === 'installed' ? 'installed' : commerce ? 'queued' : 'missing',
    action: null,
    actionError: null,
    downloadProgress: null,
  });

  const advance = () => {
    const state = learning.getState();
    const next = (state.practice?.progress.done ?? 0) + 1;
    if (next >= 5) {
      learning.set({ screen: 'summary', practice: null, summary: SUMMARY });
      return;
    }
    learning.set({ practice: card(next, state.practice.mode) });
  };

  return {
    mode: 'product',
    controller: {
      ...controller,
      async createProfile(draft) {
        controller.set({
          profiles: [...controller.getState().profiles, { ...draft, learnerId: `learner-${Date.now()}` }],
        });
      },
      async editProfile() {},
      async selectProfile() { learning.set({ screen: 'home' }); },
      async removeProfile() {},
      async dispose() {},
    },
    learning: {
      ...learning,
      async selectLearner() { learning.set({ screen: 'profiles' }); },
      showScreen(screen) { learning.set({ screen }); },
      wordMaterial(runtimeItemId) {
        return WORD_MATERIAL[runtimeItemId] ?? null;
      },
      async practiseWord() {
        learning.set({
          screen: 'practice',
          practice: {
            ...card(0, 'single', { progress: { total: 1, done: 0, checked: 0, wrongCount: 0 } }),
            label: 'Word bank practice',
          },
          roundBaseline: {
            sessionId: 'session-demo',
            monsters: rosterBeforeRound,
            camp: null,
          },
        });
      },
      async startRound(options) {
        learning.set({
          screen: 'practice',
          practice: card(0, options?.mode ?? 'smart'),
          roundBaseline: {
            sessionId: 'session-demo',
            monsters: rosterBeforeRound,
            camp: null,
          },
        });
      },
      async startGuardianMission() {
        learning.set({
          screen: 'practice',
          practice: {
            ...card(0, 'guardian'),
            label: 'Guardian Mission',
          },
          summary: { ...SUMMARY, mode: 'guardian', label: 'Guardian Mission' },
          roundBaseline: {
            sessionId: 'session-demo',
            monsters: rosterBeforeRound,
            camp: {
              packId: 'ks2-core',
              campHighWater: Math.max(0, campHighWater - 1),
              lastCreditedGuardianDay: null,
            },
          },
        });
      },
      async submitAnswer(typed) {
        const practice = learning.getState().practice;
        const right = typed.trim().toLowerCase() === practice.target;
        learning.set({
          practice: {
            ...practice,
            awaitingAdvance: right,
            phase: right ? 'question' : 'retry',
            feedback: right
              ? { kind: 'success', headline: 'Correct', answer: practice.target, body: '', footer: 'Two clean recalls secure a word.' }
              : { kind: 'error', headline: 'Not yet', attemptedAnswer: typed, answer: practice.target, body: 'Look at the letters, then type it again.' },
          },
        });
      },
      async continueRound() { advance(); },
      async skipWord() { advance(); },
      async savePrefs(patch) {
        learning.set({ prefs: { ...learning.getState().prefs, ...patch } });
      },
      async endRound() {
        learning.set({
          screen: 'summary',
          practice: null,
          summary: { ...SUMMARY, endedEarly: true },
        });
      },
      async dispose() {},
    },
    audioAvailability: {
      ...audio,
      async refresh() {},
      async recover() { audio.set({ status: 'ready' }); },
      reportPlaybackFailure() {},
      async dispose() {},
    },
    parent: {
      ...parent,
      async setPin() { parent.set({ status: 'unlocked' }); },
      async unlockWithPin() { parent.set({ status: 'unlocked' }); },
      async unlockWithBiometrics() { parent.set({ status: 'unlocked' }); },
      async setBiometricsEnabled() {},
      lock() { parent.set({ status: 'locked' }); },
    },
    parentProgress: { ...parentProgress, async refresh() {}, async dispose() {} },
    parentCommerce: {
      ...parentCommerce,
      async start() {}, async refresh() {}, async purchase() {}, async restore() {},
      // Walks the fifteen shards on a timer so the install meter can be
      // watched moving, which is the only way to judge it before a device.
      async download() {
        for (let completedShards = 0; completedShards <= 15; completedShards += 1) {
          parentCommerce.set({
            status: 'working',
            action: 'download',
            packState: 'downloading',
            downloadProgress: { completedShards, totalShards: 15 },
          });
          await new Promise((resolve) => { setTimeout(resolve, 700); });
        }
        parentCommerce.set({
          status: 'ready',
          action: null,
          packState: 'installed',
          downloadProgress: null,
        });
      },
      async recover() {}, async dispose() {},
    },
    parentAdministration: { async resetLearning() {} },
    audio: { async play() {} },
    haptics: {
      answerCorrect() {},
      celebrationStart() {},
      uiTick() {},
    },
    sfx: {
      play() {},
      noteSpeechStarted() {},
      setEnabled() {},
      isEnabled() { return true; },
      attachGestureUnlock() {},
      dispose() {},
    },
    setSfxEnabled() {},
  };
}

function Harness() {
  const [services] = useState(
    () => makeServices(new URLSearchParams(globalThis.location.search)),
  );
  useEffect(() => {
    const query = new URLSearchParams(globalThis.location.search);
    if (query.get('screen') === 'summary') {
      services.learning.set({ screen: 'summary', practice: null });
    }
    // Setup defaults to Core; band silhouettes only paint on Y3–4 / Y5–6.
    // Click the Y3–4 pill once the rail is up so ?unfound-companion=true is
    // a single deep link rather than a two-step walk.
    if (query.get('unfound-companion') === 'true' && query.get('screen') === 'setup') {
      const pickBand = () => {
        const pill = [...document.querySelectorAll('.setup-pools .pill')]
          .find((button) => button.textContent?.includes('Y3'));
        pill?.click();
      };
      requestAnimationFrame(() => requestAnimationFrame(pickBand));
    }
    // Parent area is presentation state, not a learning screen, so the
    // deep link clicks the same For parents control a grown-up uses.
    if (query.get('open') === 'parent') {
      const openParent = () => {
        const button = [...document.querySelectorAll('button')]
          .find((candidate) => candidate.textContent === 'For parents');
        button?.click();
      };
      requestAnimationFrame(() => requestAnimationFrame(openParent));
    }
    // Listing screenshot 9: keep heading, progress and the privacy preamble.
    // Hide admin/commerce cards so the capture cannot show a price or
    // delete-learner controls.
    if (query.get('capture') === 'parent-listing') {
      const style = document.createElement('style');
      style.textContent = `
        [aria-labelledby="manage-learners-title"],
        [aria-labelledby="parent-security-title"],
        [aria-labelledby="parent-commerce-title"],
        .privacy-notice-section,
        .parent-card details { display: none !important; }
      `;
      document.head.appendChild(style);
    }
  }, [services]);
  return <ProductApp services={services} />;
}

/* The boot surfaces paint before any service exists, so they are mounted
   directly rather than through ProductApp. The recovery screen only has one
   way in — a child that throws — and the error carries a short fixed stack so
   the folded diagnosis has something realistic to lay out. */
const BOOT_FAILURE = new Error('Cannot read properties of null (reading \'learnerId\')');

BOOT_FAILURE.stack = [
  'TypeError: Cannot read properties of null (reading \'learnerId\')',
  '    at TrailScreen (ProductApp.jsx:1462:31)',
  '    at renderWithHooks (react-dom-client.development.js:5529:16)',
  '    at updateFunctionComponent (react-dom-client.development.js:8897:19)',
  '    at beginWork (react-dom-client.development.js:10522:18)',
  '    at runWithFiberInDEV (react-dom-client.development.js:1520:13)',
  '    at performUnitOfWork (react-dom-client.development.js:15133:22)',
].join('\n');

function BootFailure() {
  throw BOOT_FAILURE;
}

function Root() {
  const screen = new URLSearchParams(globalThis.location.search).get('screen');
  if (screen === 'boot-loading') return <AppLoadingShell />;
  if (screen === 'boot-error') {
    return (
      <AppErrorBoundary>
        <BootFailure />
      </AppErrorBoundary>
    );
  }
  return <Harness />;
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
