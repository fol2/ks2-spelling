/* First run is its own composition (#110).

   The reference-layout row the authority makes gating —
   "First run | Welcome and local learner setup | Local-data reassurance | Add
   learner" — asks for three things the learner picker cannot carry when there
   are no learners to pick between. Before this, first run *was* the picker: the
   same bottom sheet with the list absent, no product name, no welcome, and the
   reassurance reduced to one 12px caption.

   These assertions render the real router, so removing the first-run branch
   turns them red rather than leaving them measuring a screen nothing reaches.
*/
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createServer } from 'vite';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFile(join(ROOT, path), 'utf8');

/* The Home Screen name Apple ships. The welcome must name the product the
   parent tapped, so the two are read from one source and compared. */
async function shippedDisplayName() {
  const plist = await read('ios/App/App/Info.plist');
  const match = plist.match(
    /<key>CFBundleDisplayName<\/key>\s*<string>([^<]+)<\/string>/u,
  );
  assert.ok(match, 'Info.plist must declare CFBundleDisplayName');
  return match[1];
}

function stubServices({ profiles }) {
  const store = (state) => Object.freeze({
    getState: () => state,
    subscribe: () => Object.freeze({ remove() {} }),
  });
  const profileState = Object.freeze({
    status: 'ready',
    profiles: Object.freeze(profiles),
    selectedLearnerId: profiles[0]?.learnerId ?? null,
    actionError: null,
  });
  const learningState = Object.freeze({
    status: 'ready',
    screen: 'profiles',
    learnerId: profiles[0]?.learnerId ?? null,
    practice: null,
    summary: null,
    progress: Object.freeze([]),
    vocabularySets: Object.freeze([]),
    monsters: Object.freeze([]),
    packSize: 20,
    revisionMission: null,
    camp: Object.freeze({
      packId: 'ks2-core',
      campHighWater: 0,
      lastCreditedGuardianDay: null,
      canEarnToday: false,
    }),
    actionError: null,
  });
  return Object.freeze({
    mode: 'product',
    controller: Object.freeze({
      ...store(profileState),
      async createProfile() {},
      async editProfile() {},
      async selectProfile() {},
      async removeProfile() {},
    }),
    learning: Object.freeze({
      ...store(learningState),
      showScreen() {},
      async selectLearner() {},
      async startRound() {},
      async startGuardianMission() {},
    }),
    audioAvailability: Object.freeze({
      ...store(Object.freeze({
        status: 'ready',
        activeVersion: '1.0.0',
        actionError: null,
      })),
      async refresh() {},
      async recover() {},
      reportPlaybackFailure() {},
    }),
    parent: Object.freeze({
      ...store(Object.freeze({
        status: 'locked',
        biometric: Object.freeze({ available: false, type: 'none', enabled: false }),
        attemptsRemaining: 5,
        lockedUntil: 0,
        actionError: null,
      })),
      lock() {},
    }),
    parentProgress: Object.freeze({
      ...store(Object.freeze({
        status: 'ready',
        learners: Object.freeze([]),
        actionError: null,
      })),
      async refresh() {},
    }),
    parentCommerce: Object.freeze({
      ...store(Object.freeze({
        status: 'ready',
        displayPrice: '£9.99',
        entitlementState: 'none',
        packState: 'missing',
        action: null,
        actionError: null,
      })),
      async start() {},
      async refresh() {},
      async recover() {},
    }),
    parentAdministration: Object.freeze({ async resetLearning() {} }),
    audio: Object.freeze({ async play() {} }),
    haptics: Object.freeze({ uiTick() {} }),
    sfx: Object.freeze({ play() {}, isEnabled: () => true }),
    setSfxEnabled() {},
  });
}

const ADA = Object.freeze({
  learnerId: 'learner-a',
  nickname: 'Ada',
  yearGroup: 'Y4',
  goal: 10,
  colour: '#1f6f77',
  createdAt: 1,
  updatedAt: 1,
});

