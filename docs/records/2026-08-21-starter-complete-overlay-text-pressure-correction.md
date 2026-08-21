---
module: product-design
tags:
  - measurement-run
  - starter-complete
  - dynamic-type
problem_type: design-qa-record-correction
---

# Correction — Starter-complete overlay text-pressure measurement

Status: CORRECTED at
`d8998e2b22337b13ea47d1d764c8278bb18f66f5`.

This record corrects two over-broad column headings and one measurement term
in `2026-08-21-starter-complete-overlay-text-pressure.md`. The original record
is frozen and remains unchanged.

## Evidence

- The original table's `CTA line boxes` column applies to the
  Starter-complete **overlay** CTA labels only. It does not apply to the normal
  Field Record actions. In the normal 375×667/160% and 393×852/160% cells,
  `Walk again` occupied two rendered line boxes (`Walk ` / `again`). That was
  not an intra-word split and did not expose horizontal overflow; the normal
  actions remained reachable and the Field Record still fitted horizontally.
- The original table's `Minimum contrast` column applies to the overlay
  headline and quiet Continue action against the raised-paper card only. The
  normal cells did not measure a contrast value.
- The 14.151:1 result was calculated from Chromium computed CSS colours. It
  was not derived from raster-pixel sampling, so `computed contrast` replaces
  the original phrase `painted contrast`.

The corrected interpretation of the original table is:

| Viewport | Root text scales | States rendered | Overlay CTA line boxes | Exposed horizontal overflow, both states | Overlay headline/Continue computed contrast | Focus and reachability, both states |
| --- | --- | --- | --- | ---: | ---: | --- |
| 393×852 | 100 / 130 / 160% | normal + overlay | one per CTA label | 0px | 14.151:1 | pass |
| 375×667 | 100 / 130 / 160% | normal + overlay | one per CTA label | 0px | 14.151:1 | pass |
| 810×1080 | 100 / 130 / 160% | normal + overlay | one per CTA label | 0px | 14.151:1 | pass |

All exact source pins, raw evidence hashes, overlay fit, stability, focus,
reachability, exposed-overflow result and favicon adjudication in the original
record remain valid under this correction.

## Remaining gates

The original record's remaining-gate and no-authority statements are
unchanged. This correction grants no physical-device, accessibility, signing,
release, store or broader Layer 3 authority.
