# Standalone Spelling Mobile B3 Sandbox Billing and Signed Download Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Use `superpowers:test-driven-development` for every task and `superpowers:verification-before-completion` before the exit commit. Steps use checkbox (`- [ ]`) syntax for tracking. Every task requires fresh independent spec-compliance and code-quality review before the next task begins.

**Goal:** Prove on one physical iPhone and one Play-certified physical Android test device that a Parent-only sandbox purchase can be verified by a receipt-only Cloudflare Worker, durably grant the app-wide `full-ks2` entitlement, resume and safely activate the signed `b3-sandbox-proof` data-only pack from private R2, restore/redownload it after reinstall, and revoke access without changing either child's learning history during non-destructive commerce.

**Architecture:** Keep the frozen Gate A and B2 authorities unchanged. Add app-owned StoreKit 2 and Google Play Billing bridges, a receipt-only Worker with live Apple/Google verification, Worker-sealed refresh handles and private-R2 capability delivery, SQLite schema V2 app-wide commerce/pack state, and app-owned native central-directory inspectors plus pack-transfer bridges for resumable private-file download, hostile-ZIP rejection and atomic activation. Pack manifests use one precomputed, domain-separated RFC 8785/P-256/SHA-256 DER signature fixture; runtime contains only its public key and can never sign or re-sign a pack.

**Tech Stack:** Node.js `24.18.0`, npm `11.16.0`, ESM JavaScript, React `19.2.7`, Vite `8.1.4`, Capacitor `8.4.1`, `@capacitor-community/sqlite@8.1.0`, `@capacitor/app@8.1.0`, iOS 15+ StoreKit 2/CryptoKit/ZIPFoundation, Android API 24+ Java 21/JCA/`java.util.zip`, exact official `com.android.billingclient:billing:9.1.0`, Cloudflare Workers and private R2, exact official `@apple/app-store-server-library@3.1.0`, and `node:test`.

## Authority and frozen entry evidence

| Evidence | Frozen B3 entry value |
|---|---|
| Mobile repository | `https://github.com/fol2/ks2-spelling.git` |
| B2 merged `main` commit | `39ef90a5a33efb41368272c4c6d4d002f04658b3` |
| B2 merged tree | `d4e43a1571fd1a811ce572670c30ae7209e52024` |
| B2 hosted exact-main CI | `https://github.com/fol2/ks2-spelling/actions/runs/29192615770` |
| B2 exit report SHA-256 | `6d19101ff93a3c4f0e74ad0ee987beb915686d108071b6a06b6e3e4562cab6ce` |
| B2 dependency audit SHA-256 | `bb3b572280d84beeca2ac4a892836e92fc847bf5cf67015c434f54b94ab085d6` |
| B2 native build report SHA-256 | `a72e95958e287be21f34588a167f12fd59058ab003dfe3f559b3ba244988a6f9` |
| B2 native plugin audit SHA-256 | `6c09fcc78055a3ab7f693160da22eb84080e25ee3f389b1b79b2a831b63d3740` |
| B2 package lock SHA-256 | `534b10c7f317622eba32b277b8755a0ac3d04aaf30359117fdeb7510050b6479` |
| Frozen upstream Gate A commit | `4501607a9b58f2fb252b4cce64ba056e6f60c630` |
| Gate A upstream tree | `129ba457cccf21df03f4be813b4f4ed6e7d9f6ad` |
| A2 contract manifest SHA-256 | `237b26b14e7506fa271bb3324f701d6205e6e0166d659a16789937478cc77b66` |

The product/design authority remains:

- `/Users/jamesto/Coding/ks2-mastery/docs/superpowers/specs/2026-07-09-standalone-spelling-mobile-application-design.md`
- `/Users/jamesto/Coding/ks2-mastery/docs/superpowers/plans/2026-07-09-standalone-spelling-mobile-programme.md`
- `/Users/jamesto/Coding/ks2-spelling/docs/superpowers/plans/2026-07-11-standalone-spelling-mobile-b2-native-persistence-lifecycle-proof.md`

## Global constraints

- Use UK English in code, comments, documentation, commit messages and product copy.
- Keep bundle/application identity exactly `uk.eugnel.ks2spelling`, iOS scheme `KS2Spelling`, app name `KS2 Spelling`, iOS floor `15.0`, Android minimum API `24`, target/compile API `36`, Build Tools `36.0.0` and Java `21`.
- The permanent product mapping is Apple `uk.eugnel.ks2spelling.fullks2`, Google `full_ks2`, internal entitlement `full-ks2`. The B3 fixture pack is `b3-sandbox-proof`; none of these identifiers may be inferred from display copy.
- iOS uses StoreKit 2 directly and adds no client billing dependency. Android uses the exact official base Java artifact `com.android.billingclient:billing:9.1.0`; do not add `billing-ktx`, Kotlin, RevenueCat, Capawesome, Cap-go or a private registry unless a separately reviewed proof demonstrates that Java is insufficient.
- Commerce exists only in the diagnostic Parent proof shell. No child surface shows price, Buy, Restore, download progress, purchase pressure or a store sheet.
- The gateway is receipt-only and account-free. Initial purchase/restore accepts opaque Apple JWS or Google purchase token plus store/product/environment/request-integrity metadata; refresh/download accepts only a Worker-sealed refresh handle. Every route rejects learner/profile/progress/session/Monster/Camp fields and never stores them.
- The only live gateway origin is the tracked HTTPS sandbox origin in `config/b3-gateway-authority.json`, restricted to environment `sandbox`, exact approved Cloudflare account/Worker identity and native WebView origins `capacitor://localhost`, `http://localhost`. `capacitor.config.json` keeps `server.url === null`. Endpoint, proof, handle, capability and secrets never enter logs.
- The refresh handle is a versioned AES-256-GCM envelope sealed by the Worker with a fresh unique 96-bit nonce. `ENTITLEMENT_HANDLE_KEY_CURRENT` and `ENTITLEMENT_HANDLE_KEY_PREVIOUS` values are exact records `v{positiveInteger}:{unpaddedCanonicalBase64url(raw32Bytes)}` with distinct versions and key bytes. Prefix, payload format/key version and AAD binding must agree exactly. Current encrypts; current+previous decrypt; every accepted previous handle reseals current and returns positive `refreshHandleVersion`. The app stores only the opaque handle/version in the app-wide entitlement row; raw proof is cleared after finish/acknowledgement. Restore issues a fresh handle; durable revocation commits before handle deletion.
- Durable store transaction authority comes only from live gateway truth: Apple verified `transactionId` and Google verified `orderId`, returned as `storeTransactionId` and cross-checked on every refresh. Native `transactionRef`, JWS, purchase token and opaque proof are never persisted as `store_transaction_id`; purchased results without a valid store-specific safe ID fail closed.
- Do not send `appAccountToken`, `obfuscatedAccountId`, learner ID, nickname, progress, product-defined device ID or advertising ID. Raw JWS, purchase tokens, refresh handles, capability URLs, sandbox account identity and credentials are secrets and must not enter logs, screenshots, reports, metrics or Git.
- Apple product identity is derived from verified JWS. Google product/package identity is derived from live `ProductPurchaseV2`. Never trust a client-supplied entitlement ID, R2 key or object path.
- Store environments are explicit and fail closed: Apple sandbox and production verification never fall through to one another; B3 accepts only sandbox. Google B3 accepts only the configured test-track package/product.
- Timeout, abort, offline, 5xx and unavailable gateway on launch/resume/Parent Packs never revoke or hide the last verified active entitlement, installed pack or readiness. Only a live store-verified revocation transaction may lock access.
- Transaction ordering is exact: observe -> durable journal -> live gateway verification -> one SQLite transaction grants/revokes app-wide entitlement and records ready-to-complete -> finish StoreKit transaction or confirm server-side Play acknowledgement -> clear raw proof -> create/resume download job.
- Pending never grants access. Cancellation is a normal Parent catalogue outcome. Duplicate/out-of-order callbacks are idempotent. Refund/revocation removes paid access while all learner, session, Monster and Camp bytes remain unchanged.
- StoreKit launch subscribes to `Transaction.updates`, retries `Transaction.unfinished`, restores through `Transaction.currentEntitlements`, rejects unverified transactions and finishes only after durable entitlement commit. Google enables one-time pending purchases, automatic service reconnection, refreshes `queryPurchasesAsync()` on connection and every resume, never grants `PENDING`, and acknowledges verified `PURCHASED` inside the sandbox proof window.
- Manifest signatures are ECDSA P-256 with SHA-256, ASN.1 DER. Signed bytes are `UTF8("ks2-spelling-pack-manifest-v1\u0000") || RFC8785(manifest)`. The envelope contains the exact canonical UTF-8 bytes, `keyId`, algorithm and one committed precomputed DER signature. Builder/runtime only verify that fixed signature and full envelope SHA-256; neither signs nor re-signs.
- `config/pack-signing-public-keys.json` contains public keys only. The committed RFC 6979 test-vector signing half is deliberately public/non-secret reproducibility material under `tests/fixtures/keys/`; exact test-vector PEM, SPKI and DER-signature SHA-256 values are frozen. Production/runtime/release source, bundles, native resources and archives must not import/package it. No secret or production private key exists in B3.
- Download access is a 600-second Worker capability URL bound to exact `GET`, immutable R2 object key and canonical decimal expiry. The HMAC is raw 32-byte WebCrypto HMAC-SHA-256, encoded as unpadded canonical base64url over `TextEncoder([domain, method, objectKey, expiry].join('\n'))` with no trailing LF. Validation uses an injected clock, rejects redirects/non-canonical encodings and returns `Cache-Control: private, no-store`; query values are always redacted.
- Signed URLs are memory-only. SQLite persists logical archive identity, completed ranges, byte counts, digest and ETag, never the bearer URL. Expiry obtains fresh authorisation without repurchase or job deletion.
- JS and both native bridges independently validate every capability URL before network: HTTPS, origin exactly `https://b3-gateway.eugnel.uk`, no credentials/fragment/port/redirect, exact derived pack/version/archive path, query keys exactly one canonical `expires` and one canonical `cap`, no extras/duplicates/non-canonical encoding.
- The native `PackTransfer` plugin accepts logical pack/version/archive identities only. It owns private staging/installed roots, streams ranges to owned files, rejects unsafe ZIPs, verifies declared bytes, writes activation markers and atomically renames; it never accepts an arbitrary absolute destination/extraction path.
- Owned pure Swift and Java central-directory inspectors run before any extraction and require creator OS Unix (`3`), exact regular-file mode `0100644`, UTF-8 flag only, method stored/deflate only, zero extra/comment fields, single disk and no encryption/data descriptor/ZIP64. They reject zero/unknown/ambiguous modes, directories, symlink/hard-link/device/FIFO/socket encodings and every unknown flag/extra field. Each central entry must match its local header byte-for-byte for name, flags, method, CRC and sizes. The same committed hostile ZIP bytes run through compiled Swift harness and Android JUnit; source-regex tests are supplementary only.
- Inspectors also reject duplicate/overlapping local-header offsets or data ranges, central-directory overlap, truncated/overflowing offsets/sizes, multiple or ambiguous EOCD, EOCD not exactly at EOF, and prepended/trailing junk before extraction.
- ZIP path/inventory validation additionally rejects absolute/drive/backslash/traversal/dot/empty paths, case-fold and Unicode-NFC collisions, duplicates, undeclared/missing members, executable extensions and file-count/compressed/extracted ceilings.
- Activation order is staging extraction -> every member verified -> activation marker -> atomic rename to immutable installed version -> SQLite active-pointer flip -> later old-version retirement. Every failure leaves the previous verified pack active.
- SQLite V2 app-wide tables are exactly `app_entitlements`, `transaction_journal`, `installed_pack_versions`, `active_pack_versions`, `pack_download_jobs` and `pack_download_chunks`. `app_entitlements` owns nullable `sealed_refresh_handle` and `refresh_handle_version`; no other table persists it. None may contain `learner_id`, nickname, year group, progress, session, Monster or Camp fields.
- Existing A3 `granted_entitlement_ids_json` is frozen legacy snapshot data, not entitlement authority. C3 later injects active app-wide grants through the B3 access projection.
- B3 proves actual sandbox commerce on one physical development-signed iPhone and one Play-certified Android internal-test device. iOS distribution kind is exactly `development`. Physical sandbox proves Ask to Buy pending/no access only; separate Xcode StoreKit Test approve/decline is non-live. B4 owns the broad matrix.
- The gateway runtime pins `wrangler@4.110.0`, `miniflare@4.20260708.1`, compatibility date `2026-07-12` and flag `nodejs_compat`; one real Miniflare/workerd test imports Apple library `3.1.0`, validates X.509 fixtures and intercepts outbound App Store API fetches before any deployment.
- Exact Worker bindings are private R2 `PACKS` and rate-limit binding `GATEWAY_RATE_LIMIT`. Required remote secret names are `APPLE_IAP_ISSUER_ID`, `APPLE_IAP_KEY_ID`, `APPLE_IAP_PRIVATE_KEY`, `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`, `ENTITLEMENT_HANDLE_KEY_CURRENT`, `ENTITLEMENT_HANDLE_KEY_PREVIOUS` and `R2_CAPABILITY_HMAC_KEY`. Existing OAuth verifies names/bindings read-only; scripts never read local values, `.env`, keychain or provisioning. Missing OAuth exits `6` non-interactively.
- `GATEWAY_RATE_LIMIT` runs before request-body parsing, R2 access, Apple/Google fetch or cryptography on every public POST and GET. Missing binding fails closed; limited requests return `429` with zero upstream/body-read calls.
- Sandbox bucket identifier is exactly `ks2-spelling-b3-sandbox-packs`, tracked in gateway authority and fingerprinted. It must equal prerequisites, Wrangler `PACKS` bucket, Cloud/platform evidence and exit. Object authority owns exact keys/SHA/sizes/ETags/metadata; deployment rejects drift and overwrites only byte-identical objects.
- Worker version metadata binding is exactly `WORKER_VERSION_METADATA`. Deployment normalises one fixed-length script-authority placeholder, hashes the dry-run bundle before deploy, replaces only that placeholder with the hash, and records the resulting build constant plus Cloudflare API version ID. Gateway responses return `WORKER_VERSION_METADATA.id` and the embedded normalised script-authority SHA; reports/exit require equality with tracked approved account ID, Worker name and public sandbox endpoint.
- Remote mutations require both durable approved identifiers and one exact random run-local token. Approval scopes are exactly `cloudflare-deploy`, `apple-signed-distribution`, `apple-sandbox-history-refund` and `google-test-track-refund-revoke`; the Google scope includes its internal-track distribution action. Wrappers only pause with a visible operator instruction for Apple/Google console/device actions; agents never perform those console mutations.
- Signed distribution authority is produced after the clean checkpoint. iOS B3 mode is development-signed only and binds operator-provided signed IPA SHA, independently extracted embedded authority SHA/values, code-signing certificate SHA and installed bundle/version/build/authority/development identity equality. Android binds signed internal-track AAB SHA, independently extracted authority/versionCode, Play App Signing certificate, installer and ordered pulled base/split APK SHA multiset. Agents never access keychain/signing; visible Xcode development deployment and Play internal-track actions are operator-owned.
- Evidence uses fresh random UUIDv4 trace IDs only for gateway-backed success/revocation outcomes. It never contains a store-proof commitment/SHA/prefix, refresh handle or capability. Query/cancel/pending transitions have no trace/commitment. Ordered scenario multisets are exact; iOS completion is exactly `finished:true`, Android exactly `acknowledged:true`.
- Live capture is authorised only against `config/b3-synthetic-learners.json`: exactly two synthetic learner IDs/nicknames and their expected canonical digests before purchase and after fresh-install reseed. Wrappers reject every arbitrary/real learner database or nickname; committed reports contain only the expected synthetic digests, never IDs/nicknames.
- External prerequisite checks are explicit gates, never fabricated passes. Apple/Google/Cloudflare console state, merchant agreements, products, at least two Apple sandbox tester contexts, test accounts, signing, devices and secrets are provisioned through visible official UI/credential flows. Scripts must never display a hidden password prompt.
- B3 UI stays visibly labelled `B3 sandbox proof` and is diagnostic Parent evidence only. It is not production Parent/child UI, Parent PIN, final theme, Monster presentation or asset migration.
- B3 does not claim production Full KS2 content/audio readiness, production signing keys, final Cloudflare/store configuration, store approval, family sharing, public pricing, release compliance, final visuals, accessibility or performance certification.
- TDD is mandatory. Each task begins with a focused failing test, records the exact RED reason, implements the smallest complete behaviour, reruns focused and regression gates, commits independently, then receives fresh spec and quality review. Resolve all Critical/Important findings before the next task.
- The controller records every task base/head, tests and reviews in `.superpowers/sdd/progress.md`. No review may approve unstaged workspace state or a different commit.
- Reviewed safety pushes occur after Tasks 4, 8, 13 and 18 to exact branch `jamesto/mobile-b3-billing-download`; never force-push. Push only after task tests and both reviews are clean. `SKIP_PREPUSH=1` is allowed only when the full relevant pre-push suite already passed at the exact HEAD and is recorded in progress; otherwise use normal hooks.

