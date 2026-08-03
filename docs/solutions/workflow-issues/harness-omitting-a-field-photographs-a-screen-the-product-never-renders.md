---
title: A harness that omits a field photographs a screen the product never renders
date: 2026-08-03
category: workflow-issues
module: design-harness
problem_type: workflow_issue
component: development_workflow
applies_when:
  - "A harness, preview or fixture stands in for a real store and a screen is verified from what it renders"
  - "A product projection grows a field the fake store does not publish"
  - "A component guards a whole section on the length of a defaulted collection"
  - "A clipping container holds bottom-anchored or absolutely positioned content"
  - "A gallery of screenshots is about to be treated as evidence for a layout decision"
symptoms:
  - "Every harness screenshot of a screen shows one row fewer than any real user sees"
  - "A device clips content off the top of a bottom-anchored block while no scrollbar, warning or test reports it"
  - "The one caption that explains an unfamiliar visual state has never been read on a real phone"
  - "A capture of the defect sits on disk overnight and the run is written up without the defect being named"
root_cause: incomplete_setup
resolution_type: tooling_addition
severity: high
related_components:
  - "development_workflow"
  - "testing_framework"
  - "product_ui"
tags:
  - "design-harness"
  - "visual-verification"
  - "fixture-fidelity"
  - "screenshot-evidence"
  - "layout-overflow"
  - "safe-area"
  - "physical-device"
  - "polish-round-2"
---

# A harness that omits a field photographs a screen the product never renders

## Context

`design/harness.jsx` is the instrument this project verifies visual work with.
It mounts the real `ProductApp` over in-memory services
(`design/harness.jsx:498`), so every screen can be walked at any viewport in a
browser without a native platform underneath it. The boot surfaces are the one
exception and are mounted directly, because they paint before any service
exists (`design/harness.jsx:501-503`). It is served with
`npx vite --config vite.design.config.js --port 5183`, and the product screens
render at the path **`/design/`**. The bare root is not the same application:
`vite serve` on the repository's own `index.html` reaches the product entry,
which needs SQLite, StoreKit and the audio pack and can therefore only paint
the B2 proof shell (`vite.design.config.js:3-7`). A screenshot session pointed
at `http://localhost:5183/?screen=setup` is photographing something else
entirely, which cost time once in the session that produced this record. The
round-2 workflow that rests on all of this is written down in
`reports/polish-round2/README.md:70-77`.

The engine behind the harness is faked on purpose, and the header says so
(`design/harness.jsx:1-8`): a fixed word list and a "right if you typed the
target" rule reach every visual state, and the real engine is out of scope for
design work. The learning store is a plain object literal
(`design/harness.jsx:274`). Through the whole of polish round 2 that literal
carried no `vocabularySets` key at all.

The product always supplies one. `vocabularySetsProjection`
(`src/app/product-learning-controller.js:155-173`) is computed on every state
build (`:280`) and returns Core plus whichever year bands the catalogue holds,
dropping any empty set at `:172`. Against the vendored full catalogue
(`vendor/ks2-mastery/content/spelling.mobile-runtime-full.json`) that
projection is Core 213, Y3–4 109, Y5–6 104 — the counts the harness constant
now carries (`design/harness.jsx:158-162`). Against the starter catalogue it is
Core 20 and Y3–4 20, with Y5–6 filtered out. Either catalogue yields a
non-empty field, so a real learner always has a rail to look at, on every quest
but a Guardian mission (`src/app/ProductApp.jsx:2443`).

With the key absent, `learningState.vocabularySets` (`ProductApp.jsx:3416`) was
`undefined`; the screen's own default parameter `vocabularySets = []`
(`ProductApp.jsx:2255`) turned that into an empty list; and the `length > 0`
guard removed the "Vocabulary set" label and the whole pill row
(`ProductApp.jsx:2443-2447`). Nothing threw, nothing warned, and the result was
still a legitimate screen — the one a learner with no published sets would see.
The Word bank reads the same field (`ProductApp.jsx:3465`) and went quiet in a
different way: `publishedVocabSets` treats a non-array as "infer the sets from
the projected words" (`src/app/word-bank-model.js:119-121`, fallback at `:139`),
so that screen still painted a rail and still looked right. One missing field,
two different silences, and no signal from either.

