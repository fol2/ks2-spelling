---
title: Restoring frozen Gemini sentence audio without adding runtime TTS
date: 2026-07-27
category: integration-issues
module: spelling-audio
problem_type: integration_issue
component: tooling
symptoms:
  - "Sentence dictation used Piper-generated audio instead of the approved frozen Gemini Iapetus and Sulafat recordings"
  - "Voice labels and manifest descriptions overstated the provenance of the underlying audio bytes"
  - "Authoring-only upstream repository metadata crossed into the runtime audio contract"
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components:
  - "development_workflow"
  - "testing_framework"
tags:
  - "spelling-audio"
  - "offline-audio"
  - "gemini-tts"
  - "piper-tts"
  - "asset-provenance"
  - "runtime-boundary"
---

# Restoring frozen Gemini sentence audio without adding runtime TTS

## Problem

The spelling pack had been regenerated and labelled without importing the
approved pre-generated Gemini sentence recordings. The repair needed to restore
the frozen sentence assets, keep the complete word-only set available without
withholding the corrected sentence integration, and preserve the local-only
runtime boundary.

[PR #40](https://github.com/fol2/ks2-spelling/pull/40) restored the Gemini
sentence source while retaining the reviewed Piper word-only clips as an
explicit interim source. It did not require a frontend change.

## Symptoms

- Iapetus and Sulafat labels did not prove which engine produced the bytes.
  The repaired inventory now records `sourceKind`, `sourcePath` and a
  source-specific generation specification for every asset
  (`src/domain/spelling/starter-audio-contract.js:262`,
  `src/domain/spelling/starter-audio-contract.js:272`,
  `src/domain/spelling/starter-audio-contract.js:294`).
- The Full pack could be described loosely as “Gemini audio”, although its
  exact 8,946-asset matrix is 8,520 Gemini sentence clips plus 426 interim
  Piper word clips (`tests/full-audio-contract.test.mjs:59`,
  `tests/full-audio-contract.test.mjs:88`,
  `tests/full-audio-contract.test.mjs:100`). The Starter subset is 800
  sentences plus 40 words (`tests/starter-audio-contract.test.mjs:18`,
  `tests/starter-audio-contract.test.mjs:39`,
  `tests/starter-audio-contract.test.mjs:51`).
- The first repair put an upstream repository URL and other authoring metadata
  into the runtime contract. That crossed the repository's no-remote-code
  boundary: the dependency audit rejects HTTP or HTTPS literals in runtime
  source (`scripts/audit-dependencies.mjs:692`,
  `scripts/audit-dependencies.mjs:693`).
- A completed provider batch was easy to confuse with a deployed source
  replacement. The current runtime authority still identifies word-only clips
  as the complete interim Piper set at revision
  `3d6c0e939b298a9f5d7e22ec369cecf802a5dd80`
  (`config/full-audio-runtime.json:9`,
  `config/full-audio-runtime.json:11`,
  `config/full-audio-runtime.json:13`).

## What Didn't Work

### Relabelling or regenerating instead of importing

Changing a voice name, model field or evidence description cannot establish the
origin of existing audio bytes. Earlier investigation treated Iapetus and
Sulafat labels as provenance, but those labels had also been applied to
Piper-generated outputs (session history). The source bytes and their frozen
authority have to be imported and hashed.

### Treating the pack as single-source

An all-Gemini description was false while the reviewed word-only clips remained
Piper. Conversely, withholding the corrected sentences until every replacement
word had been downloaded and integrated would have withheld the useful sentence
correction.
Provider completion is not deployment: the word source changes only after the
complete replacement has been downloaded, verified, wired and evidenced.

### Putting authoring provenance into runtime

The upstream repository URL, contract paths and source-contract hashes are
useful for reproducible authoring, but not for playback. Moving those fields
around inside runtime source would not help because the no-remote-code audit is
content-based (`scripts/audit-dependencies.mjs:692`).

### Replacing only some words

A partial substitution would create an undocumented third source state.
The runtime contract therefore describes the Piper word set as complete and
declares the policy that all word clips are replaced atomically
(`src/domain/spelling/starter-audio-contract.js:78`,
`src/domain/spelling/starter-audio-contract.js:83`).

## Solution

### 1. Split authoring authority from runtime authority

`config/starter-audio-authority.json` retains the frozen upstream repository,
revision, source-contract paths and hashes needed to reproduce the sentence
import (`config/starter-audio-authority.json:21`,
`config/starter-audio-authority.json:23`,
`config/starter-audio-authority.json:25`). The authoring helper removes
`sentenceUpstream` and `sourceLayout` before requiring exact equality with the
runtime-safe authority
(`scripts/lib/starter-audio-authoring-authority.mjs:66`,
`scripts/lib/starter-audio-authoring-authority.mjs:100`). A contract test
requires `sentenceUpstream` to be absent at runtime
(`tests/starter-audio-contract.test.mjs:136`).

### 2. Declare both source kinds

The runtime contract identifies sentences as pre-generated Gemini audio using
`gemini-3.1-flash-tts-preview`, and words as the reviewed interim Piper set
(`config/starter-audio-runtime.json:9`,
`config/starter-audio-runtime.json:15`). It also fixes the two playback voices
to Iapetus and Sulafat (`src/domain/spelling/starter-audio-contract.js:11`,
`src/domain/spelling/starter-audio-contract.js:156`).

### 3. Produce app-format assets from a pinned local source

Full-pack authoring requires an absolute local `--source` directory and keeps
the original frozen Gemini MP3 import path. Starter authoring instead reads the
reviewed 48 kbps Full-pack M4As already tracked in this repository at the
pinned restoration revision. This keeps Starter regeneration independent of a
discarded external cache while retaining a byte-addressed source.

Word M4As are still copied byte-for-byte. Starter sentence assets are re-encoded
to 16 kHz, 18 kbps AAC at authoring time; Full sentence assets remain 48 kbps.
The authoring authorities are deliberately separate so reducing the bundled
Starter payload cannot silently change the Full audio contract. No path makes
a new TTS request.

### 4. Bind evidence to source and output bytes

Each evidence record must use the expected source kind, key and path, record
valid source and output hashes, and match recomputed input and generation-spec
hashes
(`scripts/lib/starter-audio-evidence.mjs:260`,
`scripts/lib/starter-audio-evidence.mjs:265`,
`scripts/lib/starter-audio-evidence.mjs:276`). Word clips additionally require
the source and output byte sizes and hashes to be identical
(`scripts/lib/starter-audio-evidence.mjs:299`).

Starter sentence source keys now bind the restoration commit and tracked
Full-pack path. Full sentence source keys continue to bind the frozen Gemini
model, voice, speed, word slug and source index. The final stored Starter ZIP is
also checked against the unchanged 16 MiB extracted and archive ceilings.

Inventory construction rejects incomplete or duplicate audio keys and output
paths (`src/domain/spelling/starter-audio-contract.js:355`). The Full contract
also asserts unique source paths and source keys across all 8,946 assets
(`tests/full-audio-contract.test.mjs:59`,
`tests/full-audio-contract.test.mjs:62`,
`tests/full-audio-contract.test.mjs:64`).

### 5. Keep runtime playback provider-free

Both runtime authorities set generation and provider access to `false`, with no
fallback (`config/full-audio-runtime.json:5`,
`config/full-audio-runtime.json:6`,
`config/full-audio-runtime.json:7`). Each runtime-manifest asset record exposes
only asset path, SHA-256 and byte size
(`tests/full-audio-contract.test.mjs:22`,
`tests/full-audio-contract.test.mjs:34`). There is no provider SDK, credential,
network generation or speech-synthesiser fallback in the playback contract
(`src/domain/spelling/starter-audio-contract.js:220`).

## Why This Works

The evidence proves which source bytes were imported rather than relying on
voice labels or output filenames. Starter source keys bind a pinned Git
revision and tracked path; the Full evidence retains the original Gemini cache
key and MP3 hash. Word source keys remain pinned to their reviewed revision and
tracked path.

Detailed upstream provenance remains available to the authoring pipeline, while
the runtime reduction check prevents authoring-only fields from leaking into
playback configuration. The mixed-source contract also lets the genuine Gemini
sentence correction land without pretending that the interim word-only source
has already been replaced.

## Prevention

- Treat source identity as data. Pin the source revision, layout, encoding and
  hashes; never infer provenance from a voice ID or output filename.
- Keep exact split assertions: Full 8,946 = 8,520 sentence + 426 word, and
  Starter 840 = 800 sentence + 40 word. Keep uniqueness checks for audio keys,
  output paths, source paths and source keys.
- Preserve the runtime boundary: no runtime generation, provider access,
  speech synthesiser or network fallback.
- Keep Starter sentence encoding at its separately reviewed 16 kHz, 18 kbps
  setting and keep Full at 48 kbps. `npm run build:starter-pack` must remain
  below both unchanged 16 MiB ceilings before native evidence can pass.
- Replace word-only clips atomically. When genuine Gemini word clips are
  integrated, replace all 426 Full clips and the corresponding 40 Starter
  clips, update the source authority, and regenerate evidence and manifests.
- Treat a merged asset contract, a successful build, an installed debug build
  and a user-verified spelling cycle as separate gates. This learning documents
  the merged audio integration; it does not claim a completed downloadable
  rollout or user-verified end-to-end cycle.

## Related Issues

- [PR #40 — Restore pre-generated Gemini spelling dictation](https://github.com/fol2/ks2-spelling/pull/40)
