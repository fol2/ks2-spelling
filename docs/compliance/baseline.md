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
seventeen `h1` sites in `src/app/ProductApp.jsx` now fail a mutation. Every other
location in this file is still a path that does not exist; see #242.

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

The Parent entry below still carries a Backdrop-proportion clause under #118,
at a location (`src/app/Parent.jsx`) that does not exist either.

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

- **Location**: `src/app/app.css` (`.setup-quest`: `flex: 1; min-height: 0` clipped at flex-end deletes the kicker, then the top of the h1 — 55.2px / 52.0px already gone at 320×568 and 100% text)
- **Clause**: Contract — Layer 3 — Label baseline
- **Issue link**: #245
- **Status**: `todo`

### Tile consistency

- **Location**: `src/app/codex/CodexRoster.jsx` (roster tiles unevenly sized)
- **Clause**: Contract — Layer 3 — Tile consistency
- **Issue link**: #116
- **Status**: `todo`

### Rail clearance

The two #111 entries named `src/app/Setup.jsx:filter-rail` and
`src/app/Setup.jsx:vocabulary-rail` — a path that has never existed on any
branch, and the filter rail is on the Words screen, not Setup — so both are
retired rather than relocated, the same fictional-location family as #242.

- **Location**: `src/app/codex/CodexRoster.jsx:lower-rails` (rails collide with tab bar)
- **Clause**: Contract — Layer 3 — Rail clearance
- **Issue link**: #116
- **Status**: `todo`

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

- **Location**: `src/app/Results.jsx:stat-trio` (stat trio wraps ragged; topline overlaps hero art)
- **Clause**: Contract — Layer 3 — Tile consistency / Label baseline
- **Issue link**: #117
- **Status**: `todo`

- **Location**: `src/app/Parent.jsx` (dead band on entry; title stated twice)
- **Clause**: Contract — Layer 3 — Backdrop proportion / Fact singularity
- **Issue link**: #118
- **Status**: `todo`

- **Location**: `src/app/Trail.jsx:companion-plate` (iOS WebKit renders plate boundary)
- **Clause**: Direction — Design principles (not a Contract gate)
- **Issue link**: #109
- **Status**: `accepted` (deferred to post-E5 native iOS hardening slice; approved James To 2026-08-17)

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
