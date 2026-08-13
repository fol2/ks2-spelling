---
module: operations
tags:
  - packs
  - commerce
  - proof
problem_type: decision-record
---

# E2.7 deterministic-proof regeneration record

Dated 2026-08-13, written by the E2.7 slice (issue #133). The frozen
`reports/b3/deterministic-proof.json` pinned the pre-flip catalogue join
(`full-ks2 → [b3-sandbox-proof]`); the join flip to the 15 Full-KS2 shards
therefore regenerates the proof under planner adjudication. This document
records the regeneration decision and the byte-class argument for the diff.
The planner reproduces the regeneration independently before merge
(`npm run prove:b3:deterministic` from a clean worktree after a real
`npm ci`).

## Shape adopted (the issue's recommended shape, implemented as adjudicated)

1. **Existing b3 scenarios rebind explicitly to the registry's b3 row.**
   `b3-sandbox-proof` left the sellable catalogue but stays a registry row,
   so the B3 proof lanes keep resolving it directly:
   - the download-scenario harness (`tests/helpers/range-fixture-server.mjs`)
     passes the now-required `packAuthority` dependency;
   - `createB3AppServices` pins its purchase coordinator and pack reconciler
     with the new optional `packIds: ['b3-sandbox-proof']` override and its
     download coordinator with `packAuthority`;
   - the `reconcile-interrupted` activation scenario passes the same
     override and additionally asserts startup reconciliation never deletes
     a b3 job.
2. **A new deterministic scenario group `shards`** drives the shipping
   product commerce workflow (`createProductCommerceWorkflow`) against the
   real catalogue join, the real registry rows and the real signed shard
   envelopes (`tests/fixtures/packs/full-ks2-shards/`, byte-identical to the
   hosted sandbox objects — every fixture's sha256/bytes/md5 equals the
   registry row pins), with deterministic store/gateway/pack-transfer fakes
   and durable SQLite job/chunk state:
   - `purchased-all-shards`: purchase creates all 15 shard jobs
     (authorised in catalogue order), then the sequential install loop
     authorises/downloads/activates every shard — 447 chunk downloads
     exactly, all 15 jobs `ready`, all 15 active versions flipped.
   - `interrupted-resume`: a transient failure at shard 04 is absorbed
     calmly; the second run resumes without re-downloading the three
     completed shards and completes the install.
   - `integrity-failure-durable`: a final-integrity mismatch on shard 09
     fails closed, leaves shards 01–08 ready, shard 09 durable and
     resumable (chunk plan reset, temporary state removed) and shards 10–15
     queued; a retry completes the install.
   - `revoked-locks-shards`: a second composition over the same durable
     state observes a revocation and every shard locks.

## Round-1 review hardening (same day, planner review R5)

The planner's independent verification accepted the shape above and required
four changes, all applied here and re-reproduced:

1. **`revoked-locks-shards` was a tautology.** `packState === 'locked'` is
   implied by `entitlementState === 'revoked'` in `aggregatePackStates`'
   first line, so the scenario asserted its own precondition. It now reads
   per-shard evidence out of the durable store: all 15 shards keep their
   installed row and active pointer (`everyShardKeepsItsInstalledBytes`), and
   all 15 are refused re-activation with `sqlite_pack_entitlement_inactive`
   while the entitlement is revoked
   (`everyShardRefusedReactivationWhileRevoked`). Both counts are pinned to
   15, and that database refusal is the boundary a locked device actually
   depends on.
2. **`integrity-failure-durable` could pass vacuously.** Its two
   `Array.every` invariants hold over an empty array, so a run that lost its
   rows would have looked identical to one that preserved them.
   `everyShardStillHasItsJob` pins `jobs.length === 15` before them.
3. **`syntheticDigests.shardAuthoritySha256`** (new) pins the 15 resolved
   registry rows in catalogue order, so the artifact freezes the shard
   authority set its scenarios exercise: any drift in a sha256, byte count,
   etag, version or ordering fails the proof instead of quietly changing what
   was proved. `tests/b3-deterministic-proof.test.mjs` pins the literal
   `9556f0b2aacf849788c3c7f82958f85354fc2936a0c14b02e895e2a24ea00dba`.
4. **`shardChunkCount` imports `B3_DOWNLOAD_CHUNK_BYTES`** instead of
   repeating `1_048_576`.

Diff against the round-1 report: exactly four lines — the two hardened
scenarios' `stateSha256`, the added `shardAuthoritySha256` and the recomputed
`scenarioMatrixSha256`. `purchased-all-shards` and `interrupted-resume` are
byte-identical to round 1, because their invariants did not change.

## Byte-class argument for the committed diff

The regenerated report differs from the frozen report in exactly two byte
classes:

1. **`scenarioMatrix.shards` (additive):** the four new scenario rows with
   their `stateSha256` values. New content, no prior bytes displaced.
2. **`syntheticDigests.scenarioMatrixSha256` (recomputed):** the hash of the
   scenario matrix necessarily changes because the matrix gained a group.

After the round-1 hardening a third class joins them:

3. **`syntheticDigests.shardAuthoritySha256` (additive):** the new pin over
   the 15 shard registry rows.

Everything else is byte-identical, in particular:

- every pre-existing `commerce`, `download` and `activation` scenario
  `stateSha256` — the b3 rebind reproduced the exact pre-flip flows;
- `privacyContinuity`, `nonLiveStoreKit`, `clock`, trace-id evidence;
- every `syntheticDigests` pin over untouched fixtures:
  `signedManifestSha256`, `packObjectAuthoritySha256`,
  `beforePurchase`/`afterFreshInstallReseed`, `v1CellTypeAndBytesSha256`,
  `syntheticLearnerAuthoritySha256`.

Regeneration evidence from this slice: two consecutive
`npm run prove:b3:deterministic` runs (each of which itself builds the
report twice and asserts byte identity) produced report SHA-256
`e9fe85c5a089558795a265b1af5ceffa9fb280eeadc7d11466ad63c429662dfd`.

**Superseded by the round-1 hardening above.** The report was then SHA-256
`3720cbcbf218cce2b7f8e85a682b14e2c2adc786cfe71baf12e6bba317bd9647`,
again from two consecutive `npm run prove:b3:deterministic` runs (four builds
in total, all byte-identical), the second from a clean worktree at the
committed tree, which stayed clean afterwards. `node
scripts/build-b3-exit-report.mjs --check-ci` on that tree returns
`{"ok":true,"mode":"pending"}`.

## Round-2 review: a fifth shard scenario (planner review R8)

The planner's round-2 verification found that deleting the round-1 activation
guard in `create-product-commerce-workflow.js` (`activation.state !== 'ready'`
→ throw `product_commerce_activation_incomplete`) changed nothing observable
in any test or in the regenerated proof. A fix with no failing-on-revert test
is a coincidence, so the branch is now exercised by a fifth shard scenario,
using the harness-side `packRepository` wrapper the planner accepted as the
right instrument (the composition under proof stays the shipping one; the
wrapper stands where the device's own database would).

- **`revoked-at-activation`**: the entitlement goes inactive *between* a
  shard's download and its activation — `registerAndFlipActiveVersion` is
  refused for `full-ks2-shard-03` with `sqlite_pack_entitlement_inactive`,
  which `activate()` reports by *returning* `{state:'access-locked'}` rather
  than throwing. The scenario pins that `install()` refuses to report success
  (`product_commerce_activation_incomplete`, naming the shard and the
  activation state), that the locked shard has no active version but keeps
  its durable job, that shards 01–02 stay activated, and that shards 04–15
  are never started. Deleting the guard fails the proof run outright
  (`b3_scenario_invariant_failed`), which is the point.

Byte-class argument for this round's diff — exactly two classes, verified by
`git diff` on the report:

1. **`scenarioMatrix.shards` (additive):** one new row,
   `revoked-at-activation` / `stateSha256`
   `f76971bc16c1dd42aa82e70c2def9d8d417f189c91119f2d5f760850d3b2b465`.
2. **`syntheticDigests.scenarioMatrixSha256` (recomputed):**
   `d179766c…` → `36db272f167a2016e7d86cc5e5947215f6fad4dd62e672a63e030692995a7a21`.

All 22 pre-existing scenario `stateSha256` values — including all four
earlier shard scenarios — and every other `syntheticDigests` pin are
byte-identical to the round-1 report. No round-3 change touched a proof
input: the reconciler's ambiguity scoping is not exercised by any scenario
(no scenario presents duplicate native inventory) and the remaining changes
are tests and documentation.

The committed report is now SHA-256
`23d9db5e659c31be51f743d529135130a23b0a6ee211c635615ad35b090c5e41`, from two
consecutive `npm run prove:b3:deterministic` runs (four builds in total, all
byte-identical), the second from a clean worktree at the committed tree,
which stayed clean afterwards. `node scripts/build-b3-exit-report.mjs
--check-ci` on that tree returns `{"ok":true,"mode":"pending"}`.
