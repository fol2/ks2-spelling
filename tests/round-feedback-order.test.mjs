/* The round card's correction guidance is the primary region (#112).

   Reference layouts make the Feedback state "Saved result and correction
   guidance | Same listening controls | Continue or try again", and the
   accessibility contract requires reading and focus order to match the visual
   order. The card shipped the guidance *after* the button, inside no region at
   all: the child had to look past the control they had just pressed to find out
   what they got wrong, and a screen-reader user reached Continue first.

   Reading order is DOM order, so a CSS `order` would satisfy a screenshot and
   fail the contract — these assertions are on rendered markup, plus one on the
   stylesheet so the visual half cannot be reversed underneath them.

   The guidance sits *below* the answer field, which the Input tier forbids
   moving: the listening controls and the action shift down, the field does not.
*/
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createServer } from 'vite';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFile(join(ROOT, path), 'utf8');

const ADA = Object.freeze({
  learnerId: 'learner-a',
  nickname: 'Ada',
  yearGroup: 'Y4',
  goal: 10,
  colour: '#1f6f77',
  createdAt: 1,
  updatedAt: 1,
});

function practiceCard(feedback) {
  return Object.freeze({
    sessionId: 'session-1',
    runtimeItemId: 'runtime-1',
    label: 'Smart Review',
    mode: 'smart',
    phase: feedback ? 'correction' : 'question',
    awaitingAdvance: false,
    sentence: 'A coat is necessary on a morning like this.',
    cloze: 'A coat is ______ on a morning like this.',
    target: 'necessary',
    slug: 'necessary',
    feedback,
    fallbackToSmart: false,
    progress: Object.freeze({ total: 5, done: 2, checked: 2, wrongCount: 1 }),
  });
}