## File structure

### Frozen authority and product contracts

- `provenance/b2-gate.json`: immutable B2 entry commit/tree/report/package/CI authority.
- `scripts/verify-b2-authority.mjs`: hashes the frozen B2 evidence and A2 contract without rebuilding historical B2 against B3 HEAD.
- `config/store-products.json`: exact store-to-entitlement mapping.
- `config/b3-gateway-authority.json`: tracked sandbox HTTPS/account/Worker/origin/CORS authority.
- `config/b3-pack-object-authority.json`: immutable private-R2 object bytes/metadata authority.
- `config/b3-synthetic-learners.json`: exact two-fixture learner authority and canonical digests.
- `config/pack-signing-public-keys.json`: public-key ring with explicit sandbox/test restrictions.
- `config/b3-proof-pack.json`: bounded fixture pack identity, version, archive ceilings and allowed entitlement.

### Pack trust, transfer and activation

- `src/domain/packs/rfc8785.js`: shared canonical JSON implementation.
- `src/domain/packs/signed-manifest-contract.js`: exact signed-envelope and manifest schema.
- `src/domain/packs/pack-keyring.js`: environment/pack/key selection.
- `src/domain/packs/pack-signature-verifier.js`: domain-separated P-256 DER verification port.
- `src/domain/packs/data-only-pack-contract.js`: hostile member/inventory rules.
- `ios/App/App/ZipCentralDirectoryInspector.swift`: owned byte-level central/local-header authority.
- `android/app/src/main/java/uk/eugnel/ks2spelling/ZipCentralDirectoryInspector.java`: Java byte-level parity authority.
- `src/platform/pack-transfer/pack-transfer-port.js`: strict logical-identity native port.
- `src/platform/pack-transfer/capacitor-pack-transfer.js`: Capacitor adapter.
- `ios/App/App/PackTransferPlugin.swift`: iOS private range transfer, ZIP inspection/extraction and atomic rename.
- `android/app/src/main/java/uk/eugnel/ks2spelling/PackTransferPlugin.java`: Android equivalent using Java only.
- `src/app/download-coordinator.js`: durable range/free-space/job orchestration.
- `src/app/pack-activation-coordinator.js`: marker/rename/SQLite flip orchestration.
- `src/app/pack-reconciler.js`: startup repair and previous-version rollback.

### Commerce and gateway

- `src/domain/commerce/commerce-contracts.js`: exact product/transaction/entitlement states.
- `src/platform/commerce/store-port.js`: common native store surface.
- `src/platform/commerce/capacitor-store.js`: strict Capacitor adapter.
- `src/platform/gateway/http-entitlement-gateway.js`: validated timeout-bounded no-redirect HTTPS adapter.
- `src/app/purchase-coordinator.js`: journal, verification, completion, restore and revocation state machine.
- `src/app/commerce-reconciler.js`: launch/resume/update replay.
- `ios/App/App/CommercePlugin.swift`: StoreKit 2 bridge.
- `android/app/src/main/java/uk/eugnel/ks2spelling/CommercePlugin.java`: BillingClient 9.1.0 bridge.
- `gateway/src/handler.js`: route/method/content-type/size boundary.
- `gateway/src/apple-store-verifier.js`: official-library sandbox JWS validation.
- `gateway/src/google-store-verifier.js`: OAuth and `ProductPurchaseV2`/acknowledgement validation.
- `gateway/src/refresh-handle.js`: versioned AES-GCM seal/open/reseal and key rotation.
- `gateway/src/pack-access-service.js`: product mapping, signed manifest and capability issuance.
- `gateway/src/r2-capability.js`: 600-second HMAC capability validation.
- `gateway/src/redacted-logging.js`: allow-listed structured logs.

### Persistence, proof and release authority

- `src/platform/database/schema-v2.js`: six app-wide B3 tables and indexes.
- `src/platform/database/sqlite-commerce-repositories.js`: entitlements and journal.
- `src/platform/database/sqlite-pack-repositories.js`: installed/active/job/chunk records.
- `src/domain/commerce/entitlement-access-projection.js`: app-wide active entitlement projection.
- `src/app/create-b3-app-services.js`, `src/app/b3-proof-controller.js`, `src/app/App.jsx`, `src/app/app.css`: diagnostic Parent proof composition only.
- `scripts/build-b3-proof-pack.mjs`: deterministic sandbox fixture ZIP, canonical manifest and test-only signature.
- `scripts/prepare-b3-distribution.mjs`, `scripts/verify-b3-installed-distribution.mjs`: clean-checkpoint build metadata and installed signed-build authority.
- `src/platform/distribution/capacitor-build-authority.js`, `ios/App/App/BuildAuthorityPlugin.swift`, `android/app/src/main/java/uk/eugnel/ks2spelling/BuildAuthorityPlugin.java`: embedded commit/fingerprint/version/build and native distribution identity.
- `scripts/prove-b3-ios-storekit-test.mjs`: non-live Xcode StoreKit Test approve/decline proof.
- `scripts/prove-b3-ios.mjs`, `scripts/prove-b3-android.mjs`, `scripts/prove-b3-cloudflare.mjs`: physical-device/live-sandbox proof wrappers.
- `scripts/lib/b3-evidence.mjs`, `scripts/fingerprint-b3-application.mjs`, `scripts/build-b3-exit-report.mjs`: strict evidence/fingerprint/exit authority.
- `reports/b3/`: deterministic audits plus redacted Apple/Google/Cloudflare proof, screenshots and exit report.

---

### Task 1: Freeze B2 authority and define the external-prerequisite gate

**Files:**

- Create: `provenance/b2-gate.json`
- Create: `scripts/verify-b2-authority.mjs`
- Create: `scripts/check-b3-external-prerequisites.mjs`
- Create: `tests/b2-frozen-authority.test.mjs`
- Create: `tests/b3-external-prerequisites.test.mjs`
- Modify: `package.json`

**Interfaces:**

- Consumes: exact authority table above and the existing local B2/A2 files.
- Produces: `verifyB2Authority({ root }) -> Promise<FrozenAuthority>` and `checkB3ExternalPrerequisites({ approvalFile, runToken, remoteInspector }) -> Promise<{ status, gates }>`; package commands `verify:b2-authority` and `check:b3-prerequisites`.

- [ ] **Step 1: Write failing authority and prerequisite tests**

Require the exact commit/tree/CI URL and six SHA-256 values from the authority table. Require gates named `appleAgreements`, `appleProduct`, `appleSandboxTesterContexts`, `appleServerKeySecretName`, `applePhysicalDevice`, `appleSignedArtefact`, `googleMerchant`, `googleProduct`, `googleServiceAccountSecretName`, `googleInternalTrack`, `googleLicenceTester`, `googlePlayCertifiedDevice`, `googlePlayAppSigningCertificateSha256`, `cloudflareOAuth`, `cloudflareWorker`, `cloudflarePrivateR2`, `cloudflareBindings`, `cloudflareSecretNames` and `remoteMutationApprovals`. Missing gates return `{status:'blocked-external'}` and exit `6`; they never return pass, prompt or print secret values.

- [ ] **Step 2: Run focused tests and record RED**

```bash
node --test tests/b2-frozen-authority.test.mjs tests/b3-external-prerequisites.test.mjs
```

Expected: FAIL because neither fail-closed verifier exists.

- [ ] **Step 3: Add the immutable authority record and verifiers**

`provenance/b2-gate.json` must use this closed shape:

```json
{
  "schemaVersion": 1,
  "commit": "39ef90a5a33efb41368272c4c6d4d002f04658b3",
  "tree": "d4e43a1571fd1a811ce572670c30ae7209e52024",
  "hostedCiUrl": "https://github.com/fol2/ks2-spelling/actions/runs/29192615770",
  "exitReportSha256": "6d19101ff93a3c4f0e74ad0ee987beb915686d108071b6a06b6e3e4562cab6ce",
  "dependencyAuditSha256": "bb3b572280d84beeca2ac4a892836e92fc847bf5cf67015c434f54b94ab085d6",
  "nativeBuildReportSha256": "a72e95958e287be21f34588a167f12fd59058ab003dfe3f559b3ba244988a6f9",
  "nativePluginAuditSha256": "6c09fcc78055a3ab7f693160da22eb84080e25ee3f389b1b79b2a831b63d3740",
  "packageLockSha256": "534b10c7f317622eba32b277b8755a0ac3d04aaf30359117fdeb7510050b6479",
  "gateACommit": "4501607a9b58f2fb252b4cce64ba056e6f60c630",
  "a2ContractManifestSha256": "237b26b14e7506fa271bb3324f701d6205e6e0166d659a16789937478cc77b66"
}
```

The external checker accepts a user-owned, untracked `B3_PREREQUISITES_FILE` containing durable approved identifiers and the exact four scopes `cloudflare-deploy`, `apple-signed-distribution`, `apple-sandbox-history-refund`, `google-test-track-refund-revoke`. A separate `.native-build/b3/run-authority.json` contains a fresh 256-bit run token; `B3_REMOTE_RUN_TOKEN` must match it exactly for the current process. Read-only existing Cloudflare OAuth lists binding/secret names only and compares the exact required-name set; it never reads values. Missing/expired OAuth, identifier drift or token mismatch exits `6` without login or password prompt.

- [ ] **Step 4: Run, review and commit**

```bash
node --test tests/b2-frozen-authority.test.mjs tests/b3-external-prerequisites.test.mjs
npm run verify:b2-authority
npm run check:b3-prerequisites
git diff --check
git add package.json provenance/b2-gate.json scripts/verify-b2-authority.mjs scripts/check-b3-external-prerequisites.mjs tests/b2-frozen-authority.test.mjs tests/b3-external-prerequisites.test.mjs
git commit -m "test: freeze B2 entry authority"
```

Expected: tests and authority verifier PASS; the prerequisite command either PASS with every real gate present or exits `6` with only named missing gates. Obtain fresh spec and quality approval before Task 2.

### Task 2: Freeze product, entitlement, keyring and proof-pack identities

**Files:**

- Create: `config/store-products.json`
- Create: `config/pack-signing-public-keys.json`
- Create: `config/b3-proof-pack.json`
- Create: `config/b3-gateway-authority.json`
- Create: `tests/fixtures/keys/b3-public-test-vector-p256-private.pem`
- Create: `tests/fixtures/keys/README.md`
- Create: `src/domain/commerce/commerce-contracts.js`
- Create: `tests/store-product-contract.test.mjs`
- Create: `tests/pack-keyring-config.test.mjs`
- Create: `tests/b3-gateway-authority.test.mjs`

**Interfaces:**

- Produces: `assertStoreProductCatalogue(value)`, `mapStoreProductToEntitlement({store, productId})`, `assertPackKeyring(value)` and `assertB3ProofPack(value)`.

- [ ] **Step 1: Write strict failing contract tests**

Tests require exactly one product mapping and reject aliases, duplicate products, unknown stores, client entitlement override, keyring private field or production-labelled test key. Gateway authority requires actual approved 32-hex account ID, Worker `ks2-spelling-b3-sandbox`, bucket `ks2-spelling-b3-sandbox-packs`, HTTPS origin `https://b3-gateway.eugnel.uk`, sandbox, allowed origins exactly `capacitor://localhost`, `http://localhost`, no path/query/credential/wildcard; reject placeholders and prove fingerprint/distribution binding.

- [ ] **Step 2: Record RED**

```bash
node --test tests/store-product-contract.test.mjs tests/pack-keyring-config.test.mjs tests/b3-gateway-authority.test.mjs
```

Expected: FAIL because the catalogue, keyring and validators do not exist.

- [ ] **Step 3: Add exact immutable configuration**

```json
{
  "schemaVersion": 1,
  "products": [{
    "entitlementId": "full-ks2",
    "type": "non-consumable",
    "appleProductId": "uk.eugnel.ks2spelling.fullks2",
    "googleProductId": "full_ks2",
    "packIds": ["b3-sandbox-proof"]
  }]
}
```

The keyring record is exactly one SPKI/DER base64 public key with `keyId: "b3-test-p256-2026-07"`, `algorithm: "ECDSA_P256_SHA256_DER"`, `testOnly: true`, `notBefore: "2026-07-01T00:00:00Z"`, `notAfter: "2027-07-01T00:00:00Z"`, `allowedEnvironments: ["test","sandbox"]`, `allowedPackIds: ["b3-sandbox-proof"]`. Encode the public non-secret RFC6979 vector (specified scalar/coordinates) into exact PKCS#8 PEM. Freeze PEM SHA `930c320433c65f7b500f06ebf5a2a31637b96e84bb1572e551c90054ed1dea49`, SPKI SHA `5a7a78cca4a0f420d9bc62bb669c3c2759e39f723d3ae10dcbe0f0815a07ecd4`, and existing SPKI base64. README declares reproducibility-only; runtime bundles exclude PEM/scalar. `b3-proof-pack.json` fixes pack/version/entitlement/archive/extensions/ceilings.

- [ ] **Step 4: Run, review and commit**

```bash
node --test tests/store-product-contract.test.mjs tests/pack-keyring-config.test.mjs tests/b3-gateway-authority.test.mjs
npm test
git diff --check
git add config/store-products.json config/pack-signing-public-keys.json config/b3-proof-pack.json config/b3-gateway-authority.json src/domain/commerce/commerce-contracts.js tests/store-product-contract.test.mjs tests/pack-keyring-config.test.mjs tests/b3-gateway-authority.test.mjs tests/fixtures/keys
git commit -m "feat: freeze B3 commerce identities"
```

Expected: exact contract tests and regression suite PASS. Review must confirm the only signing half is public/non-secret RFC 6979 reproducibility material, no secret/production private key exists, and the gateway origin/account/Worker/origin allow-list equals durable approval.

### Task 3: Implement RFC 8785 canonical bytes and signed-manifest verification

**Files:**

- Create: `src/domain/packs/rfc8785.js`
- Create: `src/domain/packs/signed-manifest-contract.js`
- Create: `src/domain/packs/pack-keyring.js`
- Create: `src/domain/packs/pack-signature-verifier.js`
- Create: `tests/rfc8785.test.mjs`
- Create: `tests/pack-signature.test.mjs`
- Create: `tests/fixtures/rfc8785-vectors.json`

**Interfaces:**

- Produces: canonicaliser/envelope/signing input, `selectPackVerificationKey({keyring,keyId,packId,environment,clock})`, and `verifySignedPackManifest({envelopeBytes,keyring,environment,clock,verifyP256Der})`.

- [ ] **Step 1: Write failing canonicalisation and signature tests**

Use RFC8785 vectors plus duplicate/invalid/noncanonical/unknown/wrong environment/malformed DER mutations. Inject clock and test one millisecond before notBefore rejected, exact notBefore accepted, exact notAfter accepted, one millisecond after rejected.

```js
const PACK_SIGNING_DOMAIN = new TextEncoder().encode(
  'ks2-spelling-pack-manifest-v1\u0000',
);
return concatBytes(PACK_SIGNING_DOMAIN, canonicalManifestBytes);
```

- [ ] **Step 2: Record RED**

```bash
node --test tests/rfc8785.test.mjs tests/pack-signature.test.mjs
```

Expected: FAIL with missing canonicaliser and verifier exports.

- [ ] **Step 3: Implement the exact envelope and verify-before-parse sequence**

The envelope closed keys are:

```js
{
  schemaVersion: 1,
  algorithm: 'ECDSA_P256_SHA256_DER',
  keyId: 'b3-test-p256-2026-07',
  payloadEncoding: 'RFC8785_UTF8',
  domain: 'ks2-spelling-pack-manifest-v1',
  canonicalManifestBase64: 'base64(RFC8785 UTF-8 bytes)',
  signatureDerBase64: 'base64(ASN.1 DER ECDSA signature)'
}
```

Decode canonical bytes, select the key using the untrusted envelope only as a lookup, verify P-256/SHA-256 DER over the domain-separated bytes, then parse JSON and require `canonicaliseRfc8785(parsed)` to equal the signed bytes before A2 semantic validation.

- [ ] **Step 4: Run, review and commit**

```bash
node --test tests/rfc8785.test.mjs tests/pack-signature.test.mjs
npm run lint
git diff --check
git add src/domain/packs tests/rfc8785.test.mjs tests/pack-signature.test.mjs tests/fixtures/rfc8785-vectors.json
git commit -m "feat: verify signed pack manifests"
```

Expected: all valid vectors PASS and every mutation is rejected before semantic use. Review must compare the signing bytes, DER format and key-selection restrictions exactly.

### Task 4: Build the deterministic signed sandbox pack and hostile ZIP corpus

**Files:**

