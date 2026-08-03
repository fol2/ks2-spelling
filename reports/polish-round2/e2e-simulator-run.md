# Slice 4.3 — end-to-end simulator run

Branch `agent/polish-round-2`. Run date 2026-08-01 (20:40–23:05 BST) on the
KS2 Polish iPhone 17 simulator, iOS 26.5 runtime, bundle `uk.eugnel.ks2spelling`,
Xcode 26.6 RC. Two app builds were exercised: the mid-run build at `bb48e3d6`
and the closing build at `3eac529f` (the tree this PR proposes). The same
closing build is installed on James's iPhone 16 Pro Max for the slice 4.2
keyboard checklist.

Gallery: `e2e/` beside this file. Harness before/after galleries stay in
`before/` and `after/`.

## Method, and what it can and cannot prove

The product runs inside a `WKWebView`, and `axe describe-ui` sees only the
outer `ScrollArea` — no web element has a queryable frame. Three techniques
carried the run:

- **Coordinate taps.** Every product tap is a point in simulator points
  (`pt = px / 3` at 1206×2622). Native surfaces outside the web view (the
  Safari download sheet, the document picker, the springboard) do accept
  `--label` and were driven that way.
- **The database as ears.** `spelling_practice_sessions.state_json` was polled
  between taps for `phase`, `currentPrompt.word` and
  `statusByRuntimeItemId[...].{needed,successes}`, so each loop iteration
  waited for a real state change instead of a fixed sleep. Round automation
  that typed on a timer produced spurious wrong answers; poll-until-advance
  did not.
- **Pixel detectors.** `find_submit.py` (the wide blue Submit band) and
  `find_field.py` (the thin blue input underline — the *last* thin band, since
  the first is the cloze blank) located moving targets after each layout shift.

**Limit, stated plainly.** `axe type` drives the simulator over HID, which
flips it into hardware-keyboard mode; the software keyboard then behaves
differently from a real device. No conclusion about keyboard visibility,
focus or dismissal may be drawn from this run — that authority belongs to the
C5 XCUITest suite (run at slice 4.1) and to James's physical-device checklist
(slice 4.2). The simulator was erased at the end of the run for that reason,
and the closing build installed onto a clean device image.

Seeded states were delivered as real backup files: built from
`expectedB2Snapshot` through `validateSpellingCommandSnapshotV1` and
`createLearningBackupCodec`, served from a local HTTP server with
`Content-Disposition: attachment`, downloaded in Safari and imported through
the product's own document picker. Nothing was written into the app database
behind the product's back.

## What was walked

| # | Scenario | Evidence |
|---|---|---|
| 1 | First run on a clean install — the switch sheet with no learners | `e2e/01-first-run-switch-sheet.png` |
| 2 | Create a learner, pick a year group, land on the Trail | `e2e/01`, `e2e/21` |
| 3 | Setup for a Y5-6 learner shows the band's own companion — this capture is also the evidence for defects D5 and D6 below | `e2e/02-defect-setup-dimmed-egg-clipped-header.png` |
| 4 | A full round: question, feedback, retry phase, correction phase | `e2e/03`–`e2e/06` |
| 5 | Results / Field Record after the round | `e2e/07-results-field-record.png` |
| 6 | Parent area behind the PIN gate; progress grid per learner (slice 1.3a) | `e2e/08`, `e2e/10` |
| 7 | Learning backup export, then import with the typed-confirmation destructive tier (slice 2.4) | `e2e/11-import-typed-replace-tier.png` |
| 8 | Import replaces every learner; the imported learner is the only one left | `e2e/13`, DB query below |
| 9 | Companion evolution celebration, static tap-gated under Reduce Motion, with its "1 OF 2" pager | `e2e/14-celebration-companion-evolved.png` |
| 10 | Codex: growth line, roster, stats, milestone ladder (slices 3.5, 3.2) | `e2e/15-codex-growth-roster-ladder.png` |
| 11 | Camp before the first patrol — "The first patrol awaits" (slice 1.3b) | `e2e/16-camp-guardian-first-patrol.png` |
| 12 | A Guardian mission end to end, with camp credit | `e2e/17-guardian-results.png`, `e2e/18-camp-after-patrol.png` |
| 13 | Milestone ladder at both ends: all eight reached at 213 secure, only the next one ringed at zero (fix D4) | `e2e/19`, `e2e/20` |
| 14 | Two-learner isolation: a fresh learner sees an empty trail and an undiscovered codex while the other keeps 213 secure words | `e2e/21`–`e2e/23` |
| 15 | Warm background/foreground, cold relaunch, Reduce Motion on and off | see *Lifecycle* below |
| 16 | The closing build on an erased simulator | `e2e/24-final-build-first-run.png` |

