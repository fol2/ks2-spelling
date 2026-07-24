// Dev-only measurement harness: the real B4 UI, controller and audio player
// over an in-memory repository, so seam timings iterate in seconds in a
// desktop browser instead of minutes on a simulator. Never part of a build.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from '../app/App.jsx';
import '../app/app.css';
import manifest from '../../config/b4-audio-manifest.json';
import { createB4RoundController } from '../app/b4-round-controller.js';
import { createB4LocalAudioPlayer } from '../app/b4-local-audio.js';
import {
  B4_PRODUCT_IDENTIFIER,
  B4_START_TIMESTAMP,
  loadB4SpellingCatalogue,
} from '../app/b4-round-contract.js';
import {
  loadStarterSpellingCatalogue,
  validateSpellingCommandSnapshotV1,
} from '../domain/spelling/index.js';

const bridgeMs = Number(new URLSearchParams(location.search).get('bridgeMs')) || 0;

function freshSnapshot() {
  return validateSpellingCommandSnapshotV1({
    schemaVersion: 1,
    learnerId: 'learner-a',
    revision: 0,
    packId: 'ks2-core',
    catalogueId: 'ks2-core:starter',
    grantedEntitlementIds: [],
    subjectState: {
      ui: {},
      data: {
        prefs: { autoSpeak: false },
        progress: {},
        guardianMap: {},
        pattern: { wobblingByRuntimeItemId: {} },
        postMega: null,
        achievements: {},
        persistenceWarning: null,
      },
    },
    practiceSession: null,
    eventLog: [],
    monsterStateByRewardTrackId: {},
    campStateByPackId: {},
  }, loadStarterSpellingCatalogue());
}

let snapshot = freshSnapshot();

function commitPlan(plan) {
  snapshot = validateSpellingCommandSnapshotV1({
    ...structuredClone(snapshot),
    revision: plan.nextRevision,
    subjectState: plan.nextSubjectState,
    practiceSession: plan.nextPracticeSession,
    eventLog: plan.nextEventLog,
    monsterStateByRewardTrackId: plan.nextMonsterStateByRewardTrackId,
    campStateByPackId: plan.nextCampStateByPackId,
  }, loadStarterSpellingCatalogue());
}

const wait = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : null);

const repository = {
  async runCommandTransaction(_learnerId, planner) {
    await wait(bridgeMs);
    const plan = planner(structuredClone(snapshot), {
      nowMs: B4_START_TIMESTAMP + snapshot.revision,
    });
    commitPlan(plan);
    return plan;
  },
};

const controller = createB4RoundController({
  catalogue: loadB4SpellingCatalogue(),
  repository,
  snapshotStore: {
    async read() {
      await wait(bridgeMs);
      return structuredClone(snapshot);
    },
  },
  audioManifest: manifest,
  playAudio: createB4LocalAudioPlayer(),
});

window.__b4Harness = Object.freeze({
  controller,
  measures: () => performance.getEntriesByType('measure')
    .filter(({ name }) => name.startsWith('b4:'))
    .map(({ name, duration }) => ({ name, duration })),
  targetForCurrentCard: () => {
    const { currentRuntimeItemId } = controller.getState();
    return loadB4SpellingCatalogue().items
      .find(({ runtimeItemId }) => runtimeItemId === currentRuntimeItemId)?.target ?? null;
  },
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App services={Object.freeze({ mode: B4_PRODUCT_IDENTIFIER, controller })} />
  </StrictMode>,
);