- Create: `src/domain/packs/data-only-pack-contract.js`
- Create: `scripts/build-b3-proof-pack.mjs`
- Create: `tests/data-only-pack-contract.test.mjs`
- Create: `tests/b3-proof-pack-builder.test.mjs`
- Create: `tests/fixtures/b3-pack-source/catalogue.json`
- Create: `tests/fixtures/b3-pack-source/audio/proof-word.m4a`
- Create: `tests/helpers/hostile-zip-builder.mjs`
- Create: `tests/fixtures/keys/b3-sandbox-proof-manifest-signature.der`
- Create: `tests/fixtures/b3-signed-manifest.json`
- Create: `tests/fixtures/b3-hostile-zips/manifest.json`
- Create: `tests/fixtures/b3-hostile-zips/*.zip`
- Create: `reports/b3/b3-proof-pack-build.json`
- Create: `config/b3-pack-object-authority.json`

**Interfaces:**

- Produces: `validateDataOnlyInventory({manifest,entries})`, deterministic `.native-build/b3/pack/b3-sandbox-proof.zip`, byte-equal `.native-build/b3/pack/signed-manifest.json`, full signed-envelope SHA-256 and `npm run build:b3-proof-pack`. It exposes no signing API.

- [ ] **Step 1: Write failing data-only and deterministic-build tests**

Generate and commit actual byte-stable ZIPs covering traversal, absolute/drive/backslash paths, dot/empty segments, duplicate/case-fold/NFC collisions, creator OS zero/unknown, mode zero/ambiguous, symlink/hard-link/device/FIFO/socket/directory modes, central/local name/flag/method/CRC/size mismatch, duplicate/overlapping local-header offsets and data ranges, central-directory overlap, truncated/overflowing offsets/sizes, multiple/ambiguous EOCD, EOCD not at EOF, prepended/trailing junk, non-zero/unknown extra fields, data descriptor, ZIP64, undeclared/missing member, executable extension and compressed/extracted/file-count ceilings. Freeze every fixture SHA-256 in `tests/fixtures/b3-hostile-zips/manifest.json`. Assert two clean builds have identical archive, canonical manifest, full signed envelope and report SHA-256. Final-builder tests must reject every signing/authoring option/import.

- [ ] **Step 2: Record RED**

```bash
node --test tests/data-only-pack-contract.test.mjs tests/b3-proof-pack-builder.test.mjs
```

Expected: FAIL because the validator and deterministic builder are absent.

- [ ] **Step 3: Implement the bounded test-only builder**

At an early uncommitted fixture-authoring checkpoint, generate fixed archive/canonical bytes and `.native-build/b3/pack/signing-input.bin`, run OpenSSL once over the public RFC 6979 fixture, record DER SHA-256 in `config/b3-proof-pack.json`, assemble `tests/fixtures/b3-signed-manifest.json`, and freeze full envelope SHA-256. Immediately remove/disable the input-emission flag and every authoring branch before the task commit. The final committed builder has no private-key import, signing code or accepted authoring flag: it only regenerates archive/canonical bytes, verifies the one DER fixture and requires byte equality with the committed envelope.

Run the one-time authoring checkpoint exactly once:

```bash
node scripts/build-b3-proof-pack.mjs --author-fixture-input
openssl dgst -sha256 -sign tests/fixtures/keys/b3-public-test-vector-p256-private.pem -out tests/fixtures/keys/b3-sandbox-proof-manifest-signature.der .native-build/b3/pack/signing-input.bin
shasum -a 256 tests/fixtures/keys/b3-sandbox-proof-manifest-signature.der
```

Then delete the authoring path/flag, implement final verify-only behaviour, and write `config/b3-pack-object-authority.json` with two ordered records. Each record freezes exact key, SHA-256, byte size, deterministic single-PUT MD5 ETag and custom metadata `b3-role`, `b3-sha256`, `b3-size`; manifest metadata also binds full envelope SHA. Worker/deploy code imports this file and may not reconstruct keys/hashes independently.

- [ ] **Step 4: Run, review and commit**

```bash
npm run build:b3-proof-pack
if node scripts/build-b3-proof-pack.mjs --author-fixture-input; then exit 1; fi
node --test tests/data-only-pack-contract.test.mjs tests/b3-proof-pack-builder.test.mjs
git diff --check
git add package.json config/b3-proof-pack.json config/b3-pack-object-authority.json src/domain/packs/data-only-pack-contract.js scripts/build-b3-proof-pack.mjs tests/data-only-pack-contract.test.mjs tests/b3-proof-pack-builder.test.mjs tests/fixtures/b3-pack-source tests/fixtures/b3-hostile-zips tests/fixtures/b3-signed-manifest.json tests/fixtures/keys/b3-sandbox-proof-manifest-signature.der tests/helpers/hostile-zip-builder.mjs reports/b3/b3-proof-pack-build.json
git commit -m "test: build signed B3 proof pack"
```

Expected: PASS with deterministic public artefact evidence; `.native-build` remains untracked. The only tracked signing half is the exact public/non-secret RFC 6979 test vector from Task 2; no secret or production key exists. Review must inspect every hostile ZIP category, frozen fixture/signature/envelope hashes and generated runtime/native/archive bytes for absence of the test signing half.

- [ ] **Step 5: Push the first reviewed safety checkpoint**

```bash
test "$(git branch --show-current)" = "jamesto/mobile-b3-billing-download"
git status --short
git push -u origin jamesto/mobile-b3-billing-download
```

Expected: clean tree, Task 4 spec/quality reviews clean, push succeeds without force. If documented exact-HEAD full pre-push tests already passed, `SKIP_PREPUSH=1 git push -u origin jamesto/mobile-b3-billing-download` is permitted and recorded.

### Task 5: Add SQLite schema V2 with transactional migration and rollback

**Files:**

- Create: `src/platform/database/schema-v2.js`
- Modify: `src/platform/database/migrate-database.js`
- Create: `tests/sqlite-schema-v2.test.mjs`
- Create: `tests/sqlite-v1-v2-migration.test.mjs`
- Create: `tests/sqlite-v2-migration-rollback.test.mjs`

**Interfaces:**

- Consumes: B2 `SCHEMA_VERSION === 1` and the asynchronous SQL connection.
- Produces: `SCHEMA_VERSION === 2`, `SCHEMA_V2_STATEMENTS`, deterministic V0->V1->V2/V1->V2 migration and unchanged B2 learner rows.

- [ ] **Step 1: Write failing V2 schema and rollback tests**

Require these six app-wide tables and forbid learner/private fields through `PRAGMA table_info`. Require `sealed_refresh_handle` only on `app_entitlements`, never journal/download tables; require a positive handle version only when a handle exists. Require foreign keys, unique non-null store transaction IDs, V1 byte preservation, idempotent reopen, unknown V3 rejection and failure injection after every V2 statement.

- [ ] **Step 2: Record RED**

```bash
node --test tests/sqlite-schema-v2.test.mjs tests/sqlite-v1-v2-migration.test.mjs tests/sqlite-v2-migration-rollback.test.mjs
```

Expected: FAIL because schema V2 does not exist.

- [ ] **Step 3: Add exact app-wide table contracts**

Use closed states and keys:

```text
app_entitlements(
  entitlement_id PK, store, product_id, state active|revoked,
  sealed_refresh_handle NULL, refresh_handle_version NULL,
  verified_at, refreshed_at, revocation_at NULL
)
transaction_journal(
  journal_id PK, store, product_id, store_transaction_id NULL,
  observation_state pending|purchased|revoked,
  processing_state observed|verified|entitlement-committed|store-completion-pending|complete|rejected,
  opaque_proof NULL, created_at, updated_at
)
installed_pack_versions(
  pack_id, version, manifest_sha256, path_token, activation_marker_sha256,
  state ready|retired, installed_at, PRIMARY KEY(pack_id,version)
)
active_pack_versions(
  pack_id PK, version, manifest_sha256, path_token, activated_at,
  FK(pack_id,version) -> installed_pack_versions
)
pack_download_jobs(
  job_id PK, pack_id, version, manifest_sha256, archive_name,
  archive_sha256, expected_bytes, completed_bytes, etag NULL,
  state queued|downloading|downloaded|extracting|ready|failed, updated_at
)
pack_download_chunks(
  job_id, start_byte, end_byte_exclusive, state pending|complete,
  chunk_sha256 NULL, PRIMARY KEY(job_id,start_byte), FK(job_id) ON DELETE CASCADE
)
```

No capability URL column exists. Before migration, preserve the B2 database bytes through the existing rollback discipline; after success require `user_version=2`, `integrity_check=ok` and unchanged learner canonical digests.

- [ ] **Step 4: Run, review and commit**

```bash
node --test tests/sqlite-schema.test.mjs tests/sqlite-migration-rollback.test.mjs tests/sqlite-schema-v2.test.mjs tests/sqlite-v1-v2-migration.test.mjs tests/sqlite-v2-migration-rollback.test.mjs
git diff --check
git add src/platform/database/schema-v2.js src/platform/database/migrate-database.js tests/sqlite-schema-v2.test.mjs tests/sqlite-v1-v2-migration.test.mjs tests/sqlite-v2-migration-rollback.test.mjs
git commit -m "feat: add app-wide commerce schema"
```

Expected: B2 and V2 migration suites PASS. Review must prove no automatic reset/delete and no learner field in app-wide tables.

### Task 6: Implement app-wide entitlement, journal, pack and download repositories

**Files:**

- Create: `src/platform/database/sqlite-commerce-repositories.js`
- Create: `src/platform/database/sqlite-pack-repositories.js`
- Create: `src/domain/commerce/entitlement-access-projection.js`
- Create: `tests/sqlite-commerce-repositories.test.mjs`
- Create: `tests/sqlite-pack-repositories.test.mjs`
- Create: `tests/entitlement-access-projection.test.mjs`
- Create: `tests/b3-learner-preservation.test.mjs`
- Create: `config/b3-synthetic-learners.json`
- Create: `tests/b3-synthetic-learners.test.mjs`

**Interfaces:**

- Produces: `createSqliteCommerceRepositories(connection)`, `createSqlitePackRepositories(connection)` and `projectActiveEntitlements(rows) -> ReadonlySet<string>`.
- Required methods: `observeTransaction`, `markVerified`, `commitEntitlementAndReadyToComplete`, `markStoreCompleteAndClearProof`, `markRejectedAndClearProof`, `replaceSealedRefreshHandle`, `applyRevocationAndDeleteHandle`, `listRecoverableTransactions`, pack/job methods.

- [ ] **Step 1: Write failing repository and preservation tests**

Cover proof lifetime, completion clear, handle replacement/revoke deletion, safe ID, and `markRejectedAndClearProof`: authenticated permanent rejection/definitive malformed proof commits `processing_state='rejected'` + `opaque_proof=NULL` atomically; crash/replay cannot restore proof. DNS/abort/timeout/429/5xx leaves original recoverable state/proof byte-identical. Cover synthetic authority exactly.

- [ ] **Step 2: Record RED**

```bash
node --test tests/sqlite-commerce-repositories.test.mjs tests/sqlite-pack-repositories.test.mjs tests/entitlement-access-projection.test.mjs tests/b3-learner-preservation.test.mjs
```

Expected: FAIL with missing repositories.

- [ ] **Step 3: Implement transactional app-wide repositories**

`commitEntitlementAndReadyToComplete` atomically stores the Worker-sealed handle/version, gateway-returned `storeTransactionId` and ready-to-complete state. Apple IDs must match decimal transaction ID; Google IDs exact `GPA.####-####-####-#####`. `transactionRef`, JWS/token/opaque proof may never populate that column. `applyRevocationAndDeleteHandle` writes `state='revoked'` before nulling handle/version within one SQLite transaction and commits once. `markStoreCompleteAndClearProof` sets `opaque_proof=NULL` in the same write that marks `complete`. Pending observations keep store ID null until live gateway verification.

- [ ] **Step 4: Run, review and commit**

```bash
node --test tests/sqlite-commerce-repositories.test.mjs tests/sqlite-pack-repositories.test.mjs tests/entitlement-access-projection.test.mjs tests/b3-learner-preservation.test.mjs tests/b3-synthetic-learners.test.mjs tests/sqlite-multi-learner.test.mjs
npm run lint
git diff --check
git add config/b3-synthetic-learners.json src/platform/database/sqlite-commerce-repositories.js src/platform/database/sqlite-pack-repositories.js src/domain/commerce/entitlement-access-projection.js tests/sqlite-commerce-repositories.test.mjs tests/sqlite-pack-repositories.test.mjs tests/entitlement-access-projection.test.mjs tests/b3-learner-preservation.test.mjs tests/b3-synthetic-learners.test.mjs
git commit -m "feat: persist app-wide pack access"
```

Expected: all app-wide and learner-isolation tests PASS. Review must prove entitlement authority is not copied into learner snapshots.

### Task 7: Define strict store, gateway and pack-transfer ports with deterministic fakes

**Files:**

- Create: `src/platform/commerce/store-port.js`
- Create: `src/platform/commerce/capacitor-store.js`
- Create: `src/platform/gateway/entitlement-gateway-port.js`
- Create: `src/platform/gateway/http-entitlement-gateway.js`
- Create: `src/platform/pack-transfer/pack-transfer-port.js`
- Create: `src/platform/fakes/create-b3-fake-store.js`
- Create: `src/platform/fakes/create-b3-fake-gateway.js`
- Create: `src/platform/fakes/create-b3-fake-pack-transfer.js`
- Create: `tests/b3-port-contracts.test.mjs`
- Create: `tests/capacitor-store.test.mjs`
- Create: `tests/http-entitlement-gateway.test.mjs`

**Interfaces:**

- Produces the exact async surfaces below.

```js
StorePort = {
  queryProducts({ productIds }),
  purchase({ productId }),
  queryTransactions({ productIds }),
  restore({ productIds }),
  finishTransaction({ transactionRef }),
  subscribeTransactionUpdates(listener)
}
EntitlementGatewayPort = {
  verifyTransaction({ store, environment, productId, opaqueProof }),
  completeTransaction({ sealedRefreshHandle }),
  refreshEntitlement({ sealedRefreshHandle }),
  authorisePackDownload({ sealedRefreshHandle, packId, version })
}
PackTransferPort = {
  getFreeBytes(),
  downloadRange({ capabilityUrl, packId, version, archiveName, startByte, endByteExclusive, truncate }),
  inspectAndExtract({ packId, version, archiveName, signedManifestEnvelopeBase64 }),
  sealAndInstall({ packId, version, manifestSha256 }),
  inventoryInstalledVersions(),
  removeOwnedTemporaryState({ packId, version })
}
```

`createCapacitorStore({ Commerce })` validates every native request/result/event against the closed StorePort shapes and never persists native `transactionRef`. `createHttpEntitlementGateway({ authority, fetchImpl, timeoutMs: 10000 })` exposes the EntitlementGatewayPort using only the tracked HTTPS origin, exact route paths, `redirect:'error'`, `credentials:'omit'`, `cache:'no-store'`, no referrer and AbortController timeout. It validates status/content-type/body size/closed JSON/error code before returning; response errors contain only safe code/status/retryability.

- [ ] **Step 1: Write failing exact-shape tests**

Reject unknown methods/keys, non-Promise returns, arbitrary paths, capability/refresh-handle persistence outside the entitlement repository, learner fields and raw-proof/handle logging. HTTP tests cover exact origin/path, both native CORS origins, preflight allow-list, timeout abort, DNS/offline, malformed/oversized/non-JSON response, closed success/error shapes, 3xx rejection and zero endpoint logging. Store adapter tests cover product/cancel/pending/purchased/revoked/update parity and reject proof/transactionRef leakage into durable IDs. Fakes expose deterministic scripted outcomes and random per-run trace IDs.

- [ ] **Step 2: Record RED**

```bash
node --test tests/b3-port-contracts.test.mjs tests/capacitor-store.test.mjs tests/http-entitlement-gateway.test.mjs
```

Expected: FAIL because B1's disabled fake does not implement B3 contracts.

- [ ] **Step 3: Implement closed validators and fakes**

Product responses contain only `productId`, `displayName`, `description`, `displayPrice` and `currencyCode`. Transaction observations normalise to `cancelled|pending|purchased|revoked|unverified`; only purchased/revoked observations may carry opaque proof. Gateway verified response closed keys are `store`, `productId`, `environment`, `applicationId`, `entitlementId`, `state`, `storeTransactionId`, `sealedRefreshHandle`, `refreshHandleVersion`, `traceId`, `workerVersionId`, `workerScriptAuthoritySha256`. Refresh/download responses cross-check the same safe transaction/application/Worker identity. The app never accepts entitlement/store ID from native input.

- [ ] **Step 4: Run, review and commit**

```bash
node --test tests/b3-port-contracts.test.mjs tests/capacitor-store.test.mjs tests/http-entitlement-gateway.test.mjs tests/native-port-contract.test.mjs
npm run lint
git diff --check
git add src/platform/commerce src/platform/gateway src/platform/pack-transfer src/platform/fakes/create-b3-fake-*.js tests/b3-port-contracts.test.mjs tests/capacitor-store.test.mjs tests/http-entitlement-gateway.test.mjs
git commit -m "feat: define B3 native service ports"
```

