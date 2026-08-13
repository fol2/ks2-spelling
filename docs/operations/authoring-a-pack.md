---
module: pack-authoring
tags:
  - packs
  - audio
  - tooling
problem_type: operating-procedure
---

# Authoring a pack

Pack authoring is internal repository tooling. It turns an upstream catalogue
and its audio into a validated, signable pack artifact. None of it ships in the
app: Vite bundles only `src` and explicit content copies, so `scripts/` is
outside the bundle by construction.

## The authority pair

Every pack is described by two reviewed JSON documents.

`config/packs/<packId>.json` is the **build** authority. It carries pack
identity, version, archive name, required entitlement, signing state, allowed
extensions and ceilings, alongside `catalogueSource`, `audioSourceRoot` and
`audioEvidenceSource`.

`config/packs/<packId>.audio.json` is the **audio** authority pointer. It
contains exactly seven fields: `schemaVersion`, `catalogueId`,
`catalogueSource`, `audioAuthoritySource`, `audioSourceRoot`,
`audioEvidenceSource` and `runtimeManifestTarget`, the last being a
repository-relative path or `null`.

`audioAuthoritySource` names the pack's **audio authority document**, such as
`config/starter-audio-authority.json` or `config/full-audio-authority.json`.
That document is the frozen record of sources, encoding and quality bounds.
Audio authorities are exact-match frozen and additive: a new pack adds a new
document, and never loosens an existing one.

The pairs in the repository today are:

| Pack | Build authority | Audio authority pointer |
| --- | --- | --- |
| Starter | `config/packs/ks2-core.json` | `config/packs/ks2-core.audio.json` |
| Full | audio lane only | `config/packs/ks2-core-full.audio.json` |
| Fixture | `config/packs/e3-toy.json` | `config/packs/e3-toy.audio.json` |

The Full catalogue has an audio lane but no build authority. At 8 947 files its
canonical manifest measures 1 298 997 bytes, roughly 245 KiB over the 1 MiB
signed-envelope bound, so it cannot ship as a single data-only pack.

## The command sequence

Three steps, in order.

**One — generate and verify the audio.** This encodes the payload, measures
every asset and writes the pack's evidence report. It is create-only and
refuses to overwrite an existing payload or report.

```bash
node scripts/generate-starter-audio.mjs \
  --authority=config/packs/<packId>.audio.json \
  --source=/absolute/path/to/upstream/audio
```

`--source` is required only when the pack's audio authority declares an
externally sourced sentence corpus, meaning its sentence source has no
in-repository `assetRoot`. A pack whose sources are tracked in this repository,
such as Starter, omits it and uses its reviewed tracked source.

**Two — re-verify the tracked evidence.** This re-measures the payload and
fails unless it reproduces the tracked report byte for byte.

```bash
node scripts/generate-starter-audio.mjs \
  --authority=config/packs/<packId>.audio.json --check
```

**Three — build the artifact.** This produces the deterministic stored ZIP, the
RFC 8785 canonical manifest and the build report.

```bash
node scripts/build-starter-pack.mjs \
  --authority=config/packs/<packId>.json \
  --output-directory=.native-build/packs/<packId>
```

`npm run verify:starter-audio` and `npm run verify:starter-pack` are the
no-argument shorthands for the Starter pack. A pack that declares a
`runtimeManifestTarget`, as the Full catalogue does, can also regenerate that
manifest from already-verified evidence with `--runtime-manifest-only`.

## The FFmpeg pin

Every audio authority pins FFmpeg to exactly `8.1.2`, and step one asserts the
running version before it encodes anything. A host without that exact build
must not amend the authority to match whatever it has.

The pin is not bureaucratic. FFmpeg 8.1.2 decodes AAC to whole 1024-sample
frames, while later releases trim to the container-declared duration instead.
Measured durations therefore shift by up to one frame between versions, and a
tracked evidence report stops reproducing.

The `e3-toy` fixture works around this so that pack authoring can be tested
anywhere: it ships pre-made payload audio, encoded from frame-aligned input so
its declared duration is already frame-aligned. Such a payload decodes to the
same samples on either version, so its committed evidence verifies on both.
`node scripts/build-e3-toy-audio-fixture.mjs` rebuilds that fixture and asserts
the alignment. Its payload is deliberately encoded without the silence-trim
stage of the reviewed chain, because trimming would destroy the alignment the
guarantee depends on.

## What is not automated

Automated checks measure duration, level and edge silence. They cannot hear a
mispronunciation, a wrong word or a misread sentence, so a human listening pass
over new audio remains required before a pack ships.

Production signing is deliberately not part of this sequence. Packs are built
unsigned, and the production key ceremony stays an owner-gated manual step with
the key never held in this repository.
