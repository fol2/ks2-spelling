import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  HERO_ART_BASE,
  HERO_CONTRAST_BY_TONE,
  HERO_REGIONS,
  HERO_TONES,
  heroArtUrl,
  heroBgForMode,
  heroPreloadUrlsForMode,
  heroToneForProgress,
  sessionProgressIndex,
} from '../src/app/backdrop-model.js';

const ROOT = resolve(import.meta.dirname, '..');

function contentPathForUrl(url) {
  assert.ok(url.startsWith('/mastery-art/'));
  return resolve(ROOT, 'content', url.slice(1));
}

test('hero tone thirds for a 10-card round mirror mastery arithmetic', () => {
  const total = 10;
  // firstLimit = max(1, floor(10/3)) = 3
  // secondLimit = max(4, floor(20/3)) = 6
  const expectations = [
    [1, '1'], [2, '1'], [3, '1'],
    [4, '2'], [5, '2'], [6, '2'],
    [7, '3'], [8, '3'], [9, '3'], [10, '3'],
  ];

  for (const [card, tone] of expectations) {
    const done = card - 1;
    assert.equal(
      sessionProgressIndex({ done, total }),
      card,
      `card ${card} progress index`,
    );
    assert.equal(
      heroToneForProgress({ done, total }),
      tone,
      `card ${card} → tone ${tone}`,
    );
  }

  assert.equal(
    heroToneForProgress({ done: 10, total }, { complete: true }),
    '3',
  );
  assert.equal(
    heroToneForProgress({ done: 3, total }, { awaitingAdvance: true }),
    '1',
  );
  assert.equal(
    heroToneForProgress({ done: 3, total }, { awaitingAdvance: false }),
    '2',
  );
});

test('heroBgForMode builds a URL for every mode and tone that exists on disk', async () => {
  const modes = Object.keys(HERO_REGIONS);
  assert.deepEqual(modes.sort(), ['smart', 'test', 'trouble']);
  assert.deepEqual([...HERO_TONES], ['1', '2', '3']);
  assert.equal(HERO_ART_BASE, '/mastery-art/regions/the-scribe-downs');

  for (const mode of modes) {
    for (const tone of HERO_TONES) {
      const url = heroBgForMode(mode, { tone });
      assert.match(
        url,
        new RegExp(`/the-scribe-downs-[a-e]${tone}\\.1280\\.webp$`),
      );
      await access(contentPathForUrl(url));
    }

    const preload = heroPreloadUrlsForMode(mode);
    assert.equal(preload.length, HERO_REGIONS[mode].length * 3);
    for (const url of preload) {
      await access(contentPathForUrl(url));
    }
  }

  assert.equal(
    heroBgForMode('smart', { tone: '1' }),
    heroArtUrl('a1'),
  );
  assert.equal(
    heroBgForMode('trouble', { tone: '2' }),
    heroArtUrl('d2'),
  );
  assert.equal(
    heroBgForMode('test', { tone: '3' }),
    heroArtUrl('e3'),
  );
});

test('smart sessions spread across regions a, b and c by seed', async () => {
  const seen = new Set();
  for (let index = 0; index < 24; index += 1) {
    const url = heroBgForMode('smart', { tone: '1', seed: `session-${index}` });
    const match = url.match(/the-scribe-downs-([a-c])1\.1280\.webp$/u);
    assert.ok(match, `smart seed url stays in regions a-c: ${url}`);
    seen.add(match[1]);
    await access(contentPathForUrl(url));
  }
  assert.deepEqual([...seen].sort(), ['a', 'b', 'c']);

  const stable = heroBgForMode('smart', { tone: '2', seed: 'session-fixed' });
  assert.equal(stable, heroBgForMode('smart', { tone: '2', seed: 'session-fixed' }));

  assert.equal(
    heroBgForMode('trouble', { tone: '1', seed: 'session-fixed' }),
    heroArtUrl('d1'),
    'single-region modes ignore the seed',
  );
  assert.equal(
    heroBgForMode('smart', { tone: '1', seed: null }),
    heroArtUrl('a1'),
    'missing seed keeps the lead region',
  );
});

test('hero contrast table covers tones 1–3', () => {
  assert.deepEqual(Object.keys(HERO_CONTRAST_BY_TONE).sort(), ['1', '2', '3']);
  assert.equal(HERO_CONTRAST_BY_TONE[1].shell, 'dark');
  assert.equal(HERO_CONTRAST_BY_TONE[1].controls, 'dark');
  assert.deepEqual([...HERO_CONTRAST_BY_TONE[1].cards], ['dark', 'dark', 'dark']);
  assert.equal(HERO_CONTRAST_BY_TONE[2].shell, 'light');
  assert.equal(HERO_CONTRAST_BY_TONE[3].shell, 'light');
  assert.equal(HERO_CONTRAST_BY_TONE[2].controls, 'light');
  assert.equal(HERO_CONTRAST_BY_TONE[3].controls, 'light');
});