Expected: B1 and B3 contract tests PASS without weakening the frozen B1 boundary. Review must reject arbitrary paths or learner-bearing gateway inputs.

### Task 8: Implement purchase coordination and crash-safe transaction replay

**Files:**

- Create: `src/app/purchase-coordinator.js`
- Create: `src/app/commerce-reconciler.js`
- Create: `src/domain/commerce/purchase-state.js`
- Create: `src/platform/database/sqlite-commerce-attempt-repository.js`
- Create: `tests/purchase-coordinator.test.mjs`
- Create: `tests/purchase-crash-recovery.test.mjs`
- Create: `tests/purchase-replay-authority.test.mjs`
- Create: `tests/purchase-second-lifecycle.test.mjs`
- Create: `tests/sqlite-commerce-attempt-repository.test.mjs`
- Create: `tests/commerce-reconciler.test.mjs`
- Modify: `src/platform/database/sqlite-commerce-repositories.js`
- Modify: `src/domain/commerce/entitlement-access-projection.js`
- Modify: `tests/sqlite-commerce-repositories.test.mjs`
- Modify: `tests/entitlement-access-projection.test.mjs`
- Modify: `src/platform/fakes/create-b3-fake-gateway.js`
- Modify: `tests/b3-port-contracts.test.mjs`

**Interfaces:**

- Produces: `createPurchaseCoordinator({store,gateway,commerceRepository,attemptRepository,downloadRepository,clock,idFactory,failureInjector})` with `purchaseFullKs2`, `handleObservation`, `restore`, `refresh` and `recover`; `createCommerceReconciler(...).start()/resume()/dispose()`.

**Implementation amendment:** Task 8 adds a platform-configured two-method
`CommerceAttemptPort` dependency to the purchase coordinator. The frozen Task 6
nine-method repository and Task 7 six-method StorePort cannot durably record a
pre-store Parent attempt and safely delete an unprogressed cancelled/empty
attempt. The port shares the existing SQLite transaction serialiser, uses the
unchanged `transaction_journal` schema, and exposes only
`preparePendingAttempt({journalId,observedAt})` and
`discardPendingAttempt({journalId})`. A durable pending intent is one-shot
authorisation across an ambiguous process loss; every acquired proof still
requires live gateway verification.

Task 8 also derives the current safe store transaction ID into the closed
entitlement projection from `transaction_journal`; it does not add a column or
repository method. Projection queries consider every non-null candidate and
fail closed unless exactly one canonical purchased/active or revoked/revoked
lifecycle owner exists. Every acquisition or revocation transfer atomically
clears all earlier non-null owners for the same store/product before assigning
the current journal. Refresh and download authorisation must cross-check that
derived ID exactly.

An active entitlement never treats a later native purchased proof as an offline
no-op. It uses one deterministic, reusable, proof-bearing active-callback
journal per store/product. The callback journal owns no safe ID: live
verification must match the separate current lifecycle owner before gateway
completion, native finish and atomic proof clear. A changed safe ID is rejected
and proof-cleared without completion, finish or access loss. Completed callback
slots may reopen; rejected slots never reopen, keeping replay row count bounded.
Before Parent Buy or Restore invokes a second store operation, any existing
non-pending acquisition is recovered to completion. A complete native snapshot
is validated and deduplicated before effects; different acquisition candidates
fail with `PURCHASE_NATIVE_ACQUISITION_AMBIGUOUS`.
An existing proof-free pending Parent intent is also one-shot: the next explicit
action queries native state without invoking the store operation again, then
promotes a matching purchase, preserves matching pending state, or discards an
authoritatively empty/cancelled intent so only a later Parent action may retry.
The read-only query snapshot is closed and prevalidated before effects. A
matching unverified outcome preserves the intent and fails closed; a verified
revocation is processed without invoking Buy/Restore and also preserves the
intent; acquisition is always processed before a same-snapshot revocation so
revocation is final. Any foreign pending, purchased or revoked authority fails
closed without gateway or durable entitlement effects.

- [ ] **Step 1: Write failing state-machine and crash-matrix tests**

Inject a crash before/after every arrow:

```text
observation -> journal -> verify -> entitlement transaction
-> sealed-handle persistence -> gateway completion -> store finish/confirmation
-> raw proof clear -> handle-authorised download job
```

Cover normal states plus failure classification. Authenticated nonretryable gateway codes `PROOF_REJECTED`, `PRODUCT_MISMATCH`, `STORE_TRANSACTION_ID_INVALID`, or definitive malformed submitted proof call atomic rejected+clear; inject crash before/after and replay. DNS/abort/timeout/429/5xx never call it and preserve recoverable proof/state/access/install.

- [ ] **Step 2: Record RED**

```bash
node --test tests/purchase-coordinator.test.mjs tests/purchase-crash-recovery.test.mjs tests/purchase-replay-authority.test.mjs tests/purchase-second-lifecycle.test.mjs tests/sqlite-commerce-repositories.test.mjs tests/sqlite-commerce-attempt-repository.test.mjs tests/entitlement-access-projection.test.mjs tests/commerce-reconciler.test.mjs
```

Expected: FAIL before implementation. The final repair recorded 14/17 with
three failures for Buy/Restore preflight and whole-snapshot ambiguity, followed
by 40/44 with four failures for safe-ID projection and refresh/download
cross-checks. The adversarial follow-up recorded 0/2 for callback proof A/B
mismatch and rejection crash convergence: the callback remained verified with
proof A instead of rejected and proof-cleared. A second focused run recorded
0/2 for one-shot pending Buy/Restore reconciliation and Restore-result
ambiguity: the store operation was invoked again and the ambiguous result did
not reject. The final snapshot repair recorded 20/24 with four failures: a
matching unverified outcome was treated as empty, revocation-only was treated
as empty, a mixed acquisition/revocation snapshot stopped after acquisition,
and a foreign revocation was not recognised as foreign authority.

- [ ] **Step 3: Implement exact ordering and idempotency**

Implement a closed retryability classifier. Permanent authenticated rejection calls `markRejectedAndClearProof` once; transport/429/5xx stays recoverable. Verified response stores handle/version/safe ID then completion. Offline never revokes. Restore uses fresh proof/handle; only live verified revoke locks and deletes handle.

- [ ] **Step 4: Run, review and commit**

```bash
node --test tests/purchase-coordinator.test.mjs tests/purchase-crash-recovery.test.mjs tests/purchase-replay-authority.test.mjs tests/purchase-second-lifecycle.test.mjs tests/sqlite-commerce-repositories.test.mjs tests/sqlite-commerce-attempt-repository.test.mjs tests/entitlement-access-projection.test.mjs tests/commerce-reconciler.test.mjs tests/b3-port-contracts.test.mjs tests/b3-learner-preservation.test.mjs
npm run lint
git diff --check
git add docs/superpowers/plans/2026-07-12-standalone-spelling-mobile-b3-sandbox-billing-signed-download-proof.md src/app/purchase-coordinator.js src/app/commerce-reconciler.js src/domain/commerce/purchase-state.js src/domain/commerce/entitlement-access-projection.js src/platform/database/sqlite-commerce-repositories.js src/platform/database/sqlite-commerce-attempt-repository.js src/platform/fakes/create-b3-fake-gateway.js tests/purchase-coordinator.test.mjs tests/purchase-crash-recovery.test.mjs tests/purchase-replay-authority.test.mjs tests/purchase-second-lifecycle.test.mjs tests/sqlite-commerce-repositories.test.mjs tests/sqlite-commerce-attempt-repository.test.mjs tests/entitlement-access-projection.test.mjs tests/commerce-reconciler.test.mjs tests/b3-port-contracts.test.mjs
git commit -m "fix: reconcile pending authority snapshots"
```

Expected: every restart point converges without double entitlement, double finish/acknowledgement or learner mutation. Obtain fresh state-machine and privacy reviews.

- [ ] **Step 5: Push the reviewed commerce checkpoint**

```bash
test "$(git branch --show-current)" = "jamesto/mobile-b3-billing-download"
git status --short
git push origin jamesto/mobile-b3-billing-download
```

Expected: clean reviewed Task 8 HEAD pushed without force; any `SKIP_PREPUSH=1` use requires exact-HEAD full relevant suite recorded.

### Task 9: Implement the receipt-only gateway boundary and live store-verifier adapters

**Files:**

- Create: `gateway/package.json`
- Create: `gateway/package-lock.json`
- Create: `gateway/wrangler.jsonc`
- Create: `gateway/src/handler.js`
- Create: `gateway/src/store-verifier-port.js`
- Create: `gateway/src/apple-store-verifier.js`
- Create: `gateway/src/google-store-verifier.js`
- Create: `gateway/src/refresh-handle.js`
- Create: `gateway/src/redacted-logging.js`
- Create: `gateway/config/apple-root-certificates/AppleRootCA-G3.der`
- Create: `gateway/config/apple-root-certificates.json`
- Create: `tests/gateway-contract.test.mjs`
- Create: `tests/gateway-store-verifiers.test.mjs`
- Create: `tests/gateway-privacy-boundary.test.mjs`
- Create: `tests/gateway-refresh-handle.test.mjs`
- Create: `tests/gateway-workerd-runtime.test.mjs`
- Create: `tests/fixtures/apple/x509-chain-fixture.json`
- Create: `tests/fixtures/apple/app-store-api-response.json`

**Interfaces:**

- Produces Worker routes `POST /v1/entitlements/verify`, `POST /v1/entitlements/refresh`, `POST /v1/transactions/complete`, internal `StoreVerifier.verify/refresh/complete` results derived from live store truth, and `sealRefreshHandle/openRefreshHandle/resealRefreshHandle` with current+previous rotation.

- [ ] **Step 1: Write failing handler, verifier and privacy tests**

Require rate limiting before body read/JSON parse/cryptography/external fetch on every public POST/GET, missing-binding fail closed, `429` with body-read/upstream counters zero, POST JSON 64 KiB max. CORS/preflight allows origins exactly `capacitor://localhost`, `http://localhost`, methods `GET, POST, OPTIONS`, request header only `Content-Type`, `Vary: Origin`, no wildcard/credentials; unlisted origin/header/method is `403`. Require sandbox-only environment, Apple live safe decimal transaction ID, Google live safe GPA order ID/TEST. Verify accepts raw proof once; refresh/complete handle only. Reject learner/private fields. Metrics/logs contain no endpoint query/proof/trace/handle/token/capability.

- [ ] **Step 2: Record RED**

```bash
node --test tests/gateway-contract.test.mjs tests/gateway-store-verifiers.test.mjs tests/gateway-privacy-boundary.test.mjs tests/gateway-refresh-handle.test.mjs tests/gateway-workerd-runtime.test.mjs
```

Expected: FAIL because the gateway does not exist.

- [ ] **Step 3: Implement official live verification boundaries**

Pin exact official `@apple/app-store-server-library@3.1.0`, `wrangler@4.110.0` and `miniflare@4.20260708.1` in `gateway/package-lock.json`; set compatibility date `2026-07-12` and flags exactly `["nodejs_compat"]`. Copy Apple Root CA G3 from `https://www.apple.com/certificateauthority/AppleRootCA-G3.cer`, record source URL/SHA-256 in the closed certificate manifest, and validate submitted signed transactions with that trust root, sandbox environment and exact bundle ID. Then use App Store Server API with Worker secrets to query the same transaction ID in sandbox, verify returned JWS again, and derive current product/revocation truth; never authorise solely from replayable client JWS. For Google, create a short-lived OAuth token from the configured service-account secret, call `purchases.productsv2.getproductpurchasev2`, require package/product, `PURCHASED|PENDING|CANCELLED` and `testPurchaseContext.fopType === 'TEST'`, and acknowledge only a verified unacknowledged `PURCHASED` token.

Parse both handle secrets only as `v{positiveInteger}:{canonicalBase64url(raw32)}`; reject equal versions, equal bytes, padding, zero/negative/non-canonical versions or wrong length. Implement handle format `b3rh1.{keyVersion}.{base64urlNonce}.{base64urlCiphertextAndTag}`. AAD is exact UTF-8 `["b3rh1", String(keyVersion), store, productId, environment, applicationId].join("\n")`; payload repeats exact `format:"b3rh1"`, keyVersion/store/product/environment/applicationId plus gateway-safe `storeTransactionId`, opaque proof and issuedAt. Prefix, AAD, payload and request context must all equal. Current encrypts, current/previous decrypt, previous returns freshly resealed current plus positive `refreshHandleVersion`. Use 12 random bytes and per-isolate bounded nonce-reuse detection/retry; deterministic collision tests and 10,000-issuance uniqueness tests pass. Apple `storeTransactionId` comes only from verified live `transactionId`; Google only live `orderId`. Reject native transactionRef, JWS/token/proof-like value as durable ID.

Set Wrangler `version_metadata` binding exactly `WORKER_VERSION_METADATA`. Gateway safe responses include `workerVersionId = env.WORKER_VERSION_METADATA.id` and embedded `workerScriptAuthoritySha256`; no client-supplied Worker identity is accepted.

- [ ] **Step 4: Run, audit, review and commit**

```bash
npm --prefix gateway ci
node --test tests/gateway-contract.test.mjs tests/gateway-store-verifiers.test.mjs tests/gateway-privacy-boundary.test.mjs tests/gateway-refresh-handle.test.mjs tests/gateway-workerd-runtime.test.mjs
npm --prefix gateway run deploy:dry-run
npm --prefix gateway audit --omit=dev
git diff --check
git add gateway tests/gateway-contract.test.mjs tests/gateway-store-verifiers.test.mjs tests/gateway-privacy-boundary.test.mjs tests/gateway-refresh-handle.test.mjs tests/gateway-workerd-runtime.test.mjs tests/fixtures/apple
git commit -m "feat: add receipt-only entitlement gateway"
```

Expected: Node contracts, real Miniflare/workerd import/X.509/API-fetch-interception test and Wrangler dry-run PASS; audit has no unresolved high/critical finding. Review must confirm product/entitlement mapping is server-owned, handle rotation works, Google test context is enforced and no raw proof/handle reaches logs/errors.

### Task 10: Add private-R2 pack access and short-lived Worker capabilities

**Files:**

- Create: `gateway/src/r2-capability.js`
- Create: `gateway/src/pack-access-service.js`
- Create: `tests/gateway-r2-capability.test.mjs`
- Create: `tests/gateway-pack-access.test.mjs`
- Create: `tests/helpers/fake-r2-bucket.mjs`
- Modify: `gateway/src/handler.js`
- Modify: `gateway/wrangler.jsonc`

**Interfaces:**

- Produces `POST /v1/packs/authorise-download` and `GET /v1/packs/:packId/:version/:archiveName?expires={expiresUnixSeconds}&cap={base64urlCapability}`; `issueR2Capability({method,objectKey,expiresAt,secret})`; `verifyR2Capability(...)`.

- [ ] **Step 1: Write failing capability and Range tests**

Require exactly 600-second maximum TTL against an injected clock, raw 32-byte WebCrypto HMAC-SHA-256, constant-time byte comparison, canonical unpadded base64url decode/re-encode equality, canonical decimal expiry, exact method/object/expiry binding, private R2 plus mandatory rate-limit binding before capability/R2 work, no redirects, and `200/206/304/416` semantics with exact headers. Missing/limited binding returns fail-closed/`429` with zero R2 calls. Import exact keys/digests/sizes/ETags/custom metadata only from tracked object authority; reject traversal, arbitrary/drifted R2 key, expired/future-overlong capability and unauthorised handle.

- [ ] **Step 2: Record RED**

```bash
node --test tests/gateway-r2-capability.test.mjs tests/gateway-pack-access.test.mjs
```

Expected: FAIL because capability issuance and private-R2 routes are absent.

- [ ] **Step 3: Implement server-owned pack mapping and streaming**

The HMAC input has no trailing line feed and is constructed only as:

```js
const capabilityMessage = new TextEncoder().encode([
  'ks2-spelling-r2-capability-v1',
  'GET',
  objectKey,
  String(expiresAtUnixSeconds),
].join('\n'));
```

The authorise route accepts only the sealed refresh handle, decrypts/live-verifies it, reads exact signed-manifest object through private `PACKS`, verifies every tracked object-authority field, and returns immutable envelope bytes plus safe response metadata: random trace ID, Worker version ID/script authority, full envelope SHA, exact two object records and archive capability. Manifest remains a second private object. Deployment/upload refuses overwrite unless bytes, size, ETag and custom metadata all equal authority. Evidence stores only safe metadata. GET applies `GATEWAY_RATE_LIMIT` before capability/R2 work, never redirects, streams without whole-archive buffering and redacts full query.

- [ ] **Step 4: Run, review and commit**

