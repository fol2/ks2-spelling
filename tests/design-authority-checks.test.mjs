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
  assert.match(baselineContent, /#113/u);
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

/* Wrapping alone does not settle the Practice setup rail. That screen is a
   fixed-height composition whose hero is `flex: 1; min-height: 0` with a
   flex-end clip, so every pixel the tray gains it takes off the TOP of the
   hero — a second rail row there costs the "TODAY'S QUEST" kicker and 11px of
   the h1 at 393x852. Spelling "words" out on all three set pills ran the row
   378px wide; the bare count fits 288px, so the row never needs to wrap at any
   supported width and the hero is untouched. The noun moves into the
   accessible name, which is what a screen reader announces either way.

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
