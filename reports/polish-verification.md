# Commercial-grade polish pass — verification record (2026-07-31)

Branch `agent/polish-phaser-guardian` (19 commits over `1ba085fb`).
Plan: `~/.claude/plans/app-polish-polymorphic-kay.md`.

## Test verdict

Full `npm test` on the final tree: 1678 tests, 1470 pass. The failing-file set is
IDENTICAL to the pre-polish baseline recorded at `1ba085fb` (all environmental on this
machine: Node 24.2 lacks `DatabaseSync.enableDefensive` which fails the whole
b3-capture family; Wrangler/Miniflare/Android-toolchain suites; two build-race
artefacts that pass solo) — minus `gateway-workerd-runtime`, which now passes.
Zero new failing files; 25 new tests added, all green. `verify:vendor`,
`verify:art`, `verify:product-sfx` and oxlint all green throughout; the
runtime-URL local-only audit passes.

## Keyboard verdict (the invariant that must not regress)

- `tests/ios-user-driven-keyboard-focus.test.mjs` and
  `tests/keyboard-reset-visible-input.test.mjs` passed UNMODIFIED after every slice.
- XCUITest probe `testProductNicknameFieldRaisesSoftwareKeyboard` PASSED on the
  final build (clean simulator, iPhone 17 / iOS 26.5).
- `testProductPracticeFieldKeepsSoftwareKeyboardAcrossReturn` fails identically on
  the UNTOUCHED baseline build at the same `staticTexts["Vocabulary set"]` wait
  while the screen is visibly rendered — a pre-existing WKWebView a11y
  materialisation flake, not a regression (C5 is not wired into CI).
- Live E2E: the full software keyboard rose unprompted on entering a Guardian
  round (programmatic autofocus path) and returned after skip via the in-gesture
  focus reclaim — screenshots `reports/polish-after/guardian-round-keyboard-device.png`.

## On-device E2E (final build, iPhone 17 / iOS 26.5 simulator)

Smart-review journey (earlier, baseline build): 30+ submits with zero blank
frames — the 26-July "Submit blanks screen" report does not reproduce
(`startViewTransition` was removed wholesale); cards 2+ autoplay raised no error.

Guardian journey (final build): parent PIN set → all-Mega backup imported
(`scripts/dev/make-all-mega-backup.mjs`) → Camp unlocked from the X/213 teaser to
"Begin the patrol" → Guardian round with mission chip, 8-card strip,
"Answered N of 8" counter, single-attempt wobble feedback ("Wobbling. …
returns tomorrow for a Guardian check."), "I don't know" skip → Field Record
with **"The camp fire rises — Camp level 1"**, "BACK TOMORROW 8", and the
fully-grown Inklet presiding → Camp shows level 1, ring 1/10, "9 to the next
banner", "All guarded … this is what a kept camp looks like."
Evidence: `reports/polish-after/*-device.png`.

## Findings fixed during verification

- `afterImport` let an auxiliary parent-progress refresh failure mask a
  committed import as "The backup did not complete" — refresh failures are now
  tolerated there (they keep their own notice).
- `sfx-engine` carried an `http://localhost/` fallback that tripped the
  local-only runtime audit — removed.

## Known follow-ups (none block release readiness of this pass)

1. Physical-device keyboard checklist
   (`docs/solutions/integration-issues/dictation-software-keyboard-ios27-incident.md:187-212`)
   still needs one run on a real iPhone — simulator-side evidence is complete.
2. C5 practice-probe hardening (wait on a button query rather than staticTexts).
3. Import-flow archaeology: under a double-triggered import a superseded learner
   profile reappeared alongside the imported one; needs a controlled repro
   (suspect: rollback/commit interplay across two overlapping import attempts).
4. Copy nits: parent progress "…saved yet.0 secure" missing space; Guardian
   first-patrol headline reads "0 words due for guarding today" before the
   first patrol creates its entries.
5. Guardian 7-day achievement chip (engine already persists the achievement)
   and the Setup-transition header overlap seen once mid-animation — recheck.
