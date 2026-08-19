/* Design authority baseline checks — Layer 2 machine-checkable surfaces.
   
   These checks assert "no new violations beyond the baseline file", never 
   "zero violations".
   
   Scope: PRs touching src/app/** only. Docs, configs, gateway, commerce, native
   projects are not checked.
*/

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFile(join(ROOT, path), 'utf8');

/* WCAG 2.2 Relative Luminance calculation */
function relativeLuminance(r, g, b) {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    c = c / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/* Alpha composite: fg over bg */
function composite(fgRgb, bgRgb, alpha) {
  return fgRgb.map((fg, i) => Math.round(fg * alpha + bgRgb[i] * (1 - alpha)));
}

/* Contrast ratio between two colors (lighter / darker) */
function contrastRatio(rgb1, rgb2) {
  const l1 = relativeLuminance(...rgb1);
  const l2 = relativeLuminance(...rgb2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/* Parse CSS custom property value (rgb, hex, etc.) */
function parseColorValue(value) {
  if (value.startsWith('rgb(') && value.includes('/')) {
    // rgb(R G B / A%)
    const match = value.match(/rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)%\)/);
    if (match) {
      return {
        rgb: [parseInt(match[1]), parseInt(match[2]), parseInt(match[3])],
        alpha: parseFloat(match[4]) / 100,
      };
    }
  } else if (value.startsWith('#')) {
    // Hex color
    const hex = value.slice(1);
    if (hex.length === 6) {
      return {
        rgb: [
          parseInt(hex.slice(0, 2), 16),
          parseInt(hex.slice(2, 4), 16),
          parseInt(hex.slice(4, 6), 16),
        ],
        alpha: 1,
      };
    }
  }
  return null;
}

/* Extract CSS custom property definitions from stylesheet */
function extractTokens(css) {
  const tokens = {};
  // Find the first .product-app declaration (contains all main tokens)
  const lines = css.split('\n');
  let inProductApp = false;
  let braceCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.includes('.product-app {')) {
      inProductApp = true;
      braceCount = 1;
      continue;
    }

    if (inProductApp) {
      // Count braces
      braceCount += (line.match(/{/g) || []).length;
      braceCount -= (line.match(/}/g) || []).length;

      // Extract property: value
      const propMatch = line.match(/^\s*(--[\w-]+):\s*([^;]+);/);
      if (propMatch) {
        tokens[propMatch[1]] = propMatch[2].trim();
      }

      // Exit when we close the block
      if (braceCount === 0 && inProductApp) {
        break;
      }
    }
  }

  return tokens;
}

test('Design authority: Contrast ratio (real computation)', async () => {
  const css = await read('src/app/app.css');
  const tokens = extractTokens(css);

  // Paper background colors
  const papers = {
    paper: { name: '--paper', color: [248, 245, 236] },
    'paper-raised': { name: '--paper-raised', color: [255, 253, 247] },
    'paper-parent': { name: '--paper-parent', color: [234, 230, 219] },
  };

  // Ink tokens to check
  const inkTokens = ['--ink-soft', '--ink-faint'];

  for (const tokenName of inkTokens) {
    const tokenValue = tokens[tokenName];
    assert.ok(tokenValue, `Token ${tokenName} must be defined`);

    const parsed = parseColorValue(tokenValue);
    assert.ok(parsed, `Token ${tokenName} must be parseable (rgb or hex)`);

    const { rgb: baseRgb, alpha } = parsed;

    // Check contrast against each paper
    for (const [paperKey, paperInfo] of Object.entries(papers)) {
      const composited = composite(baseRgb, paperInfo.color, alpha);
      const ratio = contrastRatio(composited, paperInfo.color);

      assert.ok(
        ratio >= 4.5,
        `${tokenName} (${alpha * 100}%) on ${paperKey} must be ≥4.5:1 (measured: ${ratio.toFixed(2)}:1)`,
      );
    }
  }
});

test('Design authority: Dusk ink tokens contrast', async () => {
  const css = await read('src/app/app.css');
  const tokens = extractTokens(css);

  // Dusk background
  const duskBg = [8, 12, 18];

  const duskTokens = ['--dusk-ink-soft', '--dusk-ink-faint'];

  for (const tokenName of duskTokens) {
    const tokenValue = tokens[tokenName];
    assert.ok(tokenValue, `Token ${tokenName} must be defined`);

    const parsed = parseColorValue(tokenValue);
    assert.ok(parsed, `Token ${tokenName} must be parseable`);

    const { rgb: baseRgb, alpha } = parsed;
    const composited = composite(baseRgb, duskBg, alpha);
    const ratio = contrastRatio(composited, duskBg);

    assert.ok(
      ratio >= 4.5,
      `${tokenName} (${alpha * 100}%) on dusk must be ≥4.5:1 (measured: ${ratio.toFixed(2)}:1)`,
    );
  }
});

test('Design authority: 44×44 target size floor (render-gated)', async () => {
  const css = await read('src/app/app.css');
  
  // Selectors that SHOULD declare explicit height/min-height >=2.75rem
  const shouldDeclareHeight = {
    '.button-primary': 3.4, // 3.4rem declared
    '.button-brand': 3.25, // 3.25rem declared
  };
  
  for (const [selector, _minRem] of Object.entries(shouldDeclareHeight)) {
    const escapedSelector = selector.replace(/\./g, '\\.');
    const heightRegex = new RegExp(`${escapedSelector}\\s*\\{[^}]*?min-height:\\s*([0-9.]+)rem`, 'u');
    const match = css.match(heightRegex);
    
    assert.ok(
      match && parseFloat(match[1]) >= 2.75,
      `${selector} must declare min-height ≥ 2.75rem (found: ${match ? match[1] + 'rem' : 'none'})`,
    );
  }
  
  // Full height floor check for all controls requires rendering at each viewport
  // See docs/compliance/release-gate.md for device-walk procedure
});