What the missing row concealed is a clipping defect. `.setup-quest` is a
bottom-anchored column — `justify-content: flex-end` with
`overflow: visible clip` (`src/app/app.css:1730-1749`) — so when its content
outgrows its share, the overflow is taken off the **top**: no scrollbar, no
console warning, no failing test. Put the rail back and the tray grows; the
quest column gives up that height; and the first things to leave are the
`TODAY'S QUEST` kicker (`ProductApp.jsx:2337-2339`, styled at
`app.css:1762-1771`) and the companion wake hint (`ProductApp.jsx:2334-2336`).
Measured in the harness once the field had been restored, the content ran 72px
past its share at 402×874, putting the hint at y = −71px and the kicker at
−25px; at 390×844 the block title itself was clipped
(`reports/polish-round2/e2e-simulator-run.md:205-230`). The wake hint — "Secure
spellings here to wake this companion." — is the only copy that explains why an
unfound companion is drawn as a faint silhouette. Being first in the column, it
was the first line to go, so it had never been read on a phone.

A second cause was hiding behind the first. `.setup-tray` reserved
`max(1.25rem, var(--gutter-bottom))` at its foot, and `--gutter-bottom` is the
home-indicator safe area (`src/app/app.css:122`). The waypoint bar that sits
below the tray already carries that inset on its own foot
(`src/app/app.css:511-523`), so the same 34pt of hardware was allowed for
twice. The tray now takes a flat `0.85rem`, with the reasoning kept in the
block (`src/app/app.css:2096-2117`).

The fix landed as commit `68a4d47c` on `agent/polish-round-2` and reached
`main` through **PR #63** (verified merged). It restored the harness field and
added an `?unfound-companion=true` flag that reaches the sleeping-companion
state at all (`design/harness.jsx:9-19`, `:241`, `:253-264`, `:486-496`);
tightened the quest column's rhythm; took the duplicated safe-area gutter out
of the tray; and moved the wake hint out of the text column entirely —
absolute, bottom-right, `width: min(11rem, 45%)` (`src/app/app.css:1800-1816`)
— with the sleeping companion art lifted to `bottom: 3.1rem` so its caption has
room (`src/app/app.css:1818-1821`). The clip itself was left alone: it is what
keeps overflow off the chrome.

The fix is partial, and the round says so. The Setup quest block is still
over-subscribed at 375×667 and 320×568: the title moved from −24 to +7 at
375×667, but the block still collapses to 108px there and to 30px at 320×568,
where the tray and the quest tiles consume the column
(`reports/polish-round2/e2e-simulator-run.md:295-299`). Two further residuals
belong to this record rather than to the layout. The round's harness galleries
in `reports/polish-round2/before/` and `reports/polish-round2/after/` were all
captured before the field was restored and were never re-shot afterwards —
`git log 68a4d47c..9ee4018a -- reports/polish-round2/before reports/polish-round2/after`
returns nothing — so those images still show a Setup screen with one row fewer
than the product draws. And nothing in the tree asserts the harness store's
shape: `design/` is outside the lint scope (`package.json:16`) and no test
references the design harness at all. (Grepping `tests/` for "harness" does
return hits — an unrelated database harness and a pack reconciler — so grep
alone will suggest coverage that is not there.)

The order of discovery is the part worth keeping. The slice 4.3 simulator run
photographed Setup at 402×874 on the night of 1 August, and the run was written
up with four defects and seven residuals without anyone naming what that
capture shows (commit `59851785`). The clipped block was recognised only after
the closing build was on a real handset; the follow-up documentation commit
calls the two late findings "the two defects the device build found"
(`9384ab92`), and that same commit renamed the existing capture to
`reports/polish-round2/e2e/02-defect-setup-dimmed-egg-clipped-header.png`.
The evidence had been on
disk overnight — committed at 23:11, named at 09:32 the next morning. What was
missing was a picture that could contradict it — every harness screenshot of
Setup that round showed the screen with the row removed.

## Guidance

**Fake the shape, not the happy path.** A harness that fakes a store is only as
truthful as the shape of the data it fakes. Every key the product's projection
publishes should exist in the fake, with a value of the same kind, even when the
screen under review does not read it. A missing key is not a smaller test — it
is a different product.

**Treat a defaulted prop as a place where a fake can fail silently.**
`vocabularySets = []` (`ProductApp.jsx:2255`) is reasonable production code and
was exactly what converted an omission into a plausible empty state. Wherever a
component defaults a collection and then guards a whole section on its length,
a harness that forgets the field will render the guarded-out branch and look
completely normal. Those two lines together are the signature to look for.

