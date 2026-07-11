# KS2 Spelling

`ks2-spelling` is the standalone repository for the local-first KS2 Spelling
mobile application. B1 establishes an independently versioned prototype shell
and its native packaging boundaries.

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

## Source authority

The frozen upstream authority and import boundary are recorded in
[`docs/architecture/b1-authority.md`](docs/architecture/b1-authority.md).

## Development and verification

Install the exact lockfile with `npm ci`, then verify the local native toolchain
with `npm run native:doctor -- --strict`. The complete local gate, virtual-device
lifecycle, disk requirements and unsigned-build boundary are documented in
[`docs/operations/native-development.md`](docs/operations/native-development.md).

CI has separate Ubuntu 24.04 domain/web and Android compile lanes plus an
unsigned iOS Simulator lane on macOS 26. All third-party Actions are pinned to
full commit SHAs. A workflow definition or local pass is not presented as a
hosted CI result; the exact private-branch run must be observed first.

## B1 evidence status

B1 proves a local bundled shell, deterministic dependency governance and exact
Simulator/Emulator launch evidence. It remains a prototype: SQLite durability,
lifecycle recovery, billing and restore, signed pack downloads, physical-device
quality, accessibility and store compliance remain later gated work.
