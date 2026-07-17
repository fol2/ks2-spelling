# Standalone Spelling Mobile Application Design

## Repository authority

This document is the repository-owned foundation design authority for
`fol2/ks2-spelling`. It supersedes the earlier workstation-only reference to a
sibling `ks2-mastery` checkout. It is deliberately tracked here so a GitHub-only
review can inspect the product and architecture foundation without local files.

This is a consolidation of the decisions already frozen by the B1, B2 and B3
plans and architecture records. It does not change their evidence, expand their
claims or import a runtime from a mutable sibling checkout.

| Authority | Frozen value |
|---|---|
| Upstream repository | `https://github.com/fol2/ks2-mastery.git` |
| Frozen Gate A commit | `4501607a9b58f2fb252b4cce64ba056e6f60c630` |
| Frozen Gate A tree | `129ba457cccf21df03f4be813b4f4ed6e7d9f6ad` |
| Mobile repository | `https://github.com/fol2/ks2-spelling.git` |
| Application identity | `uk.eugnel.ks2spelling` |
| Application name | `KS2 Spelling` |

The manifest-selected upstream spelling runtime is copied into this repository
with hash evidence. Production and verification must not depend on a sibling
checkout, symlink, submodule, workspace link, remote runtime or unpublished
shared package.

## Product intent

The product is a standalone KS2 spelling application for children, with a
separate Parent-controlled surface for administrative and commerce actions.
Spelling practice is the learning authority. Monster and Camp experiences are
child-facing motivational presentation around spelling progress; they are not
independent cloud-tracked Parent metrics.

The application is local-first:

- practice, learner state, sessions, spelling events, Monster state and Camp
  state remain available offline;
- one learner's commands and projections must not change another learner's
  bytes;
- lifecycle notifications may optimise persistence but are never a correctness
  dependency; and
- a network outage must not erase or rewrite last-known valid local learning
  state.

Child surfaces do not expose prices, purchase pressure, store sheets, restore
controls or download administration. B3 commerce remains in the diagnostic
Parent proof shell until later product work explicitly promotes a reviewed
surface.

## Installed-code boundary

Application HTML, JavaScript, spelling logic and native integration are bundled
into the installed application. Production builds must keep Capacitor
`server.url` null and must not load remote HTML or JavaScript. Downloaded spelling
packs are data-only, signed and verified before atomic activation; they are not
remote code.

The native floors and identities remain:

- iOS 15 or newer, scheme `KS2Spelling`;
- Android minimum API 24, compile/target API 36 and Java 21; and
- the exact bundle/package identity `uk.eugnel.ks2spelling` on both platforms.

## Local persistence boundary

SQLite is the durable application authority. B2 freezes transactional learner
persistence and lifecycle recovery. Every changed learner command reads a fresh
learner-scoped snapshot, validates the complete command plan, commits all
related durable targets atomically and releases transient effects only after
commit.

B3 schema v2 adds app-wide commerce, pack and physical-proof capture authority
without making Cloudflare or R2 a learning-state database. The physical proof
capture database is separate ignored verification state. It must not become a
runtime dependency of spelling practice or learner progress.

## Commerce and pack boundary

The permanent identities are:

- Apple product `uk.eugnel.ks2spelling.fullks2`;
- Google product `full_ks2`;
- internal entitlement `full-ks2`; and
- B3 data-only pack `b3-sandbox-proof`.

The gateway is receipt-only and account-free. It may verify store truth, issue a
sealed refresh handle and provide a private-R2 download capability. It must not
receive learner/profile/progress/session/Monster/Camp data or become the source
of learning truth.

Raw StoreKit JWS, Google purchase tokens, refresh handles, capability URLs,
transaction identifiers, tester identities, device identifiers, learner IDs and
nicknames are secret or private. They must not enter logs, screenshots, reports,
metrics or Git. Only a live store-verified revocation may lock paid access;
timeouts, offline state and gateway failure preserve the last verified active
local entitlement and installed pack.

Signed pack manifests use domain-separated RFC 8785 canonical bytes, ECDSA P-256
with SHA-256 and a committed verification fixture. Runtime code contains public
verification keys only and cannot sign or re-sign packs. Archive inspection and
activation reject path traversal, links, duplicates, unbounded content and
signature or hash drift before replacing the active data pack.

## Native proof boundary

The B3 proof plugin is diagnostic and B3-only. Normal application builds must not
expose it. Physical observations are app-owned, command-bound, redacted and
hash-chained. The host may pull only the fixed observation path and may derive
public evidence only from validated observations.

Host checkpoints such as pending-purchase approval/decline, the exact five-second
hold, force-stop, reinstall acknowledgement and screenshot attestation are not
app observations. Process absence is never proof that a host-owned stop
completed. Native launch and force-stop crossings therefore require durable
receipts or the closed reinstall recovery gate.

Final B3 reports and screenshots are immutable derived evidence under the closed
`reports/b3` namespace. They are outside SQLite and may be created only through
the exact-byte final-output publisher. Task 19 performs local, non-mutating
certification only: it does not deploy Cloudflare, write R2, mutate a store
console, sign, install, operate a physical device or publish live evidence.

## Deferred product and release work

The current proof shell is not final child-facing visual design. Parent security,
production profile administration, accessibility and performance certification,
release signing, store records, legal metadata, production backup and final
visual/theme/asset migration remain separately reviewed programme gates. Passing
a narrower test or unsigned build must not be described as production or store
readiness.