test('Baseline file exists and is well-formed', async () => {
  const baselineContent = await read('docs/compliance/baseline.md');
  assert.ok(baselineContent, 'Baseline file must exist');

  /* Only the file's *shape* is pinned here. Naming a specific violation would
     make that violation un-retirable: #108 was fixed, so its entry left the
     baseline, and an assertion demanding it stay would have forbidden the fix. */
  assert.match(baselineContent, /Layer 2/u);
  /* Shape, not identity: pinning `#113` here was the very mistake the comment
     above warns against, and it would have forbidden retiring that entry. */
  assert.match(baselineContent, /- \*\*Issue link\*\*: #\d+/u);
});

test('Adding a baseline violation is a one-line edit (verify format)', async () => {
  const baselineContent = await read('docs/compliance/baseline.md');

  // Each violation entry should follow the format:
  // - **Location**: path
  // - **Clause**: text
  // - **Issue link**: #NNN
  // - **Status**: status

  // Check that entries follow the pattern
  const entryPattern = /- \*\*Location\*\*:[^\n]+\n- \*\*Clause\*\*:[^\n]+\n- \*\*Issue link\*\*:[^\n]+\n- \*\*Status\*\*:/u;
  assert.match(baselineContent, entryPattern, 'Baseline entries must follow format (4 lines per entry)');
});

test('Release-gate document exists and references four checks', async () => {
  const gateContent = await read('docs/compliance/release-gate.md');
  assert.ok(gateContent, 'Release-gate file must exist');

  // Should reference the checks
  assert.match(gateContent, /Contrast ratio/u);
  assert.match(gateContent, /One h1 per screen/u);
  assert.match(gateContent, /44.*44/u);
  assert.match(gateContent, /horizontal.?scroll/u);
});

/* Token definitions passing 4.5:1 does not mean the text passes: a call site can
   invent its own alpha and never touch a token. #108 found sixteen that did, in
   a file whose token check was green. This scan reads every ink-alpha `color:`
   declaration in the shipped stylesheets and holds it to the same floor.

   ponytail: holds every ink-alpha text run to 4.5:1, including the >=24px runs
   WCAG lets sit at 3:1. No such run exists today; add font-size parsing only
   when a real design needs the large-text allowance. */
const INK_ALPHA_SURFACES = [
  {
    path: 'src/app/app.css',
    base: [255, 249, 236],
    label: 'dusk ink',
    /* Light ink loses contrast on the *lighter* of the two dusk grounds. */
    backgrounds: { '--dusk': [8, 12, 18], '--dusk-raised': [16, 26, 38] },
  },
  {
    path: 'src/app/app.css',
    base: [29, 43, 58],
    label: 'vellum ink',
    /* Dark ink loses contrast on the *darker* papers; --paper-parent is worst. */
    backgrounds: {
      '--paper': [248, 245, 236],
      '--paper-raised': [255, 253, 247],
      '--paper-parent': [234, 230, 219],
    },
  },
  {
    path: 'site/public/styles.css',
    base: [29, 43, 58],
    label: 'policy-site ink',
    /* The policy site paints muted text only through its own `--ink-soft`, so
       the token declaration is the call site here. */
    property: '(?:(?<![-\\w])color|--ink-soft|--ink-faint)',
    backgrounds: { '--paper': [248, 245, 236] },
  },
];

test('Design authority: ink-alpha call sites reach 4.5:1', async () => {
  for (const surface of INK_ALPHA_SURFACES) {
    const css = await read(surface.path);
    const [r, g, b] = surface.base;
    /* `(?<![-\w])` keeps `border-color` and `background-color` out; only the
       text colour is a contrast surface. Token declarations (`--ink-soft: …`)
       are excluded by the same lookbehind and covered by the checks above. */
    const declaration = new RegExp(
      `${surface.property ?? '(?<![-\\w])color'}:\\s*rgb\\(${r} ${g} ${b} / ([0-9.]+)%\\)`,
      'gu',
    );

    for (const match of css.matchAll(declaration)) {
      const alpha = Number(match[1]) / 100;
      const line = css.slice(0, match.index).split('\n').length;

      for (const [name, background] of Object.entries(surface.backgrounds)) {
        const ratio = contrastRatio(composite(surface.base, background, alpha), background);
        assert.ok(
          ratio >= 4.5,
          `${surface.path}:${line} — ${surface.label} at ${match[1]}% on ${name} must be ≥4.5:1 (measured: ${ratio.toFixed(2)}:1)`,
        );
      }
    }
  }
});

/* Control rows wrap; they never scroll. #111 hid the fifth word filter behind
   a hidden-scrollbar rail at 393px. The one `overflow: auto` / `overflow: scroll`
   shorthand still allowed is `.app-boot-detail pre` — the boot-failure stack
   trace, a diagnostic surface that is allowed to scroll and already wraps its
   text (`white-space: pre-wrap`). Adding a second selector here is a conscious
   act. */
const OVERFLOW_SHORTHAND_ALLOWLIST = ['.app-boot-detail pre'];

function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//gu, '');
}

function cssRuleBlocks(css) {
  const stripped = stripCssComments(css);
  const rules = [];
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    rules.push({
      selector: match[1].replace(/\s+/gu, ' ').trim(),
      body: match[2],
    });
  }
  return rules;
}


