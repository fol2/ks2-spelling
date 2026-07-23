import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import App from './app/App.jsx';
import './app/app.css';
import {
  createB2AppServices,
  createSelectedAppServices,
  selectNativeAppComposition,
} from './app/create-app-services.js';

const root = document.getElementById('root');

if (!root) throw new Error('KS2 Spelling root element is missing.');

function failureServices(platformRequirement) {
  const state = Object.freeze({
    learnerIsolation: 'not verified',
    status: 'B2 proof needs attention',
  });
  return Object.freeze({
    mode: 'b2-native-proof',
    databaseName: 'ks2-spelling',
    schemaVersion: 1,
    platformRequirement,
    controller: Object.freeze({
      getState: () => state,
      subscribe(listener) {
        listener(state);
        return Object.freeze({ remove() {} });
      },
      start: () => Promise.reject(new Error('b2_native_startup_failed')),
    }),
  });
}

function productFailureServices() {
  const state = Object.freeze({
    status: 'failed',
    profiles: Object.freeze([]),
    selectedLearnerId: null,
    actionError: 'product_startup_failed',
  });
  const rejectAction = () => Promise.reject(
    new Error('product_startup_failed'),
  );
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
  return Object.freeze({
    mode: 'product',
    controller: Object.freeze({
      getState: () => state,
      subscribe(listener) {
        listener(state);
        return Object.freeze({ remove() {} });
      },
      createProfile: rejectAction,
      editProfile: rejectAction,
      selectProfile: rejectAction,
      removeProfile: rejectAction,
      async dispose() {},
    }),
    audioAvailability: Object.freeze({
      getState: () => audioState,
      subscribe(listener) {
        listener(audioState);
        return Object.freeze({ remove() {} });
      },
      refresh: rejectAction,
      recover: rejectAction,
      reportPlaybackFailure() {},
      async dispose() {},
    }),
    learning: Object.freeze({
      getState: () => learningState,
      subscribe(listener) {
        listener(learningState);
        return Object.freeze({ remove() {} });
      },
      selectLearner: rejectAction,
      showScreen() {
        throw new Error('product_startup_failed');
      },
      startSmartRound: rejectAction,
      submitAnswer: rejectAction,
      continueRound: rejectAction,
      endRound: rejectAction,
      async dispose() {},
    }),
    audio: Object.freeze({
      play: rejectAction,
    }),
  });
}

async function bootstrap() {
  let services;
  if (Capacitor.isNativePlatform()) {
    const composition = selectNativeAppComposition({
      buildMode: import.meta.env.MODE,
      platform: Capacitor.getPlatform(),
    });
    if (composition.serviceMode === 'product') {
      try {
        services = await createSelectedAppServices({
          buildMode: import.meta.env.MODE,
          isNativePlatform: true,
          platform: Capacitor.getPlatform(),
        });
      } catch {
        services = productFailureServices();
      }
    } else if (
      composition.serviceMode === 'b3' ||
      composition.serviceMode === 'b4'
    ) {
      services = await createSelectedAppServices({
        buildMode: import.meta.env.MODE,
        isNativePlatform: true,
        platform: Capacitor.getPlatform(),
      });
    } else {
      try {
        services = await createB2AppServices();
      } catch {
        services = failureServices('Native proof unavailable');
      }
    }
  } else {
    services = await createSelectedAppServices({
      buildMode: import.meta.env.MODE,
      isNativePlatform: false,
      platform: 'web',
    }) ?? failureServices('Native platform required');
  }
  if (typeof services.dispose === 'function') {
    window.addEventListener(
      'pagehide',
      () => void services.dispose().catch(() => undefined),
      { once: true },
    );
  }
  createRoot(root).render(
    <StrictMode>
      <App services={services} />
    </StrictMode>,
  );
}

void bootstrap();
