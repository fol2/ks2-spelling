/* The sheet cue fires on the dismiss-snap only — scrim tap stays silent, and
   there is no mount-time cue (a cold-launch gesture-lock would swallow it).
   Tier 'ui' ducks under speech by the existing sfxGateDecision. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFile(join(ROOT, path), 'utf8');

test('SwitchScreen dismiss-snap plays sheet.wav once, in haptic-then-cue order', async () => {
  const source = await read('src/app/ProductApp.jsx');

  const playMatches = source.match(/sfx\?\.play\('sheet'\)/g) ?? [];
  assert.equal(
    playMatches.length,
    1,
    "exactly one sfx?.play('sheet') must exist in ProductApp.jsx",
  );

  assert.match(
    source,
    /haptics\?\.uiTick\?\.\(\);\s*\n\s*sfx\?\.play\('sheet'\);\s*\n\s*onDismiss\(\);/,
    'dismiss-snap must tick haptics, play sheet, then dismiss — in that order',
  );

  assert.match(
    source,
    /useSheetDrag\(onDismiss, haptics, sfx\)/,
    'SwitchScreen must pass sfx into useSheetDrag',
  );

  assert.match(
    source,
    /<SwitchScreen[\s\S]*?sfx=\{services\.sfx\}/,
    'SwitchScreen instantiation must wire services.sfx',
  );
});
