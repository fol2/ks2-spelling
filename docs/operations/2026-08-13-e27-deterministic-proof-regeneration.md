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

## Byte-class argument for the committed diff

The regenerated report differs from the frozen report in exactly two byte
classes:

1. **`scenarioMatrix.shards` (additive):** the four new scenario rows with
   their `stateSha256` values. New content, no prior bytes displaced.
2. **`syntheticDigests.scenarioMatrixSha256` (recomputed):** the hash of the
   scenario matrix necessarily changes because the matrix gained a group.

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
