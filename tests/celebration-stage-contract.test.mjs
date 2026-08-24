import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  celebrationArtPresentation,
  celebrationStageDecision,
} from '../src/app/celebrations/celebration-model.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('celebrationStageDecision is live only for caught/evolve with all guards clear', () => {
  assert.equal(
    celebrationStageDecision({ kind: 'caught' }),
    'live',
  );
  assert.equal(
    celebrationStageDecision({ kind: 'evolve' }),
    'live',
  );
  assert.equal(
    celebrationStageDecision({
      kind: 'caught',
      reducedMotion: false,
      contextLost: false,
      backgrounded: false,
    }),
    'live',
  );
  assert.equal(
    celebrationStageDecision({
      kind: 'evolve',
      reducedMotion: false,
      contextLost: false,
      backgrounded: false,
    }),
    'live',
  );

  assert.equal(celebrationStageDecision({ kind: 'progress' }), 'static');
  assert.equal(celebrationStageDecision({ kind: 'camp-level' }), 'static');
  assert.equal(celebrationStageDecision({ kind: 'other' }), 'static');
  assert.equal(celebrationStageDecision({}), 'static');
  assert.equal(celebrationStageDecision(), 'static');
  assert.equal(celebrationStageDecision({ kind: null }), 'static');

  for (const kind of ['caught', 'evolve']) {
    assert.equal(
      celebrationStageDecision({ kind, reducedMotion: true }),
      'static',
    );
    assert.equal(
      celebrationStageDecision({ kind, contextLost: true }),
      'static',
    );
    assert.equal(
      celebrationStageDecision({ kind, backgrounded: true }),
      'static',
    );
    assert.equal(
      celebrationStageDecision({
        kind,
        reducedMotion: true,
        contextLost: true,
        backgrounded: true,
      }),
      'static',
    );
  }

  assert.equal(
    celebrationStageDecision({
      kind: 'progress',
      reducedMotion: false,
      contextLost: false,
      backgrounded: false,
    }),
    'static',
  );
  assert.equal(
    celebrationStageDecision({
      kind: 'camp-level',
      reducedMotion: false,
      contextLost: false,
      backgrounded: false,
    }),
    'static',
  );
});

test('celebrationArtPresentation keeps static art visible until the live canvas is ready', () => {
  assert.deepEqual(
    celebrationArtPresentation({ stageMode: 'static', liveStageReady: false }),
    { staticArt: 'visible', liveCanvas: 'absent' },
  );
  assert.deepEqual(
    celebrationArtPresentation({ stageMode: 'live', liveStageReady: false }),
    { staticArt: 'visible', liveCanvas: 'loading' },
  );
  assert.deepEqual(
    celebrationArtPresentation({ stageMode: 'live', liveStageReady: true }),
    { staticArt: 'hidden', liveCanvas: 'visible' },
  );
});

test('celebrationArtPresentation ignores a ready live stage when the mode is not live', () => {
  assert.deepEqual(
    celebrationArtPresentation({ stageMode: 'static', liveStageReady: true }),
    { staticArt: 'visible', liveCanvas: 'absent' },
  );
});

test('static and live celebration art are never both visible', () => {
  const inputs = [
    { stageMode: 'static', liveStageReady: false },
    { stageMode: 'static', liveStageReady: true },
    { stageMode: 'live', liveStageReady: false },
    { stageMode: 'live', liveStageReady: true },
  ];
  for (const input of inputs) {
    const art = celebrationArtPresentation(input);
    assert.notEqual(
      `${art.staticArt}+${art.liveCanvas}`,
      'visible+visible',
      `both art layers visible for ${JSON.stringify(input)} → ${JSON.stringify(art)}`,
    );
  }
});

