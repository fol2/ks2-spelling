# C6 game-layer uplift plan

Governed by the C-series product-completion plan and the V2 visual authority.
Milestones are work slices, not approval gates. Every slice keeps
`npm run test:fast`, `npm run lint` and `npm run build` green.

## C6.1 — art vendoring pipeline and first backdrop

**Goal.** Vendor the ks2-mastery spelling art slice under hash provenance and
paint the first Scribe Downs backdrop on ChildHome.

**Key files.** `scripts/verify-vendored-art.mjs` modelled on
`scripts/verify-vendored-contract.mjs`; `provenance/ks2-mastery-art.json`;
`content/mastery-art/**` — 15 Scribe Downs backdrops at 1280 (regions a/b/c
smart, d trouble, e test, tones 1–3) plus 40 monster files at 640 (inklet,
glimmerbug, vellhorn, phaeton × branches b1/b2 × stages 0–4), extracted
verbatim via git archive from a pinned ks2-mastery commit, ≈5.3 MB total budget
pinned in provenance; Vite `createBundledArtAssets` block following the
`createBundledStarterAssets` precedent; ChildHome trail hero painted with the
first backdrop; `verify:art` script registered byte-identically in the package
transition authority trio; `tests/vendored-art-authority.test.mjs`.

**Verification.** Provenance pins match extracted bytes; `verify:art` and the
vendored-art authority test pass; ChildHome shows the first backdrop.

## C6.2 — backdrop layer

**Goal.** Port the Scribe Downs backdrop model and wire tone escalation across
practice surfaces.

**Key files.** Port `hero-bg.js` and `HeroBackdrop.jsx` from ks2-mastery
`src/platform/ui/`; tone and URL pure functions plus the static per-tone
contrast table into `src/app/backdrop-model.js`; CSS keyframes inside existing
reduced-motion guards; wiring for PracticeSetup, PracticeScreen (tone follows
round progress), Summary (tone 3); `data-hero-tone` token overrides; preload of
session tone URLs; feature-detected `document.startViewTransition` with
instant-swap fallback; `tests/backdrop-model.test.mjs`; optional Fraunces
subset with OFL notice.

**Verification.** Backdrop-model tests pass; Practice/Summary tone wiring
matches round progress; reduced motion leaves a static frame.

## C6.3 — workshop mode trio

**Goal.** Expose smart, trouble and test workshop modes over the frozen A3
contract.

**Key files.** Planner-level RED tests against the vendored A3
`applySpellingCommand` (trouble with no wrongs falls back to smart with
`fallbackToSmart`; trouble after wrongs selects trouble words; test is
single-attempt with no retry); controller `startRound({mode, length})`
replacing `startSmartRound`; mode and fallback projected to views; three mode
cards on PracticeSetup with region thumbnails; test mode hides cloze and retry
framing; parity cross-checked against the ks2-mastery spelling parity document.

**Verification.** Planner RED/GREEN contracts pass; PracticeSetup presents three
modes; test mode framing matches the single-attempt contract.

## C6.4 — practice-feel parity

**Goal.** Match ks2-mastery practice feel for auto-advance, focus and keyboard
hygiene without new plugins.

**Key files.** Auto-advance delay (320 ms test, 500 ms otherwise) with the
Continue control kept as skip and accessibility path; answer-field refocus and
scroll-into-view; keyboard-overlap verification across simulator sizes; no new
keyboard plugin without device evidence; predictive-text leak check parked to
C6.7.

**Verification.** Auto-advance timings hold; Continue remains reachable;
simulator keyboard-overlap checks pass for the covered sizes.

## C6.5 — celebrations, toast and haptics

**Goal.** Queue summary-only celebration moments, one reward toast and bounded
haptics.

**Key files.** Monster projection diffed at summary entry into queued
caught/evolve events; a small local celebration layer (tap-skip, polite status
announcement, reduced-motion static card); effect visuals ported from
ks2-mastery `src/platform/game/render/` (celebration shell, effects.css,
palette, particles-burst, sparkle) without the registry/config/ack machinery;
one "+N words secure" toast; `@capacitor/haptics` pinned with a small injected
adapter; dependency governance in order (notices, sdk-privacy-register
including the Android VIBRATE amendment, dependency audit, native plugin policy
pins, cap sync, native sync check, iOS and Android suite);
`tests/product-celebrations.test.mjs`.

**Verification.** Celebration tests pass; celebrations appear only on summary,
one at a time, skippable; dependency and native-plugin governance stay green.

## C6.6 — Phaser Monster Stage

**Goal.** One bounded Phaser canvas island for monster presentation.

**Key files.** `phaser` pinned exact (web-only dependency governance);
lazy-loaded chunk off the launch path with its size recorded; one game per
mount replacing the inline Inklet SVG on the Monster screen; procedural idle
life and evolution sequence over the static 640 webp; context-loss and
backgrounding destroy to a static image fallback; device pixel ratio capped at
2; canvas hidden from accessibility APIs behind the existing text equivalent;
`tests/monster-stage-contract.test.mjs` (pure functions only).

**Verification.** Monster-stage contract tests pass; canvas never hosts input;
static fallback covers context loss and reduced motion; chunk stays off the
launch path.

## C6.7 — C5 re-verification

**Goal.** Run the full C5 bundle on the uplifted tree, obtain one independent
read-only verification, then freeze.

**Key files.** The C5 verification set on the post-C6 bytes; parked device
checks executed (predictive text, haptics, View Transitions capability, Phaser
memory and context soak, VoiceOver and TalkBack pass).

**Verification.** Full local suites, affected unsigned native compiles, hosted
exact-head CI and one independent read-only verdict are green on the uplifted
checkpoint; freeze proceeds once.

## Deliberate simplifications

- Static contrast table instead of a luminance probe.
- No celebration acknowledgement persistence.
- No tunables registry or toast bus.
- No keyboard plugin without device evidence.
- Vellhorn vendored but unreachable until the post-v1 fast-follow.
