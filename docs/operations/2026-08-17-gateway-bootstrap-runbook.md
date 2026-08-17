---
module: gateway
tags:
  - cloudflare
  - commerce
  - deployment
problem_type: operating-procedure
---

# Gateway bootstrap: the two owner sittings

Dated 2026-08-17, written by issue #156 against the decisions in #143 (sitting
order), #145 (production identity), #149 (Cloudflare mechanics research) and
#157/#197 (production secret set). Everything here is **owner-gated**: it
mutates live Cloudflare state that agents must never touch. Agents deliver up
to the boundary — scripts, dry-run plans and this document — and stop.

The sandbox Worker `ks2-spelling-b3-sandbox` has **never been deployed**. The
automated lane (`scripts/deploy-b3-sandbox-gateway.mjs`) fails closed until a
Worker with the seven secrets already exists, so the very first deploy is a
runbook event, not a code path. That is deliberate and stays deliberate: after
Sitting 1, every subsequent deploy goes through the tracked, evidence-producing
script and this document is never needed for the sandbox again.

## The wizards

Both sittings are driven by prompt-and-confirm wizards. Default is a dry run
that prints the full plan and contacts nothing; execution needs the visible
owner gate `GATEWAY_CEREMONY_EXECUTE=owner` **and** `--execute`. The wizards
validate every precondition before the first prompt, confirm each mutating
step, and never hold credentials: secret values are typed into wrangler's own
hidden prompt, not into the wizard process.

```bash
# Sitting 1 — first sandbox deploy
node scripts/sandbox-gateway-bootstrap-wizard.mjs --dry-run
GATEWAY_CEREMONY_EXECUTE=owner node scripts/sandbox-gateway-bootstrap-wizard.mjs --execute

# Sitting 2 — production day
node scripts/production-gateway-ceremony-wizard.mjs --dry-run
GATEWAY_CEREMONY_EXECUTE=owner node scripts/production-gateway-ceremony-wizard.mjs \
  --execute --ceremony-dir <dir with packs/<packId>/<version>/…>
```

Prerequisites for both: `npm --prefix gateway ci` (the pinned wrangler 4.110.0)
and a **wrangler OAuth session** on the product account (`wrangler login`).
API tokens are rejected — the same gate as
`scripts/check-b3-external-prerequisites.mjs`.

## Sitting 1 — sandbox bootstrap, reversible-first order

The order is #143's decision: every reversible step happens before the first
irreversible one.

1. **Read-only inspection** (wizard, automatic): OAuth identity on account
   `6d00cb4a…`, `ks2-spelling-b3-sandbox-packs` stays private (r2.dev disabled,
   zero bucket custom domains), and `b3-gateway.eugnel.uk` has **no DNS
   records** — a Custom Domain cannot be created over an existing CNAME.
2. **Seven secrets** (owner types values into wrangler's hidden prompt):
   `APPLE_IAP_ISSUER_ID`, `APPLE_IAP_KEY_ID`, `APPLE_IAP_PRIVATE_KEY`,
   `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`, `ENTITLEMENT_HANDLE_KEY_CURRENT`,
   `ENTITLEMENT_HANDLE_KEY_PREVIOUS`, `R2_CAPABILITY_HMAC_KEY`. Reversible:
   secrets on an undeployed Worker serve no traffic.
3. **`versions upload`** (reversible — no traffic moves). The wizard then
   probes DNS and prints whether the upload alone provisioned the Custom
   Domain. Public Cloudflare docs do not settle this (#149); **record the
   observation in the execution-evidence section below and on the issue.**
4. **Deploy the version to 100%.** This is the step expected to create the
   Custom Domain (DNS record plus edge certificate) and the first step with a
   manual-cleanup tail, so it is deliberately last: deleting a Custom Domain
   later removes the DNS record but the **Advanced Certificate it created
   survives and must be removed by hand** in the dashboard.
5. **Rollback drill** while the stakes are lowest: upload a second version,
   deploy it, `wrangler rollback` to the first, confirm traffic moved via
   `wrangler deployments status`. Proves the undo path on this account before
   production ever needs it.
6. **Handover.** From here on, `npm run check:b3-prerequisites` passes and
   `scripts/deploy-b3-sandbox-gateway.mjs` owns every sandbox deploy. Do not
   use the wizard for the sandbox again.

## Sitting 2 — production day

A replay of Sitting 1 against the production identity decided at #145, plus
the key ceremony. Identity (prompt-and-confirm, never invented at the
console): Worker `ks2-spelling-production`, Custom Domain
`ks2-gateway.eugnel.uk`, private bucket `ks2-spelling-production-packs`,
rate-limit `namespace_id` **2001** (account-scoped; sharing 1001 would share
counters with the sandbox).

1. **Key ceremony** (owner, manual — agents never touch key material): mint
   the production ECDSA P-256 signing key, take custody of the private half,
   land the public key in `config/pack-signing-public-keys.json` through a
   reviewed PR (`testOnly:false`, `allowedEnvironments:["production"]`,
   `notAfter` ten years out, all fifteen shard packIds), re-sign the fifteen
   canonical manifests, and record every envelope sha256/bytes/etag. The
   wizard validates these outcomes and refuses to continue without them.
2. **Ceremony directory**: the wizard checks, before any upload, that every
   archive under `--ceremony-dir` is byte-identical to the tracked authority
   (`config/downloadable-pack-authorities.json` — re-signed, never re-encoded)
   and every manifest is signed by the production key.
3. **Production R2**: create the private bucket, confirm r2.dev stays disabled
   with zero bucket custom domains, upload the 30 objects. Custom metadata
   stays empty — wrangler cannot set it, and shard object rows declare
   `metadata: {}` (see the 2026-08-13 hosting runbook).
4. **Exactly six secrets** — the iOS names only. The production Worker never
   declares `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` (#157). The wizard then runs
   the **secret-list gate**: `wrangler secret list` must return exactly the
   six names (`assertProductionIosRequiredSecretNames`), failing if the Play
   secret is present or any name is missing.
5. **Versions upload → observe → deploy → rollback drill**, identical shape to
   Sitting 1, against the generated production config (custom-domain route,
   invocation logs off — the App Privacy posture travels with the config).
6. **Observability confirmation** per
   `docs/operations/gateway-observability-confirmation.md`, and record the
   sitting on the issue. The submission-day runbook
   (`2026-08-15-submission-day-runbook.md`) requires this sitting complete.

## Execution evidence

Append observations here after each sitting (same discipline as the hosting
runbook):

- **Sitting 1 (pending):** did `versions upload` alone provision the Custom
  Domain? Version ids, rollback drill outcome, dashboard cleanup notes.
- **Sitting 2 (pending):** production key id, envelope hashes recorded at,
  secret-list gate output, deploy and rollback evidence.
