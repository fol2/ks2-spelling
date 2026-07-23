import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import App from '@ks2/app-root';
import AppLoadingShell from './app/AppLoadingShell.jsx';
import './app/app.css';
import {
  createB2AppServices,
  createSelectedAppServices,
  selectNativeAppComposition,
} from '@ks2/app-composition';
import {
  createProductFailureServices,
} from './app/product-failure-services.js';
import { mountApp } from './app/mount-app.js';

const root = document.getElementById('root');

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

async function createServices() {
  if (Capacitor.isNativePlatform()) {
    const composition = selectNativeAppComposition({
      buildMode: import.meta.env.MODE,
      platform: Capacitor.getPlatform(),
    });
    if (composition.serviceMode === 'product') {
      try {
        return await createSelectedAppServices({
          buildMode: import.meta.env.MODE,
          isNativePlatform: true,
          platform: Capacitor.getPlatform(),
        });
      } catch {
        return createProductFailureServices();
      }
    }
    if (
      composition.serviceMode === 'b3' ||
      composition.serviceMode === 'b4'
    ) {
      return createSelectedAppServices({
        buildMode: import.meta.env.MODE,
        isNativePlatform: true,
        platform: Capacitor.getPlatform(),
      });
    }
    try {
      return await createB2AppServices();
    } catch {
      return failureServices('Native proof unavailable');
    }
  }
  return await createSelectedAppServices({
    buildMode: import.meta.env.MODE,
    isNativePlatform: false,
    platform: 'web',
  }) ?? failureServices('Native platform required');
}

void mountApp({
  root,
  createRoot,
  createServices,
  renderLoading: () => (
    <StrictMode>
      <AppLoadingShell />
    </StrictMode>
  ),
  renderApp: (services) => (
    <StrictMode>
      <App services={services} />
    </StrictMode>
  ),
  onPageHide: (listener, options) => {
    window.addEventListener('pagehide', listener, options);
  },
});
