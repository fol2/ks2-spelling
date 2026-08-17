# Visual authority baseline: Known E5.1 violations

Baseline file: One entry per known violation as of 2026-08-17.

The design check asserts "no new violations beyond this baseline", never "zero violations".

A violation is new if: (1) unlisted in this file, or (2) its location or clause differs from an entry here.

## Layer 2: Machine-checkable violations

### Contrast ratio

- **Location**: `src/app/ProductApp.jsx:165,185,251,258,1455,1510,1739,2301,2492,2781,3034` (tab bar labels, word-bank subtitles, kicker, etc.)
- **Clause**: Contract — Layer 2 — Accessibility contract — Contrast ratio
- **Issue link**: #108
- **Status**: `todo`

### One h1 per screen

- **Location**: `src/app/learner-switch/LearnerSwitchSheet.jsx` (no h1)
- **Clause**: Contract — Layer 2 — Accessibility contract — One h1 per screen
- **Issue link**: #113
- **Status**: `todo`

- **Location**: `src/app/first-run/FirstRunScene.jsx` (no h1)
- **Clause**: Contract — Layer 2 — Accessibility contract — One h1 per screen
- **Issue link**: #113
- **Status**: `todo`

## Layer 3: Design composition violations (manual review)

### Backdrop proportion

- **Location**: `src/app/Round.jsx` (empty space below action region)
- **Clause**: Contract — Layer 3 — Backdrop proportion
- **Issue link**: #114
- **Status**: `todo`

- **Location**: `src/app/Camp.jsx` (empty space below action region)
- **Clause**: Contract — Layer 3 — Backdrop proportion
- **Issue link**: #114
- **Status**: `todo`

### Label baseline

- **Location**: `src/app/Round.jsx:dictation-disclosure` (dictation disclosure wraps)
- **Clause**: Contract — Layer 3 — Label baseline
- **Issue link**: #115
- **Status**: `todo`

### Tile consistency

- **Location**: `src/app/codex/CodexRoster.jsx` (roster tiles unevenly sized)
- **Clause**: Contract — Layer 3 — Tile consistency
- **Issue link**: #116
- **Status**: `todo`

### Rail clearance

- **Location**: `src/app/Setup.jsx:filter-rail` (rail clips last option, no affordance)
- **Clause**: Contract — Layer 3 — Rail clearance
- **Issue link**: #111
- **Status**: `todo`

- **Location**: `src/app/Setup.jsx:vocabulary-rail` (rail clips last option, no affordance)
- **Clause**: Contract — Layer 3 — Rail clearance
- **Issue link**: #111
- **Status**: `todo`

- **Location**: `src/app/codex/CodexRoster.jsx:lower-rails` (rails collide with tab bar)
- **Clause**: Contract — Layer 3 — Rail clearance
- **Issue link**: #116
- **Status**: `todo`

### Fact singularity & other composition

- **Location**: `src/app/Feedback.jsx` (correction guidance rendered below primary action; learner's attempt discarded)
- **Clause**: Contract — Layer 3 — Fact singularity
- **Issue link**: #112
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
- #110 — First run regions: Out of scope for this slice; deferred to E5.2 (per-surface polish).
