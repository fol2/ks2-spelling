/* Design harness. Dev-only — never bundled (see vite.design.config.js).
 *
 * Mounts the real ProductApp over in-memory services so every screen can be
 * walked at any viewport in a browser. The spelling engine is deliberately
 * faked: a fixed word list and a "right if you typed the target" rule is
 * enough to reach every visual state, and the real engine is out of scope for
 * design work.
 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ProductApp from '../src/app/ProductApp.jsx';
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
  const rosterBeforeRound = (empty ? [] : MONSTERS).map((monster) => ({
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
    monsters: empty ? [] : MONSTERS,
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
  const parentCommerce = store({
    status: 'ready',
    displayPrice: '£4.99',
    entitlementState: 'none',
    packState: 'missing',
    action: null,
    actionError: null,
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
      async download() {}, async recover() {}, async dispose() {},
    },
    parentAdministration: { async resetLearning() {} },
    parentBackup: {
      async exportBackup() { return { presented: true }; },
      async importBackup() { return { cancelled: true }; },
    },
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
  }, [services]);
  return <ProductApp services={services} />;
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
