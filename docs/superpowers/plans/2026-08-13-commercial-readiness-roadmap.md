# Commercial readiness roadmap

Dated 2026-08-13. Grounded in a six-domain read-only audit of the tree at
`e724ea7f` (content/pack architecture, commerce/IAP governance, C7 status,
kids-category compliance, CI hygiene, authoring pipeline). This document is
the planning source for the epic issues on GitHub; the epic issues are the
working authority once filed. Records of completed work go in separate dated
docs per the frozen-plan convention.

## Commercial definition (owner decisions, 2026-08-12)

1. **Free app + paid packs.** Free download bundles the Starter pack;
   additional spelling packs are one-time non-consumable IAP delivered
   download-on-demand. The product catalogue keeps its existing `type`
   discriminator (`config/store-products.json`) as the seam for future
   non-pack IAP; only `non-consumable` is implemented in v1.
2. **Parallel tracks.** Polish and commercial infrastructure proceed
   simultaneously; they touch nearly disjoint surfaces.
3. **iOS first, Android fast-follow.** iPad ships with iOS
   (`TARGETED_DEVICE_FAMILY = "1,2"` already set).
4. **Internal pack-authoring pipeline** is in scope: repo tooling that never
   ships inside the app bundle.

## What the audit established

The gap to commercial is much smaller than assumed. Almost every commercial
mechanism already exists from milestone B3 — the work is *generalisation from
one hard-coded sandbox pack to N real packs*, not greenfield:

- **Commerce bridges exist.** App-owned StoreKit 2 plugin
  (`ios/App/App/CommercePlugin.swift`, 412 lines: purchase/restore/
  transactions/finish) and Play Billing twin (`CommercePlugin.java`,
  BillingClient 9.1.0) — both hard-coded to the single product
  `full-ks2`/`uk.eugnel.ks2spelling.fullks2`. Extending these avoids the
  7-gate npm plugin path entirely and preserves the "no third-party
  analytics" register (`docs/compliance/sdk-privacy-register.md`).
- **A signed-pack download pipeline exists.** ECDSA-P256 signed manifests
  over RFC8785 (`src/domain/packs/`), resumable chunked native downloads
  (PackTransfer plugin + `download-coordinator.js`), zip-bomb ceilings
  attested in CI, entitlement-gated installs at the sqlite layer, startup
  reconciliation, and an `InstalledAudio` read path that shares its request
  shape with the bundled audio source — swapping bundled→downloaded audio is
  a composition change, not a player change. All pinned to the sandbox pack
  `b3-sandbox-proof`.
- **A backend exists.** Cloudflare Worker gateway
  (verify/complete/refresh/authorise-download) with server-side Apple/Google
  receipt verification and R2 pack hosting — sandbox-branded
  (`b3-gateway.eugnel.uk`) and hard-asserting `environment === 'sandbox'`.
- **Offline entitlements exist.** `app_entitlements` sqlite table; authority
  doc guarantees installed packs stay usable offline
  (`docs/architecture/b3-commerce-pack-authority.md`).
- **C7 feel-parity is shipped and superseded.** C7.1–C7.5 landed 2026-07-24
  (commits `0fe0aa67`, `f72ca259`, `397dc8d7`, `e9a67fcf`, `c14856c3`,
  `34f40287`), then the v2 painted-scene design replaced the token port
  (PR #33/#36, `docs/product/v2-visual-authority.md`). Fraunces/Inter are
  self-hosted and shipped. Residue: one cloze content fix and the combined
  C6.7+C7.7 re-verification, which has **never run**.
- **The app currently gives everything away.** `createProductAppServices`
  unconditionally calls `promoteStarterCatalogue()` + `grantFullEntitlement()`
  at startup and composes the *unavailable* commerce workflow — the exact
  opposite of the business model, and the root of issue #75 (451 MB bundled
  audio → ~474 MB download, ~1.4 GB on disk).