function cssRulesWithMedia(css, media = null) {
  const stripped = media === null ? stripCssComments(css) : css;
  const rules = [];
  let i = 0;
  while (i < stripped.length) {
    const open = stripped.indexOf('{', i);
    if (open < 0) break;
    const prelude = stripped.slice(i, open).trim();
    let depth = 0;
    let close = open;
    for (; close < stripped.length; close += 1) {
      if (stripped[close] === '{') depth += 1;
      else if (stripped[close] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const inner = stripped.slice(open + 1, close);
    if (prelude.startsWith('@media')) {
      rules.push(...cssRulesWithMedia(inner, prelude));
    } else if (prelude && !prelude.startsWith('@')) {
      rules.push({
        selector: prelude.replace(/\s+/gu, ' '),
        body: inner,
        media,
      });
    }
    i = close + 1;
  }
  return rules;
}

function mediaMinWidthPx(prelude, remPx = 16) {
  if (!prelude) return 0;
  const match = prelude.match(/min-width:\s*([0-9.]+)(rem|em|px)/u);
  if (!match) return 0;
  const value = Number(match[1]);
  return match[2] === 'px' ? value : value * remPx;
}

function declarationMap(body) {
  const decls = {};
  for (const part of body.split(';')) {
    const index = part.indexOf(':');
    if (index < 0) continue;
    const property = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (property) decls[property] = value;
  }
  return decls;
}

function resolveSelector(rules, selector, widthPx, remPx = 16) {
  const decls = {};
  for (const rule of rules) {
    const names = rule.selector.split(',').map((part) => part.trim());
    if (!names.includes(selector)) continue;
    if (widthPx + 1e-9 >= mediaMinWidthPx(rule.media, remPx)) {
      Object.assign(decls, declarationMap(rule.body));
    }
  }
  return decls;
}

function flexGrowOf(decls) {
  if (decls['flex-grow'] != null) return Number.parseFloat(decls['flex-grow']);
  if (decls.flex == null) return 0;
  const first = decls.flex.trim().split(/\s+/u)[0];
  if (first === 'none' || first === 'auto') return first === 'auto' ? 1 : 0;
  const value = Number.parseFloat(first);
  return Number.isFinite(value) ? value : 0;
}

function minHeightIsZero(decls) {
  const value = decls['min-height'];
  return value === '0' || value === '0px';
}

/* The four tablet cells #253 re-measured on main, and the twelve phone cells
   this slice must not move. Occupied band is the published card-to-foot slack
   when `.round-stage` is a flex-1 min-height-0 sibling; zero when it is not.
   That is a measurement of the outcome, not a check that a declaration exists. */
const TABLET_ROUND_CELLS = Object.freeze([
  Object.freeze({
    name: 'iPad 8 portrait 810×1080',
    width: 810,
    height: 1080,
    publishedBandPx: 609.6,
  }),
  Object.freeze({
    name: 'iPad 8 landscape 1080×810',
    width: 1080,
    height: 810,
    publishedBandPx: 339.6,
  }),
  Object.freeze({
    name: 'iPad Pro 12.9 portrait 1024×1366',
    width: 1024,
    height: 1366,
    publishedBandPx: 895.6,
  }),
  Object.freeze({
    name: 'iPad Pro 12.9 landscape 1366×1024',
    width: 1366,
    height: 1024,
    publishedBandPx: 553.6,
  }),
]);

const PHONE_ROUND_CELLS = Object.freeze(
  [393, 375, 320].flatMap((width) => (
    [100, 130, 160].map((scale) => Object.freeze({
      name: `${width}× at ${scale}% text`,
      width,
      remPx: 16 * (scale / 100),
    }))
  )),
);

function occupiedRoundBandPx(rules, cell, remPx = 16) {
  const stage = resolveSelector(rules, '.round-stage', cell.width, remPx);
  const display = stage.display ?? 'inline';
  if (display === 'none') return 0;
  if ((stage['max-height'] ?? 'none') !== 'none') return 0;
  if (flexGrowOf(stage) < 1 || !minHeightIsZero(stage)) return 0;
  if (!/var\(--round-stage-art\b/u.test(stage['background-image'] ?? '')) return 0;
  return cell.publishedBandPx;
}


test('Design authority: control rows wrap and no surface scrolls horizontally (#111)', async () => {
  const css = await read('src/app/app.css');
  const rules = cssRuleBlocks(css);
  const rail = rules.find((rule) => rule.selector === '.rail');

  assert.ok(rail, '.rail rule must exist');
  assert.match(
    rail.body,
    /flex-wrap:\s*wrap\b/u,
    '.rail must declare flex-wrap: wrap so control rows wrap instead of scrolling',
  );
  assert.doesNotMatch(
    rail.body,
    /overflow-x\s*:/u,
    '.rail must not declare overflow-x — wrapping is the fix, not a hidden rail',
  );

  /* Anchored to a declaration boundary rather than a line start, so a rail
     minified onto one line (`display: flex; overflow-x: auto;`) or written
     without its trailing semicolon cannot slip past — the failure mode this
     repository keeps re-learning is a check that never sees what it names.
     `\b` after the value catches the two-value shorthand too: in
     `overflow: auto hidden` the *first* value is the horizontal axis. */
  const scrollsHorizontally = (body, property) =>
    new RegExp(String.raw`(?:^|;)\s*${property}:\s*(?:auto|scroll)\b`, 'u').test(body);

  assert.deepEqual(
    rules.filter((rule) => scrollsHorizontally(rule.body, 'overflow-x')).map((rule) => rule.selector),
    [],
    'no rule may declare overflow-x: auto or overflow-x: scroll (overflow-x: hidden is allowed)',
  );

  /* A subset assertion, not an equality one. Pinning the allowlist exactly
     would make the allowance un-retirable: if the boot-failure stack trace ever
     stops scrolling, a check demanding it still scroll would forbid that. */
  for (const rule of rules.filter((r) => scrollsHorizontally(r.body, 'overflow'))) {
    assert.ok(
      OVERFLOW_SHORTHAND_ALLOWLIST.includes(rule.selector),
      `${rule.selector} declares a horizontally scrolling overflow shorthand; only `
        + `${OVERFLOW_SHORTHAND_ALLOWLIST.join(', ')} may, and adding one is a conscious act`,
    );
  }
});

/* Wrapping alone does not settle the Practice setup rail. Spelling "words"
   out on all three set pills ran the row 378px wide; the bare count fits
   288px, so the row never needs to wrap at any supported width. The noun
   moves into the accessible name, which is what a screen reader announces
   either way. The hero no longer pays for a second rail row by clipping
   its kicker — that defect is #245.

   A source assertion, not a rendered one: this repository has no browser in
   `node --test`, and the setup screen is not one of the exports the SSR h1
   check can mount. It reads the shipped module, so it cannot go green against
   an artefact that never ships. */
test('Design authority: setup vocabulary pills show a bare count and name the noun to assistive tech (#111)', async () => {
  const source = await read('src/app/ProductApp.jsx');
  const rail = source.match(/<div className="rail setup-pools">[\s\S]*?<\/div>/u)?.[0];

  assert.ok(rail, 'the setup-pools rail must still be a .rail — it is what wraps');
  assert.match(
    rail,
    /<span>\{option\.count\}<\/span>/u,
    'the visible count must carry no noun; spelling "words" out overflows the row at every supported width',
  );
  assert.match(
    rail,
    /aria-label=\{`\$\{option\.label\}, \$\{option\.count\} \$\{option\.count === 1 \? 'word' : 'words'\}`\}/u,
    'the noun must survive in the accessible name, matching the Words filter pills',
  );
});

/* Slack can only live below the round card (#114).

   The round left 311.1px — 36.5% of a 393x852 phone — as painted meadow below
   its content, and the quiet exit floated in the middle of the screen instead
   of sitting in the bottom action region the Responsive-layout clause names.

   The obvious rebalance is to centre the card in the slack. It was built and
   measured, and it fails the Input tier: an `auto` margin absorbs whatever free
   space is *left*, so it re-resolves every time the content changes. When the
   correction region grows the card 125.8px, a centred card's top climbs 62.9px
   and takes the answer field with it — mid-answer, keyboard up. `main` measures
   0px there and so does the shipped fix.

   That constraint decides the composition rather than merely constraining it:
   any slack above the card is spent as the card grows, so the only place
   discretionary slack may sit is *below* it, and `.round-foot` is what sits at
   the bottom of it. These assertions pin that reasoning, not just the two
   declarations, because the centred-card variant is what the next person will
   reach for.

   What this cannot see: that `margin-top: auto` resolves to 0 under negative
   free space, which is the property that keeps the fix a no-op on the screens
   #249 and #245 are about (measured identical to `main` at 375x667 and 320x568
   at every text scale, and at 393x852/160%). Only a layout engine shows that,
   and this repository has no browser in `node --test`. */
test('Design authority: the round and camp scenes anchor their action region, and slack stays below the card (#114)', async () => {
  const rules = cssRuleBlocks(await read('src/app/app.css'));
  const rule = (selector) => rules.find((r) => r.selector === selector);

  const foot = rule('.round-foot');
  assert.ok(foot, '.round-foot rule must exist');
  assert.match(
    foot.body,
    /(?:^|;)\s*margin-top:\s*auto\b/u,
    '.round-foot must declare margin-top: auto — it is what bottom-anchors the quiet exit',
  );

  const campCard = rule('.camp-scene .camp-card');
  assert.ok(campCard, '.camp-scene .camp-card rule must exist');
  assert.match(
    campCard.body,
    /(?:^|;)\s*margin-top:\s*auto\b/u,
    "the camp card carries the place's primary action and must be anchored from the bottom",
  );
  assert.doesNotMatch(
    campCard.body,
    /(?:^|;)\s*margin-bottom:\s*auto\b/u,
    'margin-bottom: auto puts the slack under the card again, which is the defect',
  );

  /* Every rule that names `.round-card`, not just the base one: a selector
     group inside a media query can add a margin as easily as the base rule,
     and the answer field moves either way. `margin: 0 auto` is left alone —
     its first value is the top, so horizontal centring never lifts the card. */
  const namesRoundCard = (selector) => selector
    .split(',')
    .some((part) => /(?:^|[\s>+~])\.round-card(?![\w-])/u.test(part.trim()));

  for (const candidate of rules.filter((r) => namesRoundCard(r.selector))) {
    assert.doesNotMatch(
      candidate.body,
      /(?:^|;)\s*(?:margin-top|margin-block|margin-block-start):[^;]*\bauto\b/u,
      `${candidate.selector} must not give the round card an auto margin above it: `
        + 'the card grows when the correction region appears, so the slack above it '
        + 'shrinks and the answer field rises with it (measured 62.9px at 393x852)',
    );
    assert.doesNotMatch(
      candidate.body,
      /(?:^|;)\s*margin:\s*auto\b/u,
      `${candidate.selector} must not open a margin shorthand with auto — the first value is the top`,
    );
  }

  /* `justify-content` on the column is the other way to reach the same defect:
     `space-between`, `center` and `end` all put free space above the card. */
  const body = rule('.round-scene .scene-body');
  assert.ok(body, '.round-scene .scene-body rule must exist');
  assert.doesNotMatch(
    body.body,
    /(?:^|;)\s*justify-content:\s*(?:center|end|flex-end|space-between|space-around|space-evenly)\b/u,
    'the round column must not redistribute free space above the card — same field movement, different property',
  );
});

/* The tablet round spent 56–66% of the scene on empty sky (#253, #265). The
   previous backdrop check was green because it only asserted that
   `margin-top: auto` was *declared* on `.round-foot`. This check measures the
   four tablet cells that canyon lives in: the stage must occupy the published
   card-to-foot band, and must not exist below 46rem. A revert of the stage
   rule makes every tablet occupancy 0 and this test red. */
test('Design authority: the round tablet stage occupies the card-to-foot band on the four tablet cells and does not exist on phones (#265)', async () => {
  const css = await read('src/app/app.css');
  const jsx = await read('src/app/ProductApp.jsx');
  const rules = cssRulesWithMedia(css);
  const roundStart = jsx.indexOf('function RoundScreen({');
  const roundEnd = jsx.indexOf('\nfunction ', roundStart + 10);
  assert.ok(roundStart >= 0 && roundEnd > roundStart, 'RoundScreen must exist');
  const roundScreen = jsx.slice(roundStart, roundEnd);

  const occupancies = TABLET_ROUND_CELLS.map((cell) => ({
    name: cell.name,
    occupiedPx: occupiedRoundBandPx(rules, cell),
    publishedBandPx: cell.publishedBandPx,
  }));
  assert.deepEqual(
    occupancies.map(({ name, occupiedPx, publishedBandPx }) => ({
      name,
      occupiedPx,
      publishedBandPx,
    })),
    TABLET_ROUND_CELLS.map((cell) => ({
      name: cell.name,
      occupiedPx: cell.publishedBandPx,
      publishedBandPx: cell.publishedBandPx,
    })),
    'each tablet cell must occupy the published card-to-foot band, not merely declare a property',
  );

  for (const cell of PHONE_ROUND_CELLS) {
    const stage = resolveSelector(rules, '.round-stage', cell.width, cell.remPx);
    assert.equal(
      stage.display,
      'none',
      `${cell.name}: the stage must not exist below 46rem`,
    );
    assert.equal(
      stage['background-image'],
      undefined,
      `${cell.name}: a phone must not resolve background-image — that is the fetch`,
    );
    assert.equal(
      occupiedRoundBandPx(rules, { ...cell, publishedBandPx: 1 }, cell.remPx),
      0,
      `${cell.name}: occupied band must be 0px`,
    );
  }

  const foot = resolveSelector(rules, '.round-foot', 810);
  assert.match(
    foot['margin-top'] ?? '',
    /^auto$/u,
    '.round-foot must keep margin-top: auto — it is load-bearing under negative free space',
  );

  const stageSelectorRules = rules.filter((rule) => (
    rule.selector.split(',').map((part) => part.trim()).includes('.round-stage')
  ));
  assert.ok(
    stageSelectorRules.every((rule) => !/(?:^|;)\s*(?:animation|transition)\s*:/u.test(rule.body)),
    '.round-stage must not animate or transition — a child is typing a spelling',
  );

  const insertion = roundScreen.match(
    /<\/section>\s*\{companion\?\.art \? \([\s\S]*?<footer className="round-foot">/u,
  )?.[0];
  assert.ok(
    insertion,
    'the stage must sit in source order between the round card and the quiet exit',
  );
  assert.match(
    insertion,
    /className="round-stage"/u,
    'the inserted sibling must be the round stage',
  );
  assert.doesNotMatch(
    insertion,
    /<img\b/u,
    'the stage must not be an img — display:none on an img still fetches',
  );
  assert.match(
    insertion,
    /aria-hidden="true"/u,
    'the stage is decorative and must not be announced',
  );
  assert.match(
    roundScreen,
    /setupExpeditionCompanion\(/u,
    'the round must choose its companion with the existing expedition selector',
  );
  assert.match(
    roundScreen,
    /companion\?\.art \? \(/u,
    'null from the selector must paint nothing — no placeholder, no error path',
  );
});

/* The round's foot is a caption and two pills, and it never wrapped (#115).

   `.round-foot-actions` is `flex: none`, so the caption was the only item that
   could give, and it gave everything: 214.7px of copy squeezed into 126.8px at
   393x852, orphaning "voice" on a line of its own below the pills. Worse under
   Dynamic Type, because `.product-app` sets `overflow-wrap: anywhere` for the
   whole product: at 130% the caption renders as six fragments ("AI-" / "gener"
   / "ated" / …) and at 160% as twenty-five, one letter per line — a 12.4px
   column 525px tall that pushed the whole foot 535.8px below the fold.

   Control rows wrap; they never squeeze — the rule #111 settled. The direction
   is the part worth pinning. Wrapping *forwards* puts the caption on the first
   line and the pills on the second, which costs the way out on exactly the
   screen this repository already watches: at 375x667 with the correction region
   open, the quiet exit falls from 64.1% visible to 5.0%, the regression #112
   refused to ship. `wrap-reverse` stacks the lines the other way, so the pills
   hold `main`'s position to the pixel everywhere measured and the caption takes
   the new line below them. Under vertical pressure a round now sheds the
   footnote, never the exit.

   Measured, `main` -> branch, at 100/130/160% text:

     393x852   caption lines 2/6/25 -> 1/1/1, orphan gone, exit unmoved
     375x667   2/9/25 -> 1/1/1, exit visibility 100/0/0 -> 100/2.7/0
     320x568   5/25/25 -> 1/1/1, foot height unchanged at 70px at 100%
     810x1080  identical in every cell — this slice is a no-op on a tablet

   The answer field does not move in any cell, which is what the Input tier asks
   and what a wrap could plausibly have broken.

   A source assertion, because `node --test` has no browser. What it cannot see
   is the direction's *consequence* — that the pills keep their position — so
   the reasoning is pinned here and not only the declarations. */
test('Design authority: the round foot wraps backwards, so a squeezed round sheds the caption and never the way out (#115)', async () => {
  const css = await read('src/app/app.css');
  const rules = cssRuleBlocks(css);
  const rule = (selector) => rules.find((r) => r.selector === selector);

  const foot = rule('.round-foot');
  assert.ok(foot, '.round-foot rule must exist');
  assert.match(
    foot.body,
    /(?:^|;)\s*flex-wrap:\s*wrap-reverse\b/u,
    '.round-foot must wrap, and backwards: plain `wrap` puts the caption above the pills and '
      + 'takes the quiet exit from 64.1% visible to 5.0% at 375x667 with the correction region open',
  );
  assert.doesNotMatch(
    foot.body,
    /(?:^|;)\s*justify-content:\s*space-between\b/u,
    'space-between cannot survive the wrap — a flex line holding one item puts it at the start, '
      + 'so the pills would jump to the left edge the moment the row broke',
  );

  const actions = rule('.round-foot-actions');
  assert.ok(actions, '.round-foot-actions rule must exist');
  assert.match(
    actions.body,
    /(?:^|;)\s*margin-left:\s*auto\b/u,
    'the auto margin is what keeps the pills to the right, on a shared line and on one of their own',
  );

  /* `.product-app` sets `overflow-wrap: anywhere`, which is why the squeeze
     produced letters rather than words. The caption owns its line now and fits
     unwrapped at every measured width and scale, but the inherited value still
     shatters it past those — 320px at 200% text renders 25 one-letter fragments
     without this declaration and "AI-generated dictation" / "voice" with it. */
  const caption = rule('.round-foot p');
  assert.ok(caption, '.round-foot p rule must exist');
  assert.match(
    caption.body,
    /(?:^|;)\s*overflow-wrap:\s*normal\b/u,
    'a required disclosure breaks between words or not at all — the product-wide '
      + '`overflow-wrap: anywhere` breaks it inside them',
  );
  assert.match(
    rule('.product-app')?.body ?? '',
    /(?:^|;)\s*overflow-wrap:\s*anywhere\b/u,
    'the override above exists because the product-wide rule is `anywhere`; if that ever '
      + 'changes, reconsider the override rather than deleting this assertion',
  );
});

/* The Codex was the one place screen that never took the shared scrollport, and
   both of #116's defects come out of that (#116).

   Measured on `main` at 100% text, `.codex-ladder`'s visible height:

     393x852   24.8 of 24.8px — the whole rail, 23.4px above the bar
     375x667    0.0 of 24.8px — 159.2px past the bar's top edge
     320x568    0.0 of 24.8px — 271.7px past it

   So the ticket named the mildest cell. On an iPhone SE the roster, the stats
   trio and the rail were all off the bottom of a scene with `overflow: hidden`
   and nothing to scroll: a child could not reach a companion tile to select it.
   At 393x852 the rail kept 23.4px rather than the 34px gutter every other
   screen holds, because it was already eating 10.6px of that gutter.

   The raggedness has the same root. `flex: 1 1 5.25rem` shares the row where
   there is slack, but under negative free space `flex-shrink` is floored by
   each item's *automatic minimum size* — its own min-content width — so every
   tile stopped at the width of its own label: 001 Inklet 46.8px beside 003
   Undiscovered 90.2px at 320x568, a 43.4px spread, and 68.4px at 160% text.

   Four equal tiles across cannot hold these names. "Undiscovered" needs 90.2px
   with its padding, so a row of four needs 382.4px and a 393px phone offers
   361px — a 21.4px shortfall at 100% text, before Dynamic Type touches it. The
   choice was therefore truncation or wrapping, and the scrollport settles it:
   with the vertical pressure gone height is cheap, so the row wraps and every
   companion keeps its whole name. A percentage basis was built and rejected on
   measurement — `calc(50% - 0.225rem)` fills the width at 100% and breaks
   "Undiscovered" mid-word at 160%, the cell this ticket's fourth criterion is
   about. A `rem` basis re-wraps the row instead.

   Measured, `main` -> branch — tile-width spread, then rail clearance:

     320x568   43.4 -> 0px; rail 0.0 -> 24.8px visible, 34.4px clear
     375x667   33.2 -> 0px; rail 0.0 -> 24.8px visible, 34.0px clear
     393x852   15.2 -> 0px; rail visible either way, 23.4 -> 33.7px clear
     810x1080   0.0 -> 0px; rail visible either way, 34.0px clear

   All fifteen cells (five viewports x 100/130/160%) measure a 0px spread, no
   label clipped, no label wrapped, and 33.7-34.6px of clearance. Bottom
   anchoring survives: where there is slack the stats and rail still sit flush at
   the foot of the port (0px below the rail at 320x1024 and 810x1080) with the
   slack above the stats — #114's rule, kept because `.codex-column` is a flex
   column and `.codex-stats`' `margin-top: auto` still resolves inside it.

   What this cannot see, `node --test` having no browser: that the look-closer
   overlay still covers the scene and not the tab bar once the port is scrolled.
   Measured at 393x852 scrolled to the end — the overlay spans 0-761px, exactly
   `.scene-body`, and the bar's top edge is 761. The structural half of that *is*
   checkable and is asserted below: the overlay sits outside the scrollport, or
   it slides away from the scene it is supposed to cover. */
test('Design authority: the Codex roster is one tile width and its lower rails clear the tab bar (#116)', async () => {
  const rules = cssRuleBlocks(await read('src/app/app.css'));
  const rule = (selector) => rules.find((r) => r.selector === selector);

  /* --- one width for every tile ----------------------------------------- */

  const roster = rule('.codex-roster');
  assert.ok(roster, '.codex-roster rule must exist');
  assert.match(
    roster.body,
    /(?:^|;)\s*flex-wrap:\s*wrap\b/u,
    'a fixed tile basis that cannot wrap overflows the row instead — the tiles must be allowed a second line',
  );
  assert.doesNotMatch(
    roster.body,
    /(?:^|;)\s*justify-content:\s*space-between\b/u,
    'space-between strands a lone tile on a wrapped line at the start edge rather than under its row',
  );

  /* Every rule that names the tile, not only the base one: a media query can
     re-open `flex-grow` as easily as the base rule can, and a wrapped line
     holding fewer tiles then grows them wider than the line above. */
  const namesTile = (selector) => selector
    .split(',')
    .some((part) => /(?:^|[\s>+~])\.codex-roster\s+button(?![\w-])/u.test(part.trim()));

  const tileRules = rules.filter((r) => namesTile(r.selector));
  assert.ok(tileRules.length > 0, 'a .codex-roster button rule must exist');

  const shorthands = tileRules
    .map((r) => ({ selector: r.selector, match: r.body.match(/(?:^|;)\s*flex:\s*([^;]+)/u) }))
    .filter((entry) => entry.match);
  assert.equal(
    shorthands.length,
    1,
    'exactly one rule may set the tile flex shorthand, or which one wins depends on source order',
  );

  const [grow, shrink, basis] = shorthands[0].match[1].trim().split(/\s+/u);
  assert.equal(
    grow,
    '0',
    'the tile must not grow: a wrapped line holding fewer tiles would make those tiles wider than '
      + 'the line above it — the same raggedness this ticket is about, one axis over',
  );
  assert.equal(
    shrink,
    '0',
    "the tile must not shrink: `flex-shrink` is floored by each item's own min-content width, so "
      + 'shrinking sizes every tile to its own label — 46.8px beside 90.2px at 320x568',
  );
  assert.match(
    basis ?? '',
    /^[\d.]+(?:rem|em)$/u,
    'the basis must be a font-relative length: a percentage fills the row at 100% text and breaks '
      + '"Undiscovered" mid-word at 160%, where a rem basis re-wraps the row instead',
  );

  for (const candidate of tileRules) {
    assert.doesNotMatch(
      candidate.body,
      /(?:^|;)\s*flex-(?:grow|shrink):\s*(?!0\b)/u,
      `${candidate.selector} must not re-open grow or shrink as a longhand after the shorthand`,
    );
  }

  /* --- the rails clear the tab bar -------------------------------------- */

  const column = rule('.codex-column');
  assert.ok(column, ".codex-column rule must exist — it is the Codex's scrollport content");
  assert.match(column.body, /(?:^|;)\s*display:\s*flex\b/u, '.codex-column must be a flex container');
  assert.match(
    column.body,
    /(?:^|;)\s*flex-direction:\s*column\b/u,
    "a flex *column* is what keeps `.codex-stats`' `margin-top: auto` resolving, so the rails stay "
      + 'bottom-anchored where there is slack (#114) instead of leaving trailing backdrop below them',
  );

  assert.match(
    rule('.codex-stats')?.body ?? '',
    /(?:^|;)\s*margin-top:\s*auto\b/u,
    "the stats trio and the rail below it are the Codex's bottom-anchored region (#114)",
  );

  assert.match(
    rule('.scene-scroll')?.body ?? '',
    /(?:^|;)\s*overflow-y:\s*auto\b/u,
    'the shared scrollport is what the Codex now leans on; if it stops scrolling, the rail goes '
      + 'straight back off the bottom of an iPhone SE',
  );

  /* The structure: the roster, stats and rail scroll; the look-closer overlay
     does not. `.codex-zoom` is `position: absolute; inset: 0` against
     `.scene-body`, so inside the scrollport it would size to the scrollable area
     and slide away from the scene the moment a child scrolled. */
  const jsx = await read('src/app/ProductApp.jsx');
  const open = jsx.indexOf('<div className="scene-scroll codex-column">');
  assert.ok(open >= 0, 'the Codex content must sit in a `scene-scroll codex-column` wrapper');

  const tags = /<div\b[^>]*?(\/?)>|<\/div>/gu;
  tags.lastIndex = open;
  let depth = 0;
  let close = -1;
  for (let match = tags.exec(jsx); match; match = tags.exec(jsx)) {
    if (match[0].startsWith('</')) depth -= 1;
    else if (match[1] !== '/') depth += 1;
    if (depth === 0) {
      close = match.index;
      break;
    }
  }
  assert.ok(close > open, 'the codex-column wrapper must close');

  for (const inside of ['codex-roster', 'codex-stats', 'codex-ladder']) {
    const at = jsx.indexOf(`className="${inside}`);
    assert.ok(
      at > open && at < close,
      `.${inside} must render inside the scrollport — it is one of the regions that fell off the bottom`,
    );
  }

  const zoomAt = jsx.indexOf('className="codex-zoom"');
  assert.ok(
    zoomAt > close,
    'the look-closer overlay must sit outside the scrollport rather than scrolling with it',
  );
});

test('Design authority: the Field Record topline keeps its own band and the stat trio seats whole labels (#117)', async () => {
  const css = await read('src/app/app.css');
  const rules = cssRuleBlocks(css);
  const rule = (selector) => rules.find((r) => r.selector === selector);
  /* One rem is one root font size, and the root font size is what Dynamic Type
     moves. Every length compared here is compared at 100% text, where the
     px-valued animation it has to clear is also authored. */
  const REM = 16;
  const lengthPx = (value) => {
    const match = /^([\d.]+)(rem|em|px)$/u.exec(value.trim());
    if (!match) return null;
    return match[2] === 'px' ? Number(match[1]) : Number(match[1]) * REM;
  };

  /* --- the topline's band ------------------------------------------------ */

  const namesArt = (selector) => selector
    .split(',')
    .some((part) => /(?:^|[\s>+~])\.results-halo\s+img(?![\w-])/u.test(part.trim()));
  const artRules = rules.filter((r) => namesArt(r.selector));
  assert.ok(artRules.length > 0, 'a .results-halo img rule must exist');

  const margins = artRules
    .map((r) => ({ selector: r.selector, match: /(?:^|;)\s*margin-top:\s*([^;]+)/u.exec(r.body) }))
    .filter((entry) => entry.match);
  assert.equal(
    margins.length,
    1,
    'exactly one rule may set the companion art margin-top, or which one wins depends on source '
      + 'order — and the losing one is the band this ticket is about',
  );

  const band = lengthPx(margins[0].match[1]);
  assert.ok(
    band !== null && band > 0,
    'the companion art must start below the topline, not tucked up under it: `-0.75rem` drew opaque '
      + 'sprite over the letterforms of "Expedition logged" on every screen measured — 45.7 css px2 '
      + 'at 393x852 and 100% text, 341.9 at 320x568 and 160%. A positive margin is the only form of '
      + 'this that holds for a companion nobody has drawn yet, because ink cannot leave its own box',
  );

  /* The band has to survive the art's own idle animation, which is authored in
     px and so does not grow with the text the way the band does. */
  const floatFrames = /@keyframes\s+float\s*\{([\s\S]*?)\n\}/u.exec(stripCssComments(css));
  assert.ok(floatFrames, '@keyframes float must exist — it is what the band has to clear');
  const lifts = [...floatFrames[1].matchAll(/translateY\(\s*(-?[\d.]+)px\s*\)/gu)]
    .map((match) => -Number(match[1]))
    .filter((amount) => amount > 0);
  const lift = Math.max(0, ...lifts);
  assert.ok(
    band >= lift,
    `the band (${band}px at 100% text) must clear the ${lift}px the float animation lifts the art, `
      + 'or the topline is overlapped once a cycle rather than never',
  );

  /* --- the stat trio ---------------------------------------------------- */

  const tally = rule('.record-tally');
  assert.ok(tally, '.record-tally rule must exist');

  const columns = /(?:^|;)\s*grid-template-columns:\s*([^;]+)/u.exec(tally.body);
  assert.ok(
    columns && /(?:^|;)\s*display:\s*grid\b/u.test(tally.body),
    'the trio must be a grid: a flex row equalises three cells on a zero basis regardless of what '
      + 'they have to say, which is what wrapped "WORDS WALKED" onto a second line on every phone '
      + 'while its neighbours sat half empty',
  );

  const track = /repeat\(\s*auto-fit\s*,\s*minmax\(\s*([\d.]+(?:rem|em|px))\s*,\s*1fr\s*\)\s*\)/u
    .exec(columns[1]);
  assert.ok(
    track,
    'the tracks must be `repeat(auto-fit, minmax(<floor>, 1fr))`. auto-fit is what drops the trio '
      + 'to two tracks, then one, as the labels grow, and it collapses the tracks no cell lands in '
      + `so a wide screen still shows three across. Found: ${columns[1].trim()}`,
  );
  assert.match(
    track[1],
    /(?:rem|em)$/u,
    'the track floor must be font-relative: a px floor holds its width while the label inside it '
      + 'grows with Dynamic Type, so the strip seats a column too many and the label wraps again',
  );
  assert.ok(
    lengthPx(track[1]) >= 90,
    'the track floor must be at least the 90px "WORDS WALKED" measures at 100% text — the longest '
      + 'label the strip has to seat. Below it the grid keeps a column it cannot fill: at 5rem the '
      + '320x568 strip holds two 107.5px tracks at 130% text and asks 117px of label to sit in one',
  );

  const cell = rule('.record-tally div');
  assert.ok(cell, '.record-tally div rule must exist');
  assert.match(
    cell.body,
    /(?:^|;)\s*flex-direction:\s*column\b/u,
    'the figure must stack over its label, or the label gets the cell minus the figure and the '
      + 'track floor has to be wider than any phone can give it',
  );
  assert.doesNotMatch(
    cell.body,
    /(?:^|;)\s*flex(?:-basis|-grow|-shrink)?:/u,
    'a flex shorthand on a grid item is the equalisation that caused this: `flex: 1` gave all three '
      + 'cells one width no matter what they had to say',
  );

  assert.equal(
    rules.filter((r) => /\.record-tally\s+div\s*\+\s*div/u.test(r.selector)).length,
    0,
    'a `div + div` separator cannot know which cell begins a grid row, so it draws a rule down the '
      + 'left edge of a wrapped line — the column gap carries the separation instead',
  );

  assert.match(
    rule('.record-tally .label')?.body ?? '',
    /(?:^|;)\s*overflow-wrap:\s*normal\b/u,
    'a stat label breaks between its words or not at all, the rule `.round-foot p` already carries: '
      + "left to the product's `overflow-wrap: anywhere`, a cell one pixel short of \"CORRECT\" "
      + 'renders it a letter per line — 6, 6 and 11 lines at 320x568 and 160% text, 250.2px of strip',
  );

  /* --- the way out stays on the screen ---------------------------------- */

  /* Seating whole labels costs height, and the results scene clips: on `main`
     the record already pushed Walk again and Trail entirely off six of the nine
     phone cells and left 0.5% of the primary at 320x568 and 100% text. The
     growth has to land in a port, and the actions have to sit outside it. */
  assert.match(
    rule('.results-column')?.body ?? '',
    /(?:^|;)\s*flex-direction:\s*column\b/u,
    'the port must be a flex column, or `.results-halo`\'s `flex: 1` stops resolving and the '
      + 'companion is no longer centred on a screen with room to spare',
  );

  const jsx = await read('src/app/ProductApp.jsx');
  const open = jsx.indexOf('<div className="scene-scroll results-column">');
  assert.ok(
    open >= 0,
    'the record must sit in a `scene-scroll results-column` port — `.product-scene` is '
      + '`overflow: hidden`, so without one every pixel the record grows is taken off the exit',
  );

  const tags = /<div\b[^>]*?(\/?)>|<\/div>/gu;
  tags.lastIndex = open;
  let depth = 0;
  let close = -1;
  for (let match = tags.exec(jsx); match; match = tags.exec(jsx)) {
    if (match[0].startsWith('</')) depth -= 1;
    else if (match[1] !== '/') depth += 1;
    if (depth === 0) {
      close = match.index;
      break;
    }
  }
  assert.ok(close > open, 'the results-column port must close');

  for (const inside of ['results-halo', 'field-record']) {
    const at = jsx.indexOf(`className="${inside}"`);
    assert.ok(
      at > open && at < close,
      `.${inside} must scroll inside the port — it is what grows when a stat label takes a track `
        + 'of its own or a return roll runs long',
    );
  }
  assert.ok(
    jsx.indexOf('className="results-actions"') > close,
    'the actions must sit outside the port as the scene\'s foot. Inside it they scroll away again, '
      + 'and the Celebration tier requires the way out to arrive with the screen',
  );
});

/* Practice setup deleted its own kicker (#245).

   `.setup-quest` was `flex: 1; min-height: 0; justify-content: flex-end` with
   `overflow: visible clip` inside a 100dvh column. Clipping at flex-end takes
   the TOP first, so any growth below the hero — a wrapped vocabulary rail, a
   taller tray, Dynamic Type — was paid for by deleting "TODAY'S QUEST", then
   the top of the h1. Already firing on `main` at 320×568 / 100% (kicker 55.2px
   gone, h1 52.0px cut). 375×667 / 100% survived by 0.0px.

   Scrolling only the quest copy is not enough: at 320×568 / 160% the hero was
   allocated 0px, so a port inside it still could not show a complete h1. The
   heading is therefore flex-none (kicker + h1 cannot shrink), slack is a
   separate `flex: 1 1 0` spacer so the title still sits on the tiles where
   there is room (#114), the brief and tiles scroll, and the tray shrinks
   (`flex: 0 1 auto`) with Set off pinned below a controls port.

   A source assertion, not a rendered one. `node --test` has no browser, so
   this cannot see that the heading actually paints inside the viewport at
   320×568 / 160%. Only a layout engine shows that. */
test('Design authority: the Practice setup hero scrolls instead of clipping its kicker (#245)', async () => {
  const css = await read('src/app/app.css');
  const jsx = await read('src/app/ProductApp.jsx');
  const rules = cssRuleBlocks(css);
  const rule = (selector) => rules.find((r) => r.selector === selector);

  const slack = rule('.setup-slack');
  assert.ok(slack, '.setup-slack must exist — it is the painted sky, not a flex-end clip');
  assert.match(
    slack.body,
    /(?:^|;)\s*flex:\s*1 1 0\b/u,
    'slack must grow from a zero basis so it is the first thing to disappear under pressure',
  );
  assert.match(
    slack.body,
    /(?:^|;)\s*min-height:\s*0\b/u,
    'slack must be allowed to vanish; a content minimum would steal height from the heading',
  );

  const heading = rule('.setup-heading');
  assert.ok(heading, '.setup-heading must exist — it is what keeps the kicker and h1 on screen');
  assert.match(
    heading.body,
    /(?:^|;)\s*flex:\s*none\b/u,
    'the heading must not shrink: a flex-1 hero at 320×568 / 160% was allocated 0px',
  );

  const quest = rule('.setup-quest');
  assert.ok(quest, '.setup-quest rule must exist — it is the brief-and-tiles scrollport content');
  assert.match(quest.body, /(?:^|;)\s*min-height:\s*0\b/u, '.setup-quest must be allowed to shrink so the heading keeps its automatic minimum');
  for (const candidate of rules.filter((r) => r.selector === '.setup-quest')) {
    assert.doesNotMatch(
      candidate.body,
      /(?:^|;)\s*overflow:\s*visible\s+clip\b/u,
      `${candidate.selector} must not restore the flex-end clip`,
    );
    assert.doesNotMatch(
      candidate.body,
      /(?:^|;)\s*justify-content:\s*flex-end\b/u,
      `${candidate.selector} must not restore flex-end alignment`,
    );
  }

  assert.match(
    rule('.setup-scene .scene-body')?.body ?? '',
    /(?:^|;)\s*flex:\s*none\b/u,
    'setup\'s scene-body is chrome only; if it grows, it swallows the column and Set off leaves the screen',
  );

  const controls = rule('.setup-tray-controls');
  assert.ok(controls, '.setup-tray-controls must exist — it is how the rails give visibly');
  assert.match(
    controls.body,
    /(?:^|;)\s*flex:\s*0 1 auto\b/u,
    'the rails must be allowed to shrink — at 320×568 / 160% they are 311px and will not give otherwise',
  );
  assert.match(
    controls.body,
    /(?:^|;)\s*overflow-y:\s*auto\b/u,
    'the rails must scroll so Set off can stay pinned below them',
  );
  assert.match(
    controls.body,
    /(?:^|;)\s*min-height:\s*3\.25rem\b/u,
    'a 0-height controls port is silent deletion; one row must remain reachable',
  );

  const go = rule('.setup-go');
  assert.ok(go, '.setup-go must exist — it is the pinned Set off foot');
  assert.match(
    go.body,
    /(?:^|;)\s*flex:\s*none\b/u,
    'Set off must not shrink or scroll away',
  );

  assert.match(
    rule('.scene-scroll')?.body ?? '',
    /(?:^|;)\s*overflow-y:\s*auto\b/u,
    'the shared scrollport is what the brief and tiles now lean on',
  );

  const hero = rule('.setup-hero');
  assert.ok(hero, '.setup-hero must exist — it is the overlay parent that keeps the 1rem bleed');
  assert.match(
    hero.body,
    /(?:^|;)\s*min-height:\s*0\b/u,
    'the hero must shrink below the tiles; otherwise the heading\'s sibling slot cannot save Set off',
  );
  assert.match(
    hero.body,
    /(?:^|;)\s*padding-right:\s*1rem\b/u,
    'the overlay\'s padding is the 1rem gutter bleed, so x can clip without `visible clip`',
  );
  assert.match(
    hero.body,
    /(?:^|;)\s*margin-right:\s*-1rem\b/u,
    'negative margin spends that padding in the scene-body gutter rather than insetting the heading',
  );
  assert.match(
    rule('.setup-hero img')?.body ?? '',
    /(?:^|;)\s*right:\s*0\b/u,
    'the sprite sits on the overlay padding edge, not at `right: -1rem` inside a hidden-x port',
  );

  assert.doesNotMatch(
    css,
    /clipping at flex-end takes the TOP/u,
    'the `.setup-quest` comment must no longer describe the flex-end clip it replaced',
  );

  const headingOpen = jsx.indexOf('<div className="setup-heading">');
  assert.ok(headingOpen >= 0, 'the kicker and h1 must live in a `setup-heading` that is flex-none');
  const heroOpen = jsx.indexOf('<div className="setup-hero">');
  const kickerAt = jsx.indexOf('Today&apos;s quest', headingOpen);
  const titleAt = jsx.indexOf('id="setup-title"', headingOpen);
  const portOpen = jsx.indexOf('<div className="scene-scroll setup-quest">');
  assert.ok(
    headingOpen < heroOpen,
    'the heading must be a sibling of the hero, not a child — a nested heading cannot beat the hero\'s min-content size',
  );
  const bodyOpen = jsx.indexOf('<div className="scene-body">');
  const slackAt = jsx.indexOf('className="setup-slack"');
  assert.ok(
    slackAt > bodyOpen && jsx.indexOf('className="setup-chrome"') > bodyOpen,
    'chrome stays in scene-body for the top gutter',
  );
  assert.ok(
    slackAt > jsx.indexOf('</div>', jsx.indexOf('setup-chrome')),
    'slack, heading and hero must sit outside scene-body so the body cannot take the tiles as its minimum',
  );
  assert.ok(portOpen > headingOpen, 'the heading must sit above the scrollport, not inside it');
  assert.ok(
    kickerAt > headingOpen && kickerAt < portOpen,
    'the kicker must sit in the heading — inside the port it is the first thing a short hero deletes',
  );
  assert.ok(
    titleAt > headingOpen && titleAt < portOpen,
    'the h1 must sit in the heading — a 0px hero cannot show a complete title from inside a port',
  );

  const tags = /<div\b[^>]*?(\/?)>|<\/div>/gu;
  tags.lastIndex = portOpen;
  let depth = 0;
  let close = -1;
  for (let match = tags.exec(jsx); match; match = tags.exec(jsx)) {
    if (match[0].startsWith('</')) depth -= 1;
    else if (match[1] !== '/') depth += 1;
    if (depth === 0) {
      close = match.index;
      break;
    }
  }
  assert.ok(close > portOpen, 'the setup-quest port must close');

  const tilesAt = jsx.indexOf('className="quest-tiles"');
  assert.ok(
    tilesAt > portOpen && tilesAt < close,
    'the quest tiles must sit inside the port so they can give visibly under the heading',
  );

  const controlsAt = jsx.indexOf('className="setup-tray-controls"');
  const goAt = jsx.indexOf('className="setup-go"');
  assert.ok(controlsAt > close, 'the rails must sit outside the quest port as a scene-column sibling');
  assert.ok(
    goAt > controlsAt,
    'Set off must live in setup-go after the rails, so the rails can shrink without moving the button',
  );
  assert.doesNotMatch(
    jsx,
    /className="setup-tray"/u,
    'do not wrap the rails and Set off in one box — display:contents did not promote the children into the scene flex',
  );

  const artAt = jsx.indexOf("className={companion.found ? undefined : 'companion-asleep'}");
  assert.ok(
    artAt >= 0 && artAt < portOpen,
    'companion art must sit outside the quest port — `.scene-scroll` overflow-x: hidden clips the bleed',
  );
});

/* The parent area opened 130px down and said its own name twice (#118).

   Both halves are one defect: a container and its first child each claiming the
   same safe-area inset. `.product-page` pads the notch, and `.product-topbar` —
   which is only ever that page's first child — padded it again, so the notch was
   counted twice. Measured in the harness at 393x852 with the iPhone 17 insets
   the harness sets (`--safe-area-inset-top: 59px`):

     title's first pixel   130px -> 84.2px   (dead band 71px -> 12px)
     title's left edge     x=32 -> x=16      (the cards below start at x=16)
     first card's top      296.4px -> 208.8px

   The horizontal half was never reported and is the same arithmetic: the bar's
   own `max(1rem, inset-left)` set the title one gutter inside the cards it
   heads. Both go away by deleting the bar's padding, not by tuning it — the bar
   is never the surface that meets the screen edge, so it has no inset to spend.
   Its two other sites gain the same correction: the parent gate, and the
   startup-failure screen, whose `.scene-body` container pads `--gutter-top`.

   The name is now stated once, by the bar, as the screen's `h1` —
   `aria-labelledby` already pointed at that name, so the accessible name is
   unchanged. Deleting the heading instead was not open: the h1-per-screen check
   gates one `h1` per screen with no baseline since #113. The parent *gate* is
   left alone, because it was already the right shape and is the model for this
   fix — its bar names the place ("Parent access") over an `h1` that names the
   task ("Enter Parent PIN"), which is two facts, not one stated twice.

   Held at 320x568 and 393x852 across 100/130/160% text: the title stays on one
   line, Done holds 44x44 or better (58x44, 75.4x57.2, 92.8x70.4), the two never
   overlap, and nothing scrolls horizontally. */
test('Design authority: the top bar spends no gutter of its own, and the parent area states its name once (#118)', async (t) => {
  const rules = cssRuleBlocks(await read('src/app/app.css'));
  const rule = (selector) => rules.find((r) => r.selector === selector);

  const bar = rule('.product-topbar');
  assert.ok(bar, '.product-topbar rule must exist');
  assert.doesNotMatch(
    bar.body,
    /safe-area-inset/u,
    '.product-topbar must claim no safe-area inset: every site renders it inside a container '
      + 'that has already spent the gutter, so a second claim counts the notch twice (130px of '
      + 'empty paper above the title at 393x852) and sets the title one gutter inside its cards',
  );

  /* The other way to reach the same screen: if the containers stopped padding,
     the bar would sit under the notch instead of below a doubled one. */
  for (const selector of ['.product-page', '.scene-body']) {
    const container = rule(selector);
    assert.ok(container, `${selector} rule must exist`);
    assert.match(
      container.body,
      /padding:[^;]*(?:safe-area-inset-top|--gutter-top)/u,
      `${selector} hosts .product-topbar and must be the one that spends the top gutter — `
        + 'with neither of them padding, the bar renders under the notch',
    );
  }

  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: join(ROOT, 'vite.config.js'),
    server: { middlewareMode: true },
    appType: 'custom',
  });
  t.after(() => vite.close());

  const { ParentArea } = await vite.ssrLoadModule('/src/app/ProductApp.jsx');
  assert.equal(
    typeof ParentArea,
    'function',
    'ParentArea must be exported from ProductApp.jsx for this check to measure it',
  );

  const noop = () => {};
  const asyncNoop = async () => {};
  const html = renderToStaticMarkup(React.createElement(ParentArea, {
    state: {
      status: 'unlocked',
      biometric: { available: false, type: 'none', enabled: false },
    },
    profiles: [],
    progressState: { status: 'ready', learners: [], actionError: null },
    commerceState: {
      status: 'ready',
      displayPrice: '£9.99',
      entitlementState: 'none',
      packState: 'missing',
      action: null,
      actionError: null,
    },
    onClose: noop,
    onSetPin: asyncNoop,
    onResetPin: asyncNoop,
    onUnlockPin: asyncNoop,
    onUnlockBiometrics: asyncNoop,
    onSetBiometricsEnabled: asyncNoop,
    onEditProfile: asyncNoop,
    onRemoveProfile: asyncNoop,
    onResetLearning: asyncNoop,
    onRefreshProgress: asyncNoop,
    onPurchase: asyncNoop,
    onRestore: asyncNoop,
    onDownload: asyncNoop,
    onRecoverCommerce: asyncNoop,
  }));

  /* Rendered text, not source: a JSX scan reads the two literals as two
     statements even when only one of them reaches the screen. */
  const statements = html.match(/>Parent area</gu) ?? [];
  assert.equal(
    statements.length,
    1,
    'the unlocked parent area must state its name exactly once — the sticky bar and the heading '
      + `below it both read "Parent area" at #118 (found ${statements.length})`,
  );

  const heading = html.match(/<h1\b[^>]*>([^<]*)<\/h1>/u);
  assert.ok(heading, 'the unlocked parent area must render an h1');
  assert.equal(
    heading[1],
    'Parent area',
    'the one statement of the name must be the h1, so removing the duplicate does not cost the '
      + 'screen its heading',
  );
  assert.match(
    heading[0],
    /\bid="parent-title"/u,
    'the h1 must keep id="parent-title" — <main aria-labelledby="parent-title"> resolves to it, '
      + 'so the accessible name survives the move into the bar',
  );
  assert.match(
    html,
    /<header class="product-topbar"><h1\b/u,
    'the surviving statement must be the bar\'s own title, first in document order',
  );
});
