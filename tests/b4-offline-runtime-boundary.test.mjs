import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  B4_BUILD_MARKER,
  createB4OfflineBoundary,
} from '../vite.config.js';

test('the B4 bundle denies runtime connections and marks the ordinary native wrapper', () => {
  const plugin = createB4OfflineBoundary('B4Development');
  assert.equal(plugin.name, 'b4-offline-runtime-boundary');
  assert.deepEqual(plugin.transformIndexHtml(), [
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
  ]);
  assert.equal(createB4OfflineBoundary('production'), null);
});

test('both native wrappers disable network-capable plugins for the marked B4 bundle', async () => {
  const [ios, android] = await Promise.all([
    readFile(new URL('../ios/App/App/SceneDelegate.swift', import.meta.url), 'utf8'),
    readFile(new URL(
      '../android/app/src/main/java/uk/eugnel/ks2spelling/MainActivity.java',
      import.meta.url,
    ), 'utf8'),
  ]);

  for (const source of [ios, android]) {
    assert.match(source, /ks2-spelling-build-mode/u);
    assert.match(source, /B4Development/u);
  }
  assert.match(ios, /if !isOfflineB4Bundle\(\)[\s\S]*PackTransferPlugin[\s\S]*CommercePlugin/u);
  assert.match(android, /if \(!isOfflineB4Bundle\(\)\)[\s\S]*PackTransferPlugin[\s\S]*CommercePlugin/u);
});
