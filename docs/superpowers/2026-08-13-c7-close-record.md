# C7 shipped-and-superseded record

Record date: 13 August 2026

Status: C7.1–C7.6 are closed as planning inputs. The original
[C7 spelling feel-parity plan](plans/2026-07-24-c7-spelling-feel-parity.md)
is frozen historical evidence and must not be edited. This record does not
claim that C7.7 ran; the remaining work is listed under **Open residues**.

The commit claims below were checked with `git log` and `git show`. Every
listed commit is an ancestor of `origin/main`. Pull requests #33 and #36 were
also checked as merged records, including their final file and commit sets.

## Landing map

| Slice | Landing evidence | Close record |
| --- | --- | --- |
| C7.1 — design tokens and typography | [`0fe0aa67`](https://github.com/fol2/ks2-spelling/commit/0fe0aa67aaec490d1ecab38706e054baf36f0a0d) introduced the ks2-mastery token set, light and dark variants, and Fraunces/Inter font stacks. [`c6b3a8a5`](https://github.com/fol2/ks2-spelling/commit/c6b3a8a50c4eb9ef9a3fa44919a8ccf69bb10fdf) later bundled the two local font files and the v2 painted-scene tokens; [PR #33](https://github.com/fol2/ks2-spelling/pull/33) landed the fonts and licence record after its conflict resolution. | Shipped, then visually superseded by v2. The typography intent remains, but the current [semantic-token authority](../product/v2-visual-authority.md#semantic-tokens) is the Vellum/Dusk painted-scene system rather than the C7.1 dual-theme port. |
| C7.2 — world-first composition | [`f72ca259`](https://github.com/fol2/ks2-spelling/commit/f72ca259d7dabc3e35a567d6294bb107c903c933) made the Scribe Downs full-bleed, floated the product surfaces over it, and added the place and welcome copy. [`58cadb10`](https://github.com/fol2/ks2-spelling/commit/58cadb10a7a50e5b10dc8e4e9cdc325e6d8f4e69) then made brand-filled chrome follow the art tone instead of the OS colour scheme. | Shipped, then superseded by the v2 painted-scene implementation. The world-first principle survives; OS-driven surface theming does not. |
| C7.3 — round surface | [`397dc8d7`](https://github.com/fol2/ks2-spelling/commit/397dc8d7d44611e9d16e7836d7713aa08f6c5995) landed round progress dots, the answered count, skip and end-round actions, persisted show-sentence and auto-play options, replay labelling, and the dictation disclosure. | Shipped. The v2 round in [`c6b3a8a5`](https://github.com/fol2/ks2-spelling/commit/c6b3a8a50c4eb9ef9a3fa44919a8ccf69bb10fdf) deliberately superseded its setup toggles with sentence-first autoplay and two replay controls. [PR #36](https://github.com/fol2/ks2-spelling/pull/36) restored that v2 round as the shipped surface after the first merge had discarded it during conflict resolution. |
| C7.4 — meadow and codex | [`e9a67fcf`](https://github.com/fol2/ks2-spelling/commit/e9a67fcf5d4b78661b2f3fef861e8f52e7a539e2) surfaced the caught-monster meadow and codex-lite roster. [`c14856c3`](https://github.com/fol2/ks2-spelling/commit/c14856c306505bab40575cac65878d30344edd5a) added the product polish layers, and [`34f40287`](https://github.com/fol2/ks2-spelling/commit/34f4028762cba177dc7e03d69ec349f1aaf2e643) completed the codex, meadow, setup and ruled-answer surfaces. | Shipped, then rebuilt within v2. The meadow/codex outcome remains part of the painted-scene product, but the ks2-mastery Hero surface is not its authority. |
| C7.5 — where you stand | [`af3a78bd`](https://github.com/fol2/ks2-spelling/commit/af3a78bd0d50b459808545f252b16f9cbb525d47) landed the six-cell setup panel from saved progress: total spellings, secure, due today, weak spots, unseen and accuracy. | Shipped as part of the C7 line, then superseded by the v2 setup composition restored in [PR #36](https://github.com/fol2/ks2-spelling/pull/36). The historical panel is not an unimplemented C7 task. |
| C7.6 — copy and content polish | The old post-round growth surface was replaced by the v2 Field Record in [`c6b3a8a5`](https://github.com/fol2/ks2-spelling/commit/c6b3a8a50c4eb9ef9a3fa44919a8ccf69bb10fdf). The misleading “famous with visitors” sentence remains in both vendored catalogues. | The broad polish slice is closed as superseded. Its one confirmed content defect is retained as the separate E1.2 residue below; it must be fixed upstream and re-vendored, not patched in place. |

## Deliberate departures from the C7 plan

These are decisions, not missing implementation:

- **The ks2-mastery Hero surface is rejected.** The v2
  [Direction](../product/v2-visual-authority.md#direction) keeps this app's own
  ChildHome trail framing and explicitly says that the ks2-mastery Hero
  surface was never ported. The local `HeroBackdrop` name in the earlier C7
  line does not change that product decision.
- **The OS dark scheme is rejected as a product-surface selector.** Commit
  [`58cadb10`](https://github.com/fol2/ks2-spelling/commit/58cadb10a7a50e5b10dc8e4e9cdc325e6d8f4e69)
  first made unchanged painted art control the tone of its chrome instead of
  the phone's appearance. V2 completes that direction: its
  [Vellum and Dusk groups](../product/v2-visual-authority.md#semantic-tokens)
  are assigned by scene, with night-lit Practice, Results and Codex surfaces
  using Dusk rather than an OS-selected second theme.
- **The setup toggles are superseded by sentence-first autoplay.** Commit
  [`c6b3a8a5`](https://github.com/fol2/ks2-spelling/commit/c6b3a8a50c4eb9ef9a3fa44919a8ccf69bb10fdf)
  and [PR #33](https://github.com/fol2/ks2-spelling/pull/33) define a round that
  autoplays the sentence and offers “Hear it again” and a half-speed replay.
  [PR #36](https://github.com/fol2/ks2-spelling/pull/36) restored that design
  and removed the listening-voice choice from setup. The C7.3 show-sentence
  and auto-play setup switches are therefore not open work.

## Font licence authority

The C7 plan's `THIRD_PARTY_NOTICES.md` pointer is stale for the bundled fonts.
The current [third-party licence notice](../legal/third-party-licence-notice.md#bundled-fonts)
records the locally packaged Fraunces and Inter subsets under the SIL Open Font
License 1.1. This is the satisfaction location for the C7 typography licence
requirement.

## Open residues

Only these two items carry forward from the C7 close-out:

1. **[E1.2 — cloze content fix](https://github.com/fol2/ks2-spelling/issues/91).**
   “The castle is famous with visitors from many countries.” remains at
   `vendor/ks2-mastery/content/spelling.mobile-runtime-starter.json:1003` and
   `vendor/ks2-mastery/content/spelling.mobile-runtime-full.json:2468`. Fix it
   in ks2-mastery, regenerate the affected dictation audio, and re-vendor it
   with updated provenance.
2. **[E1.3 — combined C6.7+C7.7 re-verification](https://github.com/fol2/ks2-spelling/issues/91).**
   The combined current-head proof and independent read-only verification have
   not run. This record is not that proof and does not make a native, device,
   signing, store or production-readiness claim.

Future planning must use these residue entries and the current v2 authority.
It must not reopen C7.1–C7.6 from the frozen plan.