```bash
node --test tests/gateway-r2-capability.test.mjs tests/gateway-pack-access.test.mjs tests/gateway-privacy-boundary.test.mjs
git diff --check
git add gateway/src/r2-capability.js gateway/src/pack-access-service.js gateway/src/handler.js gateway/wrangler.jsonc tests/gateway-r2-capability.test.mjs tests/gateway-pack-access.test.mjs tests/helpers/fake-r2-bucket.mjs
git commit -m "feat: stream authorised private packs"
```

Expected: Range and capability mutation matrix PASS. Review must prove `r2.dev`/public access is not configured and bearer values are absent from logs.

### Task 11: Implement resumable range download, expiry renewal and storage preflight

**Files:**

- Create: `src/app/download-coordinator.js`
- Create: `src/domain/packs/signed-download-access-contract.js`
- Create: `tests/download-coordinator.test.mjs`
- Create: `tests/download-range-resume.test.mjs`
- Create: `tests/download-storage-preflight.test.mjs`
- Create: `tests/download-preflight-trust.test.mjs`
- Create: `tests/helpers/range-fixture-server.mjs`

**Interfaces:**

- Produces `createDownloadCoordinator({gateway,packTransfer,packRepository,manifestVerifier,keyring,activeEntitlementProjection,currentAppVersion,currentSchemaVersion,clock,chunkSize})` with `queue`, `resume`, `retry`, `cancelTemporary`; `requiredFreeBytes(...)`.

- [ ] **Step 1: Write failing download/failure-matrix tests**

Use local HTTP server to prove fixed 1 MiB chunks/resume/expiry/ETag/206/416/truncation/duplicate/final SHA/low storage/ignored Range. Pre-download trust tests let gateway authorise, then mutate signature/canonical bytes/key validity/required entitlement/pack/version/minimum app/minimum schema/archive name/hash/compressed/extracted size/file count/ceilings. Every failure must assert gateway call allowed but archive GET/`packTransfer.downloadRange` count `0`, and download job/chunk rows byte-identical/absent.

- [ ] **Step 2: Record RED**

```bash
node --test tests/download-coordinator.test.mjs tests/download-range-resume.test.mjs tests/download-storage-preflight.test.mjs tests/download-preflight-trust.test.mjs
```

Expected: FAIL because the coordinator and access contract do not exist.

- [ ] **Step 3: Implement bounded resumable behaviour**

Free-space preflight is exact:

```js
Math.ceil(
  remainingCompressedBytes +
  fullExtractedBytes +
  stagingMetadataBytes +
  (remainingCompressedBytes + fullExtractedBytes) * 0.10,
)
```

A `200` response to a non-zero Range must call the native port with `truncate:true`, clear recorded chunks and restart at zero; it must never append. Capability URL stays only in the current call stack. Archive SHA-256, not ETag, is final integrity authority.

After gateway authorise and before creating/mutating any job/chunk or invoking any archive network/native call, run Task 3 verifier with injected clock/keyring. Require canonical signature semantics/key validity; exact `b3-sandbox-proof`/`1.0.0-b3.1`; active `full-ks2`; current app `0.3.0-b3` and schema `2` meeting manifest minima; archive identity/hash/compressed/extracted sizes/file count/ceilings equal envelope and tracked object authority. Only a fully verified immutable `VerifiedDownloadAuthority` may reach capability validation/download.

`signed-download-access-contract.js` then requires HTTPS origin exactly `https://b3-gateway.eugnel.uk`, no username/password/fragment/non-default port, path exactly `/v1/packs/b3-sandbox-proof/1.0.0-b3.1/b3-sandbox-proof.zip`, query multiset exactly one `expires` and one `cap`, canonical decimal/base64url values and canonical URL reserialisation equality. Failure occurs before native/network/job mutation.

- [ ] **Step 4: Run, review and commit**

```bash
node --test tests/download-coordinator.test.mjs tests/download-range-resume.test.mjs tests/download-storage-preflight.test.mjs tests/download-preflight-trust.test.mjs tests/sqlite-pack-repositories.test.mjs
npm run lint
git diff --check
git add src/app/download-coordinator.js src/domain/packs/signed-download-access-contract.js tests/download-coordinator.test.mjs tests/download-range-resume.test.mjs tests/download-storage-preflight.test.mjs tests/download-preflight-trust.test.mjs tests/helpers/range-fixture-server.mjs
git commit -m "feat: resume authorised pack downloads"
```

Expected: all interruption/expiry/low-storage cases preserve the previous active version and durable job. Review must inspect URL non-persistence and `200` restart safety.

### Task 12: Implement the iOS native PackTransfer bridge

**Files:**

- Create: `ios/App/App/PackTransferPlugin.swift`
- Create: `ios/App/App/ZipCentralDirectoryInspector.swift`
- Create: `ios/App/App/Resources/pack-signing-public-keys.json`
- Modify: `ios/App/App/AppDelegate.swift`
- Modify: `ios/App/App.xcodeproj/project.pbxproj`
- Create: `src/platform/pack-transfer/capacitor-pack-transfer.js`
- Create: `tests/ios-pack-transfer-contract.test.mjs`
- Create: `tests/native/ios/PackInspectorHarness.swift`
- Create: `scripts/test-ios-pack-inspector.mjs`
- Create: `tests/ios-pack-inspector-hostile.test.mjs`
- Create: `tests/capacitor-pack-transfer.test.mjs`
- Modify: `tests/ios-project-contract.test.mjs`

**Interfaces:**

- Consumes: Task 7 `PackTransferPort`, Task 3 signed envelope and existing resolved ZIPFoundation `0.9.20`.
- Produces: `ZipCentralDirectoryInspector.inspect(archiveURL:manifest:)`, compiled Swift hostile-fixture harness, Capacitor plugin name `PackTransfer` and the six exact Task 7 methods on iOS.

- [ ] **Step 1: Write failing source/adapter contract tests**

Require byte-level EOCD/central/local parity and every Task4 hostile rejection. Before constructing `URLRequest`, Swift independently validates capability HTTPS/exact `https://b3-gateway.eugnel.uk`/no credentials-fragment-port/exact derived path/exact once-only canonical expires+cap/no extras and sets no-redirect delegate policy; mutation tests assert zero URLSession calls. Also require private roots, backup exclusion, CryptoKit, public keyring, atomic move and no arbitrary path. Regex is supplementary.

- [ ] **Step 2: Record RED**

```bash
node --test tests/ios-pack-transfer-contract.test.mjs tests/ios-pack-inspector-hostile.test.mjs tests/capacitor-pack-transfer.test.mjs tests/ios-project-contract.test.mjs
```

Expected: FAIL because the plugin and adapter are absent.

- [ ] **Step 3: Implement the iOS bridge**

Map owned paths only as:

```text
Library/Application Support/KS2Spelling/Packs/staging/{packId}/{version}/
Library/Application Support/KS2Spelling/Packs/installed/{packId}/{version}/
```

Validate identifiers against `^[a-z0-9][a-z0-9._-]{0,63}$`. Download to `{archiveName}.partial`, use explicit offset/truncate semantics, verify the raw signed manifest through CryptoKit against bundled public-key JSON, run the owned inspector over the exact archive bytes, then extract only the inspector-approved inventory. Keep ZIPFoundation `0.9.20` as extraction machinery only: explicitly add/import/link its SwiftPM product in the app target, compile a runtime smoke that opens one approved fixture, and prove no ZIPFoundation metadata decision bypasses the owned inspector. Create files without following links, exclude owned pack roots from backup, then return only digests/counts/logical path tokens.

- [ ] **Step 4: Compile, review and commit**

```bash
node --test tests/ios-pack-transfer-contract.test.mjs tests/ios-pack-inspector-hostile.test.mjs tests/capacitor-pack-transfer.test.mjs tests/ios-project-contract.test.mjs
node scripts/test-ios-pack-inspector.mjs
npm run native:sync:check
npm run test:ios
git diff --check
git add ios src/platform/pack-transfer/capacitor-pack-transfer.js scripts/test-ios-pack-inspector.mjs tests/ios-pack-transfer-contract.test.mjs tests/ios-pack-inspector-hostile.test.mjs tests/native/ios/PackInspectorHarness.swift tests/capacitor-pack-transfer.test.mjs tests/ios-project-contract.test.mjs
git commit -m "feat: add iOS private pack transfer"
```

Expected: unsigned Simulator compile PASS and source contract proves no public Documents path or arbitrary extraction destination. Obtain a Swift/security review.

### Task 13: Implement the Android Java PackTransfer bridge

**Files:**

- Create: `android/app/src/main/java/uk/eugnel/ks2spelling/PackTransferPlugin.java`
- Create: `android/app/src/main/java/uk/eugnel/ks2spelling/ZipCentralDirectoryInspector.java`
- Create: `android/app/src/main/assets/pack-signing-public-keys.json`
- Modify: `android/app/src/main/java/uk/eugnel/ks2spelling/MainActivity.java`
- Modify: `android/app/src/test/java/uk/eugnel/ks2spelling/PackTransferPluginTest.java`
- Create: `android/app/src/test/java/uk/eugnel/ks2spelling/ZipCentralDirectoryInspectorTest.java`
- Create: `scripts/sync-native-hostile-zips.mjs`
- Create: `tests/native-hostile-zip-sync.test.mjs`
- Create: `tests/android-pack-transfer-contract.test.mjs`
- Modify: `tests/android-project-contract.test.mjs`

**Interfaces:**

- Consumes: the same Task 7 logical contract and P-256 SPKI keyring.
- Produces: `ZipCentralDirectoryInspector.inspect(Path, ManifestInventory)`, Android JUnit over the canonical hostile bytes, and Capacitor plugin `PackTransfer` with identical result shapes using Java/JCA/platform ZIP APIs.

- [ ] **Step 1: Write failing Java/source and JVM tests**

Require owned byte-level inspector and every canonical hostile byte. Before opening `HttpURLConnection`, Java independently validates HTTPS/exact `https://b3-gateway.eugnel.uk`/no credentials-fragment-port/exact derived path/exact once-only canonical expires+cap/no extras, disables redirects and mutation tests assert zero connections. Also require private roots, Range/ETag, JCA DER, public keyring, containment/atomic move, no Kotlin and JS parity. Regex alone cannot pass.

- [ ] **Step 2: Record RED**

```bash
node --test tests/android-pack-transfer-contract.test.mjs tests/native-hostile-zip-sync.test.mjs tests/android-project-contract.test.mjs tests/capacitor-pack-transfer.test.mjs
```

Expected: FAIL because the Android implementation is absent.

- [ ] **Step 3: Implement Java-only private transfer and extraction**

Use roots:

```text
files/ks2-spelling/packs/staging/{packId}/{version}/
files/ks2-spelling/packs/installed/{packId}/{version}/
```

Run the owned inspector before `ZipFile`; use platform ZIP APIs only to extract its already-approved inventory. Reject before writing, create output with `NOFOLLOW_LINKS`, enforce actual streamed byte ceilings, fsync files/marker/directories where supported and return the same closed evidence object as iOS.

- [ ] **Step 4: Compile, review and commit**

```bash
node scripts/sync-native-hostile-zips.mjs
node --test tests/android-pack-transfer-contract.test.mjs tests/native-hostile-zip-sync.test.mjs tests/android-project-contract.test.mjs tests/capacitor-pack-transfer.test.mjs
npm run native:sync:check
npm run test:android
git diff --check
git add android/app/src/main/java/uk/eugnel/ks2spelling/PackTransferPlugin.java android/app/src/main/java/uk/eugnel/ks2spelling/ZipCentralDirectoryInspector.java android/app/src/main/java/uk/eugnel/ks2spelling/MainActivity.java android/app/src/main/assets/pack-signing-public-keys.json android/app/src/test/java/uk/eugnel/ks2spelling/PackTransferPluginTest.java android/app/src/test/java/uk/eugnel/ks2spelling/ZipCentralDirectoryInspectorTest.java android/app/src/test/resources/b3-hostile-zips scripts/sync-native-hostile-zips.mjs tests/android-pack-transfer-contract.test.mjs tests/native-hostile-zip-sync.test.mjs tests/android-project-contract.test.mjs
git commit -m "feat: add Android private pack transfer"
```

Expected: JVM/debug/unsigned-release builds PASS with no Kotlin or new permission. Obtain Java/ZIP security review against the same hostile corpus.

- [ ] **Step 5: Push the reviewed native-transfer checkpoint**

```bash
test "$(git branch --show-current)" = "jamesto/mobile-b3-billing-download"
git status --short
git push origin jamesto/mobile-b3-billing-download
```

Expected: clean reviewed Task 13 HEAD pushed without force; bypass only under the documented exact-HEAD full-test rule.

### Task 14: Add crash-safe activation and startup reconciliation

**Files:**

- Create: `src/app/pack-activation-coordinator.js`
- Create: `src/app/pack-reconciler.js`
- Create: `tests/pack-activation-coordinator.test.mjs`
- Create: `tests/pack-activation-crash-matrix.test.mjs`
- Create: `tests/pack-reconciler.test.mjs`

**Interfaces:**

- Produces `activate({packId,version,signedManifestEnvelope})`, `reconcileAtStartup()` and `retireOldVersions({packId,keepVersions:2})`.

- [ ] **Step 1: Write failing activation/reconciliation matrix**

Crash before/after manifest verification, extraction, marker, rename, installed registration and active-pointer flip. Cover orphan staging, orphan installed version, missing/corrupt active marker, DB pointer to missing path, rollback to previous verified version and revocation access lock with retained files/history.

- [ ] **Step 2: Record RED**

```bash
node --test tests/pack-activation-coordinator.test.mjs tests/pack-activation-crash-matrix.test.mjs tests/pack-reconciler.test.mjs
```

Expected: FAIL because activation/reconciliation services are absent.

- [ ] **Step 3: Implement exact two-phase switch**

Only `sealAndInstall` may perform atomic rename. Then one SQLite transaction calls `registerInstalledVersion` and `flipActiveVersion`. Startup inventories native paths, requires marker manifest digest equality, keeps the previous verified active version on all ambiguity, and removes only owned incomplete staging after recording failure.

- [ ] **Step 4: Run, review and commit**

```bash
node --test tests/pack-activation-coordinator.test.mjs tests/pack-activation-crash-matrix.test.mjs tests/pack-reconciler.test.mjs tests/b3-learner-preservation.test.mjs
npm run lint
git diff --check
git add src/app/pack-activation-coordinator.js src/app/pack-reconciler.js tests/pack-activation-coordinator.test.mjs tests/pack-activation-crash-matrix.test.mjs tests/pack-reconciler.test.mjs
git commit -m "feat: activate signed packs atomically"
```

Expected: every injected crash leaves a verified old version active or a safely recoverable no-pack state; learner digests remain unchanged. Obtain filesystem/database ordering review.

### Task 15: Implement the app-owned StoreKit 2 bridge

**Files:**

- Create: `ios/App/App/CommercePlugin.swift`
- Create: `ios/App/App/B3Sandbox.storekit`
- Create: `ios/App/AppTests/B3StoreKitDelayedTests.swift`
- Modify: `ios/App/App/AppDelegate.swift`
- Modify: `ios/App/App.xcodeproj/project.pbxproj`
- Create: `tests/ios-storekit-bridge-contract.test.mjs`
- Create: `tests/fixtures/storekit-bridge-transcript.json`
- Create: `scripts/prove-b3-ios-storekit-test.mjs`
- Create: `tests/b3-ios-storekit-test-wrapper.test.mjs`
- Modify: `tests/ios-project-contract.test.mjs`

**Interfaces:**

- Consumes: Task 7 `StorePort` contract.
- Produces: Capacitor plugin `Commerce` with `queryProducts`, `purchase`, `queryTransactions`, `restore`, `finishTransaction` and event `transactionUpdated`; plus `npm run prove:b3:ios-storekit-test` for explicitly non-live delayed approve/decline evidence.

- [ ] **Step 1: Write failing StoreKit source/transcript tests**

Require launch updates/unfinished/currentEntitlements/products/verified JWS/pending/cancel/unverified/revoke/no legacy receipt/no early finish. Visible user-invoked `restore()` must call `try await AppStore.sync()` exactly once, then iterate verified `currentEntitlements`; cancel/auth failure is safe. Launch/resume/queryTransactions/current-entitlement refresh must never call sync or trigger store authentication UI. Transcript/source tests distinguish explicit restore from proactive query. Separate SKTestSession approve/decline remains non-live.

- [ ] **Step 2: Record RED**

```bash
node --test tests/ios-storekit-bridge-contract.test.mjs tests/b3-ios-storekit-test-wrapper.test.mjs tests/ios-project-contract.test.mjs
```

Expected: FAIL because `CommercePlugin.swift` is absent.

- [ ] **Step 3: Implement exact StoreKit 2 normalisation**

Normalised transaction output is closed:

