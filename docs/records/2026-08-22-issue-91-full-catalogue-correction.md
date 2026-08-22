---
kind: gate-verdict
module: full-ks2-content
tags:
  - issue-91
  - catalogue
  - audio
  - provenance
problem_type: release-candidate-correction
---

# Issue 91 Full-catalogue correction

Status: implementation candidate at upstream `bf1462acebba950b80b2e8901589e8143422cc79`.

## Evidence

- The Full catalogue now carries `The castle is famous among visitors from
  many countries.` at `famous/sentence-6` and contains no copy of the retired
  `famous with visitors` sentence.
- Gate A was extracted from GitHub-reachable upstream commit
  `bf1462acebba950b80b2e8901589e8143422cc79`, tree
  `67e0283a2a1496fedc15726e137cb4f8bd15bca6`.
- The vendored verifier passed 29 of 29 runtime/content authority files, 24 of
  24 runtime hashes, 9 of 9 producer-test hashes and all 33 A3 import records.
- Four affected Gemini sentence sources were regenerated without upload and
  encoded with FFmpeg 8.1.2 into the two reviewed voices and two reviewed
  paces. The Full audio checker re-probed all 8,946 assets successfully.
- The 15-shard plan still covers 8,946 assets. Only
  `full-ks2-shard-03` changed; all 15 shards rebuilt twice and reproduced the
  tracked authoring report byte-for-byte.
- The new unsigned shard-03 archive SHA-256 is
  `ba64b50226b676d5b09988d3e96a0b32038c502c59fd77c75d3d70b7f880089e`.

## Remaining gates

- Re-sign the affected canonical manifest through the visible production-key
  ceremony; the old signed envelope must not be paired with the new archive.
- Upload the new archive and signed manifest, then regenerate the downloadable
  and production object-authority documents from live object facts.
- Restore the full test suite to green, obtain hosted CI, and merge the
  downstream pull request through the repository queue.
- Cut a new release candidate after those production pack gates close. The
  already-uploaded TestFlight build must not be treated as carrying this
  correction.

This record grants no production signing, object upload, store submission,
release or merge authority.
