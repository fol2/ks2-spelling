# Release gate: E5 Commercial polish

This document specifies how visual authority compliance (v2-visual-authority.md) is proven before shipping.

## Device matrix

Tested at viewport dimensions (CSS pixels, 1x base) and physical device text scales:

| Viewport | Class | Target |
| --- | --- | --- |
| 393×852 | Phone single-column | iPhone 13 mini |
| 375×667 | Phone single-column | iPhone SE (2nd gen) |
| 810×1080 | Tablet two-column | iPad (7th gen, landscape) |

Tested at viewport text-size scaling: 100% (base), 130% (`-webkit-text-size-adjust: 130%`), 160%.

## Matrix freeze date

Device matrix locked on **2026-08-17**. No new device classes may be added without a separate E5-phase approval slice.

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

**Assertion**: All ink tokens (--ink-soft, --ink-faint, --dusk-ink-soft, --dusk-ink-faint) achieve ≥4.5:1 WCAG 2.2 contrast when alpha-composited over their painted surfaces, **and so does every declaration that spells an ink alpha out at the call site instead of reading a token** — or violations are listed as `todo` in the baseline.

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

**Render-gated** (requires layout/browser measurement): This check cannot be reliably automated in node.test. It is verified on device per the device matrix (393×852, 375×667, 810×1080) during manual design review and PR testing.

**Device-walk procedure**: For each viewport size and text scale (100%, 130%, 160%), render the page, measure whether horizontal scroll is required at any point, and assert no scroll occurs.

**Baseline**: Known violations are listed in `docs/compliance/baseline.md` under "Horizontal scroll".

## Layer 3 notes

Layer 3 composition rules are not automated. They are manually reviewed by design before integration. No CI gate exists for Layer 3.