```js
{
  store: 'apple',
  environment: 'sandbox',
  productId: 'uk.eugnel.ks2spelling.fullks2',
  outcome: 'purchased' | 'pending' | 'cancelled' | 'revoked' | 'unverified',
  transactionRef: 'opaque-native-reference-string',
  opaqueProof: 'verified-StoreKit-2-jwsRepresentation-string'
}
```

`opaqueProof` exists only for verified purchased/revoked observations. Keep a native in-memory map from `transactionRef` to verified `Transaction`; `finishTransaction` resolves that map or re-queries unfinished transactions, verifies again, then finishes. Do not create an account token.

- [ ] **Step 4: Compile, review and commit**

```bash
node --test tests/ios-storekit-bridge-contract.test.mjs tests/b3-ios-storekit-test-wrapper.test.mjs tests/ios-project-contract.test.mjs tests/b3-port-contracts.test.mjs
npm run prove:b3:ios-storekit-test
npm run native:sync:check
npm run test:ios
git diff --check
git add package.json ios/App/App/CommercePlugin.swift ios/App/App/B3Sandbox.storekit ios/App/AppTests/B3StoreKitDelayedTests.swift ios/App/App/AppDelegate.swift ios/App/App.xcodeproj/project.pbxproj scripts/prove-b3-ios-storekit-test.mjs tests/ios-storekit-bridge-contract.test.mjs tests/b3-ios-storekit-test-wrapper.test.mjs tests/fixtures/storekit-bridge-transcript.json tests/ios-project-contract.test.mjs
git commit -m "feat: bridge StoreKit 2 purchases"
```

Expected: unsigned Simulator compile and non-live Xcode StoreKit Test delayed approve+decline PASS with zero new package dependency. Review must prove verified-only JWS, durable-JS-controlled finish and that non-live evidence is impossible to mislabel as physical sandbox.

### Task 16: Implement the app-owned Android BillingClient 9.1.0 Java bridge

**Files:**

- Modify: `android/app/build.gradle`
- Modify: `android/gradle/dependency-locks/app.lockfile`
- Modify: `android/gradle/verification-metadata.xml`
- Create: `android/app/src/main/java/uk/eugnel/ks2spelling/CommercePlugin.java`
- Modify: `android/app/src/main/java/uk/eugnel/ks2spelling/MainActivity.java`
- Create: `android/app/src/test/java/uk/eugnel/ks2spelling/CommercePluginTest.java`
- Create: `tests/android-billing-bridge-contract.test.mjs`
- Modify: `tests/android-project-contract.test.mjs`

**Interfaces:**

- Consumes: Task 7 `StorePort` contract and Task 9 server-side acknowledgement.
- Produces: Capacitor plugin `Commerce` with JS parity and exact Maven dependency `com.android.billingclient:billing:9.1.0`.

- [ ] **Step 1: Write failing dependency/source/JVM tests**

Require exact base `billing` Java artifact and reject `billing-ktx`, ranges, Kotlin plugins/runtime, client acknowledgement, cached `ProductDetails`, parameterless pending purchase enablement and missing resume query. Require `enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())`, `enableAutoServiceReconnection()`, `PurchasesUpdatedListener`, `queryPurchasesAsync()` on connected and resume, and `PENDING`/`PURCHASED` mapping.

- [ ] **Step 2: Record RED**

```bash
node --test tests/android-billing-bridge-contract.test.mjs tests/android-project-contract.test.mjs
```

Expected: FAIL because BillingClient and the bridge are absent.

- [ ] **Step 3: Implement and lock the official Java dependency**

The bridge emits purchase token only as `opaqueProof`, never sets `obfuscatedAccountId`, never acknowledges locally and reports `isAcknowledged` for coordinator confirmation. `finishTransaction` re-queries the token and succeeds only when server acknowledgement is visible; otherwise it returns `STORE_COMPLETION_PENDING` for retry.

- [ ] **Step 4: Resolve, compile, audit, review and commit**

```bash
npm run native:sync:check
npm run test:android
npm run certify:android
npm run test:android-resolved-policy
node --test tests/android-billing-bridge-contract.test.mjs tests/android-project-contract.test.mjs tests/b3-port-contracts.test.mjs
git diff --check
git add android/app/build.gradle android/app/src/main/java/uk/eugnel/ks2spelling/CommercePlugin.java android/app/src/main/java/uk/eugnel/ks2spelling/MainActivity.java android/app/src/test/java/uk/eugnel/ks2spelling/CommercePluginTest.java android/gradle/dependency-locks/app.lockfile android/gradle/verification-metadata.xml tests/android-billing-bridge-contract.test.mjs tests/android-project-contract.test.mjs
git commit -m "feat: bridge Play Billing purchases"
```

Expected: unit/debug/unsigned-release builds and exact resolved-policy checks PASS. Review must confirm no Kotlin and that unacknowledged purchase retry is release-blocking.

### Task 17: Compose the diagnostic Parent commerce and pack proof shell

**Files:**

- Create: `src/app/create-b3-app-services.js`
- Create: `src/app/b3-proof-controller.js`
- Modify: `src/app/create-app-services.js`
- Modify: `src/app/App.jsx`
- Modify: `src/app/app.css`
- Create: `tests/b3-proof-controller.test.mjs`
- Create: `tests/b3-live-composition.test.mjs`
- Modify: `tests/app-shell.test.mjs`

**Interfaces:**

- Produces: `createB3AppServices(...)` and proof states `ready|purchasing|cancelled|pending|entitled|downloading|installed|restored|revoked|failed` for machine-readable evidence.

- [ ] **Step 1: Write failing shell/controller tests**

Require visible heading `B3 sandbox proof`, Parent-only diagnostic label, localised price, Buy/Restore/Redownload controls, calm cancellation/pending/offline copy, manifest/archive/install digests and zero child sales copy. Deterministic tests use only fakes; a native B3SandboxProof build must deterministically select concrete `createCapacitorStore` + `createHttpEntitlementGateway` from tracked authority, never a runtime/UI toggle. Browser/test builds select fakes. Physical-proof mode rejects fake transcripts and proves real HTTPS request/Worker identity. Parent output may show expected synthetic learner digests but no IDs/nicknames/Monster/Camp analytics.

- [ ] **Step 2: Record RED**

```bash
node --test tests/b3-proof-controller.test.mjs tests/b3-live-composition.test.mjs tests/app-shell.test.mjs
```

Expected: FAIL because the B2 controller cannot drive commerce/download states.

- [ ] **Step 3: Implement diagnostic-only composition**

Startup order is database migration -> pack reconciliation -> build-authority mode selection -> concrete/fake adapter composition -> transaction subscription/replay -> sealed-handle refresh -> readiness. `B3SandboxProof` native authority requires live adapters and exact origin; failure to construct them is fatal to proof mode, never fake fallback. Timeout/5xx/offline shows calm retry copy while keeping last active pack ready. UI actions call controller only and accept no product/endpoint/R2 path from DOM. Render no raw proof/token/handle/URL/account data.

- [ ] **Step 4: Run, review and commit**

```bash
node --test tests/b3-proof-controller.test.mjs tests/b3-live-composition.test.mjs tests/app-shell.test.mjs tests/purchase-coordinator.test.mjs tests/download-coordinator.test.mjs tests/pack-reconciler.test.mjs
npm run lint
npm run build
git diff --check
git add src/app tests/b3-proof-controller.test.mjs tests/b3-live-composition.test.mjs tests/app-shell.test.mjs
git commit -m "feat: compose B3 Parent proof shell"
```

Expected: deterministic fake end-to-end state sequence PASS. Product review must confirm diagnostic Parent scope and no Monster tracking/commercial child surface.

### Task 18: Certify B3 native dependencies, privacy and deterministic integration

**Files:**

- Create: `scripts/build-b3-native-audit.mjs`
- Create: `scripts/run-b3-deterministic-proof.mjs`
- Create: `tests/b3-native-audit.test.mjs`
- Create: `tests/b3-deterministic-proof.test.mjs`
- Create: `reports/b3/native-build.json`
- Create: `reports/b3/dependency-audit.json`
- Create: `reports/b3/deterministic-proof.json`
- Modify: `config/dependency-policy.json`
- Modify: `config/maven-licence-policy.json`
- Modify: `config/third-party-notices-overrides.json`
- Modify: `docs/compliance/sdk-privacy-register.md`
- Modify: `THIRD_PARTY_NOTICES.md`
- Modify: `package.json`

**Interfaces:**

- Produces `npm run report:b3-native`, `npm run prove:b3:deterministic` and reports binding exact npm/SPM/Maven/plugin/privacy outputs.

- [ ] **Step 1: Write failing audit and deterministic proof tests**

Require exact BillingClient `9.1.0`, no Kotlin/RevenueCat/private registry, StoreKit system-only, concrete Capacitor/HTTP adapter source hashes, tracked gateway/object/synthetic authority hashes, PackTransfer/owned inspector hashes, compiled Swift/Android identical hostile set including structural-overlap/EOCD cases, ZIPFoundation seam, no permission/usage/entitlement, `server.url === null`, no arbitrary filesystem API/executable member, full envelope, exact public-nonsecret fixture/SPKI/signature hashes, no signing fixture packaged, non-live StoreKit labels, sealed-handle/safe-store-ID/offline continuity matrix and full fake commerce/download/activation matrix with exact synthetic digests.

- [ ] **Step 2: Record RED**

```bash
node --test tests/b3-native-audit.test.mjs tests/b3-deterministic-proof.test.mjs
```

Expected: FAIL because the reports/builders do not exist.

- [ ] **Step 3: Build strict reports from fresh inputs**

The deterministic report contains no fresh random value: fixed-clock transitions, ordered scenarios, `traceIdValid:true`, `traceIdsUnique:true`, digests and booleans only (or fixed clearly test-only UUIDv4 fixtures never reused live). Run the whole proof twice from clean state and require byte-identical report SHA. Include exact non-live StoreKit block; no raw trace/proof/token/handle/capability/private fixture/email/nickname.

- [ ] **Step 4: Run native gates, review and commit**

```bash
npm ci
npm --prefix gateway ci
npm --prefix gateway run deploy:dry-run
npm run verify:b2-authority
npm run verify:vendor
npm run test:upstream:a3
npm test
npm run lint
npm run build
npm run native:sync:check
npm run test:ios
node scripts/test-ios-pack-inspector.mjs
npm run prove:b3:ios-storekit-test
npm run test:android
npm run certify:android
npm run test:android-resolved-policy
npm run report:b3-native
npm run prove:b3:deterministic
npm run audit:dependencies -- --write
npm run generate:notices
git diff --check
git add package.json package-lock.json config docs/compliance/sdk-privacy-register.md THIRD_PARTY_NOTICES.md scripts/build-b3-native-audit.mjs scripts/run-b3-deterministic-proof.mjs tests/b3-native-audit.test.mjs tests/b3-deterministic-proof.test.mjs reports/b3/native-build.json reports/b3/dependency-audit.json reports/b3/deterministic-proof.json android/gradle
git commit -m "test: certify B3 deterministic integration"
```

Expected: all deterministic/native/dependency gates PASS. Broad audit review must distinguish compiled capability from live store/cloud proof.

- [ ] **Step 5: Push the reviewed deterministic checkpoint**

```bash
test "$(git branch --show-current)" = "jamesto/mobile-b3-billing-download"
git status --short
git push origin jamesto/mobile-b3-billing-download
```

Expected: clean reviewed Task 18 HEAD pushed without force; bypass only when exact-HEAD full relevant tests are documented.

### Task 19: Define redacted live-sandbox evidence, physical-device ownership and Cloudflare deployment tooling

**Files:**

- Create: `scripts/lib/b3-evidence.mjs`
- Create: `scripts/lib/b3-cloudflare-evidence.mjs`
- Create: `scripts/fingerprint-b3-application.mjs`
- Create: `scripts/deploy-b3-sandbox-gateway.mjs`
- Create: `scripts/prove-b3-cloudflare.mjs`
- Create: `scripts/prove-b3-ios.mjs`
- Create: `scripts/prove-b3-android.mjs`
- Create: `scripts/prepare-b3-distribution.mjs`
- Create: `scripts/verify-b3-installed-distribution.mjs`
- Create: `src/platform/distribution/capacitor-build-authority.js`
- Create: `ios/App/App/BuildAuthorityPlugin.swift`
- Create: `ios/b3-distribution-loader.xcconfig`
- Create: `android/app/src/main/java/uk/eugnel/ks2spelling/BuildAuthorityPlugin.java`
- Modify: `ios/App/App/AppDelegate.swift`
- Modify: `ios/App/App.xcodeproj/project.pbxproj`
- Modify: `ios/App/App.xcodeproj/xcshareddata/xcschemes/KS2Spelling.xcscheme`
- Modify: `android/app/build.gradle`
- Modify: `android/app/src/main/java/uk/eugnel/ks2spelling/MainActivity.java`
- Create: `tests/b3-evidence-contract.test.mjs`
- Create: `tests/b3-application-fingerprint.test.mjs`
- Create: `tests/b3-cloudflare-wrapper-contract.test.mjs`
- Create: `tests/b3-ios-wrapper-contract.test.mjs`
- Create: `tests/b3-android-wrapper-contract.test.mjs`
- Create: `tests/b3-distribution-authority.test.mjs`
- Modify: `package.json`

**Interfaces:**

- Produces `npm run deploy:b3:sandbox`, `prove:b3:cloudflare`, `prove:b3:ios`, `prove:b3:android`, `prepare:b3:distribution`, `verify:b3:installed-distribution`; strict pending evidence in `.native-build/b3/evidence`; final committed reports only after screenshot-SHA attestation.

- [ ] **Step 1: Write failing fingerprint/evidence/wrapper tests**

The B3 fingerprint includes every application, gateway, config, native, manifest-builder, dependency-lock and proof-wrapper input; excludes `.git`, `node_modules`, `.native-build`, reports/screenshots and secrets. Evidence-contract, platform-wrapper and exit-builder mutation tests reject unknown keys, raw proof/token/handle/capability/private data, stale authority, wrong device/distribution/scenarios, and certificate drift: iOS requires only correct independently sourced `codeSigningCertificateSha256`, Android only correct independently sourced `playAppSigningCertificateSha256`; missing, wrong, cross-platform or generic `signingCertificateSha256` fields fail.

- [ ] **Step 2: Record RED**

```bash
node --test tests/b3-evidence-contract.test.mjs tests/b3-application-fingerprint.test.mjs tests/b3-cloudflare-wrapper-contract.test.mjs tests/b3-ios-wrapper-contract.test.mjs tests/b3-android-wrapper-contract.test.mjs tests/b3-distribution-authority.test.mjs
```

Expected: FAIL because no B3 live evidence tooling exists.

- [ ] **Step 3: Implement closed redacted evidence shapes**

Cloudflare evidence is closed:

```ts
interface B3CloudflareEvidence {
  schemaVersion: 1;
  testedApplicationCommit: string;
  applicationFingerprint: string;
  worker: {
    accountId: string; // exact tracked 32-hex approved ID
    name: 'ks2-spelling-b3-sandbox';
    publicSandboxOrigin: 'https://b3-gateway.eugnel.uk';
    deploymentVersionId: string;
    scriptAuthoritySha256: string;
    compatibilityDate: '2026-07-12';
    compatibilityFlags: ['nodejs_compat'];
    bindings: { r2: 'PACKS'; rateLimit: 'GATEWAY_RATE_LIMIT'; versionMetadata: 'WORKER_VERSION_METADATA' };
    requiredSecretNames: [
      'APPLE_IAP_ISSUER_ID', 'APPLE_IAP_KEY_ID', 'APPLE_IAP_PRIVATE_KEY',
      'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON', 'ENTITLEMENT_HANDLE_KEY_CURRENT',
      'ENTITLEMENT_HANDLE_KEY_PREVIOUS', 'R2_CAPABILITY_HMAC_KEY'
    ];
    remoteSecretNamesVerified: true;
  };
  bucket: {
    approvedIdentifier: 'ks2-spelling-b3-sandbox-packs';
    private: true;
    r2DevPublicAccess: false;
    customDomains: [];
  };
  signedEnvelopeSha256: string; // exactly equals the signed-manifest object SHA-256
  objects: [
    { role: 'signed-manifest'; key: 'b3/b3-sandbox-proof/1.0.0-b3.1/signed-manifest.json'; sha256: string; size: number; etag: string; customMetadata: { 'b3-role': 'signed-manifest'; 'b3-sha256': string; 'b3-size': string; 'b3-envelope-sha256': string } },
    { role: 'archive'; key: 'b3/b3-sandbox-proof/1.0.0-b3.1/b3-sandbox-proof.zip'; sha256: string; size: number; etag: string; customMetadata: { 'b3-role': 'archive'; 'b3-sha256': string; 'b3-size': string } }
  ];
  capability: { ttlSeconds: 600; valid: true; tamperedRejected: true; expiredRejected: true; canonicalEncodingRequired: true };
  range: { full200: true; partial206: true; conditional304: true; unsatisfied416: true; noRedirects: true; cacheControl: 'private, no-store' };
  rateLimit: { everyPublicPostGetCovered: true; limitedStatus: 429; limitedBodyReads: 0; limitedUpstreamCalls: 0; missingBindingFailedClosed: true };
}
```

