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

The B1–B4 proof shell is outside this surface. Its CSS lives in
`src/app/b4-shell.css`, imported only by `App.jsx` and the B4 harness; the
production root alias selects `ProductRoot.jsx`, so the proof-shell CSS is not
part of the product bundle.

## Local asset authority

- Raster artwork (webp) is permitted when every file is pinned by upstream
  commit, path, SHA-256 and byte size in `provenance/ks2-mastery-art.json` and
  verified by a repository script. Remote images, icon fonts and
  runtime-fetched illustration remain forbidden.
- Typography: Fraunces is the shipped, self-hosted OFL display serif for
  headings and figures; Inter carries interface chrome. Both use local woff2
  subsets and their system fallbacks. No remote fonts ever.
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
| Cream control face | `--cream` | `#fffaf0` |
| Cream control depth | `--cream-deep` | `#f0e3c9` |
| Cream control ink | `--cream-ink` | `#131b25` |
| Deep brand | `--brand-deep` | `#274d79` |
| Deep retry ink | `--retry-ink-deep` | `#8d3a29` |
| Parent paper | `--paper-parent` | `#eae6db` |

`--good` and `--retry` are the recorded, ink-on-paper correctness colours: the
Field Record tallies, filter dots and word-bank status bars. `--good-bright`
and `--retry-soft` are the live signal pair, reserved for the moment an answer
lands — the answer underline and the round's done dots — and are lifted so they
read against the dusk backdrop. `--brass-ink` is `--brass` pulled to a legible
weight for tallies, growth bars and other small brass text.

The Codex keeps its gold local to `.codex-scene`: `--codex-gold` is the RGB
triplet `226 166 43`, and `--codex-gold-ink` is `#f0cd88`. The warm quest bead
is deliberately literal at `#eddcb6`; it is a bespoke pair, not a colour token.

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

### Radius and type policy

Radius and type tokens are minted only for an identical value repeated at least
three times in the same role at convertible sites. The replacement is an
identical-value swap, never a visual approximation. `clamp()` headings, media
overrides, asymmetric corners and boot surfaces remain literal. There are no
spacing tokens: the hand-set rhythm is the design.

| Purpose | Token | Value |
| --- | --- | --- |
| Small radius | `--r-s` | `0.9rem` |
| Pill radius | `--r-pill` | `999px` |
| Note | `--fs-note` | `0.75rem` |
| Caption | `--fs-caption` | `0.78rem` |
| Small body | `--fs-body-s` | `0.85rem` |
| Body | `--fs-body` | `0.95rem` |
| Title | `--fs-title` | `1.05rem` |

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

- Body copy uses `--fs-body` (`0.95rem`).
- Primary screen titles and figures use Fraunces; interface chrome uses Inter.
  The display face is not an all-caps system.
- Controls have a minimum target of 44 by 44 CSS pixels and a visible
  `:focus-visible` ring.
- Text fields remain full-width at large text sizes. No answer or navigation
  control may require a horizontal scroll.
- Labels stay visible; placeholders are hints only.
- Every actionable surface in Parent uses `press` or `press-soft`; `.press`
  activates only through `:not(:disabled)`. Pills have a `2.75rem` minimum
  height, meeting the 44 pt floor; the non-actionable sheet grip is exempt.
- Destructive actions climb through reveal, typed confirmation and commit. The
  outlined `button-quiet`, `button-warning` and `button-destructive` controls
  reveal consequence; the filled `button-danger` commits it. All four share
  the same `2.75rem` metric line, so a mixed parent-action row remains level.

## Boot surface

Loading and recovery paint before `.product-app` exists, so `.app-boot` is a
self-contained literal-value family outside it. It uses the same vellum,
Fraunces title and `#f8f5ec` document theme colour without depending on product
tokens; it also remains scrollable for recovery detail. `.button-primary` is
shared with this family and therefore keeps its literal cream gradient and
`999px` border radius. Neither the boot surface nor that button is tokenised.

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

The learner switch sheet has a cue only when a qualifying drag dismisses it:
the haptic tick precedes `sheet.wav`, which precedes dismissal. A scrim tap is
silent, and mounting the sheet has no cue; the grip is a gesture affordance,
not a sound trigger.

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

The celebration model owns named timing. `CELEBRATION_BEATS` is the single
source for each kind; `celebrations.css` mirrors those delays literally and
the live evolve scene quotes the same values. A bounded Results queue presents
one card at a time, with tap-to-skip and an automatic finish.

| Kind | Named beats from mount (ms) | Duration and cue |
| --- | --- | --- |
| Caught | veil 0; rise 120; burst 340; copy 650; settle 1020 | 3000 ms; catch |
| Evolve | veil 0; silhouette 90; shockwave 420; reveal 760; copy 1080; settle 1400 | 3400 ms, or 4000 ms at final form; evolve |
| Progress | veil 0; mark 90; copy 380 | 2400 ms; tick |
| Camp level | veil 0; mark 110; copy 430 | 2800 ms; flourish |
| Milestone | veil 0; mark 110; copy 430 | 2800 ms; flourish |
| Achievement | veil 0; mark 110; copy 430 | 2800 ms; flourish |

Camp-level, milestone and achievement cards share the camp-level mark shape
and brass palette. Milestone and achievement are record moments, not monster
moments; they keep the same readable 2800 ms flourish cadence.

No motion may create purchase pressure. The shaking answer field remains
forbidden.

## Canvas island

At most one bounded canvas island per screen may present companion state — the
Monster Stage on the Monster screen and the Celebration Stage over the Results
screen. A canvas never appears during a question card.

A canvas island never hosts navigation. It is hidden from accessibility APIs
(`aria-hidden`) behind a text equivalent on the same screen. It always ships a
static image fallback for context loss, boot failure and reduced motion, and is
destroyed while the app is backgrounded. All learning logic stays in the frozen
domain contract; the canvas is presentation only.

The Monster Stage is opt-in behind the Codex zoom: roster and hero remain still
plates, and the Phaser chunk loads only when a learner chooses to look closer.
Its painterly depth comes from the shared `twinkleSparks` primitive, a rare
LCG-timed preen after 20–35 seconds, and a final-form evolution aura with a
second ring and brass twinkles. The still plate remains the fallback.

## Records surfaces

Camp shows `Records of the watch` only after an unlock. Its only surfaceable
chips are `GUARDIAN_7_DAY` and `RECOVERY_EXPERT`; Boss Clean Sweep and Pattern
Mastery are unreachable here and are never shown. There is no progress before
an unlock.

At Results, the record queue is ordered monsters, milestones, achievements,
then camp-level. The Codex milestone ladder reads
`SPELLING_MASTERY_MILESTONES` through the certified spelling façade, so it
cannot advertise a number the engine will not celebrate. When a found companion
is one to three secure spellings from its next evolution, `data-near` raises a
brass `N more` line and glint; outside that window the card stays calm.

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
- Accessibility hardening remains a CSS layer after the visual stylesheet:
  `celebration-hardening.css` and `trail-meadow-hardening.css` retain their
  test-pinned filenames and imports so modal focus, scrolling, contrast and
  responsive recovery stay protected without changing the visual authority.
