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

The painted-scene surface shipped on 26 July replaced the earlier expedition
palette wholesale: the teal-and-coral set this table used to name
(`--trail`, `--trail-strong`, `--reward`, `--coral`, `--correct`) no longer
exists anywhere in the product. The table below is transcribed from the
`.product-app` custom-property block in `src/app/app.css`, which is the
authority for this surface; when the two disagree, the stylesheet is right and
this table is stale.

### Vellum

| Purpose | Token | Value |
| --- | --- | --- |
| Paper background | `--paper` | `#f8f5ec` |
| Raised paper | `--paper-raised` | `#fffdf7` |
| Sunk paper | `--paper-sunk` | `#faf6ec` |
| Primary ink | `--ink` | `#1d2b3a` |
| Muted ink | `--ink-soft` | `rgb(29 43 58 / 62%)` |
| Faint ink | `--ink-faint` | `rgb(29 43 58 / 45%)` |
| Hairline | `--line` | `rgb(29 43 58 / 12%)` |
| Stated rule | `--line-strong` | `rgb(29 43 58 / 22%)` |

### Dusk

Night-lit screens — Practice, Results, the Codex hero — invert onto the dusk
group rather than tinting the vellum one.

| Purpose | Token | Value |
| --- | --- | --- |
| Dusk ground | `--dusk` | `#080c12` |
| Raised dusk | `--dusk-raised` | `#101a26` |
| Dusk ink | `--dusk-ink` | `#fff9ec` |
| Muted dusk ink | `--dusk-ink-soft` | `rgb(255 249 236 / 62%)` |
| Dusk hairline | `--dusk-line` | `rgb(255 249 236 / 16%)` |

### Semantics

| Purpose | Token | Value |
| --- | --- | --- |
| Brand blue | `--brand` | `#3e6fa8` |
| Reward gold | `--gold` | `#e6cb8e` |
| Brass | `--brass` | `#a06b22` |
| Deep brass | `--brass-deep` | `#8a5a1a` |
| Brass for small text | `--brass-ink` | `#9e6a19` |
| Correct | `--good` | `#1f7a4f` |
| Bright confirmation | `--good-bright` | `#2f9e6a` |
| Needs another try | `--retry` | `#a2472a` |
| Soft mistake red | `--retry-soft` | `#d25757` |
| Focus ring | `--focus` | `#3e6fa8` |

`--good` and `--retry` are the recorded, ink-on-paper correctness colours: the
Field Record tallies, filter dots and word-bank status bars. `--good-bright`
and `--retry-soft` are the live signal pair, reserved for the moment an answer
lands — the answer underline and the round's done dots — and are lifted so they
read against the dusk backdrop. `--brass-ink` is `--brass` pulled to a legible
weight for tallies, growth bars and other small brass text.

### Support tokens

| Purpose | Token | Value |
| --- | --- | --- |
| Plate shadow | `--plate-shadow` | `0 1px 2px rgb(29 43 58 / 5%), 0 18px 40px -20px rgb(140 105 55 / 45%)` |
| Scene easing | `--ease` | `cubic-bezier(0.22, 1, 0.36, 1)` |
| Input-tier duration | `--t-input` | `200ms` |
| Scene-entrance duration | `--t-scene` | `240ms` |
| Between-rounds reveal | `--t-reveal` | `520ms` |
| Scene gutters | `--gutter-top/-right/-bottom/-left` | `max(0.75–1rem, safe-area inset)` |

Every screen keeps the same clearance from the physical screen edge through the
gutter tokens, and a surface that must meet that edge cancels exactly the
gutter it sits in rather than guessing.

A learner's own colour arrives as `--learner-colour` from
`src/app/learner-colour.js`; CSS fallbacks for it use the first entry of that
palette (`#1f6f77`) so an unresolved chip and a resolved one agree.

Per-plate scene veils stay literal gradients: each is mixed against one painted
backdrop and is not reusable.

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

Each tier has a duration token, and the tokens are the ceiling rather than a
suggestion: `--t-input` (200 ms) for a control changing state in place,
`--t-scene` (240 ms) for anything on the answer path entering, `--t-reveal`
(520 ms) for the between-rounds reveal. Screen furniture that carries no action
— toplines, section headings, the Camp ring — may take up to 320 ms. Odd
one-off durations may stay literal where a token would misdescribe them.

### Input tier

Anything on the answer path, including screen-to-screen navigation feedback,
lasts at most 240 ms, never blocks input and never moves the answer field.

An entrance counts as blocking input: a control animating in from `opacity: 0`
behind a `backwards` fill is not pressable, so the primary action of a screen —
Set off on the trail, Walk again and Trail on the results — enters within the
input tier and after a delay of at most 40 ms. A staggered arrival is still
welcome; it is built from small delays, not from long ones.

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

The Results screen sits between rounds, so its Field Record entrance — the
record card, the accuracy stamp and the growth bar — is classified here rather
than as screen furniture: one confident reveal in which the last element starts
no later than `--t-reveal` after entry. The actions below it are input tier and
arrive first, so the reveal never stands between a child and the way out.

No motion may create purchase pressure. The shaking answer field remains
forbidden.

## Canvas island

At most one bounded canvas island per screen may present companion state — the
Monster Stage on the Monster screen and the Celebration Stage over the Results
screen. A canvas never appears during a question card.

A canvas island never hosts input or navigation. It is hidden from accessibility
APIs (`aria-hidden`) behind a text equivalent on the same screen. It always ships
a static image fallback for context loss, boot failure and reduced motion, and
is destroyed while the app is backgrounded. All learning logic stays in the
frozen domain contract; the canvas is presentation only.

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
