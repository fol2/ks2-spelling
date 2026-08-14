import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const B4_BUILD_MARKER = 'B4Development';
const ROOT = dirname(fileURLToPath(import.meta.url));

function isProductReleaseChannel(mode) {
  return mode === 'sandbox' || mode === 'production';
}

export function resolveAppComposition(mode) {
  return resolve(
    ROOT,
    isProductReleaseChannel(mode)
      ? 'src/app/create-production-app-services.js'
      : 'src/app/create-app-services.js',
  );
}

export function createReleaseChannelAuthority(mode) {
  const releaseChannel = mode === 'B3SandboxProof' ? 'sandbox' : mode;
  if (!isProductReleaseChannel(releaseChannel)) return null;
  return {
    name: 'release-channel-authority',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'release-channel.json',
        source: `${JSON.stringify({ releaseChannel })}\n`,
      });
    },
  };
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

// E2.5: the production bundle preloads only the 16 MB Starter audio. The
// full set is entitlement-gated and delivered by download (E2.6), never
// packaged in the binary.
export function createBundledStarterAssets(mode) {
  if (!isProductReleaseChannel(mode)) return null;
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

export function createPrivacyNoticeEmbed() {
  // Inlined at build time. `?raw` is refused by the webview-bundle evidence
  // reader, which only strips `?inline`; a \0 virtual module is already classified.
  const sourceId = 'virtual:privacy-notice';
  const resolvedId = `\0${sourceId}`;
  const noticePath = resolve(ROOT, 'docs/legal/privacy-notice.md');
  return {
    name: 'privacy-notice-embed',
    resolveId(id) {
      if (id === sourceId) return resolvedId;
      return undefined;
    },
    load(id) {
      if (id !== resolvedId) return undefined;
      return `export default ${JSON.stringify(readFileSync(noticePath, 'utf8'))};\n`;
    },
  };
}

export function createBundledArtAssets(mode) {
  if (!isProductReleaseChannel(mode)) return null;
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
    createPrivacyNoticeEmbed(),
    createB4OfflineBoundary(mode),
    createReleaseChannelAuthority(mode),
    createBundledStarterAssets(mode),
    createBundledArtAssets(mode),
  ].filter(Boolean),
  resolve: {
    alias: {
      '@ks2/app-composition': resolveAppComposition(mode),
      '@ks2/app-root': resolve(
        ROOT,
        isProductReleaseChannel(mode)
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
