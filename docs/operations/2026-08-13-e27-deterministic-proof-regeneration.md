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

**Superseded by the round-1 hardening above.** The committed report is now
SHA-256 `3720cbcbf218cce2b7f8e85a682b14e2c2adc786cfe71baf12e6bba317bd9647`,
again from two consecutive `npm run prove:b3:deterministic` runs (four builds
in total, all byte-identical), the second from a clean worktree at the
committed tree, which stayed clean afterwards. `node
scripts/build-b3-exit-report.mjs --check-ci` on that tree returns
`{"ok":true,"mode":"pending"}`.