The exact two-object order is immutable. `scriptAuthoritySha256`, full signed-envelope SHA, object SHA/size/ETag and deployment version are copied into each platform report's `gateway` block and must equal the Cloudflare report and actual safe gateway response. Platform reports contain only safe response metadata; no handle/capability/query value.

Each platform report contains only:

```ts
interface B3PlatformEvidence {
  schemaVersion: 1;
  testedApplicationCommit: string; // exactly 40 lowercase hexadecimal characters
  applicationFingerprint: string; // exactly 64 lowercase hexadecimal characters
  platform: 'ios-physical' | 'android-play-physical';
  device: { model: string; osVersion: string; physical: true; playCertified?: true };
  store: {
    environment: 'sandbox' | 'play-test';
    productId: 'uk.eugnel.ks2spelling.fullks2' | 'full_ks2';
    localisedPriceObserved: true;
  };
  transitions: Array<{
    scenario: B3AllowedScenario;
    startedAt: string; // ISO 8601 UTC
    completedAt: string; // ISO 8601 UTC
    outcome: B3AllowedOutcome;
    gatewayTraces: Array<{ operation: 'verify' | 'refresh' | 'authorise' | 'complete'; traceId: string; relation: 'transaction-verification' | 'completion-of-prior-verify' | 'authorisation-from-active-handle' | 'refresh-of-active-handle' }>;
  }>;
  storeCompletion: { finished: true } | { acknowledged: true };
  storeKitTest?: {
    reportSha256: string;
    scenarios: ['storekit-test-pending-approve', 'storekit-test-pending-decline'];
    liveSandbox: false;
  };
  distribution: {
    embeddedCommit: string;
    embeddedFingerprint: string;
    versionName: '0.3.0-b3';
  } & (
    { kind: 'development'; iosBuildNumber: string; signedIpaSha256: string; ipaEmbeddedAuthoritySha256: string; codeSigningCertificateSha256: string; installedBundleId: 'uk.eugnel.ks2spelling'; installedVersion: '0.3.0-b3'; installedBuild: string; installedEmbeddedAuthoritySha256: string; developmentIdentityVerified: true; sandboxReceiptVerified: true } |
    { kind: 'play-internal'; androidVersionCode: number; signedAabSha256: string; aabEmbeddedAuthoritySha256: string; playAppSigningCertificateSha256: string; installer: 'com.android.vending'; installedEmbeddedAuthoritySha256: string; pmPathOrderVerified: true; installedApks: Array<{ order: number; kind: 'base' | 'split'; splitName: string; sha256: string }> }
  );
  gateway: {
    accountId: string;
    workerName: 'ks2-spelling-b3-sandbox';
    publicSandboxOrigin: 'https://b3-gateway.eugnel.uk';
    deploymentVersionId: string;
    scriptAuthoritySha256: string;
    signedEnvelopeSha256: string;
    manifestObject: { key: 'b3/b3-sandbox-proof/1.0.0-b3.1/signed-manifest.json'; sha256: string; size: number; etag: string; metadataMatched: true };
    archiveObject: { key: 'b3/b3-sandbox-proof/1.0.0-b3.1/b3-sandbox-proof.zip'; sha256: string; size: number; etag: string; metadataMatched: true };
  };
  transport: { concreteCapacitorStore: true; concreteHttpGateway: true; serverUrl: null; nativeOriginAllowed: true; noRedirects: true };
  storeTransactionAuthority: { source: 'apple-transaction-id' | 'google-order-id'; crossCheckedOnRefresh: true; rawValueCommitted: false };
  refreshHandleLifecycle: { positiveVersionObserved: true; rawProofCleared: true; restoredFreshHandle: true; revokedHandleDeleted: true; rawHandleCommitted: false };
  entitlement: { id: 'full-ks2'; finalState: 'revoked'; digest: string; refreshHandlePresent: false };
  pack: {
    packId: 'b3-sandbox-proof';
    manifestSha256: string;
    archiveSha256: string;
    installed: true;
    redownloaded: true;
  };
  syntheticLearnerAuthoritySha256: string;
  learnerPreservation: [
    {
      scenario: 'purchase-install';
      baseline: 'before-purchase';
      learnerAInitialSha256: string;
      learnerAFinalSha256: string;
      learnerBInitialSha256: string;
      learnerBFinalSha256: string;
    },
    {
      scenario: 'refund-revoke-after-fresh-install-reseed';
      baseline: 'after-fresh-install-reseed';
      learnerAInitialSha256: string;
      learnerAFinalSha256: string;
      learnerBInitialSha256: string;
      learnerBFinalSha256: string;
    }
  ];
  restore: {
    freshInstall: true;
    entitlementRebuilt: true;
    packRedownloaded: true;
    learnerBackupRestoreClaimed: false;
    baselineCreatedAfterFreshInstall: true;
  };
  screenshotSha256: string;
  manualVisualInspection: 'passed';
}
```

Exact iOS ordered scenario/outcome/traces are: `product-query/products-visible/[]`; `cancel/cancelled/[]`; `ask-to-buy-pending/pending-no-access/[]`; `normal-purchase/verified-active/[verify:transaction-verification]`; `unfinished-relaunch/finished-recovered/[complete:completion-of-prior-verify]`; `pack-install/installed/[authorise:authorisation-from-active-handle]`; `restore-after-reinstall/restored-active/[verify:transaction-verification]`; `redownload/redownloaded/[authorise:authorisation-from-active-handle]`; `refund-revoke/revoked-locked/[refresh:refresh-of-active-handle]`. StoreKit non-live block remains exact.

Exact Android ordered scenario/outcome/traces are: `product-query/products-visible/[]`; `cancel/cancelled/[]`; `slow-card-pending-decline/declined-no-access/[]`; `slow-card-pending-approve/pending-approved-no-access/[]`; `unacknowledged-relaunch/acknowledged-recovered/[verify:transaction-verification, complete:completion-of-prior-verify]`; `pack-install/installed/[authorise:authorisation-from-active-handle]`; `restore-after-reinstall/restored-active/[verify:transaction-verification]`; `redownload/redownloaded/[authorise:authorisation-from-active-handle]`; `refund-revoke/revoked-locked/[refresh:refresh-of-active-handle]`. Every listed trace is fresh UUIDv4 and unique report-wide; exact order/multiplicity/relation required. iOS completion is only `{finished:true}`, Android only `{acknowledged:true}`.

iOS requires the exact `storeKitTest` block above; Android forbids it. Both platforms require terminal revoked/handle absent, exactly two learner-preservation records in the shown order, each learner initial digest equal final digest and every digest equal the tracked synthetic authority for that baseline. Live wrappers inspect profile IDs/nicknames before first purchase and after reseed, reject any non-authority row, then omit all IDs/nicknames from reports.

- [ ] **Step 4: Implement explicit remote/device ownership gates**

`deploy:b3:sandbox` requires tracked gateway/object authorities to equal durable approved account/worker/origin/bucket identifiers, scope `cloudflare-deploy` and run token. Existing OAuth reads bindings/secret names/public state only. The script runs deterministic Wrangler dry-run with a fixed 64-zero placeholder, hashes normalised bundled script bytes, replaces only that equal-length placeholder with the SHA build constant, deploys those bytes, and retrieves exact Cloudflare version ID through API. Response must return `WORKER_VERSION_METADATA.id` plus same build constant; any response/API/report mismatch fails. It uploads both authority objects no-overwrite-identical-only and records closed schema. iOS/Android wrappers require scoped approvals/run token, never mutate consoles, require physical signed distributions. Slow-card polling is five seconds/max ten minutes; unack hold exactly five seconds with automatic stop/release.

`prepare:b3:distribution` writes clean-HEAD/fingerprint authority + xcconfig only. `B3SandboxProof` embeds exact values. Android flavour builds internal AAB. Verifier requires iOS mode exactly `development`, operator-provided signed IPA SHA, independently extracted IPA embedded authority values/SHA, code-signing certificate SHA, installed bundle/version/build/embedded-authority equality and explicit development identity plus sandbox receipt. Android requires signed AAB SHA, independently extracted authority/versionCode, approved Play App Signing certificate, installer, and `pm path` pull/hash of ordered base then lexically ordered splits with installed embedded equality. No agent signing/keychain/provisioning.

- [ ] **Step 5: Run, review and commit proof tooling**

```bash
node --test tests/b3-evidence-contract.test.mjs tests/b3-application-fingerprint.test.mjs tests/b3-cloudflare-wrapper-contract.test.mjs tests/b3-ios-wrapper-contract.test.mjs tests/b3-android-wrapper-contract.test.mjs tests/b3-distribution-authority.test.mjs
npm run lint
git diff --check
git add package.json scripts/lib/b3-evidence.mjs scripts/lib/b3-cloudflare-evidence.mjs scripts/fingerprint-b3-application.mjs scripts/deploy-b3-sandbox-gateway.mjs scripts/prove-b3-cloudflare.mjs scripts/prove-b3-ios.mjs scripts/prove-b3-android.mjs scripts/prepare-b3-distribution.mjs scripts/verify-b3-installed-distribution.mjs src/platform/distribution ios/b3-distribution-loader.xcconfig ios/App/App/BuildAuthorityPlugin.swift ios/App/App/AppDelegate.swift ios/App/App.xcodeproj/project.pbxproj ios/App/App.xcodeproj/xcshareddata/xcschemes/KS2Spelling.xcscheme android/app/build.gradle android/app/src/main/java/uk/eugnel/ks2spelling/BuildAuthorityPlugin.java android/app/src/main/java/uk/eugnel/ks2spelling/MainActivity.java tests/b3-evidence-contract.test.mjs tests/b3-application-fingerprint.test.mjs tests/b3-cloudflare-wrapper-contract.test.mjs tests/b3-ios-wrapper-contract.test.mjs tests/b3-android-wrapper-contract.test.mjs tests/b3-distribution-authority.test.mjs
git commit -m "test: define B3 live sandbox proof"
```

Expected: tooling contract PASS without touching cloud/accounts/devices. Security review must verify no secret prompt, secret output or unauthorised remote mutation path.

### Task 20: Add the exit builder, branch CI and final B3 application checkpoint

**Files:**

