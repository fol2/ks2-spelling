---
module: pack-authoring
tags:
  - measurement-run
  - packs
  - cloudflare
  - production
problem_type: freeze-record
---

# Production pack-object measurement — 2026-08-21

Status: original-live-read recorded; independent-recheck blocked at
`1d9498d1f4799da0e6dd542b27d062da65ba343a`.

This record is **not GREEN**. It is **not** ceremony proof, **not** a
fresh independent live `--check`, and **not** production-bucket freshness
at review time.

## Evidence

### Original authorised live read (dated 2026-08-21)

An executor session listed and GET-read `ks2-spelling-production-packs`
read-only, then wrote `config/ks2-pack-object-authority-production.json`.
That same session’s `--check` rebuilt from live GET and matched the
committed bytes. Recorded then:

- Exact listing coverage: 15 packs / 30 objects; no extra keys.
- Single-part etag equalled the MD5 of the GET bytes; SHA-256 was taken
  from those same bytes.
- Live signed-manifest bytes named `production-ks2-p256-2026-08` (identity
  of the envelope, not a signature verification).
- Custom metadata on every listed object: `{}`.
- Bounded identifiers (not secrets):
  - `packs/full-ks2-shard-01/1.0.0/full-ks2-shard-01-1.0.0.zip` —
    29903190 bytes, etag `e5ddd0bfe55d70a1c2e61f452bcadae2`,
    sha256 `1debf2909614037df7d5c6b2109192c18508e915e82202e2990b0a03f57713dc`
  - `packs/full-ks2-shard-01/1.0.0/signed-manifest.json` —
    106074 bytes, etag `69ad9bd4ed54cbae3b0369708947fb73`,
    sha256 `43c4fd875729955f0d885f79eb2a85905aa0359576b0d935648aa51b7e3c45d2`
- The document contains none of `b3-sandbox-proof`,
  `ks2-spelling-b3-sandbox-packs`, `b3-test-p256-2026-07`,
  `b3-gateway.eugnel.uk`, or B3 custom-metadata keys.

That original derivation is dated evidence of one earlier authorised
read. It does not stand in for a later independent `--check`.

### Independent recheck (blocked)

A later independent live R2 `--check` against current head
`1d9498d1f4799da0e6dd542b27d062da65ba343a` is blocked: the Cloudflare
OAuth session is expired. The visible gate is a browser
`npx wrangler login`. No token was requested or accepted, and no hidden
or copied session was used to simulate a fresh pass. Source tests and
hosted CI do not prove a live bucket match.

### Ceremony tree (not evidence)

`/tmp/ks2-ceremony-output` is incomplete and mismatched: fifteen
archives are missing, and the local manifests differ from the
production objects. That tree is not ceremony evidence.

## Remaining gates

- James completes a visible `npx wrangler login`.
- A fresh independent live R2 `--check` of
  `config/ks2-pack-object-authority-production.json` against
  `ks2-spelling-production-packs`.
- A complete matching ceremony directory (all fifteen archives and
  fifteen production-signed manifests whose MD5 equals the live
  single-part etags).
- Signature verification of the fifteen live envelopes against the
  production public key, beyond the key-id identity check.

Runtime serving and Worker channel-selection are out of scope for this
lane. This record grants no live-freshness, ceremony, production-Worker,
signing, release or store authority. Issue #226 stays open.
