---
module: pack-authoring
tags:
  - packs
  - commerce
  - cloudflare
problem_type: operating-procedure
---

# Full-KS2 shard packs: owner signing and hosting runbook

Dated 2026-08-13, written by the E2.6 slice (issue #123). Everything in this
document is **owner-gated**: it needs signing-key material and live Cloudflare
access that agents must not hold (per the Task 19H/22 boundary in
`docs/superpowers/plans/2026-07-18-task19h-authorised-cloudflare-session-corrective-plan.md`).

## What the repository already contains

E2.6 delivered the complete unsigned handoff, reproducible from tracked
sources on any host (no ffmpeg needed — payloads are bit-exact copies of the
tracked C2 set):

```bash
node scripts/author-full-shards.mjs --check
```

That command verifies the committed partition documents against
`reports/c2/full-audio-evidence.json`, stages all 15 payloads bit-exact under
`.native-build/packs/full-ks2-shard-NN/payload`, builds every shard twice,
asserts byte-identical outputs, and re-verifies
`config/packs/full-ks2-shards/authoring-report.json`, which pins for every
shard:

- `archiveSha256` / `archiveBytes` / `archiveMd5Etag` (the R2 single-part etag),
- `canonicalManifestSha256` / `canonicalManifestBytes` (all under the 1 MiB
  signed-envelope bound).

The signable bytes for each shard are
`.native-build/packs/full-ks2-shard-NN/dist-first/unsigned-canonical-manifest.json`.

## Step 1 — key ceremony

Decide the sandbox signing key. Two options, both owner-held:

1. **Extend the b3 test key** (`b3-test-p256-2026-07`, deliberately public
   RFC 6979 material under `tests/fixtures/keys/`) with the 15 shard packIds.
   This is acceptable only for sandbox/testing; anyone can forge signatures
   with a public key pair, so production hosting must not reuse it.
2. **Mint a dedicated sandbox shard key** following the b3 ceremony
   (`docs/superpowers/plans/2026-07-12-standalone-spelling-mobile-b3-sandbox-billing-signed-download-proof.md`,
   Task 2). The production ceremony remains E2.10 and is a separate key.

Sign each shard as the b3 proof pack was signed
(`scripts/build-b3-proof-pack.mjs` is the worked example;
`src/domain/packs/signed-manifest-contract.js` is the contract):
ECDSA P-256 / SHA-256 / ASN.1 DER over
`UTF8("ks2-spelling-pack-manifest-v1\\u0000") || <canonical manifest bytes>`,
wrapped in the envelope `{schemaVersion, algorithm, keyId,
canonicalManifestBase64, signatureDerBase64}` and written as
`signed-manifest.json` per shard. Record each envelope's SHA-256, byte count
and MD5 (etag).

## Step 2 — upload to the sandbox R2 bucket

Bucket and worker are the b3 sandbox gateway authority
(`config/b3-gateway-authority.json`): bucket
`ks2-spelling-b3-sandbox-packs`, worker `ks2-spelling-b3-sandbox`. Key layout
follows the b3 precedent (`config/b3-pack-object-authority.json`). For each
shard NN:

```bash
wrangler r2 object put \
  "ks2-spelling-b3-sandbox-packs/packs/full-ks2-shard-NN/1.0.0/full-ks2-shard-NN-1.0.0.zip" \
  --file .native-build/packs/full-ks2-shard-NN/dist-first/full-ks2-shard-NN-1.0.0.zip \
  --content-type application/zip \
  --metadata '{"b3-role":"archive","b3-sha256":"<archiveSha256>","b3-size":"<archiveBytes>"}'

wrangler r2 object put \
  "ks2-spelling-b3-sandbox-packs/packs/full-ks2-shard-NN/1.0.0/signed-manifest.json" \
  --file <signed-manifest.json for shard NN> \
  --content-type application/json \
  --metadata '{"b3-role":"signed-manifest","b3-sha256":"<envelopeSha256>","b3-size":"<envelopeBytes>","b3-envelope-sha256":"<envelopeSha256>"}'
```

Verify each uploaded object's etag equals the recorded MD5.

## Step 3 — register the shard rows (config-only)

Append one row per shard to `config/downloadable-pack-authorities.json`
(`PACK_REGISTRY` picks them up without a code change; the closed contract in
`src/domain/packs/pack-registry.js` validates every field):

```json
{
  "packId": "full-ks2-shard-NN",
  "version": "1.0.0",
  "requiredEntitlementId": "full-ks2",
  "archiveName": "full-ks2-shard-NN-1.0.0.zip",
  "allowedExtensions": [".json", ".m4a"],
  "ceilings": { "fileCount": <fileCount>, "compressedBytes": 33554432, "extractedBytes": 33554432 },
  "manifestSha256": "<envelopeSha256>",
  "manifestBytes": <envelopeBytes>,
  "manifestEtag": "<envelopeMd5>",
  "archiveSha256": "<archiveSha256 from authoring-report>",
  "archiveBytes": <archiveBytes>,
  "archiveEtag": "<archiveMd5Etag from authoring-report>"
}
```

`tests/pack-registry-shards.test.mjs` cross-checks every appended row against
the tracked build authority and authoring report.

## Step 4 — catalogue join and keyring (planner-adjudicated)

The E2.1 invariant requires, in the same change:

- `config/pack-signing-public-keys.json`: add the 15 shard packIds to the
  signing key's `allowedPackIds` — **and** the mirrored
  `EXPECTED_SIGNING_KEY` constant in
  `src/domain/commerce/commerce-contracts.js`, plus the keyring tests that
  freeze the exact shape.
- `config/store-products.json`: extend the `full-ks2` product's `packIds` to
  the 15 shard ids (keeping or replacing `b3-sandbox-proof` is a product
  decision).

**Do not flip the join before reading the conflict report in the E2.6 PR.**
The flip currently breaks three frozen or single-pack surfaces:

1. `FULL_KS2_PACK` (`src/domain/commerce/purchase-state.js`) resolves
   `packIds[0]` at module load and requires every packId to be a registry row.
2. The product commerce workflow, download coordinator and the b3 gateway
   worker (`gateway/src/pack-access-service.js`) are single-pack bound; the
   N-shard purchase/download loop is unbuilt.
3. The frozen deterministic proof (`npm run prove:b3:deterministic`) scripts a
   single-pack purchase; an N-pack catalogue changes its scenario flow and the
   proof bytes.

## Step 5 — device verification

After steps 1–4 land, the multi-shard sandbox acceptance from issue #123
applies: sandbox purchase → all shards download resumably → full catalogue
playable offline via `createFullProductAudioPlayer`; revocation locks every
shard; non-entitled devices cannot fetch shard bytes.
