# Physical-device keyboard acceptance — polish round 2

Slice 4.2 of the round-2 polish pass. The four keyboard suites are compilation
and contract evidence in CI; their decisive assertions have to be executed by a
person on a real phone with no external hardware keyboard attached. This is that
record.

## What was tested

| | |
|---|---|
| Build | product Debug, Xcode 26.6.0 RC, `uk.eugnel.ks2spelling` |
| Source | `68a4d47c` (docs head `9384ab92`), merged to `main` as `9ee4018a` |
| Byte identity | `git diff 9384ab92 9ee4018a -- src` is empty — the tested bytes are `main`'s bytes |
| Composition | asserted clean: no `B4Development` and no `B3SandboxProof` in the synced or the built `index.html` |
| Sync command | `npm run build && npx cap sync ios` — **never** `sync:b4-development` |
| Install | `devicectl` over the existing app, 2026-08-03 |
| Device | iPhone 16 Pro Max, iOS 27.0 (24A5380h) — the affected operating system of the incident |
| Hardware keyboard | none attached |
| Observer | James (device owner) |

## Result

All thirteen items of the incident doc's required physical-device acceptance
(`docs/solutions/integration-issues/dictation-software-keyboard-ios27-incident.md`)
were exercised on the device and confirmed good, with the one documented
exception in row 13.

| # | Check | Outcome |
|---|---|---|
| 1 | Launch and leave the profile screen idle: no keyboard appears later by itself | pass |
| 2 | Add learner, tap nickname: keys appear promptly and typing reaches the field | pass |
| 3 | Open Words, tap Search spellings: keys appear promptly and filtering works | pass |
| 4 | Open Parent PIN: numeric keys appear promptly | pass |
| 5 | Tap **Set off**, wait for Practice, tap the visible answer line: keys appear promptly | pass |
| 6 | During Submit/save the key rows remain present and the answer is submitted exactly once | pass |
| 7 | During correct/incorrect feedback the field stays focused but rejects edits until Continue/auto-advance | pass |
| 8 | The next card accepts typing without another unexplained delay | pass |
| 9 | End round, Keep practising and Leave round leave no invisible focus target | pass |
| 10 | Portrait and landscape keep the authored dictation layout usable without a custom keyboard inset | pass |
| 11 | Background/foreground, then tap the answer line: ordinary typing resumes | pass |
| 12 | The system previous/next/done accessory may remain visible, but must stay system-owned and must not replace, delay or outlive the software key rows | pass |
| 13 | Repeat the bare visible-field checks on stable iOS 26 **and** the affected iOS 27 device when both are available | iOS 27 half: pass. iOS 26 half: **not run** — see below |

## Limits of this evidence

Read these before citing the table above.

- **The evidence is the device owner's confirmation, not a screenshot set.** The
  slice asked for one screenshot per item; the checks were run on the phone and
  reported as good rather than captured. The distinction matters if a later
  regression makes anyone want to re-read a specific frame — there is no frame to
  re-read, so a suspected regression means running the checklist again rather
  than re-examining this record.
- **Row 13's iOS 26 half stays open.** No stable-iOS-26 *physical* device is
  available, and the simulator cannot stand in: driving typing through an
  accessibility or HID bridge switches the simulator into hardware-keyboard mode,
  the letter rows vanish, and the result mimics this very incident. The incident
  doc's own guidance is to trust the XCUITest probes over hand-driven simulator
  typing, so no simulator session is offered here as iOS 26 evidence. The half
  closes when a stable-iOS-26 phone is to hand.
- The four keyboard suites were byte-identical to `29b2e58e` throughout round 2
  and passed at the merge head, so nothing in this round moved the code these
  checks defend.

## Consequence

The affected-OS half of the incident's acceptance gate is satisfied against the
shipping tree, on the operating system that produced the incident. The incident
doc's checklist is ticked accordingly, with row 13 annotated rather than claimed
in full.
