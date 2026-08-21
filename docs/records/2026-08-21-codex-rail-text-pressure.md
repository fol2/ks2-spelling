---
module: product-design
tags:
  - measurement-run
  - codex
  - dynamic-type
problem_type: design-qa-record
---

# Codex rail text-pressure measurement — 2026-08-21

Status: design-harness-GREEN at
`94130688a9c24d7b9c6d92d9d07eb5cde5ae8c47`.

## Evidence

- The local design harness ran at `/design/?screen=monster` on Node 24.18.0
  with Vite 8.1.4.
- Each milestone figure and stats-label word was measured character by
  character with a DOM `Range`; unique rectangle tops were grouped as rendered
  line-box tops. Every figure and every word had exactly one top in every cell.
- The scrollport was moved to its measured maximum before the rail rectangle
  was compared with the scrollport and tab-bar rectangles. The rail was wholly
  visible in every cell.
- Both `document.documentElement` and `.product-app` measured zero horizontal
  overflow in every cell.

| Viewport | Root type | Rail | Maximum figure tops | Maximum word tops | Horizontal overflow | Tab-bar clearance |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 320×568 | 16 / 20.8 / 25.6px | four columns, two rows | 1 | 1 | 0px | 33.58–34.67px |
| 375×667 | 16 / 20.8 / 25.6px | four columns, two rows | 1 | 1 | 0px | 33.98–34.09px |
| 393×852 | 16 / 20.8 / 25.6px | four columns, two rows | 1 | 1 | 0px | 33.66–34.09px |
| 810×1080 | 16 / 20.8 / 25.6px | eight columns, one row | 1 | 1 | 0px | 33.88–34.27px |

## Remaining gates

The source-level design-authority check guards the four/eight-column
declarations and the two `overflow-wrap: normal` overrides; it does not execute
a layout engine. Physical iOS devices, accessibility inspection, signed release
builds and App Store submission remain separate gates. This measurement record
grants no physical-device, signing, release or store authority.