function stubServices(practice) {
  const store = (state) => Object.freeze({
    getState: () => state,
    subscribe: () => Object.freeze({ remove() {} }),
  });
  return Object.freeze({
    mode: 'product',
    controller: Object.freeze({
      ...store(Object.freeze({
        status: 'ready',
        profiles: Object.freeze([ADA]),
        selectedLearnerId: ADA.learnerId,
        actionError: null,
      })),
      async createProfile() {},
      async editProfile() {},
      async selectProfile() {},
      async removeProfile() {},
    }),
    learning: Object.freeze({
      ...store(Object.freeze({
        status: 'ready',
        screen: 'practice',
        learnerId: ADA.learnerId,
        practice,
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
      })),
      showScreen() {},
      async selectLearner() {},
      async startRound() {},
      async startGuardianMission() {},
      async submitAnswer() {},
      async continueRound() {},
      async skipWord() {},
      async endRound() {},
    }),
    audioAvailability: Object.freeze({
      ...store(Object.freeze({ status: 'ready', activeVersion: '1.0.0', actionError: null })),
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
      ...store(Object.freeze({ status: 'ready', learners: Object.freeze([]), actionError: null })),
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

/* The three shapes the engine really produces on a wrong answer. The first miss
   deliberately withholds the target (`legacy-engine.js` — "No answer shown yet.
   Hear it again and try once more from memory."), and `service.js` attaches the
   typed word to every wrong non-test answer regardless. */
const FIRST_MISS = Object.freeze({
  kind: 'error',
  headline: 'Not quite.',
  answer: '',
  attemptedAnswer: 'nesessary',
  body: 'No answer shown yet. Hear it again and try once more from memory.',
  footer: 'If it is still wrong next time, the correct spelling will appear.',
  familyWords: Object.freeze([]),
});

const CORRECTION = Object.freeze({
  kind: 'error',
  headline: 'Try again.',
  answer: 'necessary',
  attemptedAnswer: 'nesessary',
  body: 'Type the correct spelling exactly once before moving on.',
  footer: '',
  familyWords: Object.freeze([]),
});

const SECURED = Object.freeze({
  kind: 'success',
  headline: 'Secure.',
  answer: 'necessary',
  attemptedAnswer: '',
  body: 'Two clean recalls each.',
  footer: '',
  familyWords: Object.freeze([]),
});

async function renderer(t) {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const vite = await createServer({
    configFile: join(ROOT, 'vite.config.js'),
    server: { middlewareMode: true },
    appType: 'custom',
  });
  t.after(() => vite.close());
  const { default: App } = await vite.ssrLoadModule('/src/app/App.jsx');
  return (feedback) => renderToStaticMarkup(
    React.createElement(App, { services: stubServices(practiceCard(feedback)) }),
  );
}

test('correction guidance is read before the way out of the round (#112)', async (t) => {
  const render = await renderer(t);
  const markup = render(CORRECTION);

  const feedbackAt = markup.indexOf('class="round-feedback"');
  const actionAt = markup.indexOf('class="button-brand press"');
  const fieldAt = markup.indexOf('id="product-spelling-input"');

  assert.ok(feedbackAt > -1, 'the round card must render a feedback region');
  assert.ok(actionAt > -1, 'the round card must render its primary action');

  assert.ok(
    feedbackAt < actionAt,
    'correction guidance must render before Continue, in the DOM — reading and '
      + 'focus order follow the document, not the stylesheet',
  );

  /* The Input tier forbids moving the answer field. Guidance inserted below it
     cannot: the card is `flex: none` in a top-aligned column, so only what
     follows the field shifts. */
  assert.ok(
    fieldAt < feedbackAt,
    'the guidance must sit below the answer field, which never moves',
  );

  /* Both in the same form, so a submit-time re-render cannot reorder them and
     so the focus ring walks field -> replay -> result -> Continue. */
  const form = markup.match(/<form class="answer-form"[\s\S]*?<\/form>/u)?.[0];
  assert.ok(form, 'the answer form must still exist');
  assert.ok(
    form.includes('round-feedback') && form.includes('button-brand'),
    'guidance and action must share the form, not straddle its closing tag',
  );

  /* Announced as a live region, ahead of the control, not as an alert that
     interrupts. */
  assert.match(
    markup.slice(feedbackAt - 200, feedbackAt + 200),
    /role="status"/u,
    'the feedback region stays a polite live region',
  );
});

test('the learner sees what they wrote beside the correct spelling (#112)', async (t) => {
  const render = await renderer(t);
  const markup = render(CORRECTION);

  const spellings = markup.match(
    /<div class="round-feedback-spellings">[\s\S]*?<\/div>/u,
  )?.[0];
  assert.ok(spellings, 'the two spellings must share one container');

  assert.match(
    spellings,
    /<span>You wrote<\/span><strong>nesessary<\/strong>/u,
    'the attempt the engine certified must reach the screen, not be discarded',
  );
  assert.match(
    spellings,
    /<span>Correct spelling<\/span><strong>necessary<\/strong>/u,
    'the target must sit in the same container so the difference is comparable',
  );
  assert.ok(
    spellings.indexOf('nesessary') < spellings.indexOf('>necessary<'),
    'the attempt is read first and the correct spelling last, which is the one '
      + 'the learner should leave holding',
  );
});

test('a misspelling is never painted without the correction beside it (#112)', async (t) => {
  const render = await renderer(t);

  /* First miss: the engine withholds the target on purpose. Showing the child's
     wrong spelling alone would put the only spelling on screen in the wrong
     form. */
  const firstMiss = render(FIRST_MISS);
  assert.match(firstMiss, /No answer shown yet/u, 'the first-miss body still renders');
  assert.doesNotMatch(
    firstMiss,
    /nesessary/u,
    'with no target to compare against, the attempt must not be painted',
  );
  assert.doesNotMatch(firstMiss, /round-feedback-spellings/u);

  /* A correct answer has no attempt to show. */
  const secured = render(SECURED);
  assert.match(secured, /<strong>necessary<\/strong>/u, 'the word still names itself');
  assert.doesNotMatch(secured, /You wrote/u, 'nothing was got wrong to show');
});

test('the stylesheet cannot put the action back above the guidance (#112)', async () => {
  const css = await read('src/app/app.css');
  const stripped = css.replace(/\/\*[\s\S]*?\*\//gu, '');

  /* `.answer-form` is a grid, so a single `order` declaration would restore the
     shipped defect visually while every markup assertion above stayed green —
     the exact shape of a check that passes on an artefact nobody sees. */
  for (const selector of ['.round-feedback', '.round-card .button-brand', '.answer-form']) {
    const block = stripped.match(
      new RegExp(String.raw`(?:^|\})\s*${selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\s*\{([^}]*)\}`, 'u'),
    )?.[1];
    assert.ok(block !== undefined, `${selector} must exist in the stylesheet`);
    assert.doesNotMatch(
      block,
      /(?:^|;)\s*order\s*:/u,
      `${selector} must not reorder the form: visual order has to match the DOM`,
    );
  }
});
