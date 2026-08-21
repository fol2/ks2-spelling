# Visual authority baseline: Known E5.1 violations

Baseline file: One entry per known violation as of 2026-08-17.

The design check asserts "no new violations beyond this baseline", never "zero violations".

A violation is new if: (1) unlisted in this file, or (2) its location or clause differs from an entry here.

## Layer 2: Machine-checkable violations

### One h1 per screen — retired at #113

No entry. The clause is clean, so `tests/design-authority-h1-per-screen.test.mjs`
now gates it outright rather than measuring it against a baseline.

Both entries this section once held were written against
`src/app/learner-switch/LearnerSwitchSheet.jsx` and
`src/app/first-run/FirstRunScene.jsx` — paths that have never existed on any
branch, which the h1 check loaded inside a `try` and skipped on failure. Neither
screen was measured. Corrected at #110, which gave first run a welcome heading
and retired its entry. #113 gave the learner switch its own `h1`, retiring the
last one, and extended the check from six screens to every product screen — all
seventeen `h1` sites in `src/app/ProductApp.jsx` now fail a mutation. Live
`- **Location**:` lines must resolve to a file that exists in the tree;
`tests/design-authority-checks.test.mjs` now fails them if they do not.

## Layer 3: Design composition violations (manual review)

### Backdrop proportion — the round and camp entries retired at #114

Both entries were written against `src/app/Round.jsx` and `src/app/Camp.jsx`,
paths that have never existed on any branch — the whole product surface is one
file, `src/app/ProductApp.jsx`. Same family as the two h1 entries above and the
rest of #242: the violation was real and the address was not, so nothing could
ever have been checked at it.

Measured, and then fixed, at their real locations. The round's trailing
backdrop fell from 36.5% of a 393x852 phone to 4.0%, and camp's from 19.1%
(asleep) and 12.6% (awake) to 4.0%, by anchoring each scene's action region
from the bottom. The rule is now gated outright by
`tests/design-authority-checks.test.mjs`, which also forbids the centred-card
variant that satisfies the proportion by moving the answer field.

The Parent entry carried the same clause at `src/app/Parent.jsx`, a third
address that does not exist; it is retired at #118 below.

### Label baseline — the dictation-disclosure entry retired at #115

The entry named `src/app/Round.jsx:dictation-disclosure`, a path that has never
existed on any branch — the round card is `src/app/ProductApp.jsx`
(`RoundScreen`) and the row is `.round-foot` in `src/app/app.css`. Retired
rather than relocated, the same fictional-location family as #242 and the #111,
#112 and #114 entries above.

The defect it named is fixed, and it was larger than the entry said. The foot
never wrapped, so the caption — the only flexible item in a row whose pills are
`flex: none` — absorbed the whole shortfall: 214.7px of copy into 126.8px at
393×852, orphaning "voice"; and, under the product-wide `overflow-wrap:
anywhere`, 12.4px at 160% text, one letter per line, 525px tall. The row now
wraps *backwards*, so the caption takes a line below the pills and the pills
hold `main`'s position to the pixel — a squeezed round sheds the footnote, never
the way out. Contract test:
`tests/design-authority-checks.test.mjs` ("the round foot wraps backwards").

### Practice setup hero — the #245 entry retired at #245

The entry named `src/app/app.css` (`.setup-quest`: `flex: 1; min-height: 0`
clipped at flex-end deletes the kicker, then the top of the h1). That path is
real, unlike the fictional-path family at #242.