test('progress, reduced-motion, backgrounded and context-lost celebrations keep static art only', () => {
  const fallbackModes = [
    celebrationStageDecision({ kind: 'progress' }),
    celebrationStageDecision({ kind: 'camp-level' }),
    celebrationStageDecision({ kind: 'caught', reducedMotion: true }),
    celebrationStageDecision({ kind: 'evolve', reducedMotion: true }),
    celebrationStageDecision({ kind: 'caught', backgrounded: true }),
    celebrationStageDecision({ kind: 'evolve', backgrounded: true }),
    celebrationStageDecision({ kind: 'caught', contextLost: true }),
    celebrationStageDecision({ kind: 'evolve', contextLost: true }),
  ];
  for (const stageMode of fallbackModes) {
    assert.equal(stageMode, 'static');
    for (const liveStageReady of [false, true]) {
      assert.deepEqual(
        celebrationArtPresentation({ stageMode, liveStageReady }),
        { staticArt: 'visible', liveCanvas: 'absent' },
      );
    }
  }
});

test('CelebrationLayer splits CelebrationStage behind React.lazy', async () => {
  const source = await readFile(
    join(ROOT, 'src/app/celebrations/CelebrationLayer.jsx'),
    'utf8',
  );
  assert.match(
    source,
    /lazy\(\s*\(\)\s*=>\s*import\(\s*['"]\.\/CelebrationStage\.jsx['"]\s*\)\s*\)/u,
    'CelebrationStage must load via React.lazy(() => import(...)) to keep phaser in its shared chunk',
  );
  assert.match(source, /<Suspense\s+fallback=\{null\}>/u);
  assert.match(source, /celebrationStageDecision\(/u);
  assert.match(source, /className="celebration-art"/u);
});

test('celebration-scene factory takes Phaser as an argument with no top-level import', async () => {
  const source = await readFile(
    join(ROOT, 'src/app/celebrations/celebration-scene.js'),
    'utf8',
  );
  assert.match(source, /export function createCelebrationScene\s*\(\s*Phaser\s*,/u);
  assert.doesNotMatch(source, /^import\s+.*['"]phaser['"]/mu);
  assert.doesNotMatch(source, /from\s+['"]phaser['"]/u);
  assert.match(source, /from ['"]\.\.\/monster-stage\/stage-fx\.js['"]/u);
  // The live evolution keeps all three shared primitives and takes its schedule
  // from the same beat model the stylesheet mirrors.
  assert.match(source, /spawnBurst\(/u);
  assert.match(source, /glowPulse\(/u);
  assert.match(source, /shockwaveRing\(/u);
  assert.match(source, /celebrationBeats\(/u);
  assert.match(source, /beats\.shockwave/u);
  assert.match(source, /beats\.reveal/u);
});

test('the evolve card opens as a silhouette and clears it at the reveal beat', async () => {
  const styles = await readFile(
    join(ROOT, 'src/app/celebrations/celebrations.css'),
    'utf8',
  );

  assert.match(
    styles,
    /\.celebration-evolve \.celebration-art \{[^}]*celebrationSilhouetteReveal/u,
    'the evolve art must run the silhouette keyframe',
  );
  assert.match(
    styles,
    /@keyframes celebrationSilhouetteReveal \{[\s\S]*?brightness\(0\)/u,
    'the silhouette must open at brightness(0)',
  );
  assert.match(styles, /delays mirror celebrationBeats/u);

  const reduce = styles.lastIndexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(reduce > 0, 'celebrations.css must keep its reduce block');
  const kill = styles.slice(reduce);
  assert.match(kill, /animation: none !important;/u);
  for (const selector of [
    '.celebration-art',
    '.celebration-part',
    '.celebration-eyebrow',
    '.celebration-headline',
    '.celebration-stage-label',
    '.celebration-body',
    '.celebration-meter',
  ]) {
    assert.ok(
      kill.includes(`${selector},`),
      `${selector} must be inside the reduced-motion kill list`,
    );
  }
  // Reduced motion must never be left holding a black square where the art is.
  assert.doesNotMatch(kill, /brightness\(0\)/u);
  assert.match(
    kill,
    /\.celebration-evolve \.celebration-art \{[^}]*filter:[^}]*drop-shadow/u,
  );
});

test('CelebrationStage destroys on background and unmount and blocks pointer events', async () => {
  const source = await readFile(
    join(ROOT, 'src/app/celebrations/CelebrationStage.jsx'),
    'utf8',
  );
  assert.match(source, /game\.destroy\(\s*true\s*\)/u);
  assert.match(source, /backgrounded|!visible|visible/u);
  assert.match(source, /aria-hidden=["']true["']/u);
  assert.match(source, /pointerEvents:\s*['"]none['"]/u);
  assert.match(source, /import\(['"]phaser['"]\)/u);
  assert.match(source, /createCelebrationScene/u);
  assert.match(
    source,
    /resolution:\s*Math\.min\([\s\S]*?,\s*2\)/u,
  );
});

test('stage-fx is shared by celebration-scene and monster-scene', async () => {
  const [fx, celebration, monster] = await Promise.all([
    readFile(join(ROOT, 'src/app/monster-stage/stage-fx.js'), 'utf8'),
    readFile(join(ROOT, 'src/app/celebrations/celebration-scene.js'), 'utf8'),
    readFile(join(ROOT, 'src/app/monster-stage/monster-scene.js'), 'utf8'),
  ]);

  assert.match(fx, /export function spawnBurst/u);
  assert.match(fx, /export function glowPulse/u);
  assert.match(fx, /export function shockwaveRing/u);
  assert.match(fx, /export function twinkleSparks/u);
  assert.match(celebration, /from ['"]\.\.\/monster-stage\/stage-fx\.js['"]/u);
  assert.match(monster, /from ['"]\.\/stage-fx\.js['"]/u);
  assert.match(celebration, /spawnBurst\(/u);
  assert.match(monster, /spawnBurst\(/u);
});

test('CelebrationLayer calls celebrationArtPresentation and hands off through data-live-art', async () => {
  const source = await readFile(
    join(ROOT, 'src/app/celebrations/CelebrationLayer.jsx'),
    'utf8',
  );
  assert.match(source, /celebrationArtPresentation\(/u);
  assert.match(
    source,
    /<span\s+className="celebration-stage"[^>]*data-live-art=\{/u,
  );
  assert.match(source, /onReady=/u);
  assert.match(source, /onContextLost=/u);
  assert.match(
    source,
    /celebrationStageDecision\(\{[\s\S]*?contextLost,/u,
    'context loss must flow into celebrationStageDecision, not a hardcoded false',
  );
  assert.doesNotMatch(
    source,
    /celebrationStageDecision\(\{[\s\S]*?contextLost:\s*false/u,
  );
  assert.match(
    source,
    /\{artUrl && \(/u,
    'the static img must stay mounted whenever artUrl exists',
  );
  assert.match(source, /stageMode === 'live' && artUrl/u);
  assert.match(
    source,
    /readyKey === eventKey/u,
    'live ready must be keyed to the current card so a queue advance cannot hide the new img for a frame',
  );
  assert.match(source, /lostKey === eventKey/u);
  assert.match(source, /data-static-art=\{art\.staticArt\}/u);
  assert.doesNotMatch(
    source,
    /setLiveStageReady\(false\)/u,
    'do not reset live ready in an effect after paint — that leaves a blank frame on caught→evolve',
  );
});

test('CelebrationLayer does not play SFX or haptics inside the live-stage ready callback', async () => {
  const source = await readFile(
    join(ROOT, 'src/app/celebrations/CelebrationLayer.jsx'),
    'utf8',
  );
  const readyProp = source.match(/onReady=\{([^\n}]+)\}/u);
  assert.ok(readyProp, 'CelebrationStage must receive onReady');
  assert.doesNotMatch(readyProp[1], /sfx|haptics|play\(/u);

  const sfxEffect = source.match(
    /useEffect\(\(\) => \{[\s\S]*?sfx\?\.play\([\s\S]*?\}, \[([^\]]*)\]\)/u,
  );
  assert.ok(sfxEffect, 'SFX must stay on the existing event-key effect');
  assert.doesNotMatch(sfxEffect[1], /liveStageReady|onReady/u);
  assert.match(sfxEffect[1], /eventKey/u);

  const name = readyProp[1].trim();
  if (/^[A-Za-z_][\w]*$/u.test(name)) {
    const start = source.search(new RegExp(
      String.raw`(?:const ${name}\s*=|function ${name}\s*\()`,
      'u',
    ));
    assert.ok(start >= 0, `${name} must be defined in the layer`);
    assert.doesNotMatch(source.slice(start, start + 500), /sfx|haptics/u);
  }
});

test('CSS hides static celebration art only after the live canvas is ready, without collapsing layout', async () => {
  const styles = await readFile(
    join(ROOT, 'src/app/celebrations/celebrations.css'),
    'utf8',
  );
  const hideAt = styles.search(
    /\.celebration-stage\[data-live-art=['"]ready['"]\]/u,
  );
  assert.ok(
    hideAt >= 0,
    'ready live art must hide .celebration-art via a data-live-art rule',
  );
  const hide = styles.slice(hideAt, styles.indexOf('}', hideAt) + 1);
  assert.match(hide, /visibility:\s*hidden/u);
  assert.doesNotMatch(hide, /display:\s*none/u);
  assert.match(
    styles,
    /\.celebration-stage:has\(\.celebration-canvas\[data-ready=['"]true['"]\]\)\s+\.celebration-art/u,
    'canvas data-ready must hide the static img in the same paint as the sprite',
  );
  assert.match(
    styles,
    /\.celebration-art\[data-static-art=['"]hidden['"]\]/u,
    'the presentation staticArt flag must also hide the img',
  );
});

test('CelebrationStage reports ready and context loss through refs so Phaser does not reboot', async () => {
  const source = await readFile(
    join(ROOT, 'src/app/celebrations/CelebrationStage.jsx'),
    'utf8',
  );
  assert.match(source, /onReadyRef/u);
  assert.match(source, /onContextLostRef/u);
  assert.match(source, /onReadyRef\.current/u);
  assert.match(source, /onContextLostRef\.current/u);

  const boot = source.match(
    /useEffect\(\(\) => \{[\s\S]*?new Phaser\.Game\([\s\S]*?\}, \[([\s\S]*?)\]\)/u,
  );
  assert.ok(boot, 'must find the Phaser boot effect');
  assert.doesNotMatch(
    boot[1],
    /\bonReady\b/u,
    'onReady must not be a Phaser boot dependency — a new lambda would destroy the game every render',
  );
  assert.doesNotMatch(boot[1], /\bonContextLost\b/u);
});

test('the first painted celebration sprite covers the static art instead of rising from below at alpha 0', async () => {
  const source = await readFile(
    join(ROOT, 'src/app/celebrations/celebration-scene.js'),
    'utf8',
  );
  const playCaught = source.match(/playCaught\(\) \{([\s\S]*?)\n    \}/u);
  assert.ok(playCaught, 'playCaught must exist');
  assert.doesNotMatch(
    playCaught[1],
    /setAlpha\(\s*0\s*\)/u,
    'playCaught must not hide the covering frame at alpha 0',
  );
  assert.doesNotMatch(
    playCaught[1],
    /riseFrom/u,
    'playCaught must not replay a rise-from-below after the static img hands off',
  );

  const evolveAt = source.indexOf('playEvolve() {');
  assert.ok(evolveAt >= 0, 'playEvolve must exist');
  const playEvolve = source.slice(evolveAt, source.indexOf('startShimmer() {', evolveAt));
  assert.doesNotMatch(
    playEvolve,
    /setAlpha\(\s*0\s*\)/u,
    'playEvolve must not open the covering frame at alpha 0',
  );
  assert.match(
    playEvolve,
    /beats\.silhouette/u,
    'the live evolve must still run the silhouette beat after the covering frame',
  );
  assert.match(
    playEvolve,
    /setTint\(\s*0x000000\s*\)/u,
    'the live evolve must still blacken the covering sprite on the silhouette beat',
  );
  assert.match(playEvolve, /clearTint\(/u);
  assert.match(source, /textures\.exists\(/u);
  assert.match(source, /this\.sprite\.width/u);
  assert.match(source, /this\.sprite\.height/u);
});
