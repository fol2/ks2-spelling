# KS2 Spelling V1 visual authority

**Superseded:** `docs/product/v2-visual-authority.md` replaces this document for
all product screens from C6 onward. This file remains historical evidence for
the pre-C6 checkpoints.

## Direction

The product uses a **Pocket Expedition** direction: a calm paper field, an ink
trail through practice, and one friendly Inklet companion. It should feel
playful to pupils aged 7–11 without resembling an early-years toy or a school
admin dashboard.

The learning task always owns the strongest visual hierarchy. Rewards support
practice; they never interrupt an answer, hide progress or create purchase
pressure.

## Local asset authority

- Typography uses installed system faces only:
  `ui-rounded`, `SF Pro Rounded`, `Segoe UI`, then `sans-serif`.
- Icons are semantic text plus repository-owned inline SVG. No icon font,
  remote font, remote image or runtime-fetched illustration is permitted.
- Inklet and Camp artwork is repository-owned vector geometry created for this
  project. It is decorative unless its state is also stated in text.
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

## Motion

Use one short ink-trail reveal on navigation and one restrained Inklet reaction
after saved learning progress. Motion lasts at most 240 ms, never blocks input,
and is removed under `prefers-reduced-motion: reduce`. No confetti, shaking
answer field, autoplaying loop or reward modal is permitted.

## Reference layouts

These layouts are the implementation reference, not separate approval gates.

| State | Primary region | Supporting region | Primary action |
| --- | --- | --- | --- |
| First run | Welcome and local learner setup | Local-data reassurance | Add learner |
| Learner picker | Large learner trail cards | Add learner and Parent entry | Continue |
| Child home | Greeting and next expedition | Inklet status and local audio state | Practise |
| Practice setup | Round length and year band | Plain description of Smart Review | Start |
| Practice | Listening controls and answer field | Card progress and quiet exit | Check spelling |
| Feedback | Saved result and correction guidance | Same listening controls | Continue or try again |
| Results | Round summary | Inklet progress earned from saved state | Back to trail |
| Progress | Secure and practising word counts | Recent round outcome | Continue practising |
| Monster | Inklet stage and secure-count requirement | Text equivalent of visual state | Back |
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
- Decorative SVG is hidden from accessibility APIs. Meaningful state has an
  accessible name and text equivalent.
- Reading and focus order match the visual order.
- Keyboard, switch and screen-reader users can reach every action and leave
  every child screen.
- Reduced motion, increased text size, high contrast and no-audio recovery are
  first-class states, not final polish.
