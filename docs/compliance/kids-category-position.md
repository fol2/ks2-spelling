---
module: compliance
tags:
  - store-release
  - kids-category
  - privacy
problem_type: standing-position
---

# Kids Category position

Date: 13 August 2026

Owner: KS2 Spelling maintainer

This document is the standing position on what the Kids Category commits KS2
Spelling to, where each obligation is satisfied in this repository, and which
obligations are not satisfied yet. It resolves
[#138](https://github.com/fol2/ks2-spelling/issues/138) and stands on the
primary-source research captured in
[#146](https://github.com/fol2/ks2-spelling/issues/146).

It is a position, not a legal opinion. Every claim below is either cited to a
primary source, pinned to a repository location, or explicitly marked as an
unresolved judgement.

## Scope of the verification behind this document

The negative claims in this document — "no analytics", "no learner data leaves
the device", "no link out", "the gateway retains nothing" — were each put to an
adversarial auditor instructed to refute them, with a second independent auditor
re-checking any claim reported refuted. Five claims survived. One did not: see
[Gap 1](#gap-1--the-parental-gate-is-trust-on-first-use).

Two limits on that verification, stated so the document does not read as more
than it is:

- It is a source and build-graph audit, not a scan of a signed submission
  binary. An SDK injected by a build script or an Xcode run phase would not
  appear in anything examined.
- Several claims rest on `reports/b3/dependency-audit.json`, which self-declares
  `approval: 'B3-compiled-capability-only'` and
  `disclosureStatus: 'Not a final store disclosure'`. Its hash ties it to the
  current `package-lock.json`, so the inventory is current — but it was produced
  as pre-release engineering evidence and should be regenerated against the
  actual submission build before filing.

## Decisions taken

### Age band: 9–11, cost accepted

The band is 9–11. It maps almost exactly onto Years 5–6, which leaves Years 3–4
outside the declared audience.

The documented cost is narrower than the folklore. Per
[Categories and Discoverability](https://developer.apple.com/app-store/categories/),
the Kids Category is additive: "In addition to the Kids category, your app can
be discovered in another primary and secondary category". The only surface Apple
documents as band-partitioned is the Kids page browse shelf. Nothing Apple
publishes says the band filters search, Education-category browse, or the Apps
tab. What actually hides an app from a restricted device is the **age rating**,
not the band — a separate axis.

Consequence to hold: because the band is 9–11, the **4+ age rating is what
preserves reach to Years 3–4**. A 9+ rating would forfeit it.

The free Starter pack is 100% Years 3–4 content (20 of 20), while the full
catalogue is 109 Years 3–4 / 104 Years 5–6. The declared audience is therefore
not the audience the free tier serves. That is a conversion problem, not a
compliance one, and is decided at
[#155](https://github.com/fol2/ks2-spelling/issues/155).

### The permanence being accepted

Two things do not come back:

- Guideline 1.3: "once customers expect your app to follow the Kids Category
  requirements, it will need to continue to meet these guidelines in subsequent
  updates, **even if you decide to deselect the category**."
- App Store Connect: "You can't change this selection once your app is approved
  by App Review."

So the bar on third-party analytics and advertising is permanent for the life of
the product, not a v1 constraint.

### Position on the edge: Cloudflare is infrastructure, not a third party

Guideline 1.3 states Kids Category apps "may not send personally identifiable
information or device information to third parties" and gives no
service-provider carve-out. COPPA does give one (§ 312.2 excludes a person
providing support for internal operations). An IP address necessarily reaches
any origin.

**Position:** the entitlement gateway is this product's own infrastructure, not
a third party in the sense guideline 1.3 addresses. The position is backed by a
technical measure rather than argument alone — see
[Gap 2](#gap-2--cloudflare-platform-logging-is-on-by-default).

The strongest supporting fact is that the identifier reaching the gateway is an
Apple **transaction ID**, which belongs to the App Store account holder — the
parent — and is produced only by a purchase the parent initiated. COPPA governs
personal information collected *from a child*. Nothing child-originated reaches
the gateway at all; this is verified, not asserted (see obligation map row 5c).

### Written compliance artifacts: none beyond this document

- **COPPA § 312.8(b) written children's personal information security program** —
  not produced. The obligation governs "children's personal information"; with
  no child-originated data collected and no durable retention, there is no
  subject matter for the program to govern.
- **COPPA § 312.10 written data retention policy** — not produced as a separate
  document. The Rule requires the policy to be published *in* the § 312.4(d)
  notice. It lands as a sentence in `docs/legal/privacy-notice.md`.
- **ICO Children's code standard 2 DPIA** — not produced as a separate document.
  This document performs the assessment in substance: it identifies the
  processing, the data subjects, the risks and the mitigations, and it records
  what would change the answer. Producing a second document labelled "DPIA"
  restating the same content would add a maintenance surface, not assurance.

This is a position that can be argued with. It is recorded here with its
reasoning so that, if challenged, the reasoning is on the record rather than
reconstructed after the fact. See [Tripwire](#tripwire--what-would-change-this-position).

### The paywall moment: child-facing celebration, gated transaction

The owner has fixed *when* the paywall lands — after the starter vocabulary is
secured, around the point one or two companions have hatched. The child is the
one at the screen at that moment, which puts it directly under the sentence the
Kids Category is built around:

> These apps must not include links out of the app, **purchasing opportunities**,
> or other distractions to kids unless reserved for a designated area behind a
> parental gate.

**Position:** the *moment* may be child-facing; the *paywall* may not.

- The child may see the celebration, and a factual statement that more words
  exist, and a route that says to ask a grown-up. That route is what a parental
  gate is for.
- The child may not see the price, a Buy button, an upgrade call to action, or a
  StoreKit sheet. **£9.99 must never render on a child-facing surface.**
- The signpost shows once, calmly, with a permanent quiet affordance in the
  Parent area. A recurring upsell aimed at a child is pester-power engineering,
  which ICO standard 1 (best interests of the child) reaches even though standard
  13's nudge language is confined to data.

Execution and the trigger's domain definition are
[#163](https://github.com/fol2/ks2-spelling/issues/163).

### Price

**£9.99** for the `full-ks2` unlock — `uk.eugnel.ks2spelling.fullks2`,
non-consumable, base territory United Kingdom, proceeds £7.06. Created in App
Store Connect on 13 August 2026 (IAP `6801319684`).

### Privacy policy: rendered in-app, no link out

Guideline 5.1.1(i) requires a privacy policy link "within the app in an easily
accessible manner". Guideline 1.3 requires links out of the app to sit behind a
parental gate. Apple publishes no carve-out reconciling the two.

**Position:** render the full policy text inside the app, sourced from
`docs/legal/privacy-notice.md`, and open no external URL at all. This satisfies
5.1.1(i) without creating a link-out for 1.3 to govern. The App Store Connect
metadata URL still exists, because that field is mandatory; it is simply not
surfaced in the app. The reconciliation is stated in the review notes rather
than left for the reviewer to infer.

Where the hosted copy lives is decided at
[#139](https://github.com/fol2/ks2-spelling/issues/139); that ticket inherits
the constraint that the hosted page must be generated from the same source file,
so the two cannot drift.

### App Privacy label: Data Not Collected — conditional on Gap 2

App Store Connect defines "collect" as "transmitting data off the device in a
way that allows you and/or your third-party partners to access it for a period
longer than what is necessary to service the transmitted request in real time".

With Cloudflare platform logging disabled, nothing is retained past servicing
and **Data Not Collected** is accurate. With it at its current default, it is
not. The ordering is therefore load-bearing: the Gap 2 fix must merge before the
declaration is made in App Store Connect.

## Obligation map

Paths are repository-relative. Line numbers were correct at the date above.

### Apple

| Obligation | Source | Where it is satisfied |
|---|---|---|
| Parental gate over purchasing opportunities | Guideline 1.3 | Gate UI `src/app/ProductApp.jsx:999`; enforced by the `status === 'unlocked'` render branch at `src/app/ProductApp.jsx:776`; PIN rules `src/domain/security/parent-pin-contract.js:108`; PBKDF2-SHA-256, 210 000 iterations, verifier-only storage `src/platform/database/sqlite-parent-security-repository.js:75`. **Incomplete — see [Gap 1](#gap-1--the-parental-gate-is-trust-on-first-use).** |
| Gate is machine-checked | — | `tests/app-shell.test.mjs:448` asserts the locked render exposes no `Buy` / `Restore purchase` / learner-management surface |
| No link out of the app | Guideline 1.3 | Verified absent: no `<a href>`, `window.open`, `location.href`, `mailto:`, `tel:` anywhere in `src/`; `@capacitor/browser` is not a dependency and the installed `@capacitor/app` v8 exposes no `openUrl`. **Unguarded — see [Gap 4](#gap-4--submission-hygiene-four-items).** |
| No third-party analytics or advertising | Guideline 1.3, 5.1.4(a) | WebView bundle resolves to 8 npm packages (React, Phaser, Capacitor, scheduler); SwiftPM graph is 3 pins and there is no Podfile; Gradle graph is AndroidX + Play Billing. Enforced by `scripts/audit-dependencies.mjs:1368` (privacy-manifest drift) and `tests/app-shell.test.mjs:1458` (local-only shell, real build). In-app claim pinned by `tests/app-shell.test.mjs:500`. |
| No PII or device information to third parties | Guideline 1.3 | Gateway request bodies are closed-record allowlists — `src/platform/gateway/entitlement-gateway-port.js:75`. Rejection of `deviceId`, `advertisingId`, `appAccountToken`, `learnerId`, `progress` is enforced at `tests/gateway-privacy-boundary.test.mjs:4`. Gateway source is scanned for learner fields at `tests/gateway-privacy-boundary.test.mjs:41`. |
| Privacy policy exists and is in-app accessible | Guideline 5.1.4(b), 5.1.1(i) | Canonical text `docs/legal/privacy-notice.md`. **Not reachable in-app — see [Gap 3](#gap-3--the-in-app-privacy-surface-is-a-hand-written-summary).** |
| The gate is not presented as parental consent | Guideline 5.1.4(b) | Apple states explicitly that the parental gate "is generally not the same as securing parental consent to collect personal data". No repository text claims otherwise; this document is the standing instruction that none may. |
| IAP is the only unlock mechanism | Guideline 3.1.1 | The only writer that sets an entitlement to `active` requires the transaction journal to be `purchased` + `verified`, which requires the Worker to have verified the StoreKit JWS against the Apple root CA and re-read the transaction from the App Store Server API (`gateway/src/apple-store-verifier.js:109`, `:120`, `:127`). The B3 fake gateway is excluded from the production module graph by the Vite alias swap. **v1 file path closed** — the unsigned import is deleted ([E4 — Remove learning backup from v1](https://github.com/fol2/ks2-spelling/issues/198)). The replica slice must not reintroduce an entitlement-shaped apply; see [Gap 5](#gap-5--unsigned-backup-import-can-write-an-entitlement-shaped-field). |
| Restore mechanism exists | Guideline 3.1.1 | `src/app/ProductApp.jsx:680` → `src/app/parent-commerce-controller.js:166` → `src/app/create-product-commerce-workflow.js:488` |
| Complete submission, working back end, reviewable IAP | Guideline 2.1(a), 2.1(b) | Not yet satisfied — a release-readiness obligation. The gateway and R2 origin must be live during review, and because the IAP sits behind a PIN the review notes must explain how to reach it. Recorded in [Owner checklist](#owner-checklist-app-store-connect). |
| Downloaded content is data, not code | Guideline 2.5.2 | Packs are signed audio and catalogue data written inside the app container. No downloaded code path exists. |
| Kids metadata vocabulary; 4+ assets | Guideline 2.3.8 | Available because the app is in the Kids Category. Screenshot and icon set committed in PR #89. |

### COPPA (16 CFR Part 312, as amended effective 23 June 2025)

Selecting Made for Kids concedes that the service is "directed to children", so
COPPA applies. This is the difference from a general-audience app.

| Obligation | Position |
|---|---|
| § 312.2 "personal information" incl. persistent identifiers such as IP | An IP necessarily reaches the gateway. Nothing else identifying does. |
| § 312.3 notice, verifiable parental consent, parental review | Not triggered: no personal information is collected from a child. The only identifiers in the purchase path are the parent's store-account transaction ID and the store-issued proof. |
| § 312.5(c)(7) internal-operations exception | Available as a fallback framing for the transiting IP. Its price is the § 312.4(d)(3) disclosure, which lands as a sentence in the privacy notice. |
| § 312.5(b)(2) methods of verifiable parental consent | None used, none needed. The PIN gate is not consent and is never described as such. |
| § 312.8(b) written security program | Not produced. See [Decisions taken](#written-compliance-artifacts-none-beyond-this-document). |
| § 312.10 written retention policy | Retention is zero once Gap 2 is closed. Stated in the privacy notice, not as a separate document. |

### UK Age Appropriate Design Code

The code's scope is services "which involve the processing of personal data to
which the GDPR applies". With zero retention, applicability is arguable in both
directions; the position below is written as though it applies, which is the
conservative reading.

| Standard | Position |
|---|---|
| 1 Best interests of the child | The product collects nothing, shows no ads, and gates the only commercial surface. |
| 2 DPIA | Performed in substance by this document. |
| 3 Age appropriate application | The ICO's own bands (6–9 "core primary school years", 10–12 "transition years") do not align with Apple's. KS2 straddles both. Content is age-appropriate across the full 7–11 range regardless of the declared Apple band. |
| 4 Transparency | `docs/legal/privacy-notice.md`, once reachable in-app (Gap 3). |
| 5 Detrimental use of data | No data is used for anything beyond providing the app on the device. |
| 7 Default settings | No sharing, no accounts, no discovery surfaces exist to default. |
| 8 Data minimisation | Directly implicates Gap 2. Closing it is what makes this standard met rather than argued. |
| 9 Data sharing | None. |
| 10 Geolocation | Not collected; no location permission is declared on either platform. |
| 11 Parental controls | The child-facing indication is the exact string **"Grown-ups only"** at `src/app/ProductApp.jsx:1000`, repeated at `:788`. The gate restricts purchase and learner management only — it does not monitor or track the child — so the monitoring-indicator half of standard 11 does not bite. |
| 12 Profiling | None. |
| 13 Nudge techniques | No dark patterns toward data sharing; the purchase surface is behind the gate and is not surfaced to the child. |
| 15 Online tools | Learner deletion `src/platform/database/sqlite-spelling-profile-store.js:276`; learning reset `:337`; UI at `src/app/ProductApp.jsx:507`. |

## Gaps

Each gap is a thing this document cannot yet claim. None may be closed by
editing this document.

### Gap 1 — the parental gate is trust-on-first-use

**Guideline 1.3. Highest severity: this is a plausible rejection.**

On a fresh install no Parent PIN record exists, so the controller reports
`setup-required`, the gate renders a plain "Set a Parent PIN" form, and `setPin`
publishes `unlocked` immediately. A child who launches the app first can invent
any valid six digits and land in the unlocked Parent area with **"Buy Full KS2"**
and **"Restore purchases"** live. Nothing requires a parent to establish the PIN
before a learner can use the app.

Apple's requirement is that a parental gate be "an adult-level task". A PIN-entry
form with no adult challenge is not one on first run.

Two adjacent facts belong with the same decision:

- Even after a PIN exists, it is a self-chosen six-digit PIN that a child in this
  age band can watch being entered.
- Biometric unlock (`src/app/parent-security-controller.js:263`) is a second door
  into the same unlocked state, and opens for any biometric enrolled on a shared
  family device.

Routed to [#140](https://github.com/fol2/ks2-spelling/issues/140), whose scope is
widened from PIN recovery to the whole gate lifecycle, because the adult-challenge
primitive is shared between establishment and recovery and deciding them apart
risks incompatible answers. Research already available at
[#147](https://github.com/fol2/ks2-spelling/issues/147).

Wording constraint until it is closed: the claim is "every purchase and restore
affordance renders only after the Parent security gate reports unlocked" — not
"a child cannot start a purchase".

**Name the shape, because it recurs.** This gap is *structure verified in place
of behaviour*. Auditing the gate's wiring passes — one commerce card, one render
branch, re-locks on pause, pinned by a test — while the behaviour fails, because
nothing checked what happens before a secret exists. It is the same shape as a CI
lane that is green because it never ran on the shipped artifact, and the same
shape as a regex-over-source "guard" that never executes the thing it guards.
Three other instances were found on the same day. When a check is proposed for
any of these gaps, ask what it actually exercises, not what it inspects.

### Gap 2 — Cloudflare platform logging is on by default

**Guideline 1.3, COPPA § 312.5(c)(7), ICO standard 8, and the App Privacy label.**

`observability` appears in no config or deploy script, so the deployed Worker
sits at Cloudflare's documented default of enabled. Invocation logs record
`<Method> <URL>` — which on the download route is the **full URL including the
`?expires=…&cap=…` capability query string** — retained 3 days (Free) / 7 days
(Paid).

This is the only retention anywhere in the system, and it also leaks signed
capability tokens into a log store, which is a security concern independent of
privacy.

The application-level logger is not the problem: `gateway/src/redacted-logging.js:2`
allows exactly four metadata fields (`operation`, `status`, `store`, `retryable`),
value-constrained, on three allowlisted events, and it is the only console writer
in the shipped module graph including the bundled
`@apple/app-store-server-library`.

The fix must land in **both** drift-locked config sites: `gateway/wrangler.jsonc`
and `buildB3DerivedWranglerConfig` in `scripts/lib/b3-cloudflare-live-adapter.mjs`.

### Gap 3 — the in-app privacy surface is a hand-written summary

`docs/legal/privacy-notice.md` is repo-only. The in-app card at
`src/app/ProductApp.jsx:956` is an independently worded summary, and only the
single sentence "No advertising, analytics or tracking" is pinned by a test
(`tests/app-shell.test.mjs:500`). The two agree today only because a human kept
them in step.

Closing this gap also carries the two sentences the position above owes the
notice: the § 312.10 retention statement and the § 312.4(d)(3) internal-operations
disclosure.

### Gap 4 — submission hygiene, four items

Each would embarrass the Kids declaration if a reviewer or a future commit found
it.

1. `android/app/build.gradle:81-88` retains Capacitor's stock hook that applies
   the `com.google.gms.google-services` plugin if a `google-services.json` is
   present. No such file exists, so it is inert — but dropping one file silently
   adds Firebase to the graph with no test that would catch it. The "no
   analytics" declaration should be enforced by absence, not by luck.
2. `ios/App/App.xcodeproj/project.pbxproj:318` copies `B3Sandbox.storekit` into
   the app bundle's Resources phase in **every** configuration. It is inert
   without a scheme reference, but shipping a StoreKit test configuration inside
   a Kids Category binary is an avoidable reviewer flag.
3. No `PrivacyInfo.xcprivacy` exists for the app target. The three privacy
   manifests in the audit all come from dependencies.
4. No test guards the no-link-out claim. A single future commit adding an
   `<a href>` would ship without tripping anything.

### Gap 5 — unsigned backup import can write an entitlement-shaped field

**The import path is deleted.** v1 ships neither the share-sheet export/import
nor the iCloud learning replica
([E4 — Remove learning backup from v1](https://github.com/fol2/ks2-spelling/issues/198)).
The unsigned JSON file is gone, so it cannot grant the full catalogue.

The governing rule remains a constraint on the replica slice
([iCloud learning replica — CloudKit private database, post-listing](https://github.com/fol2/ks2-spelling/issues/199)):

> The preservation exemption covers state a device **earned**, never state it
> **imported**.

A replica applying onto a never-entitled device must not raise the word list
past that device's store entitlement. That slice carries its own revert-goes-red
test. Until it ships, Gap 5's original vector is closed by absence of the file
path.

## App Store Connect

**These are agent-executable.** An App Store Connect API key is already
provisioned — key `NA8CPX2ZL2`, private key at
`~/.appstoreconnect/private_keys/`, credentials recorded in
`scripts/testflight-upload.sh:16`, driven by the `asc` CLI. The app record is
`KS2 Spelling`, id `6798866142`, bundle `uk.eugnel.ks2spelling`. The owner has
delegated these actions standing; they are listed here as a record of what was
done and what remains, not as a checklist for a human.

### Done, 13 August 2026

1. **Made for Kids, age band 9–11** — `kidsAgeBand: NINE_TO_ELEVEN` set and
   verified on age rating declaration `518674b3-b3f6-4df4-bdb2-23b3744d86cd`.
   Reversible until App Review approves a version; a one-way door after that.
2. **Age rating** — no action was needed. Every content attribute already reads
   `NONE`/`false` and `ageRatingOverride` is `NONE`, so the calculated rating is
   **4+**. The rating is an output of the questionnaire, not a free choice; what
   matters is that nothing in the answers pushes it to 9+, because restriction
   filtering compares the **rating**, not the band — a 4+ app stays visible on a
   device restricted for a 7-year-old, which is exactly what makes the 9–11
   band's cost acceptable. If a future content change would raise it, that is a
   reach decision, not a formality.
3. **In-app purchase** — `uk.eugnel.ks2spelling.fullks2`, `NON_CONSUMABLE`,
   reference name "Full KS2", IAP id `6801319684`, base territory GBR, **£9.99**,
   proceeds £7.06. Verified against the price schedule after creation.

### Remaining

4. **App Privacy** — declare **Data Not Collected**. Blocked on Gap 2: the
   declaration is only accurate once the deployed Worker has observability
   disabled, so it must follow #158 and a confirmation of the live setting.
5. **Privacy policy URL** — the metadata field is mandatory. URL decided at #139.
6. **App Review Information** — because the IAP sits behind the parental gate,
   guideline 2.1(b) requires an explanation. State: how to reach the Parent area,
   how the gate is passed, that the privacy policy is rendered in-app rather than
   linked out and why, and that the entitlement gateway and pack origin are live.
7. **Export compliance** — the standing decision on
   [#94](https://github.com/fol2/ks2-spelling/issues/94) records the owner
   confirming this personally ([#76](https://github.com/fol2/ks2-spelling/issues/76)).
   That predates the API key; whether it stays a personal confirmation is the
   owner's to say, since it is a declaration made in their name.

### Before submission, not in App Store Connect

- The gateway and R2 origin must be live during review — guideline 2.1(a),
  "turn on your back-end service!". This depends on the production ceremonies
  sequenced at [#143](https://github.com/fol2/ks2-spelling/issues/143).
- The verification path is currently hard-pinned to Apple's **Sandbox**
  environment at four layers, so a genuine production transaction would be
  rejected. The cutover contract is [#145](https://github.com/fol2/ks2-spelling/issues/145).

## Tripwire — what would change this position

This position is only as true as the configuration underneath it. It fails, and
must be re-opened, if any of the following becomes true:

1. Cloudflare observability or invocation logging is re-enabled on the deployed
   Worker.
2. The gateway gains a KV, D1 or Durable Object binding, or begins writing to R2.
3. The gateway rate limit stops being keyed to the literal string `'global'` and
   starts being keyed to anything client-derived.
4. Any field is added to the `ALLOWED_FIELDS` allowlist in
   `gateway/src/redacted-logging.js` that could carry a client identifier.
5. Any third-party SDK enters the npm, SwiftPM or Gradle graph.
6. A link out of the app is introduced.
7. Any learner-originated field enters a gateway request body.

Items 1–4 are mechanically checkable and are guarded by the test landing with
the Gap 2 fix. Items 5–7 are guarded by
`scripts/audit-dependencies.mjs`, `tests/app-shell.test.mjs` and
`tests/gateway-privacy-boundary.test.mjs` respectively, except for the link-out
case, which is Gap 4 item 4.

## Sources

Primary sources are enumerated in full on
[#146](https://github.com/fol2/ks2-spelling/issues/146). The load-bearing ones:

- App Review Guidelines — https://developer.apple.com/app-store/review/guidelines/
- Kids Category requirements — https://developer.apple.com/app-store/kids-apps/
- Categories and Discoverability — https://developer.apple.com/app-store/categories/
- Set an app age rating — https://developer.apple.com/help/app-store-connect/manage-app-information/set-an-app-age-rating/
- App privacy details — https://developer.apple.com/app-store/app-privacy-details/
- COPPA Rule, current text — https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-312
- ICO Children's code — https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/childrens-information/childrens-code-guidance-and-resources/age-appropriate-design-a-code-of-practice-for-online-services/
- Cloudflare Workers Logs — https://developers.cloudflare.com/workers/observability/logs/workers-logs/
