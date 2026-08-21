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
  loadB4SpellingCatalogue,
} from '../app/b4-round-contract.js';
import { createB4HarnessRepository } from './b4-harness-repository.js';

const bridgeMs = Number(new URLSearchParams(location.search).get('bridgeMs')) || 0;
const { repository, snapshotStore } = createB4HarnessRepository({ bridgeMs });

const controller = createB4RoundController({
  catalogue: loadB4SpellingCatalogue(),
  repository,
  snapshotStore,
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