Round-loop automation and the seeded backups live in the session scratchpad,
not in the repository; the transcripts of each poll loop are not evidence of
anything the screenshots and database queries do not already show.

## Defects found, and what was done about them

Six defects surfaced — four during the run, two more when the resulting build
was used on a real phone. Each was reproduced away from the device before any
code changed, and re-verified afterwards.

### D1 — the Parent PIN gate rejected its own correct PIN

*Symptom.* Setting a PIN worked; every later entry answered "That did not
work" and `failedAttempts` stayed at 0 — the counter a wrong PIN would have
moved.

*Root cause.* `unlockWithPin` passed the whole stored security record (nine
keys: credential plus lock state) to `pinCrypto.verify`, whose contract
(`requireCredential`) accepts exactly the four credential keys. Every call
threw `parent_pin_credential_invalid` before reaching the verifier. Reproduced
in Node against a copy of the simulator database, which produced the stack
directly. The unit fake's permissive `verify` is why the suite never saw it.
Shipped in `ddc6ad35`, i.e. it predates this branch.

*Fix.* `src/app/parent-security-controller.js` — project the record to its
four credential keys at the call site. A real-crypto round trip
(`createParentPinCrypto` with `globalThis.crypto`: set, lock, unlock, and a
wrong PIN rejected) now pins the seam the fake missed.

*Live.* `e2e/09-parent-unlocked-after-d1.png`. Commit `08c54e79`.

### D2 — the parent progress panel died on an imported learner

*Symptom.* "Progress could not be checked. Saved learning was not changed."
persisting across refresh and relaunch, immediately after an import.
Captured before the fix at `e2e/12-defect-d2-progress-unavailable.png` —
note the import itself reports success on the same screen.

*Root cause.* The snapshot validator accepts sparse progress entries (a
stage with no counters — an imported backup may carry them), but the parent
projection sums `attempts`/`correct`/`wrong` raw, folding `NaN` into the
totals; the vendor redaction walk then rejected the entire projection with
"Parent projection must contain finite numbers". Same Node replay against a
copy of the device database.

*Fix.* `src/app/parent-progress-controller.js` — `projectionSafeSnapshot`
defaults each entry's counters through `Number.isSafeInteger` before
projecting. App-side only; no engine table was extended.

*Live.* `e2e/10-parent-progress-after-d2.png` — the "Seed" row reads
"No spelling attempts saved yet." above "9 secure · 0 due · 0 needing
support", which is also slice 1.3a's grid fix doing its job. Commit
`08c54e79`.

### D3 — the import's replace-all deleted nothing on the device adapter

*Symptom.* An existing learner survived an import that promises to replace
every learner, and re-importing a backup whose learner id already existed
failed with "The backup did not complete" on its primary key. Twice.

*Root cause.* `importBackup` issued `connection.execute('DELETE FROM
learner_profiles')` with no values array. The Capacitor connection routes a
value-less statement to the plugin's statement-batch API
(`database.execute(sql, false)`), which executes this DELETE as a no-op on
iOS; with a values array it takes `database.run(...)`, which works. Node
harnesses could never reproduce it — `node:sqlite` runs both paths correctly
— which is why a full Node replay of `importBackup` passed while the device
failed. The decisive experiment was offline: a cascade delete of the
conflicting learner with `sqlite3`, after which the identical import
succeeded while the *other* learner still survived, isolating the DELETE as
the only failing statement. This was the single value-less DML site in
`src/`.

*Fix.* `src/platform/database/sqlite-learning-backup-repository.js` — pass an
explicit `[]`. `tests/backup-import-delete-path.test.mjs` pins the call
shape in the source text, since the plugin behaviour it guards cannot be
executed under Node.

*Live.* Verified twice on device by importing over an existing learner and
querying the table afterwards — only the imported learner remained. Final
state at the end of this run:

```
sqlite> SELECT learner_id, nickname, year_group FROM learner_profiles;
mega-tester|Mega|Y6
```

Commit `bb48e3d6`.

### D4 — the Codex milestone ladder counted the wrong thing

*Symptom.* After a round celebrated the "10 words secure" milestone, the
Codex ladder still showed only 1 and 5 lit with 10 merely ringed. The track
roster said 7 where the engine said 10.

*Root cause.* The ladder was fed the sum of the monster tracks' secure
counts. Track evidence counts words at stage **exactly** 4, because a word
promoted past the secure stage leaves the track's evidence set; the engine's
milestone events count every word at stage 4 **or beyond**. The two diverge
the moment any word reaches stage 5.

