# App Store screenshot set

The current provisional set is listed below for working reference only; its final sequence is not locked:

- `Spell with confidence` — spelling practice.
- `Spell words. Grow companions.` — reward loop.
- `Master spellings. Discover a world.` — Codex breadth.

The original concepts remain in `concepts/`. Upload candidates belong in
`final/` and must use authentic application captures and repository-owned art,
show the app in use, accurately reflect released functionality, be opaque RGB,
and use one Apple-accepted screenshot size throughout the set.

Current iPhone upload candidates are:

- `final/01-spell-with-confidence-identical-1320x2868.png`
- `final/02-spell-words-grow-companions-no-age-1320x2868.png`
- `final/03-master-spellings-discover-a-world-identical-1320x2868.png`

They are opaque 1320 x 2868 RGB PNGs. Their numeric prefixes record the current
working order only and may change when later screenshot sets are added. Screen 2
uses the revised subtitle `A magical spelling adventure.`; the earlier age-
labelled export remains as history and is not selected for upload. The current
working board is `qa/final-sequence-no-age-wording.jpg`.

## iPad 13-inch exports

The selected iPad-native set is in `ipad-13-inch/final/` at Apple's accepted
`2064 x 2752` portrait size. Each file is an opaque RGB PNG. These compositions
were redesigned for the wider 4:3 canvas; they do not place the iPhone artwork
inside a tablet frame or use side-fill extensions.

The current working order is:

- `ipad-13-inch/final/01-spell-with-confidence-2064x2752.png`
- `ipad-13-inch/final/02-spell-words-grow-companions-2064x2752.png`
- `ipad-13-inch/final/03-master-spellings-discover-a-world-2064x2752.png`

The source concepts remain in `ipad-13-inch/concepts/`. The rejected framed
adaptations and their old comparison board remain under
`rejected/ipad-phone-framed/` for rollback and provenance. As with the iPhone
set, the numeric prefixes record the current working sequence rather than a
permanent order.

## Next set: screens 4-6

The approved follow-on set adds three non-duplicative product stories:

- `Every round is an adventure` — the Trail and travelling companions.
- `Know every word` — Word Bank learning states and progress.
- `Make spellings stick` — Camp and Guardian review.

The App Store-sized outputs are held separately while the final sequence remains
open:

- iPhone 6.9-inch RGB PNGs: `next-set/iphone-final/` (`1320 x 2868`).
- iPad Pro 13-inch RGB PNGs: `next-set/ipad-final/` (`2064 x 2752`).

The iPad files are independent 4:3 compositions rather than framed or extended
iPhone exports. Both directories pass the local App Store Connect screenshot
preflight with no errors or warnings.

## Third set: screens 7-9

The approved third set adds three later-funnel product stories while retaining
early companion stages:

- `Learn from every try` — truthful positive and corrective spelling feedback.
- `See every step forward` — internally consistent round results and returning words.
- `Grown-ups stay in control` — local learner profiles and progress.

The approved source compositions remain in `third-set/concepts/` and
`third-set/ipad-concepts/`. Exact duplicate exports were removed after the
complete final-nine set was consolidated. Working QA boards are
`qa/third-set-iphone-final.jpg` and `qa/third-set-ipad-final.jpg`.

## Selected final nine

The complete working upload set is consolidated under `final-v3/`:

- `final-v3/iphone/`: nine `1320 x 2868` RGB PNGs for `APP_IPHONE_67`.
- `final-v3/ipad/`: nine `2064 x 2752` RGB PNGs for
  `APP_IPAD_PRO_3GEN_129`.
- `final-v3/SHA256SUMS`: hashes for all eighteen selected files.

Both nine-image directories pass local App Store Connect preflight with no
errors or warnings. Upload remains an external operation and requires an
authenticated App Store Connect session or configured `asc` credentials.

To preserve the companion-growth reveal, screens 1, 2, 4, 5, 6, 7 and 9 use
early companion stages. Screen 3 is the deliberate late-stage payoff, while
screen 8 uses an egg and early companion. Screen 4 uses the real Smart Review
expedition setup rather than a zero-due Trail state, so its round-start claim is
visibly supported by the product UI. The superseded late-stage-heavy versions
remain under `rejected/mega-heavy/`.