- **Store readiness is further along than expected.** TestFlight build
  0.5.0 (1) is VALID (blocked only on export compliance, issue #76);
  18 preflight-clean screenshots (iPhone + iPad) and the QA-passed icon exist
  — but **untracked in the working tree**. No listing copy, no hosted privacy
  policy URL, no kids-category position doc, and the parental PIN gate has
  two review-risk holes (unchallenged first-run setup, no recovery path —
  which strands Restore Purchases).
- **The authoring pipeline is one parameter away.** `build-starter-pack.mjs`
  + `generate-starter-audio.mjs` (pinned ffmpeg 8.1.2, evidence `--check`)
  already build a deterministic signed-manifest pack; they hard-code the
  starter authority inline. Audio math: full set is 8,946 clips at ~52 kbps
  (451 MB); starter proved 18 kbps acceptable (16 MB / 840 clips), so the
  full set re-encodes to roughly ~170 MB.

## Epics

Milestone per epic. One issue per slice, filed when its epic activates.
Sizes: S / M / L.

### E0 — Green board (hygiene; unblocks everything)

| Slice | Size | Notes |
|---|---|---|
| E0.1 Confirm nightly green, #87 auto-closes | S | PR #88 already repaired main; next scheduled run proves it |
| E0.2 Commit the QA-passed app-icon installation | S | Finished work sitting uncommitted; branding test 6/6 locally |
| E0.3 Implement Dependabot split policy (#74) | M | Policy decided in-issue; dependabot.yml unchanged; bot queue #81–#86 re-formed |
| E0.4 Enforce full merge-tier gate on every merge path (#73) | M | Verified live: strict:false, no merge queue — fast subset satisfies protection. **Only after E0.1.** |

### E1 — C7 close-out and re-verification

| Slice | Size | Notes |
|---|---|---|
| E1.1 C7-CLOSE record doc: shipped-and-superseded map | S | Maps C7.1–C7.6 to landing commits + v2 authority's deliberate rejections |
| E1.2 Fix the "famous with" cloze upstream + re-vendor under provenance | M | Only surviving C7.6 item; dictation audio regen risks the 16 MiB starter ceiling |
| E1.3 Combined C6.7+C7.7 re-verification and freeze on current head | L | C5 bundle + device checklist (minus moot View Transitions) + independent verify + freeze record |

### E2 — Packs as products (commerce generalisation; fixes #75)

| Slice | Size | Notes |
|---|---|---|
| E2.1 Generalise product catalogue to N pack IAPs (keep `type` seam) | M | Replace frozen single `EXPECTED_PRODUCT`; blocked on pack-granularity decision for content, not for mechanism |
| E2.2 Generalise pack authority registry from `b3-sandbox-proof` | L | Six hard-coded sites incl. native plugins must move together |
| E2.3 Generalise Commerce bridges to catalogue product-id set | L | Swift + Java allowlists, `.storekit` products; zero new npm deps |
| E2.4 Gateway + entitlement store multi-entitlement support | M | Routes/tables already keyed correctly; verifiers are single-product |
| E2.5 Starter-in-bundle + remove the free full grant | M | Bundle 16 MB starter instead of 451 MB full; migration note for TestFlight installs |
| E2.6 Full audio out of the binary via PackTransfer | L | The actual #75 fix; re-encoded pack(s) hosted and installed on purchase |
| E2.7 Wire live commerce into the product app behind the parental gate | M | Replace unavailable-workflow composition; purchase unreachable without gate |
| E2.8 Purchase/restore UX for per-pack download-on-demand | L | Coordinator chain parameterised; restore reconciles all owned packs |
| E2.9 StoreKit sandbox evidence in CI for the multi-pack catalogue | M | Extend B3StoreKitDelayedTests; don't disturb frozen B3 evidence topology |
| E2.10 Production hosting + signing key + production environment flip | M | **Owner-gated (Task 22)**: R2 bucket, gateway deploy, key ceremony, un-assert sandbox |
| E2.11 Governance bookkeeping pass | S | approvedNativePlugins text, privacy register rows, notices, audit reports |

### E3 — Pack-authoring pipeline (internal tooling)

| Slice | Size | Notes |
|---|---|---|
| E3.1 Per-pack authority documents (parameterise, don't abstract) | M | `--authority=config/packs/<id>.json`; starter rebuild stays byte-identical |
| E3.2 Author command: catalogue + audio in → validated pack out | M | Generalise `configurationFor()`; reuse encode/validate/evidence wholesale |
| E3.3 Upstream re-vendor lane for new pack catalogues | M | Extend provenance to an enumerable catalogue list; "add a pack" runbook |
| E3.4 Per-pack QA gate (`verify:pack`) + human listening checklist | S | Reuse `--check` + hostile inspector; no new QA framework |
| E3.5 Signing step activation (existing contract, new key ceremony) | M | sign-pack script; production key stays an owner manual step |
| E3.6 YAGNI ADR: modularization non-goals | S | Record existing seams; no pack SDK workspace, no dynamic catalogue service |

### E4 — Store readiness (kids compliance + listing + release path)

| Slice | Size | Notes |
|---|---|---|
| E4.1 Kids-compliance position doc: category, age band, COPPA/AADC | S | **Owner decisions**; everything else inherits from this |
| E4.2 Close parental-gate holes: first-run adult challenge + PIN recovery | M | Recovery must un-strand Restore Purchases; review-risk fixes |
| E4.3 Export compliance + App Privacy answers + privacy manifest decision | M | **Owner/legal classification**; amends frozen ios-project-contract assertions |
| E4.4 Publish privacy policy + support URLs; link behind the gate | S | First outbound link the app has ever had; 5.1.4 placement test |
| E4.5 Commit + freeze store listing assets; write listing copy | M | 18 preflight-clean screenshots currently untracked; store-listing.md |
| E4.6 App Review self-check + reviewer notes | S | Walk guidelines 1.3/2.1/3.1.1/5.1.4 with repo citations |
| E4.7 TestFlight-to-production release runbook, executed once | L | Owner-vs-agent split per step; run to submitted-for-review |
| E4.8 Play Families + Data safety pre-work (Android) | S | Docs-only; derived from same evidence as Apple answers |

### E5 — Commercial polish (the felt-quality bar)

Backlog-generating epic: the v2 design shipped and two polish rounds ran, but
"no one argues it's SOTA" is the bar. Slices:

| Slice | Size | Notes |
|---|---|---|
| E5.1 Screen-by-screen design QA against v2 visual authority | M | Design harness in browser + on-device; hero-tone seam checked in both colour schemes; produces the polish backlog as issues |
| E5.2 iPad layout QA pass | M | Device family already 1,2; screenshots exist; verify real layout quality |
| E5.3 Purchase/download UX polish | M | The new commerce surfaces (E2.7/E2.8) get the same design-QA bar |
| E5.4+ Polish backlog execution | — | Issues generated by E5.1, batched by surface |

### E6 — Android fast-follow (activates after iOS submission)

Placeholder epic: Android feel/device QA, Play Billing verification against
the shared gateway, Play listing assets, Data safety form from E4.8 pre-work.
Not sliced until activation.

## Owner decisions

Items 1–4 DECIDED by the owner on 2026-08-13; item 8 resolved by PR #89
(the full screenshot set, including concepts, is committed to git);
5–7 remain open.

1. **Pack granularity — DECIDED: hybrid.** v1 sells one "Full KS2" unlock;
   themed/year-band packs come later as additional IAP. Implementation note:
   the ~170 MB re-encoded full set exceeds the CI-attested 32 MiB/1,024-file
   native zip ceilings — deliver it as N sub-ceiling shard packs under the
   single `full-ks2` entitlement (`store-products.json` `packIds[]` is
   already an array), keeping the zip-bomb defence intact. The later themed
   packs slot in as new products without rework.
2. **Kids Category — DECIDED: yes, 9–11 band.** Permanently bars third-party
   analytics (none exist; none planned). E4.1 records the obligations map.
3. **Export compliance — DECIDED: declare exempt-encryption-only.** HTTPS +
   OS-standard crypto; SQLCipher is packaged but the DB opens
   `no-encryption`. The owner confirms the questionnaire answer in App Store
   Connect personally; E4.3 records the classification and amends the
   frozen contract tests to match.
4. **Task 22 — DECIDED: authorised now, parallel with E2.** Production
   R2/gateway, signing-key ceremony, and sandbox-assertion removal (E2.10,
   E3.5) may be scheduled alongside sandbox work. The signing-key ceremony
   itself remains a hands-on owner step.
5. **Existing-install migration** (E2.5): TestFlight devices already have
   `full-ks2` granted in sqlite. *Recommendation: reset — no production users
   exist; record the decision in the slice.*
6. **Paid-pack audio encoding tier** (E3.2/E2.6): starter's 18 kbps proved
   acceptable; paid content may warrant ~24–32 kbps. Human listening call.
7. **Privacy policy / support page hosting** (E4.4): `eugnel.uk` serves the
   sandbox gateway; a public page host is needed.
8. **Store-asset bulk** (E0.2/E4.5): commit `final-v3` (+ SHA256SUMS) is
   assumed; decide whether concepts/rejected sets live in git given the
   4 GiB packaged-surface scanner budget.

## Operating model

- **Milestone per epic; issue per slice.** Every slice issue carries: goal,
  key files (from this audit), acceptance criteria, and its governance
  footnotes (frozen surfaces it touches, CI lanes it trips).
- **Agents take issues**: assign → branch `<epic>/<slice>-short-name` → PR
  referencing the issue → full-gate evidence → merge. Orchestrator reviews
  every diff against the issue before merge.
- **Batch native churn.** Any slice touching ios/, android/,
  dependency-policy, or prove-scripts trips the long native lanes — batch
  related native changes into one branch (standing rule from PR #14).
- **Provenance discipline.** Vendored bytes never edited in place; content
  changes go upstream to ks2-mastery and re-vendor under a re-pinned
  provenance manifest. Plan docs are never edited after freeze; records go
  in new dated docs.
- **Simulator hygiene.** Sweep booted simulators before every proof run.
- **Sequencing rule.** E0.4 (merge governance) lands only after E0.1 proves
  green; E2.10 and E3.5 production halves wait for owner gates; everything
  else can start now in parallel.

## Start-now set

Track A: E1.1 (C7-CLOSE record), E5.1 (design-QA sweep).
Track B: E2.1 (catalogue mechanism), E3.1 (per-pack authority), E2.2 scoping.
Hygiene: E0.1 (watch tonight's run), E0.2 (icon PR), E0.3 (#74).
Owner: decisions 5–8 above; signing-key ceremony when E3.5/E2.10 reach it.
