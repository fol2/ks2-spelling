# E2.5 migration note — TestFlight installs that bundled the full audio

Dated 2026-08-13. Companion record for slice E2.5 (issue #122, epic #92).
Covers what happens to a device that installed a pre-E2.5 build (TestFlight
0.5.0 (1) or earlier) and updates to a build that bundles only the Starter
audio.

## What the old builds left behind

Pre-E2.5 production builds did two things this slice removes:

1. **Bundled the full 451 MB audio set** under `dist/full/audio`
   (`createBundledFullAssets`, `vite.config.js`).
2. **Promoted and granted at every startup**: each learner aggregate was
   moved to `catalogue_id = 'ks2-core:full'` and given
   `granted_entitlement_ids_json = '["full-ks2"]'`
   (`promoteStarterCatalogue()` + `grantFullEntitlement()`).

So an existing TestFlight device holds full-catalogue aggregates and a
dev-era `full-ks2` grant in sqlite, while the updated binary no longer
carries any full-catalogue audio.

## What this build does on first launch

Startup migration (`resetFullCatalogueLearning()`, called from
`createProductAppServices` before any snapshot is read):

- Every aggregate with `catalogue_id = 'ks2-core:full'` is reset to a fresh
  Starter aggregate: catalogue `ks2-core:starter`, empty entitlement list,
  revision 0. The per-learner learning tables (subject state, practice
  sessions, events, monster states, camp states) are wiped by the existing
  `ON DELETE CASCADE` chain — the same mechanics as the parent-gated
  "reset learning" action.
- **Profiles survive** (nicknames, year groups, colours, selected learner).
- Learners whose aggregates are already Starter are untouched.
- The same reset runs after a backup import, so a backup exported from a
  pre-E2.5 build also degrades cleanly instead of resurrecting the
  full-catalogue state.

Net effect: the device behaves exactly like a fresh install — Starter fully
playable offline from the bundle, no code path that can request the removed
full audio, no half-playing words, no crash on the stored full-catalogue
snapshots.

## Why reset rather than preserve progress

Owner decision (roadmap owner-decision item 5, recommendation recorded
2026-08-13): **reset — no production users exist.** Preserving full-catalogue
progress under the Starter catalogue is not possible without violating the
frozen A3 snapshot invariants (the subject state references words the Starter
catalogue does not contain), and building a partial-preserve path for a
tester-only population is not worth the risk.

## What this does NOT touch

- **`app_entitlements` (commerce truth) is untouched.** The dev-era grant
  lived only in the per-learner spelling aggregates; store-verified
  purchases recorded by the B3/E2 commerce machinery survive the migration.
- The reset is currently unconditional for full-catalogue aggregates because
  this build has no source of full-catalogue audio at all. E2.6 (download
  delivery) replaces the call with entitlement-driven pack activation, at
  which point an entitled device re-downloads and re-activates the full
  catalogue instead of being reset.

## Tester-facing summary

After updating, the app opens on the same profiles but learning progress has
been reset and the word list is the 20-word Starter set. This is the planned
transition to the free-plus-purchase model; the full catalogue returns as a
purchasable download in a later build.