test('first run is a distinct composition, not the learner picker minus a row', async (t) => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const vite = await createServer({
    configFile: join(ROOT, 'vite.config.js'),
    server: { middlewareMode: true },
    appType: 'custom',
  });
  t.after(() => vite.close());

  const { default: App } = await vite.ssrLoadModule('/src/app/App.jsx');
  const render = (profiles) => renderToStaticMarkup(
    React.createElement(App, { services: stubServices({ profiles }) }),
  );

  const firstRun = render([]);
  const picker = render([ADA]);

  /* The router, not just the component: an empty roster must reach first run. */
  assert.match(firstRun, /class="[^"]*first-run-scene/u);
  assert.doesNotMatch(
    firstRun,
    /switch-sheet|Who is practising\?/u,
    'first run must not be the learner-picker sheet',
  );

  /* …and a populated roster must still reach the picker. */
  assert.match(picker, /switch-sheet/u);
  assert.match(picker, /Who is practising\?/u);
  assert.doesNotMatch(picker, /first-run-scene/u);

  /* Welcome region: names the product the parent tapped, as the page heading. */
  const displayName = await shippedDisplayName();
  assert.match(
    firstRun,
    new RegExp(`<section class="first-run-welcome">[\\s\\S]*?<h1[^>]*>${displayName}</h1>`, 'u'),
    `the welcome region must name ${displayName} in an h1`,
  );
  assert.match(
    firstRun,
    /<h1[^>]*>[\s\S]*?<\/h1>[\s\S]*?<p class="body-copy">[^<]*spelling practice/u,
    'the welcome must say what the app does, not only what it is called',
  );

  /* Local-data reassurance: its own region with its own heading, carrying more
     than the single caption the picker reduced it to. */
  const local = firstRun.match(
    /<section class="first-run-local"[\s\S]*?<\/section>/u,
  )?.[0];
  assert.ok(local, 'first run must render a local-data reassurance region');
  assert.match(local, /<h2[^>]*>Everything stays on this device<\/h2>/u);
  assert.ok(
    (local.match(/<li[\s>]/gu) ?? []).length >= 2,
    'the reassurance region must state more than one fact',
  );
  assert.doesNotMatch(local, /switch-note/u, 'reassurance must not be a caption');

  /* Add learner is the primary action: the filled submit, reached without the
     dashed disclosure the picker puts in front of it. */
  assert.match(
    firstRun,
    /<button type="submit" class="button-primary press"[^>]*>Add learner<\/button>/u,
  );
  assert.doesNotMatch(
    firstRun,
    /learner-add/u,
    'the dashed disclosure is the picker\'s affordance, not first run\'s primary action',
  );
  assert.match(firstRun, /id="profile-nickname"/u, 'the form is open on arrival');

  /* Guideline 1.3: the first screen is child-reachable, so no commerce copy. */
  assert.doesNotMatch(firstRun, /£|\bbuy\b|\bprice\b|purchase|unlock/iu);
});

test('the first-run welcome is set in the display face and its action clears 44pt', async () => {
  const css = await read('src/app/app.css');

  const serif = css.match(/--serif:\s*([^;]+);/u)?.[1];
  assert.ok(serif?.trim().startsWith('Fraunces'), 'the display face is Fraunces');

  assert.match(
    css,
    /\.product-app :where\(h1, h2, h3\) \{[^}]*font-family: var\(--serif\)/u,
    'headings take the display face, so the welcome h1 is set in it',
  );
  assert.doesNotMatch(
    css,
    /\.first-run-welcome[^{]*\{[^}]*font-family/u,
    'the welcome must not opt out of the display face',
  );

  const primaryMinHeight = css
    .match(/\.button-primary \{[^}]*min-height:\s*([\d.]+)rem/u)?.[1];
  assert.ok(primaryMinHeight, '.button-primary must declare a min-height');
  assert.ok(
    Number(primaryMinHeight) * 16 >= 44,
    `the primary action must clear the 44pt floor, got ${primaryMinHeight}rem`,
  );
});
