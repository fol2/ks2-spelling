import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const B4_BUILD_MARKER = 'B4Development';
const ROOT = dirname(fileURLToPath(import.meta.url));

export function resolveAppComposition(mode) {
  return resolve(
    ROOT,
    mode === 'production'
      ? 'src/app/create-production-app-services.js'
      : 'src/app/create-app-services.js',
  );
}

export function createB4OfflineBoundary(mode) {
  if (mode !== B4_BUILD_MARKER) return null;
  return {
    name: 'b4-offline-runtime-boundary',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { name: 'ks2-spelling-build-mode', content: B4_BUILD_MARKER },
          injectTo: 'head-prepend',
        },
        {
          tag: 'meta',
          attrs: {
            'http-equiv': 'Content-Security-Policy',
            content: "default-src 'self' capacitor:; connect-src 'none'; img-src 'self' data:; media-src 'self' capacitor:; object-src 'none'; base-uri 'none'; form-action 'self'",
          },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

export function createBundledStarterAssets(mode) {
  if (mode !== 'production') return null;
  return {
    name: 'bundled-starter-assets',
    async writeBundle(outputOptions) {
      const outputRoot = resolve(ROOT, outputOptions.dir ?? 'dist');
      const target = resolve(outputRoot, 'starter/audio');
      await mkdir(dirname(target), { recursive: true });
      await cp(
        resolve(ROOT, 'content/starter-pack/audio'),
        target,
        {
          recursive: true,
          force: false,
          errorOnExist: true,
        },
      );
    },
  };
}

export function createBundledArtAssets(mode) {
  if (mode !== 'production') return null;
  return {
    name: 'bundled-art-assets',
    async writeBundle(outputOptions) {
      const outputRoot = resolve(ROOT, outputOptions.dir ?? 'dist');
      const target = resolve(outputRoot, 'mastery-art');
      await mkdir(dirname(target), { recursive: true });
      await cp(
        resolve(ROOT, 'content/mastery-art'),
        target,
        {
          recursive: true,
          force: false,
          errorOnExist: true,
        },
      );
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    createB4OfflineBoundary(mode),
    createBundledStarterAssets(mode),
    createBundledArtAssets(mode),
  ].filter(Boolean),
  resolve: {
    alias: {
      '@ks2/app-composition': resolveAppComposition(mode),
      '@ks2/app-root': resolve(
        ROOT,
        mode === 'production'
          ? 'src/app/ProductRoot.jsx'
          : 'src/app/App.jsx',
      ),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
}));
