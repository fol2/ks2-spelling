# Release gate: E5 Commercial polish

This document specifies how visual authority compliance (v2-visual-authority.md) is proven before shipping.

## Device matrix

Three floors, kept distinct:

| Floor | Definition | Value |
| --- | --- | --- |
| Geometry floor | Narrowest / shortest viewport the app must survive | **320pt** (iPad Slide Over; `Info.plist` has no `UIRequiresFullScreen`) |
| Performance floor | Oldest silicon supported | **iPad (8th generation)** (A12) and **iPhone SE (2nd generation)** (A13) |
| Aesthetics judge | The panel that decides whether it looks right | A current device, **not** the floor machine |

Visual-authority viewports (CSS pixels, 1x base) and physical-device text
scales:

| Viewport | Class | Target |
| --- | --- | --- |
| 393×852 | Phone single-column | iPhone 13 mini (aesthetics judge) |
| 375×667 | Phone single-column | iPhone SE (2nd generation) |
| 810×1080 | Tablet two-column | iPad (8th generation) portrait |

Tested at viewport text-size scaling: 100% (base), 130% (`-webkit-text-size-adjust: 130%`), 160%.

The committed `reports/b4-physical/ios-physical-proof.json` is the
owner-iPhone artefact (`iPhone 16 Pro Max` / iOS 27). It is not
floor-device evidence. Floor-device walks remain owner-gated; see
`docs/operations/2026-08-21-floor-device-gate-runbook.md`.

## Deployment target

