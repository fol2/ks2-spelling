// Dev-only measurement harness: the real B4 UI, controller and audio player
// over an in-memory repository, so seam timings iterate in seconds in a
// desktop browser instead of minutes on a simulator. Never part of a build.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from '../app/App.jsx';
import '../app/app.css';
import '../app/b4-shell.css';
import manifest from '../../config/b4-audio-manifest.json';
import { createB4RoundController } from '../app/b4-round-controller.js';
import { createB4LocalAudioPlayer } from '../app/b4-local-audio.js';
import {
  B4_PRODUCT_IDENTIFIER,
  B4_START_TIMESTAMP,
  commitB4CommandPlan,
  createB4LearnerSnapshot,
  loadB4SpellingCatalogue,
} from '../app/b4-round-contract.js';

const bridgeMs = Number(new URLSearchParams(location.search).get('bridgeMs')) || 0;

let snapshot = createB4LearnerSnapshot();

function commitPlan(plan) {
  snapshot = commitB4CommandPlan(snapshot, plan);
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
