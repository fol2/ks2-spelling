# KS2 Spelling

`ks2-spelling` is the standalone repository for the local-first KS2 Spelling
mobile application. B1 established the independently versioned native shell;
B2 added local transactional SQLite and lifecycle proof, and B3/B4 established
the bounded commerce, signed-pack and learner-journey development seams.
Continued product work follows the
[C-series product-completion plan](docs/superpowers/plans/2026-07-23-c-series-product-completion.md).

## Frozen identity

| Field | B1 value |
|---|---|
| Repository name | `ks2-spelling` |
| Local repository path | `/Users/jamesto/Coding/ks2-spelling` |
| Product display name | `KS2 Spelling` |
| JavaScript package name | `ks2-spelling` |
| Capacitor app ID | `uk.eugnel.ks2spelling` |
| iOS bundle identifier | `uk.eugnel.ks2spelling` |
| Android application ID and namespace | `uk.eugnel.ks2spelling` |
| Shared Xcode scheme | `KS2Spelling` |
| Apple development team | `V45S7U2LZB` |
| iOS dependency manager | Swift Package Manager |
| Android B1 signing | Local debug signing only; no release key or Play App Signing enrolment in B1 |
| Default branch | `main` |
| B1 implementation branch | `jamesto/mobile-b1-bootstrap` |

The mobile toolchain uses Node.js `24.18.0`.

## B1 prototype boundary

B1 is a prototype shell only. The following capabilities are not implemented,
approved or claimed as complete:

- SQLite or any other durable learner-state storage;
- commerce, billing, purchases or entitlements;
- content downloads, pack delivery or remote synchronisation;
- production readiness, signing, store enrolment, deployment or release;
- a remote runtime, remote HTML or remote JavaScript;
- accounts, analytics, advertising or cloud progress; and
- production native plugins.

The application remains local-first and must package its application code in
the installed binary. Later work requires its own evidence and approval gates.

## B3 local and online boundary

Spelling practice, installed packs, learner progress and child-owned Monster
progress remain local and work offline. Online access is used only for commerce
verification, pack download or redownload, entitlement refresh, restore and
revocation. It is not a runtime dependency for spelling practice or installed
content.

Monster is a motivational presentation around spelling, not an independently
cloud-tracked Parent metric. A dedicated Visual / Theme / Asset Migration Spec
remains mandatory before C3 child UI. The dated
[B4 owner GO](docs/superpowers/plans/2026-07-23-b4-owner-go.md)
accepts Capacitor as the product direction. Historical timing observations are
retained, but their external measurement method is not accepted as an
application-threshold verdict and will be replaced during later optimisation. B3
Development proves deterministic and compiled commerce/signed-download capability
only. Signed App Store/Google Play, deployed Cloudflare/R2 and physical-device
truth remain one Release Commerce Certification blocker before public submission.

## B2 persistence boundary

B2 proves the frozen A3 spelling command contract through one local SQLite
transaction boundary on the owned iOS Simulator and Android Emulator. It proves
atomic rollback, WAL recovery, pause/resume, process termination and exact
session recovery while preserving two learners' independent state. Starter
Camp remains empty and Monster state remains child-owned and spelling-derived.

The B2 shell is deliberately diagnostic. Production profiles, Parent UI and
security, backup, commerce, downloads, final visuals, physical-device quality,
accessibility, signing and release metadata remain later gates. SQLCipher is
packaged but B2 uses `no-encryption`; export classification remains unresolved
before store release.

## Source authority

The frozen upstream authority and import boundary are recorded in
[`docs/architecture/b1-authority.md`](docs/architecture/b1-authority.md).
The B2 transaction, lifecycle and evidence authority is recorded in
[`docs/architecture/b2-persistence-authority.md`](docs/architecture/b2-persistence-authority.md).
The B3 sandbox commerce, signed-pack and clean-checkpoint boundary is recorded in
[`docs/architecture/b3-commerce-pack-authority.md`](docs/architecture/b3-commerce-pack-authority.md).

## AI-native development

[`AGENTS.md`](AGENTS.md) is the small execution kernel and
[`docs/agents/ai-sdlc.md`](docs/agents/ai-sdlc.md) is the development-process
single source of truth. The operating rules are: AI-native traceability,
minimum wall time, minimum token/context consumption and no loss of relevant
assurance. Humans set intent and authority above the loop; agents own the
reversible delivery loop beneath those boundaries.

One outcome normally uses one owner, one branch and one ordinary PR. Discovery
and research remain bounded and isolated until a result is selected for
delivery. Evidence is routed through F0 change integrity, F1 direct behaviour,
F2 affected contracts, conditional F3 actual-runtime/service proof and explicit
F4 irreversible/external authority.

## Development and verification

Install the exact lockfile with `npm ci`, then verify the local native toolchain
with `npm run native:doctor -- --strict`. The complete local gate, virtual-device
lifecycle, disk requirements and unsigned-build boundary are documented in
[`docs/operations/native-development.md`](docs/operations/native-development.md).

Pull requests use one `Domain and web` job. Explicit safe documentation-only
diffs run the F0 contract without installing product dependencies; product,
test, script, workflow, legal/privacy, evidence, native and unknown changes fail
closed into the existing fast product lane. Feature-branch pushes do not create
a duplicate CI run.

Merge-group candidates, `main`, scheduled runs and manual integration runs keep
the complete maintained boundary: Ubuntu 24.04 domain/web, Android unsigned
debug/release compile and unsigned iOS Simulator compile on macOS 26. All use
Node.js `24.18.0`, retain full Git history and pin third-party Actions to full
commit SHAs. The shared native selector fails closed for unresolved or governed
inputs. Physical-device, live-service, signing, store and release claims remain
separate authority/evidence gates.

B3 CI accepts a legitimate zero-file `pending` Development Checkpoint or the
exact six-file `complete` pre-release evidence successor. It does not perform
live Cloudflare, store or physical-device actions. A workflow definition or
local pass is not presented as a hosted CI result; the exact candidate run must
be observed first. The event-to-tier mapping and its source-versus-live
boundary are documented in
[`docs/operations/merge-tier-gate.md`](docs/operations/merge-tier-gate.md).

## B2 evidence status

B1 proves the local bundled shell and deterministic dependency governance. B2
adds virtual iOS/Android SQLite durability and lifecycle recovery. Run the exact
local and evidence workflow in
[`docs/operations/native-development.md`](docs/operations/native-development.md).
Billing and restore, signed pack downloads, production security,
physical-device quality, accessibility and store compliance remain later gated
work.
