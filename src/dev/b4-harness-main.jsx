// Dev-only measurement harness: the real B4 UI, controller and audio player
// over an in-memory repository, so seam timings iterate in seconds in a
// desktop browser instead of minutes on a simulator. Never part of a build.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from '../app/App.jsx';
import '../app/app.css';
import '../app/b4-shell.css';
import { createB4LocalAudioPlayer } from '../app/b4-local-audio.js';
import { B4_PRODUCT_IDENTIFIER } from '../app/b4-round-contract.js';
import { createB4DesktopHarness } from './create-b4-desktop-harness.js';

const bridgeMs = Number(new URLSearchParams(location.search).get('bridgeMs')) || 0;
const { controller, targetForCurrentCard } = createB4DesktopHarness({
  bridgeMs,
  playAudio: createB4LocalAudioPlayer(),
});

window.__b4Harness = Object.freeze({
  controller,
  measures: () => performance.getEntriesByType('measure')
    .filter(({ name }) => name.startsWith('b4:'))
    .map(({ name, duration }) => ({ name, duration })),
  targetForCurrentCard,
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App services={Object.freeze({ mode: B4_PRODUCT_IDENTIFIER, controller })} />
  </StrictMode>,
);