**Assert the fake against the real contract instead of remembering to look.**
Remembering does not scale across a polish round with dozens of captures. A
key-set assertion runs in milliseconds and fails on the day the projection
grows a field, which is the day the harness silently stops matching. See the
Examples for what such a guard would cost here and what it would not catch.

**Prefer the real projection to a hand-written constant when it is
affordable.** The harness now hard-codes Core 213 / Y3–4 109 / Y5–6 104
(`design/harness.jsx:158-162`). Those numbers are correct against the vendored
full catalogue today; they are a copy, and copies drift. Deriving them from the
catalogue would need `vocabularySetsProjection` exported from
`product-learning-controller.js`, which is a real change to a module boundary.
Copying is a legitimate choice here — but a copy should be checked, not
trusted.

**When a row comes back, re-measure and re-shoot.** Restoring a field changes
the layout, so measurements taken before it are void and screenshots taken
before it are not evidence any more. This round did the measuring and skipped
the re-shooting; the galleries are stale, and that is recorded above rather
than quietly left.

**Keep the instrument's operating instructions inside the instrument.** The
query flags now live in the harness header (`design/harness.jsx:9-19`) and the
serving command and viewports in `reports/polish-round2/README.md:70-77`. The
`/design/` path in particular is the kind of detail that costs an hour when it
is only in someone's memory.

## Why This Matters

The failure mode is specific, and it is worse than a symmetric error. Omitting
a field **under-represents** content: it removes whatever that field renders and
leaves everything else in place, so every layout judgement made from the
resulting screenshots is biased in one direction — towards "there is room".
A harness that over-represented content would produce false alarms, which get
investigated. One that under-represents produces false calm, which does not.

The bias compounds when the layout absorbs overflow silently. A bottom-anchored
column behind `overflow: clip` has no failure signal at all: no scrollbar, no
warning, no exception, and no assertion in any suite. The only detector is a
photograph at a real viewport — which is precisely the detector the missing
field had disabled.

It also matters which copy goes first. Clipping at `flex-end` eats the top of
the block, and the top of this block is where the orientation lives: the kicker
that names the screen and the caption that explains a silhouette. The content
that disappears first is the content a first-time learner most needs, and the
content a returning reviewer is least likely to miss.

Finally, there is the cost ladder. The harness is the cheapest instrument in
this project — a browser, a port, any viewport in seconds. The simulator run is
expensive, hours long, and constrained about what it may conclude
(`reports/polish-round2/e2e-simulator-run.md` states its own keyboard limits
plainly). Physical device time is the scarcest of all. A defect that gets past
the cheapest instrument is not caught by a cheaper one later; it is caught by a
more expensive one, or by a person holding a phone. Keeping the cheap
instrument honest is what keeps the expensive ones for the problems only they
can find.

## When to Apply

- Whenever a harness, preview, story or fixture stands in for a real store, and
  a screen is verified from what it renders.
- When a projection in the product grows a new field. The harness will not
  fail; it will simply keep drawing the previous product.
- When a component guards an entire section on `length > 0`, `?.` or a defaulted
  collection. Ask what the harness supplies for it.
- When a container clips (`overflow: clip`/`hidden`) and its content is
  bottom-anchored or absolutely positioned. Overflow there is invisible by
  construction, so the fidelity of the input data is the whole verification.
- Before treating a gallery of screenshots as evidence for a layout decision,
  and again after any fix that changes what the harness feeds the screen — at
  which point the old gallery has expired.
- When a screenshot session and the product disagree about what a screen
  contains. Check the path being served before doubting the code.

## Examples

### The omission, and what it produced

The harness store carried the roster but not the sets. The line that now exists
is the whole of the fix on the harness side (`design/harness.jsx:290`):

```js
monsters: harnessMonsters,
vocabularySets: empty ? [] : VOCABULARY_SETS,
```

Before it, the consuming screen behaved exactly as designed:

```js
// src/app/ProductApp.jsx:2255 — a reasonable default…
vocabularySets = [],
// …and src/app/ProductApp.jsx:2443 — that removes the row without complaint.
{vocabularySets.length > 0 && !guardianRuns && (
```

The same undefined value reached the Word bank and was absorbed differently
(`src/app/word-bank-model.js:119-121`), which is why nothing anywhere looked
wrong:

