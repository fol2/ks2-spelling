import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));

async function readSource(relativePath) {
  return readFile(join(root, relativePath), 'utf8');
}

function sliceFunction(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `${startMarker} must exist`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `${endMarker} must follow ${startMarker}`);
  return source.slice(start, end);
}

test('dictation RoundScreen has no pressable mute and keeps replay plus autoplay', async () => {
  const productApp = await readSource('src/app/ProductApp.jsx');
  const roundScreen = sliceFunction(
    productApp,
    'function RoundScreen({',
    '\nfunction ResultsScreen({',
  );

  assert.match(
    roundScreen,
    /<div className="listen-row" aria-label="Listening controls">/u,
  );
  assert.match(
    roundScreen,
    /Hear it again[\s\S]*?aria-label="Replay slowly"/u,
  );
  assert.match(roundScreen, /void play\('sentence'\)/u);
  assert.match(roundScreen, /void play\('slow-sentence'\)/u);
  assert.match(
    roundScreen,
    /useEffect\(\(\) => \{\s*if \(!audioRequest \|\| audioState\.status !== 'ready'\) return;\s*void play\('sentence'\);/u,
  );

  assert.doesNotMatch(roundScreen, /Sound effects/u);
  assert.doesNotMatch(roundScreen, /setup-sfx/u);
  assert.doesNotMatch(roundScreen, /onSetSfxEnabled/u);
  assert.doesNotMatch(roundScreen, /setSfxEnabled/u);
  assert.doesNotMatch(roundScreen, /role="switch"/u);
  assert.doesNotMatch(roundScreen, /aria-label="Mute"/iu);
  assert.doesNotMatch(
    roundScreen,
    /IconMute|volumeOff|volume-off|soundOff/u,
  );
});

test('Setup no longer exposes a child-facing Sound effects mute switch', async () => {
  const productApp = await readSource('src/app/ProductApp.jsx');
  const setupScreen = sliceFunction(
    productApp,
    'function SetupScreen({',
    '\nfunction RoundScreen({',
  );

  assert.doesNotMatch(setupScreen, /Sound effects/u);
  assert.doesNotMatch(setupScreen, /setup-sfx/u);
  assert.doesNotMatch(setupScreen, /onSetSfxEnabled/u);
  assert.doesNotMatch(setupScreen, /role="switch"/u);
  assert.doesNotMatch(productApp, /onSetSfxEnabled=/u);
});

test('product SFX starts enabled and is not gated by a stored Off preference', async () => {
  const services = await readSource('src/app/create-product-app-services.js');
  assert.match(
    services,
    /sfx = options\.sfx \?\? createSfxEngine\(\{[\s\S]*?initiallyEnabled: true,/u,
  );
  assert.doesNotMatch(
    services,
    /initiallyEnabled: soundPrefs\?\.sfxEnabled !== false/u,
  );
});
