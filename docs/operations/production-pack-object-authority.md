---
module: pack-authoring
tags:
  - packs
  - cloudflare
  - production
problem_type: operating-procedure
---

# Production pack-object authority

Dated 2026-08-21, issue #226. This is the production sibling of
`config/b3-pack-object-authority.json`: live private-R2 object evidence for
`ks2-spelling-production-packs`, never a copy of the sandbox proof pack.

## Schema decision

Repeat the sandbox single-pack shape fifteen times only if that is the simpler
consumed authority. Tracing the consumers shows it is not.

| Consumer | What it actually reads today |
|---|---|
| `gateway/src/pack-access-service.js` | The B3 proof row from the single-pack sandbox document; the fifteen shard rows from `config/downloadable-pack-authorities.json` as one pack table |
| `#145` B6 dependency-evidence lane | A `src/` import of a second config document enters the WebView bundle and trips `assertB3DependencyEvidenceCurrent`. A `gateway/src/`-only import does not, because wrangler bundles the Worker, not Vite |
| `scripts/lib/b3-cloudflare-evidence.mjs` and the B3 fingerprint/proof scripts | Sandbox-pinned: exactly two B3 objects, the sandbox bucket, and `b3-sandbox-proof` |

The truthful consumed shape for production is therefore **one multi-pack
document** with a closed `packs[]` of fifteen shard rows, each carrying the
same per-object record as the sandbox document (`role`, `key`, `bytes`,
`sha256`, `etag`, empty `metadata`). Fifteen sibling files would repeat
`schemaVersion` and the bucket name fifteen times, would not match the
gateway's pack table, and would still not be imported from `src/`.

The production document is **not** imported from `src/` or `gateway/src/` in
this slice. Runtime serving and Worker channel-selection are out of scope
here. The downloadable-pack registry remains the runtime shard table.
Archive payload hashes in that registry may agree with production (same zip
bytes); its manifest envelopes are sandbox-signed and must not be treated as
production object facts.

## Document

`config/ks2-pack-object-authority-production.json`

Closed keys:

- document: `schemaVersion`, `bucketName`, `packs`
- pack: `packId`, `version`, `objects`
- object: `role`, `key`, `bytes`, `sha256`, `etag`, `metadata`

`bucketName` must match `config/ks2-gateway-authority-production.json`
`privateR2BucketName` (#145 B6). Shard `metadata` is `{}` — wrangler cannot set
custom metadata, and the 2026-08-13 hosting runbook made empty metadata the
shard convention. `b3-*` labels remain a B3-pack-only convention.

The document must never contain `b3-sandbox-proof`, the sandbox bucket name,
sandbox object etags or SHA-256s, `b3-test-p256-2026-07`, or B3 custom
metadata keys.

## Generation and provenance

Live reads only, against `ks2-spelling-production-packs`, using the machine's
authorised Cloudflare OAuth session:

```bash
node scripts/generate-production-pack-object-authority.mjs --check
node scripts/generate-production-pack-object-authority.mjs --write
node scripts/generate-production-pack-object-authority.mjs --check --ceremony-dir "$CEREMONY_OUTPUT_DIR/objects"
```

`--write` lists the live bucket, GETs each of the thirty objects, records the
listing etag and byte count, hashes the GET bytes (SHA-256 and MD5), and
refuses to write unless MD5 equals the single-part listing etag. Each signed
manifest is verified with `verifySignedPackManifest` against
`config/production/pack-signing-public-keys.json` using the current clock
(`() => new Date()`). Tests may inject a fixed clock; production/live paths
must not. The canonical payload must be a closed production manifest
(`schemaVersion`, `requiredEntitlementId` `full-ks2`, `archive`, `ceilings`,
`allowedExtensions`, `files`, `packId`, `version`, with optional
`minimumAppVersion` / `minimumSchemaVersion` only) bound to the paired live
GET archive. The verifier compares live GET bytes (and, with `--ceremony-dir`,
the local bytes) to the committed facts; it does not re-sign live production
envelopes. `--check` rebuilds from live GET and requires byte-identical
committed serialisation.

`--ceremony-dir <dir>` is fail-closed. The supplied directory is the exact
object tree: `packs/<packId>/1.0.0/…` with exactly 15 archives and 15
signed-manifest envelopes and no other files. Missing, extra, unreadable,
malformed, byte/size/SHA/etag mismatch, wrong key, invalid signature, or a
signed payload that does not bind packId, version, archive name, archive
bytes and archive SHA-256 to the paired live GET fails the command. Read
errors are not mapped to skip. An unprefixed tree, a stale tree, a
cross-shard envelope, or a locally re-signed envelope is not ceremony
evidence. `ceremony-metadata.json` inside that directory is extra and fails.

`scripts/resign-manifests-with-production-key.mjs` writes the object tree at
`CEREMONY_OUTPUT_DIR/objects/packs/…` and operational
`ceremony-metadata.json` beside that subdirectory. Pass
`--ceremony-dir "$CEREMONY_OUTPUT_DIR/objects"`. The verifier never treats
`status: ready` as proof.

Archive SHA-256s are expected to agree with
`config/packs/full-ks2-shards/authoring-report.json` because the zips are
re-signed never re-encoded. That agreement is a local consistency check, not
live proof. Manifest facts must come from the live production objects and
must not match the sandbox-signed registry envelopes.

Do not hand-edit the committed document. Do not copy
`config/b3-pack-object-authority.json`. Do not run unrelated
`audit-dependencies --write`: this document is not imported from `src/`, so it
does not enter the WebView bundle inventory.

The 2026-08-21 original live read, and the later blocked independent
recheck, are recorded in
`docs/records/2026-08-21-production-pack-object-authority.md`. That record
is not GREEN and is not ceremony proof.

## Remaining gates

Runtime serving and Worker channel-selection are out of scope for this
evidence lane. The production document is not imported from `src/` or
`gateway/src/`.

- Fresh independent live R2 `--check` after a visible browser `wrangler login`
  re-consent. That live pass now includes `verifySignedPackManifest` against
  the committed production public keys. Source tests and hosted CI do not
  prove a live bucket match.
- A complete matching ceremony directory: exactly the thirty canonical
  objects, byte-identical to the live GET facts. An incomplete, extra,
  unreadable or mismatched local tree is not ceremony evidence.
- Any R2 write, Worker deploy, DNS change, or secret rotation — out of scope
  for this evidence lane.

Staging a ceremony directory from `scripts/author-full-shards.mjs` must resolve
the nested outputs `.native-build/packs/<packId>/dist-first|dist-second/<archiveName>`.
`scripts/resign-manifests-with-production-key.mjs` requires the authoring
report to list the exact fifteen canonical pack IDs, versions and archive
names in order — a subset, duplicate, extra, reordered or substituted shard
list is not ready. It removes stale `ceremony-metadata.json` and the `objects/` tree before
validating the authoring report, then preflights every nested archive, stages
all thirty objects under `objects/`, and writes `status: ready` last. A failed
run must not leave a current ready marker or a complete object tree.
