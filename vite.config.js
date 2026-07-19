import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export const B4_BUILD_MARKER = 'B4Development';

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

export default defineConfig(({ mode }) => ({
  plugins: [react(), createB4OfflineBoundary(mode)].filter(Boolean),
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
}));