```js
const explicit = Array.isArray(value);
const candidates = explicit ? value : inferredVocabSets(words);
```

### A cheap guard, and its honest limits

No such guard exists in this repository today. If one were added, the smallest
version that would have caught this is a key-set comparison between the fake
store and the controller's published state. The controller side is already
cheap: `tests/product-learning-controller.test.mjs:56` builds a real controller
in Node over `loadStarterSpellingCatalogue()`, so the published keys are one
`getState()` away. The harness side is the awkward half — `design/harness.jsx`
calls `createRoot` at module scope and reads `globalThis.location`, so it
cannot be imported from a test as it stands. Three routes, with their costs:

1. **Extract the fake store into its own module** that both the harness and a
   test import, then assert the key sets match. The most honest check; costs
   one new module and a small refactor of the harness.
2. **Read the harness as text** and require every published key name to appear
   in it. No restructuring at all, and it would have failed on this defect —
   but it proves only that the name is mentioned somewhere in the file, not
   that the value has the right shape or reaches the store.
3. **Make the screen refuse to be silent** by dropping the `= []` default at
   `ProductApp.jsx:2255`, so a missing field throws instead of rendering a
   plausible screen. Cheapest of all, and the trade-off is real: the component
   becomes less tolerant, and every other caller — the harness and any test
   that renders Setup — must supply the field.

What none of them would have caught: a field that is present but wrong. A
harness carrying one pill where the product draws three, or counts an order of
magnitude out, passes every check above and biases the layout the same way,
just less. Nor would any of them have found the clipping defect itself — a key
assertion cannot see that a bottom-anchored column is 72px over budget. The
value of the guard is narrow and worth being clear about: it does not verify
the layout, it makes the screenshot that verifies the layout honest.

### The double safe-area allowance, kept as a comment

Worth repeating as a pattern in its own right, because it is the other half of
the reclaimed height and the code now explains itself
(`src/app/app.css:2100-2103`):

```css
/* The waypoint bar sits below this tray and already carries the home
   indicator on its own safe-area foot, so a bottom gutter here was a second
   allowance for the same hardware — 34pt of dead space that the quest block
   above needed. The tray keeps its own rhythm instead. */
```

A safe-area inset belongs to whichever element actually touches the hardware
edge. When a fixed foot sits below a scrolling or flexing region, both
elements claiming the inset costs the layout the space twice, and the loss
lands wherever the flex algorithm decides — which, behind a `flex-end` clip, is
out of sight.

## Related

Four docs in this store are siblings of this one. Together they say one thing:
an instrument can be silent for reasons that have nothing to do with the code
being correct.

- `docs/solutions/integration-issues/dictation-software-keyboard-ios27-incident.md`
  — the nearest sibling, with the polarity reversed. There, driving typing
  through an accessibility or HID bridge flips the simulator into
  hardware-keyboard mode and **manufactures** a look-alike of a real defect: a
  false positive. Here a starved fixture **conceals** one: a false negative.
  Same instrument class, opposite failure.
- `docs/solutions/workflow-issues/gating-physical-ios-installs-on-application-composition.md`
  — the store's existing statement of the same prevention shape: build success,
  install success and process launch do not prove the requested product
  experience. This learning extends it by one step — render success does not
  prove it either, when the data behind the render is not the product's data.
- `docs/solutions/logic-errors/test-doubles-that-accept-more-than-the-contract.md`
  — the unit-test dialect of the fixture-breadth rule, and worth reading for
  the difference as much as the likeness. That doc's stand-in accepts *more*
  than the real contract, so an invalid caller stays green. This one supplies
  *less* than the real store, so a valid screen renders incomplete. And the
  detection channels differ: a test double lives inside a suite that can go
  red, whereas the harness is not a test at all. Nothing in it can fail. Its
  only failure mode is a picture of a screen nobody has.
- `docs/solutions/integration-issues/capacitor-sqlite-value-less-dml-executes-as-a-no-op.md`
  — from the same round, and the fourth member of the family: an off-device
  Node harness that could not see a defect the platform adapter had.

Evidence for this record:

- `reports/polish-round2/e2e-simulator-run.md` — D6, its measurements, and the
  residual sizes it did not solve.
- `reports/polish-round2/README.md` — the screenshot workflow and the viewports
  this round used.
