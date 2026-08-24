---
kind: gate-verdict
module: full-ks2-content
tags:
  - issue-91
  - catalogue
  - provenance
problem_type: authority-correction
---

# Issue 91 upstream merge authority

Status: upstream merge authority pinned at `c39b07bb5a339ca1329407274d7972c7f66f6c59`.

This record corrects only the pre-merge upstream authority named by
`docs/records/2026-08-22-issue-91-full-catalogue-correction.md`. The earlier
record remains frozen.

## Evidence

- Upstream pull request `fol2/ks2-mastery#941` was squash-merged as commit
  `c39b07bb5a339ca1329407274d7972c7f66f6c59`, tree
  `7adf8b5224c6a88879c6088850a65d4911125ed5`.
- A fresh clone of `https://github.com/fol2/ks2-mastery.git` resolved `main`
  to that exact commit and tree.
- All 38 files under `vendor/ks2-mastery` were extracted or compared against
  that Git authority. Every vendored file was byte-identical, so the merged
  authority changes provenance identity without changing shipped bytes.
- The corrected Full-catalogue sentence remains `The castle is famous among
  visitors from many countries.`
- The visible owner-held signing ceremony produced a complete thirty-object
  tree using `production-ks2-p256-2026-08`; the private key remained outside
  the repository and was not printed to the evidence log.
- Before the first write, all thirty existing production objects were copied
  to a rollback tree and verified against the pre-run committed authority.
- All fifteen archives and fifteen production-signed manifests were uploaded
  to remote `ks2-spelling-production-packs`. The authority generator then
  listed and GET-read exactly thirty live objects, wrote
  `config/ks2-pack-object-authority-production.json`, and independently
  repeated the full live read with the ceremony tree supplied.
- Shard 03 now binds archive SHA-256
  `ba64b50226b676d5b09988d3e96a0b32038c502c59fd77c75d3d70b7f880089e`,
  30,516,833 bytes and ETag `650889ef9526f232c33ebe9b8c4a1116`.
- The sandbox shard 03 pair was backed up before mutation, then replaced as
  one bounded archive-and-manifest operation. A second remote GET read was
  byte-identical to the local pair: archive facts match the production
  archive above, while the sandbox envelope has SHA-256
  `305c8a213126d6fd6099e8ab116eacb5f677fc357ec5354df22923a842eaf471`,
  114,431 bytes and ETag `37ffa4d6dc7b446a5217510c16b6eb5f`.
- The sandbox envelope was signed only with the deliberately public test
  vector `b3-test-p256-2026-07`; the production private key was not reused.
- The regenerated B3 deterministic proof reproduced byte-identically with
  report SHA-256
  `077c8016f167438863945d345e7f2fc6b09b8abd57e5fef8b6d94553a7ca9f0e`.

## Remaining gates

- Restore exact-head hosted CI to green before merging the downstream pull
  request.
- Record the first App Store build containing the correction before closing
  issue 91.

This record grants no signing-key access, production-object mutation, store
submission, release or merge authority.
