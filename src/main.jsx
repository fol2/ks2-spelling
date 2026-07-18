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

async function bootstrap() {
  let services;
  if (Capacitor.isNativePlatform()) {
    const composition = selectNativeAppComposition({
      buildMode: import.meta.env.MODE,
      platform: Capacitor.getPlatform(),
    });
    if (composition.serviceMode === 'b3') {
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
