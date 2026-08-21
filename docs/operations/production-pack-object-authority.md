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
this slice. Wiring it into the shared Worker source would mix sandbox and
production identities unless the Worker is channel-selected; that remains a
later production-Worker gate. The downloadable-pack registry remains the
runtime shard table until then. Archive payload hashes in that registry may
agree with production (same zip bytes); its manifest envelopes are
sandbox-signed and must not be treated as production object facts.

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
node scripts/generate-production-pack-object-authority.mjs --check --ceremony-dir <dir>
```

`--write` lists the live bucket, GETs each of the thirty objects, records the
listing etag and byte count, hashes the GET bytes (SHA-256 and MD5), and
refuses to write unless MD5 equals the single-part listing etag. Manifest GET
bytes must name `production-ks2-p256-2026-08`; that is a live-bytes identity
check, not a signature verification. `--check` rebuilds from live GET and
requires byte-identical committed serialisation.

`--ceremony-dir` is optional. When a local file exists for an object key, its
MD5 must equal the live etag and its SHA-256 and byte count must equal the
live GET. A stale ceremony tree fails closed; it is never used as a substitute
for the live read.

Archive SHA-256s are expected to agree with
`config/packs/full-ks2-shards/authoring-report.json` because the zips are
re-signed never re-encoded. That agreement is a local consistency check, not
live proof. Manifest facts must come from the live production objects and
must not match the sandbox-signed registry envelopes.

Do not hand-edit the committed document. Do not copy
`config/b3-pack-object-authority.json`. Do not run unrelated
`audit-dependencies --write`: this document is not imported from `src/`, so it
does not enter the WebView bundle inventory.

## Remaining gates

- Channel-selecting the production Worker so its pack table is this document
  rather than the B3 row plus the sandbox-signed registry.
- Signature verification of the fifteen live envelopes against the production
  public key as a separate proof, beyond the key-id identity check.
- Any R2 write, Worker deploy, DNS change, or secret rotation — out of scope
  for this evidence lane.
