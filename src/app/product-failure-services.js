function rejectedAction() {
  return Promise.reject(new Error('product_startup_failed'));
}

function subscription(listener, state) {
  listener(state);
  return Object.freeze({ remove() {} });
}

export function createProductFailureServices() {
  const profileState = Object.freeze({
    status: 'failed',
    profiles: Object.freeze([]),
    selectedLearnerId: null,
    actionError: 'product_startup_failed',
  });
  const audioState = Object.freeze({
    status: 'unavailable',
    activeVersion: null,
    actionError: 'starter_audio_check_failed',
  });
  const learningState = Object.freeze({
    status: 'ready',
    screen: 'profiles',
    learnerId: null,
    practice: null,
    summary: null,
    progress: Object.freeze([]),
    monsters: Object.freeze([]),
    camp: null,
    actionError: 'product_startup_failed',
  });
  const parentState = Object.freeze({
    status: 'locked',
    biometric: Object.freeze({
      available: false,
      type: 'none',
      enabled: false,
    }),
    attemptsRemaining: 0,
    lockedUntil: 0,
    actionError: 'parent_security_unavailable',
  });

  return Object.freeze({
    mode: 'product',
    controller: Object.freeze({
      getState: () => profileState,
      subscribe: (listener) => subscription(listener, profileState),
      createProfile: rejectedAction,
      editProfile: rejectedAction,
      selectProfile: rejectedAction,
      removeProfile: rejectedAction,
      reload: rejectedAction,
      async dispose() {},
    }),
    audioAvailability: Object.freeze({
      getState: () => audioState,
      subscribe: (listener) => subscription(listener, audioState),
      refresh: rejectedAction,
      recover: rejectedAction,
      reportPlaybackFailure() {},
      async dispose() {},
    }),
    learning: Object.freeze({
      getState: () => learningState,
      subscribe: (listener) => subscription(listener, learningState),
      selectLearner: rejectedAction,
      showScreen() {
        throw new Error('product_startup_failed');
      },
      startSmartRound: rejectedAction,
      submitAnswer: rejectedAction,
      continueRound: rejectedAction,
      endRound: rejectedAction,
      async dispose() {},
    }),
    parent: Object.freeze({
      getState: () => parentState,
      subscribe: (listener) => subscription(listener, parentState),
      setPin: rejectedAction,
      unlockWithPin: rejectedAction,
      unlockWithBiometrics: rejectedAction,
      setBiometricsEnabled: rejectedAction,
      lock() {},
      async dispose() {},
    }),
    parentAdministration: Object.freeze({
      resetLearning: rejectedAction,
    }),
    parentBackup: Object.freeze({
      exportBackup: rejectedAction,
      importBackup: rejectedAction,
    }),
    audio: Object.freeze({
      play: rejectedAction,
    }),
  });
}