`IPHONEOS_DEPLOYMENT_TARGET = 26.0` (iOS 26 / iPadOS 26), per
[#150](https://github.com/fol2/ks2-spelling/issues/150). The two
device-family floors agree. Reach cost at Apple's 2026-06-07 App Store
measurement: **21% of active iPhones and 32% of active iPads excluded**
(79% / 68% on 26). The trade-off was accepted at #141: a large reach cut
in a market where hand-me-down devices are common, taken deliberately, and
**reversible** — lowering the target later costs only the `color-mix()` /
`text-wrap: balance` fallbacks. Those features are unguarded in product CSS
(re-counted **38** and **4** uses); iOS 26 removes the Safari 16.2 / 17.5
exposure, so no fallback work remains after the raise.

This source slice does not fabricate floor-device, signed-archive,
TestFlight or App Store Connect evidence.

Floor-device performance comparators required by #152, in addition to the
section-18 four, are **time-to-interactive**, **frame rate** and **memory**.
#141/#152 name them but do not publish numeric thresholds, so those three
stay `pending-owner-adjudication` and cannot score GREEN. Frame-rate risk
surfaces are the Phaser Monster Stage behind the Codex zoom, the celebration
tier, and the ambient backdrop pan; nothing may drop frames during a
question card. The current UITest records time-to-interactive; frame-rate
and memory stay required, fail-closed, unmeasured fields until the owner
instruments them. The committed schemaVersion 1 owner-iPhone proof is not
rewritten.

## Matrix freeze date

Viewport classes locked on **2026-08-17**. The performance-floor devices
and deployment target were corrected on **2026-08-21** to match #150 / #152
(iPad 8th generation, not 7th; `26.0`, not `15.0`). No new device classes
may be added without a separate E5-phase approval slice.

## Baseline file format

File: `docs/compliance/baseline.md`

Each entry:

```
- **Location**: `src/app/path/to/component.jsx:123` (file, line number, and component/selector)
- **Clause**: Citation from Contract section of v2-visual-authority.md (e.g. "Accessibility contract — Contrast ratio")
- **Issue link**: #108, #109, etc. (E5.1–E5.x finding)
- **Status**: `todo` | `accepted`
- **Note** (if accepted): Reason for acceptance and date approved
```

## Sign-off procedure

- **Design review owner**: James To (fol2)
- **Approval gate**: Each Layer 2 check must pass on main before a polish slice can merge
- **Waiver rules**: A baseline violation may be marked `accepted` only by the design owner, with a reason and date

## Baseline mode

The CI checks run in **baseline mode**: they assert "no new violations beyond the baseline file", never "zero violations". A violation counts as new if:

1. It is not listed in `docs/compliance/baseline.md`, or
2. Its location or clause differs from an entry in the baseline

The checks apply only to PRs touching `src/app/**`. PRs that touch only docs, configs, gateway, commerce, or native projects are never blocked.

## Implementation: Layer 2 checks (automated in CI)

### Check 1: Contrast ratio

**Gated to**: PRs touching `src/app/**`

**Input**:
- Token definitions from `src/app/app.css`
- Every ink-alpha `color:` declaration in `src/app/app.css` and `site/public/styles.css`
- Baseline file at `docs/compliance/baseline.md`

**Assertion**: All ink tokens (--ink-soft, --ink-faint, --dusk-ink-soft, --dusk-ink-faint) achieve ≥4.5:1 WCAG 2.2 contrast when alpha-composited over their **declared grounds** (`--dusk` / `--dusk-raised` for dusk ink; `--paper` / `--paper-raised` / `--paper-parent` for vellum ink), **and so does every declaration that spells an ink alpha out at the call site instead of reading a token** — or violations are listed as `todo` in the baseline. That is a **declared-ground floor**, not a painted-surface proof. The Layer 2 painted-surface clause remains; evidence for it is harness-measured, not this CI check.

The second half is what #108 needed: batch 0 raised the four tokens and the
check went green while sixteen text runs kept their own hand-written alphas,
as low as 24%. A token check cannot see a declaration that never names a token.

**Mutation to prove failure**: Change `--ink-faint` from 70% to 60%; test must fail (contrast drops below 4.5:1). For the call-site half, restore any of #108's alphas — e.g. `.codex-growth span` to `rgb(255 249 236 / 24%)`.

### Check 2: One h1 per screen

**Gated to**: PRs touching `src/app/**`

**Input**:
- Screen components SSR-rendered with minimal fixtures
- Baseline file

**Assertion**: Every screen component, when SSR-rendered, contains exactly one `<h1>` element, or violations are listed as `todo` in baseline.

**Screens tested**: ParentArea, ResultsScreen, WordBankScreen, WordDetailScreen, SwitchScreen, FirstRunScene — every one an export of `src/app/ProductApp.jsx`, and every one asserted to load. "Standalone screens if renderable" was the loophole that let two named screens go unmeasured because their paths did not exist (#110); a screen this check names must now resolve or the check fails. The one known violation (SwitchScreen, per #113) is baseline-aware: expected to fail, new violations beyond baseline fail the check.

**Mutation to prove failure**: Add a second `<h1>` to a passing screen component; test must fail.

### Check 3: Target size floor (44×44 CSS pixels)

**Gated to**: PRs touching `src/app/**`

**Input**:
- Interactive element CSS declarations from stylesheet
- Baseline file

**Assertion**: Every declared interactive selector (.press, .button-primary, etc.) specifies `height` or `min-height` ≥ 2.75rem, or violations are listed as `todo` in baseline.

**Mutation to prove failure**: Change `.press { height: 2.75rem }` to `height: 2rem`; test must fail.

### Check 4: Horizontal scroll

**Gated to**: PRs touching `src/app/**`

**Input**:
- Stylesheet declarations from `src/app/app.css`
- The setup vocabulary rail in `src/app/ProductApp.jsx`
- Baseline file

**Assertion**: The source-visible half is automated in two named assertions in
`tests/design-authority-checks.test.mjs`.

`Design authority: control rows wrap and no surface scrolls horizontally (#111)` —
`src/app/app.css` may declare no `overflow-x: auto` or `overflow-x: scroll`, and
`.rail` must declare `flex-wrap: wrap`. The `overflow` shorthand may name a
horizontally scrolling value only on the one allowlisted diagnostic surface
(`.app-boot-detail pre`). Declarations are matched at a `;` boundary, not a line
start, so a rule written on one line or without its trailing semicolon cannot
slip past; the two-value shorthand is matched on its first value, which is the
horizontal axis.

`Design authority: setup vocabulary pills show a bare count and name the noun to
assistive tech (#111)` — Practice setup is a fixed-height composition whose hero
is `flex: 1; min-height: 0` clipped at flex-end, so a second rail row there costs
the hero's kicker and the top of its h1. That rail must therefore fit one row at
every supported width: the visible count carries no noun, and the noun rides in
the `aria-label`.

**Mutation to prove failure**: Restore `overflow-x: auto` on `.rail`; test must
fail. Also proven red: dropping `flex-wrap` from `.rail`; `overflow-x: auto`
written mid-line or without a trailing semicolon on any other selector; a
two-value `overflow: auto hidden`; restoring `words` to the setup pill's visible
count; dropping that pill's `aria-label`; stripping `rail` off `setup-pools`. A
control `overflow-y: auto` elsewhere must stay green.

**Render half (device walk)**: A text-length that overflows a wrapped row still cannot be seen from source. It is verified on device per the device matrix (393×852, 375×667, 810×1080) during manual design review and PR testing.

**Device-walk procedure**: For each viewport size and text scale (100%, 130%, 160%), render the page, measure whether horizontal scroll is required at any point, and assert no scroll occurs.

**Baseline**: Known violations are listed in `docs/compliance/baseline.md` under "Rail clearance".

## Layer 3 notes

Layer 3 composition rules are not automated. They are manually reviewed by design before integration. No CI gate exists for Layer 3.
