---
module: product-design
tags:
  - measurement-run
  - starter-complete
  - dynamic-type
problem_type: design-qa-record
---

# Starter-complete overlay text-pressure measurement — 2026-08-21

Status: design-harness-GREEN at
`4a627504929927df999d3599ca9b29aac8c88d95`.

## Evidence

- The local design harness ran with Vite 8.1.4 at
  `/design/?screen=summary` and
  `/design/?screen=summary&starter-complete=true`. Chromium
  149.0.7827.55 rendered the normal and Starter-complete states at
  393×852, 375×667 and 810×1080 with root text scales of 100%, 130% and
  160%: 18 cells in total.
- The exact source tree was
  `f999abe34a05cbecd5762fc8fdface3f17e7c37f`. Its binary diff from base
  `f29b0d5ba4e0036e206a0c4178da87507a683dfb` had SHA-256
  `656af690bcf78245c4872da94ff1ead15306f5ea37bf9871f799e1339ace42a4`.
- Character-level DOM `Range` rectangles placed `Ask a grown-up` on one
  line in every overlay cell. In both phone cells at 160%, every character
  in `grown-up` shared one rendered line-box top and `split` was false.
- At 375×667/160% and 393×852/160%, the Ask button measured
  `clientWidth = scrollWidth = 261px`; its text stayed inside the button
  border. The card measured `clientWidth = scrollWidth = 332px`, and the
  document and body widths equalled their viewports. No cell exposed a
  horizontal scroller.
- The headline and quiet Continue action both measured a minimum painted
  contrast ratio of 14.151:1 against the raised-paper card. All actions were
  reachable, every overlay card fitted its viewport, the normal Field Record
  fitted horizontally, and geometry was stable after 350ms.
- Keyboard focus stayed visible and cycled
  `Continue → Ask a grown-up → Continue → Ask a grown-up`. There were no
  page errors or request failures. One request for `/favicon.ico` returned
  404 in the first normal cell; it was adjudicated as design-harness chrome
  noise rather than an application-source failure.
- The fresh local evidence directory was
  `/tmp/ks2-151-candidate-4a627504-20260821T092218/`. Its `cells.json`,
  `summary.json` and `adjudication.json` files had SHA-256 values
  `baf263e717a5e65e620e0bebcf0f0d1d6ae72c22aa5518023fe69c172fb09a89`,
  `52ce2a722a2aab324a65ef147a6338cd89810cfc42172bb1e84fe737d110af01`
  and `05d5d41af096e85253ddb776a76ab4f99296095f66d400ed1aa626a0971791bf`
  respectively. The directory also contained the 18 screenshots and their
  per-file SHA-256 manifest.

| Viewport | Root text scales | States | CTA line boxes | Horizontal overflow | Minimum contrast | Focus and reachability |
| --- | --- | --- | --- | ---: | ---: | --- |
| 393×852 | 100 / 130 / 160% | normal + overlay | one per CTA label | 0px | 14.151:1 | pass |
| 375×667 | 100 / 130 / 160% | normal + overlay | one per CTA label | 0px | 14.151:1 | pass |
| 810×1080 | 100 / 130 / 160% | normal + overlay | one per CTA label | 0px | 14.151:1 | pass |

The source-level design-authority tests also passed 21/21. They guard the
raised-paper ink, stacked action grid, normal overflow wrapping and intact
no-wrap labels; they do not execute Chromium or prove the rendered facts
above.

## Remaining gates

This is desktop Chromium design-harness evidence for the Field Record and
Starter-complete overlay only. The broader #151 Layer 3 composition authority
and owner approval remain open. The #249 round-scene software-keyboard-up
focused-field and quiet-exit decision still requires real iOS WKWebView device
measurement. Physical iOS and Android devices, assistive-technology review,
signed builds, TestFlight, App Store review and release remain separate gates.
This record grants no physical-device, accessibility, signing, release, store
or broader Layer 3 authority.