- Create: `scripts/build-b3-exit-report.mjs`
- Create: `tests/b3-exit-report-builder.test.mjs`
- Create: `tests/b3-exit-report.live.mjs`
- Create: `tests/b3-live-evidence-history.test.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `tests/ci-workflow-contract.test.mjs`
- Create: `docs/architecture/b3-commerce-pack-authority.md`
- Modify: `docs/operations/native-development.md`
- Modify: `docs/compliance/sdk-privacy-register.md`
- Modify: `README.md`
- Modify: `package.json`

**Interfaces:**

- Produces strict `npm run verify:b3`, a clean `testedApplicationCommit`, B3 CI on `jamesto/mobile-b3-billing-download`, and a live report checker deliberately outside the default test glob until evidence exists.

- [ ] **Step 1: Write failing exit-builder and CI tests**

The builder must bind frozen B2 authority; exact application commit/fingerprint; tracked gateway/object/synthetic authorities; concrete-adapter/live-origin proof; deterministic audits; Worker/Cloud objects; signed distribution; platform reports/screenshots; product/safe store IDs; envelope/scenarios/offline continuity. Certificate mutations require iOS `codeSigningCertificateSha256` only and Android `playAppSigningCertificateSha256` only; missing/wrong/cross-platform/generic fields fail. It rejects dirty/stale/private/executable/production claims. Live topology is exact six; history tests cover never-present, prior one/five/complete, partial and complete.

- [ ] **Step 2: Record RED**

```bash
node --test tests/b3-exit-report-builder.test.mjs tests/b3-live-evidence-history.test.mjs tests/ci-workflow-contract.test.mjs tests/b3-application-fingerprint.test.mjs
```

Expected: FAIL because the B3 exit builder/CI contract are absent.

- [ ] **Step 3: Implement the builder and exact branch CI**

`build-b3-exit-report.mjs --write` validates live inputs atomically. `--check-ci` has two legal modes. **Pending:** all six absent, deterministic green, and separate full-history queries for each exact path prove none ever appeared in any ancestor/ref. **Complete:** all six exist and strict regeneration matches. Current one-to-five partial fails. If ancestry ever contained any one of six, later zero/partial fails permanently—even if exit JSON itself never existed. Mutation tests cover deleted one, deleted five and deleted complete sets. CI uses full history on every job; Task 23 requires complete.

CI retains three jobs and Node `24.18.0`; Domain/Web runs real workerd/gateway, sealed-handle and deterministic B3 suites, iOS compiles StoreKit/owned inspector/PackTransfer and runs the Swift hostile harness plus non-live StoreKit Test, Android runs Java inspector JUnit and compiles debug/unsigned release with BillingClient `9.1.0`.

Add package command `verify:b3` as the complete deterministic/native audit chain ending in `node scripts/build-b3-exit-report.mjs --check-ci`; it prints exactly one mode record, `pending` or `complete`, and returns non-zero for every partial/history-invalid topology.

- [ ] **Step 4: Document exact proof and deferrals**

The architecture document must state that B3 proves only `b3-sandbox-proof` through real sandbox/test purchases and test Cloudflare resources. It explicitly denies production Full content/audio, production keys/bucket/Worker, public pricing, store approval, production Parent/child UI, release compliance, family sharing, broad physical-device quality, accessibility/performance and visual/theme/assets completion. It records that B4 owns the broad matrix and that Visual / Theme / Asset Migration remains after Gate B `GO` and before C3.

- [ ] **Step 5: Run the final application checkpoint and commit**

```bash
npm ci
npm --prefix gateway ci
npm --prefix gateway run deploy:dry-run
npm run verify:b2-authority
npm run verify:vendor
npm run test:upstream:a3
npm test
npm run lint
npm run build
npm run native:sync:check
npm run test:ios
node scripts/test-ios-pack-inspector.mjs
npm run prove:b3:ios-storekit-test
npm run test:android
npm run certify:android
npm run test:android-resolved-policy
npm run report:b3-native
npm run prove:b3:deterministic
npm run audit:dependencies -- --write
actionlint .github/workflows/ci.yml
node --test tests/b3-live-evidence-history.test.mjs
git diff --check
git add .github package.json package-lock.json gateway/package-lock.json docs scripts src tests config android ios README.md THIRD_PARTY_NOTICES.md reports/b3/b3-proof-pack-build.json reports/b3/native-build.json reports/b3/dependency-audit.json reports/b3/deterministic-proof.json
git commit -m "test: prepare final B3 application checkpoint"
git status --short
git push -u origin jamesto/mobile-b3-billing-download
```

Expected: clean tree and exact-head branch CI green for all three jobs in legitimate pending mode. This commit becomes `testedApplicationCommit`; Task 21 may create only untracked `.native-build` distribution authority, Task 22 may commit only the six live evidence files, and Task 23 changes no files. Any application/gateway/native/verifier change requires a new Task 20 checkpoint, new signed distribution and complete live recapture.

### Task 21: Produce and verify signed distribution authority for the clean checkpoint

**Files:** No tracked files. Outputs stay under `.native-build/b3/distribution/` and are consumed into Task 22 platform reports.

**Interfaces:**

- Consumes: Task 20 clean commit/fingerprint, durable Apple/Google distribution approvals, visible operator-built/signed artefacts and installed apps.
- Produces: `.native-build/b3/distribution/build-authority.json`, `ios-installed-authority.json` and `android-installed-authority.json`; no seventh committed live evidence file.

- [ ] **Step 1: Generate deterministic build authority from clean HEAD**

```bash
git status --short
B3_REMOTE_RUN_TOKEN="$B3_REMOTE_RUN_TOKEN" npm run prepare:b3:distribution
```

Expected: clean tree; metadata binds exact Task 20 commit/fingerprint, `versionName: "0.3.0-b3"`, approved positive iOS build number and Android versionCode. It contains no future/evidence commit SHA, key/certificate bytes or secret.

- [ ] **Step 2: Pause for visible signed distribution actions**

The wrapper exits `7` for visible operator action. Operator uses Xcode Archive scheme `KS2Spelling`/`B3SandboxProof`, exports a development-signed IPA and installs it physically. Android uploads exact signed `bundleB3SandboxProofRelease` AAB to Play internal testing. Agent does not sign/upload/access keychain or console.

```bash
B3_REMOTE_MUTATION_SCOPE=apple-signed-distribution B3_REMOTE_RUN_TOKEN="$B3_REMOTE_RUN_TOKEN" npm run prepare:b3:distribution -- --request-operator-action ios
B3_REMOTE_MUTATION_SCOPE=google-test-track-refund-revoke B3_REMOTE_RUN_TOKEN="$B3_REMOTE_RUN_TOKEN" npm run prepare:b3:distribution -- --request-operator-action android
```

Expected: each command exits `7` only after validating its durable identifiers/run token and writing a redacted visible instruction; it performs no remote mutation.

- [ ] **Step 3: Verify installed signed builds against authority**

```bash
npm run verify:b3:installed-distribution -- --platform ios --signed-ipa "$B3_IOS_SIGNED_IPA"
npm run verify:b3:installed-distribution -- --platform android --signed-aab "$B3_ANDROID_SIGNED_AAB"
```

Expected: iOS exact closed development IPA/embedded authority/cert/installed bundle-version-build-authority/development identity/sandbox receipt equality. Android exact AAB/extracted authority/versionCode/Play cert/installer plus ordered pulled base/split APK SHA multiset and installed authority equality. Any other distribution or mismatch fails.

- [ ] **Step 4: Reconfirm no tracked change**

```bash
git status --short
node --test tests/b3-distribution-authority.test.mjs
```

Expected: working tree remains clean; only `.native-build/b3/distribution/` exists untracked/ignored. Fresh reviewer checks the three authority files and signed-artefact comparison before Task 22.

### Task 22: Deploy the exact sandbox checkpoint and capture Apple, Google and private-R2 proof

**Files:**

- Create: `reports/b3/cloudflare-sandbox-proof.json`
- Create: `reports/b3/ios-sandbox-proof.json`
- Create: `reports/b3/ios-sandbox-proof.png`
- Create: `reports/b3/android-sandbox-proof.json`
- Create: `reports/b3/android-sandbox-proof.png`
- Create: `reports/b3/b3-exit-report.json`

**Interfaces:**

- Consumes: Task 20 exact clean checkpoint, Task 21 installed distribution authority, exact run-local token, durable scoped remote-mutation approvals, provisioned stores/test accounts/devices/remote secret names and root-authored screenshot attestations.
- Produces: one evidence-only commit proving actual store/gateway/R2 behaviour.

- [ ] **Step 1: Prove external gates and deploy exact test resources**

```bash
npm run check:b3-prerequisites
B3_REMOTE_MUTATION_SCOPE=cloudflare-deploy B3_REMOTE_RUN_TOKEN="$B3_REMOTE_RUN_TOKEN" npm run deploy:b3:sandbox
npm run prove:b3:cloudflare
```

Expected: prerequisite gate reads OAuth remotely and matches tracked account/Worker/public endpoint, private bucket, `PACKS`, `GATEWAY_RATE_LIMIT`, `WORKER_VERSION_METADATA`, seven secret names and run token without values. Deployment validates object authority, uploads immutable identical-only objects, binds normalised script authority + Cloudflare API version ID, and passes CORS, every-route rate-limit `429` with zero upstream calls, missing-binding fail-closed, capability, Range and no-redirect smoke. Missing/drift exits `6`; never login/overwrite/fabricate/request credentials.

- [ ] **Step 2: Capture the complete live Apple sandbox journey**

First require the committed deterministic report's separate non-live StoreKit Test block with exact approve then decline scenarios. It cannot satisfy any physical sandbox field. Then, on one physical iPhone whose installed signed build matches Task 21, use one sandbox tester context reserved for Ask to Buy pending and a separate normal-purchase tester context:

```bash
B3_REMOTE_MUTATION_SCOPE=apple-sandbox-history-refund B3_REMOTE_RUN_TOKEN="$B3_REMOTE_RUN_TOKEN" npm run prove:b3:ios
```

Before purchase require exact synthetic authority. Journey: query; cancel; Ask pending; switch tester; normal purchase/hold/unfinished; live JWS/finish/HTTPS install; unchanged digests; delete/reinstall; parent visibly taps Restore, native calls `AppStore.sync()` exactly once then verified current entitlements/fresh handle/redownload; proactive launch/resume before that must show zero sync/auth UI; reseed exact authority; visible refund; verified revoke/handle delete/unchanged second record. Wrapper rejects fake adapter/Worker identity.

Each exit `7` writes only redacted run-local state and a visible instruction. After the operator completes that exact action, rerun the same scoped command; the wrapper resumes from its validated checkpoint. It must never treat timeout/no state change as success.

Expected initial exit: `5` with code `b3_ios_manual_attestation_required` after writing pending report/screenshot. The root controller inspects the original-resolution screenshot, verifies complete Parent diagnostic shell/no store sheet/system dialog/private account data, then creates only `.native-build/b3/ios-manual-attestation.json` with platform, screenshot SHA-256 and `manualVisualInspection: "passed"`.

```bash
npm run prove:b3:ios -- --attest .native-build/b3/ios-manual-attestation.json
```

Expected: PASS with exact nine-scenario physical order, separate non-live StoreKit Test reference, Task 21 distribution block, Cloudflare/object equality, full envelope SHA, random trace IDs only for gateway-backed outcomes, no commitment on query/cancel/pending and completion exactly `{finished:true}`.

- [ ] **Step 3: Capture the complete live Google Play test journey**

On one Play-certified physical Android device with the build installed through internal/closed testing, run:

```bash
B3_REMOTE_MUTATION_SCOPE=google-test-track-refund-revoke B3_REMOTE_RUN_TOKEN="$B3_REMOTE_RUN_TOKEN" npm run prove:b3:android
```

Before purchase the wrapper requires exact tracked synthetic two-learner authority and rejects any other profile/nickname/digest. It proves ordered scenarios with Google `TEST`: query; cancel; slow decline; slow pending/approve; bounded polling; resume query; durable entitlement/handle/safe Google order ID then exact five-second unack hold/force-stop; relaunch -> live ProductPurchaseV2 -> acknowledgement -> real HTTPS install; unchanged synthetic digests; Play reinstall -> fresh proof/handle -> restore/redownload/no learner-backup claim; reseed/revalidate exact synthetic authority; visible refund+revoke; gateway denial, durable revoke+handle deletion and unchanged second synthetic record. It pauses exit `7` and never mutates Play Console or permits fake gateway/store adapters.

After every exit `7`, the operator completes only the displayed approved action and the same scoped command is rerun. Automatic slow-card polling and the five-second hold never ask the operator to race a hidden prompt; timeout fails closed.

Expected initial exit: `5` with code `b3_android_manual_attestation_required`. After root inspection, create only `.native-build/b3/android-manual-attestation.json` bound to the screenshot SHA and finalise:

```bash
npm run prove:b3:android -- --attest .native-build/b3/android-manual-attestation.json
```

Expected: PASS with exact nine-scenario order, completion exactly `{acknowledged:true}`, Task 21 embedded authority/versionCode/signing certificate, installer `com.android.vending`, certified-device evidence, Cloudflare/object equality, full envelope SHA and no raw token/handle/account identity.

- [ ] **Step 4: Build and validate the B3 exit report**

```bash
node --test tests/b3-evidence-contract.test.mjs tests/b3-cloudflare-wrapper-contract.test.mjs tests/b3-ios-wrapper-contract.test.mjs tests/b3-android-wrapper-contract.test.mjs
node scripts/build-b3-exit-report.mjs --write
npm test
node --test tests/b3-exit-report.live.mjs
git diff --check
git status --short
```

Expected: exactly the complete six-file topology is changed: Cloudflare JSON, iOS JSON/PNG, Android JSON/PNG and exit JSON. All strict ordered scenarios, non-live/live labels, distribution/gateway/object equality and screenshot attestations pass; no application/config/gateway/native/verifier input changed.

- [ ] **Step 5: Commit evidence only and push**

```bash
git add reports/b3/cloudflare-sandbox-proof.json reports/b3/ios-sandbox-proof.json reports/b3/ios-sandbox-proof.png reports/b3/android-sandbox-proof.json reports/b3/android-sandbox-proof.png reports/b3/b3-exit-report.json
git commit -m "test: close B3 sandbox commerce evidence"
git push origin jamesto/mobile-b3-billing-download
```

Expected: branch HEAD is the evidence-only commit and exact-head three-job CI passes. If any live journey cannot be completed, B3 remains blocked-external rather than partially passed.

### Task 23: Complete broad review, fast-forward main and prove exact main

**Files:** No planned source files. Review fixes repeat Tasks 20–22 in full.

**Interfaces:**

- Consumes: Task 22 evidence-only head, exact-head hosted CI in complete mode and whole-branch review.
- Produces: fast-forwarded `main`, exact-main CI and measured B4 entry authority.

- [ ] **Step 1: Require exact-head CI and broad independent review**

Build a review package from `git merge-base main HEAD` through branch HEAD. Require CI `mode:'complete'`; pending mode cannot merge. The fresh reviewer must assess every B3 exit criterion, product scope, native billing correctness, sealed-handle lifecycle, receipt-only privacy, signed distribution, live store truth, gateway/R2 access, signature/canonicalisation, compiled hostile ZIP proof, crash recovery, learner preservation, dependency/licence evidence and claim honesty. Resolve all Critical/Important findings. Any non-evidence change creates a new clean Task 20 checkpoint and forces new signed distribution, Cloudflare redeploy and both full physical-device recaptures.

- [ ] **Step 2: Fast-forward and prove exact main**

```bash
test "$(node scripts/build-b3-exit-report.mjs --check-ci --print-mode)" = "complete"
git switch main
git pull --ff-only origin main
git merge --ff-only jamesto/mobile-b3-billing-download
git push origin main
```

Require the exact pushed `main` SHA to complete all three hosted jobs successfully. Then run read-only authority capture:

```bash
git rev-parse HEAD
git rev-parse HEAD^{tree}
shasum -a 256 reports/b3/b3-exit-report.json reports/b3/dependency-audit.json reports/b3/native-build.json package-lock.json gateway/package-lock.json
gh run list --branch main --commit "$(git rev-parse HEAD)" --workflow ci.yml --json databaseId,url,headSha,status,conclusion
```

Expected: one successful exact-main run whose `headSha` equals `git rev-parse HEAD`. Preserve the branch until these measured values are copied into the next B4 plan authority section.

## B3 exit criteria

B3 is complete only when all items below have direct evidence:

1. Frozen B2/A2 authority passes; tracked gateway binds approved account/Worker, bucket `ks2-spelling-b3-sandbox-packs`, origin `https://b3-gateway.eugnel.uk`, sandbox and exact Capacitor origins while `server.url` is null.
2. Store/product/entitlement/pack IDs are exact. Concrete Capacitor store and closed 10-second no-redirect HTTP gateway run physically; fake fallback fails; CORS exact; endpoint/secrets unlogged.
3. RFC8785/P-256 precomputed fixture verifies with injected clock and exact key validity `2026-07-01T00:00:00Z` through `2027-07-01T00:00:00Z`; outside instants fail. No runtime signing/authoring material.
4. Same-byte compiled Swift/Java inspectors reject full metadata/path/overlap/overflow/EOCD/junk corpus before extraction.
5. SQLite V2 is learner-free. Safe durable ID is live Apple transaction ID/Google orderId only. Permanent authenticated rejection atomically marks rejected+clears proof; crash/replay stays clear; retryable transport/429/5xx preserves proof/state.
6. Distinct versioned handle keys, prefix/payload/AAD/context, nonce uniqueness, current/previous rotation, positive reseal version, fresh restore and revoke-commit-before-delete pass; raw proof clears after completion.
7. Launch/resume/Parent Packs timeout/offline/5xx keeps last active entitlement/install/readiness; only verified revocation locks. Explicit iOS restore calls `AppStore.sync()` then verified current entitlements; proactive queries never sync/authenticate.
8. Worker runtime/workerd/Google TEST and every-route pre-body/upstream rate limiting pass; missing binding and live 429 prove zero body/upstream.
9. Cloud evidence binds tracked account/Worker/origin/exact bucket, version ID/normalised script authority, compatibility/bindings/secrets and two immutable tracked objects; response/platform/report/exit equality and identical-only upload pass.
10. After gateway authorise but before job/archive GET/native range, signed manifest/key/entitlement/pack/version/app/schema/archive/ceiling trust checks pass. Every mutation proves zero archive/native calls and zero job/chunk mutation.
11. JS/Swift/Java capability URL validators require exact HTTPS origin/path/canonical once-only expires+cap/no credentials/fragment/redirect/extras before network.
12. Range/resume/storage/corruption/activation failures preserve previous pack.
13. Only exact synthetic two-learner authority is accepted; exactly two ordered preservation records equal expected digests; fresh reinstall makes no learner-backup claim.
14. iOS report has exact StoreKit-Test SHA/two non-live scenarios, exact nine live scenario/outcome/trace mapping, completion finished, terminal revoked. Android has exact nine mapping, ack completion, terminal revoked. Trace UUID multiplicity/order/relation is exact; query/cancel/pending have zero.
15. iOS distribution is development only and binds signed IPA SHA, independently extracted authority/values, cert and installed identity equality. Android binds signed AAB SHA/extracted authority/versionCode/Play cert/installer and ordered pulled base/split APK SHA multiset.
16. Live reports contain fresh trace UUIDs only; deterministic proof contains no fresh random values and is byte-identical across two clean runs. No raw proof/handle/capability/store ID.
17. Platform gateway/object/Worker/distribution blocks equal actual response/Cloud/distribution authority; screenshots are SHA-attested and Parent-only.
18. Reviewed non-force pushes occur after Tasks 4/8/13/18 on exact branch; hook bypass only after documented exact-HEAD full relevant tests. Task20 formal checkpoint remains.
19. CI checks ancestry separately for all six paths; only never-present zero is pending, any partial/history deletion fails, exact six is complete; Task23 merges complete with exact-head branch/main CI and broad review.

## Complete B3 verification command

```bash
npm ci
npm --prefix gateway ci
npm --prefix gateway run deploy:dry-run
npm run check:b3-prerequisites
npm run verify:b2-authority
npm run verify:vendor
npm run test:upstream:a3
npm test
npm run lint
npm run build
npm run native:sync:check
npm run test:ios
node scripts/test-ios-pack-inspector.mjs
npm run prove:b3:ios-storekit-test
npm run test:android
npm run certify:android
npm run test:android-resolved-policy
npm run report:b3-native
npm run prove:b3:deterministic
npm run audit:dependencies
npm run prove:b3:cloudflare
npm run verify:b3:installed-distribution -- --platform ios --signed-ipa "$B3_IOS_SIGNED_IPA"
npm run verify:b3:installed-distribution -- --platform android --signed-aab "$B3_ANDROID_SIGNED_AAB"
npm run prove:b3:ios -- --attest .native-build/b3/ios-manual-attestation.json
npm run prove:b3:android -- --attest .native-build/b3/android-manual-attestation.json
test "$(node scripts/build-b3-exit-report.mjs --check-ci --print-mode)" = "complete"
node --test tests/b3-exit-report.live.mjs
actionlint .github/workflows/ci.yml
git diff --check
git status --short
```

## Explicit B3 non-goals and B4 boundary

B3 does not ship or certify production Full KS2 content/audio, production pack signing keys, production Cloudflare resources, public pricing, store approval, family sharing, production Parent/child/profile/PIN/biometric UI, final Monster/pack visuals, final theme/assets, accessibility, performance, complete phone/tablet support, public compliance metadata or release readiness. It does not change spelling mastery, Monster stages or Camp rules.

B4 now owns the broad physical-device and WebView proof: one complete Starter spelling round, bundled local audio, software keyboard, lifecycle/audio interruption, VoiceOver/TalkBack, iPhone/iPad/Pixel 6a/Galaxy Tab A9 layout, and all section 18 performance/size budgets. B3's two physical devices prove commerce/download truth only. Only B4 `GO` authorises C-series work. The dedicated Visual / Theme / Asset Migration plan remains mandatory after Gate B `GO` and before C3 child-facing production UI.

## B4 entry authority block

The next B4 plan must freeze values measured after Task 23, using these exact sources and no inferred values:

| B4 authority field | Exact source after B3 merge |
|---|---|
| B3 merged `main` commit | stdout of `git rev-parse HEAD` |
| B3 merged tree | stdout of `git rev-parse HEAD^{tree}` |
| B3 exit report SHA-256 | stdout for `reports/b3/b3-exit-report.json` from the Task 23 `shasum` command |
| B3 dependency audit SHA-256 | stdout for `reports/b3/dependency-audit.json` |
| B3 native build report SHA-256 | stdout for `reports/b3/native-build.json` |
| Root package lock SHA-256 | stdout for `package-lock.json` |
| Gateway package lock SHA-256 | stdout for `gateway/package-lock.json` |
| Exact-main hosted CI URL | `url` from the unique successful `gh run list` record whose `headSha` equals the measured B3 commit |
| Frozen upstream Gate A commit | `4501607a9b58f2fb252b4cce64ba056e6f60c630` |
| A2 contract manifest SHA-256 | `237b26b14e7506fa271bb3324f701d6205e6e0166d659a16789937478cc77b66` |

Do not delete `jamesto/mobile-b3-billing-download` or begin B4 implementation until every measured B4 authority value has been written into the B4 plan and independently checked against exact `main`.
