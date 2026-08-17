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
- Baseline file at `docs/compliance/baseline.md`
- Rendered page at each of the three viewports and text scales

**Assertion**: All text and interface elements meet their Layer 1 contrast floor (4.5:1 for body text, 3:1 for large text), or are listed as `todo` in the baseline.

**Mutation to prove failure**: Change a passing token value (e.g. `--ink-soft: rgb(29 43 58 / 50%)` instead of `62%`), re-run check; must fail.

### Check 2: One h1 per screen

**Gated to**: PRs touching `src/app/**`

**Input**:
- DOM tree at each of the three viewports
- Baseline file

**Assertion**: Every route/screen has exactly one `<h1>` element, or violations are listed as `todo` in baseline.

**Mutation to prove failure**: Add or remove an `<h1>`, re-run check; must fail.

### Check 3: Target size floor (44×44 CSS pixels)

**Gated to**: PRs touching `src/app/**`

**Input**:
- Interactive elements (buttons, inputs, tappable regions) at each viewport
- Baseline file

**Assertion**: Every actionable element is at least 44×44 CSS pixels (excluding padding), or violations are listed as `todo` in baseline.

**Mutation to prove failure**: Reduce button size to 40×40, re-run check; must fail.

### Check 4: No horizontal scroll

**Gated to**: PRs touching `src/app/**`

**Input**:
- Rendered page at each viewport and text scale
- Baseline file

**Assertion**: No horizontal scroll is required at any viewport, or violations are listed as `todo` in baseline.

**Mutation to prove failure**: Add `width: 100vw` to a content element, re-run check; must fail.

## Layer 3 notes

Layer 3 composition rules are not automated. They are manually reviewed by design before integration. No CI gate exists for Layer 3.
