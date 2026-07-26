# KS2 Spelling V2 visual authority

This document supersedes `docs/product/v1-visual-authority.md` for all product
screens. V1 remains historical evidence only.

## Direction

The Pocket Expedition direction grows into the Scribe Downs world: vendored
ks2-mastery region and monster artwork with recorded provenance becomes the
product's visual base. The app keeps its own ChildHome trail framing; the
ks2-mastery Hero surface is explicitly rejected and never ported.

The learning task always owns the strongest visual hierarchy. Rewards support
practice; they never interrupt an answer, hide progress or create purchase
pressure. The product remains playful for pupils aged 7–11 without resembling
an early-years toy.

## Local asset authority

- Raster artwork (webp) is permitted when every file is pinned by upstream
  commit, path, SHA-256 and byte size in `provenance/ks2-mastery-art.json` and
  verified by a repository script. Remote images, icon fonts and
  runtime-fetched illustration remain forbidden.
- Typography: body text stays on the installed system rounded stack from V1
  (`ui-rounded`, `SF Pro Rounded`, `Segoe UI`, then `sans-serif`). One bundled
  OFL-licensed display face (Fraunces woff2 subset, headings only) is permitted
  once its licence is recorded in `THIRD_PARTY_NOTICES.md` and its bytes are
  provenance-pinned. No remote fonts ever.
- Starter audio remains the separately recorded local C1 data pack. No visual
  state may imply that audio is ready when the local authority says otherwise.

## Semantic tokens

| Purpose | Token | Value |
| --- | --- | --- |
| Paper background | `--paper` | `#F7F1E3` |
| Raised paper | `--paper-raised` | `#FFFDF7` |
| Primary ink | `--ink` | `#17324D` |
| Muted ink | `--ink-soft` | `#526474` |
| Expedition teal | `--trail` | `#157A76` |
| Action teal | `--trail-strong` | `#0D625F` |
| Reward gold | `--reward` | `#E2A62B` |
| Support coral | `--coral` | `#D96B53` |
| Correct | `--correct` | `#247A4A` |
| Needs another try | `--retry` | `#A44937` |
| Focus ring | `--focus` | `#5B46B2` |

Backdrop tones may override presentation tokens through a `data-hero-tone`
attribute while correctness colours and the focus ring remain fixed.
Correctness is never conveyed by colour alone. Every state includes a heading,
plain-language explanation and, where useful, an icon with hidden decorative
semantics.

## Type and controls

- Body text follows the platform Dynamic Type base where available and never
  falls below `1rem`.
- Primary screen titles use a compact rounded display size, not all capitals.
- Controls have a minimum target of 44 by 44 CSS pixels and a visible
  `:focus-visible` ring.
- Text fields remain full-width at large text sizes. No answer or navigation
  control may require a horizontal scroll.
- Labels stay visible; placeholders are hints only.

## Motion tiers

### Input tier

Anything on the answer path, including screen-to-screen navigation feedback,
lasts at most 240 ms, never blocks input and never moves the answer field.

### Ambient tier

Backdrop cross-fade and slow pan, and monster idle life, may run continuously.
They stay calm and never urgent. Under `prefers-reduced-motion: reduce` they
are fully removed, leaving a static frame with the same information.

### Celebration tier

Monster caught/evolve moments and reward toasts are permitted only between
rounds. They are queued to the summary screen, shown one at a time, skippable
by tap, auto-completing, announced through a polite status region, and rendered
as a static text-equivalent card under reduced motion. Celebrations never
appear during a question card.

No motion may create purchase pressure. The shaking answer field remains
forbidden.

## Canvas island

Exactly one bounded canvas stage (Phaser) may present monster state. It never
hosts input or navigation, is hidden from accessibility APIs behind a text
equivalent, always ships a static image fallback for context loss and reduced
motion, and is destroyed while the app is backgrounded. All learning logic
stays in the frozen domain contract; the canvas is presentation only.

## Reference layouts

These layouts are the implementation reference, not separate approval gates.

| State | Primary region | Supporting region | Primary action |
| --- | --- | --- | --- |
| First run | Welcome and local learner setup | Local-data reassurance | Add learner |
| Learner picker | Large learner trail cards | Add learner and Parent entry | Continue |
| Child home | Greeting and next expedition | Scribe Downs backdrop; Inklet status and local audio state | Practise |
| Practice setup | Mode choice and round length | Mode cards with region art | Start |
| Practice | Listening controls and answer field | Backdrop tone follows round progress; card progress and quiet exit | Check spelling |
| Feedback | Saved result and correction guidance | Same listening controls | Continue or try again |
| Results | Round summary; queued celebration moments | Inklet progress earned from saved state | Back to trail |
| Progress | Secure and practising word counts | Recent round outcome | Continue practising |
| Monster | Monster Stage with living presentation | Text equivalent of stage and requirement | Back |
| Camp | Camp high-water and next locked step | Earning explanation | Back |
| Parent entry | Clearly grown-up-only route | No price or commerce copy in child view | Parent area |

## Responsive layout

Phones use one readable column with a sticky-safe bottom action region. Tablets
use a two-column expedition layout only where the practice surface remains at
least 28 rem wide. The content width is capped for readable line length, safe
areas are respected, and both orientations remain usable without changing the
meaning or order of controls.

## Accessibility contract

- Headings follow document order and each screen has one `h1`.
- Live feedback uses a polite atomic region; errors use `role="alert"` only
  when immediate correction is required.
- Decorative artwork — SVG, raster backdrops and the canvas stage — is hidden
  from accessibility APIs. Meaningful state has an accessible name and text
  equivalent.
- Reading and focus order match the visual order.
- Keyboard, switch and screen-reader users can reach every action and leave
  every child screen.
- Reduced motion, increased text size, high contrast and no-audio recovery are
  first-class states, not final polish.