*Fix.* `src/app/ProductApp.jsx` — `CodexScreen` takes `progress` and derives
`secureWordTotal` as the count of entries with `stage >= 4`, which is what
`milestoneLadder` is now given. `tests/app-shell.test.mjs` gained a fixture
with a single stage-5 word and zero companion evidence, which discriminates
the old wiring from the new.

*Live.* `e2e/19-ladder-213-secure-after-d4.png` (all eight marks gold at 213
secure) and `e2e/20-ladder-fresh-learner-after-d4.png` (nothing reached, only
the "1" ringed as next) — both ends of the ladder. Commit `3eac529f`.

### D5 — an unfound companion was legible everywhere but the Codex

*Symptom.* Reported from the device after the run. Set off painted the art of
a creature the learner has not found yet clearly enough to identify, and
tapping the Codex's silhouetted hero opened the zoom island, which paints
through Phaser with no filter at all — one tap revealed exactly what the
silhouette hides.

*Root cause.* Two treatments for one rule. The Codex withholds unfound art
with `filter: brightness(0) invert(1) opacity(0.15)`; Setup had its own
`grayscale(0.4) brightness(0.55)`, which reads as "a bit dark" rather than
"withheld". Separately, the hero's closer-look button rendered whether or not
the companion was found.

*Fix.* One silhouette declaration now covers Setup and the three Codex
surfaces. An unfound hero renders the same plate without the affordance, and
the island is guarded on `hero?.found` so no other route can open it.
Commit `13ca2346`. `e2e/25-setup-after-402x874.png`.

*Checked and left alone.* The Field Record was examined for the same leak and
has none: it already requires a found companion and falls back to the
furthest-grown found one, so it paints no phantom egg. A first attempt at
this fix removed that guard in order to "fix" a leak that did not exist; it
was reverted.

### D6 — the Setup quest block clipped its own kicker and the wake hint

*Symptom.* On a 402×874 phone with the vocabulary rail up, "Smart Review" sat
flush under the chrome: the "Today's quest" kicker and the wake hint that
explains a sleeping companion were both gone. At 390×844 the title itself was
clipped. Visible in `e2e/02-defect-setup-dimmed-egg-clipped-header.png`.

*Root cause.* `.setup-quest` is bottom-aligned (`justify-content: flex-end`)
behind slice 1.4's deliberate `overflow: visible clip`, so overflow comes off
the **top**. Measured in the harness: content ran 72px past its share at
402×874, putting the hint at −71px and the kicker at −25px.

*Why no harness check caught it.* `design/harness.jsx` carried no
`vocabularySets` at all, so the entire Vocabulary set rail — a row every real
learner sees — was absent from every screenshot this round was verified
against. The harness now carries the live catalogue shape and an
`?unfound-companion=true` flag for the sleeping-companion state.

*Fix.* Height came back from three places: the column's own rhythm tightened;
the tray stopped reserving a bottom gutter for the home indicator that the
waypoint bar beneath it already carries (34pt allowed twice for the same
hardware); and the wake hint left the column for the bottom-right, beneath
the silhouette it explains, where it costs the column nothing. The clip is
untouched. After: kicker at +40, title at +66 (402×874) and both clear at
390×844. Commit `68a4d47c`. `e2e/26-setup-after-390x844.png`,
`e2e/27-setup-found-companion-unchanged.png`.

## Negative results worth recording

- **The import resurrect race did not reproduce off-device.** Slice 1.2's
  step-A matrix and a further tracing harness (a connection that recorded
  every post-DELETE writer with its stack) never resurrected a superseded
  profile in Node. The live symptom that prompted the hunt was D3, an adapter
  fault, not an interleaving. The tracing harness was deleted rather than
  merged as a skipped test; slice 1.2's in-flight join guard lands on its own
  merit and `import-race-findings.md` records the matrix.
- **The Camp records strip is empty, and that is correct.** No achievement is
  unlocked in the run's final state; the snapshot holds only progress keys:

  ```
  {"_progress:guardian:days":{"days":[20666]},
   "_progress:pattern:completions":{"completions":{}},
   "_progress:recovery:slugs":{"slugs":[]}}
  ```

  `GUARDIAN_7_DAY` needs seven kept days and `RECOVERY_EXPERT` a recovery, so
  slice 3.2's strip renders nothing — and the `_progress:*` keys it filters
  are exactly the ones the engine forbids showing before unlock. The rule is
  observed live, not merely unit-tested. `e2e/18-camp-after-patrol.png`.