The defect it named is fixed. Clipping at flex-end took the TOP of the block
first, so any growth below the hero was paid for by deleting "TODAY'S QUEST",
then the top of the h1 — **55.2px of kicker and 52.0px of title already gone at
320×568 and 100% text**, and 375×667 survived by 0.0px. A port around only the
quest copy is not enough: at 320×568 and 160% text that hero was allocated
**0px**, so the kicker still could not show. The heading is now flex-none,
slack is a `flex: 1 1 0` spacer so the title still sits on the tiles where
there is room (#114), the brief and tiles scroll, and the tray shrinks with
Set off pinned below a controls port. Companion art is a sibling of the quest
port so its 1rem gutter bleed is not clipped by `overflow-x: hidden`. Contract
test: `tests/design-authority-checks.test.mjs` ("the Practice setup hero
scrolls instead of clipping its kicker").

### Tile consistency — the Codex roster entry retired at #116

The entry named `src/app/codex/CodexRoster.jsx`, a path that has never existed
on any branch — there is no `src/app/codex/` directory, and the roster is
`.codex-roster` in `src/app/app.css` rendered from `src/app/ProductApp.jsx`
(`CodexScreen`). Retired rather than relocated, the same fictional-location
family as #242 and the #111, #112, #114 and #115 entries.

The defect it named was real. `flex: 1 1 5.25rem` shares the row where there is
slack, but under negative free space `flex-shrink` is floored by each item's
automatic minimum size — its own min-content width — so every tile stopped at
the width of its own label: 001 Inklet 46.8px beside 003 Undiscovered 90.2px at
320×568, a 43.4px spread, rising to 68.4px at 160% text. The tiles now take one
fixed `rem` basis and the row wraps, measuring a **0px spread in all fifteen
cells** (320×568, 320×1024, 375×667, 393×852, 810×1080 × 100/130/160%) with no
label clipped and none broken mid-word. Contract test:
`tests/design-authority-checks.test.mjs` ("the Codex roster is one tile width").

### Rail clearance — the Codex entry retired at #116

The two #111 entries named `src/app/Setup.jsx:filter-rail` and
`src/app/Setup.jsx:vocabulary-rail` — a path that has never existed on any
branch, and the filter rail is on the Words screen, not Setup — so both are
retired rather than relocated, the same fictional-location family as #242.

The #116 entry named `src/app/codex/CodexRoster.jsx:lower-rails`, fictional for
the same reason, and it understated the defect. The Codex was the one place
screen that never took the shared scrollport, so at 100% text the threshold rail
measured **0 of its 24.8px visible at both 375×667 and 320×568** — 159.2px and
271.7px past the tab bar's top edge, on a scene with `overflow: hidden` and
nothing to scroll, which also put the roster and the stats trio out of reach. A
child on an iPhone SE could not select a companion. At 393×852 the rail kept
23.4px rather than the 34px gutter, having already eaten 10.6px of it. The Codex
now takes `.scene-scroll`, and clearance measures **33.7–34.6px in all fifteen
cells** with the rail wholly visible in every one. Bottom anchoring survives
(#114): where there is slack the stats and rail still sit flush at the foot of
the port. Same contract test as above.

The remaining #256 label-baseline entry is retired. Eight milestones now use a
full-width four-column, two-row grid below 46rem and retain eight columns on a
tablet; the squeezed `flex: 1; min-width: 0` composition is gone. Both the
milestone figures and the stats labels override the product-wide
`overflow-wrap: anywhere` with `normal`, so labels wrap only at word boundaries.
The runtime evidence is recorded in
`docs/records/2026-08-21-codex-rail-text-pressure.md`. Structural contract test:
`tests/design-authority-checks.test.mjs` ("the Codex source declares compact and
tablet milestone grids with whole-label wrapping").

### Fact singularity & other composition

The #112 entry named `src/app/Feedback.jsx` — a path that has never existed on
any branch; the round card is `src/app/ProductApp.jsx` (`RoundScreen`). It is
retired rather than relocated, the same fictional-location family as #242 and
the two #111 rail entries, because the defect it named is fixed: correction
guidance now renders above the primary action and the learner's attempt is shown
beside the target. Contract test: `tests/round-feedback-order.test.mjs`.

- **Location**: `src/app/app.css` (`.round-scene .scene-body`: a fixed non-scrolling column, so the quiet exit falls off the bottom — 16.4px of `.round-foot` already gone at 375×667 and 100% text, all 44px at 393×852 and 130%)
- **Clause**: Contract — Layer 2 — Reference layouts (Practice — quiet exit)
- **Issue link**: #249
- **Status**: `todo`

### Field Record — the #117 entry retired at #117

The entry named `src/app/Results.jsx:stat-trio`, a path that has never existed
on any branch — the summary screen is `src/app/ProductApp.jsx`
(`ResultsScreen`), the strip is `.record-tally` in `src/app/app.css` and the
topline is `.results-halo`. Retired rather than relocated, the same fictional
location family as #242 and the #111, #112, #114, #115 and #116 entries above.

Of the three defects the ticket named, **two were real and one was not**.

*The topline overlap is real, on every screen measured.* `.results-halo img`
carried `margin-top: -0.75rem`, tucking the companion up under "Expedition
logged" — opaque sprite crossed the letterforms in all twelve cells, 45.7 css
px² at 393×852 and 100% text through 341.9 px² at 320×568 and 160%, before the
`float` animation lifts the art a further 5px once a cycle. The margin is now
positive, so the art's *box* starts below the label and ink cannot leave its
box: clearance measures **10.2–17.8px in all twelve cells**, and it holds for a
companion nobody has drawn yet, which is what the ticket's "every companion
stage and every roster member" asks for.

*The ragged trio is real; its stated mechanism is not.* The three cells never
differed in height and the row's baseline never broke — `.record-tally` is a
flex row, so `align-items: stretch` had already equalised them, and figures and
labels shared a baseline to the pixel in every cell measured. What was true is
worse than what was written: `flex: 1` on a zero basis gave all three cells one
width regardless of what they had to say, so "WORDS WALKED" (90px) wrapped to
two lines on every phone at 100% text while its neighbours sat half empty, and
under Dynamic Type the product-wide `overflow-wrap: anywhere` shredded rather
than wrapped — **6, 6 and 11 lines at 320×568 and 160%, a 250.2px strip**, a
quarter of the phone spent on three numbers. The trio is now an `auto-fit` grid
over a 5.75rem floor with the label stacked under its figure and
`overflow-wrap: normal`: **every label sits on one line in all twelve cells**,
three across where three fit and two, then one, where they do not, each cell
keeping its track width on a wrapped row.

*The triple statement is real, on the card above the sheet.* Not the Field
Record: `celebrationProgressMeterCopy` was called twice into the same
celebration card — once through the stage label, once through the meter copy —
beside the bar that draws the same figure. One predicate now decides it, so the
meter states the count and the gain and the prose states neither, and where
there is no meter both come back rather than the card stating them nowhere.

*Surfaced by the fix, and larger than the ticket:* the results scene has no
scrollport, and `.product-scene` is `overflow: hidden`, so every pixel the
record grows is taken off the way out. On `main` **Walk again and Trail are
wholly off the screen in six of the nine phone cells** — 320×568 at 130% and
160%, 375×667 at 130% and 160%, 393×852 at 160% — and at 320×568 and 100% text
0.5% of the primary button is left. Seating whole stat labels would have taken
that last sliver, so this slice gives the record the shared `.scene-scroll`
port and keeps the actions outside it as the scene's foot: **100% visible in
all twelve cells**, on both buttons. Same shape as the Codex at #116, and the
same defect `#249` records for the round scene.

Contract test: `tests/design-authority-checks.test.mjs` (topline band, stat trio
and the exit) and `tests/product-celebrations.test.mjs` (fact singularity).
Nineteen mutations of the fix were watched go red.

### Trail companion plate — the #109 entry retired at #242

The entry named `src/app/Trail.jsx:companion-plate`, a path that has never
existed on any branch — the Trail is `src/app/ProductApp.jsx` (`TrailScreen`)
and the sprite is `.trail-companion-art` in `src/app/trail/trail-meadow.css`.
Retired rather than relocated, the same fictional-location family as #242 and
the #111, #112, #114, #115, #116, #117 and #118 entries.

The defect it named is already fixed. The status was still `accepted`
("deferred to post-E5 native iOS hardening slice") after PR #240 / `a967ac11`
had already taken the filter off `.trail-companion-art` and moved the depth
into `.trail-companion-shadow`. Relocating a stale waiver onto a real path
would have re-licensed a defect the tree no longer has. Contract test:
`tests/trail-meadow-contract.test.mjs` ("no CSS filter reaches the companion
sprite").

### Parent area — the entry retired at #118

The entry named `src/app/Parent.jsx`, a path that has never existed on any
branch — the parent surface is `src/app/ProductApp.jsx` (`ParentArea`) and the
bar is `.product-topbar` in `src/app/app.css`. Retired rather than relocated,
the same fictional-location family as #242 and the #111, #112, #114, #115, #116
and #117 entries above.

**Both clauses were one defect.** A container and its first child each claimed
the same safe-area inset: `.product-page` spent the top gutter, and
`.product-topbar` — which is only ever that page's first child — spent it again,
so the notch was counted twice. Measured at 393×852 against the iPhone 17 insets
the harness sets, the title's first pixel sat **130px** down, of which 71px was
unexplained. The horizontal half was never reported and is the same arithmetic:
the bar's own `max(1rem, inset-left)` set the title at x=32 while every card it
heads started at x=16.

The fix deletes the bar's padding rather than tuning it, because the bar is
never the surface that meets the screen edge — the rule `--gutter-*` already
states. Its two other sites gain the same correction: the parent gate, and the
startup-failure screen inside `.scene-body`. Title's first pixel **130px →
84.2px**, dead band **71px → 12px**, title **x=32 → x=16**, first card
**296.4px → 208.8px** — 10% of the screen returned.

*The title is now stated once, by the bar, as the screen's `h1`.* Deleting the
heading instead was not open: the h1-per-screen check has gated one `h1` per
screen with no baseline since #113, so the name had to move rather than go.
`<main aria-labelledby="parent-title">` already pointed at that name and still
resolves, so the accessible name is unchanged. **The parent *gate* is left
alone** — it was already the right shape and is the model this fix copies: its
bar names the place ("Parent access") over an `h1` that names the task ("Enter
Parent PIN"), which is two facts, not one stated twice.

Held at 320×568 and 393×852 across 100/130/160% text: the title stays on one
line, Done holds 44×44 or better (58×44, 75.4×57.2, 92.8×70.4), the two never
overlap and nothing scrolls horizontally.

Contract test: `tests/design-authority-checks.test.mjs`. Six mutations of the
fix were watched go red. `tests/app-shell.test.mjs` pinned the literal
`.product-topbar p` selector and had to be moved to the real one — widening it
to a loose match would have left it green against anything.

### Out-of-scope (resolved by this slice)

- #119 — Data-hero-tone falsehood: Fixed in v2-visual-authority.md; removed sentence, documented real tone mechanism and screen lists.
- #112 — Round card feedback order: **fixed**. Correction guidance renders above
  the primary action in the DOM, so reading and focus order reach the result
  before Continue, and `feedback.attemptedAnswer` is shown beside the target in
  one grid. It stays below the answer field, which never moves. Contract test:
  `tests/round-feedback-order.test.mjs`.
- #110 — First run regions: **fixed**. First run is its own composition with a
  welcome region, an inline learner form and a local-data reassurance region;
  the picker is no longer reused for it. Contract test:
  `tests/first-run-composition.test.mjs`.
