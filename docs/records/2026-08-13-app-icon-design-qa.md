---
module: branding
tags:
  - freeze-record
  - app-icon
  - design-qa
problem_type: freeze-record
---

# App icon design QA

**Comparison target**

- Source visual truth: `assets/branding/icon-concepts/vellhorn-spelling-b-selected.png`
- iOS implementation: `ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png`
- Android implementation: `android/app/src/main/res/mipmap-*/ic_launcher*.png`
- Full-view evidence: `design/qa/app-icon-option-3/full-view-comparison.png`
- Focused evidence: `design/qa/app-icon-option-3/small-size-comparison.png`
- Viewport: square app-icon artwork and common Android launcher masks
- Source pixels: 1024 x 1024, opaque RGB, 1:1 square
- iOS implementation pixels: 1024 x 1024, opaque RGB, 1:1 square
- Android adaptive QA pixels: 432 x 432 xxxhdpi foreground rendered into
  432 x 432 circle, squircle and rounded masks
- Density normalization: source and iOS master were compared at equal pixel
  dimensions; small-size crops were downsampled with Lanczos to 180, 120, 60,
  40 and 29 pixels
- State: selected option 3 as the default native launcher icon

**Findings**

- No actionable P0, P1 or P2 difference remains.
- Fonts and typography: the lowercase `b` is part of the approved raster
  artwork, preserves its intended weight and remains recognisable at 29 pixels.
- Spacing and layout rhythm: Vellhorn, the `b` and the check retain their
  hierarchy in the square iOS master and all three Android masks.
- Colours and visual tokens: iOS preserves the source palette byte-for-byte;
  Android uses a matched dark-green background behind transparent foreground
  artwork without the earlier square inset.
- Image quality and asset fidelity: the iOS master is the approved 1024-pixel
  source; Android derivatives use the same real artwork, with clean alpha edges
  and no substitute glyphs, SVG approximations or compression artefacts.
- Copy and content: the spelling signal is the approved lowercase `b`; there is
  no additional app-specific text to compare.

**Open Questions**

- None for the selected icon asset. A signed build and physical-device Home
  Screen inspection remain release evidence, rather than a design mismatch.

**Implementation Checklist**

- [x] Retain all three approved concepts in the branding authority.
- [x] Install option 3 as the iOS source icon.
- [x] Generate Android legacy, round and adaptive launcher derivatives.
- [x] Inspect source and implementation in one full-view comparison.
- [x] Inspect the spelling letter and companion at shelf-scale sizes.

**Comparison History**

1. Initial adaptive comparison found a P2 square inset caused by compositing
   the complete source image as a reduced foreground layer.
2. The background was extracted, the real Vellhorn, `b` and check artwork was
   retained as transparent foreground, and the background colour was matched.
3. The revised circle, squircle and rounded-mask evidence shows no square inset
   and no actionable P0, P1 or P2 difference.

**Follow-up Polish**

- No P3 refinement is required before handoff.

final result: passed