## Lifecycle

- **Warm background → foreground.** Home button, then resume by tapping the
  app icon on the springboard. The app process survives (pid 97552 before and
  after), but the web content re-boots, so the app returns to the Trail rather
  than the screen it was on. Data is intact and the learner selection holds.
  Nothing in this round touches lifecycle or the web view; an in-progress
  round is restored by round 1's baseline store, which was verified separately
  by killing the app mid-round and relaunching. Worth one glance on the
  physical device, where the web-content process is less readily reclaimed.
- **Cold relaunch.** Terminate and launch: boots to the Trail with the correct
  learner and a committed summary, as designed.
- **Reduce Motion.** With it on, celebration cards become static and
  tap-gated with a "TAP OR PRESS TO CONTINUE · N OF M" pager
  (`e2e/14-celebration-companion-evolved.png`). With it off, the app relaunches
  and renders normally with the drifting Trail companions. Both states were
  exercised in this run.

## Residuals and observations

1. **The milestone card's face was never photographed.** The event is proven
   in the database (fires once mid-round when the global secure count crosses
   a milestone, silent on replay), the card's copy, keys, duration and
   ordering are pinned by unit tests, and the evolve capture's "1 OF 2" pager
   shows the second card queued behind it. What is missing is a picture. Both
   attempts to catch it fell inside a post-submit poll window, and the third
   was skipped past by the tap that advanced the pager. A milestone crossing
   needs a seeded near-threshold learner, so this is cheap to retry but was
   not worth another seeded round at close-out.
2. **A focus loss was observed under Reduce Motion during automated
   auto-advance** (empty submits answered "Type the spelling before checking
   it."). Per the standing rule this is *not* diagnosed as an app defect from
   an AXe session — HID typing has already changed the simulator's keyboard
   mode by then. It is named here so slice 4.2 and the C5 suite can look for
   it deliberately.
3. **Two secure counts coexist by design.** Monster tracks count stage ===
   4 evidence; Codex stats and milestones count stage >= 4. D4 aligned the
   ladder with the engine; the roster still shows track evidence, which is
   what a track *is*. `earnedStageHighWater` keeps the monster's visual stage
   monotone so nothing appears to regress when a word is promoted past 4.
4. **Codex overflows at 320×568** — pre-existing, recorded in the round-2
   harness gallery, not introduced here. The Setup quest block is
   over-subscribed at the same sizes: D6 improved 375×667 (the title moved
   from −24 to +7) but the block still collapses to 108px there and 30px at
   320×568, where the tray and tiles consume the column. Not solved.
5. **The practice screen's soft key reports `isHittable == false` in the
   simulator** — investigated at slice 4.1 against a round-1 control build and
   confirmed pre-existing, not a round-2 regression.
6. **"Inklet" names the reward system in three copy strings**
   (`ProductApp.jsx:481`, `:545`, `:2194`), which reads oddly on a Y5-6
   learner's Setup screen beside a Glimmerbug egg. All three predate this
   branch and the usage is consistent product-wide, so this is left for a
   future copy pass rather than changed at close-out.
7. **The second learner in the isolation pass is named "Roman", not
   "Rowan".** iOS autocorrect claimed the typed name while the automation was
   dismissing the suggestion bar. A harness artefact; the app stored exactly
   what the field contained.

## Gate at the closing head (`3eac529f`)

| Check | Result |
|---|---|
| Full `npm test` failing **set** vs `baseline/failing-set.txt` | Identical but for the known `ENOTEMPTY dist/full` build race; `node --test tests/b4-audio-manifest.slow.test.mjs` standalone 6/6 pass — artefact, per the README protocol |
| `npm run lint` | Clean (two pre-existing warnings in `tests/b3-ios-screenshot-target-contract.test.mjs`, untouched by this branch) |
| `npm run verify:vendor` | 24/24 runtime hashes, 29/29 authority files, 9/9 producer tests, Starter 20 / Full 213, 33 A3 records |
| `npm run verify:art` | 55/55 files, 5,469,658 bytes within budget |
| `npm run verify:product-sfx` | ok |
| Keyboard suites byte-identical vs `29b2e58e` | Yes, and 11/11 pass |
| Ten non-keyboard source-text suites | 68/68 pass |
| Composition assert | No `B4Development` / `B3SandboxProof` in the built or synced `index.html`; bundle id `uk.eugnel.ks2spelling` |
| Production CSS purity | `.product-app` present, `.b4-learner-shell` absent (slice 2.2, verified in the shipped artefact) |
