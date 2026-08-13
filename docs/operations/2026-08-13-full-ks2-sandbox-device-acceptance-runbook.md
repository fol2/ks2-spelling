---
module: operations
tags:
  - packs
  - commerce
  - cloudflare
problem_type: operating-procedure
---

# Full-KS2 sandbox device acceptance: owner runbook

Dated 2026-08-13, written by the E2.7 slice (issue #133). Everything below
is **owner-gated** (Task 19H/22 boundary): it needs live Cloudflare access
and store-console/sandbox-account material that agents must not hold. This
is the acceptance that closes #123 and #75 — the planner records the result
on the issues.

**Prerequisite: run this on a build that carries #135 (E2.7b).** E2.7
delivered the purchase, the 15-shard install and the entitlement-driven audio
*source* only; on an E2.7 build a completed install still left the child
practising the 20 Starter words, so step 3 was deferred. E2.7b adds the
catalogue switch and step 3 below is now executable in full. #123 and #75
stay open until this checklist has been run end to end and the planner has
recorded the result.

## What the repository delivers up to this boundary

- The catalogue join sells the 15 shards: `config/store-products.json`
  `packIds = [full-ks2-shard-01 … full-ks2-shard-15]`.
- The product app composes live commerce on native runtimes
  (`createProductAppServices` → `createProductCommerceWorkflow`): real store
  bridge, HTTP entitlement gateway against the sandbox authority, and the
  sequential N-shard download/activation loop. Purchase, restore and
  download stay behind the Parent PIN gate.
- The gateway worker serves a registry-derived pack table: all 15 shard
  keys plus the b3 row (shard objects asserted with EMPTY custom metadata,
  b3 objects with their `b3-*` metadata, every object pinned to the
  registry's sha256/bytes/etag).
- Deterministic evidence: `npm run prove:b3:deterministic` covers purchase →
  15 sequential authorise/download/activate → all ready, interrupted-run
  resume, durable partial failure and revocation lock (see the same-day
  proof-regeneration record).
- `wrangler deploy --dry-run` passes from `gateway/` (agents never deploy).

## Step 1 — deploy the sandbox worker (owner)

The worker has never been live-deployed (bucket
`ks2-spelling-b3-sandbox-packs` was created 2026-08-13 during the shard
upload; all 30 shard objects plus the 2 b3 objects are hosted and
verified). From `gateway/`:

```bash
npm ci
npx wrangler deploy                  # worker ks2-spelling-b3-sandbox
npx wrangler secret put ENTITLEMENT_HANDLE_KEY_CURRENT
npx wrangler secret put ENTITLEMENT_HANDLE_KEY_PREVIOUS
npx wrangler secret put R2_CAPABILITY_HMAC_KEY
# store-verifier credentials per gateway/wrangler.jsonc bindings
```

Bind the route so `https://b3-gateway.eugnel.uk` reaches the worker
(Cloudflare dashboard: the `eugnel.uk` zone custom domain/route), and
confirm the R2 binding `PACKS → ks2-spelling-b3-sandbox-packs` and the rate
limiter binding exist as declared in `gateway/wrangler.jsonc`.

Smoke: an authorise POST without a valid sealed handle must return a safe
4xx JSON error; `GET /v1/packs/...` without a capability must fail closed.

## Step 2 — build and install the sandbox app

Standard product build for the target platform (iOS development /
Android internal track per the b3 distribution precedent). No native-shell
changes shipped in E2.7, so the existing certified native lanes apply.

## Step 3 — device acceptance checklist

On a device signed into a **sandbox** store account:

1. **Purchase** Full KS2 from the Parent area (behind the Parent PIN gate;
   verify the child surfaces show no price or purchase copy).
2. **Download**: all 15 shards download and activate sequentially; the
   Parent area reaches the installed state. Kill the app mid-download and
   relaunch: the download resumes without re-fetching completed shards
   (watch the gateway logs — completed shards re-authorise but transfer no
   new ranges).
3. **Full catalogue, offline.** The catalogue switch is decided at startup,
   so **close and relaunch the app** once the install completes — the Parent
   card says so itself ("Close and reopen the app to start practising the
   full word list"); if it still says that after a relaunch, the switch did
   not happen and this step fails.
   Then, with airplane mode on:
   a. The word bank publishes **213** words, not 20 (Parent area → progress,
      or the setup panel's pack size).
   b. Practise and spot-check playback across the shard span — shards
      partition the catalogue alphabetically, so take at least one word from
      shards 01–04 (e.g. *accidentally*, shard 01), one mid (*language*,
      shard 12) and one late (*yacht*, shard 15). Every one must speak,
      offline. Shards 05–15 were installed but never read before E2.7b, so
      the late words are the ones that prove the install was worth making.
   c. Progress earned before the purchase is still there: the Starter words
      the child had practised keep their stages and due dates. The switch
      re-tags the aggregate; it does not reset it.
   d. Guardian Missions and Camp are no longer locked out (they read the
      `full-ks2` grant off the learner's own record, which the switch writes).
4. **Revocation**: refund/revoke the sandbox purchase; after refresh the
   entitlement reads revoked and every shard locks (no playback of
   full-catalogue words; Starter remains available).
   Relaunch and confirm the **learning is still there**: a revoked device
   that had earned full-catalogue learning keeps it rather than resetting to
   Starter, so the app still composes the full 213-word catalogue and every
   stage and due date survives. **Expected and deliberate:** in this state
   the non-Starter words are visible but silent — the entitlement gates the
   audio, and the alternative was deleting a refunded family's history. Note
   what the card says and whether the family has an obvious route back
   ("Restore purchases"). Then re-purchase or restore and confirm the same
   learning is in front of the child with audio working again.
   For comparison, a device revoked *before* the child practised any
   non-Starter word goes cleanly back to the 20 Starter words with its
   Starter progress intact — that downgrade is lossless, so it is taken.
5. **Non-entitled device**: on a device without the entitlement, confirm
   shard bytes are unreachable: no authorise (403), and a captured
   capability URL from the entitled device fails after expiry (600 s) and
   never matches another shard's path.
6. **Legacy-state device**: on a device that previously ran the B3 proof
   app (carrying `b3-sandbox-proof` rows), the product app starts cleanly
   and reports the b3 job retired (deliberate retirement, not a crash).

Record pass/fail per step with device, OS and build identifiers; the
planner attaches the record to #133 and closes #123/#75 on acceptance.

## Non-goals of this acceptance

- Production keys, production R2/gateway and store-listing work remain
  E2.10/Task 22 (separate ceremony; the sandbox signing key
  `b3-test-p256-2026-07` is deliberately public and must never host
  production).
