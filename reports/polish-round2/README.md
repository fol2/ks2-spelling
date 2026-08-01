# Polish Round 2 — verification gate and baselines

Branch `agent/polish-round-2` off `main @ 29b2e58e`. Plan: `~/.claude/plans/app-binary-river.md`.

Environment note: Node is pinned at 24.18.0; this machine runs 24.2.0, so the
b3-capture family fails environmentally (`DatabaseSync.enableDefensive` is
missing). Compare failure **sets**, never counts.

The dist/ build race: suites that build into the shared `dist/` tree
(app-shell's local-only build, the b4 shell builds, the B4 audio-manifest
build) can race each other to an `ENOTEMPTY` in vite's prepare-out-dir. The
race lives INSIDE a single `npm test` run — the node test runner executes
files concurrently — so it can fire with nothing else running; parallel test
commands only raise the odds. Two rules follow. First, never run two test
commands concurrently. Second, when a failing-set diff shows exactly this
signature (`ENOTEMPTY … dist/…` inside a build step), re-run the named suite
standalone at the same tree: a standalone pass proves an artefact (record it
beside the run log); a standalone fail is a real regression — stop the slice.

The failing-set lines carry per-run timings, so strip ` (…ms)` before diffing:
`sed -E 's/ \([0-9.]+ms\)$//' | sort -u` on both sides.

Baseline correction (recorded 2026-08-01): the original full-run capture
recorded one such artefact — "B4 Vite build contains all 25 exact WAV bytes
and bound manifest authority" on `ENOTEMPTY dist/full`. Standalone re-runs at
the same tree pass it, so the line has been removed from
`baseline/failing-set.txt`; the true environmental set is the remaining 208
lines. The same artefact resurfaced in the slice 1.2 full run and passed
standalone again, confirming the intra-run mechanism.

## The Slice Gate (run in order after every slice)

1. `npm run test:fast` — failing set identical to `baseline/test-fast-failing-set.txt`.
2. `npm test 2>&1 | tee /tmp/after.log; grep -E '^✖ ' /tmp/after.log | sort -u | diff - reports/polish-round2/baseline/failing-set.txt` — empty diff.
3. `npm run lint`
4. `npm run verify:vendor`
5. `npm run verify:art && npm run verify:product-sfx`
6. Keyboard invariants:
   `git diff --exit-code 29b2e58e -- tests/keyboard-reset-visible-input.test.mjs tests/ios-user-driven-keyboard-focus.test.mjs tests/ios-practice-keyboard-probe-contract.test.mjs tests/answer-keyboard.test.mjs`
   (byte-identical), then `node --test` those four files (all pass).
7. Any `src/app/ProductApp.jsx` edit → targeted run of the ten non-keyboard
   source-text suites:
   `node --test tests/product-celebrations.test.mjs tests/core-monster-progression.test.mjs tests/trail-meadow-contract.test.mjs tests/round-agency-contract.test.mjs tests/monster-stage-contract.test.mjs tests/app-shell.test.mjs tests/practice-feel.test.mjs tests/learner-colour.test.mjs tests/product-audio-policy-refusal.test.mjs tests/post-commit-refresh-tolerance.test.mjs`
8. Visual slices → design-harness before/after screenshots into
   `reports/polish-round2/before/` and `after/`.

## Screenshot workflow

`npx vite --config vite.design.config.js --port 5183` (there is deliberately no
npm dev script — do not add one). States:
`?screen=home|progress|monster|camp|setup|practice|summary|profiles`, with
`&guardian=locked|teaser|active|rested|done` on camp/setup (plus `first`, added
in slice 1.3). Viewports: 390×844 primary; 320×568 and 375×667 where a slice
lists them. Naming: `<screen>[-guardian-<state>]-<w>x<h>.png`.

## iOS simulator rules

- iPhone 17 / iOS 26.5 runtime ONLY. The 26.2 runtime has a broken dyld shared
  cache on this Mac — full-white screens there are environmental, never app
  evidence.
- Guardian states: `node scripts/dev/make-all-mega-backup.mjs` → Parent → Import.
- Never drive typing through AXe/HID bridges: the first HID key event flips the
  simulator into hardware-keyboard mode (letter rows vanish, only the assistant
  strip remains) and the state survives relaunches. Recover with
  `xcrun simctl erase <udid>`. Keyboard-visibility claims belong to the C5
  XCUITest only.

## Decisions recorded for this round

- **No aggregate `verify:product` npm script.** Every new package script costs
  byte-identical registration in three places (package-transition authority),
  and the decisive step — the failure-set comparison — is not expressible as an
  `&&` chain: an aggregate would exit non-zero on this machine every time and
  train agents to ignore red. The gate lives as the checklist above.
- **C5 stays out of required CI.** Repo policy is compile-evidence in CI,
  decisive assertions on device; a CI job would have to re-sync the product
  payload over the composition the other jobs verify — the exact hazard
  `docs/solutions/workflow-issues/gating-physical-ios-installs-on-application-composition.md`
  exists to prevent. Manual runbook below.

## C5 manual runbook (product composition, then the probe)

```sh
npm run build && npx cap sync ios
# Composition assertion (gating doc): the synced payload must be the product.
grep -qE 'B4Development|B3SandboxProof' ios/App/App/public/index.html && echo "WRONG COMPOSITION — STOP" || echo "product composition OK"
xcodebuild -project ios/App/App.xcodeproj -scheme KS2Spelling -configuration Debug \
  -destination 'platform=iOS Simulator,name=KS2 Spelling iPhone 17,OS=26.5' build
# install the built .app on the simulator, then:
xcodebuild -project ios/App/App.xcodeproj -scheme B3ProofUITests -configuration Debug \
  -destination 'platform=iOS Simulator,name=KS2 Spelling iPhone 17,OS=26.5' \
  -only-testing:B3ProofUITests/C5ProductLayoutTests test
```

Run on a freshly-erased simulator (`xcrun simctl erase`) so no earlier HID
session can counterfeit a keyboard failure.
