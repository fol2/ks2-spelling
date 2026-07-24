# C7 spelling feel-parity plan

Goal of the series: the iOS port should feel like the **same product** as the
ks2-mastery webapp's spelling experience — same tone, same theme, same
composition, same reward loop. C6 ported the art and the practice mechanics;
C7 ports the *feeling*. Scope is spelling only.

Grounding: a side-by-side play test on 2026-07-24 (simulator "KS2 Play
iPhone 17" vs ks2.eugnel.uk demo) found the two apps mechanically equivalent
but experientially different. The four gaps, in order of felt impact:

1. **Composition.** Web is world-first: full-bleed backdrop, small translucent
   panels floating over the scene. Mobile is card-first: opaque cream cards
   dominate and the backdrop peeks around the edges.
2. **Reward loop.** Web catches a monster per round into a meadow that
   visibly populates, with a codex to fill. Mobile has a single companion on
   a slow secure-words growth track ("0 secure words are now helping Inklet
   grow" after a full first session).
3. **Identity.** Web: Fraunces display serif, light + dark token system,
   personalised greeting, named place. Mobile: divergent pastel palette,
   rounded sans, light-only, form-app copy ("Who is practising?").
4. **Round agency.** Web: dot progress strip, attempts counter, skip-for-now,
   end-round-early, show-sentence and auto-play toggles, 0.5× replay label.
   Mobile: length + voice only; the completed-words "Card N of 5" counter
   reads as stuck while a learner cycles through different words.

Source of truth for every port below is the local ks2-mastery checkout
(`~/Coding/ks2-mastery`), the same repo the C6 art was vendored from.
Milestones are work slices, not approval gates. Every slice keeps
`npm run test:fast`, `npm run lint` and `npm run build` green.

## C7.1 — design-token and typography parity

**Goal.** Replace the divergent `.product-app` palette with the webapp's
token system, both themes, and the Fraunces/Inter pairing.

**Key files.** Port the `:root` token block (surfaces, ink, lines, semantic
tones, brand, shape, elevation, `--tap-min`, typography, motion) from
ks2-mastery `styles/app.css` into `src/app/app.css`, including the
`prefers-color-scheme: dark` and `[data-theme]` variants; self-hosted
Fraunces subset (OFL notice — already anticipated by C6.2) and Inter with
system fallbacks; map existing `.product-app` custom properties
(`--paper`→`--bg`, `--trail`→`--brand`, `--correct`/`--retry`→`--good`/
`--bad`, etc.) rather than renaming every call site in one slice;
`THIRD_PARTY_NOTICES.md` font entries; no new runtime dependencies.

**Verification.** Simulator screenshots in light and dark match webapp token
values; contrast table still passes against both themes; fonts load from the
bundle with no network fetch.

## C7.2 — world-first composition

**Goal.** Invert card-over-wallpaper into panels-over-world on every product
screen.

**Key files.** Composition patterns from ks2-mastery
`src/platform/ui/PracticeStage.jsx`, `SessionHUD.jsx`, `HomeHeroScene.jsx`,
`SetupSidePanel.jsx` and `src/subjects/spelling/components/
SpellingHeroBackdrop.jsx`: full-bleed `HeroBackdrop` behind ChildHome,
PracticeSetup, PracticeScreen and Summary with translucent panel surfaces
(`color-mix` over `--panel`, backdrop blur where cheap) instead of opaque
cards; hero welcome line via the `heroWelcomeLine` contract
(`src/platform/ui/hero-copy.js`) plus the home hero headline pattern
("Today's words are waiting." / "Nothing due today — explore for fun.");
surface the vendored place name (The Scribe Downs) in home and setup copy;
existing reduced-motion and contrast guards keep working.

**Verification.** Side-by-side screenshots: backdrop visible behind every
product screen; panel text passes contrast on all three tones; greeting and
place naming render; reduced motion still shows a static frame.

## C7.3 — round-surface parity

**Goal.** Make the in-round card read and behave like the web session scene.

**Key files.** ks2-mastery `src/subjects/spelling/components/
SpellingSessionScene.jsx` and `session-ui.js` as reference: dot progress
strip plus "You have answered N of M" attempts counter replacing the
completed-words "Card N of 5" label; skip-for-now (maps to the engine's
existing skip path) and end-round-early (summary for answered words, replaces
bare Leave-and-discard); show-sentence and auto-play-audio toggles on
PracticeSetup persisted per learner; serif italic input treatment and
"Replay slowly" 0.5× labelling; "AI-generated dictation voice" disclosure
line; feedback card styling aligned with web (colour tokens from C7.1).

**Verification.** Counter advances on every submission; skip and end-early
round-trip through the A3 contract without new command types (or the slice
documents the planner-level RED tests if one is needed); toggles persist and
apply; parity screenshots against the web session card.

## C7.4 — meadow and the catch loop

**Goal.** Surface the per-round monster catch that is the webapp's core
reward, using events and art the app already ships.

**Key files.** The C6.5 monster projection already diffs caught/evolve
events at summary entry; present them as the web does: a catch moment on the
summary (existing celebration layer), then a home **MonsterMeadow** that
populates — port `src/surfaces/home/MonsterMeadow.jsx` composition and its
empty state ("Nothing caught yet. Your meadow stays tidy. Finish a round to
see your first monster appear."); codex-lite screen replacing the single
Monster page: caught species grid (`CodexCard`/`CodexCreature` reference)
over the vendored glimmerbug and phaeton art alongside inklet (vellhorn
stays unreachable per the C6 simplification); Phaser stage reused for the
selected creature; growth stays secure-words-driven — no purchases, no
tapping economy, no Hero Coins.

**Verification.** Finishing a round that secures a word produces a visible
catch/evolve moment and a populated meadow slot; empty state matches web
copy; codex-lite lists only vendored, reachable species; monster projection
tests stay green.

## C7.5 — where-you-stand and the word bank

**Goal.** Give the learner (and parent) the web's sense of standing and
transparency.

**Key files.** "Where you stand" stat panel on PracticeSetup — total
spellings, secure, due today, weak spots, unseen, accuracy — derived from
existing A3 projections (`StatCard` composition reference); word-bank
browser screen ported from `SpellingWordBankScene.jsx` /
`SpellingWordDetailModal.jsx` over the runtime catalogue already bundled;
entry points mirroring web (setup side panel and parent progress).

**Verification.** Stat values reconcile with the parent progress projection
on the same state; word bank lists the full runtime pack with per-word
progress; no new storage schema.

## C7.6 — copy and content polish

**Goal.** Close the small felt gaps the play test surfaced.

**Key files.** Post-round monster copy — replace the deflating "0 secure
words are now helping Inklet grow" with staged encouragement keyed off the
catch loop; "1 more secure words" pluralisation fix; content fix for the
misleading cloze "The castle is famous with visitors from many countries."
(natural collocation is "popular with"; either reword the sentence or accept
the risk consciously) — content lives in the vendored pack, so route the fix
through the upstream ks2-mastery content and re-vendor under provenance
rather than editing vendored bytes.

**Verification.** Copy tests updated; vendored-content provenance stays
byte-identical to the pinned upstream commit.

## C7.7 — re-verification

**Goal.** Same bar as C6.7: run the full C5 bundle on the uplifted tree,
one independent read-only verification, then freeze. If C6.7 has not run
yet when C7 lands, fold both into a single re-verification pass.

## Deliberate simplifications

- No Hero Coins / camp economy — the meadow populates from play alone.
- No multi-subject codex; codex-lite is spelling species only.
- Vellhorn remains vendored but unreachable (unchanged from C6).
- No keyboard-shortcut layer (touch platform).
- No theme toggle UI; theme follows the system setting.
- Fraunces subset covers Latin only.
